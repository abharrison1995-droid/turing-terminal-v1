import type { Db } from '../db.js';
import {
  GOAL_TERMINAL_STATUSES,
  TERMINAL_RUN_STATUSES,
  type FindingSeverity,
  type GoalApproval,
  type GoalApprovalRisk,
  type GoalStatus,
} from '../../shared/goals.js';
import {
  decideGoalApproval,
  getGoalApproval,
  GoalApprovalError,
  pendingGoalApprovals,
  requestGoalApproval,
} from './approvals.js';
import { activeCycle, finalizeCycle } from './cycles.js';
import { loadDefinitionVersion } from './definitions.js';
import { decideFinding, getGoalFinding, GoalFindingError, type GoalFinding } from './findings.js';
import { isManualReconciliation } from './readModel.js';
import { GoalStateError, isLegalGoalTransition, transitionGoal } from './stateMachine.js';

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

export const ABANDON_APPROVAL_NOTE = 'Goal abandoned by user; pending gate is no longer actionable.';

/**
 * draft/ready/needs_user/blocked/paused -> abandoned (reason `user_abandoned`). There is no running/reviewing ->
 * abandoned edge, so a user first gets the Goal into a legal quiescent state. Nothing is deleted: every row stays as
 * history.
 *
 * Abandonment makes the Goal terminal, so it re-proves, server-side and inside the one transaction, that nothing
 * Goal-owned can still change its history:
 *   - every Goal-linked run (the `goal_runs` view) is terminal (`TERMINAL_RUN_STATUSES`); and
 *   - no Goal integration operation is still `planned`.
 * Otherwise it is refused with `goal_work_in_flight` and nothing changes. It never cancels a run, kills a process or
 * moves a ref: the user waits for the work to settle and retries.
 *
 * On success, in the same transaction: an active cycle (all its work already terminal) is finalised `cancelled`; every
 * still-pending Goal approval is denied with `decidedBy: 'system'` (the system may deny, never approve); and the Goal
 * moves through `transitionGoal`, the only writer of `goals.status`. Any failure rolls all of it back.
 */
export function abandonGoal(db: Db, goalId: string, options: { now?: string } = {}): { status: 'abandoned' } {
  const now = options.now ?? new Date().toISOString();
  db.transaction(() => {
    const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
      { status: GoalStatus } | undefined;
    if (!goal) throw new GoalStateError('goal_not_found', 'The Goal does not exist.');
    if (GOAL_TERMINAL_STATUSES.includes(goal.status))
      throw new GoalStateError('terminal_state', `A ${goal.status} Goal has no outgoing transitions.`);
    if (!isLegalGoalTransition(goal.status, 'abandoned'))
      throw new GoalStateError('illegal_transition', `A Goal cannot move from ${goal.status} to abandoned.`);

    const runs = db
      .prepare('SELECT run_id, status FROM goal_runs g JOIN runs r ON r.id = g.run_id WHERE g.goal_id = ?')
      .all(goalId) as Array<{ run_id: string; status: string }>;
    const running = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
    const plannedOps = db
      .prepare("SELECT id, op FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned'")
      .all(goalId) as Array<{ id: string; op: string }>;
    if (running.length > 0 || plannedOps.length > 0)
      throw new GoalStateError(
        'goal_work_in_flight',
        'The Goal still has work in flight. Wait for it to finish, then abandon the Goal.',
      );

    const cycle = activeCycle(db, goalId);
    if (cycle)
      finalizeCycle(db, {
        cycleId: cycle.id,
        to: 'cancelled',
        outcomeCode: 'goal_abandoned',
        detail: { abandonedBy: 'user' },
        now,
      });
    for (const approval of pendingGoalApprovals(db, goalId))
      decideGoalApproval(db, {
        goalId,
        approvalId: approval.id,
        decision: 'denied',
        decidedBy: 'system',
        note: ABANDON_APPROVAL_NOTE,
        now,
      });
    transitionGoal(db, { goalId, to: 'abandoned', reasonCode: 'user_abandoned', actor: 'user', now });
  })();
  return { status: 'abandoned' };
}

/**
 * The explicit user decision on a Goal approval. It refuses (without touching the row) while the approval is pending
 * and its Goal is terminal, or needs manual reconciliation, whatever a stale client or a Goal-less surface shows. The
 * system's own cleanup uses `decideGoalApproval` directly and is unaffected. It never starts or resumes the Goal.
 */
export function decideGoalApprovalAsUser(
  db: Db,
  input: { approvalId: string; decision: 'approved' | 'denied'; note?: string; now?: string },
): { approval: GoalApproval; changed: boolean } {
  return db.transaction(() => {
    const existing = getGoalApproval(db, input.approvalId);
    if (!existing) throw new GoalApprovalError('approval_not_found', 'No such Goal approval.');
    if (existing.status === 'pending') {
      const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(existing.goalId) as
        { status: GoalStatus } | undefined;
      if (!goal || GOAL_TERMINAL_STATUSES.includes(goal.status))
        throw new GoalApprovalError(
          'goal_terminal',
          'The Goal has finished, so this approval can no longer be decided.',
        );
      if (isManualReconciliation(db, existing.goalId))
        throw new GoalApprovalError(
          'manual_reconciliation_required',
          'This Goal needs manual reconciliation; its approvals cannot be decided here.',
        );
    }
    return decideGoalApproval(db, {
      goalId: existing.goalId,
      approvalId: existing.id,
      decision: input.decision,
      decidedBy: 'user',
      ...(input.note ? { note: input.note } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  })();
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
      .prepare('SELECT current_definition_version AS v, status FROM goals WHERE id = ?')
      .get(input.goalId) as { v: number | null; status: GoalStatus } | undefined;
    if (!goal) throw new GoalFindingError('goal_not_found', 'The Goal does not exist.');
    // Checked before the decision approval is created, so a refusal leaves no generated approval behind.
    if (GOAL_TERMINAL_STATUSES.includes(goal.status))
      throw new GoalFindingError(
        'goal_terminal',
        'The Goal has finished; its findings can no longer be decided.',
      );
    if (isManualReconciliation(db, input.goalId))
      throw new GoalFindingError(
        'manual_reconciliation_required',
        'This Goal needs manual reconciliation; its findings cannot be decided here.',
      );
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
