import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition, GoalReviewKind } from '../../shared/goals.js';
import { diffLineCount } from '../goalGit.js';
import { finalizeCycle, reconcileCounters, transitionCycle } from './cycles.js';
import { listGoalEvents } from './events.js';
import {
  BUILD,
  cleanupRepoFixtures,
  milestone,
  TESTS,
  passDeterministic,
  reportOf,
  simpleDefinition,
} from './repoKit.js';
import { coveredByExpected, determineReviewTrigger } from './reviewTriggers.js';
import { completeReview, reviewForCycle } from './reviews.js';
import { reviewRoleForKind } from './reviewRole.js';
import { transitionGoal } from './stateMachine.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILT_IN = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
};

type ReviewPolicy = GoalDefinition['review'];

/** A Goal with the given automatic review triggers enabled (the shared harness disables them by default). */
function goal(
  review: Partial<ReviewPolicy>,
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

/** A terminal work cycle fabricated straight into history (counters reconciled by the caller). */
function addWork(
  h: Harness,
  status: 'succeeded' | 'failed' | 'rejected' | 'cancelled',
  over: {
    kind?: 'execution' | 'remediation';
    version?: number;
    task?: unknown;
    result?: string;
  } = {},
): string {
  const id = randomUUID();
  const sequence =
    (
      h.fx.db
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM goal_cycles WHERE goal_id = ?')
        .get(h.fx.goalId) as { s: number }
    ).s + 1;
  h.fx.db
    .prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status,
         base_integration_commit, outcome_json, created_at, finished_at, validated_task_json, result_integration_commit)
       VALUES (?, ?, ?, ?, ?, 'test_work', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      h.fx.goalId,
      over.version ?? 1,
      sequence,
      over.kind ?? 'execution',
      status,
      h.fx.head(),
      JSON.stringify({ code: status === 'succeeded' ? 'integrated' : 'failed' }),
      new Date().toISOString(),
      new Date().toISOString(),
      over.task ? JSON.stringify(over.task) : null,
      over.result ?? null,
    );
  reconcileCounters(h.fx.db, h.fx.goalId);
  return id;
}

const cycles = (h: Harness, kind?: string) =>
  h.fx.db
    .prepare(
      `SELECT id, kind, status, trigger_code AS triggerCode, sequence,
              json_extract(outcome_json, '$.reviewPlan.reviewKind') AS reviewKind
         FROM goal_cycles WHERE goal_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY sequence`,
    )
    .all(...(kind ? [h.fx.goalId, kind] : [h.fx.goalId])) as Array<{
    id: string;
    kind: string;
    status: string;
    triggerCode: string;
    sequence: number;
    reviewKind: string | null;
  }>;
const reviewCycles = (h: Harness) => cycles(h, 'review');

/**
 * Drives the one active review cycle to a terminal state exactly as the accepted Stage-6A lifecycle leaves it: the review
 * record is bound atomically, completed from a report, the cycle finalised and the Goal returned to `running`.
 */
