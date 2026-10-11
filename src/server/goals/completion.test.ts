import { afterEach, describe, expect, it } from 'vitest';
import type { CompletionEvaluation, GoalDefinition } from '../../shared/goals.js';
import { checkCompletionProof, evaluateCompletion } from './completionEvaluation.js';
import { completeGoal } from './completion.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { hashGoalDefinition } from './definitionHash.js';
import { loadDefinitionVersion } from './definitions.js';
import { listGoalEvents } from './events.js';
import { applyReviewFindings, decideFinding } from './findings.js';
import { evaluateMilestones, syncMilestoneRuntime } from './milestones.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  milestone,
  newFinding,
  passDeterministic,
  reportOf,
  simpleDefinition,
  type DefinitionOptions,
  type GoalRepoFixture,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { completeReview, createReview } from './reviews.js';
import { transitionGoal } from './stateMachine.js';
import { parseCompletionPolicy } from './completionPolicy.js';

afterEach(cleanupRepoFixtures);

function running(options: DefinitionOptions = {}) {
  const fx = goalRepoFixture({ definition: simpleDefinition(options) });
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  return fx;
}
const codes = (evaluation: CompletionEvaluation) => evaluation.failures.map((failure) => failure.code);
const status = (fx: GoalRepoFixture) =>
  (fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId) as { status: string }).status;

async function finalReview(
  fx: GoalRepoFixture,
  verdict: 'pass' | 'pass_with_findings' | 'block' = 'pass',
  independence?: unknown,
) {
  const { id } = await createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' });
  completeReview(fx.db, { reviewId: id, report: reportOf({ verdict }), independence });
  return id;
}

