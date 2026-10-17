import type {
  Approval,
  ProjectProfile,
  RunStage,
  RunSummary,
  StageAttempt,
  WorkflowDefinition,
  ContextPolicy,
  ConnectionProfile,
  ModelPreset,
} from '../shared/types.js';
import type { BillingLane, BillingMode } from '../shared/types.js';
import { BILLING_MODES, resolveBillingMode } from '../shared/billing.js';
import type { Db } from './db.js';

type Row = Record<string, unknown>;

/**
 * The owner that alone may cancel a run, or null for an ordinary run the user may stop. Goal-owned runs (goal_cycle_id)
 * are retired by their Grand Project, and route-probe runs (route_validation_probes) by their reconciler, in every
 * status. It lives here, below runLauncher and app, so the cancel routes and the run projection share one rule.
 */
export function runCancellationOwner(db: Db, runId: string): 'goal-owned' | 'route-probe' | null {
  const row = db.prepare('SELECT goal_cycle_id FROM runs WHERE id = ?').get(runId) as
    { goal_cycle_id: string | null } | undefined;
  if (row && row.goal_cycle_id !== null) return 'goal-owned';
  if (db.prepare('SELECT 1 FROM route_validation_probes WHERE run_id = ?').get(runId)) return 'route-probe';
  return null;
}

/**
 * Statuses the Stop control acts on, matching the client's active set without `cancelling`: a stop already in flight
 * needs no second control. A queued run is stoppable only when no owner must start it. An executing run stays
 * stoppable whatever its owner, because RunEngine.cancel is the only cancel path for a wedged Goal run.
 */
const STOPPABLE_RUN_STATUSES = new Set([
  'queued',
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'retrying',
]);

function runIsStoppable(db: Db, runId: string, status: string): boolean {
  if (!STOPPABLE_RUN_STATUSES.has(status)) return false;
  return status !== 'queued' || runCancellationOwner(db, runId) === null;
}

export function localMachine(db: Db): Row {
  const id = (
    db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as
      { value: string } | undefined
  )?.value;
  if (!id) throw new Error('Local machine registration is missing.');
  return db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as Row;
}

export function toProject(row: Row): ProjectProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    gitRoot: nullable(row.git_root),
    branch: nullable(row.branch),
    dirty: row.dirty === null ? null : Boolean(row.dirty),
    packageManager: nullable(row.package_manager),
    languages: parseJson<string[]>(row.languages_json, []),
    frameworks: parseJson<string[]>(row.frameworks_json, []),
    buildCommand: parseNullableJson<string[]>(row.build_command_json),
    testCommand: parseNullableJson<string[]>(row.test_command_json),
    lintCommand: parseNullableJson<string[]>(row.lint_command_json),
    readmePath: nullable(row.readme_path),
    instructionFiles: parseJson<string[]>(row.instruction_files_json, []),
    machineId: String(row.machine_id),
    createdAt: String(row.created_at),
  };
}

