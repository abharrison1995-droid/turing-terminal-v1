import type { Db } from '../db.js';
import { decideGoalApproval, getGoalApproval, GoalApprovalError } from './approvals.js';
import { appendAttestationCorrection, AttestationCorrectionError } from './attestationCorrection.js';
import {
  parseAttestationCorrectionApprovalDetail,
  type AttestationCorrectionKind,
} from './attestationCorrectionDetail.js';

/**
 * The one dedicated user decision on a post-attestation correction approval (D.4C). It decides exactly one reviewed
 * correction: the approval must be a genuine correction approval of this Goal, its reviewed action digest must equal the
 * stored digest, and an approval only becomes a correction once the append re-verifies the whole chain. Both writes run
 * in one outer immediate transaction, so a refusal in the append rolls back the decision too.
 *
 * Authority: the decider is fixed to the user here, and the generic approval route refuses correction approvals
 * (`correction_decision_requires_dedicated_service`). A correction never starts, resumes or completes a Goal, never
 * touches the Git repository, and never writes `goals`, the completion proof table or any completion event. A
 * completed Goal may receive a correction; an abandoned Goal may not (`goal_terminal`).
 *
 * The chain tip is not supplied by the caller. The previous-digest and sequence checks are inside the append, against
 * the verified tip, so a stale review refuses with `correction_chain_changed` and leaves the approval pending.
 */

interface AttestationCorrectionDecisionBase {
  goalId: string;
  approvalId: string;
  /** The reviewed correction action digest. It is compared with the stored digest and is never trusted as authority. */
  reviewedActionDigest: string;
  note?: string;
}

export type AttestationCorrectionDecisionInput =
  | (AttestationCorrectionDecisionBase & { decision: 'denied' })
  | (AttestationCorrectionDecisionBase & {
      decision: 'approved';
      /** Must equal the attestation named by the stored approval. */
      attestationId: string;
      /** Must equal the correction kind named by the stored approval. */
      correctionKind: AttestationCorrectionKind;
      /** Must match the stored explanation digest exactly (null when the approval carries no explanation). */
      explanation: string | null;
    });

export interface AttestationCorrectionDecisionResult {
  approvalId: string;
  status: 'approved' | 'denied';
  actionDigest: string;
  /** Present only for an approved decision, the correction that the decision appended or had already appended. */
  correctionId: string | null;
  sequence: number | null;
  /** True when nothing new was recorded: the decision was already recorded and, for approval, the correction exists. */
  reused: boolean;
}

function mismatch(): AttestationCorrectionError {
  return new AttestationCorrectionError(
    'correction_action_mismatch',
    'The approval does not match the reviewed correction.',
  );
}

export function decideAttestationCorrectionAsUser(
  db: Db,
  input: AttestationCorrectionDecisionInput,
): AttestationCorrectionDecisionResult {
  const decide = db.transaction((): AttestationCorrectionDecisionResult => {
    const approval = getGoalApproval(db, input.approvalId);
    if (!approval || approval.goalId !== input.goalId)
      throw new GoalApprovalError('approval_not_found', 'No such approval for this Goal.');
    const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(input.goalId) as
      { status: string } | undefined;
    if (!goal) throw new AttestationCorrectionError('goal_not_found', 'The Goal does not exist.');
    if (goal.status === 'abandoned')
      throw new GoalApprovalError(
        'goal_terminal',
        'The Goal has finished, so this approval can no longer be decided.',
      );

    // Only a stored correction approval whose digest column and detail both verify is a correction at all.
    const detail =
      approval.attestationCorrectionActionDigest === undefined
        ? null
        : parseAttestationCorrectionApprovalDetail(approval.detail);
    if (
      !detail ||
      detail.goalId !== input.goalId ||
      approval.attestationCorrectionActionDigest !== input.reviewedActionDigest ||
      detail.actionDigest !== input.reviewedActionDigest
    )
      throw mismatch();
    if (
      input.decision === 'approved' &&
      (detail.attestationId !== input.attestationId || detail.correctionKind !== input.correctionKind)
    )
      throw mismatch();

    const decided = decideGoalApproval(db, {
      goalId: input.goalId,
      approvalId: input.approvalId,
      decision: input.decision,
      decidedBy: 'user',
      ...(input.note ? { note: input.note } : {}),
    });

    if (input.decision === 'denied')
      return {
        approvalId: input.approvalId,
        status: 'denied',
        actionDigest: input.reviewedActionDigest,
        correctionId: null,
        sequence: null,
        reused: !decided.changed,
      };

    const appended = appendAttestationCorrection(db, {
      goalId: input.goalId,
      approvalId: input.approvalId,
      expectedActionDigest: input.reviewedActionDigest,
      explanation: input.explanation,
    });
    return {
      approvalId: input.approvalId,
      status: 'approved',
      actionDigest: input.reviewedActionDigest,
      correctionId: appended.record.correctionId,
      sequence: appended.record.sequence,
      reused: !decided.changed && appended.reused,
    };
  });
  try {
    return decide.immediate();
  } catch (error) {
    if (error instanceof AttestationCorrectionError || error instanceof GoalApprovalError) throw error;
    throw new AttestationCorrectionError(
      'persistence_failed',
      'The correction could not be persisted safely.',
    );
  }
}
