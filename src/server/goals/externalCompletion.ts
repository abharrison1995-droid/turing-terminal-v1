import { z } from 'zod';
import type { Db } from '../db.js';
import { activeWorkBlocker } from './activeWork.js';
import {
  listExternalCompletionDecisions,
  observeReviewedPreflight,
  readExternalCompletionDecision,
} from './externalCompletionDecision.js';
import {
  buildExternalCompletionAction,
  buildExternalCompletionProof,
  type ExternalCompletionProofV1,
} from './externalCompletionProof.js';
import { firstDifference } from './externalCompletionPreflight.js';
import {
  consumeExternalCompletionDecision,
  ExternalCompletionTerminalError,
  readStoredCompletion,
  selectCompletionDecision,
  type StoredCompletion,
  type ValidatedCompletionDecision,
} from './externalCompletionTerminal.js';
import { GoalCompletionLockError, withGoalCompletionLock } from './goalCompletionLock.js';
import { notifyGoalTransition } from './stateMachine.js';

/**
 * The internal, route-less service that completes one version-2 Goal from one approved user decision. It has no HTTP
 * route and no caller outside its tests. Nothing here is reachable from `transitionGoal`: the terminal write is the
 * proof-bound writer in externalCompletionTerminal.ts, reached only through `consumeExternalCompletionDecision`.
 *
 * Order: parse the input, refuse an open transaction, take the Goal's completion lock, replay a stored completion, select
 * the one approved decision, refuse any active work, take a fresh read-only preflight, confirm the destination and the
 * reviewed digest against the decision, build the proof from the fresh observation, and then consume the decision inside
 * one immediate transaction. Git runs only before that transaction; the transaction itself never runs Git.
 *
 * `user` means an authenticated app control, not a verified person. The completed Goal records that a user confirmed the
 * decision, and the proof records that content preservation was not proven.
 */

const CODE_DETAIL = /^[a-z0-9_]{1,100}$/;

export const EXTERNAL_COMPLETION_ERROR_CODES = [
  'completion_input_invalid',
  'acknowledgement_required',
  'completion_internal_state',
  'completion_busy',
  'decision_not_found',
  'decision_corrupt',
  'preflight_refused',
  'reviewed_preflight_changed',
  'destination_changed',
  'decision_action_mismatch',
  'authority_changed_during_completion',
  'completion_persistence_failed',
  'completion_conflict',
  'completion_corrupt',
  'completion_read_failed',
  // Terminal refusals, passed through under their own codes so the cause is not renamed.
  'completion_proof_required',
  'goal_not_found',
  'goal_not_running',
  'completion_already_recorded',
  'decision_conflict',
  'proof_invalid',
  'proof_action_mismatch',
  'goal_work_in_flight',
] as const;

export type ExternalCompletionErrorCode = (typeof EXTERNAL_COMPLETION_ERROR_CODES)[number];

const MESSAGES: Record<ExternalCompletionErrorCode, string> = {
  completion_input_invalid: 'The external completion input is invalid.',
  acknowledgement_required: 'The external completion requires acknowledging that content is not proven.',
  completion_internal_state: 'The external completion cannot run in the current internal state.',
  completion_busy: 'Too many completion requests are waiting for this Goal. Try again shortly.',
  decision_not_found: 'No approved completion decision matches this attestation and reviewed preflight.',
  decision_corrupt: 'A stored completion decision is invalid, so the Goal cannot be completed.',
  preflight_refused: 'The external completion preflight refused this attestation.',
  reviewed_preflight_changed: 'The reviewed preflight digest no longer matches the current preflight.',
  destination_changed: 'The destination no longer matches the decided tip.',
  decision_action_mismatch: 'The rebuilt completion action does not match the decided action.',
  authority_changed_during_completion: 'Goal authority changed during the external completion.',
  completion_persistence_failed: 'The external completion could not be recorded, so nothing changed.',
  completion_conflict: 'This Goal is already completed by a different decision.',
  completion_corrupt: 'The stored completion of this Goal fails verification.',
  completion_read_failed: 'The Goal state could not be read, so nothing changed.',
  completion_proof_required: 'A completion needs a validated decision and its proof.',
  goal_not_found: 'The Goal does not exist.',
  goal_not_running: 'The Goal is not running.',
  completion_already_recorded: 'A completion has already been recorded for this Goal.',
  decision_conflict: 'A different completion decision already exists for this attestation.',
  proof_invalid: 'The completion proof is invalid.',
  proof_action_mismatch: 'The completion proof does not match the decided action.',
  goal_work_in_flight: 'The Goal has work in flight, so it cannot be completed.',
};

export class ExternalCompletionError extends Error {
  readonly detail: string | null;

  constructor(
    readonly code: ExternalCompletionErrorCode,
    detail: string | null,
  ) {
    super(MESSAGES[code]);
    this.name = 'ExternalCompletionError';
    this.detail = detail !== null && CODE_DETAIL.test(detail) ? detail : null;
  }
}

const completionInput = z.strictObject({
  goalId: z.string().uuid(),
  attestationId: z.string().uuid(),
  reviewedPreflightDigest: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledgeContentNotProven: z.boolean(),
});

