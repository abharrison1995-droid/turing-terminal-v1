import type {
  BudgetStatus,
  ConnectionProfileWithCredentials,
  MetricTotal,
  UsageAggregate,
  UsageAnalytics,
  UsageGroupRow,
} from '../../src/client/api';
import type {
  Approval,
  DashboardSnapshot,
  MachineStatus,
  ModelPreset,
  ProjectProfile,
  ProviderStatus,
  RunStage,
  RunStatus,
  RunSummary,
  StageAttempt,
  StageKind,
  StageStatus,
  TuringRule,
  WorkflowDefinition,
  WorkflowStage,
} from '../../src/shared/types';
import type {
  GoalDashboardApprovals,
  GoalDashboardSummary,
  GoalListItem,
  GoalListResponse,
  UnifiedApproval,
  UnifiedApprovalsResponse,
} from '../../src/shared/goalApi';
import { FIXED_NOW } from './dashboard';

/**
 * FIXTURE DATA. Every value in this file is invented for deterministic UI evidence: no project, run, provider, goal,
 * approval or usage figure here came from a machine, a provider or a user. Names carry a "Fixture" prefix so a
 * screenshot cannot be mistaken for product data. Timestamps are fixed offsets from `FIXED_NOW`, never the wall clock.
 */
const NOW_MS = Date.parse(FIXED_NOW);
const at = (minutesBeforeNow: number): string => new Date(NOW_MS - minutesBeforeNow * 60_000).toISOString();

const machine: MachineStatus = {
  id: 'fixture-machine',
  name: 'Fixture machine',
  hostname: 'fixture-host',
  os: 'linux',
  status: 'online',
  lastSeenAt: at(0),
};

// ---- Projects (3) -------------------------------------------------------------------------------------------------

function project(
  id: string,
  name: string,
  branch: string,
  languages: string[],
  frameworks: string[],
): ProjectProfile {
  return {
    id,
    name,
    path: `/fixture/projects/${id}`,
    gitRoot: `/fixture/projects/${id}`,
    branch,
    dirty: false,
    packageManager: 'npm',
    languages,
    frameworks,
    buildCommand: ['npm', 'run', 'build'],
    testCommand: ['npm', 'test'],
    lintCommand: ['npm', 'run', 'lint'],
    readmePath: null,
    instructionFiles: [],
    machineId: machine.id,
    createdAt: at(60 * 24 * 30),
  };
}

const PROJECT_ATLAS = 'fixture-project-atlas';
const PROJECT_LEDGER = 'fixture-project-ledger';
const PROJECT_DOCS = 'fixture-project-docs';

const projects: ProjectProfile[] = [
  project(PROJECT_ATLAS, 'Fixture Atlas API', 'main', ['TypeScript'], ['Fastify']),
  project(PROJECT_LEDGER, 'Fixture Ledger UI', 'main', ['TypeScript'], ['React']),
  project(PROJECT_DOCS, 'Fixture Docs Site', 'main', ['Markdown'], []),
];

// ---- Workflows (2) ------------------------------------------------------------------------------------------------

function workflowStage(id: string, label: string, kind: StageKind): WorkflowStage {
  return { id, label, kind, enabled: true };
}

