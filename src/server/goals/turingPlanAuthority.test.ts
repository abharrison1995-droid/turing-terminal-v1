import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalBuiltinById } from '../../shared/goalWorkflows.js';
import type { ProviderCapabilities, ProviderStatus, WorkflowDefinition } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in plan authority tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider } from '../providers.js';
import type { ProposalRequest } from './executor.js';
import { cleanupRepoFixtures, milestone, simpleDefinition } from './repoKit.js';
import { GOOD_TASK } from './supervisorKit.js';
import { TuringExecutorError, TuringGoalExecutor } from './turingExecutor.js';
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
const claude = (): ProviderStatus => ({
  id: 'claude-code',
  name: 'Claude Code',
  cli: 'claude',
  detected: true,
  version: '1',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
});
const done = (text: string) => ({
  text,
  inputTokens: 1,
  outputTokens: 1,
  usageProvenance: 'provider_reported' as const,
  exitCode: 0,
  stdout: 'ok',
});

let h: RealRunHarness | undefined;
const mutate = { current: (_workflow: WorkflowDefinition): void => undefined };
const NOW = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  mutate.current = () => undefined;
  vi.mocked(discoverProviders).mockResolvedValue([claude()]);
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

const customOf = (
  id: string,
  edit: (workflow: WorkflowDefinition) => void = () => undefined,
  from = 'goal-planning-v1',
): WorkflowDefinition => {
  const workflow = {
    ...structuredClone(goalBuiltinById(from)!),
    id,
    name: id,
    createdAt: NOW,
    updatedAt: NOW,
  } as WorkflowDefinition;
  edit(workflow);
  return workflow;
};

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
const outcome = async (harness: RealRunHarness, over: Partial<ProposalRequest> = {}) => {
  const before = runCount(harness);
  const result = await new TuringGoalExecutor(harness.fx.db, harness.plans)
    .queueProposalRun(request(harness, over))
    .then(
      (queued) => ({ runId: queued.runId }),
      (caught: unknown) => caught,
    );
  if (result instanceof TuringExecutorError) expect(runCount(harness)).toBe(before);
  return result instanceof TuringExecutorError ? result.code : result;
};

type Edit = [string, (workflow: WorkflowDefinition) => void];
const stage0 = (workflow: WorkflowDefinition) => workflow.stages[0]!;

