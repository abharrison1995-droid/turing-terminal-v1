import type { GoalDashboardApprovals, GoalDashboardSummary } from './goalApi.js';

export type PermissionMode = 'supervised' | 'normal' | 'yolo' | 'enigma';
export type ExecutionProfile = 'economy' | 'balanced' | 'maximum';
export type RunStatus =
  | 'queued'
  | 'preparing'
  | 'waiting_for_approval'
  | 'running'
  | 'waiting_for_user'
  | 'retrying'
  | 'paused'
  | 'paused_limit_reached'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_user'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled';
export type StageKind =
  | 'planner'
  | 'promptRefinement'
  | 'implementer'
  | 'build'
  | 'test'
  | 'reviewer'
  | 'parallelReview'
  | 'consolidate'
  | 'orchestrator'
  | 'remediation'
  | 'finalGate'
  | 'gitCheckpoint'
  | 'gitCommit'
  | 'gitPush'
  | 'gitMerge'
  | 'gitRollback'
  | 'conditionalBranch'
  | 'shellCommand'
  | 'notification'
  | 'humanApproval'
  | 'decisionGate';

export type WorkflowConditionPath =
  'build.success' | 'tests.failed' | 'review.openCritical' | 'review.openHigh' | 'finalGate.status';

export interface WorkflowCondition {
  path: WorkflowConditionPath;
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
  value: boolean | number | string;
}

/** How a model exposes reasoning control. Values stay provider-native; labels are presentational only. */
export type ReasoningControl = 'effort' | 'variant' | 'budget' | 'provider-controlled' | 'none';
export type ModelIdentityKind = 'pinned' | 'floating';
export type ModelCatalogStatus = 'current' | 'last-known' | 'unavailable' | 'deprecated';
export type CapabilityFamily = 'generative' | 'decision';

export interface NumericRange {
  min: number;
  max: number;
}

/** Per-token USD prices reported by a metered provider catalog. Null means unknown, never zero. */
export interface ModelPricingSnapshot {
  promptUsdPerToken: number | null;
  completionUsdPerToken: number | null;
  requestUsd: number | null;
  cacheReadUsdPerToken: number | null;
  /** Highest conditional/override price seen; used for conservative reservations. */
  maxPromptUsdPerToken: number | null;
  maxCompletionUsdPerToken: number | null;
  source: string;
  observedAt: string;
}

export interface ModelOption {
  id: string;
  name: string;
  providerId: string;
  subscriptionBacked?: boolean;
  /** Provider-native reasoning/effort values the selected model reports. */
  reasoningLevels?: string[];
  variantIds?: string[];
  capabilities?: Record<string, unknown>;
  discoveredAt?: string;
  adapterVersion?: string | null;
  supportsTools?: boolean;
  family?: CapabilityFamily;
  reasoningControl?: ReasoningControl;
  reasoningBudgetRange?: NumericRange;
  supportsTemperature?: boolean;
  temperatureRange?: NumericRange;
  supportsMaxOutput?: boolean;
  maxOutputRange?: NumericRange;
  supportsImages?: boolean;
  supportsStructuredOutput?: boolean;
  contextLength?: number | null;
  identity?: ModelIdentityKind;
  status?: ModelCatalogStatus;
  deprecationDate?: string | null;
  pricing?: ModelPricingSnapshot;
}

export interface ProviderCapabilities {
  authentication: boolean;
  subscriptionAuth: boolean;
  modelDiscovery: boolean;
  execution: boolean;
  streaming: boolean;
  cancellation: boolean;
  usageTelemetry: boolean;
  remainingAllowance: boolean;
  resetTelemetry: boolean;
  structuredOutput: boolean;
  sessionResume: boolean;
  toolMediation: boolean;
  /** Turing can bill this backend through a metered lane (OpenRouter, Cline usage-billing, …). */
  meteredBilling?: boolean;
  /** Turing can read whether the provider will silently fall back to pay-as-you-go. */
  providerSideFallbackStatus?: boolean;
  /** Structured decision API (for example Jev through OpenRouter Decisions). */
  decisions?: boolean;
}