const workflows: WorkflowDefinition[] = [
  {
    id: 'fixture-workflow-standard',
    name: 'Fixture standard review',
    description: 'Fixture: plan, implement, test, review, then commit after approval.',
    template: 'standard',
    executionProfile: 'balanced',
    permissionMode: 'supervised',
    promptRefinementDefault: false,
    maxRemediationRounds: 2,
    maxParallelAgents: 1,
    maxDurationMinutes: 60,
    retryPolicy: { maxRetries: 1, initialDelayMs: 2000, maxDelayMs: 10000 },
    isolatedWorktree: true,
    subscriptionOnly: true,
    billingMode: 'subscriptions-only',
    meteredBudget: { perRunUsd: null, unknownCostPolicy: 'block' },
    externalDecisionDataPolicy: 'block',
    lockProviders: false,
    contextPolicy: {
      strategy: 'focused',
      maxFiles: 40,
      maxEstimatedTokens: 60000,
      maxFileBytes: 200000,
      includeGlobs: [],
      excludeGlobs: [],
      includeCurrentDiff: true,
      includeTestOutput: true,
      includeBuildOutput: false,
      includePreviousArtifact: true,
      includePreviousTranscript: false,
      onLimitExceeded: 'compact',
    },
    stages: [
      workflowStage('fixture-stage-plan', 'Plan', 'planner'),
      workflowStage('fixture-stage-implement', 'Implement', 'implementer'),
      workflowStage('fixture-stage-test', 'Test', 'test'),
      workflowStage('fixture-stage-review', 'Review', 'reviewer'),
      workflowStage('fixture-stage-commit', 'Commit', 'gitCommit'),
    ],
    version: 3,
    isDefault: true,
    createdAt: at(60 * 24 * 20),
    updatedAt: at(60 * 24 * 2),
  },
  {
    id: 'fixture-workflow-quick-fix',
    name: 'Fixture quick fix',
    description: 'Fixture: implement and test only, with a commit approval.',
    template: 'quick-fix',
    executionProfile: 'economy',
    permissionMode: 'normal',
    promptRefinementDefault: false,
    maxRemediationRounds: 1,
    maxParallelAgents: 1,
    maxDurationMinutes: 30,
    retryPolicy: { maxRetries: 0, initialDelayMs: 2000, maxDelayMs: 10000 },
    isolatedWorktree: true,
    subscriptionOnly: true,
    billingMode: 'subscriptions-only',
    meteredBudget: { perRunUsd: null, unknownCostPolicy: 'block' },
    externalDecisionDataPolicy: 'block',
    lockProviders: false,
    contextPolicy: {
      strategy: 'changed-files',
      maxFiles: 12,
      maxEstimatedTokens: 20000,
      maxFileBytes: 100000,
      includeGlobs: [],
      excludeGlobs: [],
      includeCurrentDiff: true,
      includeTestOutput: true,
      includeBuildOutput: false,
      includePreviousArtifact: false,
      includePreviousTranscript: false,
      onLimitExceeded: 'stop',
    },
    stages: [
      workflowStage('fixture-quick-implement', 'Implement', 'implementer'),
      workflowStage('fixture-quick-test', 'Test', 'test'),
      workflowStage('fixture-quick-commit', 'Commit', 'gitCommit'),
    ],
    version: 1,
    isDefault: false,
    createdAt: at(60 * 24 * 10),
    updatedAt: at(60 * 24 * 10),
  },
];

// ---- Providers (2, both fixture) -----------------------------------------------------------------------------------

const noCapabilities = {
  authentication: false,
  subscriptionAuth: false,
  modelDiscovery: false,
  execution: false,
  streaming: false,
  cancellation: false,
  usageTelemetry: false,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: false,
};

const providers: ProviderStatus[] = [
  {
    id: 'fixture-provider-a',
    name: 'Fixture provider A',
    cli: 'fixture-cli-a',
    detected: true,
    version: '0.0.0-fixture',
    authentication: 'connected',
    subscriptionAuthenticated: true,
    authMechanism: 'fixture',
    note: 'Fixture: not a real provider.',
    checkedAt: at(1),
    capabilities: {
      ...noCapabilities,
      authentication: true,
      execution: true,
      streaming: true,
      cancellation: true,
    },
    models: [
      {
        id: 'fixture-model-1',
        name: 'Fixture model 1',
        providerId: 'fixture-provider-a',
        subscriptionBacked: true,
        supportsTools: true,
        contextLength: 200000,
      },
    ],
    catalogSource: 'cache',
    catalogRefreshedAt: at(1),
  },
  {
    id: 'fixture-provider-b',
    name: 'Fixture provider B',
    cli: 'fixture-cli-b',
    detected: false,
    version: null,
    authentication: 'disconnected',
    subscriptionAuthenticated: null,
    authMechanism: 'fixture',
    note: 'Fixture: not installed on this machine.',
    checkedAt: at(1),
    capabilities: noCapabilities,
    models: [],
    catalogSource: 'none',
    catalogRefreshedAt: null,
  },
];

