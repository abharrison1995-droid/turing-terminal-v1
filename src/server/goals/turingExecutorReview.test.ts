import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in Goal executor tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider } from '../providers.js';
import type { ReviewRunRequest } from './executor.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { getCycle } from './cycles.js';
import { readReviewPlan } from './reviewPlan.js';
import { createReviewCycle } from './reviewCycle.js';
import { reviewRoleForKind } from './reviewRole.js';
import { TuringGoalExecutor, TuringExecutorError } from './turingExecutor.js';
import { realRunHarness, type RealRunHarness } from './turingRunKit.js';

const caps: ProviderCapabilities = {
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery: false,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: true,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
};
const claude: ProviderStatus = {
  id: 'claude-code',
  name: 'Claude Code',
  cli: 'claude-code',
  detected: true,
  version: '1',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
};

let h: RealRunHarness | undefined;
beforeEach(() => vi.mocked(discoverProviders).mockResolvedValue([claude]));
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

/** A running Goal whose only cycle is a freshly created final review cycle (the earlier proposal cycle is retired). */
const open = async (kind: 'final' | 'milestone' | 'periodic' = 'final') => {
  h = await realRunHarness();
  await h.supervisor.startGoal(h.fx.goalId);
  await h.until('cycle_created');
  h.fx.db
    .prepare("UPDATE goal_cycles SET status = 'cancelled', finished_at = ? WHERE goal_id = ?")
    .run(new Date().toISOString(), h.fx.goalId);
  const created = createReviewCycle(h.fx.db, {
    goalId: h.fx.goalId,
    reviewKind: kind,
    triggerCode: 'test_trigger',
    ...(kind === 'milestone' ? { milestoneKey: 'm1' } : {}),
  });
  if (!created.created) throw new Error('expected a new review cycle');
  return { h, cycleId: created.cycle.id };
};
const request = (harness: RealRunHarness, cycleId: string, over: Partial<ReviewRunRequest> = {}) => ({
  goalId: harness.fx.goalId,
  cycleId,
  baseCommit: harness.fx.head(),
  reviewKind: 'final' as const,
  reviewRole: reviewRoleForKind('final'),
  reviewerCount: readReviewPlan(getCycle(harness.fx.db, cycleId)!.outcome)?.reviewerCount ?? 1,
  ...over,
});
const executorOf = (harness: RealRunHarness) => new TuringGoalExecutor(harness.fx.db, harness.plans);
const runCount = (harness: RealRunHarness) =>
  (harness.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
const refusal = async (harness: RealRunHarness, input: ReviewRunRequest) => {
  const before = runCount(harness);
  const error = await executorOf(harness)
    .queueReviewRun(input)
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(TuringExecutorError);
  expect(runCount(harness)).toBe(before);
  return (error as TuringExecutorError).code;
};

describe('TuringGoalExecutor.queueReviewRun', () => {
  it('queues a never-started review run with the materialised review workflow and task', async () => {
    const { h: harness, cycleId } = await open('final');
    const { runId } = await executorOf(harness).queueReviewRun(request(harness, cycleId));
    expect(harness.runRow(runId)).toMatchObject({
      status: 'queued',
      goal_run_purpose: 'review',
      goal_cycle_id: cycleId,
      goal_base_commit: harness.fx.head(),
    });
    expect(harness.engine.isActive(runId)).toBe(false);
    const row = harness.runRow(runId);
    const snapshot = JSON.parse(row.workflow_snapshot_json as string) as {
      id: string;
      isolatedWorktree: boolean;
      stages: Array<{ kind: string; customInstructions?: string; parallelism?: number }>;
    };
    expect(snapshot.id).toBe('goal-review-v1');
    expect(snapshot.isolatedWorktree).toBe(true);
    const stages = snapshot.stages.filter((stage) =>
      ['parallelReview', 'consolidate', 'finalGate'].includes(stage.kind),
    );
    expect(stages).toHaveLength(3);
    for (const stage of stages) expect(stage.customInstructions).toMatch(/^Goal review/);
    expect(row.prompt).toContain('final reviewer');
    expect(row.prompt).toContain(harness.fx.head());
    expect(harness.plans.requests.at(-1)).toMatchObject({ purpose: 'review', reviewRole: 'final_reviewer' });
    expect(vi.mocked(executeProvider)).not.toHaveBeenCalled();
  });

  it('is idempotent per cycle: a retry returns the existing run and plans nothing', async () => {
    const { h: harness, cycleId } = await open('final');
    const first = await executorOf(harness).queueReviewRun(request(harness, cycleId));
    const plans = harness.plans.requests.length;
    expect(await executorOf(harness).queueReviewRun(request(harness, cycleId))).toEqual(first);
    expect(harness.plans.requests.length).toBe(plans);
    expect(runCount(harness)).toBe(
      1 +
        (
          harness.fx.db
            .prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose <> 'review'")
            .get() as { n: number }
        ).n,
    );
  });

  it('refuses a role, kind or count that is not the persisted review plan, queueing nothing', async () => {
    const { h: harness, cycleId } = await open('final');
    expect(await refusal(harness, request(harness, cycleId, { reviewRole: 'routine_reviewer' }))).toBe(
      'review_invalid',
    );
    expect(
      await refusal(
        harness,
        request(harness, cycleId, { reviewKind: 'periodic', reviewRole: 'routine_reviewer' }),
      ),
    ).toBe('review_plan_mismatch');
    expect(await refusal(harness, request(harness, cycleId, { reviewerCount: 4 }))).toBe(
      'review_plan_mismatch',
    );
    expect(harness.plans.requests.filter((r) => r.purpose === 'review')).toHaveLength(0);
  });

  it('refuses a cycle that is not a review cycle', async () => {
    const { h: harness } = await open('final');
    const execution = harness.fx.db
      .prepare("SELECT id FROM goal_cycles WHERE goal_id = ? AND kind <> 'review' ORDER BY sequence LIMIT 1")
      .get(harness.fx.goalId) as { id: string };
    const code = await refusal(harness, request(harness, execution.id, { reviewerCount: 1 }));
    expect(['review_invalid', 'cycle_mismatch', 'review_plan_mismatch', 'cycle_terminal']).toContain(code);
    expect(harness.plans.requests.filter((r) => r.purpose === 'review')).toHaveLength(0);
  });

  it('refuses a stale base commit without a plan request or run', async () => {
    const { h: harness, cycleId } = await open('final');
    expect(await refusal(harness, request(harness, cycleId, { baseCommit: harness.fx.orphanCommit() }))).toBe(
      'base_commit_mismatch',
    );
    expect(harness.plans.requests.filter((r) => r.purpose === 'review')).toHaveLength(0);
  });

  it('refuses when the Goal head moved after the cycle captured its base', async () => {
    const { h: harness, cycleId } = await open('final');
    const captured = harness.fx.head();
    harness.fx.advance({ 'src/late.ts': 'export const late = 1;\n' }, 'late');
    expect(await refusal(harness, request(harness, cycleId, { baseCommit: captured }))).toBe(
      'base_commit_mismatch',
    );
  });

  it('refuses a plan provider that returns a different workflow or a non-isolated plan', async () => {
    const { h: harness, cycleId } = await open('final');
    const original = harness.plans.planRun.bind(harness.plans);
    harness.plans.planRun = async (input) => {
      const plan = await original(input);
      if (plan.ready) plan.workflowOverride.isolatedWorktree = false;
      return plan;
    };
    expect(await refusal(harness, request(harness, cycleId))).toBe('plan_not_isolated');
  });

  it('passes a typed first-use approval refusal through untouched', async () => {
    const { h: harness, cycleId } = await open('final');
    harness.plans.planRun = async () => ({
      ready: false,
      code: 'approval_required',
      message: 'first use',
      approval: {
        poolId: 'p',
        role: 'final_reviewer',
        memberIndex: 0,
        memberIdentityHash: 'x'.repeat(64),
      } as never,
    });
    expect(await refusal(harness, request(harness, cycleId))).toBe('approval_required');
  });
});
