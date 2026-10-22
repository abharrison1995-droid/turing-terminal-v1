import type {
  GoalApprovalStatus,
  GoalDefinition,
  GoalFindingStatus,
  GoalStatus,
  NextTask,
} from '../../shared/goals.js';
import { TERMINAL_RUN_STATUSES } from '../../shared/goals.js';
import type {
  GoalApprovalView,
  GoalChildRunBrief,
  GoalCompletionView,
  GoalCycleBrief,
  GoalCycleView,
  GoalCyclesResponse,
  GoalDashboardApprovals,
  GoalDashboardSummary,
  GoalDefinitionFull,
  GoalDefinitionSummary,
  GoalDetail,
  GoalEventsResponse,
  GoalEvidenceResponse,
  GoalEvidenceView,
  GoalFindingView,
  GoalFindingsResponse,
  GoalListItem,
  GoalListResponse,
  GoalMilestoneView,
  GoalNextAction,
  GoalReviewView,
  GoalReviewsResponse,
  GoalRouteResolutionSummary,
  GoalRunBrief,
  GoalUsageSummary,
  UnifiedApproval,
  UnifiedApprovalsResponse,
} from '../../shared/goalApi.js';
import type { Db } from '../db.js';
import { toWorkflow } from '../serialize.js';
import {
  bindExactGate,
  getGoalApproval,
  isDedicatedCompletionApproval,
  isDedicatedCorrectionApproval,
  isPendingFinalAcceptanceRow,
  pendingGoalApprovals,
  type DedicatedApprovalSubject,
} from './approvals.js';
import { activeCycle, listCycles, type CycleRow } from './cycles.js';
import { loadDefinitionVersion, validateStoredDefinition } from './definitions.js';
import type { GoalDefinitionVersion } from '../../shared/goals.js';
import type { WorkflowContext } from './definitionValidation.js';
import { verifyAmendmentResolution } from './amendmentAuthority.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { goalMeteredSpendUsd } from './bounds.js';
import { assessEvidence, type EvidenceRow } from './freshness.js';
import { listGoalFindings, openFindingCounts } from './findings.js';
import { listReviews } from './reviews.js';
import { createRepositoryReader, resolveGoalRepository, type RepositoryReader } from './repository.js';
import { readRemediationPlan } from './remediationPlan.js';
import { readReviewPlan } from './reviewPlan.js';
import { readStoredResolutions } from './routeResolution.js';
import type { RoleResolution } from './routeAudit.js';
import { findVerifier, normalizeVerifierDigests } from './verifierDigest.js';

/**
 * Goal read models: bounded, JSON-safe projections of canonical Goal rows. Nothing here writes, calls a provider or
 * model, refreshes a provider, or touches a user's checkout; repository reads go to Git objects at the Goal head only.
 */
export type GoalReadErrorCode = 'goal_not_found' | 'definition_not_found' | 'invalid_filter';

export class GoalReadError extends Error {
  constructor(
    readonly code: GoalReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalReadError';
  }
}

export const READ_LIMITS = {
  goals: { default: 50, max: 100 },
  cycles: { default: 50, max: 100 },
  evidence: { default: 100, max: 200 },
  reviews: { default: 50, max: 100 },
  findings: { default: 100, max: 200 },
  events: { default: 100, max: 200 },
  approvals: { default: 100, max: 200 },
} as const;

export function clampLimit(raw: number | undefined, bounds: { default: number; max: number }): number {
  if (raw === undefined || !Number.isFinite(raw)) return bounds.default;
  return Math.min(bounds.max, Math.max(1, Math.floor(raw)));
}

const ACTIVE_RUN = new Set([
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'retrying',
  'cancelling',
]);
const PAUSED_RUN = new Set(['paused', 'paused_limit_reached']);
const TERMINAL_RUN = TERMINAL_RUN_STATUSES;
const MAX_DETAIL_CHARS = 4_000;
const MAX_TEXT = 500;

const ATTENTION_STATUSES: readonly GoalStatus[] = ['needs_user', 'blocked'];
const NON_TERMINAL: readonly GoalStatus[] = [
  'ready',
  'running',
  'reviewing',
  'needs_user',
  'blocked',
  'paused',
];

