import type { GoalStatus } from '../../shared/goals.js';
import type { Db } from '../db.js';
import {
  AttestationCorrectionError,
  getAttestationCorrectionStanding,
  type AttestationCorrectionStanding,
  type AttestationCorrectionStandingProjection,
} from './attestationCorrection.js';
import { approvedCompletionPolicyMode } from './approvedCompletionAuthority.js';
import { computeEmptyCorrectionChainIdentity } from './externalCompletionPreflight.js';
import { readExternalCompletionProof } from './externalCompletionProof.js';
import { externalCompletionProofRowCount, readStoredCompletion } from './externalCompletionTerminal.js';

/**
 * Completion standing: the Goal-level classification of a historical external completion.
 *
 * The classifier `classifyCompletionStanding` is pure. The reader `readGoalCompletionStanding` is read-only: it runs one
 * deferred SQLite read transaction, never runs Git, and writes nothing. A consumer must decide whether a completed Goal
 * may be treated as an unqualified success from `claim`, never from the stored Goal status. Only a version-2 completion
 * whose attestation has no correction is `uncontested`, and only that standing is trusted for downstream use. Every
 * other standing, and a legacy or not-completed Goal, is not trusted.
 */

/** The seven Goal-level completion standings. Their order is part of the contract. */
export const COMPLETION_STANDING_VALUES = [
  'uncontested',
  'disputed',
  'withdrawn',
  'superseded',
  'reconciliation_required',
  'invalid_unverified',
  'historical_legacy',
] as const;

export type CompletionStandingValue = (typeof COMPLETION_STANDING_VALUES)[number];

/** The closed set of reasons a completion claim is qualified. `none` is the only value that is not a qualification. */
export const COMPLETION_CLAIM_QUALIFIERS = [
  'none',
  'disputed_by_user',
  'withdrawn_by_user',
  'superseded_by_user',
  'replacement_failed',
  'proof_unverified',
  'legacy_not_v2_attested',
  'not_completed',
] as const;

export type CompletionClaimQualifier = (typeof COMPLETION_CLAIM_QUALIFIERS)[number];

export type CompletionContentPreservation = 'not_proven' | 'not_applicable';

/** The claim a consumer may make about a completed Goal. Derived in one place by `classifyCompletionStanding`. */
export interface GoalCompletionClaim {
  unqualifiedSuccessAllowed: boolean;
  trustedForDownstream: boolean;
  qualifier: CompletionClaimQualifier;
  contentPreservation: CompletionContentPreservation;
}

/**
 * The facts the classifier reads. Each kind pairs only with the standings it can produce, so an impossible pairing
 * cannot be written in typed code.
 */
export type CompletionStandingFacts =
  | { kind: 'not_completed'; standing: null }
  | {
      kind: 'v2';
      standing: 'uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'reconciliation_required';
    }
  | { kind: 'legacy'; standing: 'historical_legacy' }
  | { kind: 'invalid'; standing: 'invalid_unverified' };

/**
 * The qualifier for each standing. `uncontested` is mapped to `proof_unverified` as a fail-closed fallback. The
 * classifier returns `none` for the one trusted case before it reads this map, so the fallback is reached only by a
 * pairing that the facts type does not allow.
 */
const QUALIFIER_BY_STANDING: Record<CompletionStandingValue, CompletionClaimQualifier> = {
  uncontested: 'proof_unverified',
  disputed: 'disputed_by_user',
  withdrawn: 'withdrawn_by_user',
  superseded: 'superseded_by_user',
  reconciliation_required: 'replacement_failed',
  invalid_unverified: 'proof_unverified',
  historical_legacy: 'legacy_not_v2_attested',
};

/**
 * Classifies one Goal's completion facts into its claim. `unqualifiedSuccessAllowed` and `trustedForDownstream` are
 * true only for a version-2 completion with the `uncontested` standing, and they are always equal.
 */
export function classifyCompletionStanding(facts: CompletionStandingFacts): GoalCompletionClaim {
  if (facts.kind === 'not_completed') {
    return {
      unqualifiedSuccessAllowed: false,
      trustedForDownstream: false,
      qualifier: 'not_completed',
      contentPreservation: 'not_applicable',
    };
  }
  const trusted = facts.kind === 'v2' && facts.standing === 'uncontested';
  return {
    unqualifiedSuccessAllowed: trusted,
    trustedForDownstream: trusted,
    qualifier: trusted ? 'none' : QUALIFIER_BY_STANDING[facts.standing],
    contentPreservation: facts.kind === 'v2' ? 'not_proven' : 'not_applicable',
  };
}

/** True only when the Goal's claim allows an unqualified success. Reads the claim alone. */
export function completionStandingAllowsUnqualifiedSuccess(model: { claim: GoalCompletionClaim }): boolean {
  return model.claim.unqualifiedSuccessAllowed;
}