async function consumeReview(
  h: Harness,
  options: {
    verdict?: 'pass' | 'block' | 'pass_with_findings';
    independence?: unknown;
    outcome?: 'completed' | 'failed';
  } = {},
): Promise<void> {
  const cycle = reviewCycles(h).find(
    (entry) => !['succeeded', 'failed', 'cancelled'].includes(entry.status),
  )!;
  const kind = cycle.reviewKind as GoalReviewKind;
  await h.executor.queueReviewRun({
    goalId: h.fx.goalId,
    cycleId: cycle.id,
    baseCommit: h.fx.head(),
    reviewKind: kind,
    reviewRole: reviewRoleForKind(kind),
    reviewerCount: 1,
  });
  const review = reviewForCycle(h.fx.db, cycle.id)!;
  if (options.outcome === 'failed') {
    h.fx.db
      .prepare("UPDATE goal_reviews SET status = 'failed', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), review.id);
  } else {
    completeReview(h.fx.db, {
      reviewId: review.id,
      report: reportOf({ verdict: options.verdict ?? 'pass' }),
      ...(options.independence !== undefined ? { independence: options.independence } : {}),
    });
  }
  for (const to of ['launching', 'running', 'collecting'] as const) {
    const current = h.fx.db.prepare('SELECT status FROM goal_cycles WHERE id = ?').get(cycle.id) as {
      status: string;
    };
    if (current.status === 'planned' || to !== 'launching')
      if (current.status !== to) transitionCycle(h.fx.db, { cycleId: cycle.id, to });
  }
  finalizeCycle(h.fx.db, {
    cycleId: cycle.id,
    to: options.outcome === 'failed' ? 'failed' : 'succeeded',
    outcomeCode: options.outcome === 'failed' ? 'review_failed' : 'review_consumed',
  });
  transitionGoal(h.fx.db, {
    goalId: h.fx.goalId,
    to: 'running',
    reasonCode: 'review_passed',
    actor: 'supervisor',
  });
}

/** Ticks (evidence collection first) until the supervisor creates its next cycle, whichever kind. */
async function nextCreated(h: Harness): Promise<void> {
  for (let step = 0; step < 8; step += 1) if ((await h.tick()) === 'cycle_created') return;
  throw new Error('no cycle was created');
}

const ready = async (h: Harness) => {
  await passDeterministic(h.fx);
  await h.start();
};

describe('final review trigger', () => {
  const final = (over: Partial<ReviewPolicy> = {}) =>
    goal(
      { final: true, ...over },
      {
        definition: simpleDefinition({ policy: { requireFinalReview: true } }),
      },
    );

  it('creates exactly one final review when every milestone is done and none exists, before completion is attempted', async () => {
    const h = final();
    await ready(h);
    expect(await h.tick()).toBe('cycle_created');
    expect(h.status().status).toBe('reviewing');
    expect(reviewCycles(h)).toMatchObject([
      { status: 'planned', triggerCode: 'final_review', reviewKind: 'final' },
    ]);
    const plan = h.fx.db
      .prepare('SELECT outcome_json AS j FROM goal_cycles WHERE kind = ?')
      .get('review') as { j: string };
    expect(JSON.parse(plan.j).reviewPlan.reviewedFromCommit).toBeNull();
    expect(listGoalEvents(h.fx.db, h.fx.goalId).some((event) => event.type === 'completion_evaluated')).toBe(
      false,
    );
  });

  it('after a restart the same state yields the same single active cycle, never a duplicate', async () => {
    const h = final();
    await ready(h);
    await h.tick();
    const fresh = h.restart();
    for (let index = 0; index < 3; index += 1) await fresh.supervisor.tickGoal(h.fx.goalId);
    expect(reviewCycles(h)).toHaveLength(1);
  });

  it('a completed current final review is not repeated, even with independence unestablished: completion stays pending', async () => {
    const h = final();
    await ready(h);
    await h.tick();
    await consumeReview(h, {
      independence: {
        established: false,
        policy: 'different-family',
        detail: { reasonCode: 'candidate_identity_unproven' },
      },
    });
    expect(await h.tick()).toBe('completion_pending');
    expect(await h.tick()).toBe('completion_pending');
    expect(reviewCycles(h)).toHaveLength(1);
  });

  it('a blocking final review is not repeated at the same head after the user resumes', async () => {
    const h = final();
    await ready(h);
    await h.tick();
    await consumeReview(h, { verdict: 'block' });
    expect(await h.tick()).toBe('completion_pending');
    expect(reviewCycles(h)).toHaveLength(1);
  });

  it('a moved head makes the old final review stale and permits a new one', async () => {
    const h = final();
    await ready(h);
    await h.tick();
    await consumeReview(h);
    h.fx.advance({ 'src/new.ts': 'export const n = 1;\n' });
    await passDeterministic(h.fx);
    expect(await h.tick()).toBe('cycle_created');
    expect(reviewCycles(h)).toHaveLength(2);
  });

  it('is not scheduled when final review is disabled', async () => {
    const h = goal({ final: false });
    await ready(h);
    expect(await h.tick()).toBe('completed');
    expect(reviewCycles(h)).toHaveLength(0);
  });
});

describe('milestone review trigger', () => {
  const two = () =>
    simpleDefinition({
      milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])],
    });
  const ids = (h: Harness) => cycles(h).map((entry) => `${entry.kind}:${entry.triggerCode}`);

  it('schedules a milestone review once its criteria are satisfied (onMilestoneComplete)', async () => {
    const h = goal({ onMilestoneComplete: true }, { definition: two() });
    await ready(h);
    expect(await h.tick()).toBe('cycle_created');
    expect(ids(h)).toEqual(['review:milestone_complete']);
    const row = h.fx.db.prepare("SELECT milestone_id AS m FROM goal_cycles WHERE kind = 'review'").get() as {
      m: string;
    };
    expect(row.m).toBe(h.fx.milestoneId('m1'));
  });

  it('a milestone that also requires a review still gets exactly one', async () => {
    const definition = simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'], { reviewRequirements: { milestoneReview: true } })],
    });
    const h = goal({ onMilestoneComplete: true }, { definition });
    await ready(h);
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(1);
    await consumeReview(h);
    expect(await h.tick()).not.toBe('cycle_created');
    expect(reviewCycles(h)).toHaveLength(1);
  });

  it('does not schedule while criteria are unsatisfied: ordinary work continues', async () => {
    const h = goal({ onMilestoneComplete: true }, { definition: two() });
    await h.start();
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(0);
    expect(cycles(h)[0]).toMatchObject({ kind: 'execution' });
  });

  it('missing/stale deterministic evidence keeps priority over the review', async () => {
    const h = goal({ onMilestoneComplete: true }, { definition: two() });
    await passDeterministic(h.fx);
    await h.start();
    h.fx.advance({ 'src/x.ts': 'export const x = 1;\n' }); // evidence now bound to an older tree
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('a pending human completion gate does not stop the review from happening first', async () => {
    const definition = simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'], { reviewRequirements: { milestoneReview: true } })],
      gates: { beforeMilestoneComplete: true },
    });
    const h = goal({ onMilestoneComplete: true }, { definition });
    await ready(h);
    expect(await h.tick()).toBe('cycle_created');
    expect(reviewCycles(h)).toHaveLength(1);
    await consumeReview(h);
    expect(await h.tick()).toBe('gate_requested');
  });

  it('a completed review at the current tree suppresses a duplicate; one at an older tree does not', async () => {
    const docs = {
      key: 'docs',
      statement: 'Docs build',
      verification: [{ kind: 'file_exists' as const, path: 'src/never.ts' }],
      required: true,
    };
    const h = goal(
      { onMilestoneComplete: true },
      {
        definition: simpleDefinition({
          criteria: [structuredClone(BUILD), structuredClone(TESTS), docs],
          milestones: [milestone('m1', ['build', 'tests']), milestone('m2', ['docs'])],
        }),
      },
    );
    await ready(h);
    await h.tick();
    await consumeReview(h);
    // The reviewed milestone is satisfied and reviewed at this tree: ordinary work (m2) continues, no second review.
    expect(await h.tick()).toBe('cycle_created');
    expect(reviewCycles(h)).toHaveLength(1);
    expect(h.cycle()!.kind).toBe('execution');
    finalizeCycle(h.fx.db, { cycleId: h.cycle()!.id, to: 'cancelled', outcomeCode: 'cancelled' });
    h.fx.advance({ 'src/more.ts': 'export const more = 1;\n' });
    await passDeterministic(h.fx);
    expect(await h.tick()).toBe('cycle_created');
    expect(reviewCycles(h)).toHaveLength(2);
  });

  it('the cached runtime status "satisfied" never hides a still-required review after a restart', async () => {
    const h = goal({ onMilestoneComplete: true }, { definition: two() });
    await ready(h);
    h.fx.db.prepare("UPDATE goal_milestones SET status = 'satisfied' WHERE milestone_key = 'm1'").run();
    const fresh = h.restart();
    expect((await fresh.supervisor.tickGoal(h.fx.goalId)).action).toBe('cycle_created');
    expect(reviewCycles(h)).toHaveLength(1);
  });
});

