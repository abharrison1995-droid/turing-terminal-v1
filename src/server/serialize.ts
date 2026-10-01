import type { Approval, ProjectProfile, RunStage, RunSummary, WorkflowDefinition } from '../shared/types.js';
import type { Db } from './db.js';

type Row = Record<string, unknown>;

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
    isolatedWorktree: Boolean(config.isolatedWorktree),
    stages: Array.isArray(config.stages) ? (config.stages as WorkflowDefinition['stages']) : [],
    version: Number(row.version),
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toStage(row: Row): RunStage {
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
    status: String(row.status) as RunStage['status'],
    startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at),
    output: parseNullableJson<Record<string, unknown>>(row.output_json),
    error: nullable(row.error),
    logs: String(row.logs ?? ''),
  };
}

export function toRun(db: Db, row: Row): RunSummary {
  const stages = db.prepare('SELECT * FROM stages WHERE run_id = ? ORDER BY sequence').all(row.id) as Row[];
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
    status: String(row.status) as RunSummary['status'],
    branch: nullable(row.branch),
    worktreePath: nullable(row.worktree_path),
    summary: nullable(row.summary),
    createdAt: String(row.created_at),
    startedAt: nullable(row.started_at),
    completedAt: nullable(row.completed_at),
    stages: stages.map(toStage),
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
