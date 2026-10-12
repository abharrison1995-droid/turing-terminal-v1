import type { Db } from '../db.js';
import { getGoalApproval, GoalApprovalError, pendingGoalApprovals } from './approvals.js';
import {
  AttestationCorrectionError,
  buildAttestationCorrectionAction,
  getAttestationCorrectionChainPosition,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import {
  parseAttestationCorrectionApprovalDetail,
  type AttestationCorrectionApprovalDetailV1,
  type AttestationCorrectionKind,
  type AttestationCorrectionReasonCode,
} from './attestationCorrectionDetail.js';

/**
 * The user's request for one correction (D.4D). It creates at most one pending high-risk approval and changes nothing
 * else: no Goal row, no completion proof, no event other than `approval_requested`, and no Git. The decision is a separate
 * user action on the D.4C route. A request is idempotent for an identical pending action (same reviewed chain position,
 * kind, reason, explanation and replacement), and it refuses a second, different pending correction on the same
 * attestation so that at most one correction is awaiting a decision for each attestation.
 *
 * The chain position is the caller's If-Match precondition. It is compared inside the same immediate transaction that
 * creates the approval, so a stale review refuses with `correction_chain_changed` and nothing is written.
 */

export interface AttestationCorrectionRequestInput {
  goalId: string;
  handoffId: string;
  attestationId: string;
  /** The chain position the user reviewed, from If-Match. Compared with the current position, never trusted as authority. */
  expectedChainPosition: string;
  correctionKind: AttestationCorrectionKind;
  reasonCode: AttestationCorrectionReasonCode;
  explanation: string | null;
  replacementAttestationId: string | null;
}

export interface AttestationCorrectionRequestResult {
  approvalId: string;
  actionDigest: string;
  detail: AttestationCorrectionApprovalDetailV1;
  status: 'pending';
  /** True when an identical pending request already existed and no new approval was recorded. */
  reused: boolean;
}

interface Found {
  approvalId: string;
  status: string;
}

export function requestAttestationCorrectionAsUser(
  db: Db,
  input: AttestationCorrectionRequestInput,
): AttestationCorrectionRequestResult {
  const request = db.transaction((): AttestationCorrectionRequestResult => {
    const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(input.goalId) as
      { status: string } | undefined;
    if (!goal) throw new AttestationCorrectionError('goal_not_found', 'The Goal does not exist.');
    if (goal.status === 'abandoned')
      throw new GoalApprovalError(
        'goal_terminal',
        'The Goal has finished, so no correction can be requested.',
      );
    const attestation = db
      .prepare('SELECT handoff_id FROM goal_external_integration_attestations WHERE goal_id = ? AND id = ?')
      .get(input.goalId, input.attestationId) as { handoff_id: string } | undefined;
    if (!attestation || attestation.handoff_id !== input.handoffId)
      throw new AttestationCorrectionError(
        'attestation_not_found',
        'The attestation does not exist for this Goal and handoff.',
      );

    const position = getAttestationCorrectionChainPosition(db, input.goalId, input.attestationId);
    if (position !== input.expectedChainPosition)
      throw new AttestationCorrectionError(
        'correction_chain_changed',
        'The correction history changed since you reviewed it.',
      );

    // The exact action is built from the verified chain, so an identical request is recognised by its digest.
    const { actionDigest } = buildAttestationCorrectionAction(db, {
      goalId: input.goalId,
      attestationId: input.attestationId,
      correctionKind: input.correctionKind,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      replacementAttestationId: input.replacementAttestationId,
    });

    // The unique index on (goal, action digest) makes an identical request find at most one row.
    const identical = db
      .prepare(
        'SELECT id AS approvalId, status FROM goal_approvals WHERE goal_id = ? AND attestation_correction_action_digest = ?',
      )
      .get(input.goalId, actionDigest) as Found | undefined;
    if (identical) {
      const approval = getGoalApproval(db, identical.approvalId);
      const detail = approval ? parseAttestationCorrectionApprovalDetail(approval.detail) : null;
      if (identical.status !== 'pending' || !detail || !approval)
        throw new AttestationCorrectionError(
          'correction_request_already_decided',
          'This exact correction was already decided.',
        );
      return { approvalId: approval.id, actionDigest, detail, status: 'pending', reused: true };
    }

    // A second, different correction may not wait beside a pending one on the same attestation.
    const awaiting = db
      .prepare(
        `SELECT id FROM goal_approvals
         WHERE goal_id = ? AND status = 'pending' AND attestation_correction_action_digest IS NOT NULL`,
      )
      .all(input.goalId) as { id: string }[];
    for (const row of awaiting) {
      const approval = getGoalApproval(db, row.id);
      const detail = approval ? parseAttestationCorrectionApprovalDetail(approval.detail) : null;
      if (detail?.attestationId === input.attestationId)
        throw new AttestationCorrectionError(
          'correction_request_pending',
          'A correction is already waiting for your decision.',
        );
    }

    const created = requestAttestationCorrectionApproval(db, {
      goalId: input.goalId,
      attestationId: input.attestationId,
      correctionKind: input.correctionKind,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      replacementAttestationId: input.replacementAttestationId,
    });
    return {
      approvalId: created.approval.id,
      actionDigest: created.actionDigest,
      detail: created.detail,
      status: 'pending',
      reused: false,
    };
  });
  try {
    return request.immediate();
  } catch (error) {
    if (error instanceof AttestationCorrectionError || error instanceof GoalApprovalError) throw error;
    throw new AttestationCorrectionError(
      'persistence_failed',
      'The correction request could not be recorded safely.',
    );
  }
}

/** A correction request awaiting the user's decision, as the read route shows it. It never carries the explanation text. */
export interface PendingAttestationCorrectionRequest {
  approvalId: string;
  actionDigest: string;
  correctionKind: AttestationCorrectionKind;
  reasonCode: AttestationCorrectionReasonCode;
  sequence: number;
  previousCorrectionDigest: string | null;
  replacementAttestationId: string | null;
  /** True when the decision must re-send the same explanation, because the reviewed action carries one. */
  explanationRequired: boolean;
  requestedAt: string;
}

/**
 * Read-only: the pending correction requests for one attestation, plus a count of pending correction rows of this Goal
 * whose stored detail does not verify. An unreadable row is counted, never repaired and never shown as a request.
 */
export function listPendingAttestationCorrectionRequests(
  db: Db,
  goalId: string,
  attestationId: string,
): { pending: PendingAttestationCorrectionRequest[]; pendingUnreadableCount: number } {
  const pending: PendingAttestationCorrectionRequest[] = [];
  let pendingUnreadableCount = 0;
  for (const approval of pendingGoalApprovals(db, goalId)) {
    if (approval.attestationCorrectionActionDigest === undefined) continue;
    const detail = parseAttestationCorrectionApprovalDetail(approval.detail);
    if (!detail) {
      pendingUnreadableCount += 1;
      continue;
    }
    if (detail.attestationId !== attestationId) continue;
    pending.push({
      approvalId: approval.id,
      actionDigest: detail.actionDigest,
      correctionKind: detail.correctionKind,
      reasonCode: detail.reasonCode,
      sequence: detail.sequence,
      previousCorrectionDigest: detail.previousCorrectionDigest,
      replacementAttestationId: detail.replacementAttestationId,
      explanationRequired: detail.explanationDigest !== null,
      requestedAt: approval.createdAt,
    });
  }
  return { pending, pendingUnreadableCount };
}
