import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type {
  EvidenceVerdict,
  FindingSeverity,
  GoalEvidenceKind,
  GoalReviewKind,
  ReviewVerdict,
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
  evidence_recorded: {
    evidenceId: string;
    criterionKey: string;
    verifierDigest: string;
    kind: GoalEvidenceKind;
    verdict: EvidenceVerdict;
    definitionVersion: number;
  };
  review_completed: {
    reviewId: string;
    reviewKind: GoalReviewKind;
    verdict: ReviewVerdict;
    blocking: boolean;
    reviewedToTree: string;
  };
  review_findings_applied: {
    reviewId: string;
    opened: number;
    observed: number;
    resolved: number;
    reopened: number;
    resolutionsRefused: number;
  };
  finding_opened: { goalFindingId: string; severity: FindingSeverity; reviewId: string };
  finding_resolved: { goalFindingId: string; reviewId: string };
  finding_reopened: { goalFindingId: string; reviewId: string };
  finding_decided: {
    goalFindingId: string;
    decision: 'accepted_by_user' | 'dismissed_by_user';
    approvalId: string;
  };
  milestone_satisfied: { milestoneKey: string; definitionVersion: number };
  completion_evaluated: {
    ok: boolean;
    definitionVersion: number;
    definitionHash: string;
    integrationHead: string;
    integrationTree: string;
    failureCodes: string[];
  };
  cycle_created: {
    cycleId: string;
    sequence: number;
    kind: string;
    triggerCode: string;
    milestoneKey: string | null;
    definitionVersion: number;
    baseIntegrationCommit: string;
  };
  cycle_finished: {
    cycleId: string;
    sequence: number;
    kind: string;
    status: string;
    outcomeCode: string;
  };
  counters_reconciled: {
    cyclesExecuted: number;
    consecutiveFailedCycles: number;
    remediationAttempts: Record<string, number>;
    corrected: boolean;
  };
  /** Written by an evidence collector only after every evidence row for the run is durably recorded (even zero). */
  run_evidence_collected: {
    runId: string;
    cycleId: string;
    definitionVersion: number;
    evidenceCount: number;
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
