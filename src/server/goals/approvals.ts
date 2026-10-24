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
import { parseExternalIntegrationApprovalDetail } from './externalIntegrationApproval.js';
import {
  ATTESTATION_CORRECTION_ACTION,
  parseAttestationCorrectionApprovalDetail,
} from './attestationCorrectionDetail.js';
import { parseExternalCompletionAction } from './externalCompletionProof.js';
import { opportunityApprovalDetailSchema } from '../../shared/opportunityContract.js';
import {
  recordOpportunityAdmissionProof,
  reproveOpportunityAdmissionApproval,
} from '../opportunityEvidence.js';

const EXTERNAL_COMPLETION_ACTION = 'complete_goal_external_integration_v2';

export type GoalApprovalErrorCode =
  | 'goal_not_found'
  | 'invalid_gate'
  | 'approval_not_found'
  | 'user_decision_required'
  | 'already_decided'
  | 'goal_terminal'
  | 'manual_reconciliation_required'
  | 'invalid_intent_digest'
  | 'invalid_external_integration_action_digest'
  | 'invalid_attestation_correction_action_digest'
  | 'invalid_external_completion_action_digest'
  | 'completion_decision_requires_dedicated_service'
  | 'correction_decision_requires_dedicated_service'
  | 'invalid_opportunity_admission';

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
  intent_digest: string | null;
  external_integration_action_digest: string | null;
  external_completion_action_digest: string | null;
  attestation_correction_action_digest: string | null;
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
    ...(row.intent_digest ? { intentDigest: row.intent_digest } : {}),
    ...(row.external_integration_action_digest
      ? { externalIntegrationActionDigest: row.external_integration_action_digest }
      : {}),
    ...(row.external_completion_action_digest
      ? { externalCompletionActionDigest: row.external_completion_action_digest }
      : {}),
    ...(row.attestation_correction_action_digest
      ? { attestationCorrectionActionDigest: row.attestation_correction_action_digest }
      : {}),
  };
}

export function getGoalApproval(db: Db, approvalId: string): GoalApproval | undefined {
  const row = db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(approvalId) as Row | undefined;
  return row ? toApproval(row) : undefined;
}

/** The fields that identify a dedicated-service approval. Shared by the generic route refusal and the inbox projection. */
export type DedicatedApprovalSubject = Pick<
  GoalApproval,
  'detail' | 'attestationCorrectionActionDigest' | 'externalCompletionActionDigest'
>;

/**
 * A correction approval is decided only by its dedicated correction service, at any status. The generic decision route
 * refuses it, and the unified inbox must not offer a generic decision for it.
 */
export function isDedicatedCorrectionApproval(approval: DedicatedApprovalSubject): boolean {
  return (
    approval.attestationCorrectionActionDigest !== undefined ||
    approval.detail.action === ATTESTATION_CORRECTION_ACTION
  );
}

/**
 * A completion approval is decided only by its dedicated completion service, while it is pending. This predicate is
 * status-blind: the generic decision route and the unified inbox each apply the pending condition themselves.
 */
export function isDedicatedCompletionApproval(approval: DedicatedApprovalSubject): boolean {
  return (
    approval.externalCompletionActionDigest !== undefined ||
    approval.detail.action === EXTERNAL_COMPLETION_ACTION
  );
}

/**
 * True only for a stored row that is a pending final-acceptance gate. The desktop-only caller boundary reads the stored
 * `goal_approvals` row (which is mutable) and applies this exact conjunction before body validation; the projection uses
 * the same shape to keep the row visible but read-only for a remote caller.
 */
export function isPendingFinalAcceptanceRow(row: { gate: string; status: string }): boolean {
  return row.gate === 'final_acceptance' && row.status === 'pending';
}