describe('periodic review trigger', () => {
  const periodic = () =>
    goal({ periodic: { everyNExecutionCycles: 3, reviewerCount: 1, scope: 'since_last_review' } });

  it('N-1 attempted cycles do not trigger, the Nth does', async () => {
    const h = periodic();
    await h.start();
    addWork(h, 'succeeded');
    addWork(h, 'failed');
    expect(await h.tick()).toBe('cycle_created');
    expect(cycles(h).at(-1)).toMatchObject({ kind: 'execution' });
    // The ordinary cycle was just created; settle it so only history decides.
    const active = h.cycle()!;
    finalizeCycle(h.fx.db, { cycleId: active.id, to: 'cancelled', outcomeCode: 'cancelled' });
    reconcileCounters(h.fx.db, h.fx.goalId);
    addWork(h, 'rejected');
    expect(await h.tick()).toBe('cycle_created');
    expect(reviewCycles(h)).toMatchObject([{ triggerCode: 'periodic_interval', reviewKind: 'periodic' }]);
  });

  it('cancelled work and review/verification cycles do not count', async () => {
    const h = periodic();
    await h.start();
    addWork(h, 'succeeded');
    addWork(h, 'cancelled');
    addWork(h, 'cancelled');
    h.fx.db
      .prepare(
        `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at, finished_at)
         VALUES (?, ?, 1, 90, 'verification', 'evidence_refresh', 'succeeded', ?, ?)`,
      )
      .run(randomUUID(), h.fx.goalId, new Date().toISOString(), new Date().toISOString());
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('restart at the threshold yields one review; the next interval counts from that review', async () => {
    const h = periodic();
    await h.start();
    for (let index = 0; index < 3; index += 1) addWork(h, 'succeeded');
    await h.tick();
    const fresh = h.restart();
    await fresh.supervisor.tickGoal(h.fx.goalId);
    expect(reviewCycles(h)).toHaveLength(1);
    await consumeReview(h);
    // Two cycles after the review: below the interval, no repeat.
    addWork(h, 'succeeded');
    addWork(h, 'failed');
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(1);
    const active = h.cycle()!;
    expect(active.kind).toBe('execution');
    finalizeCycle(h.fx.db, { cycleId: active.id, to: 'cancelled', outcomeCode: 'cancelled' });
    addWork(h, 'succeeded');
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(2);
  });

  it('trigger history restarts at an approved definition boundary: older-version cycles never count toward the new interval', async () => {
    const h = periodic();
    await h.start();
    for (let index = 0; index < 3; index += 1) addWork(h, 'succeeded');
    const { beginAmendment, approveDefinition } = await import('./definitions.js');
    const amended = structuredClone(h.fx.definition);
    h.fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(h.fx.goalId);
    const { version } = beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user', definition: amended });
    approveDefinition(h.fx.db, { goalId: h.fx.goalId, version, actor: 'user' });
    h.fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(h.fx.goalId);
    // Three version-1 cycles exist but the epoch is version 2: nothing is due.
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(0);
    finalizeCycle(h.fx.db, { cycleId: h.cycle()!.id, to: 'cancelled', outcomeCode: 'cancelled' });
    for (let index = 0; index < 3; index += 1) addWork(h, 'succeeded', { version });
    await h.tick();
    expect(reviewCycles(h)).toMatchObject([{ triggerCode: 'periodic_interval' }]);
  });
});

describe('repeated-failure review trigger', () => {
  const failing = () => goal({ onRepeatedFailure: { afterConsecutiveFailures: 2 } });

  it('below the threshold nothing happens; at the threshold a repeated_failure review is created', async () => {
    const h = failing();
    await h.start();
    addWork(h, 'failed');
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(0);
    finalizeCycle(h.fx.db, { cycleId: h.cycle()!.id, to: 'cancelled', outcomeCode: 'cancelled' });
    addWork(h, 'rejected');
    expect(await h.tick()).toBe('cycle_created');
    expect(reviewCycles(h)).toMatchObject([
      { triggerCode: 'repeated_failure', reviewKind: 'repeated_failure' },
    ]);
    const counters = h.fx.db
      .prepare('SELECT consecutive_failed_cycles AS n FROM goal_runtime WHERE goal_id = ?')
      .get(h.fx.goalId) as { n: number };
    expect(counters.n).toBe(2);
  });

  it('the same failure episode is not reviewed twice; a newer failure may trigger again', async () => {
    const h = failing();
    await h.start();
    addWork(h, 'failed');
    addWork(h, 'failed');
    await h.tick();
    await consumeReview(h);
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(1);
    expect(h.cycle()!.kind).toBe('execution');
    finalizeCycle(h.fx.db, { cycleId: h.cycle()!.id, to: 'cancelled', outcomeCode: 'cancelled' });
    addWork(h, 'failed');
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(2);
  });

  it('a success resets the streak, so no stale trigger fires', async () => {
    const h = failing();
    await h.start();
    addWork(h, 'failed');
    addWork(h, 'failed');
    addWork(h, 'succeeded');
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('the hard failure bound keeps precedence and is not bypassed by a review', async () => {
    const h = failing();
    await h.start();
    const max = 4; // testKit maxConsecutiveFailedCycles
    for (let index = 0; index < max; index += 1) addWork(h, 'failed');
    expect(await h.tick()).toBe('bound_blocked');
    expect(h.status()).toMatchObject({ status: 'blocked', reason: 'bound_failures' });
    expect(reviewCycles(h)).toHaveLength(0);
  });
});

describe('scope-change review trigger', () => {
  const scoped = (policy: { pathsOutsideScopeAtLeast: number; diffLinesAtLeast?: number }) =>
    goal({ onScopeChange: policy });

  /** One real work cycle integrated through the supervisor, so the advance op and validated task are genuine. */
  async function integrate(h: Harness, expectedPaths: string[], files: Record<string, string | null>) {
    h.files.current = files;
    h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, expectedPaths } });
    await h.until('waiting_for_run');
    h.setRunStatus(h.runs().at(-1)!.id, 'completed');
    await h.until('cycle_succeeded');
  }
  const file = (lines: number) => `${'x\n'.repeat(lines)}`;

  it('changes all within expectedPaths do not trigger (exact path or directory descendant)', async () => {
    const h = scoped({ pathsOutsideScopeAtLeast: 1 });
    await h.start();
    await integrate(h, ['src/a.ts', 'src/lib'], { 'src/a.ts': file(2), 'src/lib/b.ts': file(2) });
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('outside paths below the threshold do not trigger; at the threshold they do', async () => {
    const below = scoped({ pathsOutsideScopeAtLeast: 3 });
    await below.start();
    await integrate(below, ['src/a.ts'], { 'src/a.ts': file(1), 'src/x.ts': file(1), 'src/y.ts': file(1) });
    await nextCreated(below);
    expect(reviewCycles(below)).toHaveLength(0);

    const at = scoped({ pathsOutsideScopeAtLeast: 2 });
    await at.start();
    await integrate(at, ['src/a.ts'], { 'src/a.ts': file(1), 'src/x.ts': file(1), 'src/y.ts': file(1) });
    await nextCreated(at);
    expect(reviewCycles(at)).toMatchObject([{ triggerCode: 'scope_change', reviewKind: 'scope_change' }]);
    const event = listGoalEvents(at.fx.db, at.fx.goalId).find(
      (entry) => entry.type === 'cycle_created' && (entry.payload as { kind?: string }).kind === 'review',
    )!;
    const detail = (event.payload as { triggerDetail: Record<string, unknown> }).triggerDetail;
    expect(detail).toMatchObject({ outsidePathCount: 2, pathsOutsideScopeAtLeast: 2 });
    expect(JSON.stringify(event.payload).length).toBeLessThan(1500);
  });

  it('the diff-line threshold is conjunctive with the path threshold', async () => {
    const lowLines = scoped({ pathsOutsideScopeAtLeast: 1, diffLinesAtLeast: 50 });
    await lowLines.start();
    await integrate(lowLines, ['src/a.ts'], { 'src/a.ts': file(1), 'src/x.ts': file(1) });
    await nextCreated(lowLines);
    expect(reviewCycles(lowLines)).toHaveLength(0);

    const both = scoped({ pathsOutsideScopeAtLeast: 1, diffLinesAtLeast: 10 });
    await both.start();
    await integrate(both, ['src/a.ts'], { 'src/a.ts': file(5), 'src/x.ts': file(8) });
    await nextCreated(both);
    expect(reviewCycles(both)).toHaveLength(1);
    const detail = (
      listGoalEvents(both.fx.db, both.fx.goalId).find(
        (entry) => entry.type === 'cycle_created' && (entry.payload as { kind?: string }).kind === 'review',
      )!.payload as { triggerDetail: Record<string, unknown> }
    ).triggerDetail;
    expect(detail.diffLines).toBe(13);
  });

  it('empty expectedPaths gives no drift baseline and never triggers', async () => {
    const h = scoped({ pathsOutsideScopeAtLeast: 1 });
    await h.start();
    await integrate(h, [], { 'src/a.ts': file(1), 'src/x.ts': file(1) });
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('unintegrated or failed cycles are ignored', async () => {
    const h = scoped({ pathsOutsideScopeAtLeast: 1 });
    await h.start();
    addWork(h, 'failed', {
      task: { ...GOOD_TASK, expectedPaths: ['docs/only.md'] },
      result: h.fx.head(),
    });
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('a succeeded cycle with no applied advance op is not an integrated candidate', async () => {
    const h = scoped({ pathsOutsideScopeAtLeast: 1 });
    await h.start();
    addWork(h, 'succeeded', {
      task: { ...GOOD_TASK, expectedPaths: ['docs/only.md'] },
      result: h.fx.head(),
    });
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(0);
  });

  it('a source cycle already followed by a scope review is not repeated; a later drifting cycle triggers again', async () => {
    const h = scoped({ pathsOutsideScopeAtLeast: 1 });
    await h.start();
    await integrate(h, ['src/a.ts'], { 'src/a.ts': file(1), 'src/x.ts': file(1) });
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(1);
    await consumeReview(h);
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(1);
    expect(h.cycle()!.kind).toBe('execution');
    finalizeCycle(h.fx.db, { cycleId: h.cycle()!.id, to: 'cancelled', outcomeCode: 'cancelled' });
    await integrate(h, ['src/a.ts'], { 'src/a.ts': file(2), 'src/y.ts': file(1) });
    await nextCreated(h);
    expect(reviewCycles(h)).toHaveLength(2);
  });

  it('expectedPaths stay advisory: work outside them is still integrated and the cycle succeeds', async () => {
    const h = scoped({ pathsOutsideScopeAtLeast: 1 });
    await h.start();
    await integrate(h, ['src/nowhere.ts'], { 'src/a.ts': file(1) });
    const done = cycles(h, 'execution')[0]!;
    expect(done.status).toBe('succeeded');
  });

  it('path coverage is by whole components, never substring containment', () => {
    expect(coveredByExpected('src/a.ts', ['src/a.ts'])).toBe(true);
    expect(coveredByExpected('src/lib/b.ts', ['src/lib'])).toBe(true);
    expect(coveredByExpected('src/library/b.ts', ['src/lib'])).toBe(false);
    expect(coveredByExpected('src/a.tsx', ['src/a.ts'])).toBe(false);
  });

  it('diffLineCount counts text lines, treats binary as zero, and reports git failure as unavailable', async () => {
    const h = goal({});
    const from = h.fx.head();
    h.fx.advance({ 'src/t.ts': 'a\nb\nc\n' });
    const to = h.fx.head();
    const repo = h.fx.repo;
    expect(await diffLineCount(repo, from, to)).toEqual({ ok: true, lines: 3, capped: false });
    expect(await diffLineCount(repo, from, 'f'.repeat(40))).toEqual({ ok: false });
  });
});

describe('trigger precedence and one-cycle-per-tick', () => {
  const everything = () =>
    goal(
      {
        onRepeatedFailure: { afterConsecutiveFailures: 2 },
        onScopeChange: { pathsOutsideScopeAtLeast: 1 },
        onMilestoneComplete: true,
        periodic: { everyNExecutionCycles: 2, reviewerCount: 1, scope: 'since_last_review' },
        final: true,
      },
      { definition: simpleDefinition({ policy: { requireFinalReview: true } }) },
    );

  /** Marks a real integrated cycle as drifting by giving it an advisory baseline its change set does not match. */
  async function drifting(h: Harness) {
    h.files.current = { 'src/a.ts': 'x\n', 'src/z.ts': 'x\n' };
    h.model.script.push({ ok: true, proposal: { ...GOOD_TASK, expectedPaths: ['src/a.ts'] } });
    await h.until('waiting_for_run');
    h.setRunStatus(h.runs().at(-1)!.id, 'completed');
    await h.until('cycle_succeeded');
  }

  it('repeated_failure beats scope_change, scope_change beats milestone, milestone beats periodic', async () => {
    const h = everything();
    await h.start();
    await drifting(h); // scope source + 1 attempted cycle
    addWork(h, 'failed'); // streak 1
    addWork(h, 'failed'); // streak 2 -> repeated_failure due too; 3 attempted -> periodic due
    await passDeterministic(h.fx); // milestone due
    const order: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      await nextCreated(h);
      const active = reviewCycles(h).at(-1)!;
      order.push(active.reviewKind!);
      expect(reviewCycles(h).filter((entry) => entry.status === 'planned')).toHaveLength(1);
      await consumeReview(h);
    }
    expect(order.slice(0, 3)).toEqual(['repeated_failure', 'scope_change', 'milestone']);
    expect(order.slice(3)).toEqual(['periodic', 'final']);
  });

  it('final is evaluated only after no milestone remains, and an active review is never duplicated by a restart', async () => {
    const h = everything();
    await h.start(); // no evidence: milestone unsatisfied, so no final
    await h.tick();
    expect(reviewCycles(h).filter((entry) => entry.reviewKind === 'final')).toHaveLength(0);
    const fresh = h.restart();
    await fresh.supervisor.tickGoal(h.fx.goalId);
    expect(reviewCycles(h)).toHaveLength(0);
  });
});

describe('triggering performs no route, provider or run work', () => {
  it('creates only a cycle plus the Goal transition: no run, no queue call, no approval, no start', async () => {
    const h = goal({ onMilestoneComplete: true });
    await ready(h);
    const before = (table: string) =>
      (h.fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const runs = before('runs');
    const approvals = before('goal_approvals');
    expect(await h.tick()).toBe('cycle_created');
    expect(before('runs')).toBe(runs);
    expect(before('goal_approvals')).toBe(approvals);
    expect(before('goal_reviews')).toBe(0);
    expect(h.executor.reviewQueueCalls).toHaveLength(0);
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.model.calls).toBe(0);
    const types = listGoalEvents(h.fx.db, h.fx.goalId).map((event) => event.type);
    expect(types).toContain('cycle_created');
    expect(types.filter((type) => type.startsWith('route'))).toEqual([]);
  });

  it('the selector alone is read-only: a dry evaluation changes nothing and is repeatable', async () => {
    const h = goal({ onMilestoneComplete: true });
    await ready(h);
    const goalRow = h.fx.db
      .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
      .get(h.fx.goalId) as { v: number };
    const { loadDefinitionVersion } = await import('./definitions.js');
    const version = loadDefinitionVersion(h.fx.db, h.fx.goalId, goalRow.v)!;
    const { evaluateCriteria } = await import('./freshness.js');
    expect(evaluateCriteria).toBeTypeOf('function');
    const call = () =>
      determineReviewTrigger(h.fx.db, h.fx.goalId, {
        definition: version.definition,
        version: version.version,
        evaluations: undefined,
        includeFinal: true,
      });
    const first = await call();
    expect(await call()).toEqual(first);
    expect(reviewCycles(h)).toHaveLength(0);
    expect(h.status().status).toBe('running');
  });
});

describe('failed review is not auto-recreated', () => {
  it('a failed review cycle for the same source is not recreated for periodic/failure dedupe', async () => {
    const h = goal({ onRepeatedFailure: { afterConsecutiveFailures: 2 } });
    await h.start();
    addWork(h, 'failed');
    addWork(h, 'failed');
    await h.tick();
    await consumeReview(h, { outcome: 'failed' });
    await h.tick();
    expect(reviewCycles(h)).toHaveLength(1);
  });
});