const text = (value: unknown, max = MAX_TEXT): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null;

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function boundedObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > MAX_DETAIL_CHARS) return null;
  const value = parseJson(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Contextual validation needs the registered workflows; one that cannot be read is simply absent from the context. */
export function workflowContexts(db: Db): WorkflowContext[] {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY id').all() as Array<Record<string, unknown>>;
  const out: WorkflowContext[] = [];
  for (const row of rows) {
    try {
      const workflow = toWorkflow(row);
      out.push({
        id: workflow.id,
        billingMode: workflow.billingMode,
        isolatedWorktree: workflow.isolatedWorktree,
        maxParallelAgents: workflow.maxParallelAgents,
        permissionMode: workflow.permissionMode,
        stages: workflow.stages.map((stage) => ({ kind: stage.kind })),
      });
    } catch {
      continue;
    }
  }
  return out;
}

// --- Definitions --------------------------------------------------------------------------------------------------

function definitionSummary(version: GoalDefinitionVersion): GoalDefinitionSummary {
  return {
    version: version.version,
    parentVersion: version.parentVersion,
    status: version.status,
    definitionHash: version.definitionHash,
    changeSummary: version.changeSummary,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
    approvedAt: version.approvedAt,
    approvedBy: version.approvedBy,
    approvalId: version.approvalId,
  };
}

export function listDefinitionSummaries(db: Db, goalId: string): GoalDefinitionSummary[] {
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
    throw new GoalReadError('goal_not_found', 'The Goal does not exist.');
  const versions = (
    db
      .prepare('SELECT version FROM goal_definition_versions WHERE goal_id = ? ORDER BY version')
      .all(goalId) as Array<{ version: number }>
  ).map((row) => loadDefinitionVersion(db, goalId, row.version)!);
  return versions.map(definitionSummary);
}

export function getDefinitionFull(
  db: Db,
  goalId: string,
  version: number,
  workflows: readonly WorkflowContext[],
): GoalDefinitionFull {
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
    throw new GoalReadError('goal_not_found', 'The Goal does not exist.');
  const stored = loadDefinitionVersion(db, goalId, version);
  if (!stored) throw new GoalReadError('definition_not_found', 'No such definition version.');
  const validation = validateStoredDefinition(db, goalId, version, workflows);
  const issue = (entry: { severity: 'error' | 'warning'; path: string; code: string; message: string }) => ({
    severity: entry.severity,
    path: entry.path,
    code: entry.code,
    message: entry.message,
  });
  return {
    ...definitionSummary(stored),
    goalId,
    definition: stored.definition,
    validation: {
      valid: validation.valid,
      errors: validation.errors.map(issue),
      warnings: validation.warnings.map(issue),
    },
  };
}

// --- Shared pieces -------------------------------------------------------------------------------------------------

interface GoalRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  status: GoalStatus;
  status_reason_code: string | null;
  status_detail_json: string | null;
  current_definition_version: number | null;
  active_milestone_id: string | null;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

const GOAL_SELECT = `SELECT g.*, p.name AS project_name FROM goals g JOIN projects p ON p.id = g.project_id`;

function goalRow(db: Db, goalId: string): GoalRow {
  const row = db.prepare(`${GOAL_SELECT} WHERE g.id = ?`).get(goalId) as GoalRow | undefined;
  if (!row) throw new GoalReadError('goal_not_found', 'The Goal does not exist.');
  return row;
}

interface RuntimeRow {
  cycles_executed: number;
  consecutive_failed_cycles: number;
  remediation_attempts_json: string;
  active_ms: number;
  base_branch: string | null;
  base_commit: string | null;
  goal_branch: string | null;
  integration_head: string | null;
  memory_json: string;
}

function runtimeRow(db: Db, goalId: string): RuntimeRow | undefined {
  return db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(goalId) as RuntimeRow | undefined;
}

export function usageSummary(db: Db, goalId: string): GoalUsageSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS events, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens
       FROM usage_events u WHERE u.run_id IN (SELECT run_id FROM goal_runs WHERE goal_id = ?)`,
    )
    .get(goalId) as { events: number; input_tokens: number | null; output_tokens: number | null };
  return {
    events: row.events,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    meteredSpendUsd: goalMeteredSpendUsd(db, goalId),
  };
}

function cycleBrief(cycle: CycleRow): GoalCycleBrief {
  return {
    id: cycle.id,
    sequence: cycle.sequence,
    kind: cycle.kind,
    status: cycle.status,
    triggerCode: cycle.triggerCode,
    finishedAt: cycle.finishedAt,
  };
}

function approvalView(approval: NonNullable<ReturnType<typeof getGoalApproval>>): GoalApprovalView {
  const detailJson = JSON.stringify(approval.detail);
  return {
    id: approval.id,
    goalId: approval.goalId,
    gate: approval.gate,
    risk: approval.risk,
    reason: approval.reason,
    requestedBy: approval.requestedBy,
    status: approval.status,
    decidedBy: approval.decidedBy,
    decisionNote: approval.decisionNote,
    createdAt: approval.createdAt,
    respondedAt: approval.respondedAt,
    detail: detailJson.length <= MAX_DETAIL_CHARS ? approval.detail : {},
  };
}

/**
 * A pending Goal approval is live user work only while its Goal is not terminal. A pending row under a completed or
 * abandoned Goal (legacy data from before abandonment settled them) stays in the table as history but is never
 * presented as something awaiting a decision.
 */
const LIVE_PENDING = `a.status = 'pending' AND a.goal_id IN (SELECT id FROM goals WHERE status NOT IN ('completed','abandoned'))`;

const MANUAL_CODES_FOR_GATE = 'gate_pending';

/**
 * True when the Goal's persisted state requires manual reconciliation: a manual-only reason code, or a
 * `needs_user(gate_pending)` status detail that does not bind exactly to a real approval of this Goal. Pure read of
 * persisted rows (the same facts `deriveNextAction` uses); it never guesses another approval.
 */
export function isManualReconciliation(db: Db, goalId: string): boolean {
  const row = db
    .prepare('SELECT status, status_reason_code, status_detail_json FROM goals WHERE id = ?')
    .get(goalId) as
    { status: GoalStatus; status_reason_code: string | null; status_detail_json: string | null } | undefined;
  if (!row) return false;
  const code = row.status_reason_code ?? '';
  if (row.status === 'blocked' || row.status === 'needs_user') {
    if (MANUAL.has(code)) return true;
    if (row.status === 'needs_user' && code === MANUAL_CODES_FOR_GATE)
      return !bindExactGate(db, goalId, {
        status: 'needs_user',
        reasonCode: 'gate_pending',
        detail: boundedObject(row.status_detail_json),
      }).ok;
  }
  return false;
}

export function pendingApprovalViews(db: Db, goalId: string): GoalApprovalView[] {
  const rows = db
    .prepare(
      `SELECT a.id FROM goal_approvals a WHERE a.goal_id = ? AND ${LIVE_PENDING} ORDER BY a.created_at, a.rowid LIMIT 50`,
    )
    .all(goalId) as Array<{ id: string }>;
  return rows.map((row) => approvalView(getGoalApproval(db, row.id)!));
}

function milestoneRuntime(db: Db, goalId: string, milestoneId: string | null) {
  if (!milestoneId) return null;
  return (
    (db
      .prepare('SELECT milestone_key AS key, status FROM goal_milestones WHERE id = ? AND goal_id = ?')
      .get(milestoneId, goalId) as { key: string; status: string } | undefined) ?? null
  );
}

function currentDefinitionOf(db: Db, goal: GoalRow): GoalDefinitionVersion | undefined {
  return goal.current_definition_version === null
    ? undefined
    : loadDefinitionVersion(db, goal.id, goal.current_definition_version);
}

function proposedVersion(db: Db, goalId: string): number | null {
  const row = db
    .prepare(
      "SELECT version FROM goal_definition_versions WHERE goal_id = ? AND status = 'proposed' ORDER BY version DESC LIMIT 1",
    )
    .get(goalId) as { version: number } | undefined;
  return row?.version ?? null;
}

function childRunOf(db: Db, cycle: CycleRow | undefined): GoalChildRunBrief | null {
  if (!cycle) return null;
  const runs = db
    .prepare(
      'SELECT id, goal_run_purpose AS purpose, status FROM runs WHERE goal_cycle_id = ? ORDER BY created_at DESC, rowid DESC',
    )
    .all(cycle.id) as GoalChildRunBrief[];
  return runs.find((run) => !TERMINAL_RUN.has(run.status)) ?? null;
}

const classifyRun = (run: GoalChildRunBrief | null): 'none' | 'queued' | 'active' | 'paused' =>
  !run
    ? 'none'
    : run.status === 'queued'
      ? 'queued'
      : PAUSED_RUN.has(run.status)
        ? 'paused'
        : ACTIVE_RUN.has(run.status)
          ? 'active'
          : 'none';

/** Work could be launched (or is under way) but no validated task is persisted yet, so a proposal is still required. */
export function proposalRequired(status: GoalStatus, cycle: CycleRow | undefined): boolean {
  if (!['ready', 'running', 'reviewing', 'paused', 'needs_user'].includes(status)) return false;
  if (!cycle) return status === 'running' || status === 'ready';
  return ['execution', 'remediation'].includes(cycle.kind) && cycle.validatedTask === null;
}

// --- nextAction ----------------------------------------------------------------------------------------------------

const MANUAL = new Set(['goal_ref_changed', 'goal_ref_missing', 'git_state_invalid', 'base_diverged']);
const REVISE = new Set([
  'bound_cycles',
  'bound_failures',
  'bound_remediation',
  'bound_active_time',
  'bound_wall_clock',
  'bound_spend',
]);

/**
 * A pure, deterministic projection of what the user can do next. It reads persisted facts only and has no authority:
 * every action it names is still an explicit, separately validated user request.
 */
const TERMINAL_USER_FAILURES = new Set([
  'final_acceptance_missing',
  'final_apply_required',
  'external_completion_not_activated',
]);

/** The terminal completion actions: only meaningful when every remaining failure is a user action. */
function terminalUserAction(
  db: Db,
  goalId: string,
  completion: GoalCompletionView | null | undefined,
): GoalNextAction | null {
  if (!completion || completion.ok || completion.failures.length === 0) return null;
  if (!completion.failures.every((failure) => TERMINAL_USER_FAILURES.has(failure.code))) return null;
  if (completion.failures.some((failure) => failure.code === 'final_acceptance_missing')) {
    const match = pendingGoalApprovals(db, goalId).find(
      (approval) =>
        approval.gate === 'final_acceptance' &&
        approval.detail.definitionVersion === completion.definitionVersion &&
        approval.detail.definitionHash === completion.definitionHash &&
        approval.detail.integrationTree === completion.integrationTree,
    );
    return { kind: 'final_acceptance', approvalId: match?.id ?? null };
  }
  // A v2 Goal is intentionally blocked until its later completion stage. Never project that refusal as an
  // instruction to run the legacy final-apply workflow.
  if (completion.failures.some((failure) => failure.code === 'external_completion_not_activated'))
    return null;
  return { kind: 'final_apply' };
}

/**
 * `needs_user(gate_pending)`: the action for the exact approval the status names. A status detail that does not bind
 * to a real approval of this Goal with the same gate is corrupt: it is never guessed from other pending approvals.
 */
function exactGateAction(db: Db, goalId: string, detail: Record<string, unknown> | null): GoalNextAction {
  const bound = bindExactGate(db, goalId, { status: 'needs_user', reasonCode: 'gate_pending', detail });
  if (!bound.ok) return { kind: 'manual_reconciliation' };
  const approval = bound.approval;
  if (approval.status === 'pending') return { kind: 'review_approval', approvalId: approval.id };
  if (approval.status === 'approved' || approval.gate === 'pool_route_first_use') return { kind: 'resume' };
  // A denied gate is terminal: the Goal stays with the user, who revises it (or abandons it). Until the supervisor has
  // settled the denial (cancelled the gate's cycle) the revision would be refused, so Turing still has one action.
  return activeCycle(db, goalId) ? { kind: 'wait_for_turing' } : { kind: 'revise_goal' };
}

/**
 * The amendment outcomes the persisted history proves for the Goal's current quiescent episode, using the very same
 * proof the supervisor applies to a resume claim. Read-only and deterministic: the client offers exactly these resume
 * reasons (normally one) and never infers one from a button it clicked.
 */
function amendmentResolutions(db: Db, goalId: string): Array<'amendment_approved' | 'amendment_discarded'> {
  const reasons: Array<'amendment_approved' | 'amendment_discarded'> = [];
  if (verifyAmendmentResolution(db, goalId, 'amendment_approved').ok) reasons.push('amendment_approved');
  if (verifyAmendmentResolution(db, goalId, 'amendment_discarded').ok) reasons.push('amendment_discarded');
  return reasons;
}

export function deriveNextAction(
  db: Db,
  goalId: string,
  goal: { status: GoalStatus; reasonCode: string | null; detail: Record<string, unknown> | null },
  completion?: GoalCompletionView | null,
): GoalNextAction {
  const proposed = proposedVersion(db, goalId);
  const pending = pendingApprovalViews(db, goalId);
  const firstApproval = pending[0];
  switch (goal.status) {
    case 'draft':
      return proposed !== null
        ? { kind: 'approve_definition', version: proposed }
        : { kind: 'author_definition' };
    case 'ready':
      return proposed !== null ? { kind: 'approve_definition', version: proposed } : { kind: 'start' };
    case 'running':
    case 'reviewing': {
      // Terminal user actions precede "wait": when the only completion failures are the user's, Turing has finished.
      const terminal = terminalUserAction(db, goalId, completion);
      return terminal ?? { kind: 'wait_for_turing' };
    }
    case 'paused':
      return { kind: 'resume' };
    case 'completed':
      return { kind: 'completed' };
    case 'abandoned':
      return { kind: 'abandoned' };
    case 'blocked': {
      const code = goal.reasonCode ?? 'blocked';
      if (MANUAL.has(code)) return { kind: 'manual_reconciliation' };
      if (REVISE.has(code)) return { kind: 'revise_goal' };
      return { kind: 'resolve_blocker', reasonCode: code };
    }
    case 'needs_user': {
      const code = goal.reasonCode ?? 'needs_user';
      // The exact gate the status names, never "the first pending approval"; malformed state fails closed.
      if (code === 'gate_pending') return exactGateAction(db, goalId, goal.detail);
      if (code === 'run_interrupted') {
        const cycle = activeCycle(db, goalId);
        const paused = cycle
          ? (db
              .prepare(
                "SELECT id FROM runs WHERE goal_cycle_id = ? AND status IN ('paused','paused_limit_reached') ORDER BY created_at DESC LIMIT 1",
              )
              .get(cycle.id) as { id: string } | undefined)
          : undefined;
        return paused ? { kind: 'resume_run', runId: paused.id } : { kind: 'resume' };
      }
      if (code === 'amendment_in_progress')
        return proposed !== null
          ? { kind: 'approve_definition', version: proposed }
          : { kind: 'resume_after_amendment', resolved: amendmentResolutions(db, goalId) };
      if (MANUAL.has(code)) return { kind: 'manual_reconciliation' };
      if (['user_confirmation_pending', 'review_needs_decision'].includes(code) && firstApproval)
        return { kind: 'review_approval', approvalId: firstApproval.id };
      if (code !== 'gate_pending') {
        const terminal = terminalUserAction(db, goalId, completion);
        if (terminal) return terminal;
      }
      if (firstApproval) return { kind: 'review_approval', approvalId: firstApproval.id };
      return { kind: 'resolve_blocker', reasonCode: code };
    }
  }
}

// --- List ----------------------------------------------------------------------------------------------------------

function listItem(
  db: Db,
  row: GoalRow,
  pendingCount: number,
  completion?: GoalCompletionView | null,
): GoalListItem {
  const runtime = runtimeRow(db, row.id);
  const definition = currentDefinitionOf(db, row);
  const milestone = milestoneRuntime(db, row.id, row.active_milestone_id);
  const title = milestone
    ? (definition?.definition.milestones.find((spec) => spec.key === milestone.key)?.title ?? milestone.key)
    : null;
  const cycles = db
    .prepare(
      `SELECT c.*, m.milestone_key FROM goal_cycles c LEFT JOIN goal_milestones m ON m.id = c.milestone_id
       WHERE c.goal_id = ? ORDER BY c.sequence DESC LIMIT 1`,
    )
    .get(row.id) as
    | {
        id: string;
        sequence: number;
        kind: GoalCycleBrief['kind'];
        status: string;
        trigger_code: string;
        finished_at: string | null;
      }
    | undefined;
  const detail = boundedObject(row.status_detail_json);
  const attention: GoalListItem['attention'] = [];
  if (row.status === 'needs_user') attention.push('status_needs_user');
  if (row.status === 'blocked') attention.push('status_blocked');
  if (pendingCount > 0) attention.push('pending_goal_approval');
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    status: row.status,
    reasonCode: row.status_reason_code,
    reasonDetail: detail,
    needsUser: attention.length > 0,
    attention,
    paused: row.status === 'paused',
    pendingApprovalCount: pendingCount,
    currentDefinitionVersion: row.current_definition_version,
    activeMilestone: milestone
      ? { key: milestone.key, title: title ?? milestone.key, runtimeStatus: milestone.status }
      : null,
    lastCycle: cycles
      ? {
          id: cycles.id,
          sequence: cycles.sequence,
          kind: cycles.kind,
          status: cycles.status,
          triggerCode: cycles.trigger_code,
          finishedAt: cycles.finished_at,
        }
      : null,
    nextAction: deriveNextAction(
      db,
      row.id,
      { status: row.status, reasonCode: row.status_reason_code, detail },
      completion,
    ),
    integrationBranch: runtime?.goal_branch ?? null,
    integrationHead: runtime?.integration_head ?? null,
    openFindingCounts: openFindingCounts(db, row.id),
    usageSummary: usageSummary(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const pendingCounts = (db: Db): Map<string, number> =>
  new Map(
    (
      db
        .prepare(
          `SELECT a.goal_id, COUNT(*) AS n FROM goal_approvals a WHERE ${LIVE_PENDING} GROUP BY a.goal_id`,
        )
        .all() as Array<{ goal_id: string; n: number }>
    ).map((row) => [row.goal_id, row.n]),
  );

const GOAL_STATUS_SET = new Set<string>([
  'draft',
  'ready',
  'running',
  'reviewing',
  'needs_user',
  'blocked',
  'paused',
  'completed',
  'abandoned',
]);

export function listGoals(
  db: Db,
  options: { limit?: number; status?: string; projectId?: string } = {},
): GoalListResponse {
  const limit = clampLimit(options.limit, READ_LIMITS.goals);
  if (options.status !== undefined && !GOAL_STATUS_SET.has(options.status))
    throw new GoalReadError('invalid_filter', 'The status filter is not a Goal status.');
  if (options.projectId !== undefined && (!options.projectId || options.projectId.length > 200))
    throw new GoalReadError('invalid_filter', 'The project filter must be a project id.');
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    where.push('g.status = ?');
    params.push(options.status);
  }
  if (options.projectId) {
    where.push('g.project_id = ?');
    params.push(options.projectId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM goals g ${clause}`).get(...params) as { n: number }).n;
  // Deterministic: most recently updated first, id as the tie-break.
  const rows = db
    .prepare(`${GOAL_SELECT} ${clause} ORDER BY g.updated_at DESC, g.id LIMIT ?`)
    .all(...params, limit) as GoalRow[];
  const pending = pendingCounts(db);
  return { goals: rows.map((row) => listItem(db, row, pending.get(row.id) ?? 0)), total, limit };
}

