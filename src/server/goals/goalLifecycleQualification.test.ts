import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { openDatabase } from '../db.js';
import { RunEngine } from '../runEngine.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { repositoryState } from './goalV2TestKit.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import {
  approveDefinition,
  attestObservation,
  call,
  changedTables,
  closeLifecycle,
  completedState,
  correctAttestation,
  expectCompleted,
  FORMATS,
  goalRow,
  installFakeProviders,
  lifecycle,
  openAndDriveToVerifiedHandoff,
  openGoal,
  proofRows,
  proofRowsJson,
  REVIEW_STAGE_ROLES,
  snapshotOf,
  wholeDatabase,
  type CompletionRequest,
} from './goalLifecycleKit.js';

/**
 * Real-execution lifecycle qualification of one version-2 Goal. The fakes are the provider process boundary
 * (`providers.js`, with deterministic provider response texts) and the route-validation rows seeded by
 * `seedFakeRouteValidations`, which stand in for a live provider probe. The supervisor, the RunEngine, the broker, the
 * verifier, the review and acceptance gates, the approve/start/decision/handoff/attest HTTP routes, the correction and
 * completion services, Git and SQLite are all real. No test code calls `acceptedFixture`, `completeReview`, or writes a
 * Goal table directly. The restart drives a fresh supervisor and a fresh app on the same database.
 *
 * NOT PROVEN HERE: OS-level crash durability (no process is killed mid-write), WAL recovery after a killed process,
 * partial-fsync behaviour, Windows path/ref/common-dir semantics, physical iPhone, live Tailscale, and live provider
 * validation. The old supervisor is not explicitly stopped before the restart; the fresh one is what drives the rest.
 *
 * The shared steps live in goalLifecycleKit.ts. Corrections other than the dispute, and the merge characterization,
 * live in goalLifecycleCorrections.test.ts.
 */
vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Live provider calls are disabled in Goal acceptance tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

beforeEach(() => installFakeProviders());

afterEach(async () => closeLifecycle());

