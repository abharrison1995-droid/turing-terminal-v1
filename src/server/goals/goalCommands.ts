import type { Db } from '../db.js';
import type { FindingSeverity, GoalApprovalRisk } from '../../shared/goals.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { loadDefinitionVersion } from './definitions.js';
import { decideFinding, getGoalFinding, GoalFindingError, type GoalFinding } from './findings.js';
import { transitionGoal } from './stateMachine.js';

/**
 * Narrow, user-initiated Goal commands (Stage 7A). Each is a thin composition of the accepted domain services: status
 * only ever changes through `transitionGoal` and a finding decision only through `decideFinding`. The actor is fixed
 * here and never supplied by a caller.
 */

/**
 * running -> paused (reason `user`). It cancels nothing: a proposal run, child run, review or verification that is
 * already running may finish, and the supervisor simply does not advance a paused Goal. The active-time tracker closes
 * the interval through the committed-transition listener. Any other starting status is refused by the state machine
 * (`GoalStateError`).
 */
export function pauseGoal(db: Db, goalId: string, options: { now?: string } = {}): { status: 'paused' } {
  transitionGoal(db, {
    goalId,
    to: 'paused',
    reasonCode: 'user',
    actor: 'user',
    ...(options.now ? { now: options.now } : {}),
  });
  return { status: 'paused' };
}

/**
 * draft/ready/needs_user/blocked/paused -> abandoned (reason `user_abandoned`). There is no running/reviewing -> abandoned
 * edge, so a user first gets the Goal into a legal quiescent state. Nothing is deleted: every row stays as history.
 */
export function abandonGoal(db: Db, goalId: string, options: { now?: string } = {}): { status: 'abandoned' } {
  transitionGoal(db, {
    goalId,
    to: 'abandoned',
    reasonCode: 'user_abandoned',
    actor: 'user',
    ...(options.now ? { now: options.now } : {}),
  });
  return { status: 'abandoned' };
}

const RISK_BY_SEVERITY: Record<FindingSeverity, GoalApprovalRisk> = {
  critical: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/**
 * One explicit user action: the HTTP request itself is the user's decision. Inside ONE transaction it creates a
 * `finding_decision` Goal approval bound to the finding, the decision and the current definition (version and hash),
 * approves that exact approval as the user, and applies `decideFinding` with it. Any failure - including
 * `finding_integration_in_progress` from a planned remediation integration - rolls the whole action back, so there is
 * never an approved decision approval without the finding decision, and the caller never supplies an approval id.
 */
export function decideFindingAsUser(
  db: Db,
  input: {
    goalId: string;
    findingId: string;
    decision: 'accepted_by_user' | 'dismissed_by_user';
    note?: string;
    now?: string;
  },
): { finding: GoalFinding; approvalId: string } {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const goal = db
      .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
      .get(input.goalId) as { v: number | null } | undefined;
    if (!goal) throw new GoalFindingError('goal_not_found', 'The Goal does not exist.');
    const version = goal.v === null ? undefined : loadDefinitionVersion(db, input.goalId, goal.v);
    if (!version)
      throw new GoalFindingError('definition_not_approved', 'The Goal has no approved definition.');
    const finding = getGoalFinding(db, input.findingId);
    if (!finding || finding.goalId !== input.goalId)
      throw new GoalFindingError('finding_not_found', 'No such finding for this Goal.');
    const approval = requestGoalApproval(db, {
      goalId: input.goalId,
      gate: 'finding_decision',
      risk: RISK_BY_SEVERITY[finding.severity],
      reason: `${input.decision === 'accepted_by_user' ? 'Accept' : 'Dismiss'} a ${finding.severity} finding`,
      requestedBy: 'user',
      detail: {
        findingId: input.findingId,
        decision: input.decision,
        definitionVersion: version.version,
        definitionHash: version.definitionHash,
      },
      now,
    });
    decideGoalApproval(db, {
      goalId: input.goalId,
      approvalId: approval.id,
      decision: 'approved',
      decidedBy: 'user',
      ...(input.note ? { note: input.note } : {}),
      now,
    });
    const decided = decideFinding(db, {
      goalId: input.goalId,
      findingId: input.findingId,
      decision: input.decision,
      approvalId: approval.id,
      actor: 'user',
      now,
    });
    return { finding: decided, approvalId: approval.id };
  })();
}