// --- Detail --------------------------------------------------------------------------------------------------------

export function completionView(
  evaluation: Awaited<ReturnType<typeof evaluateCompletion>>,
): GoalCompletionView {
  return {
    ok: evaluation.ok,
    definitionVersion: evaluation.definitionVersion,
    definitionHash: evaluation.definitionHash,
    integrationHead: evaluation.integrationHead,
    integrationTree: evaluation.integrationTree,
    failures: evaluation.failures,
    finalReview: {
      required: evaluation.finalReview.required,
      ok: evaluation.finalReview.ok,
      reason: evaluation.finalReview.reason,
    },
    finalAcceptance: {
      required: evaluation.finalAcceptance.required,
      ok: evaluation.finalAcceptance.ok,
      approvalId: evaluation.finalAcceptance.approvalId,
      reason: evaluation.finalAcceptance.reason,
    },
    finalApply: {
      required: evaluation.finalApply.required,
      ok: evaluation.finalApply.ok,
      basis: evaluation.finalApply.basis,
      reason: evaluation.finalApply.reason,
    },
  };
}

/** A fresh evaluation at the Goal head, or null when the Goal has none to evaluate. Never throws for a Git problem. */
export async function evaluateForRead(db: Db, goalId: string) {
  const goal = db.prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?').get(goalId) as
    { v: number | null } | undefined;
  if (!goal || goal.v === null || !runtimeRow(db, goalId)?.integration_head) return null;
  try {
    return await evaluateCompletion(db, goalId);
  } catch {
    return null;
  }
}