/** Provider-measured key/account telemetry. Key-level and account-level values are kept separate. */
export interface ProviderSpendTelemetry {
  scope: 'key' | 'account';
  connectionProfileId: string | null;
  label: string | null;
  usageUsd: number | null;
  usageDailyUsd: number | null;
  usageWeeklyUsd: number | null;
  usageMonthlyUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  limitReset: string | null;
  expiresAt: string | null;
  accountCreditsUsd: number | null;
  accountUsageUsd: number | null;
  provenance: 'provider_measured';
  observedAt: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  cli: string;
  detected: boolean;
  version: string | null;
  authentication: 'connected' | 'disconnected' | 'unknown';
  subscriptionAuthenticated?: boolean | null;
  authMechanism: string;
  note: string;
  checkedAt: string;
  capabilities: ProviderCapabilities;
  models: ModelOption[];
  /** live = refreshed from the provider now; cache = last-known catalog after a failed refresh. */
  catalogSource?: 'live' | 'cache' | 'adapter' | 'none';
  catalogRefreshedAt?: string | null;
  spendTelemetry?: ProviderSpendTelemetry[];
}

export type BillingLane =
  | 'opencode-go-subscription'
  | 'opencode-metered'
  | 'clinepass-subscription'
  | 'cline-usage-billing'
  | 'chatgpt-subscription'
  | 'claude-subscription'
  | 'openai-api'
  | 'anthropic-api'
  | 'openrouter-metered'
  | 'unknown';

/**
 * Run-level billing permission. Subscriptions Only blocks every metered lane. Subscriptions + Decision
 * Budget additionally allows explicitly configured Decision Engine calls on a metered lane under budget.
 * Custom allows explicitly configured lanes. No mode permits silent substitution.
 */
export type BillingMode = 'subscriptions-only' | 'subscriptions-plus-decision-budget' | 'custom';
export type WorkloadType = 'generative' | 'decision' | 'deterministic';
export type UnknownCostPolicy = 'block' | 'ask' | 'allow-with-warning';
export type ExternalDataPolicy = 'allow' | 'ask-first' | 'block';

export interface MeteredBudgetPolicy {
  /** Hard Turing cap for metered spend in one run (USD). Null = no per-run cap (requires custom mode). */
  perRunUsd: number | null;
  unknownCostPolicy: UnknownCostPolicy;
}

/** Desktop-wide metered budgets, separate from any provider-enforced key limit. */
export interface MeteredBudgetSettings {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  warningRatio: number;
  timezone: string | null;
  updatedAt: string | null;
}

export type UsageProvenance =
  'provider_measured' | 'locally_measured' | 'user_configured' | 'estimated' | 'unavailable';

export type DecisionEngineId =
  'deterministic-rules' | 'jev-openrouter' | 'subscription-llm-judge' | 'openrouter-judge';
export type DecisionQuestionType = 'boolean' | 'choice' | 'score';
export type DecisionInputCategory =
  'task' | 'plan' | 'implementation' | 'diff' | 'tests' | 'build' | 'findings' | 'finalGate';
export type DecisionOutcome = 'pass' | 'fail' | 'uncertain' | 'choice';

export interface DecisionRouteAction {
  action: 'continue' | 'skip-stages' | 'fail-run' | 'human-approval' | 'escalate';
  skipStageIds?: string[];
}

export interface DecisionRoutingPolicy {
  /** The explicit DecisionResult field thresholds read. Probability and confidence are never interchangeable. */
  field: 'probability' | 'confidence' | 'score';
  passAtOrAbove?: number;
  failAtOrBelow?: number;
  /** Choice/score only: below this engine-reported confidence the result is UNCERTAIN. */
  minConfidence?: number;
  onPass: DecisionRouteAction;
  onFail: DecisionRouteAction;
  onUncertain: DecisionRouteAction;
  choiceRoutes?: Record<string, DecisionRouteAction>;
}

export interface DecisionEngineRoute {
  engine: DecisionEngineId;
  modelId?: string;
  connectionProfileId?: string;
  /** Subscription judge route (backend/provider/lane/model/variant) — reuses the normal stage route model. */
  judge?: ModelConfiguration;
}

export interface DecisionGateConfig extends DecisionEngineRoute {
  questionType: DecisionQuestionType;
  question: string;
  /** boolean: {true,false} descriptions; choice: option id → description; score: ordered level descriptions. */
  criteria?: Record<string, string> | string[];
  inputs: DecisionInputCategory[];
  maxStateChars?: number;
  /** Deterministic Rules engine: structured proposition over Turing state. */
  rule?: WorkflowCondition;
  routing: DecisionRoutingPolicy;
  escalation?: DecisionEngineRoute;
  instructions?: string;
}

