import type {
  GoalAttestationCorrectionDecisionRecorded,
  GoalAttestationCorrectionRequested,
  GoalExternalCompletionCompleted,
  GoalExternalCompletionDecisionRecorded,
} from '../../shared/goalApi';
import { ApiError, UnreadableResponseError } from '../api';

/**
 * Unknown-outcome handling for the Goal writes (D.4E). A write's outcome is unknown when no response arrived, the server
 * answered 5xx, or a successful response does not have the shape the client reads. A committed write may then exist on
 * the server, so the client must read the saved state and must never assume either success or failure. A 4xx is
 * definite: nothing was written.
 */

/** True when the write may have happened. Only the write paths call this; a non-API error there is a lost response. */
export function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof UnreadableResponseError) return true;
  if (error instanceof ApiError) return error.status >= 500;
  return true;
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;
type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isDigest = (value: unknown): value is string => typeof value === 'string' && HEX_DIGEST.test(value);

/** Returns the value as the expected type, or throws when its shape is not the one the client reads. */
function checkShape<T>(value: unknown, shape: (fields: Fields) => boolean): T {
  if (!isRecord(value) || !shape(value)) throw new UnreadableResponseError(null);
  return value as T;
}

/** A completion decision: the ids and both digests the client holds, and the approved status. */
export const expectCompletionDecision = (value: unknown) =>
  checkShape<GoalExternalCompletionDecisionRecorded>(
    value,
    (fields) =>
      isText(fields.approvalId) &&
      isDigest(fields.actionDigest) &&
      isDigest(fields.preflightDigest) &&
      fields.status === 'approved',
  );

/** A Goal completion. The server answers with the `reused` flag; the rest is read from the status, not the response. */
export const expectCompletion = (value: unknown) =>
  checkShape<GoalExternalCompletionCompleted>(value, (fields) => typeof fields.reused === 'boolean');

/** A correction request: the pending gate's id and digest, and the kind and reason the server reports for it. */
export const expectCorrectionRequested = (value: unknown) =>
  checkShape<GoalAttestationCorrectionRequested>(
    value,
    (fields) =>
      isText(fields.approvalId) &&
      isDigest(fields.actionDigest) &&
      fields.status === 'pending' &&
      typeof fields.reused === 'boolean' &&
      isRecord(fields.detail) &&
      isText(fields.detail.correctionKind) &&
      isText(fields.detail.reasonCode) &&
      (fields.detail.explanationDigest === null || isDigest(fields.detail.explanationDigest)),
  );

/** A correction decision: the approval it decided and its outcome. */
export const expectCorrectionDecided = (value: unknown) =>
  checkShape<GoalAttestationCorrectionDecisionRecorded>(
    value,
    (fields) => isText(fields.approvalId) && (fields.status === 'approved' || fields.status === 'denied'),
  );
