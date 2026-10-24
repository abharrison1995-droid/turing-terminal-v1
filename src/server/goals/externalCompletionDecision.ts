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
import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';
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
 * no proof row, no terminal transition. The completion consumer (externalCompletion.ts) re-reads the decision under the
 * same lock and re-checks its eligibility before it completes the Goal.
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
  'competing_decision',
  'decision_corrupt',
  'decision_persistence_failed',
] as const;

export type ExternalCompletionDecisionErrorCode = (typeof EXTERNAL_COMPLETION_DECISION_ERROR_CODES)[number];

const MESSAGES: Record<ExternalCompletionDecisionErrorCode, string> = {
  decision_input_invalid: 'The completion decision input is invalid.',
  acknowledgement_required:
    'The completion decision requires acknowledging that content preservation was checked at one observed merge.',
  manual_reconciliation_required:
    'This Goal needs manual reconciliation; no completion decision can be recorded.',
  preflight_refused: 'The external completion preflight refused this attestation.',
  reviewed_preflight_changed: 'The reviewed preflight digest no longer matches the current preflight.',
  authority_changed_during_decision: 'Goal authority changed during the completion decision.',
  decision_conflict: 'A different completion decision already exists for this attestation.',
  competing_decision:
    'Another attestation already has an eligible completion decision, so no new decision can be recorded.',
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

/** What the classifier allows the decision to do: return an existing approval, or record a new one. */
type AuthorityOutcome = { reuse: string } | { record: true };

/**
 * Classifies the Goal's completion authority for this decision (completionAuthorityPolicy.ts). Class 6 and class 5
 * refuse as the preflight refuses them. Class 4 refuses as a competing decision, and the option never waives it. Class 2
 * reuses the exact decision the Goal already holds for this attestation, only while that decision is eligible. A
 * corrected (ineligible) exact decision refuses as authority_changed_during_decision, and a different decision for the
 * same attestation refuses as a conflict. Classes 1 and 3 may record. Reuse is reachable only through class 2.
 */
function authorityOutcome(
  db: Db,
  goalId: string,
  attestationId: string,
  actionDigest: string,
): AuthorityOutcome {
  const classification = classifyCompletionAuthority(db, goalId, attestationId);
  if (classification.class === 6)
    throw new ExternalCompletionDecisionError('preflight_refused', 'completion_already_recorded');
  if (classification.class === 5)
    throw new ExternalCompletionDecisionError('preflight_refused', 'completion_history_invalid');
  if (classification.class === 4) throw new ExternalCompletionDecisionError('competing_decision', null);
  if (classification.class === 2) {
    const own = classification.entries.filter((entry) => entry.attestationId === attestationId);
    if (own.some((entry) => entry.actionDigest !== actionDigest))
      throw new ExternalCompletionDecisionError('decision_conflict', null);
    const exact = own.find((entry) => entry.actionDigest === actionDigest);
    // Class 2 has an own entry, and the conflict check above passed, so an exact entry is always present. Refuse rather
    // than record if it ever is not.
    if (!exact) throw new ExternalCompletionDecisionError('decision_conflict', null);
    // An exact decision that a correction made ineligible is not current authority, so it is not reused. Nothing is
    // written: this throw rolls back the decision transaction, and the UNIQUE re-classification path reaches it too.
    if (!exact.eligible)
      throw new ExternalCompletionDecisionError(
        'authority_changed_during_decision',
        'own_decision_ineligible',
      );
    return { reuse: exact.decisionId };
  }
  return { record: true };
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
 * transaction, so a correction committed after that read is detected by the authority check inside the transaction.
 * Everything from the corrupt-row check onward runs under the Goal's completion lock.
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
  if (report.outcome !== 'ready' || identity === null) {
    const reason = report.reasons[0];
    // Preflight check 4 names a competing eligible decision by detail. The decision service reports it by its own code.
    if (reason?.code === 'completion_already_recorded' && reason.detail === 'competing_decision')
      throw new ExternalCompletionDecisionError('competing_decision', null);
    throw new ExternalCompletionDecisionError('preflight_refused', reason?.code ?? null);
  }
  if (report.digest !== input.reviewedPreflightDigest)
    throw new ExternalCompletionDecisionError('reviewed_preflight_changed', null);
  const action = buildExternalCompletionAction({
    ...report.actionFields,
    contentOutcomeAcknowledged: input.acknowledgeContentNotProven,
    userReviewedPreflightDigest: report.digest,
  });
  if (action === null)
    throw new ExternalCompletionDecisionError('preflight_refused', 'preflight_internal_invalid');

  const reviewed: SnapshotIdentity = identity;
  const result = (approvalId: string, reused: boolean): ExternalCompletionDecisionResult => ({
    approvalId,
    actionDigest: action.actionDigest,
    preflightDigest: report.digest,
    status: 'approved',
    reused,
  });

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
  // The classifier runs first, before the snapshot comparison: a competing decision or corrupt history must refuse with
  // its own reason, and an exact duplicate must reuse, even though the snapshot counts completion rows and would
  // otherwise refuse a second call that captured its identity before the first call committed.
  return db
    .transaction((): ExternalCompletionDecisionResult => {
      const outcome = authorityOutcome(db, input.goalId, input.attestationId, action.actionDigest);
      if ('reuse' in outcome) return result(outcome.reuse, true);

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
          const again = authorityOutcome(db, input.goalId, input.attestationId, action.actionDigest);
          if ('reuse' in again) return result(again.reuse, true);
        }
        throw new ExternalCompletionDecisionError('decision_persistence_failed', null);
      }
      return result(approval.id, false);
    })
    .immediate();
}