/** True only when the Goal's claim is trusted for downstream use. Reads the claim alone, so it agrees with the predicate above. */
export function completionStandingTrustedForDownstream(model: { claim: GoalCompletionClaim }): boolean {
  return model.claim.trustedForDownstream;
}

/** The only domain error of the reader. Every other failure is classified as an invalid standing, never thrown. */
export const COMPLETION_STANDING_ERROR_CODES = ['goal_not_found'] as const;
export type CompletionStandingErrorCode = (typeof COMPLETION_STANDING_ERROR_CODES)[number];

export class CompletionStandingError extends Error {
  constructor(readonly code: CompletionStandingErrorCode) {
    super(`Completion standing refused: ${code}.`);
    this.name = 'CompletionStandingError';
  }
}

/** The closed reasons the trust classification may carry. Commit 2 emits only the codes listed here. */
export const COMPLETION_STANDING_REASONS = [
  'legacy_completion',
  'reason_code_unclassifiable',
  'legacy_policy_unverified',
  'legacy_with_proof_row',
  'proof_without_completion',
  'proof_integrity_failed',
  'chain_identity_mismatch',
  'integrity_check_failed',
  'correction_mapping_pending',
] as const;
export type CompletionStandingReason = (typeof COMPLETION_STANDING_REASONS)[number];

/** The three historical facts of the Goal row, copied verbatim. A correction never changes them. */
export interface GoalCompletionStatus {
  goalStatus: GoalStatus;
  completedAt: string | null;
  reasonCode: string | null;
}

/** The proof's integrity. `valid` carries the original, immutable proof identity; a correction never changes it. */
export type ProofIntegrity =
  | {
      state: 'valid';
      proofId: string;
      proofDigest: string;
      attestationId: string;
      attestationRecordDigest: string;
      approvalId: string;
      actionDigest: string;
      observedAt: string;
      chainAtProof: { sequence: 0; digest: string; standing: 'active_uncontested' };
    }
  | { state: 'invalid'; reason: string }
  | { state: 'legacy_no_proof' };

type ValidProofIntegrity = Extract<ProofIntegrity, { state: 'valid' }>;

/** The newest correction of the proof's attestation, as the projection exposes it. Always null in commit 2. */
export type CorrectionTip = NonNullable<AttestationCorrectionStandingProjection['tip']>;

/** The current correction standing of the proof's attestation only. Commit 2 fills only the empty chain. */
export interface CorrectionDimension {
  attestationId: string;
  standing: AttestationCorrectionStanding | 'unavailable';
  correctionCount: number;
  tip: CorrectionTip | null;
  correctedAfterCompletion: boolean | null;
  invalidCode: string | null;
  replacement: { attestationId: string; standing: AttestationCorrectionStanding | 'unavailable' } | null;
}

/** The trust and reconciliation classification, derived from the standing alone. */
export interface TrustClassification {
  trust: 'trusted' | 'qualified' | 'untrusted';
  reconciliation: 'none' | 'required';
  reasons: CompletionStandingReason[];
}

/**
 * Another attestation of the same Goal. It says nothing about its own currentness (the reader runs no Git), and it never
 * restores or changes the completion, so `restoresCompletion` is the literal `false`.
 */
export interface OtherAttestation {
  attestationId: string;
  recordDigest: string;
  standing: AttestationCorrectionStanding | 'unavailable';
  isReplacementOfProofAttestation: boolean;
  restoresCompletion: false;
}

interface CompletionStandingCommon {
  schemaVersion: 1;
  goalId: string;
  status: GoalCompletionStatus;
  claim: GoalCompletionClaim;
}

/**
 * The Goal-level standing, as a discriminated union on `kind`. `standing` is null only for a Goal that is not completed.
 * The `invalid` kind is the fail-closed result for every completed Goal whose completion cannot be verified.
 */
export type GoalCompletionStanding =
  | (CompletionStandingCommon & { kind: 'not_completed'; standing: null })
  | (CompletionStandingCommon & {
      kind: 'v2';
      standing: 'uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'reconciliation_required';
      proof: ValidProofIntegrity;
      correction: CorrectionDimension;
      classification: TrustClassification;
      otherAttestations: OtherAttestation[];
      otherAttestationsTruncated: boolean;
    })
  | (CompletionStandingCommon & {
      kind: 'legacy';
      standing: 'historical_legacy';
      proof: { state: 'legacy_no_proof' };
      correction: null;
      classification: TrustClassification;
      otherAttestations: [];
      otherAttestationsTruncated: false;
    })
  | (CompletionStandingCommon & {
      kind: 'invalid';
      standing: 'invalid_unverified';
      proof: ProofIntegrity;
      correction: CorrectionDimension | null;
      classification: TrustClassification;
      otherAttestations: [];
      otherAttestationsTruncated: false;
    });