export async function getGoalDetail(
  db: Db,
  goalId: string,
  workflows: readonly WorkflowContext[],
): Promise<GoalDetail> {
  const row = goalRow(db, goalId);
  const runtime = runtimeRow(db, goalId);
  const evaluation = await evaluateForRead(db, goalId);
  const completion = evaluation ? completionView(evaluation) : null;
  const pending = pendingCounts(db).get(goalId) ?? 0;
  const base = listItem(db, row, pending, completion);
  const current = currentDefinitionOf(db, row);
  const proposed = proposedVersion(db, goalId);
  const cycle = activeCycle(db, goalId);
  const childRun = childRunOf(db, cycle);
  const evaluations = new Map((evaluation?.milestones ?? []).map((item) => [item.key, item]));
  const milestoneRows = db
    .prepare(
      'SELECT milestone_key AS key, ordinal, status, satisfied_at FROM goal_milestones WHERE goal_id = ? ORDER BY ordinal',
    )
    .all(goalId) as Array<{ key: string; ordinal: number; status: string; satisfied_at: string | null }>;
  const milestones: GoalMilestoneView[] = milestoneRows.map((entry) => {
    const evaluated = evaluations.get(entry.key);
    return {
      key: entry.key,
      title: current?.definition.milestones.find((spec) => spec.key === entry.key)?.title ?? entry.key,
      ordinal: entry.ordinal,
      runtimeStatus: entry.status,
      satisfiedAt: entry.satisfied_at,
      evaluation: evaluated ? { state: evaluated.state, blockers: [...evaluated.blockers] } : null,
    };
  });
  const memory = parseJson(runtime?.memory_json);
  const hasMemory = memory && typeof memory === 'object' && Object.keys(memory as object).length > 0;
  return {
    ...base,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    baseBranch: runtime?.base_branch ?? null,
    baseCommit: runtime?.base_commit ?? null,
    runtime: {
      cyclesExecuted: runtime?.cycles_executed ?? 0,
      consecutiveFailedCycles: runtime?.consecutive_failed_cycles ?? 0,
      remediationAttempts: (parseJson(runtime?.remediation_attempts_json) ?? {}) as Record<string, number>,
      activeMs: runtime?.active_ms ?? 0,
    },
    currentDefinition: current ? getDefinitionFull(db, goalId, current.version, workflows) : null,
    proposedDefinition: proposed !== null ? getDefinitionFull(db, goalId, proposed, workflows) : null,
    definitions: listDefinitionSummaries(db, goalId),
    milestones,
    activeCycle: cycle
      ? { ...cycleBrief(cycle), milestoneKey: cycle.milestoneKey, createdAt: cycle.createdAt }
      : null,
    childRun,
    memory: hasMemory ? memory : null,
    pendingApprovals: pendingApprovalViews(db, goalId),
    completion,
    flags: {
      cycleActive: !!cycle,
      childRun: classifyRun(childRun),
      proposalRequired: proposalRequired(row.status, cycle),
      userNeeded: base.needsUser,
    },
  };
}

