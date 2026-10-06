import { afterEach, describe, expect, it } from 'vitest';
import { activeCycle, computeCounters, CycleError } from './cycles.js';
import { listGoalEvents } from './events.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { createReviewCycle } from './reviewCycle.js';
import { reviewForCycle } from './reviews.js';
import { GOAL_BUILTIN_WORKFLOWS } from '../../shared/goalWorkflows.js';
import { harness, type Harness } from './supervisorKit.js';

afterEach(cleanupRepoFixtures);

const BUILT_IN = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
};

/** A running Goal with the built-in review workflow selected, then one review cycle of the given kind. */
async function reviewing(
  kind: 'periodic' | 'milestone' | 'final' | 'repeated_failure' | 'scope_change' = 'final',
  options: { reviewedFromCommit?: string | null } = {},
) {
  const h = harness({
    tune: (definition) => {
      definition.routing.workflows = { ...BUILT_IN };
    },
  });
  await h.start();
  const created = createReviewCycle(h.fx.db, {
    goalId: h.fx.goalId,
    reviewKind: kind,
    triggerCode: 'test_trigger',
    ...(kind === 'milestone' ? { milestoneKey: 'm1' } : {}),
    ...(options.reviewedFromCommit !== undefined ? { reviewedFromCommit: options.reviewedFromCommit } : {}),
  });
  if (!created.created) throw new Error('expected a new review cycle');
  return { h, cycle: created.cycle };
}
const reviewRun = (h: Harness) =>
  h.fx.db.prepare("SELECT id, status FROM runs WHERE goal_run_purpose = 'review'").all() as Array<{
    id: string;
    status: string;
  }>;
const reviewRows = (h: Harness) =>
  h.fx.db.prepare('SELECT * FROM goal_reviews WHERE goal_id = ?').all(h.fx.goalId) as Array<
    Record<string, unknown>
  >;

describe('createReviewCycle', () => {
  it('creates a planned review cycle on the current head and moves the Goal to reviewing', async () => {
    const { h, cycle } = await reviewing('final');
    expect(cycle).toMatchObject({
      kind: 'review',
      status: 'planned',
      triggerCode: 'test_trigger',
      definitionVersion: 1,
      baseIntegrationCommit: h.fx.head(),
      milestoneId: null,
    });
    expect(cycle.outcome).toEqual({
      reviewPlan: { reviewKind: 'final', reviewerCount: 2, reviewedFromCommit: null },
    });
    expect(h.status()).toMatchObject({ status: 'reviewing', reason: 'review_triggered' });
    expect(listGoalEvents(h.fx.db, h.fx.goalId).some((e) => e.type === 'cycle_created')).toBe(true);
  });

  it('records the milestone, and counts against neither execution nor remediation bounds', async () => {
    const { h, cycle } = await reviewing('milestone');
    expect(cycle.milestoneKey).toBe('m1');
    expect(computeCounters(h.fx.db, h.fx.goalId)).toEqual({
      cyclesExecuted: 0,
      consecutiveFailedCycles: 0,
      remediationAttempts: {},
    });
  });

  it('refuses a milestone review without a milestone, and a Goal that is not running', async () => {
    const h = harness({ tune: (d) => void (d.routing.workflows = { ...BUILT_IN }) });
    await h.start();
    expect(() =>
      createReviewCycle(h.fx.db, { goalId: h.fx.goalId, reviewKind: 'milestone', triggerCode: 't' }),
    ).toThrow(CycleError);
    createReviewCycle(h.fx.db, { goalId: h.fx.goalId, reviewKind: 'final', triggerCode: 't' });
    expect(() =>
      createReviewCycle(h.fx.db, { goalId: h.fx.goalId, reviewKind: 'final', triggerCode: 't' }),
    ).toThrow(/running Goal/);
  });

  it('is idempotent while another cycle is active', async () => {
    const h = harness({ tune: (d) => void (d.routing.workflows = { ...BUILT_IN }) });
    await h.start();
    await h.until('cycle_created');
    const active = activeCycle(h.fx.db, h.fx.goalId)!;
    const result = createReviewCycle(h.fx.db, { goalId: h.fx.goalId, reviewKind: 'final', triggerCode: 't' });
    expect(result).toMatchObject({ created: false, reason: 'active_cycle_exists' });
    expect(result.cycle.id).toBe(active.id);
    expect(h.status().status).toBe('running');
  });

  it('derives the reviewer count from the periodic policy, clamped by the workflow parallelism', async () => {
    const h = harness({
      tune: (d) => {
        d.routing.workflows = { ...BUILT_IN };
        d.review.periodic = { everyNExecutionCycles: 2, reviewerCount: 3, scope: 'full_diff' };
      },
    });
    await h.start();
    const periodic = createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: 'periodic',
      triggerCode: 't',
    });
    expect(
      (periodic.cycle.outcome as { reviewPlan: { reviewerCount: number } }).reviewPlan.reviewerCount,
    ).toBe(2);
  });
});