// ---- Runs (6: running, waiting_for_approval x2, completed, failed, paused) -----------------------------------------

type StageSpec = { key: string; kind: StageKind; title: string; status: StageStatus; error?: string };

function runStages(runId: string, specs: StageSpec[], startedAt: string | null): RunStage[] {
  return specs.map((spec, index) => {
    const failed = spec.status === 'failed';
    const attempts: StageAttempt[] = failed
      ? [
          {
            id: `${runId}-${spec.key}-attempt-1`,
            attempt: 1,
            reviewerIndex: null,
            status: 'failed',
            category: 'test',
            error: spec.error ?? 'Fixture: check failed.',
            startedAt: startedAt ?? at(0),
            finishedAt: at(170),
          },
        ]
      : [];
    const finished = spec.status === 'passed' || spec.status === 'failed' || spec.status === 'skipped';
    return {
      id: `${runId}-${spec.key}`,
      runId,
      stageKey: spec.key,
      kind: spec.kind,
      title: spec.title,
      sequence: index + 1,
      backendId: 'fixture-backend',
      providerId: 'fixture-provider-a',
      modelId: 'fixture-model-1',
      status: spec.status,
      startedAt: spec.status === 'pending' ? null : (startedAt ?? at(0)),
      finishedAt: finished ? at(170) : null,
      output: null,
      error: spec.error ?? null,
      logs: '',
      attempts,
    };
  });
}

interface RunSpec {
  id: string;
  projectId: string;
  projectName: string;
  workflow: WorkflowDefinition;
  prompt: string;
  status: RunStatus;
  createdMinutesAgo: number;
  startedMinutesAgo: number;
  completedMinutesAgo: number | null;
  elapsedMs: number;
  summary: string | null;
  stages: StageSpec[];
}

function run(spec: RunSpec): RunSummary {
  const startedAt = at(spec.startedMinutesAgo);
  return {
    id: spec.id,
    machineId: machine.id,
    projectId: spec.projectId,
    projectName: spec.projectName,
    workflowId: spec.workflow.id,
    workflowName: spec.workflow.name,
    prompt: spec.prompt,
    profile: spec.workflow.executionProfile,
    permissionMode: spec.workflow.permissionMode,
    refinePrompt: false,
    subscriptionOnly: true,
    billingMode: 'subscriptions-only',
    lockProviders: false,
    status: spec.status,
    branch: `fixture/${spec.id}`,
    worktreePath: null,
    summary: spec.summary,
    createdAt: at(spec.createdMinutesAgo),
    startedAt,
    completedAt: spec.completedMinutesAgo === null ? null : at(spec.completedMinutesAgo),
    stages: runStages(spec.id, spec.stages, startedAt),
    elapsedMs: spec.elapsedMs,
    remainingMs: null,
  };
}

const [standard, quickFix] = workflows as [WorkflowDefinition, WorkflowDefinition];