export interface DecisionResult {
  id: string;
  runId: string | null;
  stageId: string | null;
  batchId: string | null;
  usageEventId: string | null;
  engine: DecisionEngineId;
  providerId: string | null;
  billingLane: BillingLane | null;
  configuredModelId: string | null;
  resolvedModelId: string | null;
  upstreamProvider: string | null;
  questionId: string;
  questionType: DecisionQuestionType;
  question: string;
  answer: string | boolean | number | null;
  /** Boolean: engine-reported P(true). Never a confidence value. */
  probability: number | null;
  distribution: Record<string, number> | null;
  /** Engine-reported confidence (for Jev: peakedness of the distribution). Never a probability. */
  confidence: number | null;
  confidenceKind: 'engine-distribution' | 'self-reported' | 'deterministic' | null;
  score: number | null;
  legend: Record<string, string> | null;
  outcome: DecisionOutcome;
  route: DecisionRouteAction & { reason: string };
  configHash: string;
  schemaVersion: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costProvenance: UsageProvenance;
  escalatedFromId: string | null;
  createdAt: string;
}

export type ContextStrategy = 'focused' | 'changed-files' | 'artifacts-only' | 'full-project';

export interface ContextPolicy {
  strategy: ContextStrategy;
  maxFiles: number;
  maxEstimatedTokens: number;
  maxFileBytes: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  includeCurrentDiff: boolean;
  includeTestOutput: boolean;
  includeBuildOutput: boolean;
  includePreviousArtifact: boolean;
  includePreviousTranscript: boolean;
  onLimitExceeded: 'compact' | 'ask' | 'stop';
}