// --- Cycles --------------------------------------------------------------------------------------------------------

export function summariseResolution(resolution: RoleResolution): GoalRouteResolutionSummary {
  return {
    role: resolution.role,
    routeKind: resolution.routeKind,
    poolId: resolution.poolId,
    identityHash: resolution.selected.identityHash,
    backendId: resolution.selected.configuration.backendId ?? null,
    providerId: resolution.selected.configuration.providerId ?? null,
    modelId: resolution.selected.configuration.modelId ?? null,
    approvalState: resolution.approval.state,
  };
}

export const taskView = (task: NextTask | null): GoalCycleView['validatedTask'] =>
  task
    ? {
        milestoneKey: task.milestoneKey,
        title: task.title.slice(0, 200),
        targetCriteria: task.targetCriteria.slice(0, 50),
        expectedPaths: task.expectedPaths.slice(0, 50),
        workflowId: task.workflowId ?? null,
      }
    : null;

export function routeSummaries(rawResolutionJson: string | null): GoalRouteResolutionSummary[] {
  return Object.values(readStoredResolutions(rawResolutionJson))
    .filter((resolution): resolution is RoleResolution => !!resolution)
    .map(summariseResolution);
}

function outcomeView(outcome: CycleRow['outcome']): GoalCycleView['outcome'] {
  if (!outcome) return null;
  const files = Array.isArray(outcome.changedFiles)
    ? (outcome.changedFiles as unknown[])
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 50)
    : [];
  return { code: text(outcome.code, 100), summary: text(outcome.summary), changedFiles: files };
}