const runs: RunSummary[] = [
  run({
    id: 'fixture-run-001',
    projectId: PROJECT_ATLAS,
    projectName: 'Fixture Atlas API',
    workflow: standard,
    prompt: 'Fixture: add bounded retry backoff to the Atlas client.',
    status: 'running',
    createdMinutesAgo: 14,
    startedMinutesAgo: 12,
    completedMinutesAgo: null,
    elapsedMs: 720_000,
    summary: null,
    stages: [
      { key: 'plan', kind: 'planner', title: 'Plan', status: 'passed' },
      { key: 'implement', kind: 'implementer', title: 'Implement', status: 'running' },
      { key: 'test', kind: 'test', title: 'Test', status: 'pending' },
      { key: 'review', kind: 'reviewer', title: 'Review', status: 'pending' },
      { key: 'commit', kind: 'gitCommit', title: 'Commit', status: 'pending' },
    ],
  }),
  run({
    id: 'fixture-run-002',
    projectId: PROJECT_LEDGER,
    projectName: 'Fixture Ledger UI',
    workflow: standard,
    prompt: 'Fixture: export ledger rows as CSV v2 with a stable header.',
    status: 'waiting_for_approval',
    createdMinutesAgo: 95,
    startedMinutesAgo: 93,
    completedMinutesAgo: null,
    elapsedMs: 420_000,
    summary: null,
    stages: [
      { key: 'plan', kind: 'planner', title: 'Plan', status: 'passed' },
      { key: 'implement', kind: 'implementer', title: 'Implement', status: 'passed' },
      { key: 'test', kind: 'test', title: 'Test', status: 'passed' },
      { key: 'review', kind: 'reviewer', title: 'Review', status: 'passed' },
      { key: 'commit', kind: 'gitCommit', title: 'Commit', status: 'waiting_for_approval' },
    ],
  }),
  run({
    id: 'fixture-run-003',
    projectId: PROJECT_DOCS,
    projectName: 'Fixture Docs Site',
    workflow: quickFix,
    prompt: 'Fixture: fix the broken link in the onboarding guide.',
    status: 'waiting_for_approval',
    createdMinutesAgo: 40,
    startedMinutesAgo: 38,
    completedMinutesAgo: null,
    elapsedMs: 120_000,
    summary: null,
    stages: [
      { key: 'implement', kind: 'implementer', title: 'Implement', status: 'passed' },
      { key: 'test', kind: 'test', title: 'Test', status: 'passed' },
      { key: 'commit', kind: 'gitCommit', title: 'Commit', status: 'waiting_for_approval' },
    ],
  }),
  run({
    id: 'fixture-run-004',
    projectId: PROJECT_ATLAS,
    projectName: 'Fixture Atlas API',
    workflow: standard,
    prompt: 'Fixture: tighten the Atlas error envelope.',
    status: 'completed',
    createdMinutesAgo: 300,
    startedMinutesAgo: 298,
    completedMinutesAgo: 250,
    elapsedMs: 2_880_000,
    summary: 'Fixture: 3 files changed, build and tests passed.',
    stages: [
      { key: 'plan', kind: 'planner', title: 'Plan', status: 'passed' },
      { key: 'implement', kind: 'implementer', title: 'Implement', status: 'passed' },
      { key: 'test', kind: 'test', title: 'Test', status: 'passed' },
      { key: 'review', kind: 'reviewer', title: 'Review', status: 'passed' },
      { key: 'commit', kind: 'gitCommit', title: 'Commit', status: 'passed' },
    ],
  }),
  run({
    id: 'fixture-run-005',
    projectId: PROJECT_LEDGER,
    projectName: 'Fixture Ledger UI',
    workflow: quickFix,
    prompt: 'Fixture: align ledger totals with the ledger header row.',
    status: 'failed',
    createdMinutesAgo: 200,
    startedMinutesAgo: 198,
    completedMinutesAgo: 170,
    elapsedMs: 1_800_000,
    summary: 'Fixture: the test stage failed after two remediation rounds.',
    stages: [
      { key: 'implement', kind: 'implementer', title: 'Implement', status: 'passed' },
      {
        key: 'test',
        kind: 'test',
        title: 'Test',
        status: 'failed',
        error: 'Fixture: 2 tests failed in ledger-totals.test.ts.',
      },
      { key: 'commit', kind: 'gitCommit', title: 'Commit', status: 'skipped' },
    ],
  }),
  run({
    id: 'fixture-run-006',
    projectId: PROJECT_DOCS,
    projectName: 'Fixture Docs Site',
    workflow: standard,
    prompt: 'Fixture: rewrite the onboarding guide headings.',
    status: 'paused',
    createdMinutesAgo: 70,
    startedMinutesAgo: 68,
    completedMinutesAgo: null,
    elapsedMs: 120_000,
    summary: null,
    stages: [
      { key: 'plan', kind: 'planner', title: 'Plan', status: 'passed' },
      { key: 'implement', kind: 'implementer', title: 'Implement', status: 'pending' },
      { key: 'test', kind: 'test', title: 'Test', status: 'pending' },
      { key: 'review', kind: 'reviewer', title: 'Review', status: 'pending' },
      { key: 'commit', kind: 'gitCommit', title: 'Commit', status: 'pending' },
    ],
  }),
];