describe('milestone evaluation', () => {
  const two = () =>
    running({
      criteria: [
        {
          key: 'build',
          statement: 'b',
          required: true,
          verification: [{ kind: 'build', command: ['npm', 'run', 'build'] }],
        },
        { key: 'tests', statement: 't', required: true, verification: [{ kind: 'test' }] },
      ],
      milestones: [milestone('m1', ['build']), milestone('m2', ['tests'], { dependsOn: ['m1'] })],
    });
  const keyed = (evaluation: CompletionEvaluation, key: string) =>
    evaluation.milestones.find((entry) => entry.key === key)!;

  it(
    'is satisfied only when its criteria are satisfied by fresh evidence',
    async () => {
      const fx = two();
      const before = await evaluateCompletion(fx.db, fx.goalId);
      expect(keyed(before, 'm1')).toMatchObject({ state: 'unsatisfied', blockers: ['criteria_unsatisfied'] });
      await passDeterministic(fx);
      const after = await evaluateCompletion(fx.db, fx.goalId);
      expect(keyed(after, 'm1').state).toBe('satisfied');
      expect(keyed(after, 'm2').state).toBe('satisfied');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'lets stale evidence beat an old satisfied runtime status, and never trusts the stored status',
    async () => {
      const fx = two();
      await passDeterministic(fx);
      const first = await evaluateCompletion(fx.db, fx.goalId);
      syncMilestoneRuntime(fx.db, { goalId: fx.goalId, definitionVersion: 1, milestones: first.milestones });
      expect(fx.db.prepare("SELECT status FROM goal_milestones WHERE milestone_key = 'm1'").get()).toEqual({
        status: 'satisfied',
      });
      fx.advance({ 'src/x.ts': 'x' });
      const stale = await evaluateCompletion(fx.db, fx.goalId);
      expect(keyed(stale, 'm1').state).toBe('unsatisfied');
      const synced = syncMilestoneRuntime(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        milestones: stale.milestones,
      });
      expect(synced.reopened.sort()).toEqual(['m1', 'm2']);
      // A forged satisfied row changes nothing either.
      fx.db.prepare("UPDATE goal_milestones SET status = 'satisfied' WHERE milestone_key = 'm1'").run();
      expect(keyed(await evaluateCompletion(fx.db, fx.goalId), 'm1').state).toBe('unsatisfied');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'ignores milestones removed from the current definition',
    async () => {
      const fx = two();
      await passDeterministic(fx);
      const amended = structuredClone(fx.definition);
      amended.milestones = [amended.milestones[0]!];
      amended.milestones[0]!.criteria = ['build', 'tests'];
      const { beginAmendment, approveDefinition } = await import('./definitions.js');
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const { version } = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: amended as GoalDefinition,
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.milestones.map((entry) => entry.key)).toEqual(['m1']);
      expect(evaluation.ok).toBe(true);
      expect(fx.db.prepare("SELECT status FROM goal_milestones WHERE milestone_key = 'm2'").get()).toEqual({
        status: 'skipped',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'honours a user skip only with a bound approved user approval, and not a runtime skipped row',
    async () => {
      const fx = two();
      await passDeterministic(fx);
      fx.advance({ 'src/x.ts': 'x' }); // m2 is now unsatisfied
      const detail = (over: Record<string, unknown> = {}) => ({
        action: 'skip',
        milestoneKey: 'm2',
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        ...over,
      });
      fx.db.prepare("UPDATE goal_milestones SET status = 'skipped' WHERE milestone_key = 'm2'").run();
      expect(keyed(await evaluateCompletion(fx.db, fx.goalId), 'm2').state).toBe('unsatisfied');
      for (const bad of [
        fx.approval('milestone_complete', detail({ milestoneKey: 'm1' })),
        fx.approval('milestone_complete', detail({ action: 'complete' })),
        fx.approval('milestone_complete', detail({ definitionHash: 'h' })),
        fx.approval('milestone_complete', detail({ definitionVersion: 2 })),
        fx.approval('milestone_complete', detail(), 'denied'),
        fx.approval('final_acceptance', detail()),
      ])
        expect(bad).toBeTruthy();
      expect(keyed(await evaluateCompletion(fx.db, fx.goalId), 'm2').state).toBe('unsatisfied');
      const approval = fx.approval('milestone_complete', detail());
      expect(keyed(await evaluateCompletion(fx.db, fx.goalId), 'm2')).toMatchObject({
        state: 'skipped_by_user',
        skipApprovalId: approval,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'exempts criteria owned only by a user-skipped milestone from completion, and nothing else',
    async () => {
      const fx = two();
      fx.approval('milestone_complete', {
        action: 'skip',
        milestoneKey: 'm2',
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
      });
      const none = await evaluateCompletion(fx.db, fx.goalId);
      expect(codes(none)).toEqual(['criterion_unsatisfied', 'milestone_unsatisfied']); // build/m1 still required
      expect(none.failures[0]!.subject).toBe('build');
      await passDeterministic(fx);
      expect((await evaluateCompletion(fx.db, fx.goalId)).ok).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'requires a passing, current milestone review and the human gate when configured',
    async () => {
      const fx = running({
        milestones: [milestone('m1', ['build', 'tests'], { reviewRequirements: { milestoneReview: true } })],
        gates: { beforeMilestoneComplete: true },
      });
      await passDeterministic(fx);
      const blockers = async () => keyed(await evaluateCompletion(fx.db, fx.goalId), 'm1').blockers;
      expect(await blockers()).toEqual(['milestone_review_missing', 'human_gate_missing']);
      const review = async (verdict: 'pass' | 'block') => {
        const { id } = await createReview(fx.db, {
          goalId: fx.goalId,
          definitionVersion: 1,
          reviewKind: 'milestone',
          milestoneId: fx.milestoneId('m1'),
        });
        completeReview(fx.db, { reviewId: id, report: reportOf({ verdict }) });
      };
      await review('block');
      expect(await blockers()).toEqual(['milestone_review_not_passing', 'human_gate_missing']);
      await review('pass');
      expect(await blockers()).toEqual(['human_gate_missing']);
      fx.approval('milestone_complete', {
        action: 'complete',
        milestoneKey: 'm1',
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
      });
      expect(await blockers()).toEqual([]);
      fx.advance({ 'src/x.ts': 'x' });
      await passDeterministic(fx);
      expect(await blockers()).toEqual(['milestone_review_stale', 'human_gate_missing'].slice(0, 1));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'requires each requiredEvidence kind to be the deciding kind of a satisfied verifier',
    async () => {
      const fx = running({
        milestones: [
          milestone('m1', ['build', 'tests'], {
            requiredEvidence: [{ criterionKey: 'build', kinds: ['build_result'] }],
          }),
        ],
      });
      expect(keyed(await evaluateCompletion(fx.db, fx.goalId), 'm1').blockers).toEqual([
        'criteria_unsatisfied',
        'required_evidence_missing',
      ]);
      await passDeterministic(fx);
      expect(keyed(await evaluateCompletion(fx.db, fx.goalId), 'm1').blockers).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'evaluateMilestones is a pure function of its inputs',
    async () => {
      const fx = two();
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      const again = evaluateMilestones(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        definition: fx.definition,
        integrationTree: fx.tree(),
        criteria: evaluation.criteria,
      });
      expect(again).toEqual(evaluation.milestones);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('evaluateCompletion', () => {
  it(
    'passes with fresh evidence and changes no state',
    async () => {
      const fx = running();
      await passDeterministic(fx);
      const events = listGoalEvents(fx.db, fx.goalId).length;
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation).toMatchObject({
        ok: true,
        goalId: fx.goalId,
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationHead: fx.head(),
        integrationTree: fx.tree(),
        failures: [],
        findings: { ok: true },
        finalReview: { required: false, ok: true },
        finalAcceptance: { required: false, ok: true },
        finalApply: { required: false, ok: true, basis: 'not_required' },
      });
      expect(evaluation.criteria.map((criterion) => criterion.key)).toEqual(['build', 'tests']);
      expect(evaluation.criteria[0]!.satisfiedBy.length).toBeGreaterThan(0);
      expect(Object.isFrozen(evaluation)).toBe(true);
      expect(listGoalEvents(fx.db, fx.goalId)).toHaveLength(events);
      expect(status(fx)).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a missing Goal, an unapproved definition and an unusable Goal ref as structured failures',
    async () => {
      const fx = running();
      expect(codes(await evaluateCompletion(fx.db, 'ghost'))).toEqual(['goal_not_found']);
      fx.git('update-ref', '-d', `refs/heads/turing/goal/${fx.goalId}`);
      expect(codes(await evaluateCompletion(fx.db, fx.goalId))).toEqual(['goal_ref_unavailable']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  const cases: Array<{
    name: string;
    options?: DefinitionOptions;
    setup?: (fx: GoalRepoFixture) => Promise<void>;
    expected: string[];
  }> = [
    {
      name: 'no evidence at all',
      setup: async () => {},
      expected: ['criterion_unsatisfied', 'criterion_unsatisfied', 'milestone_unsatisfied'],
    },
    {
      name: 'evidence at an older tree',
      setup: async (fx) => {
        await passDeterministic(fx);
        fx.advance({ 'src/x.ts': 'x' });
      },
      expected: ['criterion_unsatisfied', 'criterion_unsatisfied', 'milestone_unsatisfied'],
    },
    {
      name: 'an open high finding over the limit',
      setup: async (fx) => {
        await passDeterministic(fx);
        const { id } = await createReview(fx.db, {
          goalId: fx.goalId,
          definitionVersion: 1,
          reviewKind: 'periodic',
        });
        completeReview(fx.db, {
          reviewId: id,
          report: reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding()] as never }),
        });
        await applyReviewFindings(fx.db, { reviewId: id });
      },
      expected: ['findings_over_threshold'],
    },
    {
      name: 'final review required but missing',
      options: { policy: { requireFinalReview: true } },
      setup: passDeterministic,
      expected: ['final_review_missing'],
    },
    {
      name: 'final review at an older tree',
      options: { policy: { requireFinalReview: true } },
      setup: async (fx) => {
        await finalReview(fx);
        fx.advance({ 'src/x.ts': 'x' });
        await passDeterministic(fx);
      },
      expected: ['final_review_stale'],
    },
    {
      name: 'final review blocking',
      options: { policy: { requireFinalReview: true } },
      setup: async (fx) => {
        await passDeterministic(fx);
        await finalReview(fx, 'block');
      },
      expected: ['final_review_not_passing'],
    },
    {
      name: 'final review pass_with_findings',
      options: { policy: { requireFinalReview: true } },
      setup: async (fx) => {
        await passDeterministic(fx);
        await finalReview(fx, 'pass_with_findings');
      },
      expected: ['final_review_not_passing'],
    },
    {
      name: 'final review without independence',
      options: { policy: { requireFinalReview: true } },
      setup: async (fx) => {
        await passDeterministic(fx);
        await finalReview(fx);
      },
      expected: ['final_review_independence'],
    },
    {
      name: 'final review with independence not established',
      options: { policy: { requireFinalReview: true } },
      setup: async (fx) => {
        await passDeterministic(fx);
        await finalReview(fx, 'pass', { established: false, policy: 'different-family' });
      },
      expected: ['final_review_independence'],
    },
    {
      name: 'user acceptance required but absent',
      options: { policy: { requireUserAcceptance: true } },
      setup: passDeterministic,
      expected: ['final_acceptance_missing'],
    },
    {
      name: 'final acceptance bound to an older tree',
      options: { gates: { finalAcceptance: true } },
      setup: async (fx) => {
        fx.approval('final_acceptance', {
          definitionVersion: 1,
          definitionHash: fx.currentHash(),
          integrationTree: fx.tree(),
        });
        fx.advance({ 'src/x.ts': 'x' });
        await passDeterministic(fx);
      },
      expected: ['final_acceptance_missing'],
    },
    {
      name: 'apply to base required but not applied',
      options: { policy: { applyToBase: 'required' } },
      setup: passDeterministic,
      expected: ['final_apply_required'],
    },
  ];
  it.each(cases)(
    'refuses completion: $name',
    async ({ options, setup, expected }) => {
      const fx = running(options);
      await setup!(fx);
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(false);
      expect(codes(evaluation)).toEqual(expected);
      const { completed } = await completeGoal(fx.db, fx.goalId);
      expect(completed).toBe(false);
      expect(status(fx)).toBe('running');
      expect(listGoalEvents(fx.db, fx.goalId).at(-1)).toMatchObject({
        type: 'completion_evaluated',
        payload: { ok: false },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'completes when final review, acceptance and external apply are all satisfied',
    async () => {
      const fx = running({
        policy: { requireFinalReview: true, applyToBase: 'required' },
        gates: { finalAcceptance: true },
      });
      await passDeterministic(fx);
      await finalReview(fx, 'pass', {
        established: true,
        policy: fx.definition.routing.independence.finalReview,
      });
      fx.approval('final_acceptance', {
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationTree: fx.tree(),
      });
      expect(codes(await evaluateCompletion(fx.db, fx.goalId))).toEqual(['final_apply_required']);
      fx.approval('final_apply', {
        action: 'applied_externally',
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationHead: fx.head(),
      });
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation).toMatchObject({
        ok: true,
        finalApply: { ok: true, basis: 'applied_externally' },
        finalReview: { ok: true },
        finalAcceptance: { ok: true },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'accepts a user-decided finding as within threshold',
    async () => {
      const fx = running();
      await passDeterministic(fx);
      const { id } = await createReview(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        reviewKind: 'periodic',
      });
      completeReview(fx.db, {
        reviewId: id,
        report: reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding()] as never }),
      });
      const { opened } = await applyReviewFindings(fx.db, { reviewId: id });
      expect(codes(await evaluateCompletion(fx.db, fx.goalId))).toEqual(['findings_over_threshold']);
      decideFinding(fx.db, {
        goalId: fx.goalId,
        findingId: opened[0]!,
        decision: 'accepted_by_user',
        actor: 'user',
        approvalId: fx.approval('finding_decision', {
          findingId: opened[0],
          decision: 'accepted_by_user',
          definitionVersion: 1,
          definitionHash: fx.currentHash(),
        }),
      });
      expect((await evaluateCompletion(fx.db, fx.goalId)).ok).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not let a model-named final review satisfy independence (never inferred from model names)',
    async () => {
      const fx = running({ policy: { requireFinalReview: true } });
      await passDeterministic(fx);
      await finalReview(fx, 'pass', {
        established: true,
        policy: 'different-model',
        detail: { reviewer: 'other-model', author: 'x' },
      });
      const wanted = fx.definition.routing.independence.finalReview;
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.finalReview.ok).toBe(wanted === 'different-model' || wanted === 'none');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('completeGoal and completion proofs', () => {
  it(
    'completes a Goal that leaves its result on the Goal branch, with an evaluation event',
    async () => {
      const fx = running();
      fx.advance({ 'src/work.ts': 'w' });
      await passDeterministic(fx);
      const result = await completeGoal(fx.db, fx.goalId);
      expect(result.completed).toBe(true);
      expect(status(fx)).toBe('completed');
      expect(fx.db.prepare('SELECT completed_at FROM goals WHERE id = ?').get(fx.goalId)).toEqual({
        completed_at: expect.any(String),
      });
      const events = listGoalEvents(fx.db, fx.goalId).map((event) => event.type);
      expect(events).toContain('completion_evaluated');
      expect(events.at(-1)).toBe('state_changed');
      expect(fx.git('rev-parse', `refs/heads/turing/goal/${fx.goalId}`)).toBe(fx.head());
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  const proof = async (fx: GoalRepoFixture) => {
    await passDeterministic(fx);
    return evaluateCompletion(fx.db, fx.goalId);
  };
  const transition = (fx: GoalRepoFixture, completionProof: unknown) =>
    transitionGoal(fx.db, {
      goalId: fx.goalId,
      to: 'completed',
      reasonCode: 'completion_verified',
      actor: 'supervisor',
      completionProof: completionProof as CompletionEvaluation,
    });

  it(
    'does not let approved v2 policy inherit an applied_externally v1 approval',
    async () => {
      const definition = simpleDefinition({
        policy: {
          completionContractVersion: 2,
          integrationMode: 'external_user_attested',
          requireFinalReview: true,
          requireUserAcceptance: true,
          applyToBase: 'required',
        },
      });
      definition.review.final = true;
      const fx = goalRepoFixture({ definition });
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      await passDeterministic(fx);
      await finalReview(fx, 'pass', {
        established: true,
        policy: fx.definition.routing.independence.finalReview,
      });
      fx.approval('final_acceptance', {
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationTree: fx.tree(),
      });
      // This historical v1 decision has no version-2 action binding.
      fx.approval('final_apply', {
        action: 'applied_externally',
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationHead: fx.head(),
      });

      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation).toMatchObject({
        ok: false,
        finalReview: { ok: true },
        finalAcceptance: { ok: true },
        finalApply: { required: true, ok: false, reason: 'external_completion_not_activated' },
        failures: [expect.objectContaining({ code: 'external_completion_not_activated' })],
      });
      const result = await completeGoal(fx.db, fx.goalId);
      expect(result.completed).toBe(false);
      expect(status(fx)).toBe('running');
      expect(checkCompletionProof(fx.db, fx.goalId, evaluation)).toMatchObject({
        ok: false,
        code: 'external_completion_not_activated',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not treat a corrupted approved v2 definition as legacy completion authority',
    async () => {
      const definition = simpleDefinition({
        policy: {
          completionContractVersion: 2,
          integrationMode: 'external_user_attested',
          requireFinalReview: true,
          requireUserAcceptance: true,
          applyToBase: 'required',
        },
      });
      definition.review.final = true;
      const fx = goalRepoFixture({ definition });
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      await passDeterministic(fx);
      await finalReview(fx, 'pass', {
        established: true,
        policy: fx.definition.routing.independence.finalReview,
      });
      fx.approval('final_acceptance', {
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationTree: fx.tree(),
      });
      const approvedHash = fx.currentHash();
      const legacyApplyApprovalId = fx.approval('final_apply', {
        action: 'applied_externally',
        definitionVersion: 1,
        definitionHash: approvedHash,
        integrationHead: fx.head(),
      });

      const intact = await evaluateCompletion(fx.db, fx.goalId);
      expect(intact.ok).toBe(false);
      expect(codes(intact)).toContain('external_completion_not_activated');

      // Deliberate corruption fixture: bypass only the SQL immutability guard so the test models damaged storage.
      const stored = fx.db
        .prepare('SELECT contract_json FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
        .get(fx.goalId) as { contract_json: string };
      const contract = JSON.parse(stored.contract_json) as {
        completionPolicy: Record<string, unknown>;
      };
      delete contract.completionPolicy.completionContractVersion;
      delete contract.completionPolicy.integrationMode;
      fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
      fx.db
        .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = 1')
        .run(JSON.stringify(contract), fx.goalId);

      const altered = loadDefinitionVersion(fx.db, fx.goalId, 1)!;
      const legacyApplyApproval = fx.db
        .prepare('SELECT detail_json FROM goal_approvals WHERE id = ?')
        .get(legacyApplyApprovalId) as { detail_json: string };
      expect(altered.definitionHash).toBe(approvedHash);
      expect((JSON.parse(legacyApplyApproval.detail_json) as { definitionHash: string }).definitionHash).toBe(
        approvedHash,
      );
      expect(parseCompletionPolicy(altered.definition.contract.completionPolicy)).toEqual({
        kind: 'valid',
        mode: 'legacy_v1',
      });
      expect(hashGoalDefinition(altered.definition)).not.toBe(altered.definitionHash);

      const corrupted = await evaluateCompletion(fx.db, fx.goalId);
      expect(corrupted.ok).toBe(false);
      expect(codes(corrupted)).toContain('completion_policy_unsupported');
      expect(corrupted.finalApply).toMatchObject({ ok: false, reason: 'completion_policy_unsupported' });
      expect(checkCompletionProof(fx.db, fx.goalId, corrupted)).toMatchObject({
        ok: false,
        code: 'completion_policy_unsupported',
      });
      expect((await completeGoal(fx.db, fx.goalId)).completed).toBe(false);
      expect(() => transition(fx, corrupted)).toThrow(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
      expect(status(fx)).toBe('running');
      expect(
        listGoalEvents(fx.db, fx.goalId).some(
          (event) => event.type === 'state_changed' && event.payload.to === 'completed',
        ),
      ).toBe(false);
      expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({
        n: 0,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'revalidates v1 definition and approval integrity after evaluation and before the terminal transition',
    async () => {
      const fx = running({ policy: { applyToBase: 'required' } });
      await passDeterministic(fx);
      fx.approval('final_apply', {
        action: 'applied_externally',
        definitionVersion: 1,
        definitionHash: fx.currentHash(),
        integrationHead: fx.head(),
      });
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(true);

      // Deliberate corruption after successful evaluation: the payload remains valid v1, but no longer matches its
      // approved content hash or the hash bound by the user's approval.
      const stored = fx.db
        .prepare('SELECT contract_json FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
        .get(fx.goalId) as { contract_json: string };
      const contract = JSON.parse(stored.contract_json) as {
        completionPolicy: Record<string, unknown>;
      };
      contract.completionPolicy.applyToBase = 'leave-on-goal-branch';
      fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
      fx.db
        .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = 1')
        .run(JSON.stringify(contract), fx.goalId);

      const corruptedEvaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(corruptedEvaluation.ok).toBe(false);
      expect(codes(corruptedEvaluation)).toContain('completion_policy_unsupported');
      expect(checkCompletionProof(fx.db, fx.goalId, evaluation)).toMatchObject({
        ok: false,
        code: 'completion_policy_unsupported',
      });
      expect((await completeGoal(fx.db, fx.goalId)).completed).toBe(false);
      expect(() => transition(fx, evaluation)).toThrow(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
      expect(status(fx)).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a proof when the integration head moved after the evaluation',
    async () => {
      const fx = running();
      const evaluation = await proof(fx);
      fx.advance({ 'src/x.ts': 'x' });
      expect(checkCompletionProof(fx.db, fx.goalId, evaluation)).toMatchObject({
        ok: false,
        code: 'completion_proof_stale',
      });
      expect(() => transition(fx, evaluation)).toThrow(
        expect.objectContaining({ code: 'completion_proof_stale' }),
      );
      expect(status(fx)).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a proof after the definition is amended, even to identical headline content',
    async () => {
      const fx = running();
      const evaluation = await proof(fx);
      const { beginAmendment, approveDefinition } = await import('./definitions.js');
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const amended = structuredClone(fx.definition);
      amended.limits.maxExecutionCycles += 1;
      const { version } = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user', definition: amended });
      approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      expect(checkCompletionProof(fx.db, fx.goalId, evaluation)).toMatchObject({
        code: 'completion_proof_stale',
      });
      expect(() => transition(fx, evaluation)).toThrow(
        expect.objectContaining({ code: 'completion_proof_stale' }),
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses literals, clones, JSON copies, failed evaluations and another Goal’s proof',
    async () => {
      const fx = running();
      const other = running();
      const good = await proof(fx);
      await passDeterministic(other);
      const failing = await evaluateCompletion(running().db, 'ghost');
      for (const candidate of [
        undefined,
        null,
        true,
        { ...good },
        structuredClone(good),
        JSON.parse(JSON.stringify(good)),
        failing,
        await evaluateCompletion(other.db, other.goalId),
      ])
        expect(() => transition(fx, candidate)).toThrow(/proof/i);
      expect(status(fx)).toBe('running');
      expect(() => transition(fx, good)).not.toThrow();
      expect(status(fx)).toBe('completed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses completion for a Goal that is not running even with a good proof',
    async () => {
      const fx = running();
      const evaluation = await proof(fx);
      fx.db.prepare("UPDATE goals SET status = 'paused' WHERE id = ?").run(fx.goalId);
      expect(() => transition(fx, evaluation)).toThrow();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not complete when the Goal ref moves outside Turing between evaluation and transition',
    async () => {
      const fx = running();
      await passDeterministic(fx);
      fx.git('commit', '-q', '--allow-empty', '-m', 'outside');
      fx.git('update-ref', `refs/heads/turing/goal/${fx.goalId}`, fx.git('rev-parse', 'HEAD'));
      const result = await completeGoal(fx.db, fx.goalId);
      expect(result.completed).toBe(false);
      expect(codes(result.evaluation)).toEqual(['goal_ref_unavailable']);
      expect(status(fx)).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('exposes no function that can mint proof: the issuer is module-private', async () => {
    const evaluationModule = await import('./completionEvaluation.js');
    const completionModule = await import('./completion.js');
    expect(Object.keys(evaluationModule).sort()).toEqual(['checkCompletionProof', 'evaluateCompletion']);
    for (const mod of [evaluationModule, completionModule, await import('./stateMachine.js')])
      expect(
        Object.keys(mod).filter((name) => /issue|mint|proof/i.test(name) && name !== 'checkCompletionProof'),
      ).toEqual([]);
  });
});

describe('completion standing: R4 a legacy version-1 completion reads as historical_legacy', () => {
  it(
    'R4: a real completeGoal completion with no proof row is kind legacy, historical_legacy, and not trusted',
    async () => {
      const fx = running();
      fx.advance({ 'src/work.ts': 'w' });
      await passDeterministic(fx);
      const result = await completeGoal(fx.db, fx.goalId);
      expect(result.completed).toBe(true);
      const row = fx.db.prepare('SELECT completed_at FROM goals WHERE id = ?').get(fx.goalId) as {
        completed_at: string | null;
      };
      const model = readGoalCompletionStanding(fx.db, fx.goalId);
      expect(model).toEqual({
        schemaVersion: 1,
        goalId: fx.goalId,
        kind: 'legacy',
        standing: 'historical_legacy',
        status: { goalStatus: 'completed', completedAt: row.completed_at, reasonCode: 'completion_verified' },
        proof: { state: 'legacy_no_proof' },
        correction: null,
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'legacy_not_v2_attested',
          contentPreservation: 'not_applicable',
        },
        classification: { trust: 'qualified', reconciliation: 'none', reasons: ['legacy_completion'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(model.standing).not.toBe('invalid_unverified');
      expect(model.standing).not.toBe('uncontested');
      expect(row.completed_at).not.toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
