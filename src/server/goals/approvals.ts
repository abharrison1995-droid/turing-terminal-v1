import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import {
  GOAL_APPROVAL_GATES,
  type GoalApproval,
  type GoalApprovalGate,
  type GoalApprovalRisk,
  type GoalApprovalRequester,
} from '../../shared/goals.js';
import { writeGoalEvent } from './events.js';

export type GoalApprovalErrorCode =
  'goal_not_found' | 'invalid_gate' | 'approval_not_found' | 'user_decision_required' | 'already_decided';

export class GoalApprovalError extends Error {
  constructor(
    readonly code: GoalApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalApprovalError';
  }
}

interface Row {
  id: string;
  goal_id: string;
  gate: GoalApprovalGate;
  risk: GoalApprovalRisk;
  reason: string;
  requested_by: GoalApprovalRequester;
  detail_json: string;
  status: GoalApproval['status'];
  decided_by: 'user' | 'system' | null;
  decision_note: string | null;
  created_at: string;
  responded_at: string | null;
}

function toApproval(row: Row): GoalApproval {
  return {
    id: row.id,
    goalId: row.goal_id,
    gate: row.gate,
    risk: row.risk,
    reason: row.reason,
    requestedBy: row.requested_by,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    status: row.status,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

export function getGoalApproval(db: Db, approvalId: string): GoalApproval | undefined {
  const row = db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(approvalId) as Row | undefined;
  return row ? toApproval(row) : undefined;
}

export function pendingGoalApprovals(db: Db, goalId: string): GoalApproval[] {
  return (
    db
      .prepare(
        "SELECT * FROM goal_approvals WHERE goal_id = ? AND status = 'pending' ORDER BY created_at, rowid",
      )
      .all(goalId) as Row[]
  ).map(toApproval);
}

/** Records a pending Goal-level approval (separate from per-run approvals). */
export function requestGoalApproval(
  db: Db,
  input: {
    goalId: string;
    gate: GoalApprovalGate;
    risk: GoalApprovalRisk;
    reason: string;
    requestedBy: GoalApprovalRequester;
    detail?: Record<string, unknown>;
    now?: string;
  },
): GoalApproval {
  if (!GOAL_APPROVAL_GATES.includes(input.gate))
    throw new GoalApprovalError('invalid_gate', `Unknown gate "${input.gate}".`);
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(input.goalId))
      throw new GoalApprovalError('goal_not_found', 'The Goal does not exist.');
    const id = randomUUID();
    db.prepare(
      `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      id,
      input.goalId,
      input.gate,
      input.risk,
      input.reason,
      input.requestedBy,
      JSON.stringify(input.detail ?? {}),
      now,
    );
    writeGoalEvent(
      db,
      input.goalId,
      'approval_requested',
      { approvalId: id, gate: input.gate, risk: input.risk },
      now,
    );
    return getGoalApproval(db, id)!;
  })();
}

/**
 * Decides a pending approval exactly once. Only an explicit user decision can approve; the system may only deny
 * (for example when a restart interrupts a gate). Repeating the recorded decision is a stable no-op; a conflicting
 * second decision is refused. There is no model or automatic approval path.
 */
export function decideGoalApproval(
  db: Db,
  input: {
    goalId: string;
    approvalId: string;
    decision: 'approved' | 'denied';
    decidedBy: 'user' | 'system';
    note?: string;
    now?: string;
  },
): { approval: GoalApproval; changed: boolean } {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM goal_approvals WHERE id = ? AND goal_id = ?')
      .get(input.approvalId, input.goalId) as Row | undefined;
    if (!row) throw new GoalApprovalError('approval_not_found', 'No such approval for this Goal.');
    if (input.decision === 'approved' && input.decidedBy !== 'user')
      throw new GoalApprovalError(
        'user_decision_required',
        'Only an explicit user action can approve a Goal gate.',
      );
    if (row.status !== 'pending') {
      if (row.status === input.decision) return { approval: toApproval(row), changed: false };
      throw new GoalApprovalError('already_decided', `The approval was already ${row.status}.`);
    }
    db.prepare(
      `UPDATE goal_approvals SET status = ?, decided_by = ?, decision_note = ?, responded_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(input.decision, input.decidedBy, input.note ?? null, now, row.id);
    writeGoalEvent(
      db,
      input.goalId,
      'approval_decided',
      { approvalId: row.id, gate: row.gate, status: input.decision, decidedBy: input.decidedBy },
      now,
    );
    return { approval: getGoalApproval(db, row.id)!, changed: true };
  })();
}

export type ExactGateBinding = { ok: true; approval: GoalApproval } | { ok: false };

/**
 * The one proof that a `needs_user(gate_pending)` Goal's status detail names a real gate: the status and reason match,
 * the detail parses and carries a string `approvalId` and `gate`, and that approval exists, belongs to this Goal and has
 * exactly that gate. Pure read; callers decide what each approval status means.
 */
export function bindExactGate(
  db: Db,
  goalId: string,
  goal: { status: string; reasonCode: string | null; detail: string | Record<string, unknown> | null },
): ExactGateBinding {
  if (goal.status !== 'needs_user' || goal.reasonCode !== 'gate_pending') return { ok: false };
  let detail: unknown = goal.detail;
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail);
    } catch {
      return { ok: false };
    }
  }
  const named = detail as { approvalId?: unknown; gate?: unknown } | null;
  if (!named || typeof named.approvalId !== 'string' || typeof named.gate !== 'string' || !named.gate)
    return { ok: false };
  const approval = getGoalApproval(db, named.approvalId);
  if (!approval || approval.goalId !== goalId || approval.gate !== named.gate) return { ok: false };
  return { ok: true, approval };
}