describe('review launch', () => {
  it('queues the run, binds the immutable review row, and only then starts the run', async () => {
    const { h, cycle } = await reviewing('final');
    const boundAtStart: Array<unknown> = [];
    h.startRun.mockImplementationOnce((runId) => {
      boundAtStart.push(reviewForCycle(h.fx.db, cycle.id)?.runId === runId);
      h.setRunStatus(runId, 'running');
      return { started: true };
    });
    expect(await h.until('review_run_started')).toEqual([
      'launch_started',
      'review_run_queued',
      'review_run_started',
    ]);
    expect(boundAtStart).toEqual([true]);
    expect(h.executor.reviewQueueCalls).toEqual([
      {
        goalId: h.fx.goalId,
        cycleId: cycle.id,
        baseCommit: h.fx.head(),
        reviewKind: 'final',
        reviewRole: 'final_reviewer',
        reviewerCount: 2,
      },
    ]);
    const review = reviewForCycle(h.fx.db, cycle.id)!;
    expect(review).toMatchObject({
      status: 'pending',
      reviewKind: 'final',
      cycleId: cycle.id,
      runId: reviewRun(h)[0]!.id,
      reviewedToCommit: h.fx.head(),
      reviewedToTree: h.fx.tree(),
      reviewedFromCommit: null,
    });
    expect(h.cycle()!.status).toBe('running');
    expect(h.status().status).toBe('reviewing');
  });

  it('persists the honest range start the cycle was planned with', async () => {
    const start = (() => {
      const probe = harness();
      return probe.fx.head();
    })();
    void start;
    const h = harness({ tune: (d) => void (d.routing.workflows = { ...BUILT_IN }) });
    await h.start();
    const first = h.fx.head();
    h.fx.advance({ 'src/b.ts': 'export const b = 1;\n' }, 'b');
    createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: 'periodic',
      triggerCode: 't',
      reviewedFromCommit: first,
    });
    await h.until('review_run_queued');
    expect(reviewRows(h)[0]).toMatchObject({ reviewed_from_commit: first, reviewed_to_commit: h.fx.head() });
  });

  it('fails the cycle when the planned range start is not in the Goal history', async () => {
    const h = harness({ tune: (d) => void (d.routing.workflows = { ...BUILT_IN }) });
    await h.start();
    createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: 'periodic',
      triggerCode: 't',
      reviewedFromCommit: h.fx.orphanCommit(),
    });
    expect(await h.tick()).toBe('launch_started');
    expect(await h.tick()).toBe('review_decision_needed');
    expect(h.cycle()!.outcome).toMatchObject({
      code: 'review_queue_error',
      queueCode: 'review_from_commit_invalid',
    });
    // Nothing durable: neither a run nor a review row survives the refused launch.
    expect(reviewRows(h)).toHaveLength(0);
    expect(reviewRun(h)).toHaveLength(0);
  });

  it('never starts or duplicates anything across repeated ticks and restarts', async () => {
    const { h, cycle } = await reviewing('milestone');
    await h.until('review_run_started');
    for (const tick of [
      () => h.tick(),
      async () => (await h.restart().supervisor.tickGoal(h.fx.goalId)).action,
    ]) {
      expect(await tick()).toBe('review_waiting');
    }
    expect(reviewRun(h)).toHaveLength(1);
    expect(reviewRows(h)).toHaveLength(1);
    expect(h.startRun).toHaveBeenCalledTimes(1);
    expect(reviewForCycle(h.fx.db, cycle.id)!.milestoneId).toBe(h.fx.milestoneId('m1'));
  });

  it('crash after the atomic queue+bind commit, before start: the same run and review start exactly once', async () => {
    const { h } = await reviewing('final');
    await h.until('review_run_queued');
    const runBefore = reviewRun(h)[0]!.id;
    const reviewBefore = reviewRows(h)[0]!.id;
    const fresh = h.restart();
    expect((await fresh.supervisor.tickGoal(h.fx.goalId)).action).toBe('review_run_started');
    expect(fresh.executor.reviewQueueCalls).toHaveLength(0);
    expect(reviewRun(h).map((run) => run.id)).toEqual([runBefore]);
    expect(reviewRows(h).map((row) => row.id)).toEqual([reviewBefore]);
    expect(h.startRun).toHaveBeenCalledTimes(1);
  });

  it('observes an already active run and consumes a terminal one without restarting it', async () => {
    const { h } = await reviewing('final');
    await h.until('review_run_queued');
    h.setRunStatus(reviewRun(h)[0]!.id, 'running');
    expect(await h.tick()).toBe('review_run_started');
    expect(h.startRun).not.toHaveBeenCalled();
    h.setRunStatus(reviewRun(h)[0]!.id, 'completed');
    expect(await h.tick()).toBe('collection_started');
    expect(h.cycle()!.status).toBe('collecting');
  });

  it('does not start when the Goal head moved after the cycle captured it (no silent later head)', async () => {
    const { h, cycle } = await reviewing('final');
    await h.until('review_run_queued');
    h.fx.advance({ 'src/late.ts': 'export const late = 1;\n' }, 'late');
    expect(await h.tick()).toBe('review_decision_needed');
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.cycle()).toMatchObject({ status: 'failed' });
    expect(h.cycle()!.outcome).toMatchObject({ code: 'review_base_moved' });
    // The atomically-bound review is closed failed with the cycle, never left pending.
    expect(reviewRows(h).map((row) => row.status)).toEqual(['failed']);
    expect(h.status()).toMatchObject({ status: 'needs_user', reason: 'review_needs_decision' });
    expect(activeCycle(h.fx.db, h.fx.goalId)).toBeUndefined();
    void cycle;
  });
});

