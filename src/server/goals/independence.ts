import type { IndependencePolicy } from '../../shared/goals.js';
import { lineageOf, type ModelLineage } from './modelFamily.js';
import type { EffectiveIdentityKind } from './routeIdentity.js';

/**
 * Pure final-review independence evaluator (design Q7). It compares exact normalised model keys and, for
 * `different-family`, known family lineage. It never calls a model, and unknown identity can only make independence
 * harder to establish, never easier.
 */

export type AuthorityRole = IndependencePolicy['against'][number];

/** A model that authored work the reviewer must be independent of. */
export interface AuthorityModel {
  role: AuthorityRole;
  configuredModelId: string;
  /** `resolved_model_id` from canonical usage telemetry, when the route actually ran. */
  resolvedModelId?: string | null;
  identityKind: EffectiveIdentityKind;
}

export interface IndependenceCandidate {
  configuredModelId: string;
  resolvedModelId?: string | null;
  identityKind: EffectiveIdentityKind;
}

export const INDEPENDENCE_REASONS = [
  'policy_none',
  'no_authority',
  'candidate_identity_unproven',
  'authority_identity_unproven',
  'identity_conflict',
  'same_model',
  'same_family',
  'family_unknown',
  'established',
] as const;
export type IndependenceReason = (typeof INDEPENDENCE_REASONS)[number];

export interface IndependenceSubject {
  configuredKey: string | null;
  resolvedKey: string | null;
  familyKey: string | null;
  identityKind: EffectiveIdentityKind;
}

export interface IndependenceResult {
  established: boolean;
  /** False only for policy `none`: independence is not required and not claimed. */
  required: boolean;
  policy: IndependencePolicy['finalReview'];
  candidate: IndependenceSubject;
  comparedAgainst: Array<IndependenceSubject & { role: AuthorityRole }>;
  reasonCode: IndependenceReason;
  /** True when the evidence proves the candidate is NOT independent (as opposed to merely unproven). */
  conflict: boolean;
}

const subject = (lineage: ModelLineage, identityKind: EffectiveIdentityKind): IndependenceSubject => ({
  configuredKey: lineage.configuredKey,
  resolvedKey: lineage.resolvedKey,
  familyKey: lineage.familyKey,
  identityKind,
});

/**
 * The key a model is compared by. A floating/unknown configured id proves nothing on its own, so it counts only
 * through trusted resolved telemetry. A pinned id whose telemetry reports a different model is a conflict, never a
 * convenient choice between the two.
 */
function effectiveKey(
  lineage: ModelLineage,
  identityKind: EffectiveIdentityKind,
): { key: string | null; conflict: boolean } {
  if (identityKind === 'pinned') {
    if (lineage.resolvedKey && lineage.configuredKey && lineage.resolvedKey !== lineage.configuredKey)
      return { key: null, conflict: true };
    return { key: lineage.resolvedKey ?? lineage.configuredKey, conflict: false };
  }
  return { key: lineage.resolvedKey, conflict: false };
}

export function evaluateIndependence(input: {
  policy: IndependencePolicy['finalReview'];
  against: IndependencePolicy['against'];
  candidate: IndependenceCandidate;
  authority: readonly AuthorityModel[];
}): IndependenceResult {
  const candidateLineage = lineageOf(input.candidate.configuredModelId, input.candidate.resolvedModelId);
  const candidateSubject = subject(candidateLineage, input.candidate.identityKind);
  const relevant = input.authority.filter((entry) => input.against.includes(entry.role));
  const compared = relevant.map((entry) => ({
    role: entry.role,
    ...subject(lineageOf(entry.configuredModelId, entry.resolvedModelId), entry.identityKind),
  }));
  const result = (
    established: boolean,
    reasonCode: IndependenceReason,
    conflict = false,
  ): IndependenceResult => ({
    established,
    required: input.policy !== 'none',
    policy: input.policy,
    candidate: candidateSubject,
    comparedAgainst: compared,
    reasonCode,
    conflict,
  });
  if (input.policy === 'none') return result(false, 'policy_none');
  if (relevant.length === 0) return result(false, 'no_authority');

  const candidateKey = effectiveKey(candidateLineage, input.candidate.identityKind);
  // Contradicting telemetry makes the identity untrustworthy; that is unproven, not a proven overlap.
  if (candidateKey.conflict) return result(false, 'identity_conflict');
  // Compare against every authority first: a proven overlap is a conflict even when another comparison is unproven.
  let unproven: IndependenceReason | null = candidateKey.key ? null : 'candidate_identity_unproven';
  for (const entry of relevant) {
    const lineage = lineageOf(entry.configuredModelId, entry.resolvedModelId);
    const authorityKey = effectiveKey(lineage, entry.identityKind);
    if (authorityKey.conflict) return result(false, 'identity_conflict');
    if (!authorityKey.key || !candidateKey.key) {
      unproven ??= authorityKey.key ? null : 'authority_identity_unproven';
      continue;
    }
    if (authorityKey.key === candidateKey.key) return result(false, 'same_model', true);
    if (input.policy === 'different-family') {
      const candidateFamily = candidateLineage.familyKey;
      const authorityFamily = lineage.familyKey;
      if (candidateFamily && authorityFamily && candidateFamily === authorityFamily)
        return result(false, 'same_family', true);
      if (!candidateFamily || !authorityFamily) unproven ??= 'family_unknown';
    }
  }
  if (unproven) return result(false, unproven);
  return result(true, 'established');
}

/**
 * True when every authority compared against has a proven model key (and, for `different-family`, a known family).
 * The explicit floating-reviewer allowance excuses only the reviewer's own unproven identity, never uncertainty about
 * the work it must be independent of.
 */
export function authorityIdentitiesKnown(result: IndependenceResult): boolean {
  if (result.comparedAgainst.length === 0) return false;
  return result.comparedAgainst.every((entry) => {
    const key =
      entry.identityKind === 'pinned' ? (entry.resolvedKey ?? entry.configuredKey) : entry.resolvedKey;
    return key !== null && (result.policy !== 'different-family' || entry.familyKey !== null);
  });
}