// ---- Run approvals (2, both pending) -------------------------------------------------------------------------------

const runApprovals: Approval[] = [
  {
    id: 'fixture-approval-001',
    runId: 'fixture-run-002',
    stageId: 'fixture-run-002-commit',
    operation: 'git commit',
    reason: 'Fixture: commit the reviewed CSV v2 changes to the run branch.',
    risk: 'medium',
    status: 'pending',
    createdAt: at(20),
    respondedAt: null,
  },
  {
    id: 'fixture-approval-002',
    runId: 'fixture-run-003',
    stageId: 'fixture-run-003-commit',
    operation: 'git commit',
    reason: 'Fixture: commit the one-line link fix to the run branch.',
    risk: 'low',
    status: 'pending',
    createdAt: at(12),
    respondedAt: null,
  },
];

// ---- Goals (4) ----------------------------------------------------------------------------------------------------

const GOAL_APPROVAL_ID = 'fixture-goal-approval-001';

function goal(
  overrides: Partial<GoalListItem> & Pick<GoalListItem, 'id' | 'title' | 'status'>,
): GoalListItem {
  return {
    projectId: PROJECT_ATLAS,
    projectName: 'Fixture Atlas API',
    reasonCode: null,
    reasonDetail: null,
    needsUser: false,
    attention: [],
    paused: false,
    pendingApprovalCount: 0,
    currentDefinitionVersion: 1,
    activeMilestone: null,
    lastCycle: null,
    nextAction: { kind: 'wait_for_turing' },
    integrationBranch: null,
    integrationHead: null,
    openFindingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    usageSummary: { events: 0, inputTokens: null, outputTokens: null, meteredSpendUsd: 0 },
    createdAt: at(60 * 24 * 6),
    updatedAt: at(9),
    ...overrides,
  };
}

const goalAtlas = goal({
  id: 'fixture-goal-atlas',
  title: 'Fixture: harden Atlas client retries',
  status: 'running',
  currentDefinitionVersion: 2,
  activeMilestone: { key: 'm2-retry', title: 'Retry policy', runtimeStatus: 'running' },
  lastCycle: {
    id: 'fixture-cycle-atlas-3',
    sequence: 3,
    kind: 'execution',
    status: 'running',
    triggerCode: 'scheduled',
    finishedAt: null,
  },
  nextAction: { kind: 'wait_for_turing' },
  integrationBranch: 'goal/fixture-atlas-retries',
  integrationHead: null,
  openFindingCounts: { critical: 0, high: 0, medium: 1, low: 2 },
  usageSummary: { events: 14, inputTokens: 88_210, outputTokens: 12_904, meteredSpendUsd: 0 },
  updatedAt: at(9),
});

const goalLedger = goal({
  id: 'fixture-goal-ledger',
  title: 'Fixture: CSV v2 ledger export',
  projectId: PROJECT_LEDGER,
  projectName: 'Fixture Ledger UI',
  status: 'needs_user',
  reasonCode: 'approval_required',
  needsUser: true,
  attention: ['status_needs_user', 'pending_goal_approval'],
  pendingApprovalCount: 1,
  currentDefinitionVersion: 1,
  activeMilestone: { key: 'm3-writer', title: 'CSV v2 writer', runtimeStatus: 'completed' },
  lastCycle: {
    id: 'fixture-cycle-ledger-2',
    sequence: 2,
    kind: 'review',
    status: 'completed',
    triggerCode: 'milestone_complete',
    finishedAt: at(25),
  },
  nextAction: { kind: 'review_approval', approvalId: GOAL_APPROVAL_ID },
  integrationBranch: 'goal/fixture-ledger-csv',
  integrationHead: null,
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 1 },
  usageSummary: { events: 22, inputTokens: 141_003, outputTokens: 20_118, meteredSpendUsd: 0 },
  updatedAt: at(25),
});

