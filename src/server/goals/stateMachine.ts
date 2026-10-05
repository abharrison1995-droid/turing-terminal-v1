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
import { writeGoalEvent } from './events.js';

export type GoalStateErrorCode =
  | 'goal_not_found'
  | 'terminal_state'
  | 'illegal_transition'
  | 'unknown_reason_code'
  | 'reason_not_allowed'
  | 'actor_not_allowed'
  | 'precondition_failed'
  | 'definition_not_approved'
  | 'project_lease_conflict';

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
  now?: string;
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
  if (to === 'completed') return ['completion_evaluated'];
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
  return run();
}
