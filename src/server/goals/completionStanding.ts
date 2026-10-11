/**
 * Completion standing: the Goal-level classification of a historical external completion. This module is pure. It has
 * no database access and imports nothing, so it can be tested without a database and cannot write.
 *
 * A consumer must decide whether a completed Goal may be treated as an unqualified success from `claim`, never from the
 * stored Goal status. Only a version-2 completion whose attestation has no correction is `uncontested`, and only that
 * standing is trusted for downstream use. Every other standing, and a legacy or not-completed Goal, is not trusted.
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