const goalDocs = goal({
  id: 'fixture-goal-docs',
  title: 'Fixture: onboarding guide refresh',
  projectId: PROJECT_DOCS,
  projectName: 'Fixture Docs Site',
  status: 'paused',
  reasonCode: 'paused_by_user',
  paused: true,
  currentDefinitionVersion: 1,
  lastCycle: {
    id: 'fixture-cycle-docs-2',
    sequence: 2,
    kind: 'review',
    status: 'completed',
    triggerCode: 'user_pause',
    finishedAt: at(70),
  },
  nextAction: { kind: 'resume' },
  usageSummary: { events: 6, inputTokens: 21_400, outputTokens: 3_870, meteredSpendUsd: 0 },
  updatedAt: at(70),
});

const goalCli = goal({
  id: 'fixture-goal-cli',
  title: 'Fixture: JSON output for the status command',
  status: 'completed',
  currentDefinitionVersion: 1,
  lastCycle: {
    id: 'fixture-cycle-cli-4',
    sequence: 4,
    kind: 'verification',
    status: 'completed',
    triggerCode: 'completion',
    finishedAt: at(480),
  },
  nextAction: { kind: 'completed' },
  completionStandingBrief: {
    state: 'ready',
    standing: 'uncontested',
    qualifier: 'none',
    trusted: true,
    // Honest value: the fixture claims an uncontested decision, not that the content was proven correct.
    contentPreservation: 'not_proven',
  },
  usageSummary: { events: 31, inputTokens: 190_772, outputTokens: 27_560, meteredSpendUsd: 0 },
  updatedAt: at(480),
});

const goals: GoalListItem[] = [goalAtlas, goalLedger, goalDocs, goalCli];

const goalsResponse: GoalListResponse = { goals, total: goals.length, limit: 50 };

const goalSummary: GoalDashboardSummary = {
  total: goals.length,
  active: 2,
  needsUser: 1,
  blocked: 0,
  paused: 1,
  cards: [goalAtlas, goalLedger],
};

const goalApproval: UnifiedApproval = {
  source: 'goal',
  id: GOAL_APPROVAL_ID,
  goalId: goalLedger.id,
  title: 'milestone_complete',
  reason: 'Fixture: the CSV v2 writer milestone is ready for your review.',
  risk: 'medium',
  status: 'pending',
  requestedBy: 'supervisor',
  decidedBy: null,
  createdAt: at(25),
  respondedAt: null,
  gate: 'milestone_complete',
  decidable: true,
};

const goalApprovals: GoalDashboardApprovals = { pending: 1, approvals: [goalApproval] };

const unifiedApprovalsAll: UnifiedApproval[] = [
  ...runApprovals.map((approval): UnifiedApproval => ({
    source: 'run',
    id: approval.id,
    runId: approval.runId,
    title: approval.operation,
    reason: approval.reason,
    risk: approval.risk,
    status: approval.status,
    requestedBy: 'supervisor',
    decidedBy: null,
    createdAt: approval.createdAt,
    respondedAt: null,
  })),
  goalApproval,
];

// ---- Dashboard snapshot -------------------------------------------------------------------------------------------

export const POPULATED_SNAPSHOT: DashboardSnapshot = {
  machine,
  projects,
  workflows,
  providers,
  runs,
  approvals: runApprovals,
  goals: goalSummary,
  goalApprovals,
  usage: {
    events: 128,
    localMinutesToday: 42,
    inputTokens: 1_234_567,
    outputTokens: 234_567,
    provenance: 'locally observed',
  },
};

// ---- Usage (/api/usage and /api/usage/analytics) ------------------------------------------------------------------

const metric = (value: number | null, reported: number): MetricTotal => ({
  value,
  reported,
  missing: value === null ? reported : 0,
});

function aggregate(
  events: number,
  inputTokens: number,
  outputTokens: number,
  equivalentUsd: number,
): UsageAggregate {
  return {
    events,
    requests: events,
    durationMs: events * 4_200,
    inputTokens: metric(inputTokens, events),
    outputTokens: metric(outputTokens, events),
    cachedInputTokens: metric(0, events),
    cacheWriteTokens: metric(0, events),
    reasoningTokens: metric(null, 0),
    totalTokens: metric(inputTokens + outputTokens, events),
    actualMeteredCostUsd: metric(0, events),
    equivalentValueUsd: metric(equivalentUsd, events),
    tokenProvenance: { locally_measured: events },
  };
}