const FORBIDDEN_CHANGES: Edit[] = [
  ['name', (w) => void (w.name = 'Renamed')],
  ['description', (w) => void (w.description = 'Changed')],
  ['template', (w) => void (w.template = 'other')],
  ['version', (w) => void (w.version = 2)],
  ['isDefault', (w) => void (w.isDefault = true)],
  [
    'executionProfile',
    (w) => void (w.executionProfile = w.executionProfile === 'economy' ? 'balanced' : 'economy'),
  ],
  ['promptRefinementDefault', (w) => void (w.promptRefinementDefault = !w.promptRefinementDefault)],
  ['maxRemediationRounds', (w) => void (w.maxRemediationRounds += 1)],
  ['maxParallelAgents', (w) => void (w.maxParallelAgents += 1)],
  ['maxParallelAgents (lower)', (w) => void (w.maxParallelAgents = 0)],
  ['maxDurationMinutes', (w) => void (w.maxDurationMinutes += 1)],
  [
    'retryPolicy.maxRetries',
    (w) => void (w.retryPolicy = { ...w.retryPolicy, maxRetries: w.retryPolicy.maxRetries + 1 }),
  ],
  ['retryPolicy.maxRetries (lower)', (w) => void (w.retryPolicy = { ...w.retryPolicy, maxRetries: 0 })],
  [
    'retryPolicy.initialDelayMs',
    (w) => void (w.retryPolicy = { ...w.retryPolicy, initialDelayMs: w.retryPolicy.initialDelayMs + 1 }),
  ],
  [
    'retryPolicy.maxDelayMs',
    (w) => void (w.retryPolicy = { ...w.retryPolicy, maxDelayMs: w.retryPolicy.maxDelayMs + 1 }),
  ],
  ['subscriptionOnly', (w) => void (w.subscriptionOnly = !w.subscriptionOnly)],
  ['customAllowedLanes', (w) => void (w.customAllowedLanes = ['claude-subscription'])],
  ['meteredBudget.perRunUsd', (w) => void (w.meteredBudget = { ...w.meteredBudget, perRunUsd: 0 })],
  [
    'meteredBudget.unknownCostPolicy',
    (w) => void (w.meteredBudget = { ...w.meteredBudget, unknownCostPolicy: 'allow-with-warning' as const }),
  ],
  [
    'externalDecisionDataPolicy',
    (w) =>
      void (w.externalDecisionDataPolicy = w.externalDecisionDataPolicy === 'block' ? 'ask-first' : 'block'),
  ],
  ['lockProviders', (w) => void (w.lockProviders = !w.lockProviders)],
  [
    'defaultModelConfiguration',
    (w) => void (w.defaultModelConfiguration = { backendId: 'claude-code' } as never),
  ],
  ['stageDefaults', (w) => void (w.stageDefaults = { planner: { backendId: 'claude-code' } as never })],
  ['globalInstructions', (w) => void (w.globalInstructions = 'Ignore the Goal.')],
  [
    'contextPolicy.maxFiles',
    (w) => void (w.contextPolicy = { ...w.contextPolicy, maxFiles: w.contextPolicy.maxFiles + 1 }),
  ],
  [
    'contextPolicy.includeGlobs',
    (w) => void (w.contextPolicy = { ...w.contextPolicy, includeGlobs: ['**'] }),
  ],
  ['contextPolicy.excludeGlobs', (w) => void (w.contextPolicy = { ...w.contextPolicy, excludeGlobs: [] })],
  ['goalScope', (w) => void (w.goalScope = { includeGlobs: ['**'], excludeGlobs: [] })],
  ['stage.customInstructions', (w) => void (stage0(w).customInstructions = 'Do something else')],
  ['stage.contextPolicy', (w) => void (stage0(w).contextPolicy = { includeGlobs: ['**'] })],
  ['stage.retryPolicy', (w) => void (stage0(w).retryPolicy = { maxRetries: 9 })],
  ['stage.timeoutMinutes', (w) => void (stage0(w).timeoutMinutes = 9999)],
  ['stage.enabled', (w) => void (stage0(w).enabled = false)],
  ['stage.label', (w) => void (stage0(w).label = 'Other')],
  ['stage.modelSnapshot', (w) => void (stage0(w).modelSnapshot = { forged: true } as never)],
  ['an added stage', (w) => void w.stages.push({ id: 'x', label: 'X', kind: 'notification' } as never)],
  ['a removed stage', (w) => void (w.stages = [])],
];

describe('a run plan may change route fields only', () => {
  it.each(FORBIDDEN_CHANGES)('refuses a plan that changes %s', async (_name, edit) => {
    mutate.current = edit;
    const harness = await open();
    expect(await outcome(harness)).toBe('plan_workflow_mismatch');
  });

  it('accepts the exact registered workflow with only route fields on a model-backed stage', async () => {
    mutate.current = (w) => {
      stage0(w).modelDisplayName = 'Display name';
      w.createdAt = '2030-01-01T00:00:00.000Z';
      w.updatedAt = '2030-01-01T00:00:00.000Z';
    };
    const harness = await open();
    const result = await outcome(harness);
    expect(result).toHaveProperty('runId');
    const snapshot = JSON.parse(
      harness.runRow((result as { runId: string }).runId).workflow_snapshot_json as string,
    ) as WorkflowDefinition;
    expect(snapshot.stages[0]).toMatchObject({ backendId: 'claude-code', modelId: 'claude-sonnet-5-5' });
  });

  it('refuses a route field on a deterministic stage', async () => {
    mutate.current = (w) => {
      Object.assign(w.stages[1]!, {
        backendId: 'claude-code',
        providerId: 'anthropic-subscription',
        modelId: 'm',
      });
    };
    const custom = customOf(
      'custom-plan',
      (w) => void w.stages.push({ id: 'b', label: 'Build', kind: 'build' }),
    );
    const harness = await open({ custom: [{ purpose: 'planning', workflow: custom }] });
    expect(await outcome(harness)).toBe('plan_workflow_mismatch');
  });

  it('does not take modelSnapshot from the plan: the queued snapshot is the preview-observed one', async () => {
    const harness = await open();
    const result = (await outcome(harness)) as { runId: string };
    const snapshot = JSON.parse(
      harness.runRow(result.runId).workflow_snapshot_json as string,
    ) as WorkflowDefinition;
    expect(snapshot.stages[0]!.modelSnapshot).toMatchObject({ modelId: 'claude-sonnet-5-5' });
    expect(snapshot.stages[0]!.modelSnapshot).not.toHaveProperty('forged');
  });

  it('still rejects a registered workflow that exceeds the Goal billing authority, without rewriting it', async () => {
    const custom = customOf('custom-plan', (w) => {
      w.billingMode = 'custom';
      w.subscriptionOnly = false;
    });
    const harness = await open({ custom: [{ purpose: 'planning', workflow: custom }] });
    expect(await outcome(harness)).toBe('plan_billing_exceeds_goal');
    const stored = harness.fx.db
      .prepare("SELECT config_json FROM workflows WHERE id = 'custom-plan'")
      .get() as { config_json: string };
    expect(JSON.parse(stored.config_json).billingMode).toBe('custom');
  });
});