type CompletionInput = z.infer<typeof completionInput>;

/** The stored completion, as `readStoredCompletion` verifies it. */
export type CompletedStoredCompletion = Extract<StoredCompletion, { state: 'completed' }>;

export interface ExternalCompletionResult {
  /** True when this call found a completion that was already stored and returned it without any write. */
  reused: boolean;
  completion: CompletedStoredCompletion;
}

/**
 * Completes one running version-2 Goal from its approved decision. Idempotent for the same attestation and reviewed
 * digest: a stored completion is returned with `reused: true` and nothing is written.
 */
export async function completeGoalFromExternalDecision(
  db: Db,
  rawInput: unknown,
): Promise<ExternalCompletionResult> {
  const parsed = completionInput.safeParse(rawInput);
  if (!parsed.success) throw new ExternalCompletionError('completion_input_invalid', null);
  const input = parsed.data;
  if (!input.acknowledgeContentNotProven) throw new ExternalCompletionError('acknowledgement_required', null);
  // Git must never run while a caller holds a SQLite transaction, so the service refuses to start inside one.
  if (db.inTransaction) throw new ExternalCompletionError('completion_internal_state', 'open_transaction');
  try {
    return await withGoalCompletionLock(input.goalId, () => completeLocked(db, input));
  } catch (error) {
    if (error instanceof GoalCompletionLockError) throw new ExternalCompletionError('completion_busy', null);
    throw error;
  }
}

/**
 * Maps a failed read to a refusal. A refusal already raised keeps its code. A terminal refusal keeps its own code and
 * detail. Any other failure, a SQLite error for example, becomes `completion_read_failed` with the read's name.
 */
function readOrRefuse<T>(readName: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ExternalCompletionError) throw error;
    if (error instanceof ExternalCompletionTerminalError)
      throw new ExternalCompletionError(error.code, error.detail);
    throw new ExternalCompletionError('completion_read_failed', readName);
  }
}

/**
 * The refusal for a stored completion that does not verify. A missing Goal is `goal_not_found`. A Goal completed by a
 * path other than this service (a legacy or another reason code) is a `completion_conflict`, not corruption. Anything
 * else is `completion_corrupt` and is never reused.
 */
function replayRefusal(reason: string): ExternalCompletionError {
  if (reason === 'goal_not_found') return new ExternalCompletionError('goal_not_found', null);
  if (reason === 'reason_code_mismatch') return new ExternalCompletionError('completion_conflict', null);
  return new ExternalCompletionError('completion_corrupt', reason);
}

async function completeLocked(db: Db, input: CompletionInput): Promise<ExternalCompletionResult> {
  // Replay first, before any Git work: a stored completion is the answer for this request or a conflict.
  const replay = readStoredCompletion(db, input.goalId);
  if (replay.state === 'invalid') throw replayRefusal(replay.reason);
  if (replay.state === 'completed') {
    const stored = readOrRefuse('decision_read', () =>
      readExternalCompletionDecision(db, input.goalId, replay.approvalId),
    );
    if (
      stored.state !== 'valid' ||
      stored.action.attestation.id !== input.attestationId ||
      replay.preflightDigest !== input.reviewedPreflightDigest
    )
      throw new ExternalCompletionError('completion_conflict', null);
    return { reused: true, completion: replay };
  }

  const decision = readOrRefuse('decision_select', () => selectDecision(db, input));

  // Active work is checked here, before Git, through the shared predicate. The preflight report does not carry it.
  const blocker = readOrRefuse('active_work', () => activeWorkBlocker(db, input.goalId));
  if (blocker !== null) throw new ExternalCompletionError('preflight_refused', blocker);

  const reviewed = await observeReviewedPreflight(db, input.goalId, input.attestationId);
  const { report, identity, observation, postGitIdentity } = reviewed;
  if (report.outcome !== 'ready')
    throw new ExternalCompletionError('preflight_refused', report.reasons[0]?.code ?? null);
  if (identity === null || observation === null || postGitIdentity === null || report.actionFields === null)
    throw new ExternalCompletionError('preflight_refused', 'preflight_internal_invalid');

  // The fresh observation must be the exact tip the user decided on (D1), and the reviewed digest must still be the one
  // the decision names. The rebuilt action must match the decided action digest.
  const { action } = decision;
  if (observation.ref !== action.destination.ref)
    throw new ExternalCompletionError('destination_changed', 'ref');
  if (observation.commit !== action.destination.observedCommit)
    throw new ExternalCompletionError('destination_changed', 'commit');
  if (observation.tree !== action.destination.observedTree)
    throw new ExternalCompletionError('destination_changed', 'tree');
  if (observation.objectFormat !== action.repository.objectFormat)
    throw new ExternalCompletionError('destination_changed', 'object_format');
  if (report.digest !== action.userReviewedPreflightDigest)
    throw new ExternalCompletionError('reviewed_preflight_changed', null);
  const rebuilt = buildExternalCompletionAction({
    ...report.actionFields,
    userReviewedPreflightDigest: report.digest,
  });
  if (rebuilt === null || rebuilt.actionDigest !== action.actionDigest)
    throw new ExternalCompletionError('decision_action_mismatch', null);

  // Captured once. The writer uses this value for completed_at and both event timestamps.
  const now = new Date().toISOString();
  if (new Date(now).toISOString() !== now)
    throw new ExternalCompletionError('completion_internal_state', 'clock_not_canonical');
  const proof = proofForDecision(decision, observation.observedAt);

  // The identity the transaction compares is the one captured after Git. The preflight proved it equal to the pre-Git
  // identity; that equality is asserted here as well, so the value is genuinely post-Git.
  const drift = firstDifference(identity, postGitIdentity);
  if (drift !== null) throw new ExternalCompletionError('authority_changed_during_completion', drift);

  const progress = { written: false };
  try {
    db.transaction(() => {
      consumeExternalCompletionDecision(db, decision, proof, postGitIdentity, now);
      progress.written = true;
    }).immediate();
  } catch (error) {
    throw mapWriteFailure(error, progress);
  }

  notifyGoalTransition(db, input.goalId, 'running', 'completed');
  const stored = readStoredCompletion(db, input.goalId);
  if (stored.state !== 'completed')
    throw new ExternalCompletionError(
      'completion_corrupt',
      stored.state === 'invalid' ? stored.reason : 'not_completed',
    );
  return { reused: false, completion: stored };
}