function group(
  key: string,
  label: string,
  providerId: string | null,
  modelId: string | null,
  totals: UsageAggregate,
): UsageGroupRow {
  return {
    ...totals,
    key,
    label,
    billingLane: 'subscription',
    providerId,
    modelId,
    roles: {},
    projects: {},
    reasoning: {},
    upstreamProviders: {},
  };
}

const totals = aggregate(128, 1_234_567, 234_567, 0);
const dayBuckets = [
  '2026-01-09',
  '2026-01-10',
  '2026-01-11',
  '2026-01-12',
  '2026-01-13',
  '2026-01-14',
  '2026-01-15',
];

const usageAnalytics: UsageAnalytics = {
  filter: { from: at(60 * 24 * 7), to: FIXED_NOW, timeZone: 'UTC' },
  granularity: 'day',
  totals,
  activeModels: 1,
  activeBillingLanes: 1,
  series: dayBuckets.map((bucket, index) => ({
    bucket,
    ...aggregate(14 + index * 2, 150_000 + index * 9_000, 25_000 + index * 1_500, 0),
  })),
  byBillingLane: [group('subscription', 'Subscription (fixture)', null, null, totals)],
  byModel: [group('fixture-model-1', 'Fixture model 1', 'fixture-provider-a', 'fixture-model-1', totals)],
  byProvider: [group('fixture-provider-a', 'Fixture provider A', 'fixture-provider-a', null, totals)],
  byRole: [],
  byProject: [
    group(PROJECT_ATLAS, 'Fixture Atlas API', null, null, aggregate(54, 510_000, 96_000, 0)),
    group(PROJECT_LEDGER, 'Fixture Ledger UI', null, null, aggregate(48, 460_000, 88_000, 0)),
    group(PROJECT_DOCS, 'Fixture Docs Site', null, null, aggregate(26, 264_567, 50_567, 0)),
  ],
  byWorkflow: [],
  byMachine: [group(machine.id, 'Fixture machine', null, null, totals)],
  byWorkload: [],
  byReasoning: [],
  decisions: {
    decisions: 0,
    byType: {},
    byOutcome: {},
    autoRouted: 0,
    escalated: 0,
    costUsd: metric(0, 0),
    inputTokens: metric(0, 0),
    outputTokens: metric(0, 0),
    averageBooleanProbability: null,
    averageChoiceConfidence: null,
    averageScoreConfidence: null,
    byEngineModel: [],
  },
  events: [],
  eventCount: totals.events,
};

const usageLegacy = {
  window: '30d',
  days: 30,
  since: at(60 * 24 * 30),
  provenance: 'FIXTURE: locally measured activity, invented for screenshot evidence.',
  quotas: [],
  providers: [{ key: 'fixture-provider-a', label: 'Fixture provider A', events: totals.events }],
  models: [{ key: 'fixture-model-1', events: totals.events }],
  projects: [
    { name: 'Fixture Atlas API', events: 54, duration_ms: 226_800 },
    { name: 'Fixture Ledger UI', events: 48, duration_ms: 201_600 },
    { name: 'Fixture Docs Site', events: 26, duration_ms: 109_200 },
  ],
  daily: [],
  eventCount: totals.events,
  raw: [],
};

// ---- Settings helpers ---------------------------------------------------------------------------------------------

const rules: TuringRule[] = [
  {
    id: 'fixture-rule-diffs',
    scope: 'global',
    projectId: null,
    name: 'Fixture rule: keep diffs small',
    description: 'Fixture rule for screenshot evidence.',
    content: 'Fixture: prefer changes under 300 lines per run.',
    enabled: true,
    priority: 10,
    mandatory: true,
    appliesTo: [],
    createdAt: at(60 * 24 * 12),
    updatedAt: at(60 * 24 * 12),
  },
  {
    id: 'fixture-rule-secrets',
    scope: 'global',
    projectId: null,
    name: 'Fixture rule: never commit secrets',
    description: 'Fixture rule for screenshot evidence.',
    content: 'Fixture: refuse to stage files that look like credentials.',
    enabled: true,
    priority: 20,
    mandatory: true,
    appliesTo: [],
    createdAt: at(60 * 24 * 12),
    updatedAt: at(60 * 24 * 12),
  },
];