/** A Goal row as this reader needs it. Read once, inside the read transaction. */
interface GoalRow {
  id: string;
  status: GoalStatus;
  status_reason_code: string | null;
  completed_at: string | null;
  current_definition_version: number | null;
}

/** The most other attestations listed. One more row is read, so truncation is detected without a count. */
const OTHER_ATTESTATION_LIMIT = 20;

/**
 * Derives the completion standing of one Goal from one deferred read transaction. It never runs Git and never writes.
 * A missing Goal throws `CompletionStandingError('goal_not_found')`. Every other outcome is a returned value, and any
 * unexpected failure while classifying becomes an `invalid` standing rather than an unqualified success.
 */
export function readGoalCompletionStanding(db: Db, goalId: string): GoalCompletionStanding {
  return db.transaction((): GoalCompletionStanding => {
    const goal = readGoalRow(db, goalId);
    try {
      return deriveStanding(db, goal);
    } catch {
      return invalidStanding(
        goal,
        { state: 'invalid', reason: 'integrity_check_failed' },
        'integrity_check_failed',
        null,
      );
    }
  })();
}

function readGoalRow(db: Db, goalId: string): GoalRow {
  const row = db
    .prepare(
      'SELECT id, status, status_reason_code, completed_at, current_definition_version FROM goals WHERE id = ?',
    )
    .get(goalId) as GoalRow | undefined;
  if (!row) throw new CompletionStandingError('goal_not_found');
  return row;
}

function deriveStanding(db: Db, goal: GoalRow): GoalCompletionStanding {
  const stored = readStoredCompletion(db, goal.id);
  if (stored.state === 'not_completed') return notCompletedStanding(goal);
  if (stored.state === 'completed') return versionTwoStanding(db, goal, stored.proofId);
  if (stored.reason === 'reason_code_mismatch') return legacyOrUnclassifiable(db, goal);
  return invalidStanding(
    goal,
    { state: 'invalid', reason: stored.reason },
    storedFailureReason(stored.reason),
    null,
  );
}

function statusOf(goal: GoalRow): GoalCompletionStatus {
  return { goalStatus: goal.status, completedAt: goal.completed_at, reasonCode: goal.status_reason_code };
}

function notCompletedStanding(goal: GoalRow): GoalCompletionStanding {
  return {
    kind: 'not_completed',
    schemaVersion: 1,
    goalId: goal.id,
    status: statusOf(goal),
    standing: null,
    claim: classifyCompletionStanding({ kind: 'not_completed', standing: null }),
  };
}

/**
 * A completed Goal whose stored reason is not the external reason. It is `historical_legacy` only when every fact of a
 * version-1 completion holds: the completion_verified reason, no proof row, and the version-1 policy of the current
 * approved definition. Anything else, including a bare status change, is invalid.
 */
function legacyOrUnclassifiable(db: Db, goal: GoalRow): GoalCompletionStanding {
  if (goal.status_reason_code !== 'completion_verified')
    return invalidStanding(
      goal,
      { state: 'invalid', reason: 'reason_code_unclassifiable' },
      'reason_code_unclassifiable',
      null,
    );
  if (externalCompletionProofRowCount(db, goal.id) !== 0)
    return invalidStanding(
      goal,
      { state: 'invalid', reason: 'legacy_with_proof_row' },
      'legacy_with_proof_row',
      null,
    );
  const mode =
    goal.current_definition_version === null
      ? null
      : approvedCompletionPolicyMode(db, goal.id, goal.current_definition_version);
  if (mode !== 'legacy_v1')
    return invalidStanding(
      goal,
      { state: 'invalid', reason: 'legacy_policy_unverified' },
      'legacy_policy_unverified',
      null,
    );
  return {
    kind: 'legacy',
    schemaVersion: 1,
    goalId: goal.id,
    status: statusOf(goal),
    standing: 'historical_legacy',
    proof: { state: 'legacy_no_proof' },
    correction: null,
    claim: classifyCompletionStanding({ kind: 'legacy', standing: 'historical_legacy' }),
    classification: { trust: 'qualified', reconciliation: 'none', reasons: ['legacy_completion'] },
    otherAttestations: [],
    otherAttestationsTruncated: false,
  };
}

