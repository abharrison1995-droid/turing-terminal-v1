import { z } from 'zod';
import type { Db } from '../db.js';
import type { GoalApproval } from '../../shared/goals.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
import {
  buildExternalCompletionAction,
  parseExternalCompletionAction,
  type ExternalCompletionActionV1,
} from './externalCompletionProof.js';
import {
  computeExternalCompletionPreflightWithIdentity,
  firstDifference,
  PreflightRefusal,
  readPreflightSnapshotIdentity,
  type SnapshotIdentity,
} from './externalCompletionPreflight.js';
import { isManualReconciliation } from './readModel.js';

/**
 * The explicit user decision that a reviewed external completion may proceed. It records one approved, high-risk
 * `user_confirmation` approval whose detail is the exact completion action. It completes nothing: no status change,
 * no proof row, no terminal transition, and no consumer reads the decision yet. Completion stays inactive until a
 * separately reviewed stage (D.3E) consumes it.
 *
 * The caller supplies only identity: the Goal, the attestation, and the preflight digest the user reviewed. Git is
 * read fresh, the reviewed digest must equal the fresh digest, and the database must still match the identity that the
 * preflight captured before the transaction.
 */

const REASON = 'Complete the Goal from one reviewed external integration (version-2 completion decision).';

export const EXTERNAL_COMPLETION_DECISION_ERROR_CODES = [
  'decision_input_invalid',
  'acknowledgement_required',
  'manual_reconciliation_required',
  'preflight_refused',
  'reviewed_preflight_changed',
  'authority_changed_during_decision',
  'decision_conflict',
  'decision_corrupt',
  'decision_persistence_failed',
] as const;

export type ExternalCompletionDecisionErrorCode = (typeof EXTERNAL_COMPLETION_DECISION_ERROR_CODES)[number];

const MESSAGES: Record<ExternalCompletionDecisionErrorCode, string> = {
  decision_input_invalid: 'The completion decision input is invalid.',
  acknowledgement_required: 'The completion decision requires acknowledging that content is not proven.',
  manual_reconciliation_required:
    'This Goal needs manual reconciliation; no completion decision can be recorded.',
  preflight_refused: 'The external completion preflight refused this attestation.',
  reviewed_preflight_changed: 'The reviewed preflight digest no longer matches the current preflight.',
  authority_changed_during_decision: 'Goal authority changed during the completion decision.',
  decision_conflict: 'A different completion decision already exists for this attestation.',
  decision_corrupt: 'A stored completion decision is invalid, so no new decision can be recorded.',
  decision_persistence_failed: 'The completion decision could not be recorded.',
};

export class ExternalCompletionDecisionError extends Error {
  constructor(
    readonly code: ExternalCompletionDecisionErrorCode,
    readonly detail: string | null,
  ) {
    super(MESSAGES[code]);
    this.name = 'ExternalCompletionDecisionError';
  }
}

const decisionInput = z.strictObject({
  goalId: z.string().uuid(),
  attestationId: z.string().uuid(),
  reviewedPreflightDigest: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledgeContentNotProven: z.boolean(),
  note: z.string().min(1).max(500).optional(),
});

export interface ExternalCompletionDecisionResult {
  approvalId: string;
  actionDigest: string;
  preflightDigest: string;
  status: 'approved';
  reused: boolean;
}

/** Why a stored completion approval is not a valid decision. Each value is a snake_case detail. */
export type ExternalCompletionDecisionInvalidReason =
  'not_completion_approval' | 'schema_invalid' | 'digest_mismatch' | 'approval_fields_invalid';

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
function completionRows(db: Db, goalId: string): { id: string; approval: GoalApproval | null }[] {
  const ids = db
    .prepare(
      `SELECT id FROM goal_approvals
       WHERE goal_id = ?
         AND (external_completion_action_digest IS NOT NULL
              OR detail_json LIKE '%complete_goal_external_integration_v2%')
       ORDER BY created_at, rowid`,
    )
    .all(goalId) as { id: string }[];
  return ids.map(({ id }) => ({ id, approval: readApproval(db, id) }));
}

