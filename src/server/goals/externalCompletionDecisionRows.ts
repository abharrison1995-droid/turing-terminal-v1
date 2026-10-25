import type { Db } from '../db.js';
import type { GoalApproval } from '../../shared/goals.js';
import { getGoalApproval } from './approvals.js';
import { parseExternalCompletionAction, type ExternalCompletionActionV1 } from './externalCompletionProof.js';

/**
 * Read-only access to the completion-decision rows of a Goal. This is a leaf module: it imports neither the preflight
 * nor the decision writer, so the completion authority classifier can read these rows without a dependency cycle.
 * The readers were moved here unchanged from externalCompletionDecision.ts, which re-exports the public ones.
 */

/** The filter that selects every row claiming to be a completion decision. Shared by the reader and the counter. */
const COMPLETION_ROWS_WHERE = `goal_id = ?
         AND (external_completion_action_digest IS NOT NULL
              OR detail_json LIKE '%complete_goal_external_integration_v2%')`;

/** Why a stored completion approval is not a valid decision. Each value is a snake_case detail. */
export type ExternalCompletionDecisionInvalidReason =
  | 'not_completion_approval'
  | 'schema_invalid'
  | 'digest_mismatch'
  | 'approval_fields_invalid'
  | 'content_outcome_unacknowledged';

export type ExternalCompletionDecisionRead =
  | { state: 'not_found' }
  | { state: 'invalid'; approvalId: string; reason: ExternalCompletionDecisionInvalidReason }
  | { state: 'valid'; approval: GoalApproval; action: ExternalCompletionActionV1 };

type Validation =
  | { valid: true; action: ExternalCompletionActionV1 }
  | { valid: false; reason: ExternalCompletionDecisionInvalidReason };

/** Reads one approval row; an unparseable row returns null rather than throwing. */
function readApproval(db: Db, approvalId: string): GoalApproval | null {
  try {
    return getGoalApproval(db, approvalId) ?? null;
  } catch {
    return null;
  }
}

/** Every row of this Goal that is, or claims to be, a completion decision. */
export function completionRows(db: Db, goalId: string): { id: string; approval: GoalApproval | null }[] {
  const ids = db
    .prepare(
      `SELECT id FROM goal_approvals
       WHERE ${COMPLETION_ROWS_WHERE}
       ORDER BY created_at, rowid`,
    )
    .all(goalId) as { id: string }[];
  return ids.map(({ id }) => ({ id, approval: readApproval(db, id) }));
}

/** How many rows of this Goal are, or claim to be, a completion decision. Reads no approval contents. */
export function countCompletionRows(db: Db, goalId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM goal_approvals
       WHERE ${COMPLETION_ROWS_WHERE}`,
    )
    .get(goalId) as { n: number };
  return row.n;
}

/** A row is a valid decision only when every field the consumer relies on matches exactly. */
export function validateCompletionApproval(approval: GoalApproval | null): Validation {
  if (!approval) return { valid: false, reason: 'schema_invalid' };
  if (approval.externalCompletionActionDigest === undefined)
    return { valid: false, reason: 'not_completion_approval' };
  const parsed = parseExternalCompletionAction(approval.detail);
  if (!parsed.valid) return { valid: false, reason: parsed.reason };
  if (parsed.digest !== approval.externalCompletionActionDigest)
    return { valid: false, reason: 'digest_mismatch' };
  if (
    parsed.action.contentVerificationDigest !== undefined &&
    parsed.action.contentOutcomeAcknowledged !== true
  )
    return { valid: false, reason: 'content_outcome_unacknowledged' };
  if (
    approval.gate !== 'user_confirmation' ||
    approval.risk !== 'high' ||
    approval.requestedBy !== 'user' ||
    approval.status !== 'approved' ||
    approval.decidedBy !== 'user' ||
    approval.respondedAt === null ||
    approval.intentDigest !== undefined ||
    approval.externalIntegrationActionDigest !== undefined ||
    approval.attestationCorrectionActionDigest !== undefined ||
    parsed.action.goalId !== approval.goalId
  )
    return { valid: false, reason: 'approval_fields_invalid' };
  return { valid: true, action: parsed.action };
}

/** Reads one completion decision of a Goal. Read-only; it never repairs or trusts an invalid row. */
export function readExternalCompletionDecision(
  db: Db,
  goalId: string,
  approvalId: string,
): ExternalCompletionDecisionRead {
  const owner = db.prepare('SELECT goal_id FROM goal_approvals WHERE id = ?').get(approvalId) as
    { goal_id: string } | undefined;
  if (!owner || owner.goal_id !== goalId) return { state: 'not_found' };
  const approval = readApproval(db, approvalId);
  const checked = validateCompletionApproval(approval);
  if (!checked.valid) return { state: 'invalid', approvalId, reason: checked.reason };
  return { state: 'valid', approval: approval!, action: checked.action };
}

/** Every completion decision row of a Goal, valid or invalid, in creation order. */
export function listExternalCompletionDecisions(db: Db, goalId: string): ExternalCompletionDecisionRead[] {
  return completionRows(db, goalId).map(({ id, approval }) => {
    const checked = validateCompletionApproval(approval);
    return checked.valid
      ? { state: 'valid', approval: approval!, action: checked.action }
      : { state: 'invalid', approvalId: id, reason: checked.reason };
  });
}
