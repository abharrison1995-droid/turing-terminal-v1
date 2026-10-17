import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition, GoalReviewKind } from '../../shared/goals.js';
import { finalizeCycle, reconcileCounters, transitionCycle } from './cycles.js';
import { listGoalEvents } from './events.js';
import { applyReviewFindings, decideFinding } from './findings.js';
import { openFinding, reviewWith } from './remediationKit.js';
import { readRemediationPlan, remediationEpisodeKey } from './remediationPlan.js';
import { determineRemediationPlan } from './remediationSelector.js';
import {
  cleanupRepoFixtures,
  milestone,
  newFinding,
  passDeterministic,
  reportOf,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { loadDefinitionVersion } from './definitions.js';
import { reviewRoleForKind } from './reviewRole.js';
import { completeReview, reviewForCycle } from './reviews.js';
import { transitionGoal } from './stateMachine.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILT_IN = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
};

function goal(
  review: Partial<GoalDefinition['review']> = {},
  options: { definition?: GoalDefinition; tune?: (definition: GoalDefinition) => void } = {},
): Harness {
  return harness({
    ...(options.definition ? { definition: options.definition } : {}),
    tune: (definition) => {
      definition.routing.workflows = { ...BUILT_IN };
      Object.assign(definition.review, review);
      options.tune?.(definition);
    },
  });
}

const taskFor = (key: string) =>
  key === 'm2' ? { ...GOOD_TASK, milestoneKey: 'm2', targetCriteria: ['tests'] } : GOOD_TASK;

const setActive = (h: Harness, key: string | null) =>
  h.fx.db
    .prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?')
    .run(key === null ? null : h.fx.milestoneId(key), h.fx.goalId);
const activeKey = (h: Harness) =>
  (
    h.fx.db
      .prepare(
        'SELECT m.milestone_key AS k FROM goals g LEFT JOIN goal_milestones m ON m.id = g.active_milestone_id WHERE g.id = ?',
      )
      .get(h.fx.goalId) as { k: string | null }
  ).k;

interface CycleView {
  id: string;
  kind: string;
  status: string;
  triggerCode: string;
  sequence: number;
  outcome: Record<string, unknown> | null;
}
const cyclesOf = (h: Harness, kind?: string): CycleView[] =>
  (
    h.fx.db
      .prepare(
        `SELECT id, kind, status, trigger_code, sequence, outcome_json FROM goal_cycles WHERE goal_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY sequence`,
      )
      .all(...(kind ? [h.fx.goalId, kind] : [h.fx.goalId])) as Array<{
      id: string;
      kind: string;
      status: string;
      trigger_code: string;
      sequence: number;
      outcome_json: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    triggerCode: row.trigger_code,
    sequence: row.sequence,
    outcome: row.outcome_json ? (JSON.parse(row.outcome_json) as Record<string, unknown>) : null,
  }));
const remediations = (h: Harness) => cyclesOf(h, 'remediation');
const reviewCycles = (h: Harness) => cyclesOf(h, 'review');
const planOfCycle = (cycle: CycleView) => readRemediationPlan(cycle.outcome)!;

/** Ticks until a cycle is created (evidence collection first), whichever kind. */
async function nextCreated(h: Harness): Promise<void> {
  for (let step = 0; step < 8; step += 1) if ((await h.tick()) === 'cycle_created') return;
  throw new Error('no cycle was created');
}

let sequence = 0;
/** Drives the active (or next) remediation cycle through its proposal and work run to a terminal state. */
async function drive(
  h: Harness,
  end: 'succeed' | 'fail' = 'succeed',
  task: unknown = undefined,
): Promise<void> {
  const milestoneKey = (cyclesOf(h).at(-1)?.outcome?.remediationPlan as { milestoneKey?: string } | undefined)
    ?.milestoneKey;
  sequence += 1;
  h.files.current = { 'src/a.ts': `export const a = ${sequence};\n` };
  h.model.script.push({ ok: true, proposal: task ?? taskFor(milestoneKey ?? 'm1') });
  await h.until('waiting_for_run');
  h.setRunStatus(h.runs().at(-1)!.id, end === 'succeed' ? 'completed' : 'failed');
  await h.until(end === 'succeed' ? 'cycle_succeeded' : 'cycle_failed');
}