// ---- Budgets, connection profiles and model presets (read by Settings and Workflows) ------------------------------

const budgetStatus: BudgetStatus = {
  timeZone: 'UTC',
  run: { committedUsd: 0, capUsd: null },
  daily: { committedUsd: 0, capUsd: 10 },
  monthly: { committedUsd: 0, capUsd: 100 },
  warningRatio: 0.8,
};

const connectionProfiles: ConnectionProfileWithCredentials[] = [
  {
    id: 'fixture-profile-subscription',
    name: 'Fixture subscription profile',
    backendId: 'fixture-backend',
    providerId: 'fixture-provider-a',
    billingLane: 'claude-subscription',
    credentialStoreRef: null,
    metadata: { note: 'FIXTURE: no credential is stored.' },
    createdAt: at(60 * 24 * 20),
    updatedAt: at(60 * 24 * 20),
    credentials: { inference: false, management: false },
  },
];

const modelPresets: ModelPreset[] = [
  {
    id: 'fixture-preset-balanced',
    name: 'Fixture balanced preset',
    configuration: {
      backendId: 'fixture-backend',
      providerId: 'fixture-provider-a',
      billingLane: 'claude-subscription',
      modelId: 'fixture-model-1',
      modelDisplayName: 'Fixture model 1',
      reasoning: 'balanced',
    },
    createdAt: at(60 * 24 * 14),
    updatedAt: at(60 * 24 * 14),
  },
];

// ---- Route table for installFixtures() ----------------------------------------------------------------------------

/**
 * Responses for the populated screens, keyed by pathname (the same key `installFixtures` uses). Pass to
 * `installFixtures(page, populatedRoutes)`. Any endpoint not listed is still recorded as unmapped.
 */
export const populatedRoutes: Record<string, unknown> = {
  '/api/dashboard': POPULATED_SNAPSHOT,
  '/api/providers': { providers },
  '/api/rules': { rules },
  '/api/goals': goalsResponse,
  '/api/approvals/unified': (url: URL): UnifiedApprovalsResponse => {
    const goalId = url.searchParams.get('goalId');
    const approvals = goalId
      ? unifiedApprovalsAll.filter((approval) => approval.goalId === goalId)
      : unifiedApprovalsAll;
    return { approvals, total: approvals.length, limit: 20 };
  },
  '/api/usage': usageLegacy,
  '/api/usage/analytics': usageAnalytics,
  '/api/system/readiness': {
    tailscale: {
      installed: true,
      running: true,
      hostname: 'fixture-host.example.invalid',
      ips: ['100.64.0.1'],
      serveConfigured: true,
      identityHeaderPresent: true,
      identityObservation: 'fixture: identity header present',
      masterLoopbackOnly: true,
      connectionHealth: 'ready',
      message: 'Fixture: ready (invented readiness, not a live check).',
    },
  },
  '/api/pairing/requests': { requests: [] },
  '/api/pairing/devices': {
    devices: [
      {
        id: 'fixture-device-001',
        name: 'Fixture phone',
        tailscaleLogin: null,
        createdAt: at(60 * 24 * 5),
        lastSeenAt: at(3),
        expiresAt: at(-60 * 24 * 85),
        status: 'active',
      },
    ],
  },
  '/api/budgets': {
    settings: {
      dailyUsd: 10,
      monthlyUsd: 100,
      warningRatio: 0.8,
      timezone: 'UTC',
      updatedAt: at(60 * 24 * 3),
    },
    status: budgetStatus,
    systemTimeZone: 'UTC',
  },
  '/api/connection-profiles': { profiles: connectionProfiles },
  '/api/model-presets': { presets: modelPresets },
  '/api/notifications/config': {
    enabled: false,
    publicKey: null,
    reason: 'Fixture: web push is not configured.',
  },
};