export interface ModelConfiguration {
  backendId?: string;
  connectionProfileId?: string;
  providerId?: string;
  billingLane?: BillingLane;
  modelId?: string;
  modelDisplayName?: string;
  variantId?: string;
  reasoning?: string;
  /** Exact adapter-native fields (for example effort, thinking budget, or variant). */
  nativeSettings?: Record<string, string | number | boolean | null>;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  backendId: string;
  providerId: string;
  billingLane: BillingLane;
  credentialStoreRef: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPreset {
  id: string;
  name: string;
  configuration: ModelConfiguration;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStage {
  id: string;
  label: string;
  kind: StageKind;
  role?: string;
  backendId?: string;
  providerId?: string;
  billingLane?: BillingLane;
  modelId?: string;
  reasoning?: string;
  connectionProfileId?: string;
  modelDisplayName?: string;
  variantId?: string;
  nativeSettings?: Record<string, string | number | boolean | null>;
  modelSnapshot?: {
    providerId: string;
    modelId: string;
    displayName: string;
    connectionProfileName?: string | null;
    billingLane?: BillingLane;
    variantId?: string;
    capabilities: Record<string, unknown>;
    discoveredAt: string | null;
    adapterVersion: string | null;
    status: ModelCatalogStatus;
    identity?: ModelIdentityKind;
    reasoningControl?: ReasoningControl;
  };
  customInstructions?: string;
  contextPolicy?: Partial<ContextPolicy>;
  decision?: DecisionGateConfig;
  /** Optional AI Orchestrator: it may only choose among these explicitly configured forward branches. */
  orchestration?: {
    branches: Array<{ id: string; label: string; skipStageIds: string[] }>;
    defaultBranchId: string;
  };
  maxIterations?: number;
  timeoutMinutes?: number;
  retryPolicy?: Partial<RetryPolicy>;
  parallelism?: number;
  command?: string[];
  condition?: WorkflowCondition;
  skipStageIds?: string[];
  notificationMessage?: string;
  commitMessage?: string;
  /** gitCommit only: a clean worktree completes the stage without creating a commit instead of failing. */
  allowNoChanges?: boolean;
  pushRemote?: string;
  pushBranch?: string;
  rollbackTarget?: 'runStart' | 'latestCheckpoint';
  continueOnFailure?: boolean;
  enabled?: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  template: string;
  executionProfile: ExecutionProfile;
  permissionMode: PermissionMode;
  promptRefinementDefault: boolean;
  maxRemediationRounds: number;
  maxParallelAgents: number;
  maxDurationMinutes: number;
  retryPolicy: RetryPolicy;
  isolatedWorktree: boolean;
  /** Derived compatibility flag: true unless billingMode is custom. */
  subscriptionOnly: boolean;
  billingMode: BillingMode;
  customAllowedLanes?: BillingLane[];
  meteredBudget: MeteredBudgetPolicy;
  externalDecisionDataPolicy: ExternalDataPolicy;
  lockProviders: boolean;
  defaultModelConfiguration?: ModelConfiguration;
  stageDefaults?: Partial<Record<StageKind, ModelConfiguration>>;
  globalInstructions?: string;
  contextPolicy: ContextPolicy;
  /**
   * Trusted Goal milestone scope, minted only by Turing's Goal executor after a run plan is verified. It is an
   * independent conjunctive constraint: a path must be allowed by the context policy AND by this scope. No API schema
   * accepts it and a run plan carrying it is refused.
   */
  goalScope?: { includeGlobs: string[]; excludeGlobs: string[] };
  stages: WorkflowStage[];
  version: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TuringRule {
  id: string;
  scope: 'global' | 'project';
  projectId: string | null;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  priority: number;
  mandatory: boolean;
  appliesTo: StageKind[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectProfile {
  id: string;
  name: string;
  path: string;
  gitRoot: string | null;
  branch: string | null;
  dirty: boolean | null;
  packageManager: string | null;
  languages: string[];
  frameworks: string[];
  buildCommand: string[] | null;
  testCommand: string[] | null;
  lintCommand: string[] | null;
  readmePath: string | null;
  instructionFiles: string[];
  machineId: string;
  createdAt: string;
}

export interface MachineStatus {
  id: string;
  name: string;
  hostname: string;
  os: string;
  status: 'online' | 'offline';
  lastSeenAt: string;
}

export interface RunStage {
  id: string;
  runId: string;
  stageKey: string;
  kind: StageKind;
  title: string;
  sequence: number;
  backendId: string | null;
  providerId: string | null;
  modelId: string | null;
  connectionProfileId?: string | null;
  billingLane?: BillingLane | null;
  variantId?: string | null;
  modelSnapshot?: WorkflowStage['modelSnapshot'] | null;
  reasoning?: string | null;
  nativeSettings?: Record<string, string | number | boolean | null>;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  output: Record<string, unknown> | null;
  error: string | null;
  logs: string;
  attempts: StageAttempt[];
}

export interface StageAttempt {
  id: string;
  attempt: number;
  reviewerIndex: number | null;
  status: 'running' | 'retrying' | 'succeeded' | 'failed';
  category: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunSummary {
  id: string;
  machineId: string;
  projectId: string;
  projectName: string;
  workflowId: string;
  workflowName: string;
  prompt: string;
  profile: ExecutionProfile;
  permissionMode: PermissionMode;
  refinePrompt: boolean;
  subscriptionOnly?: boolean;
  billingMode?: BillingMode;
  lockProviders?: boolean;
  status: RunStatus;
  branch: string | null;
  worktreePath: string | null;
  summary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  stages: RunStage[];
  elapsedMs: number;
  remainingMs: number | null;
  /** Whether the user's Stop control may cancel this run. False for Goal-owned and route-probe runs and settled runs. */
  cancellable: boolean;
}

export type UsageReconciliationState = 'pending' | 'locally_estimated' | 'provider_reconciled' | 'final';

/** One canonical row per external inference/decision call. Later telemetry updates it in place. */
export interface UsageEvent {
  id: string;
  requestId: string | null;
  providerRequestId: string | null;
  occurredAt: string;
  machineId: string | null;
  projectId: string | null;
  projectName?: string | null;
  workflowId: string | null;
  runId: string | null;
  stageId: string | null;
  stageTitle?: string | null;
  role: string | null;
  workloadType: WorkloadType;
  backend: string | null;
  connectionProfileId: string | null;
  billingLane: BillingLane | null;
  providerId: string | null;
  upstreamProvider: string | null;
  modelId: string | null;
  resolvedModelId: string | null;
  modelDisplayName: string | null;
  variantId: string | null;
  reasoning: string | null;
  contextStrategy: string | null;
  decisionEngine: string | null;
  decisionType: string | null;
  decisionOutcome: string | null;
  batchId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requestCount: number;
  durationMs: number;
  latencyMs: number | null;
  status: string;
  finishReason: string | null;
  tokenProvenance: UsageProvenance;
  actualCostUsd: number | null;
  actualCostProvenance: UsageProvenance;
  equivalentCostUsd: number | null;
  reconciliationState: UsageReconciliationState;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface Approval {
  id: string;
  runId: string;
  stageId: string | null;
  operation: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  respondedAt: string | null;
}

export interface ExecutionOperation {
  id: string;
  stageId: string;
  backendId: string;
  providerId: string;
  modelId: string;
  role: string;
  operationType: string;
  action: Record<string, unknown>;
  cwd: string;
  projectRoot: string;
  classification: string;
  approvalRequired: boolean;
  approvalId: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  result: unknown;
  stdout: string | null;
  stderr: string | null;
}

export interface GitOperation {
  id: string;
  runId: string;
  stageId: string;
  operation: string;
  branch: string | null;
  target: string | null;
  approvalId: string | null;
  approvalRequired: boolean;
  status: string;
  beforeCommit: string | null;
  afterCommit: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DashboardSnapshot {
  machine: MachineStatus;
  projects: ProjectProfile[];
  workflows: WorkflowDefinition[];
  providers: ProviderStatus[];
  runs: RunSummary[];
  approvals: Approval[];
  /** Additive Goal fields the server already returns; absent from older masters. */
  goals?: GoalDashboardSummary;
  goalApprovals?: GoalDashboardApprovals;
  usage: {
    events: number;
    localMinutesToday: number;
    inputTokens: number | null;
    outputTokens: number | null;
    provenance: string;
  };
}

export interface RunPreview {
  project: ProjectProfile;
  workflow: WorkflowDefinition;
  machine: MachineStatus;
  task: string;
  profile: ExecutionProfile;
  permissionMode: PermissionMode;
  refinePrompt: boolean;
  subscriptionOnly: boolean;
  billingMode: BillingMode;
  lockProviders: boolean;
  effectiveRules: TuringRule[];
  branchStrategy: 'worktree' | 'current-branch';
  expectedAiStages: number;
  canStart: boolean;
  warnings: string[];
  providerAssignments: Array<{
    stage: string;
    stageId?: string;
    kind?: StageKind;
    role?: string | null;
    workload?: WorkloadType;
    identity?: ModelIdentityKind;
    billingAllowed?: boolean;
    billingReason?: string | null;
    decision?: {
      engine: DecisionEngineId;
      questionType: DecisionQuestionType;
      question: string;
      routingField: DecisionRoutingPolicy['field'];
      inputs: DecisionInputCategory[];
      external: boolean;
      externalDataPolicy: ExternalDataPolicy;
      configHash: string;
      escalation: DecisionEngineId | null;
    };
    backendId: string | null;
    providerId: string | null;
    modelId: string | null;
    modelDisplayName?: string | null;
    variantId?: string | null;
    connectionProfileName?: string | null;
    billingLane?: BillingLane;
    catalogStatus?: 'current' | 'last-known' | 'unavailable' | 'deprecated';
    context: {
      label: string;
      estimatedInputTokens: number;
      maxEstimatedTokens: number;
      maxFiles: number;
      maxFileBytes: number;
      onLimitExceeded: 'compact' | 'ask' | 'stop';
      estimateOnly: true;
    };
    reasoning?: string | null;
    nativeSettings?: Record<string, string | number | boolean | null>;
    ready: boolean;
  }>;
  billingSummary: Array<{ billingLane: BillingLane | 'not-used'; stages: string[] }>;
  routingSummary: {
    subscriptions: Array<{ billingLane: BillingLane; label: string; stages: string[] }>;
    metered: Array<{
      billingLane: BillingLane;
      label: string;
      generativeStages: string[];
      decisionStages: string[];
    }>;
    meteredNone: boolean;
    runMeteredCapUsd: number | null;
    dailyBudgetUsd: number | null;
    monthlyBudgetUsd: number | null;
    unknownCostPolicy: UnknownCostPolicy;
    paygFallback: 'none' | 'configured';
    externalDecisionDataPolicy: ExternalDataPolicy;
  };
  providerFallbackStatus: Array<{
    backendId: string;
    billingLane?: BillingLane;
    status: 'known-disabled' | 'known-enabled' | 'unknown';
    message: string;
  }>;
  contextWarnings: string[];
}