/** Exact opportunity admissions are desktop-only; static first-use decisions retain their existing remote policy. */
export function isPendingOpportunityAdmissionRow(row: {
  gate: string;
  status: string;
  detail_json: string;
}): boolean {
  if (row.gate !== 'pool_route_first_use' || row.status !== 'pending') return false;
  try {
    const detail = JSON.parse(row.detail_json) as unknown;
    return (
      !!detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      (detail as Record<string, unknown>).admissionKind === 'opportunity'
    );
  } catch {
    return false;
  }
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
    intentDigest?: string;
    externalIntegrationActionDigest?: string;
    attestationCorrectionActionDigest?: string;
    externalCompletionActionDigest?: string;
    now?: string;
  },
): GoalApproval {
  if (!GOAL_APPROVAL_GATES.includes(input.gate))
    throw new GoalApprovalError('invalid_gate', `Unknown gate "${input.gate}".`);
  // A completion approval is the only request that may carry a completion digest. Any other digest or intent on it,
  // and any completion digest on another action, is refused here rather than falling into the branches below.
  if (
    (input.externalCompletionActionDigest !== undefined ||
      input.detail?.action === EXTERNAL_COMPLETION_ACTION) &&
    !externalCompletionRequestMatches(input)
  )
    throw new GoalApprovalError(
      'invalid_external_completion_action_digest',
      'An external completion approval action digest is invalid. It must match its versioned high-risk user approval action.',
    );
  const externalAction =
    input.externalIntegrationActionDigest !== undefined ||
    input.detail?.action === 'confirm_external_integration';
  const externalDetail = parseExternalIntegrationApprovalDetail(input.detail);
  if (
    externalAction &&
    (input.gate !== 'final_apply' ||
      input.risk !== 'high' ||
      input.requestedBy !== 'user' ||
      input.intentDigest !== undefined ||
      input.detail?.schemaVersion !== 2 ||
      input.detail?.action !== 'confirm_external_integration' ||
      input.detail?.actionDigest !== input.externalIntegrationActionDigest ||
      !externalDetail ||
      externalDetail.goalId !== input.goalId ||
      externalDetail.actionDigest !== input.externalIntegrationActionDigest ||
      input.externalIntegrationActionDigest === undefined ||
      !/^[0-9a-f]{64}$/.test(input.externalIntegrationActionDigest))
  )
    throw new GoalApprovalError(
      'invalid_external_integration_action_digest',
      'An external-integration action digest must match its versioned high-risk user approval detail.',
    );
  if (
    !externalAction &&
    (input.intentDigest !== undefined || input.detail?.action === 'apply_to_base_intent') &&
    (input.gate !== 'final_apply' ||
      input.risk !== 'high' ||
      input.requestedBy !== 'user' ||
      input.detail?.action !== 'apply_to_base_intent' ||
      input.detail?.intentDigest !== input.intentDigest ||
      input.intentDigest === undefined ||
      !/^[0-9a-f]{64}$/.test(input.intentDigest))
  )
    throw new GoalApprovalError(
      'invalid_intent_digest',
      'A prospective final-apply digest must match its final-apply approval detail.',
    );
  const correctionAction =
    input.attestationCorrectionActionDigest !== undefined ||
    input.detail?.action === ATTESTATION_CORRECTION_ACTION;
  const correctionDetail = parseAttestationCorrectionApprovalDetail(input.detail);
  if (
    correctionAction &&
    (input.gate !== 'user_confirmation' ||
      input.risk !== 'high' ||
      input.requestedBy !== 'user' ||
      input.intentDigest !== undefined ||
      input.externalIntegrationActionDigest !== undefined ||
      input.attestationCorrectionActionDigest === undefined ||
      !/^[0-9a-f]{64}$/.test(input.attestationCorrectionActionDigest) ||
      !correctionDetail ||
      correctionDetail.goalId !== input.goalId ||
      correctionDetail.actionDigest !== input.attestationCorrectionActionDigest)
  )
    throw new GoalApprovalError(
      'invalid_attestation_correction_action_digest',
      'An attestation correction digest must match its versioned high-risk user approval detail.',
    );
  if (
    input.detail?.admissionKind !== undefined &&
    (input.gate !== 'pool_route_first_use' ||
      input.detail.admissionKind !== 'opportunity' ||
      input.risk !== 'medium' ||
      input.requestedBy !== 'user' ||
      !opportunityApprovalDetailSchema.safeParse(input.detail).success ||
      JSON.stringify(input.detail).length > 4_000)
  )
    throw new GoalApprovalError(
      'invalid_opportunity_admission',
      'An opportunity admission must use its exact, bounded user-approval binding.',
    );
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(input.goalId))
      throw new GoalApprovalError('goal_not_found', 'The Goal does not exist.');
    const id = randomUUID();
    db.prepare(
      `INSERT INTO goal_approvals (
         id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at,
         intent_digest, external_integration_action_digest, attestation_correction_action_digest,
         external_completion_action_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.goalId,
      input.gate,
      input.risk,
      input.reason,
      input.requestedBy,
      JSON.stringify(input.detail ?? {}),
      now,
      input.intentDigest ?? null,
      input.externalIntegrationActionDigest ?? null,
      input.attestationCorrectionActionDigest ?? null,
      input.externalCompletionActionDigest ?? null,
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
 * A completion approval is a high-risk user confirmation whose detail is exactly one valid completion action for this
 * Goal, and whose digest column names that action's digest. It carries no other digest and no intent.
 */
function externalCompletionRequestMatches(input: {
  goalId: string;
  gate: GoalApprovalGate;
  risk: GoalApprovalRisk;
  requestedBy: GoalApprovalRequester;
  detail?: Record<string, unknown>;
  intentDigest?: string;
  externalIntegrationActionDigest?: string;
  attestationCorrectionActionDigest?: string;
  externalCompletionActionDigest?: string;
}): boolean {
  const digest = input.externalCompletionActionDigest;
  if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest)) return false;
  if (
    input.gate !== 'user_confirmation' ||
    input.risk !== 'high' ||
    input.requestedBy !== 'user' ||
    input.intentDigest !== undefined ||
    input.externalIntegrationActionDigest !== undefined ||
    input.attestationCorrectionActionDigest !== undefined
  )
    return false;
  const parsed = parseExternalCompletionAction(input.detail);
  return parsed.valid && parsed.action.goalId === input.goalId && parsed.digest === digest;
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
    if (input.decision === 'approved' && row.gate === 'pool_route_first_use') {
      let detail: unknown;
      try {
        detail = JSON.parse(row.detail_json);
      } catch {
        detail = null;
      }
      if (
        detail &&
        typeof detail === 'object' &&
        !Array.isArray(detail) &&
        (detail as Record<string, unknown>).admissionKind === 'opportunity'
      ) {
        try {
          reproveOpportunityAdmissionApproval(db, {
            goalId: input.goalId,
            approvalId: row.id,
            detailJson: row.detail_json,
            now,
          });
        } catch {
          throw new GoalApprovalError(
            'invalid_opportunity_admission',
            'The opportunity evidence or its active definition changed; request a fresh admission.',
          );
        }
      }
    }
    db.prepare(
      `UPDATE goal_approvals SET status = ?, decided_by = ?, decision_note = ?, responded_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(input.decision, input.decidedBy, input.note ?? null, now, row.id);
    if (input.decision === 'approved' && row.gate === 'pool_route_first_use') {
      let detail: unknown;
      try {
        detail = JSON.parse(row.detail_json);
      } catch {
        detail = null;
      }
      if (
        detail &&
        typeof detail === 'object' &&
        !Array.isArray(detail) &&
        (detail as Record<string, unknown>).admissionKind === 'opportunity'
      ) {
        try {
          recordOpportunityAdmissionProof(db, { approvalId: row.id, goalId: input.goalId, acceptedAt: now });
        } catch {
          throw new GoalApprovalError(
            'invalid_opportunity_admission',
            'The approved admission proof could not be preserved for its exact definition.',
          );
        }
      }
    }
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
  // A completion approval is never a gate the supervisor or a read model may resolve; it is inert until its consumer.
  if (approval.externalCompletionActionDigest !== undefined) return { ok: false };
  // A correction approval is never a gate either: it is a user_confirmation decision with its own consumer only.
  if (approval.attestationCorrectionActionDigest !== undefined) return { ok: false };
  return { ok: true, approval };
}