/**
 * The one completion decision that matches this attestation and reviewed digest. A corrupt decision row on the Goal
 * refuses everything, because it could hide a second decision. The chosen row is re-read before it is branded.
 */
function selectDecision(db: Db, input: CompletionInput): ValidatedCompletionDecision {
  const matches: string[] = [];
  for (const row of listExternalCompletionDecisions(db, input.goalId)) {
    if (row.state !== 'valid')
      throw new ExternalCompletionError(
        'decision_corrupt',
        row.state === 'invalid' ? row.reason : 'not_found',
      );
    if (
      row.action.attestation.id === input.attestationId &&
      row.action.userReviewedPreflightDigest === input.reviewedPreflightDigest
    )
      matches.push(row.approval.id);
  }
  if (matches.length === 0) throw new ExternalCompletionError('decision_not_found', null);
  if (matches.length > 1) throw new ExternalCompletionError('decision_corrupt', 'multiple_decisions');
  const approvalId = matches[0]!;
  const reread = readExternalCompletionDecision(db, input.goalId, approvalId);
  if (reread.state !== 'valid')
    throw new ExternalCompletionError(
      'decision_corrupt',
      reread.state === 'invalid' ? reread.reason : 'not_found',
    );
  return selectCompletionDecision(db, input.goalId, approvalId);
}

/** The proof body that the decided action and the fresh observation imply, built by the production proof builder. */
function proofForDecision(
  decision: ValidatedCompletionDecision,
  observedAt: string,
): ExternalCompletionProofV1 {
  const { action, approval } = decision;
  const proof = buildExternalCompletionProof({
    schemaVersion: 1,
    kind: 'turing_goal_external_completion_proof',
    contractVersion: 2,
    goalId: action.goalId,
    definition: action.definition,
    evaluation: {
      integrationHead: action.source.commit,
      integrationTree: action.source.tree,
      verificationEvidenceDigest: action.verificationEvidenceDigest,
      milestoneIdentityDigest: action.milestoneIdentityDigest,
      findingIdentityDigest: action.findingIdentityDigest,
      finalReviewId: action.review.finalReviewId,
      finalAcceptanceApprovalId: action.review.acceptanceApprovalId,
    },
    handoff: action.handoff,
    attestation: action.attestation,
    repository: action.repository,
    source: action.source,
    destination: action.destination,
    gitProof: { ...action.proof, observedAt },
    decision: {
      approvalId: approval.id,
      actionDigest: action.actionDigest,
      decidedAt: approval.respondedAt,
      classification: 'user_confirmed_historical_external_integration',
    },
    proofLimitations: { contentPreservation: 'not_proven' },
    correctionChain: action.correctionChain,
    userReviewedPreflightDigest: action.userReviewedPreflightDigest,
  });
  if (proof === null) throw new ExternalCompletionError('completion_internal_state', 'proof_build_invalid');
  return proof;
}

/**
 * Maps a failure from the immediate transaction. Terminal refusals keep their codes and details. A busy database at
 * BEGIN or COMMIT is `database_busy`. Any other SQLite failure is `rolled_back`, or `commit_failed` when the consumer had
 * finished and only the commit failed. The transaction has already rolled back when this runs.
 */
function mapWriteFailure(error: unknown, progress: { written: boolean }): ExternalCompletionError {
  if (error instanceof ExternalCompletionError) return error;
  if (error instanceof ExternalCompletionTerminalError)
    return new ExternalCompletionError(error.code, error.detail);
  if (isSqliteBusy(error))
    return new ExternalCompletionError('completion_persistence_failed', 'database_busy');
  return new ExternalCompletionError(
    'completion_persistence_failed',
    progress.written ? 'commit_failed' : 'rolled_back',
  );
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_BUSY')
  );
}
