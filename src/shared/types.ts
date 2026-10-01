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
  | 'humanApproval';

export type WorkflowConditionPath =
  'build.success' | 'tests.failed' | 'review.openCritical' | 'review.openHigh' | 'finalGate.status';

export interface WorkflowCondition {
  path: WorkflowConditionPath;
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
  value: boolean | number | string;
}

export interface ModelOption {
  id: string;
  name: string;
  providerId: string;
  subscriptionBacked?: boolean;
  reasoningLevels?: string[];
  supportsTools?: boolean;
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
}

export interface WorkflowStage {
  id: string;
  label: string;
  kind: StageKind;
  role?: string;
  backendId?: string;
  providerId?: string;
  modelId?: string;
  reasoning?: string;
  maxIterations?: number;
  timeoutMinutes?: number;
  retryPolicy?: Partial<RetryPolicy>;
  parallelism?: number;
  command?: string[];
  condition?: WorkflowCondition;
  skipStageIds?: string[];
  notificationMessage?: string;
  commitMessage?: string;
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
}

export interface UsageEvent {
  id: string;
  occurredAt: string;
  providerId: string | null;
  modelId: string | null;
  backend: string | null;
  projectId: string | null;
  runId: string | null;
  stageId: string | null;
  role: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  requestCount: number;
  provenance: 'provider_reported' | 'locally_measured' | 'estimated' | 'unavailable';
  equivalentCostUsd: number | null;
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
  effectiveRules: TuringRule[];
  branchStrategy: 'worktree' | 'current-branch';
  expectedAiStages: number;
  canStart: boolean;
  warnings: string[];
  providerAssignments: Array<{
    stage: string;
    backendId: string | null;
    providerId: string | null;
    modelId: string | null;
    ready: boolean;
  }>;
}