const observations = (h: Harness) =>
  (h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_finding_observations').get() as { n: number }).n;
const findingRow = (h: Harness, id: string) =>
  h.fx.db
    .prepare('SELECT status, resolved_by_review_id AS resolvedBy FROM goal_findings WHERE id = ?')
    .get(id) as {
    status: string;
    resolvedBy: string | null;
  };
const select = (h: Harness) => {
  const goalRow = h.fx.db
    .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
    .get(h.fx.goalId) as {
    v: number;
  };
  const version = loadDefinitionVersion(h.fx.db, h.fx.goalId, goalRow.v)!;
  return determineRemediationPlan(h.fx.db, h.fx.goalId, {
    definition: version.definition as GoalDefinition,
    version: version.version,
    tree: h.fx.tree(),
  });
};

/** The accepted Stage-6A end state of a consumed review, with findings applied. */
async function consumeReview(
  h: Harness,
  options: { verdict?: 'pass' | 'block' | 'pass_with_findings'; findings?: Array<{ severity: 'high' }> } = {},
): Promise<void> {
  const cycle = cyclesOf(h, 'review').find(
    (entry) => !['succeeded', 'failed', 'cancelled'].includes(entry.status),
  )!;
  const kind = (cycle.outcome as { reviewPlan: { reviewKind: GoalReviewKind } }).reviewPlan.reviewKind;
  await h.executor.queueReviewRun({
    goalId: h.fx.goalId,
    cycleId: cycle.id,
    baseCommit: h.fx.head(),
    reviewKind: kind,
    reviewRole: reviewRoleForKind(kind),
    reviewerCount: 1,
  });
  const review = reviewForCycle(h.fx.db, cycle.id)!;
  completeReview(h.fx.db, {
    reviewId: review.id,
    report: reportOf({
      verdict: options.verdict ?? 'pass',
      newFindings: (options.findings ?? []).map((entry) =>
        newFinding({ severity: entry.severity, description: `final finding ${randomUUID()}` }),
      ) as never,
    }),
  });
  await applyReviewFindings(h.fx.db, { reviewId: review.id });
  for (const to of ['launching', 'running', 'collecting'] as const)
    transitionCycle(h.fx.db, { cycleId: cycle.id, to });
  finalizeCycle(h.fx.db, { cycleId: cycle.id, to: 'succeeded', outcomeCode: 'review_consumed' });
  transitionGoal(h.fx.db, {
    goalId: h.fx.goalId,
    to: 'running',
    reasonCode: 'review_passed',
    actor: 'supervisor',
  });
}

const decide = (h: Harness, findingId: string, decision: 'accepted_by_user' | 'dismissed_by_user') =>
  decideFinding(h.fx.db, {
    goalId: h.fx.goalId,
    findingId,
    decision,
    actor: 'user',
    approvalId: h.fx.approval('finding_decision', {
      findingId,
      decision,
      definitionVersion: 1,
      definitionHash: h.fx.currentHash(),
    }),
  });

describe('remediation scheduling placement and effects', () => {
  it(
    'a current threshold finding creates exactly one remediation cycle with its write-once plan and does no run, route, approval or provider work',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const high = await openFinding(h.fx, 'high');
      const approvalsBefore = (
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get() as { n: number }
      ).n;
      const eventsBefore = listGoalEvents(h.fx.db, h.fx.goalId).length;
      expect(await h.tick()).toBe('cycle_created');
      const [cycle] = remediations(h);
      expect(cycle).toMatchObject({
        kind: 'remediation',
        triggerCode: 'finding_remediation',
        status: 'planned',
      });
      expect(planOfCycle(cycle!)).toMatchObject({
        schema: 1,
        definitionVersion: 1,
        milestoneKey: 'm1',
        episodes: [{ findingId: high, reason: 'threshold' }],
      });
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect((h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get() as { n: number }).n).toBe(
        approvalsBefore,
      );
      expect(h.model.calls).toBe(0);
      expect(h.executor.proposalQueueCalls).toHaveLength(0);
      expect(h.executor.queueCalls).toHaveLength(0);
      expect(h.startRun).not.toHaveBeenCalled();
      const added = listGoalEvents(h.fx.db, h.fx.goalId).slice(eventsBefore);
      expect(added.map((event) => event.type)).toEqual(['cycle_created']);
      expect(added.some((event) => /route|approval|run/.test(event.type))).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a review trigger that is due wins over remediation, which follows once the review ends',
    async () => {
      const h = goal({
        periodic: { everyNExecutionCycles: 1, reviewerCount: 1, scope: 'since_last_review' },
      });
      await h.start();
      setActive(h, 'm1');
      await openFinding(h.fx, 'high');
      h.fx.db
        .prepare(
          `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status,
           base_integration_commit, outcome_json, created_at, finished_at)
         VALUES (?, ?, 1, 1, 'execution', 'test_work', 'succeeded', ?, '{"code":"integrated"}', ?, ?)`,
        )
        .run(randomUUID(), h.fx.goalId, h.fx.head(), new Date().toISOString(), new Date().toISOString());
      reconcileCounters(h.fx.db, h.fx.goalId);
      expect(await h.tick()).toBe('cycle_created');
      expect(reviewCycles(h)).toHaveLength(1);
      expect(remediations(h)).toHaveLength(0);
      await consumeReview(h);
      expect(await h.tick()).toBe('cycle_created');
      expect(remediations(h)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'advisory findings are not remediated: ordinary execution proceeds unchanged and carries no plan',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      await openFinding(h.fx, 'low');
      await openFinding(h.fx, 'medium'); // no medium limit configured
      expect(await h.tick()).toBe('cycle_created');
      expect(remediations(h)).toHaveLength(0);
      const [cycle] = cyclesOf(h);
      expect(cycle).toMatchObject({ kind: 'execution', triggerCode: 'next_task' });
      expect(cycle!.outcome).toBeNull();
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await h.until('waiting_for_run');
      const memory = h.executor.proposalQueueCalls[0]!.memory;
      expect(memory.nextHint).toBeUndefined();
      expect(memory.openFindings[0]!.severity).toBe('medium'); // ordinary severity order, no focus
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the proposal for a remediation cycle sees the selected findings first and a trusted hint',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const focus = await openFinding(h.fx, 'high');
      // A more severe finding that is NOT selected (a different milestone) would normally sort first.
      await openFinding(h.fx, 'critical', { kind: 'milestone', milestone: 'm2' });
      await h.tick(); // the critical m2 finding has priority: it is the one selected
      const [cycle] = remediations(h);
      const selected = planOfCycle(cycle!).episodes.map((episode) => episode.findingId);
      expect(selected).not.toContain(focus);
      h.model.script.push({ ok: true, proposal: taskFor('m2') });
      await h.until('waiting_for_run');
      const memory = h.executor.proposalQueueCalls[0]!.memory;
      expect(memory.openFindings[0]!.goalFindingId).toBe(selected[0]);
      expect(memory.nextHint).toContain('Remediation cycle');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('final pass_with_findings end to end', () => {
  it(
    'remediates once, leaves the finding open, and only then lets the stale final review run again',
    async () => {
      const h = goal(
        { final: true },
        {
          definition: simpleDefinition({
            policy: { requireFinalReview: true },
            milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])],
          }),
        },
      );
      await passDeterministic(h.fx);
      await h.start();
      await nextCreated(h);
      expect(reviewCycles(h)).toMatchObject([{ outcome: { reviewPlan: { reviewKind: 'final' } } }]);
      await consumeReview(h, { verdict: 'pass_with_findings', findings: [{ severity: 'high' }] });
      setActive(h, 'm2'); // what the milestone's own work persisted earlier
      const [open] = h.fx.db.prepare("SELECT id FROM goal_findings WHERE status = 'open'").all() as Array<{
        id: string;
      }>;

      // The current final review suppresses an identical one, and completion is not attempted: remediation comes instead.
      expect(await h.tick()).toBe('cycle_created');
      expect(reviewCycles(h)).toHaveLength(1);
      expect(
        listGoalEvents(h.fx.db, h.fx.goalId).some((event) => event.type === 'completion_evaluated'),
      ).toBe(false);
      const [cycle] = remediations(h);
      expect(planOfCycle(cycle!)).toMatchObject({ milestoneKey: 'm2', episodes: [{ findingId: open!.id }] });

      const observationsBefore = observations(h);
      const headBefore = h.fx.head();
      await drive(h);
      expect(h.executor.proposalQueueCalls).toHaveLength(1);
      expect(h.executor.queueCalls[0]).toMatchObject({ purpose: 'remediation' });
      expect(h.fx.head()).not.toBe(headBefore);
      // Remediation changed the repository but did not resolve, accept, dismiss or observe the finding.
      expect(findingRow(h, open!.id)).toEqual({ status: 'open', resolvedBy: null });
      expect(observations(h)).toBe(observationsBefore);
      // The episode is consumed, so the same stale assessment does not remediate again.
      expect(select(h)).toEqual({ ok: true, plan: null });

      // New head: the old final review is stale and the existing final trigger is due again.
      await passDeterministic(h.fx);
      await nextCreated(h);
      expect(remediations(h)).toHaveLength(1);
      expect(reviewCycles(h)).toHaveLength(2);
      expect(reviewCycles(h)[1]!.outcome).toMatchObject({ reviewPlan: { reviewKind: 'final' } });
      expect(findingRow(h, open!.id).status).toBe('open');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('blocking review path', () => {
  it(
    'does not auto-resume; after the user resumes, a current blocking finding is remediated even when advisory by threshold',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const medium = await openFinding(h.fx, 'medium', {
        kind: 'milestone',
        milestone: 'm1',
        verdict: 'block',
      });
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'blocked',
        reasonCode: 'review_blocked',
        actor: 'supervisor',
      });
      expect(await h.tick()).toBe('idle');
      expect(cyclesOf(h)).toHaveLength(0);
      expect(h.status()).toMatchObject({ status: 'blocked', reason: 'review_blocked' });
      expect(
        await h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'blocker_resolved' }),
      ).toEqual({
        ok: true,
      });
      expect(await h.tick()).toBe('cycle_created');
      expect(planOfCycle(remediations(h)[0]!).episodes).toMatchObject([
        { findingId: medium, reason: 'blocking_review' },
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'with no valid milestone anchor the Goal is blocked with a bounded detail and nothing is scheduled',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, null);
      const high = await openFinding(h.fx, 'high', { kind: 'final' });
      expect(await h.tick()).toBe('remediation_unavailable');
      expect(h.status()).toMatchObject({ status: 'blocked', reason: 'review_blocked' });
      const detail = JSON.parse(
        (
          h.fx.db.prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?').get(h.fx.goalId) as {
            d: string;
          }
        ).d,
      );
      expect(detail).toEqual({ code: 'remediation_milestone_unavailable', findingId: high });
      expect(cyclesOf(h)).toHaveLength(0);
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(h.model.calls).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

type LoosePlan = {
  milestoneKey: string;
  episodes: Array<{ findingId: string; lastSeenReviewId: string }>;
} & Record<string, unknown>;

describe('plan reproof before provider work', () => {
  it(
    'a user decision between scheduling and the proposal retires the cycle without any provider call',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const high = await openFinding(h.fx, 'high');
      const headBefore = h.fx.head();
      expect(await h.tick()).toBe('cycle_created');
      decide(h, high, 'dismissed_by_user');
      const seen = await h.until('remediation_retired', 4);
      expect(seen.at(-1)).toBe('remediation_retired');
      expect(remediations(h)).toHaveLength(1);
      expect(remediations(h)[0]).toMatchObject({
        status: 'cancelled',
        outcome: { code: 'remediation_no_longer_current' },
      });
      expect(h.executor.proposalQueueCalls).toHaveLength(0);
      expect(h.model.calls).toBe(0);
      expect(h.startRun).not.toHaveBeenCalled();
      expect(h.fx.head()).toBe(headBefore);
      // Nothing is substituted into the retired cycle; the next decision is recomputed from current state (ordinary work).
      expect(await h.tick()).toBe('cycle_created');
      expect(cyclesOf(h).at(-1)).toMatchObject({ kind: 'execution', triggerCode: 'next_task' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a finding seen again by a newer review retires the cycle too, and the new episode is scheduled next',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const high = await openFinding(h.fx, 'high');
      await h.tick();
      await reviewWith(h.fx, { existing: [{ goalFindingId: high, status: 'still_open' }] });
      await h.until('remediation_retired', 4);
      expect(h.executor.proposalQueueCalls).toHaveLength(0);
      expect(await h.tick()).toBe('cycle_created');
      const [first, second] = remediations(h);
      expect(planOfCycle(second!).episodes[0]!.episodeKey).not.toBe(
        planOfCycle(first!).episodes[0]!.episodeKey,
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  const tampers: Array<[string, (plan: LoosePlan, ctx: { other: string }) => unknown]> = [
    [
      'bad episode hash',
      (plan) => ({ ...plan, episodes: [{ ...plan.episodes[0], episodeKey: 'a'.repeat(64) }] }),
    ],
    ['duplicate finding', (plan) => ({ ...plan, episodes: [plan.episodes[0], plan.episodes[0]] })],
    [
      'wrong definition version',
      (plan) => ({
        ...plan,
        definitionVersion: 2,
        episodes: plan.episodes.map((episode: Record<string, string>) => ({
          ...episode,
          episodeKey: remediationEpisodeKey({
            findingId: episode.findingId!,
            lastSeenReviewId: episode.lastSeenReviewId!,
            definitionVersion: 2,
            milestoneKey: plan.milestoneKey,
          }),
        })),
      }),
    ],
    [
      'wrong milestone',
      (plan) => ({
        ...plan,
        milestoneKey: 'm2',
        episodes: plan.episodes.map((episode: Record<string, string>) => ({
          ...episode,
          episodeKey: remediationEpisodeKey({
            findingId: episode.findingId!,
            lastSeenReviewId: episode.lastSeenReviewId!,
            definitionVersion: 1,
            milestoneKey: 'm2',
          }),
        })),
      }),
    ],
    [
      'unknown finding',
      (plan) => {
        const findingId = randomUUID();
        return {
          ...plan,
          episodes: [
            {
              ...plan.episodes[0],
              findingId,
              episodeKey: remediationEpisodeKey({
                findingId,
                lastSeenReviewId: plan.episodes[0].lastSeenReviewId,
                definitionVersion: 1,
                milestoneKey: plan.milestoneKey,
              }),
            },
          ],
        };
      },
    ],
    ['oversized', (plan) => ({ ...plan, episodes: Array.from({ length: 7 }, () => plan.episodes[0]) })],
    ['unknown key', (plan) => ({ ...plan, extra: true })],
  ];
  for (const [name, tamper] of tampers) {
    it(
      `fails closed on a corrupt persisted plan (${name}) at both queue points`,
      async () => {
        for (const stage of ['proposal', 'launch'] as const) {
          const h = goal();
          await h.start();
          setActive(h, 'm1');
          await openFinding(h.fx, 'high');
          await h.tick();
          const [cycle] = remediations(h);
          const original = planOfCycle(cycle!);
          if (stage === 'launch') {
            h.model.script.push({ ok: true, proposal: GOOD_TASK });
            await h.until('launch_started');
          }
          h.fx.db
            .prepare('UPDATE goal_cycles SET outcome_json = ? WHERE id = ?')
            .run(JSON.stringify({ remediationPlan: tamper(original as never, { other: '' }) }), cycle!.id);
          const seen = await h.until('cycle_failed', 4);
          expect(seen.at(-1)).toBe('cycle_failed');
          expect(remediations(h)[0]).toMatchObject({
            status: 'failed',
            outcome: { code: 'remediation_plan_invalid' },
          });
          expect(h.executor.queueCalls).toHaveLength(0);
          expect(stage === 'proposal' ? h.executor.proposalQueueCalls : []).toHaveLength(0);
          expect(h.runs()).toHaveLength(0);
        }
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  }

  it(
    'a remediation cycle with no plan at all fails closed',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      await openFinding(h.fx, 'high');
      await h.tick();
      h.fx.db.prepare('UPDATE goal_cycles SET outcome_json = NULL WHERE id = ?').run(remediations(h)[0]!.id);
      await h.until('cycle_failed', 4);
      expect(remediations(h)[0]).toMatchObject({
        status: 'failed',
        outcome: { code: 'remediation_plan_invalid' },
      });
      expect(h.executor.proposalQueueCalls).toHaveLength(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('episode consumption and the review → remediation → review loop', () => {
  it(
    'only a succeeded, integrated, op-proved remediation consumes an episode; a later review makes a new one',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const high = await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
      await nextCreated(h);
      const firstKey = planOfCycle(remediations(h)[0]!).episodes[0]!.episodeKey;
      await drive(h);
      expect(findingRow(h, high)).toEqual({ status: 'open', resolvedBy: null });
      expect(select(h)).toEqual({ ok: true, plan: null }); // stale assessment never remediates twice

      await reviewWith(h.fx, {
        kind: 'milestone',
        milestone: 'm1',
        existing: [{ goalFindingId: high, status: 'still_open' }],
      });
      const next = select(h);
      expect(next.ok && next.plan?.episodes[0]!.episodeKey).toBeTruthy();
      await nextCreated(h);
      const [first, second] = remediations(h);
      expect(planOfCycle(second!).episodes[0]!.episodeKey).not.toBe(firstKey);
      expect(planOfCycle(first!).episodes[0]!.findingId).toBe(planOfCycle(second!).episodes[0]!.findingId);
      await drive(h);
      expect(findingRow(h, high)).toEqual({ status: 'open', resolvedBy: null });
      expect(select(h)).toEqual({ ok: true, plan: null });
      const attempts = h.fx.db
        .prepare('SELECT remediation_attempts_json AS j FROM goal_runtime WHERE goal_id = ?')
        .get(h.fx.goalId) as { j: string };
      expect(JSON.parse(attempts.j)).toEqual({ m1: 2 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'consumed episodes are skipped and the remainder of a capped group is scheduled next',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      for (let index = 0; index < 7; index += 1) await openFinding(h.fx, 'high');
      await nextCreated(h);
      const first = planOfCycle(remediations(h)[0]!);
      expect(first.episodes).toHaveLength(6);
      await drive(h);
      await nextCreated(h);
      const second = planOfCycle(remediations(h)[1]!);
      expect(second.episodes).toHaveLength(1);
      const used = new Set(first.episodes.map((episode) => episode.findingId));
      expect(used.has(second.episodes[0]!.findingId)).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'after one milestone group is consumed another milestone group is scheduled',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      const onM2 = await openFinding(h.fx, 'critical', { kind: 'milestone', milestone: 'm2' });
      const onM1 = await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
      await nextCreated(h);
      expect(planOfCycle(remediations(h)[0]!)).toMatchObject({
        milestoneKey: 'm2',
        episodes: [{ findingId: onM2 }],
      });
      expect(activeKey(h)).toBe('m2');
      await drive(h);
      await nextCreated(h);
      expect(planOfCycle(remediations(h)[1]!)).toMatchObject({
        milestoneKey: 'm1',
        episodes: [{ findingId: onM1 }],
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('failed, rejected and cancelled remediation; existing bounds', () => {
  const setup = async (tune?: (definition: GoalDefinition) => void) => {
    const h = goal({}, tune ? { tune } : {});
    await h.start();
    setActive(h, 'm2');
    const high = await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
    return { h, high };
  };
  const counters = (h: Harness) =>
    h.fx.db
      .prepare(
        'SELECT cycles_executed AS cycles, consecutive_failed_cycles AS failed, remediation_attempts_json AS attempts FROM goal_runtime WHERE goal_id = ?',
      )
      .get(h.fx.goalId) as { cycles: number; failed: number; attempts: string };

  it(
    'failed and rejected attempts do not consume the episode and use the existing per-milestone bound',
    async () => {
      const { h } = await setup();
      await nextCreated(h);
      await drive(h, 'fail'); // attempt 1: failed run
      await nextCreated(h);
      h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, milestoneKey: 'm2' } }); // wrong milestone → rejected
      await h.until('proposal_rejected');
      expect(remediations(h).map((cycle) => cycle.status)).toEqual(['failed', 'rejected']);
      await nextCreated(h);
      await drive(h, 'fail'); // attempt 3
      const keys = remediations(h).map((cycle) => planOfCycle(cycle).episodes[0]!.episodeKey);
      expect(new Set(keys).size).toBe(1);
      expect(counters(h)).toMatchObject({ cycles: 3, failed: 3 });
      expect(JSON.parse(counters(h).attempts)).toEqual({ m1: 3 });

      // The fourth attempt is refused by maxRemediationAttempts; the active milestone is not moved by the failed creation.
      setActive(h, 'm2');
      const created = remediations(h).length;
      expect(await h.tick()).toBe('evidence_collected');
      expect(await h.tick()).toBe('bound_blocked');
      expect(h.status()).toMatchObject({ status: 'blocked', reason: 'bound_remediation' });
      expect(remediations(h)).toHaveLength(created);
      expect(activeKey(h)).toBe('m2');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a cancelled remediation consumes nothing and is not counted as an attempt',
    async () => {
      const { h } = await setup();
      await nextCreated(h);
      const first = remediations(h)[0]!;
      finalizeCycle(h.fx.db, { cycleId: first.id, to: 'cancelled', outcomeCode: 'cancelled' });
      expect(JSON.parse(counters(h).attempts)).toEqual({});
      await nextCreated(h);
      const [, second] = remediations(h);
      expect(planOfCycle(second!).episodes[0]!.episodeKey).toBe(planOfCycle(first).episodes[0]!.episodeKey);
      expect(counters(h)).toMatchObject({ cycles: 0, failed: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the global consecutive-failure bound still wins over remediation scheduling',
    async () => {
      const { h } = await setup((definition) => {
        definition.limits.maxConsecutiveFailedCycles = 2;
      });
      await nextCreated(h);
      await drive(h, 'fail');
      await nextCreated(h);
      await drive(h, 'fail');
      expect(await h.tick()).toBe('bound_blocked');
      expect(h.status()).toMatchObject({ status: 'blocked', reason: 'bound_failures' });
      expect(remediations(h)).toHaveLength(2);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the execution-cycle bound also keeps its authority',
    async () => {
      const { h } = await setup((definition) => {
        definition.limits.maxExecutionCycles = 1;
      });
      await nextCreated(h);
      await drive(h, 'fail');
      expect(await h.tick()).toBe('bound_blocked');
      expect(h.status()).toMatchObject({ status: 'blocked', reason: 'bound_cycles' });
      expect(remediations(h)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('restart and idempotency', () => {
  it(
    'a fresh supervisor on every tick yields one cycle, one proposal, one run, one integration and the same plan',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      await openFinding(h.fx, 'high');
      sequence += 1;
      h.files.current = { 'src/a.ts': `export const a = ${sequence};\n` };
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      const headBefore = h.fx.head();
      let planAtCreation: string | undefined;
      let action = '';
      for (let index = 0; index < 40 && action !== 'cycle_succeeded'; index += 1) {
        const fresh = h.restart();
        action = (await fresh.supervisor.tickGoal(h.fx.goalId)).action;
        planAtCreation ??= remediations(h)[0]
          ? JSON.stringify(remediations(h)[0]!.outcome?.remediationPlan)
          : undefined;
        if (action === 'waiting_for_run') h.setRunStatus(h.runs().at(-1)!.id, 'completed');
      }
      expect(action).toBe('cycle_succeeded');
      expect(remediations(h)).toHaveLength(1);
      expect(h.proposalRuns()).toHaveLength(1);
      expect(h.runs()).toHaveLength(1);
      expect(h.model.calls).toBe(1);
      expect(JSON.stringify(remediations(h)[0]!.outcome?.remediationPlan)).toBe(planAtCreation);
      expect(
        h.fx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE op = 'advance' AND status = 'applied'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(h.fx.head()).not.toBe(headBefore);
      expect(h.fx.git('rev-list', '--count', `${headBefore}..${h.fx.head()}`)).toBe('1');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a restart before the cycle exists, and a duplicate tick, never create a second cycle or change the target',
    async () => {
      const h = goal();
      await h.start();
      setActive(h, 'm1');
      await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
      const [a, b] = await Promise.all([
        h.supervisor.tickGoal(h.fx.goalId),
        h.supervisor.tickGoal(h.fx.goalId),
      ]);
      expect([a.action, b.action].filter((action) => action === 'cycle_created')).toHaveLength(1);
      const before = JSON.stringify(remediations(h)[0]!.outcome);
      setActive(h, 'm2'); // a changed active milestone must not move an existing cycle's target
      await h.restart().supervisor.tickGoal(h.fx.goalId);
      expect(remediations(h)).toHaveLength(1);
      expect(JSON.stringify(remediations(h)[0]!.outcome)).toBe(before);
      expect(planOfCycle(remediations(h)[0]!).milestoneKey).toBe('m1');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