export function getGoalCycles(db: Db, goalId: string, options: { limit?: number } = {}): GoalCyclesResponse {
  goalRow(db, goalId);
  const limit = clampLimit(options.limit, READ_LIMITS.cycles);
  const all = listCycles(db, goalId);
  const slice = all.slice(-limit).reverse();
  const resolutions = new Map(
    (
      db.prepare('SELECT id, route_resolution_json FROM goal_cycles WHERE goal_id = ?').all(goalId) as Array<{
        id: string;
        route_resolution_json: string | null;
      }>
    ).map((entry) => [entry.id, entry.route_resolution_json]),
  );
  const runStatement = db.prepare(
    'SELECT id, goal_run_purpose AS purpose, status, created_at FROM runs WHERE goal_cycle_id = ? ORDER BY created_at, rowid',
  );
  const cycles: GoalCycleView[] = slice.map((cycle) => {
    const runs: Record<string, GoalRunBrief[]> = {};
    for (const run of runStatement.all(cycle.id) as Array<{
      id: string;
      purpose: string;
      status: string;
      created_at: string;
    }>)
      (runs[run.purpose] ??= []).push({
        id: run.id,
        purpose: run.purpose,
        status: run.status,
        createdAt: run.created_at,
      });
    const review = readReviewPlan(cycle.outcome);
    const remediation = readRemediationPlan(cycle.outcome);
    const digests = normalizeVerifierDigests(cycle.outcome?.verifierDigests);
    return {
      id: cycle.id,
      sequence: cycle.sequence,
      kind: cycle.kind,
      status: cycle.status,
      triggerCode: cycle.triggerCode,
      definitionVersion: cycle.definitionVersion,
      milestoneKey: cycle.milestoneKey,
      baseIntegrationCommit: cycle.baseIntegrationCommit,
      resultIntegrationCommit: cycle.resultIntegrationCommit,
      validatedTask: taskView(cycle.validatedTask),
      routeResolutions: routeSummaries(resolutions.get(cycle.id) ?? null),
      reviewPlan: review,
      remediationPlan: remediation
        ? {
            definitionVersion: remediation.definitionVersion,
            milestoneKey: remediation.milestoneKey,
            episodes: remediation.episodes.map((episode) => ({
              findingId: episode.findingId,
              reason: episode.reason,
            })),
          }
        : null,
      verifierDigests: digests,
      outcome: outcomeView(cycle.outcome),
      runs,
      createdAt: cycle.createdAt,
      finishedAt: cycle.finishedAt,
    };
  });
  return { cycles, total: all.length, limit };
}

// --- Evidence ------------------------------------------------------------------------------------------------------

export async function getGoalEvidence(
  db: Db,
  goalId: string,
  options: { limit?: number; criterionKey?: string } = {},
): Promise<GoalEvidenceResponse> {
  const goal = goalRow(db, goalId);
  const limit = clampLimit(options.limit, READ_LIMITS.evidence);
  if (options.criterionKey !== undefined && (!options.criterionKey || options.criterionKey.length > 200))
    throw new GoalReadError('invalid_filter', 'The criterion filter must be a criterion key.');
  const clause = options.criterionKey ? 'AND criterion_key = ?' : '';
  const params = options.criterionKey ? [goalId, options.criterionKey] : [goalId];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? ${clause}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM goal_evidence WHERE goal_id = ? ${clause} ORDER BY recorded_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as EvidenceRow[];
  const definition = currentDefinitionOf(db, goal);
  const resolved = await resolveGoalRepository(db, goalId);
  let reader: RepositoryReader | null = null;
  if (resolved.ok) reader = createRepositoryReader(resolved.state);
  const evidence: GoalEvidenceView[] = [];
  for (const row of rows) {
    let freshness: 'current' | 'stale' = 'stale';
    let staleReason: string | undefined;
    const verifier = definition
      ? findVerifier(definition.definition, row.criterion_key, row.verifier_digest)
      : undefined;
    if (!reader) staleReason = 'repository_unavailable';
    else if (!verifier) staleReason = 'verifier_not_current';
    else {
      const assessment = await assessEvidence(db, row, verifier, reader);
      if (assessment.standing === 'current') freshness = 'current';
      else staleReason = assessment.reason ?? assessment.standing;
    }
    evidence.push({
      id: row.id,
      kind: row.kind,
      criterionKey: row.criterion_key,
      verifierDigest: row.verifier_digest,
      verdict: row.verdict,
      definitionVersion: row.definition_version,
      subject: {
        commit: row.subject_commit,
        tree: row.subject_tree,
        path: row.subject_path,
        reviewedToCommit: row.reviewed_to_commit,
        reviewedToTree: row.reviewed_to_tree,
      },
      cycleId: row.cycle_id,
      runId: row.run_id,
      reviewId: row.review_id,
      recordedAt: row.recorded_at,
      freshness,
      ...(staleReason ? { staleReason } : {}),
    });
  }
  return { evidence, total, limit, integrationHead: resolved.ok ? resolved.state.head : null };
}

// --- Reviews / findings --------------------------------------------------------------------------------------------

export async function getGoalReviews(
  db: Db,
  goalId: string,
  options: { limit?: number } = {},
): Promise<GoalReviewsResponse> {
  const goal = goalRow(db, goalId);
  const limit = clampLimit(options.limit, READ_LIMITS.reviews);
  const all = listReviews(db, goalId);
  const resolved = await resolveGoalRepository(db, goalId);
  const tree = resolved.ok ? resolved.state.tree : null;
  const reviews: GoalReviewView[] = all
    .slice(-limit)
    .reverse()
    .map((review) => ({
      id: review.id,
      kind: review.reviewKind,
      status: review.status,
      cycleId: review.cycleId,
      runId: review.runId,
      definitionVersion: review.definitionVersion,
      milestoneKey: milestoneRuntime(db, goalId, review.milestoneId)?.key ?? null,
      reviewedFromCommit: review.reviewedFromCommit,
      reviewedToCommit: review.reviewedToCommit,
      reviewedToTree: review.reviewedToTree,
      verdict: review.verdict,
      blocking: review.blocking,
      independence: review.independence,
      report: review.report,
      currentAtHead:
        review.status === 'completed' &&
        tree !== null &&
        review.reviewedToTree === tree &&
        review.definitionVersion === goal.current_definition_version,
      createdAt: review.createdAt,
      completedAt: review.completedAt,
    }));
  return { reviews, total: all.length, limit };
}

