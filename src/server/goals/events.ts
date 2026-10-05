import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type {
  GoalApprovalGate,
  GoalApprovalRisk,
  GoalApprovalStatus,
  GoalEventType,
  GoalReasonCode,
  GoalStatus,
} from '../../shared/goals.js';

/**
 * Canonical Goal event writer. Payloads are small, structured references (ids, versions, hashes, statuses and
 * enumerated codes), never full definitions or free text; the log is append-only (migration 017).
 */
export interface GoalEventPayloads {
  goal_created: { projectId: string; title: string };
  definition_proposed: { version: number; parentVersion: number | null; definitionHash: string };
  definition_approved: {
    version: number;
    definitionHash: string;
    approvalId: string;
    supersededVersion: number | null;
    milestones: { added: number; reopened: number; skipped: number };
  };
  definition_rejected: { version: number; definitionHash: string };
  amendment_started: { fromVersion: number; toVersion: number };
  state_changed: {
    from: GoalStatus;
    to: GoalStatus;
    reasonCode: GoalReasonCode;
    actor: 'user' | 'supervisor';
  };
  approval_requested: { approvalId: string; gate: GoalApprovalGate; risk: GoalApprovalRisk };
  approval_decided: {
    approvalId: string;
    gate: GoalApprovalGate;
    status: Exclude<GoalApprovalStatus, 'pending'>;
    decidedBy: 'user' | 'system';
  };
}

const MAX_PAYLOAD_CHARS = 16_384;

export function writeGoalEvent<T extends GoalEventType>(
  db: Db,
  goalId: string,
  type: T,
  payload: GoalEventPayloads[T],
  now = new Date().toISOString(),
): string {
  const json = JSON.stringify(payload);
  if (json.length > MAX_PAYLOAD_CHARS)
    throw new Error(`Goal event payload for ${type} exceeds ${MAX_PAYLOAD_CHARS} characters.`);
  const id = randomUUID();
  db.prepare(
    'INSERT INTO goal_events (id, goal_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, goalId, type, json, now);
  return id;
}

export function listGoalEvents(
  db: Db,
  goalId: string,
): Array<{ type: GoalEventType; payload: unknown; createdAt: string }> {
  return (
    db
      .prepare('SELECT type, payload_json, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid')
      .all(goalId) as Array<{ type: GoalEventType; payload_json: string; created_at: string }>
  ).map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
}