function versionTwoStanding(db: Db, goal: GoalRow, proofId: string): GoalCompletionStanding {
  const read = readExternalCompletionProof(db, goal.id, proofId);
  // The stored-completion read has just verified this proof, so a failed re-read is an integrity failure, not a state.
  if (read.state !== 'valid') throw new Error('a verified stored completion has no readable proof');
  const proof = read.proof;
  const attestationId = proof.attestation.id;
  const validProof: ValidProofIntegrity = {
    state: 'valid',
    proofId,
    proofDigest: proof.proofDigest,
    attestationId,
    attestationRecordDigest: proof.attestation.recordDigest,
    approvalId: proof.decision.approvalId,
    actionDigest: proof.decision.actionDigest,
    observedAt: proof.gitProof.observedAt,
    chainAtProof: { sequence: 0, digest: proof.correctionChain.digest, standing: 'active_uncontested' },
  };
  const emptyChain = computeEmptyCorrectionChainIdentity({
    attestationId,
    attestationRecordDigest: proof.attestation.recordDigest,
  });
  if (proof.correctionChain.sequence !== 0 || proof.correctionChain.digest !== emptyChain.digest)
    return invalidStanding(
      goal,
      { state: 'invalid', reason: 'chain_identity_mismatch' },
      'chain_identity_mismatch',
      null,
    );

  let projection: AttestationCorrectionStandingProjection | null = null;
  try {
    projection = getAttestationCorrectionStanding(db, goal.id, attestationId);
  } catch (error) {
    // The original attestation is missing or invalid. Commit 2 has no mapping for that, so it is pending like any
    // other correction result. Any other error is unexpected and is classified by the caller.
    if (!(error instanceof AttestationCorrectionError)) throw error;
  }
  // Commit 2 maps only the empty chain. Commit 3 replaces this fail-closed placeholder with the disputed, withdrawn,
  // superseded and reconciliation mapping, and removes the `correction_mapping_pending` reason with it.
  if (
    projection === null ||
    projection.standing !== 'active_uncontested' ||
    projection.correctionCount !== 0 ||
    projection.tip !== null
  )
    return invalidStanding(goal, validProof, 'correction_mapping_pending', null);

  return {
    kind: 'v2',
    schemaVersion: 1,
    goalId: goal.id,
    status: statusOf(goal),
    standing: 'uncontested',
    claim: classifyCompletionStanding({ kind: 'v2', standing: 'uncontested' }),
    proof: validProof,
    correction: {
      attestationId,
      standing: 'active_uncontested',
      correctionCount: 0,
      tip: null,
      correctedAfterCompletion: null,
      invalidCode: null,
      replacement: null,
    },
    classification: { trust: 'trusted', reconciliation: 'none', reasons: [] },
    ...readOtherAttestations(db, goal.id, attestationId),
  };
}

/** Other attestations of the Goal, in insertion order, bounded. Standing is caught per attestation, never thrown. */
function readOtherAttestations(
  db: Db,
  goalId: string,
  proofAttestationId: string,
): { otherAttestations: OtherAttestation[]; otherAttestationsTruncated: boolean } {
  // One row past the limit tells whether the list is truncated.
  const rows = db
    .prepare(
      'SELECT id, record_digest FROM goal_external_integration_attestations WHERE goal_id = ? AND id <> ? ORDER BY rowid LIMIT 21',
    )
    .all(goalId, proofAttestationId) as { id: string; record_digest: string }[];
  return {
    otherAttestations: rows.slice(0, OTHER_ATTESTATION_LIMIT).map((row) => ({
      attestationId: row.id,
      recordDigest: row.record_digest,
      standing: otherAttestationStanding(db, goalId, row.id),
      isReplacementOfProofAttestation: false,
      restoresCompletion: false,
    })),
    otherAttestationsTruncated: rows.length > OTHER_ATTESTATION_LIMIT,
  };
}

function otherAttestationStanding(
  db: Db,
  goalId: string,
  attestationId: string,
): AttestationCorrectionStanding | 'unavailable' {
  try {
    return getAttestationCorrectionStanding(db, goalId, attestationId).standing;
  } catch {
    return 'unavailable';
  }
}

function invalidStanding(
  goal: GoalRow,
  proof: ProofIntegrity,
  reason: CompletionStandingReason,
  correction: CorrectionDimension | null,
): GoalCompletionStanding {
  return {
    kind: 'invalid',
    schemaVersion: 1,
    goalId: goal.id,
    status: statusOf(goal),
    standing: 'invalid_unverified',
    proof,
    correction,
    claim: classifyCompletionStanding({ kind: 'invalid', standing: 'invalid_unverified' }),
    classification: { trust: 'untrusted', reconciliation: 'none', reasons: [reason] },
    otherAttestations: [],
    otherAttestationsTruncated: false,
  };
}

/** Maps a stored-completion failure code to a classification reason. Every other code is a failed proof. */
function storedFailureReason(reason: string): CompletionStandingReason {
  if (reason === 'integrity_check_failed') return 'integrity_check_failed';
  if (reason === 'proof_without_completion') return 'proof_without_completion';
  return 'proof_integrity_failed';
}
