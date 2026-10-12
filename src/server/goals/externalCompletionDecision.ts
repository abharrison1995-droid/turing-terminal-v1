import { z } from 'zod';
import type { Db } from '../db.js';
import type { GoalApproval } from '../../shared/goals.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import {
  computeExternalCompletionPreflightWithIdentity,
  firstDifference,
  PreflightRefusal,
  readPreflightSnapshotIdentity,
  type SnapshotIdentity,
} from './externalCompletionPreflight.js';
import { completionRows, validateCompletionApproval } from './externalCompletionDecisionRows.js';
import { isManualReconciliation } from './readModel.js';
import { withGoalCompletionLock } from './goalCompletionLock.js';

// The readers live in the leaf module externalCompletionDecisionRows.ts; these re-exports keep every importer unchanged.
export {
  listExternalCompletionDecisions,
  readExternalCompletionDecision,
  type ExternalCompletionDecisionInvalidReason,
  type ExternalCompletionDecisionRead,
} from './externalCompletionDecisionRows.js';

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

function isObservationChanged(report: { outcome: string; reasons: { code: string }[] }): boolean {
  return report.outcome === 'refused' && report.reasons[0]?.code === 'observation_changed';
}

/**
 * One preflight observation. A refusal with `observation_changed` means a Goal row moved during the Git read, usually
 * because an identical decision committed meanwhile. That refusal is retried once, immediately and deterministically.
 * A second refusal is returned unchanged.
 */
export async function observeReviewedPreflight(db: Db, goalId: string, attestationId: string) {
  const observe = () =>
    computeExternalCompletionPreflightWithIdentity(
      db,
      goalId,
      { attestationId },
      { allowRecordedDecision: true },
    );
  const first = await observe();
  return isObservationChanged(first.report) ? observe() : first;
}

/**
 * Records the user's completion decision for one reviewed preflight. The Git observation happens before the database
 * transaction, which is the one read the design cannot move inside; D.3E closes the gap between this decision and
 * a later completion. Everything from the corrupt-row check onward runs under the Goal's completion lock.
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
  return withGoalCompletionLock(input.goalId, () => recordLocked(db, input));
}

async function recordLocked(
  db: Db,
  input: z.infer<typeof decisionInput>,
): Promise<ExternalCompletionDecisionResult> {
  assertNoCorruptRows(db, input.goalId);

  const { report, identity } = await observeReviewedPreflight(db, input.goalId, input.attestationId);
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

  // BEGIN IMMEDIATE: a cross-connection writer cannot make this deferred read upgrade fail with SQLITE_BUSY_SNAPSHOT.
  return db
    .transaction((): ExternalCompletionDecisionResult => {
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
    })
    .immediate();
}