describe('review infrastructure failures', () => {
  it('a failed run closes the pending review failed, fails the cycle and hands the Goal to the user', async () => {
    const { h, cycle } = await reviewing('final');
    await h.until('review_run_started');
    const runId = reviewRun(h)[0]!.id;
    h.setRunStatus(runId, 'failed');
    expect(await h.tick()).toBe('collection_started');
    expect(await h.tick()).toBe('review_decision_needed');
    expect(reviewForCycle(h.fx.db, cycle.id)).toMatchObject({
      status: 'failed',
      report: null,
      verdict: null,
    });
    expect(h.cycle()).toMatchObject({ status: 'failed' });
    expect(h.cycle()!.outcome).toMatchObject({ code: 'run_failed' });
    expect(h.status()).toMatchObject({ status: 'needs_user', reason: 'review_needs_decision' });
    // The run is terminal and nothing was recorded for it: the evidence-collected marker says so (zero rows).
    const marker = listGoalEvents(h.fx.db, h.fx.goalId).filter((e) => e.type === 'run_evidence_collected');
    expect(marker).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(marker[0]!.payload))).toMatchObject({ runId, evidenceCount: 0 });
    // No automatic retry: further ticks do nothing.
    expect(await h.tick()).not.toBe('review_run_queued');
    expect(reviewRun(h)).toHaveLength(1);
  });

  it('a cancelled run cancels the review and the cycle', async () => {
    const { h, cycle } = await reviewing('periodic');
    await h.until('review_run_started');
    h.setRunStatus(reviewRun(h)[0]!.id, 'cancelled');
    await h.tick();
    expect(await h.tick()).toBe('review_decision_needed');
    expect(reviewForCycle(h.fx.db, cycle.id)!.status).toBe('cancelled');
    expect(h.cycle()).toMatchObject({ status: 'cancelled' });
  });

  it('a queue failure fails the cycle without any review row', async () => {
    const { h } = await reviewing('final');
    h.executor.queueReviewRun = async () => {
      throw Object.assign(new Error('boom'), { code: 'plan_unavailable' });
    };
    await h.tick();
    expect(await h.tick()).toBe('review_decision_needed');
    expect(h.cycle()!.outcome).toMatchObject({ code: 'review_queue_error', queueCode: 'plan_unavailable' });
    expect(reviewRows(h)).toHaveLength(0);
    expect(h.status().reason).toBe('review_needs_decision');
  });

  it('surfaces a first-use approval as a typed decision and keeps the cycle active', async () => {
    const { h, cycle } = await reviewing('final');
    h.executor.queueReviewRun = async () => {
      throw Object.assign(new Error('needs approval'), {
        code: 'approval_required',
        approval: {
          poolId: 'reviewers',
          memberIdentityHash: 'a'.repeat(64),
          role: 'final_reviewer',
          memberIndex: 0,
        },
      });
    };
    await h.tick();
    expect(await h.tick()).toBe('review_decision_needed');
    expect(h.status()).toMatchObject({ status: 'needs_user', reason: 'review_needs_decision' });
    const detail = JSON.parse(
      (
        h.fx.db.prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?').get(h.fx.goalId) as {
          d: string;
        }
      ).d,
    ) as Record<string, unknown>;
    expect(detail).toMatchObject({
      code: 'approval_required',
      gate: 'pool_route_first_use',
      role: 'final_reviewer',
    });
    expect(typeof detail.approvalId).toBe('string');
    expect(activeCycle(h.fx.db, h.fx.goalId)!.id).toBe(cycle.id);
    expect(reviewRun(h)).toHaveLength(0);
  });

  it('a paused review run hands the Goal to the user and a resume restores reviewing', async () => {
    const { h, cycle } = await reviewing('final');
    await h.until('review_run_started');
    h.setRunStatus(reviewRun(h)[0]!.id, 'paused');
    expect(await h.tick()).toBe('review_decision_needed');
    expect(h.status()).toMatchObject({ status: 'needs_user', reason: 'review_needs_decision' });
    expect(activeCycle(h.fx.db, h.fx.goalId)!.id).toBe(cycle.id);
    const resumed = await h.supervisor.resumeGoal(h.fx.goalId, { actor: 'user', reasonCode: 'run_resumed' });
    expect(resumed).toEqual({ ok: true });
    expect(h.resumeRun).toHaveBeenCalledWith(reviewRun(h)[0]!.id);
    expect(h.status().status).toBe('running');
    expect(await h.tick()).toBe('review_restored');
    expect(h.status()).toMatchObject({ status: 'reviewing', reason: 'review_triggered' });
  });
});

