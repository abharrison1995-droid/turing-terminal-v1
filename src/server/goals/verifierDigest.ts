import { createHash } from 'node:crypto';
import type {
  GoalDefinition,
  GoalEvidenceKind,
  VerificationKind,
  VerificationSpec,
} from '../../shared/goals.js';
import { canonicalJson } from './definitionHash.js';

/** The evidence kind a verifier is satisfied by. `run_result` is deliberately absent: it satisfies nothing. */
export const VERIFIER_EVIDENCE_KIND: Readonly<Record<VerificationKind, GoalEvidenceKind>> = {
  build: 'build_result',
  test: 'test_result',
  lint: 'lint_result',
  file_exists: 'artifact',
  review_verdict: 'review_verdict',
  commit_on_branch: 'commit',
  user_confirmation: 'user_confirmation',
};

/**
 * Deterministic digest of one criterion verifier: SHA-256 over canonical JSON of the criterion key and the complete
 * verifier spec. Any semantic change (command, path, review kind, confirmation freshness or prompt) changes the digest;
 * so does moving a verifier to another criterion. Evidence is bound to this digest, never to a caller's claim.
 */
export function verifierDigest(criterionKey: string, verifier: VerificationSpec): string {
  return createHash('sha256').update(canonicalJson({ criterionKey, verifier })).digest('hex');
}

export interface CurrentVerifier {
  criterionKey: string;
  digest: string;
  spec: VerificationSpec;
  required: boolean;
}

/** Every verifier of a definition, in definition order, with duplicate (criterion, spec) pairs collapsed. */
export function listVerifiers(definition: GoalDefinition): CurrentVerifier[] {
  const seen = new Set<string>();
  const result: CurrentVerifier[] = [];
  for (const criterion of definition.contract.successCriteria)
    for (const spec of criterion.verification) {
      const digest = verifierDigest(criterion.key, spec);
      if (seen.has(digest)) continue;
      seen.add(digest);
      result.push({ criterionKey: criterion.key, digest, spec, required: criterion.required });
    }
  return result;
}

export function findVerifier(
  definition: GoalDefinition,
  criterionKey: string,
  digest: string,
): CurrentVerifier | undefined {
  return listVerifiers(definition).find(
    (verifier) => verifier.criterionKey === criterionKey && verifier.digest === digest,
  );
}