export function toWorkflow(row: Row): WorkflowDefinition {
  const config = parseJson<Record<string, unknown>>(row.config_json, {});
  const defaultContext: ContextPolicy = {
    strategy: 'focused',
    maxFiles: 24,
    maxEstimatedTokens: 32_000,
    maxFileBytes: 80_000,
    includeGlobs: [],
    excludeGlobs: ['.git/**', 'node_modules/**', 'dist/**', 'build/**'],
    includeCurrentDiff: true,
    includeTestOutput: true,
    includeBuildOutput: true,
    includePreviousArtifact: true,
    includePreviousTranscript: false,
    onLimitExceeded: 'compact',
  };
  const context = (config.contextPolicy ?? {}) as Partial<ContextPolicy>;
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    template: String(row.template),
    executionProfile: (config.executionProfile as WorkflowDefinition['executionProfile']) ?? 'balanced',
    permissionMode: (config.permissionMode as WorkflowDefinition['permissionMode']) ?? 'normal',
    promptRefinementDefault: Boolean(config.promptRefinementDefault),
    maxRemediationRounds: Number(config.maxRemediationRounds ?? 0),
    maxParallelAgents: Number(config.maxParallelAgents ?? 1),
    maxDurationMinutes: Number(config.maxDurationMinutes ?? 120),
    retryPolicy: {
      maxRetries: Number((config.retryPolicy as Record<string, unknown> | undefined)?.maxRetries ?? 1),
      initialDelayMs: Number(
        (config.retryPolicy as Record<string, unknown> | undefined)?.initialDelayMs ?? 1_000,
      ),
      maxDelayMs: Number((config.retryPolicy as Record<string, unknown> | undefined)?.maxDelayMs ?? 30_000),
    },
    isolatedWorktree: Boolean(config.isolatedWorktree),
    ...billingConfiguration(config),
    lockProviders: config.lockProviders !== false,
    defaultModelConfiguration:
      config.defaultModelConfiguration as WorkflowDefinition['defaultModelConfiguration'],
    stageDefaults: config.stageDefaults as WorkflowDefinition['stageDefaults'],
    globalInstructions: typeof config.globalInstructions === 'string' ? config.globalInstructions : undefined,
    contextPolicy: { ...defaultContext, ...context },
    stages: Array.isArray(config.stages) ? (config.stages as WorkflowDefinition['stages']) : [],
    version: Number(row.version),
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function billingConfiguration(config: Record<string, unknown>) {
  const billingMode = resolveBillingMode({
    billingMode: BILLING_MODES.includes(config.billingMode as BillingMode)
      ? (config.billingMode as BillingMode)
      : undefined,
    subscriptionOnly: typeof config.subscriptionOnly === 'boolean' ? config.subscriptionOnly : undefined,
  });
  const budget = (config.meteredBudget ?? {}) as Partial<WorkflowDefinition['meteredBudget']>;
  const policy = config.externalDecisionDataPolicy;
  return {
    billingMode,
    subscriptionOnly: billingMode !== 'custom',
    ...(Array.isArray(config.customAllowedLanes)
      ? { customAllowedLanes: config.customAllowedLanes as BillingLane[] }
      : {}),
    meteredBudget: {
      perRunUsd: typeof budget.perRunUsd === 'number' && budget.perRunUsd >= 0 ? budget.perRunUsd : null,
      unknownCostPolicy: (['block', 'ask', 'allow-with-warning'] as const).includes(
        budget.unknownCostPolicy as 'block',
      )
        ? (budget.unknownCostPolicy as WorkflowDefinition['meteredBudget']['unknownCostPolicy'])
        : 'block',
    },
    externalDecisionDataPolicy: (['allow', 'ask-first', 'block'] as const).includes(policy as 'allow')
      ? (policy as WorkflowDefinition['externalDecisionDataPolicy'])
      : 'ask-first',
  };
}

export function toConnectionProfile(row: Row): ConnectionProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    backendId: String(row.backend_id),
    providerId: String(row.provider_id),
    billingLane: String(row.billing_lane) as ConnectionProfile['billingLane'],
    credentialStoreRef: nullable(row.credential_store_ref),
    metadata: parseJson<Record<string, string | number | boolean | null>>(row.metadata_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toModelPreset(row: Row): ModelPreset {
  return {
    id: String(row.id),
    name: String(row.name),
    configuration: parseJson<ModelPreset['configuration']>(row.configuration_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toStage(row: Row, attempts: StageAttempt[] = []): RunStage {
  const input = parseJson<Record<string, unknown>>(row.input_json, {});
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageKey: String(row.stage_key),
    kind: String(row.kind) as RunStage['kind'],
    title: String(row.title),
    sequence: Number(row.sequence),
    backendId: nullable(row.backend_id),
    providerId: nullable(row.provider_id),
    modelId: nullable(row.model_id),
    connectionProfileId: nullable(row.connection_profile_id),
    billingLane: nullable(row.billing_lane) as RunStage['billingLane'],
    variantId: nullable(row.variant_id),
    modelSnapshot: parseNullableJson<NonNullable<RunStage['modelSnapshot']>>(row.model_snapshot_json),
    reasoning: typeof input.reasoning === 'string' ? input.reasoning : null,
    nativeSettings:
      input.nativeSettings && typeof input.nativeSettings === 'object'
        ? (input.nativeSettings as Record<string, string | number | boolean | null>)
        : {},
    status: String(row.status) as RunStage['status'],
    startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at),
    output: parseNullableJson<Record<string, unknown>>(row.output_json),
    error: nullable(row.error),
    logs: String(row.logs ?? ''),
    attempts,
  };
}

export function toRun(db: Db, row: Row): RunSummary {
  const stages = db.prepare('SELECT * FROM stages WHERE run_id = ? ORDER BY sequence').all(row.id) as Row[];
  const snapshot = parseJson<Record<string, unknown>>(row.workflow_snapshot_json, {});
  const maxDurationMinutes = Number(snapshot.maxDurationMinutes ?? 120);
  const startedAt = nullable(row.started_at);
  const completedAt = nullable(row.completed_at);
  const elapsedMs = startedAt
    ? Math.max(0, Date.parse(completedAt ?? new Date().toISOString()) - Date.parse(startedAt))
    : 0;
  const remainingMs = Number.isFinite(maxDurationMinutes)
    ? Math.max(0, maxDurationMinutes * 60_000 - elapsedMs)
    : null;
  return {
    id: String(row.id),
    machineId: String(row.machine_id),
    projectId: String(row.project_id),
    projectName: String(row.project_name ?? ''),
    workflowId: String(row.workflow_id),
    workflowName: String(row.workflow_name ?? ''),
    prompt: String(row.prompt),
    profile: String(row.profile) as RunSummary['profile'],
    permissionMode: String(row.permission_mode) as RunSummary['permissionMode'],
    refinePrompt: Boolean(row.refinement_requested),
    subscriptionOnly: snapshot.subscriptionOnly !== false,
    billingMode: resolveBillingMode({
      billingMode: BILLING_MODES.includes(snapshot.billingMode as BillingMode)
        ? (snapshot.billingMode as BillingMode)
        : undefined,
      subscriptionOnly:
        typeof snapshot.subscriptionOnly === 'boolean' ? snapshot.subscriptionOnly : undefined,
    }),
    lockProviders: snapshot.lockProviders !== false,
    status: String(row.status) as RunSummary['status'],
    branch: nullable(row.branch),
    worktreePath: nullable(row.worktree_path),
    summary: nullable(row.summary),
    createdAt: String(row.created_at),
    startedAt: nullable(row.started_at),
    completedAt: nullable(row.completed_at),
    stages: stages.map((stage) => {
      const attempts = db
        .prepare('SELECT * FROM stage_attempts WHERE stage_id = ? ORDER BY reviewer_index, attempt')
        .all(stage.id) as Row[];
      return toStage(stage, attempts.map(toStageAttempt));
    }),
    elapsedMs,
    remainingMs: ['completed', 'failed', 'cancelled'].includes(String(row.status)) ? null : remainingMs,
    cancellable: runIsStoppable(db, String(row.id), String(row.status)),
  };
}

function toStageAttempt(row: Row): StageAttempt {
  return {
    id: String(row.id),
    attempt: Number(row.attempt),
    reviewerIndex: row.reviewer_index === null ? null : Number(row.reviewer_index),
    status: String(row.status) as StageAttempt['status'],
    category: nullable(row.category),
    error: nullable(row.error),
    startedAt: String(row.started_at),
    finishedAt: nullable(row.finished_at),
  };
}

export function toApproval(row: Row): Approval {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: nullable(row.stage_id),
    operation: String(row.operation),
    reason: String(row.reason),
    risk: String(row.risk) as Approval['risk'],
    status: String(row.status) as Approval['status'],
    createdAt: String(row.created_at),
    respondedAt: nullable(row.responded_at),
  };
}

export function getRunRow(db: Db, id: string): Row | undefined {
  return db
    .prepare(
      `SELECT r.*, p.name AS project_name, w.name AS workflow_name
    FROM runs r JOIN projects p ON p.id = r.project_id JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?`,
    )
    .get(id) as Row | undefined;
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function parseNullableJson<T>(value: unknown): T | null {
  return typeof value === 'string' ? parseJson<T | null>(value, null) : null;
}
