import type { Db } from '../db.js';
import type {
  GoalCompletionStanding,
  GoalExternalCompletionDecisionView,
  GoalExternalCompletionStatus,
  GoalExternalCompletionStatusRecord,
} from '../../shared/goalApi.js';
import {
  classifyCompletionAuthority,
  type CompletionAuthorityClassification,
  type CompletionAuthorityEntry,
} from './completionAuthorityPolicy.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { ExternalCompletionError } from './externalCompletion.js';
import { listExternalCompletionDecisions } from './externalCompletionDecision.js';

/**
 * HTTP shaping for the version-2 completion routes. Every function here is read-only: it calls existing readers and
 * reshapes their output. It owns no authority, writes nothing, and never repairs or trusts an invalid stored row. The
 * status is derived from the completion standing, never from the historical stored completion, which can still read as
 * completed after a correction.
 */

/** A listed row is either valid or invalid; `not_found` is only a single-row read result and never appears here. */
type ListedDecision = Exclude<
  ReturnType<typeof listExternalCompletionDecisions>[number],
  { state: 'not_found' }
>;

/**
 * The view of one listed decision row. Eligibility and correction standing come from the authority classifier's entry for
 * the same row. A valid row with no intact entry fails closed: it is reported as an invalid view, never as eligible.
 * `authority.reason` names a whole-Goal failure (the row cap or an unreadable history), which the entry is missing for.
 */
function toDecisionView(
  row: ListedDecision,
  entry: CompletionAuthorityEntry | undefined,
  authority: CompletionAuthorityClassification,
): GoalExternalCompletionDecisionView {
  if (row.state === 'valid' && entry?.integrity === 'ok')
    return {
      approvalId: row.approval.id,
      actionDigest: row.action.actionDigest,
      attestationId: row.action.attestation.id,
      status: 'approved',
      valid: true,
      invalidReason: null,
      eligibility: entry.eligible ? 'eligible' : 'ineligible',
      correctionStanding: entry.standing,
      ...(row.action.contentVerificationStatus === undefined
        ? {}
        : { contentVerificationStatus: row.action.contentVerificationStatus }),
    };
  if (row.state === 'valid')
    return {
      approvalId: row.approval.id,
      actionDigest: null,
      attestationId: null,
      status: null,
      valid: false,
      invalidReason:
        entry?.integrity ??
        (authority.reason === 'too_many_decisions' || authority.reason === 'history_unreadable'
          ? authority.reason
          : 'row_unreadable'),
      eligibility: 'invalid',
      correctionStanding: null,
    };
  return {
    approvalId: row.approvalId,
    actionDigest: null,
    attestationId: null,
    status: null,
    valid: false,
    invalidReason: row.reason,
    eligibility: 'invalid',
    correctionStanding: null,
  };
}

/**
 * The completion identity of a Goal whose standing is a version-2 completion with a valid proof, read from the standing.
 * Null otherwise. The standing does not carry the reviewed preflight digest, so this record has none.
 */
function toCompletionRecord(standing: GoalCompletionStanding): GoalExternalCompletionStatusRecord | null {
  if (standing.kind !== 'v2' || standing.proof.state !== 'valid' || standing.status.completedAt === null)
    return null;
  return {
    proofId: standing.proof.proofId,
    proofDigest: standing.proof.proofDigest,
    approvalId: standing.proof.approvalId,
    actionDigest: standing.proof.actionDigest,
    ...(standing.proof.contentVerificationDigest === undefined
      ? {}
      : { contentVerificationDigest: standing.proof.contentVerificationDigest }),
    ...(standing.proof.contentVerificationStatus === undefined
      ? {}
      : { contentVerificationStatus: standing.proof.contentVerificationStatus }),
    attestationId: standing.proof.attestationId,
    observedAt: standing.proof.observedAt,
    completedAt: standing.status.completedAt,
  };
}

/**
 * The completion status of one Goal, read-only. `actionDigest`, when given, filters `decisions` and `completion` to the one
 * exact action; `state` still describes the whole Goal, so a filter that matches nothing is not an error.
 */
export function readExternalCompletionStatus(
  db: Db,
  goalId: string,
  actionDigest: string | null,
): GoalExternalCompletionStatus {
  // The classifier's entries do not depend on the selected attestation (only its class and policy digest do), so the
  // selection is empty and only `entries` and `reason` are read. It never throws and writes nothing.
  const authority = classifyCompletionAuthority(db, goalId, '');
  const entries = new Map(authority.entries.map((entry) => [entry.decisionId, entry]));
  const views = listExternalCompletionDecisions(db, goalId).flatMap((row) => {
    if (row.state === 'not_found') return [];
    const approvalId = row.state === 'valid' ? row.approval.id : row.approvalId;
    return [toDecisionView(row, entries.get(approvalId), authority)];
  });
  const standing = readGoalCompletionStanding(db, goalId);
  const hasInvalidDecision = views.some((view) => !view.valid);
  const hasEligibleDecision = views.some((view) => view.eligibility === 'eligible');

  const state: GoalExternalCompletionStatus['state'] =
    hasInvalidDecision || standing.kind === 'invalid' || authority.class === 5
      ? 'invalid'
      : standing.kind === 'v2' && standing.claim.contentPreservation === 'mismatch'
        ? 'content_mismatch'
        : standing.kind === 'v2' && standing.standing === 'uncontested'
          ? 'completed'
          : standing.kind === 'v2'
            ? 'contested'
            : standing.kind === 'legacy'
              ? 'legacy'
              : hasEligibleDecision
                ? 'decided'
                : 'not_completed';

  const completion = toCompletionRecord(standing);

  return {
    goalId,
    state,
    decisions:
      actionDigest === null
        ? views
        : views.filter((view) => view.valid && view.actionDigest === actionDigest),
    completion:
      completion !== null && (actionDigest === null || completion.actionDigest === actionDigest)
        ? completion
        : null,
    completionStanding: standing,
  };
}

/** The stored decision that one exact action digest names. Every value is read from the stored, validated row. */
export interface DecisionByActionDigest {
  approvalId: string;
  actionDigest: string;
  attestationId: string;
  reviewedPreflightDigest: string;
}

/**
 * The one completion decision whose exact action digest is `digest`. The client supplies only the digest; the attestation
 * and the reviewed preflight digest come from the stored row. Any invalid row on the Goal fails closed, as the service does.
 */
export function findDecisionByActionDigest(db: Db, goalId: string, digest: string): DecisionByActionDigest {
  let found: DecisionByActionDigest | null = null;
  for (const row of listExternalCompletionDecisions(db, goalId)) {
    if (row.state !== 'valid')
      throw new ExternalCompletionError(
        'decision_corrupt',
        row.state === 'invalid' ? row.reason : 'not_found',
      );
    if (row.action.actionDigest === digest)
      found = {
        approvalId: row.approval.id,
        actionDigest: row.action.actionDigest,
        attestationId: row.action.attestation.id,
        reviewedPreflightDigest: row.action.userReviewedPreflightDigest,
      };
  }
  if (found === null) throw new ExternalCompletionError('decision_not_found', null);
  return found;
}
