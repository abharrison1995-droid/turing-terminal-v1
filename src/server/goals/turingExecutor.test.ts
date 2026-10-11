import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus, WorkflowDefinition } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in Goal executor tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider } from '../providers.js';
import { canonicalGoalBuiltin, canonicalStoredWorkflow } from '../db.js';
import { goalBuiltinById } from '../../shared/goalWorkflows.js';
import type { ProposalRequest } from './executor.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { GOOD_TASK } from './supervisorKit.js';
import { METERED_TEST_ROUTE } from './testPlanProvider.js';
import { TuringGoalExecutor, TuringExecutorError, PROPOSAL_LIMITS } from './turingExecutor.js';
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
const provider = (id: string, name: string, extra: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  name,
  cli: id,
  detected: true,
  version: '1',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
  ...extra,
});

let h: RealRunHarness | undefined;
const mutate = { current: (_workflow: WorkflowDefinition): void => undefined };

beforeEach(() => {
  mutate.current = () => undefined;
  vi.mocked(discoverProviders).mockResolvedValue([provider('claude-code', 'Claude Code')]);
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

const open = async (options: Parameters<typeof realRunHarness>[0] = {}) => {
  h = await realRunHarness({ ...options, mutate: (workflow) => mutate.current(workflow) });
  await h.supervisor.startGoal(h.fx.goalId);
  await h.until('cycle_created');
  return h;
};
const request = (harness: RealRunHarness, over: Partial<ProposalRequest> = {}): ProposalRequest => ({
  goalId: harness.fx.goalId,
  cycleId: harness.cycleId(),
  definitionVersion: 1,
  milestone: harness.fx.definition.milestones[0]!,
  baseCommit: harness.baseCommit,
  memory: {} as ProposalRequest['memory'],
  ...over,
});
const runCount = (harness: RealRunHarness) =>
  (harness.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
const refusal = async (harness: RealRunHarness, over: Partial<ProposalRequest> = {}) => {
  const before = runCount(harness);
  const error = await new TuringGoalExecutor(harness.fx.db, harness.plans)
    .queueProposalRun(request(harness, over))
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(TuringExecutorError);
  expect(runCount(harness)).toBe(before);
  return (error as TuringExecutorError).code;
};

describe('TuringGoalExecutor plan verification', () => {
  it(
    'queues a proposal run for a verified plan and never starts it',
    async () => {
      const harness = await open();
      const executor = new TuringGoalExecutor(harness.fx.db, harness.plans);
      const { runId } = await executor.queueProposalRun(request(harness));
      expect(harness.runRow(runId)).toMatchObject({ status: 'queued', goal_run_purpose: 'proposal' });
      expect(harness.engine.isActive(runId)).toBe(false);
      expect(vi.mocked(executeProvider)).not.toHaveBeenCalled();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a non-isolated plan',
    async () => {
      mutate.current = (workflow) => void (workflow.isolatedWorktree = false);
      expect(await refusal(await open())).toBe('plan_not_isolated');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a plan with a merge, push or rollback stage',
    async () => {
      mutate.current = (workflow) =>
        void workflow.stages.push({ id: 'merge', label: 'Merge', kind: 'gitMerge' } as never);
      expect(await refusal(await open())).toBe('plan_forbidden_stage');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses the enigma permission mode and any permission change',
    async () => {
      mutate.current = (workflow) => void (workflow.permissionMode = 'enigma');
      expect(await refusal(await open())).toBe('plan_permission_mode');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a plan that is more permissive in billing than the Goal',
    async () => {
      mutate.current = (workflow) => void (workflow.billingMode = 'custom');
      expect(await refusal(await open())).toBe('plan_billing_exceeds_goal');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a plan for a different workflow or with changed stages',
    async () => {
      mutate.current = (workflow) => void (workflow.id = 'goal-execution-v1');
      const harness = await open();
      expect(await refusal(harness)).toBe('plan_workflow_mismatch');
      mutate.current = (workflow) => void (workflow.stages[0]!.instructions = 'Do something else');
      expect(await refusal(harness)).toBe('plan_workflow_mismatch');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses when the plan provider says no route is ready',
    async () => {
      const harness = await open();
      harness.plans.planRun = async () => ({ ready: false, code: 'route_unavailable', message: 'none' });
      expect(await refusal(harness)).toBe('plan_unavailable');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a stale or mismatched base without a plan request or run',
    async () => {
      const harness = await open();
      const plans = harness.plans.requests.length;
      expect(await refusal(harness, { baseCommit: harness.fx.orphanCommit() })).toBe('base_commit_mismatch');
      expect(harness.plans.requests.length).toBe(plans);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a user workflow that shadows a reserved Goal workflow id',
    async () => {
      const harness = await open();
      const row = harness.fx.db
        .prepare("SELECT config_json FROM workflows WHERE id = 'goal-planning-v1'")
        .get() as {
        config_json: string;
      };
      const changed = { ...JSON.parse(row.config_json), description: 'tampered' };
      harness.fx.db
        .prepare(
          "UPDATE workflows SET config_json = ?, description = 'tampered' WHERE id = 'goal-planning-v1'",
        )
        .run(JSON.stringify(changed));
      expect(await refusal(harness)).toBe('reserved_workflow_conflict');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('TuringGoalExecutor.queueChildRun', () => {
  it(
    'refuses a task that is not the cycle validated task and starts no run',
    async () => {
      const harness = await open();
      const before = runCount(harness);
      const error = await new TuringGoalExecutor(harness.fx.db, harness.plans)
        .queueChildRun({
          goalId: harness.fx.goalId,
          cycleId: harness.cycleId(),
          purpose: 'execution',
          task: GOOD_TASK,
          baseCommit: harness.baseCommit,
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toMatchObject({ code: 'task_mismatch' });
      expect(runCount(harness)).toBe(before);
      expect(harness.plans.requests).toHaveLength(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('TuringGoalExecutor billing authority', () => {
  it(
    'refuses a metered plan for a subscriptions-only Goal at preview and starts no run',
    async () => {
      vi.mocked(discoverProviders).mockResolvedValue([
        provider('claude-code', 'Claude Code'),
        provider('opencode', 'OpenCode', {
          capabilities: { ...caps, modelDiscovery: true },
          models: [
            {
              id: METERED_TEST_ROUTE.modelId,
              providerId: 'anthropic',
              name: 'Metered model',
              subscriptionBacked: false,
              status: 'current',
            } as never,
          ],
        }),
      ]);
      const harness = await open({ route: METERED_TEST_ROUTE });
      expect(harness.fx.definition.limits.billingMode).toBe('subscriptions-only');
      expect(await refusal(harness)).toBe('preview_not_startable');
      expect(vi.mocked(executeProvider)).not.toHaveBeenCalled();
      // The adapter never mutates the registered workflow or the Goal's billing authority.
      const stored = harness.fx.db
        .prepare("SELECT * FROM workflows WHERE id = 'goal-planning-v1'")
        .get() as Record<string, unknown>;
      expect(canonicalStoredWorkflow(stored)).toBe(
        canonicalGoalBuiltin(goalBuiltinById('goal-planning-v1')!),
      );
      expect(harness.fx.definition.limits.billingMode).toBe('subscriptions-only');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses when the ready provider is disconnected (preview refusal)',
    async () => {
      vi.mocked(discoverProviders).mockResolvedValue([
        provider('claude-code', 'Claude Code', { subscriptionAuthenticated: false }),
      ]);
      expect(await refusal(await open())).toBe('preview_not_startable');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('TuringGoalExecutor.readProposal', () => {
  let seeded = 0;
  const seedRun = (
    harness: RealRunHarness,
    status: string,
    purpose: string,
    output: unknown,
    key = 'goal-propose',
  ) => {
    const runId = `run-${Math.random().toString(16).slice(2)}`;
    const cycleId = `cycle-${runId}`;
    harness.fx.db
      .prepare(
        `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at)
         VALUES (?, ?, 1, ?, 'execution', 't', 'cancelled', '2026-01-01T00:00:00.000Z')`,
      )
      .run(cycleId, harness.fx.goalId, 100 + seeded++);
    harness.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, goal_cycle_id, goal_run_purpose, goal_base_commit)
         VALUES (?, (SELECT machine_id FROM goals WHERE id = ?), ?, 'goal-planning-v1', '{}', 'p', 'economy', 'normal', ?, '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
      )
      .run(runId, harness.fx.goalId, harness.fx.projectId, status, cycleId, purpose, harness.baseCommit);
    if (output !== undefined)
      harness.fx.db
        .prepare(
          `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, output_json) VALUES (?, ?, ?, 'planner', 'P', 1, 'passed', ?)`,
        )
        .run(`stage-${runId}`, runId, key, typeof output === 'string' ? output : JSON.stringify(output));
    return runId;
  };

  it(
    'classifies missing, invalid, oversize, wrong-stage and non-completed runs',
    async () => {
      const harness = await open();
      harness.fx.db
        .prepare("UPDATE goal_cycles SET status = 'cancelled' WHERE goal_id = ?")
        .run(harness.fx.goalId);
      const executor = new TuringGoalExecutor(harness.fx.db, harness.plans);
      const read = (runId: string) => executor.readProposal(runId);
      expect(await read('absent')).toEqual({ ok: false, code: 'proposal_run_invalid' });
      expect(await read(seedRun(harness, 'running', 'proposal', { text: '{}' }))).toEqual({
        ok: false,
        code: 'proposal_run_invalid',
      });
      expect(await read(seedRun(harness, 'completed', 'execution', { text: '{}' }))).toEqual({
        ok: false,
        code: 'proposal_run_invalid',
      });
      expect(await read(seedRun(harness, 'completed', 'proposal', undefined))).toEqual({
        ok: false,
        code: 'proposal_output_missing',
      });
      expect(await read(seedRun(harness, 'completed', 'proposal', { text: '{}' }, 'other-stage'))).toEqual({
        ok: false,
        code: 'proposal_output_missing',
      });
      expect(await read(seedRun(harness, 'completed', 'proposal', { text: '   ' }))).toEqual({
        ok: false,
        code: 'proposal_output_missing',
      });
      expect(await read(seedRun(harness, 'completed', 'proposal', { text: 'not json' }))).toEqual({
        ok: false,
        code: 'proposal_output_invalid',
      });
      expect(await read(seedRun(harness, 'completed', 'proposal', '{broken'))).toEqual({
        ok: false,
        code: 'proposal_output_invalid',
      });
      expect(
        await read(
          seedRun(harness, 'completed', 'proposal', { text: 'x'.repeat(PROPOSAL_LIMITS.textChars + 1) }),
        ),
      ).toEqual({ ok: false, code: 'proposal_output_invalid' });
      expect(
        await read(
          seedRun(harness, 'completed', 'proposal', {
            text: 'y',
            pad: 'z'.repeat(PROPOSAL_LIMITS.outputJsonChars),
          }),
        ),
      ).toEqual({ ok: false, code: 'proposal_output_invalid' });
      expect(
        await read(seedRun(harness, 'completed', 'proposal', { text: `\n${JSON.stringify(GOOD_TASK)}\n` })),
      ).toEqual({ ok: true, proposal: GOOD_TASK });
      expect(vi.mocked(executeProvider)).not.toHaveBeenCalled();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