describe('Q1 one version-2 Goal from real bounded execution to a corrected completion', () => {
  it.each(FORMATS)(
    'Q1 dispute (%s): one v2 Goal from real execution through a corrected completion',
    async (objectFormat) => {
      const { harness, db, repo, goalId, target, externalPath, observation, afterIntegration } =
        await openAndDriveToVerifiedHandoff(objectFormat);

      // Step 5: attestation through the real HTTP route, then the real preflight and decision services.
      const attestationId = await attestObservation(externalPath, observation.actionDigest);
      expect(repositoryState(repo)).toEqual(afterIntegration);

      const preflight = await computeExternalCompletionPreflight(db, goalId, { attestationId });
      expect(preflight.outcome).toBe('ready');
      const decision = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId,
        reviewedPreflightDigest: preflight.digest,
        acknowledgeContentNotProven: true,
      });
      expect(decision).toMatchObject({ status: 'approved', reused: false });
      const request: CompletionRequest = {
        goalId,
        attestationId,
        reviewedPreflightDigest: preflight.digest,
        acknowledgeContentNotProven: true,
      };

      // Step 6: the completion, and its whole-state effect.
      const before = snapshotOf(target, decision.approvalId);
      const completed = await completeGoalFromExternalDecision(db, request);
      expect(completed.reused).toBe(false);
      expect(completed.completion).toMatchObject({
        state: 'completed',
        approvalId: decision.approvalId,
        preflightDigest: preflight.digest,
      });
      expectCompleted(target, before, decision.approvalId);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base'",
          )
          .get(goalId),
      ).toEqual({ n: 0 });
      expect(readStoredCompletion(db, goalId)).toMatchObject({
        state: 'completed',
        proofId: completed.completion.proofId,
      });
      const proofId = completed.completion.proofId;
      const proofBytes = proofRowsJson(db, goalId);
      const completedGoal = goalRow(db, goalId);

      // Close the database and reopen it from the same data root. Every read below is on the reopened connection.
      await harness.close();
      lifecycle.harness = undefined;
      await lifecycle.restartedApp!.close();
      lifecycle.restartedApp = undefined;
      lifecycle.serving = undefined;
      db.close();
      const reopened = openDatabase(dirname(repo));
      try {
        const reopenedTarget = { db: reopened, goalId, repo };
        expectCompleted(reopenedTarget, before, decision.approvalId);
        expect(proofRowsJson(reopened, goalId)).toBe(proofBytes);
        expect(goalRow(reopened, goalId)).toEqual(completedGoal);

        // Step 7: the dispute through the real correction services: request, user decision, then the correction.
        const explanation = 'Disputed by the Q1 lifecycle qualification.';
        const beforeDispute = completedState(reopenedTarget);
        const beforeDisputeWhole = wholeDatabase(reopened);
        correctAttestation(reopened, {
          goalId,
          attestationId,
          correctionKind: 'dispute',
          reasonCode: 'observation_error',
          replacementAttestationId: null,
          explanation,
        });

        expect(completedState(reopenedTarget)).toEqual(beforeDispute);
        expect(goalRow(reopened, goalId)).toEqual(completedGoal);
        expect(proofRowsJson(reopened, goalId)).toBe(proofBytes);
        expect(changedTables(beforeDisputeWhole, wholeDatabase(reopened))).toEqual([
          'goal_approvals',
          'goal_attestation_corrections',
          'goal_events',
        ]);
        const standing = readGoalCompletionStanding(reopened, goalId);
        expect(standing).toMatchObject({ kind: 'v2', standing: 'disputed' });
        expect(repositoryState(repo)).toEqual(afterIntegration);

        // The HTTP read agrees with the standing reader on the same database.
        const readApp = createApp({ database: reopened, engine: new RunEngine(reopened, () => undefined) });
        try {
          await readApp.ready();
          const detail = await readApp.inject({ method: 'GET', url: `/api/goals/${goalId}` });
          expect(detail.statusCode).toBe(200);
          expect(
            (detail.json() as { goal: { completionStanding: unknown } }).goal.completionStanding,
          ).toEqual(standing);
        } finally {
          await readApp.close();
        }

        // An exact replay of the completion request returns the original proof, and writes nothing.
        const replayBefore = wholeDatabase(reopened);
        const replayRepo = repositoryState(repo);
        const replay = await completeGoalFromExternalDecision(reopened, request);
        expect(replay).toEqual({ reused: true, completion: completed.completion });
        expect(replay.completion.proofId).toBe(proofId);
        expect(wholeDatabase(reopened)).toEqual(replayBefore);
        expect(repositoryState(repo)).toEqual(replayRepo);
        expect(proofRowsJson(reopened, goalId)).toBe(proofBytes);
      } finally {
        if (reopened.open) reopened.close();
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'Q1b (%s): a decided A whose destination advanced after observation blocks B until A is disputed, then B completes',
    async (objectFormat) => {
      const { db, repo, goalId, externalPath, observation, harness } =
        await openAndDriveToVerifiedHandoff(objectFormat);

      // A is attested through the real route and decided through the real decision service.
      const attestationA = await attestObservation(externalPath, observation.actionDigest);
      const preflightA = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: attestationA,
      });
      expect(preflightA.outcome).toBe('ready');
      const decisionA = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId: attestationA,
        reviewedPreflightDigest: preflightA.digest,
        acknowledgeContentNotProven: true,
      });
      expect(decisionA).toMatchObject({ status: 'approved', reused: false });
      const rowA = db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(decisionA.approvalId);

      // The destination advances with a real commit after A was observed. A is not corrected.
      harness.fx.git('rev-parse', 'main');
      writeFileSync(join(repo, 'after-a.txt'), 'destination advanced after A was observed\n');
      harness.fx.git('add', 'after-a.txt');
      harness.fx.git('commit', '-m', 'user advances destination after A');
      const staleA = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attestationA },
        { allowRecordedDecision: true },
      );
      expect(staleA).toMatchObject({ outcome: 'refused' });
      // Observed: the source is still integrated and only the tip advanced, so A is historical, not stale.
      expect(staleA.reasons[0]).toMatchObject({ code: 'destination_advanced_after_observation' });
      expect(db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(decisionA.approvalId)).toEqual(rowA);
      expect(goalRow(db, goalId)).toMatchObject({ status: 'running', completed_at: null });
      expect(proofRows(db, goalId)).toEqual([]);

      // B is attested at the new destination tip through the real route.
      const verifiedB = await call('GET', `${externalPath}/verification`);
      expect(verifiedB).toMatchObject({ status: 200, body: { verification: { state: 'verified' } } });
      const observationB = (verifiedB.body.verification as { observation: { actionDigest: string } })
        .observation;
      const attestationB = await attestObservation(externalPath, observationB.actionDigest);

      // While A is still eligible, B is blocked as a competing decision by every route.
      const blockedB = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attestationB },
        { allowRecordedDecision: true },
      );
      expect(blockedB).toMatchObject({ outcome: 'refused' });
      expect(blockedB.reasons[0]).toMatchObject({ code: 'completion_already_recorded' });
      const beforeBlocked = wholeDatabase(db);
      const repoBeforeBlocked = repositoryState(repo);
      await expect(
        recordExternalCompletionDecision(db, {
          goalId,
          attestationId: attestationB,
          reviewedPreflightDigest: blockedB.digest,
          acknowledgeContentNotProven: true,
        }),
      ).rejects.toMatchObject({ code: 'competing_decision', detail: null });
      const blockedPost = await call(
        'POST',
        `/api/goals/${goalId}/completion-decision`,
        {
          decision: 'record_completion_decision',
          attestationId: attestationB,
          acknowledgeContentNotProven: true,
        },
        { 'if-match': `"${blockedB.digest}"` },
      );
      expect(blockedPost).toMatchObject({ status: 409, body: { code: 'competing_decision' } });
      expect(wholeDatabase(db)).toEqual(beforeBlocked);
      expect(repositoryState(repo)).toEqual(repoBeforeBlocked);

      // The user disputes A through the real correction services. Only the correction's own tables change.
      const explanation = 'Disputed by the Q1b stale-A qualification.';
      const beforeDispute = wholeDatabase(db);
      const repoBeforeDispute = repositoryState(repo);
      correctAttestation(db, {
        goalId,
        attestationId: attestationA,
        correctionKind: 'dispute',
        reasonCode: 'observation_error',
        replacementAttestationId: null,
        explanation,
      });
      expect(changedTables(beforeDispute, wholeDatabase(db))).toEqual([
        'goal_approvals',
        'goal_attestation_corrections',
        'goal_events',
      ]);
      expect(db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(decisionA.approvalId)).toEqual(rowA);
      expect(proofRows(db, goalId)).toEqual([]);
      expect(goalRow(db, goalId)).toMatchObject({ status: 'running', completed_at: null });
      expect(repositoryState(repo)).toEqual(repoBeforeDispute);

      // With A disputed, B is recorded through the real decision service.
      const readyB = await computeExternalCompletionPreflight(db, goalId, { attestationId: attestationB });
      expect(readyB.outcome).toBe('ready');
      const decisionB = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId: attestationB,
        reviewedPreflightDigest: readyB.digest,
        acknowledgeContentNotProven: true,
      });
      expect(decisionB).toMatchObject({ status: 'approved', reused: false });
      expect(decisionB.approvalId).not.toBe(decisionA.approvalId);
      expect(proofRows(db, goalId)).toEqual([]);
      expect(goalRow(db, goalId)).toMatchObject({ status: 'running', completed_at: null });

      // Complete B separately: the proof names B, and A is reported as disputed.
      const requestB = {
        goalId,
        attestationId: attestationB,
        reviewedPreflightDigest: readyB.digest,
        acknowledgeContentNotProven: true,
      };
      const completedB = await completeGoalFromExternalDecision(db, requestB);
      expect(completedB.reused).toBe(false);
      expect(completedB.completion).toMatchObject({ state: 'completed', approvalId: decisionB.approvalId });
      expect(proofRows(db, goalId)).toHaveLength(1);
      expect(goalRow(db, goalId)).toMatchObject({ status: 'completed' });
      expect(readGoalCompletionStanding(db, goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        otherAttestations: expect.arrayContaining([
          expect.objectContaining({ attestationId: attestationA, standing: 'disputed' }),
        ]),
      });
      expect(db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(decisionA.approvalId)).toEqual(rowA);

      // An exact replay of B's completion returns the same proof and writes nothing.
      const replayBefore = wholeDatabase(db);
      const replay = await completeGoalFromExternalDecision(db, requestB);
      expect(replay).toEqual({ reused: true, completion: completedB.completion });
      expect(wholeDatabase(db)).toEqual(replayBefore);
      expect(proofRows(db, goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a same-family final reviewer is refused as review_queue_error with queueCode plan_unavailable, attributed to the family check by contrast with the passing different-family run (sha1)',
    async () => {
      const harness = await openGoal('claude-opus-5-5', 'sha1');
      const { db, repo, goalId } = harness.fx;
      const approval = await approveDefinition(db, goalId);
      expect(approval.response).toMatchObject({ status: 200, body: { goalStatus: 'ready' } });
      const started = await call('POST', `/api/goals/${goalId}/start`, {});
      expect(started).toMatchObject({ status: 200 });

      await harness.until('review_decision_needed');
      const reviewCycle = db
        .prepare(
          "SELECT status, outcome_json FROM goal_cycles WHERE goal_id = ? AND kind = 'review' ORDER BY sequence DESC LIMIT 1",
        )
        .get(goalId) as { status: string; outcome_json: string };
      expect(reviewCycle.status).toBe('failed');
      expect(JSON.parse(reviewCycle.outcome_json)).toMatchObject({
        code: 'review_queue_error',
        queueCode: 'plan_unavailable',
      });
      // Changed assertion. Before: `providerCalls.some((request) => request.role === 'final-reviewer')` was always false,
      // because no production stage has that role; the final reviewer runs as the `final-gate` stage. After: no review
      // stage at all reached the provider, so the refusal happened before any review was dispatched.
      expect(lifecycle.providerCalls.some((request) => REVIEW_STAGE_ROLES.includes(request.role))).toBe(
        false,
      );
      expect(goalRow(db, goalId)).toMatchObject({
        status: 'needs_user',
        status_reason_code: 'review_needs_decision',
      });
      expect(proofRows(db, goalId)).toEqual([]);

      const before = wholeDatabase(db);
      const repoBefore = repositoryState(repo);
      const evaluation = await evaluateCompletion(db, goalId);
      expect(evaluation.finalReview).toMatchObject({
        required: true,
        ok: false,
        reason: 'final_review_missing',
      });
      expect(evaluation.failures.map((failure) => failure.code)).toEqual([
        'final_review_missing',
        'final_acceptance_missing',
        'external_completion_not_activated',
      ]);
      expect(wholeDatabase(db)).toEqual(before);
      expect(repositoryState(repo)).toEqual(repoBefore);
      expect(proofRows(db, goalId)).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