describe('migration 022 review identity', () => {
  it('allows at most one review per cycle and per run', async () => {
    const { h, cycle } = await reviewing('final');
    await h.until('review_run_queued');
    const row = reviewRows(h)[0]!;
    const insert = (cycleId: string | null, runId: string | null) =>
      h.fx.db
        .prepare(
          `INSERT INTO goal_reviews (id, goal_id, cycle_id, definition_version, run_id, review_kind, status,
             reviewed_to_commit, reviewed_to_tree, created_at) VALUES (?, ?, ?, 1, ?, 'final', 'pending', ?, ?, 'now')`,
        )
        .run(`x${Math.random()}`, h.fx.goalId, cycleId, runId, row.reviewed_to_commit, row.reviewed_to_tree);
    expect(() => insert(cycle.id, null)).toThrow(/UNIQUE/);
    expect(() => insert(null, row.run_id as string)).toThrow(/UNIQUE/);
    // Rows without a cycle or run (legacy, manual) are unaffected.
    insert(null, null);
    insert(null, null);
  });

  it('is part of the shipped built-in workflow set', () => {
    expect(GOAL_BUILTIN_WORKFLOWS.some((workflow) => workflow.id === 'goal-review-v1')).toBe(true);
  });
});

describe('atomic review run + review record', () => {
  const request = (h: Harness, cycleId: string, reviewKind: 'final' | 'periodic' = 'final') => ({
    goalId: h.fx.goalId,
    cycleId,
    baseCommit: h.fx.head(),
    reviewKind,
    reviewRole: reviewKind === 'final' ? ('final_reviewer' as const) : ('routine_reviewer' as const),
    reviewerCount: 2,
  });
  const launching = async () => {
    const { h, cycle } = await reviewing('final');
    expect(await h.tick()).toBe('launch_started');
    return { h, cycle };
  };
  const failReviewInserts = (h: Harness) =>
    h.fx.db.exec(
      "CREATE TRIGGER inject_review_bind_failure BEFORE INSERT ON goal_reviews BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END",
    );

  it('a binding failure after the run was queued rolls the run back with it: nothing durable, nothing started', async () => {
    const { h, cycle } = await launching();
    failReviewInserts(h);
    await expect(h.executor.queueReviewRun(request(h, cycle.id))).rejects.toThrow(/injected binding failure/);
    expect(reviewRun(h)).toHaveLength(0);
    expect(reviewRows(h)).toHaveLength(0);
    expect(
      h.fx.db
        .prepare(
          'SELECT COUNT(*) AS n FROM stages WHERE run_id IN (SELECT id FROM runs WHERE goal_cycle_id = ?)',
        )
        .get(cycle.id),
    ).toEqual({ n: 0 });
    expect(h.cycle()).toMatchObject({ status: 'launching' });
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('the supervisor reports the failure as a queue error and leaves no half-launched review', async () => {
    const { h } = await launching();
    failReviewInserts(h);
    expect(await h.tick()).toBe('review_decision_needed');
    expect(h.cycle()).toMatchObject({ status: 'failed' });
    expect(h.cycle()!.outcome).toMatchObject({ code: 'review_queue_error' });
    expect(reviewRun(h)).toHaveLength(0);
    expect(reviewRows(h)).toHaveLength(0);
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('retry after a rolled-back attempt creates exactly one run and one review', async () => {
    const { h, cycle } = await launching();
    failReviewInserts(h);
    await expect(h.executor.queueReviewRun(request(h, cycle.id))).rejects.toThrow();
    h.fx.db.exec('DROP TRIGGER inject_review_bind_failure');
    expect(await h.tick()).toBe('review_run_queued');
    expect(reviewRun(h)).toHaveLength(1);
    expect(reviewRows(h)).toHaveLength(1);
    expect(reviewRows(h)[0]).toMatchObject({ run_id: reviewRun(h)[0]!.id, status: 'pending' });
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('a duplicate queue attempt returns the same run and review', async () => {
    const { h, cycle } = await launching();
    const first = await h.executor.queueReviewRun(request(h, cycle.id));
    const second = await h.executor.queueReviewRun(request(h, cycle.id));
    expect(second).toEqual(first);
    expect(reviewRun(h)).toHaveLength(1);
    expect(reviewRows(h)).toHaveLength(1);
    expect(reviewRows(h)[0]).toMatchObject({
      run_id: first.runId,
      reviewed_to_commit: h.fx.head(),
      review_kind: 'final',
      definition_version: 1,
    });
  });

  it('the binding is re-proven inside the transaction: a moved head or another review kind rolls everything back', async () => {
    const { h, cycle } = await launching();
    await expect(h.executor.queueReviewRun(request(h, cycle.id, 'periodic'))).rejects.toMatchObject({
      code: 'review_binding_invalid',
    });
    expect(reviewRun(h)).toHaveLength(0);
    expect(reviewRows(h)).toHaveLength(0);
    h.fx.advance({ 'src/late.ts': 'export const late = 1;\n' }, 'late');
    await expect(h.executor.queueReviewRun(request(h, cycle.id))).rejects.toMatchObject({
      code: 'review_binding_invalid',
    });
    expect(reviewRun(h)).toHaveLength(0);
    expect(reviewRows(h)).toHaveLength(0);
  });

  it('a historical queued review run without a review record fails closed and is never started or duplicated', async () => {
    const { h, cycle } = await launching();
    const queued = await h.executor.queueReviewRun(request(h, cycle.id));
    // Simulate a historical/corrupt state: the immutability trigger is removed only to fabricate the orphan.
    for (const row of h.fx.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%reviews cannot be deleted%'",
      )
      .all() as Array<{ name: string }>)
      h.fx.db.exec(`DROP TRIGGER ${row.name}`);
    h.fx.db.prepare('DELETE FROM goal_reviews WHERE run_id = ?').run(queued.runId);
    const fresh = h.restart();
    expect((await fresh.supervisor.tickGoal(h.fx.goalId)).action).toBe('review_decision_needed');
    expect(h.cycle()!.outcome).toMatchObject({ code: 'review_binding_missing' });
    expect(h.startRun).not.toHaveBeenCalled();
    expect(reviewRun(h).map((run) => run.id)).toEqual([queued.runId]);
    expect(reviewRows(h)).toHaveLength(0);
    // The executor refuses to adopt it too, rather than manufacturing a record around an arbitrary run.
    await expect(fresh.executor.queueReviewRun(request(h, cycle.id))).rejects.toMatchObject({
      code: 'review_binding_missing',
    });
    expect(reviewRows(h)).toHaveLength(0);
  });

  describe('persisted binding is fully re-proven before an existing run is started', () => {
    const dropImmutability = (h: Harness) => {
      for (const name of ['trg_goal_review_identity', 'trg_goal_review_terminal'])
        h.fx.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    };
    const corrupt = async (
      kind: 'final' | 'milestone',
      mutate: (h: Harness, runId: string) => void,
    ): Promise<{ h: Harness; cycleId: string; runId: string }> => {
      const { h, cycle } = await reviewing(kind);
      expect(await h.tick()).toBe('launch_started');
      const queued = await h.executor.queueReviewRun({
        goalId: h.fx.goalId,
        cycleId: cycle.id,
        baseCommit: h.fx.head(),
        reviewKind: kind,
        reviewRole: kind === 'final' ? 'final_reviewer' : 'routine_reviewer',
        reviewerCount: 2,
      });
      dropImmutability(h);
      mutate(h, queued.runId);
      return { h, cycleId: cycle.id, runId: queued.runId };
    };
    const expectRefused = async ({ h, cycleId, runId }: { h: Harness; cycleId: string; runId: string }) => {
      const fresh = h.restart();
      expect((await fresh.supervisor.tickGoal(h.fx.goalId)).action).toBe('review_decision_needed');
      expect(h.startRun).not.toHaveBeenCalled();
      expect(reviewRun(h).map((run) => run.id)).toEqual([runId]);
      expect(reviewRows(h)).toHaveLength(1);
      expect(h.cycle()!.id).toBe(cycleId);
      return h.cycle()!.outcome as { code?: string };
    };
    const update = (h: Harness, runId: string, column: string, value: string | null) =>
      h.fx.db.prepare(`UPDATE goal_reviews SET ${column} = ? WHERE run_id = ?`).run(value, runId);

    it('wrong milestone', async () => {
      const state = await corrupt('milestone', (h, runId) => update(h, runId, 'milestone_id', null));
      expect(await expectRefused(state)).toMatchObject({ code: 'review_binding_invalid' });
    });

    it('wrong reviewedFromCommit', async () => {
      const state = await corrupt('final', (h, runId) =>
        update(h, runId, 'reviewed_from_commit', h.fx.head()),
      );
      expect(await expectRefused(state)).toMatchObject({ code: 'review_binding_invalid' });
    });

    it('wrong reviewedToTree', async () => {
      const state = await corrupt('final', (h, runId) =>
        update(h, runId, 'reviewed_to_tree', 'f'.repeat(40)),
      );
      expect(await expectRefused(state)).toMatchObject({ code: 'review_base_moved' });
    });

    it('non-pending review attached to the queued run', async () => {
      const state = await corrupt('final', (h, runId) => update(h, runId, 'status', 'cancelled'));
      expect(await expectRefused(state)).toMatchObject({ code: 'review_binding_invalid' });
    });

    it('the executor refuses to reuse such a run too, and creates no replacement review', async () => {
      const state = await corrupt('final', (h, runId) =>
        update(h, runId, 'reviewed_from_commit', h.fx.head()),
      );
      await expect(
        state.h.restart().executor.queueReviewRun({
          goalId: state.h.fx.goalId,
          cycleId: state.cycleId,
          baseCommit: state.h.fx.head(),
          reviewKind: 'final',
          reviewRole: 'final_reviewer',
          reviewerCount: 2,
        }),
      ).rejects.toMatchObject({ code: 'review_binding_missing' });
      expect(reviewRows(state.h)).toHaveLength(1);
      expect(reviewRun(state.h)).toHaveLength(1);
    });

    it('a correct persisted binding still restarts and starts exactly once', async () => {
      const state = await corrupt('final', () => undefined);
      const fresh = state.h.restart();
      expect((await fresh.supervisor.tickGoal(state.h.fx.goalId)).action).toBe('review_run_started');
      expect(state.h.startRun).toHaveBeenCalledTimes(1);
      expect(reviewRows(state.h)).toHaveLength(1);
    });
  });
});