/** A row is a valid decision only when every field the consumer relies on matches exactly. */
function validateCompletionApproval(approval: GoalApproval | null): Validation {
  if (!approval) return { valid: false, reason: 'schema_invalid' };
  if (approval.externalCompletionActionDigest === undefined)
    return { valid: false, reason: 'not_completion_approval' };
  const parsed = parseExternalCompletionAction(approval.detail);
  if (!parsed.valid) return { valid: false, reason: parsed.reason };
  if (parsed.digest !== approval.externalCompletionActionDigest)
    return { valid: false, reason: 'digest_mismatch' };
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

function assertNoCorruptRows(db: Db, goalId: string): void {
  for (const { approval } of completionRows(db, goalId)) {
    const checked = validateCompletionApproval(approval);
    if (!checked.valid) throw new ExternalCompletionDecisionError('decision_corrupt', checked.reason);
  }
}

/**
 * Inside the decision transaction: a corrupt row refuses everything, a different decision for this attestation refuses,
 * an identical decision is returned for reuse, and a decision for another attestation is ignored.
 */
function classifyCompletionRows(
  db: Db,
  goalId: string,
  attestationId: string,
  actionDigest: string,
): GoalApproval | null {
  let exact: GoalApproval | null = null;
  let conflict = false;
  for (const { approval } of completionRows(db, goalId)) {
    const checked = validateCompletionApproval(approval);
    if (!checked.valid) throw new ExternalCompletionDecisionError('decision_corrupt', checked.reason);
    if (checked.action.attestation.id !== attestationId) continue;
    if (checked.action.actionDigest === actionDigest) exact = approval;
    else conflict = true;
  }
  if (conflict) throw new ExternalCompletionDecisionError('decision_conflict', null);
  return exact;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Records the user's completion decision for one reviewed preflight. The Git observation happens before the database
 * transaction, which is the one read the design cannot move inside; D.3E closes the gap between this decision and
 * a later completion.
 */
export async function recordExternalCompletionDecision(
  db: Db,
  rawInput: unknown,
): Promise<ExternalCompletionDecisionResult> {
  const parsed = decisionInput.safeParse(rawInput);
  if (!parsed.success) throw new ExternalCompletionDecisionError('decision_input_invalid', null);
  const input = parsed.data;
  if (!input.acknowledgeContentNotProven)
    throw new ExternalCompletionDecisionError('acknowledgement_required', null);
  if (isManualReconciliation(db, input.goalId))
    throw new ExternalCompletionDecisionError('manual_reconciliation_required', null);
  assertNoCorruptRows(db, input.goalId);

  const { report, identity } = await computeExternalCompletionPreflightWithIdentity(
    db,
    input.goalId,
    { attestationId: input.attestationId },
    { allowRecordedDecision: true },
  );
  if (report.outcome !== 'ready' || identity === null)
    throw new ExternalCompletionDecisionError('preflight_refused', report.reasons[0]?.code ?? null);
  if (report.digest !== input.reviewedPreflightDigest)
    throw new ExternalCompletionDecisionError('reviewed_preflight_changed', null);
  const action = buildExternalCompletionAction({
    ...report.actionFields,
    userReviewedPreflightDigest: report.digest,
  });
  if (action === null)
    throw new ExternalCompletionDecisionError('preflight_refused', 'preflight_internal_invalid');

  const reviewed: SnapshotIdentity = identity;
  const result = (approval: GoalApproval, reused: boolean): ExternalCompletionDecisionResult => ({
    approvalId: approval.id,
    actionDigest: action.actionDigest,
    preflightDigest: report.digest,
    status: 'approved',
    reused,
  });

  // The exact-duplicate lookup runs before the snapshot comparison: the snapshot counts completion approval rows, so a
  // second call that captured its identity before the first call committed would otherwise be refused instead of
  // returned as a reuse. An exact match was built from this call's fresh Git observation, so reuse stays correct.
  const write = db.transaction((): GoalApproval => {
    const approval = requestGoalApproval(db, {
      goalId: input.goalId,
      gate: 'user_confirmation',
      risk: 'high',
      reason: REASON,
      requestedBy: 'user',
      detail: { ...action },
      externalCompletionActionDigest: action.actionDigest,
    });
    decideGoalApproval(db, {
      goalId: input.goalId,
      approvalId: approval.id,
      decision: 'approved',
      decidedBy: 'user',
      ...(input.note ? { note: input.note } : {}),
    });
    return approval;
  });

  return db.transaction((): ExternalCompletionDecisionResult => {
    const exact = classifyCompletionRows(db, input.goalId, input.attestationId, action.actionDigest);
    if (exact) return result(exact, true);

    let current: SnapshotIdentity;
    try {
      current = readPreflightSnapshotIdentity(db, input.goalId, input.attestationId, {
        allowRecordedDecision: true,
      });
    } catch (error) {
      if (error instanceof PreflightRefusal)
        throw new ExternalCompletionDecisionError('authority_changed_during_decision', error.code);
      throw error;
    }
    const changed = firstDifference(reviewed, current);
    if (changed !== null)
      throw new ExternalCompletionDecisionError('authority_changed_during_decision', changed);

    let approval: GoalApproval;
    try {
      approval = write();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const again = classifyCompletionRows(db, input.goalId, input.attestationId, action.actionDigest);
        if (again) return result(again, true);
      }
      throw new ExternalCompletionDecisionError('decision_persistence_failed', null);
    }
    return result(approval, false);
  })();
}
