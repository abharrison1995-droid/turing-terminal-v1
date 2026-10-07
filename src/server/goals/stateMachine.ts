import {
  GOAL_LEASE_STATUSES,
  GOAL_TERMINAL_STATUSES,
  GOAL_TRANSITIONS,
  BLOCKED_REASONS,
  GOAL_TRANSITION_REASONS,
  NEEDS_USER_REASONS,
  PAUSED_REASONS,
  type GoalActor,
  type GoalReasonCode,
  type GoalStatus,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import { checkCompletionProof } from './completionEvaluation.js';
import { writeGoalEvent } from './events.js';
import type { CompletionEvaluation } from '../../shared/goals.js';

export type GoalStateErrorCode =
  | 'goal_not_found'
  | 'terminal_state'
  | 'illegal_transition'
  | 'unknown_reason_code'
  | 'reason_not_allowed'
  | 'actor_not_allowed'
  | 'precondition_failed'
  | 'definition_not_approved'
  | 'project_lease_conflict'
  | 'completion_proof_required'
  | 'completion_proof_failed'
  | 'completion_proof_stale'
  | 'goal_work_in_flight';

export class GoalStateError extends Error {
  constructor(
    readonly code: GoalStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalStateError';
  }
}

export interface TransitionPrecondition {
  code: string;
  ok: boolean;
}

export interface TransitionRequest {
  goalId: string;
  to: GoalStatus;
  reasonCode: GoalReasonCode;
  /** Who causes the transition. There is deliberately no model actor: models cannot call this function. */
  actor: GoalActor;
  /** Bounded human-readable and structured detail; stored in status_detail_json. */
  detail?: Record<string, unknown>;
  /** Deterministic checks the caller already ran. Required codes per edge are listed below. */
  preconditions?: readonly TransitionPrecondition[];
  /**
   * Required for an edge into `completed`: the structured proof returned by `evaluateCompletion`. A raw boolean or
   * string precondition no longer substitutes for it. Re-checked here against the current definition, its stored hash
   * and the integration head.
   */
  completionProof?: CompletionEvaluation;
  now?: string;
}

export interface GoalTransitionEvent {
  db: Db;
  goalId: string;
  from: GoalStatus;
  to: GoalStatus;
}
type GoalTransitionListener = (event: GoalTransitionEvent) => void;
const listeners = new Set<GoalTransitionListener>();

/**
 * Observes committed status changes (for example to account active time when a user pauses a Goal). Listeners run
 * after the transaction commits, cannot veto or alter the transition, and a throwing listener is ignored.
 * Returns the unsubscribe function.
 */
export function onGoalTransition(listener: GoalTransitionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const ALL_REASONS: ReadonlySet<string> = new Set<string>([
  ...NEEDS_USER_REASONS,
  ...BLOCKED_REASONS,
  ...PAUSED_REASONS,
  ...GOAL_TRANSITION_REASONS,
]);

const MAX_DETAIL_CHARS = 8_000;

/** Preconditions the caller must have evaluated (and passed) for an edge into the named status. */
function requiredPreconditions(from: GoalStatus, to: GoalStatus): string[] {
  if (to === 'running' && from !== 'reviewing') return ['preflight'];
  return [];
}

export function isLegalGoalTransition(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS.some((rule) => rule.from === from && rule.to === to);
}

/**
 * The only writer of goals.status. One transaction validates the edge, reason code, actor and preconditions,
 * updates the status columns and appends the goal_events row.
 */
export function transitionGoal(db: Db, request: TransitionRequest): { from: GoalStatus; to: GoalStatus } {
  const now = request.now ?? new Date().toISOString();
  const run = db.transaction(() => {
    const goal = db
      .prepare('SELECT status, project_id, current_definition_version, started_at FROM goals WHERE id = ?')
      .get(request.goalId) as
      | {
          status: GoalStatus;
          project_id: string;
          current_definition_version: number | null;
          started_at: string | null;
        }
      | undefined;
    if (!goal) throw new GoalStateError('goal_not_found', 'The Goal does not exist.');
    const from = goal.status;
    if (GOAL_TERMINAL_STATUSES.includes(from))
      throw new GoalStateError('terminal_state', `A ${from} Goal has no outgoing transitions.`);
    const rule = GOAL_TRANSITIONS.find((candidate) => candidate.from === from && candidate.to === request.to);
    if (!rule)
      throw new GoalStateError('illegal_transition', `A Goal cannot move from ${from} to ${request.to}.`);
    if (!ALL_REASONS.has(request.reasonCode))
      throw new GoalStateError(
        'unknown_reason_code',
        `"${request.reasonCode}" is not an enumerated reason code.`,
      );
    if (!rule.reasons.includes(request.reasonCode))
      throw new GoalStateError(
        'reason_not_allowed',
        `${request.reasonCode} is not valid for ${from} -> ${request.to}.`,
      );
    if (!rule.actors.includes(request.actor))
      throw new GoalStateError(
        'actor_not_allowed',
        `${from} -> ${request.to} requires ${rule.actors.join(' or ')}.`,
      );
    for (const code of requiredPreconditions(from, request.to)) {
      const found = request.preconditions?.find((precondition) => precondition.code === code);
      if (!found?.ok)
        throw new GoalStateError('precondition_failed', `Required precondition "${code}" did not pass.`);
    }
    if (request.to === 'completed') {
      const proof = checkCompletionProof(db, request.goalId, request.completionProof);
      if (!proof.ok) throw new GoalStateError(proof.code, proof.message);
    }
    const failed = request.preconditions?.find((precondition) => !precondition.ok);
    if (failed)
      throw new GoalStateError('precondition_failed', `Precondition "${failed.code}" did not pass.`);

    if ((request.to === 'ready' || request.to === 'running') && goal.current_definition_version !== null) {
      const approved = db
        .prepare(
          "SELECT 1 FROM goal_definition_versions WHERE goal_id = ? AND version = ? AND status = 'approved'",
        )
        .get(request.goalId, goal.current_definition_version);
      if (!approved)
        throw new GoalStateError('definition_not_approved', 'The current definition is not approved.');
    } else if (request.to === 'ready' || request.to === 'running')
      throw new GoalStateError('definition_not_approved', 'The Goal has no approved definition.');

    if (GOAL_LEASE_STATUSES.includes(request.to) && !GOAL_LEASE_STATUSES.includes(from)) {
      const holder = db
        .prepare(
          `SELECT id FROM goals WHERE project_id = ? AND id <> ? AND status IN (${GOAL_LEASE_STATUSES.map(() => '?').join(',')})`,
        )
        .get(goal.project_id, request.goalId, ...GOAL_LEASE_STATUSES);
      if (holder)
        throw new GoalStateError('project_lease_conflict', 'Another Goal is active on this project.');
    }

    const detail = request.detail ? JSON.stringify(request.detail) : null;
    if (detail && detail.length > MAX_DETAIL_CHARS)
      throw new GoalStateError('precondition_failed', 'Status detail is too large.');
    try {
      db.prepare(
        `UPDATE goals SET status = ?, status_reason_code = ?, status_detail_json = ?, updated_at = ?,
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
         WHERE id = ? AND status = ?`,
      ).run(
        request.to,
        request.reasonCode,
        detail,
        now,
        request.to,
        now,
        request.to,
        now,
        request.goalId,
        from,
      );
    } catch (error) {
      if (String((error as Error).message).includes('goals.project_id'))
        throw new GoalStateError('project_lease_conflict', 'Another Goal is active on this project.');
      throw error;
    }
    writeGoalEvent(
      db,
      request.goalId,
      'state_changed',
      { from, to: request.to, reasonCode: request.reasonCode, actor: request.actor },
      now,
    );
    return { from, to: request.to };
  });
  const result = run();
  for (const listener of listeners)
    try {
      listener({ db, goalId: request.goalId, from: result.from, to: result.to });
    } catch {
      /* Observers are advisory. */
    }
  return result;
}

/** Reasons a Goal that is still a draft can carry. They describe the draft; they never change its status. */
export const DRAFT_STATUS_REASONS = ['authoring_failed'] as const;
export type DraftStatusReason = (typeof DRAFT_STATUS_REASONS)[number];

/**
 * Records (or clears, with `null`) a typed reason on a Goal that is, and stays, a draft. This is deliberately not a
 * `draft -> draft` transition: it never writes `goals.status`, emits no `state_changed` event and is refused for any
 * other status. `transitionGoal` remains the only status writer.
 */
export function setDraftStatusReason(
  db: Db,
  goalId: string,
  reason: DraftStatusReason | null,
  detail?: Record<string, unknown>,
  now = new Date().toISOString(),
): void {
  if (reason !== null && !DRAFT_STATUS_REASONS.includes(reason))
    throw new GoalStateError('unknown_reason_code', `"${reason}" is not a draft status reason.`);
  const json = detail && reason !== null ? JSON.stringify(detail) : null;
  if (json && json.length > MAX_DETAIL_CHARS)
    throw new GoalStateError('precondition_failed', 'Status detail is too large.');
  const result = db
    .prepare(
      `UPDATE goals SET status_reason_code = ?, status_detail_json = ?, updated_at = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .run(reason, json, now, goalId);
  if (result.changes === 0) {
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      throw new GoalStateError('goal_not_found', 'The Goal does not exist.');
    throw new GoalStateError('precondition_failed', 'A draft reason applies only to a draft Goal.');
  }
}