describe('Goal parallelism clamp', () => {
  it('queues min(registered, Goal) parallelism after proving the plan equals the registered workflow', async () => {
    const definition = simpleDefinition({ milestones: [milestone('m1', ['build', 'tests'])] });
    definition.limits.maxParallelAgents = 2;
    const custom = customOf(
      'custom-plan',
      (w) => {
        w.maxParallelAgents = 3;
        w.stages = [
          { id: 'rev', label: 'Review', kind: 'parallelReview', role: 'reviewer', parallelism: 3 },
        ] as never;
      },
      'goal-review-v1',
    );
    const harness = await open({ definition, custom: [{ purpose: 'planning', workflow: custom }] });
    const result = (await outcome(harness)) as { runId: string };
    const snapshot = JSON.parse(
      harness.runRow(result.runId).workflow_snapshot_json as string,
    ) as WorkflowDefinition;
    expect(snapshot.maxParallelAgents).toBe(2);
    expect(snapshot.stages[0]!.parallelism).toBe(2);
  });

  it('never raises parallelism above the registered workflow when the Goal allows more', async () => {
    const harness = await open();
    const result = (await outcome(harness)) as { runId: string };
    const snapshot = JSON.parse(
      harness.runRow(result.runId).workflow_snapshot_json as string,
    ) as WorkflowDefinition;
    expect(harness.fx.definition.limits.maxParallelAgents).toBeGreaterThan(1);
    expect(snapshot.maxParallelAgents).toBe(1);
  });
});

describe('idempotent existing-run authority', () => {
  const queued = async () => {
    const harness = await open();
    const first = (await outcome(harness)) as { runId: string };
    return { harness, runId: first.runId, plans: harness.plans.requests.length };
  };

  it('returns the same run for a legitimate retry without a new plan request', async () => {
    const { harness, runId, plans } = await queued();
    expect(await outcome(harness)).toEqual({ runId });
    expect(harness.plans.requests).toHaveLength(plans);
  });

  it('refuses an existing run requested under the wrong Goal', async () => {
    const { harness, plans } = await queued();
    expect(await outcome(harness, { goalId: 'another-goal' })).toBe('goal_not_found');
    expect(harness.plans.requests).toHaveLength(plans);
  });

  it('refuses an existing run whose cycle belongs to another Goal', async () => {
    const { harness, plans } = await queued();
    const other = harness.fx.db
      .prepare(
        "INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) SELECT 'g2', machine_id, project_id, 'G2', 'draft', created_at, updated_at FROM goals WHERE id = ?",
      )
      .run(harness.fx.goalId);
    expect(other.changes).toBe(1);
    expect(await outcome(harness, { goalId: 'g2' })).toBe('cycle_goal_mismatch');
    expect(harness.plans.requests).toHaveLength(plans);
  });

  it('refuses an existing run for a superseded definition', async () => {
    const { harness, plans } = await queued();
    harness.fx.db.pragma('foreign_keys = OFF');
    harness.fx.db
      .prepare('UPDATE goals SET current_definition_version = 2 WHERE id = ?')
      .run(harness.fx.goalId);
    harness.fx.db.pragma('foreign_keys = ON');
    expect(await outcome(harness)).toBe('definition_superseded');
    expect(harness.plans.requests).toHaveLength(plans);
  });

  it('refuses an existing run requested with the wrong definition version or base', async () => {
    const { harness, plans } = await queued();
    expect(await outcome(harness, { definitionVersion: 7 })).toBe('definition_mismatch');
    expect(await outcome(harness, { baseCommit: harness.fx.orphanCommit() })).toBe('base_commit_mismatch');
    expect(harness.plans.requests).toHaveLength(plans);
  });

  it('refuses an existing execution run requested with a different task', async () => {
    const harness = await open();
    const task = { ...GOOD_TASK };
    harness.fx.db
      .prepare('UPDATE goal_cycles SET validated_task_json = ? WHERE id = ?')
      .run(JSON.stringify(task), harness.cycleId());
    const executor = new TuringGoalExecutor(harness.fx.db, harness.plans);
    const child = {
      goalId: harness.fx.goalId,
      cycleId: harness.cycleId(),
      purpose: 'execution' as const,
      task,
      baseCommit: harness.baseCommit,
    };
    const { runId } = await executor.queueChildRun(child);
    const plans = harness.plans.requests.length;
    expect(await executor.queueChildRun(child)).toEqual({ runId });
    const different = await executor
      .queueChildRun({ ...child, task: { ...task, instructions: 'A different task.' } })
      .then(
        () => 'queued',
        (error: TuringExecutorError) => error.code,
      );
    expect(different).toBe('task_mismatch');
    expect(harness.plans.requests).toHaveLength(plans);
  });
});