const FINDING_STATUSES = new Set<string>(['open', 'resolved', 'accepted_by_user', 'dismissed_by_user']);

export function getGoalFindings(
  db: Db,
  goalId: string,
  options: { limit?: number; status?: string } = {},
): GoalFindingsResponse {
  goalRow(db, goalId);
  const limit = clampLimit(options.limit, READ_LIMITS.findings);
  if (options.status !== undefined && !FINDING_STATUSES.has(options.status))
    throw new GoalReadError('invalid_filter', 'The finding status filter is not recognised.');
  const all = listGoalFindings(db, goalId, options.status as GoalFindingStatus | undefined);
  const findings: GoalFindingView[] = all.slice(0, limit).map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    category: finding.category,
    description: finding.description,
    affectedFiles: finding.affectedFiles.slice(0, 50),
    status: finding.status,
    firstSeenReviewId: finding.firstSeenReviewId,
    lastSeenReviewId: finding.lastSeenReviewId,
    resolvedByReviewId: finding.resolvedByReviewId,
    decisionApprovalId: finding.decisionApprovalId,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
  }));
  return { findings, total: all.length, limit };
}

// --- Events --------------------------------------------------------------------------------------------------------

export function getGoalEvents(
  db: Db,
  goalId: string,
  options: { limit?: number; before?: number } = {},
): GoalEventsResponse {
  goalRow(db, goalId);
  const limit = clampLimit(options.limit, READ_LIMITS.events);
  if (options.before !== undefined && (!Number.isInteger(options.before) || options.before < 1))
    throw new GoalReadError('invalid_filter', 'before must be a positive event sequence number.');
  const rows = db
    .prepare(
      `SELECT rowid AS seq, id, type, payload_json, created_at FROM goal_events
       WHERE goal_id = ? ${options.before !== undefined ? 'AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...(options.before !== undefined ? [goalId, options.before] : [goalId]), limit + 1) as Array<{
    seq: number;
    id: string;
    type: GoalEventsResponse['events'][number]['type'];
    payload_json: string;
    created_at: string;
  }>;
  const page = rows.slice(0, limit);
  return {
    events: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      type: row.type,
      payload: parseJson(row.payload_json),
      createdAt: row.created_at,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1]!.seq : null,
    limit,
  };
}

// --- Unified approvals ---------------------------------------------------------------------------------------------

const APPROVAL_STATUS = new Set<string>(['pending', 'approved', 'denied', 'all']);

/**
 * The dedicated decision that owns this Goal approval, or undefined when the generic route decides it. A correction
 * approval is owned by the correction review at any status; a completion approval only while it is pending, since a
 * decided one is history. The generic route refuses exactly these rows (goalCommands.ts), so the inbox shows them read-only.
 */
function dedicatedDecisionOf(
  approval: DedicatedApprovalSubject & { status: string },
): 'correction' | 'completion' | undefined {
  if (isDedicatedCorrectionApproval(approval)) return 'correction';
  if (approval.status === 'pending' && isDedicatedCompletionApproval(approval)) return 'completion';
  return undefined;
}

/**
 * Reads one Goal approval for the inbox projection. A malformed stored detail (the SyntaxError JSON.parse throws in
 * toApproval) is treated as unreadable for that row only: the row fails closed to read-only and stays visible, and the
 * list does not fail. Any other error, such as a database failure, is rethrown.
 */
function readApprovalForProjection(db: Db, approvalId: string): ReturnType<typeof getGoalApproval> {
  try {
    return getGoalApproval(db, approvalId);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Whether the Goal is in manual reconciliation, for the inbox projection. bindExactGate reads the approval the Goal's
 * gate names, so a malformed stored detail on that approval makes the row read-only and fails closed; the list does not
 * fail. Any other error, such as a database failure, is rethrown.
 */
function isManualReconciliationForProjection(db: Db, goalId: string): boolean {
  try {
    return isManualReconciliation(db, goalId);
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
}

/**
 * Whether the server would accept a user decision on this Goal approval right now: pending, its Goal not terminal, not in
 * manual reconciliation, and not owned by a dedicated decision (see dedicatedDecisionOf). The decision route enforces the
 * same rules; this projection only lets a surface show the row as read-only instead of offering a refused decision. A
 * dedicated row is kept in every history: it is projected, never hidden. An unreadable approval fails closed. A pending
 * final-acceptance row projected for a remote caller additionally carries `desktopOnly: true` and is not decidable.
 */
function goalApprovalToUnified(db: Db, row: Record<string, unknown>, remoteCaller: boolean): UnifiedApproval {
  const goalId = String(row.goal_id);
  const goalStatus = (
    db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: GoalStatus } | undefined
  )?.status;
  const approval = readApprovalForProjection(db, String(row.id));
  const dedicatedDecision = approval ? dedicatedDecisionOf(approval) : undefined;
  // A pending final acceptance is a decision only the desktop may take. The row stays in every projection, but a
  // paired remote caller sees it read-only. A local caller keeps the ordinary decidable projection.
  const desktopOnly =
    remoteCaller &&
    isPendingFinalAcceptanceRow({
      gate: String(row.gate),
      status: String(row.status),
    });
  const decidable =
    approval !== undefined &&
    row.status === 'pending' &&
    goalStatus !== undefined &&
    goalStatus !== 'completed' &&
    goalStatus !== 'abandoned' &&
    !isManualReconciliationForProjection(db, goalId) &&
    dedicatedDecision === undefined &&
    !desktopOnly;
  return {
    source: 'goal',
    id: String(row.id),
    goalId: String(row.goal_id),
    title: String(row.gate),
    gate: row.gate as UnifiedApproval['gate'],
    reason: String(row.reason),
    risk: row.risk as UnifiedApproval['risk'],
    status: row.status as GoalApprovalStatus,
    requestedBy: String(row.requested_by),
    decidedBy: (row.decided_by as string | null) ?? null,
    createdAt: String(row.created_at),
    respondedAt: (row.responded_at as string | null) ?? null,
    decidable,
    ...(desktopOnly ? { desktopOnly: true } : {}),
    ...(dedicatedDecision ? { dedicatedDecision } : {}),
  };
}

export function unifiedApprovals(
  db: Db,
  options: { status?: string; goalId?: string; limit?: number; remote?: boolean } = {},
): UnifiedApprovalsResponse {
  const status = options.status ?? 'pending';
  if (!APPROVAL_STATUS.has(status))
    throw new GoalReadError('invalid_filter', 'The status filter must be pending, approved, denied or all.');
  if (options.goalId !== undefined && (!options.goalId || options.goalId.length > 200))
    throw new GoalReadError('invalid_filter', 'The Goal filter must be a Goal id.');
  const limit = clampLimit(options.limit, READ_LIMITS.approvals);
  const statusClause = status === 'all' ? '' : 'AND a.status = ?';
  const statusParams = status === 'all' ? [] : [status];
  const goalClause = options.goalId ? 'AND a.goal_id = ?' : '';
  const goalParams = options.goalId ? [options.goalId] : [];
  const goalLive = status === 'pending' ? `AND ${LIVE_PENDING}` : '';
  // A remote caller gets the same rows, but its pending final-acceptance rows are projected read-only (desktopOnly).
  const remoteCaller = options.remote === true;
  const goalRows = db
    .prepare(
      `SELECT a.* FROM goal_approvals a WHERE 1 = 1 ${statusClause} ${goalLive} ${goalClause}
       ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
    )
    .all(...statusParams, ...goalParams, limit) as Array<Record<string, unknown>>;
  const runClause = options.goalId ? 'AND a.run_id IN (SELECT run_id FROM goal_runs WHERE goal_id = ?)' : '';
  const runRows = db
    .prepare(
      `SELECT a.*, (SELECT goal_id FROM goal_runs g WHERE g.run_id = a.run_id) AS goal_id FROM approvals a
       WHERE 1 = 1 ${statusClause} ${runClause} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
    )
    .all(...statusParams, ...goalParams, limit) as Array<Record<string, unknown>>;
  const total =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM goal_approvals a WHERE 1 = 1 ${statusClause} ${goalLive} ${goalClause}`,
        )
        .get(...statusParams, ...goalParams) as { n: number }
    ).n +
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM approvals a WHERE 1 = 1 ${statusClause} ${runClause}`)
        .get(...statusParams, ...goalParams) as { n: number }
    ).n;
  const merged: UnifiedApproval[] = [
    ...goalRows.map((row) => goalApprovalToUnified(db, row, remoteCaller)),
    ...runRows.map((row): UnifiedApproval => ({
      source: 'run',
      id: String(row.id),
      runId: String(row.run_id),
      ...(row.goal_id ? { goalId: String(row.goal_id) } : {}),
      title: String(row.operation),
      reason: String(row.reason),
      risk: row.risk as UnifiedApproval['risk'],
      status: row.status as GoalApprovalStatus,
      createdAt: String(row.created_at),
      respondedAt: (row.responded_at as string | null) ?? null,
    })),
  ];
  merged.sort(
    (a, b) =>
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { approvals: merged.slice(0, limit), total, limit };
}

// --- Dashboard -----------------------------------------------------------------------------------------------------

export function dashboardGoals(
  db: Db,
  options: { remote?: boolean } = {},
): {
  goals: GoalDashboardSummary;
  goalApprovals: GoalDashboardApprovals;
} {
  const remoteCaller = options.remote === true;
  const counts = new Map(
    (
      db.prepare('SELECT status, COUNT(*) AS n FROM goals GROUP BY status').all() as Array<{
        status: string;
        n: number;
      }>
    ).map((row) => [row.status, row.n]),
  );
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const pending = pendingCounts(db);
  const rows = db
    .prepare(
      `${GOAL_SELECT} WHERE g.status IN (${NON_TERMINAL.map(() => '?').join(',')})
       ORDER BY CASE WHEN g.status IN (${ATTENTION_STATUSES.map(() => '?').join(',')}) THEN 0 ELSE 1 END,
         g.updated_at DESC, g.id LIMIT 5`,
    )
    .all(...NON_TERMINAL, ...ATTENTION_STATUSES) as GoalRow[];
  const attention = db
    .prepare(
      `SELECT COUNT(*) AS n FROM goals g WHERE g.status IN ('needs_user','blocked')
         OR EXISTS (SELECT 1 FROM goal_approvals a WHERE a.goal_id = g.id AND ${LIVE_PENDING})`,
    )
    .get() as { n: number };
  return {
    goals: {
      total,
      active: (counts.get('running') ?? 0) + (counts.get('reviewing') ?? 0),
      needsUser: attention.n,
      blocked: counts.get('blocked') ?? 0,
      paused: counts.get('paused') ?? 0,
      cards: rows.map((row) => listItem(db, row, pending.get(row.id) ?? 0)),
    },
    goalApprovals: {
      pending: (
        db.prepare(`SELECT COUNT(*) AS n FROM goal_approvals a WHERE ${LIVE_PENDING}`).get() as { n: number }
      ).n,
      // Selected as Goal approvals (not by truncating the mixed inbox), so newer run approvals cannot hide them.
      approvals: (
        db
          .prepare(
            `SELECT a.* FROM goal_approvals a WHERE ${LIVE_PENDING} ORDER BY a.created_at DESC, a.rowid DESC LIMIT 10`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((row) => goalApprovalToUnified(db, row, remoteCaller)),
    },
  };
}

export type { GoalDefinition };
