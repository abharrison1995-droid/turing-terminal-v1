import type { Db } from '../db.js';
import type {
  GoalExternalCompletionDecisionView,
  GoalExternalCompletionRecord,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { ExternalCompletionError } from './externalCompletion.js';
import { listExternalCompletionDecisions } from './externalCompletionDecision.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';

/**
 * HTTP shaping for the version-2 completion routes. Every function here is read-only: it calls three existing readers and
 * reshapes their output. It owns no authority, writes nothing, and never repairs or trusts an invalid stored row.
 */

/** A listed row is either valid or invalid; `not_found` is only a single-row read result and never appears here. */
type ListedDecision = Exclude<
  ReturnType<typeof listExternalCompletionDecisions>[number],
  { state: 'not_found' }
>;

function toDecisionView(row: ListedDecision): GoalExternalCompletionDecisionView {
  if (row.state === 'valid')
    return {
      approvalId: row.approval.id,
      actionDigest: row.action.actionDigest,
      attestationId: row.action.attestation.id,
      status: 'approved',
      valid: true,
      invalidReason: null,
    };
  return {
    approvalId: row.approvalId,
    actionDigest: null,
    attestationId: null,
    status: null,
    valid: false,
    invalidReason: row.reason,
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
  const views = listExternalCompletionDecisions(db, goalId).flatMap((row) =>
    row.state === 'not_found' ? [] : [toDecisionView(row)],
  );
  const stored = readStoredCompletion(db, goalId);
  const hasInvalidDecision = views.some((view) => !view.valid);
  const hasValidDecision = views.some((view) => view.valid);

  const state: GoalExternalCompletionStatus['state'] =
    hasInvalidDecision || stored.state === 'invalid'
      ? 'invalid'
      : stored.state === 'completed'
        ? 'completed'
        : hasValidDecision
          ? 'decided'
          : 'not_completed';

  const completion: GoalExternalCompletionRecord | null =
    stored.state === 'completed'
      ? {
          proofId: stored.proofId,
          proofDigest: stored.proofDigest,
          approvalId: stored.approvalId,
          actionDigest: stored.actionDigest,
          preflightDigest: stored.preflightDigest,
          observedAt: stored.observedAt,
          completedAt: stored.completedAt,
        }
      : null;

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
    completionStanding: readGoalCompletionStanding(db, goalId),
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