describe('Goal scope is a second, conjunctive read constraint (real provider broker)', () => {
  const FILES = [
    'src/parser/a.ts',
    'src/other.ts',
    'src/secret/k.ts',
    'src/generated/g.ts',
    'server/a.ts',
    'client/a.ts',
  ];
  const policy = (include: string[], exclude: string[] = []) => ({
    strategy: 'focused' as const,
    maxFiles: 24,
    maxEstimatedTokens: 32_000,
    maxFileBytes: 80_000,
    includeGlobs: include,
    excludeGlobs: ['.git/**', 'node_modules/**', ...exclude],
    includeCurrentDiff: true,
    includeTestOutput: true,
    includeBuildOutput: true,
    includePreviousArtifact: true,
    includePreviousTranscript: false,
    onLimitExceeded: 'compact' as const,
  });

  /** Runs one planning run whose planner tries to read every file through the real broker and reports the verdicts. */
  const readable = async (options: {
    registered?: string[];
    registeredExclude?: string[];
    stage?: Partial<ReturnType<typeof policy>>;
    scope: { includeGlobs: string[]; excludeGlobs?: string[] };
    taskExpectedPaths?: string[];
  }): Promise<Record<string, boolean>> => {
    const verdicts: Record<string, boolean> = {};
    vi.mocked(executeProvider).mockImplementation(async (req) => {
      for (const path of FILES) {
        const result = await h!.broker(req.toolBroker.token, 'read_file', { path });
        verdicts[path] = result.error === undefined;
      }
      return done(
        JSON.stringify({ ...GOOD_TASK, expectedPaths: options.taskExpectedPaths ?? GOOD_TASK.expectedPaths }),
      );
    });
    const custom = customOf('custom-plan', (w) => {
      w.contextPolicy = policy(options.registered ?? [], options.registeredExclude);
      if (options.stage) stage0(w).contextPolicy = options.stage;
    });
    const definition = simpleDefinition({
      milestones: [
        milestone('m1', ['build', 'tests'], {
          allowedScope: {
            includeGlobs: options.scope.includeGlobs,
            excludeGlobs: options.scope.excludeGlobs ?? [],
          },
        }),
      ],
    });
    h = await realRunHarness({ definition, custom: [{ purpose: 'planning', workflow: custom }] });
    h.fx.advance(Object.fromEntries(FILES.map((file) => [file, `export const x = '${file}';\n`])), 'files');
    await h.supervisor.startGoal(h.fx.goalId);
    await h.until('proposal_run_started');
    await vi.waitFor(() => expect(Object.keys(verdicts)).toHaveLength(FILES.length), { timeout: 15_000 });
    return verdicts;
  };

  it('broad registered workflow, narrow milestone: only the milestone scope is readable', async () => {
    const verdicts = await readable({ registered: [], scope: { includeGlobs: ['src/parser/**'] } });
    expect(verdicts['src/parser/a.ts']).toBe(true);
    expect(verdicts['src/other.ts']).toBe(false);
    expect(verdicts['server/a.ts']).toBe(false);
  });

  it('narrow registered workflow, broad milestone: the registered policy still binds', async () => {
    const verdicts = await readable({ registered: ['src/parser/**'], scope: { includeGlobs: ['src/**'] } });
    expect(verdicts['src/parser/a.ts']).toBe(true);
    expect(verdicts['src/other.ts']).toBe(false);
  });

  it('disjoint scopes deny everything: each side denies what the other allows', async () => {
    const verdicts = await readable({ registered: ['server/**'], scope: { includeGlobs: ['client/**'] } });
    expect(verdicts['server/a.ts']).toBe(false);
    expect(verdicts['client/a.ts']).toBe(false);
  });

  it('exclusions from either side stay denied', async () => {
    const verdicts = await readable({
      registered: [],
      registeredExclude: ['src/secret/**'],
      scope: { includeGlobs: ['src/**'], excludeGlobs: ['src/generated/**'] },
    });
    expect(verdicts['src/secret/k.ts']).toBe(false);
    expect(verdicts['src/generated/g.ts']).toBe(false);
    expect(verdicts['src/parser/a.ts']).toBe(true);
    expect(verdicts['src/other.ts']).toBe(true);
  });

  it('a narrower stage policy stays narrower and cannot remove the milestone constraint', async () => {
    const narrower = await readable({
      registered: [],
      stage: { includeGlobs: ['src/parser/**', 'server/**'] },
      scope: { includeGlobs: ['src/**'] },
    });
    expect(narrower['src/parser/a.ts']).toBe(true);
    expect(narrower['src/other.ts']).toBe(false);
    expect(narrower['server/a.ts']).toBe(false);
  });

  it('a stage policy that erases includes still cannot escape the milestone scope', async () => {
    const erased = await readable({
      registered: ['server/**'],
      stage: { includeGlobs: [] },
      scope: { includeGlobs: ['src/parser/**'] },
    });
    expect(erased['src/parser/a.ts']).toBe(true);
    expect(erased['src/other.ts']).toBe(false);
    expect(erased['server/a.ts']).toBe(false);
  });

  it('NextTask.expectedPaths has no effect on read authority', async () => {
    const verdicts = await readable({
      registered: [],
      scope: { includeGlobs: ['src/parser/**'] },
      taskExpectedPaths: ['src/other.ts', 'server/a.ts'],
    });
    expect(verdicts['src/other.ts']).toBe(false);
    expect(verdicts['server/a.ts']).toBe(false);
    expect(verdicts['src/parser/a.ts']).toBe(true);
  });

  it('listing is not read authority: a listed file outside either constraint is still unreadable', async () => {
    const seen: { listed: boolean; read: boolean | undefined } = { listed: false, read: undefined };
    vi.mocked(executeProvider).mockImplementation(async (req) => {
      const listing = await h!.broker(req.toolBroker.token, 'list_files', { path: 'src' });
      seen.listed = Boolean(listing.result?.includes('other.ts'));
      seen.read =
        (await h!.broker(req.toolBroker.token, 'read_file', { path: 'src/other.ts' })).error === undefined;
      return done(JSON.stringify(GOOD_TASK));
    });
    const definition = simpleDefinition({
      milestones: [
        milestone('m1', ['build', 'tests'], {
          allowedScope: { includeGlobs: ['src/parser/**'], excludeGlobs: [] },
        }),
      ],
    });
    h = await realRunHarness({ definition });
    h.fx.advance({ 'src/other.ts': 'x\n', 'src/parser/a.ts': 'y\n' }, 'files');
    await h.supervisor.startGoal(h.fx.goalId);
    await h.until('proposal_run_started');
    await vi.waitFor(() => expect(seen.read).toBeDefined(), { timeout: 15_000 });
    expect(seen.listed).toBe(true);
    expect(seen.read).toBe(false);
  });

  it('the queued workflow keeps the registered context policy untouched and carries the trusted scope', async () => {
    const harness = await open();
    const result = (await outcome(harness)) as { runId: string };
    const snapshot = JSON.parse(
      harness.runRow(result.runId).workflow_snapshot_json as string,
    ) as WorkflowDefinition;
    const registered = goalBuiltinById('goal-planning-v1')!;
    expect(snapshot.contextPolicy).toEqual(registered.contextPolicy);
    expect(snapshot.goalScope).toEqual({
      includeGlobs: harness.fx.definition.milestones[0]!.allowedScope.includeGlobs,
      excludeGlobs: harness.fx.definition.milestones[0]!.allowedScope.excludeGlobs,
    });
    void execFileSync;
  });
});
