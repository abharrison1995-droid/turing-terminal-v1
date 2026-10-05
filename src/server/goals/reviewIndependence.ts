import type { ReviewIndependence } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import type { GoalReviewRow } from './reviews.js';
import { reproveRoleResolution } from './routing.js';
import { readStoredResolutions } from './routeResolution.js';

export type DerivedIndependence =
  { ok: true; independence: ReviewIndependence | undefined } | { ok: false; code: string };

const MAX_COMPARED = 8;

/**
 * Final-review independence, derived on the server from the cycle's persisted `final_reviewer` route resolution. The
 * model never supplies it. The stored resolution is semantically re-proven against the approved definition it was
 * made under (the same proof used when it was persisted and when it is read back); if it no longer proves, the review
 * fails closed rather than manufacturing independence. Non-final reviews record none.
 */
export function deriveReviewIndependence(db: Db, review: GoalReviewRow): DerivedIndependence {
  if (review.reviewKind !== 'final') return { ok: true, independence: undefined };
  const cycle = db
    .prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ? AND goal_id = ?')
    .get(review.cycleId, review.goalId) as { json: string | null } | undefined;
  const resolution = cycle ? readStoredResolutions(cycle.json).final_reviewer : undefined;
  if (!resolution) return { ok: false, code: 'independence_resolution_missing' };
  const stored = loadDefinitionVersion(db, review.goalId, review.definitionVersion);
  if (!stored || stored.status !== 'approved' || !verifyDefinitionHash(stored))
    return { ok: false, code: 'independence_definition_invalid' };
  const failure = reproveRoleResolution(
    {
      definitionVersion: stored.version,
      definitionHash: stored.definitionHash,
      routingPolicy: stored.definition.routing,
      limits: stored.definition.limits,
    },
    'final_reviewer',
    resolution,
  );
  if (failure) return { ok: false, code: `independence_reproof_${failure}`.slice(0, 80) };
  const claim = resolution.independence;
  if (!claim) return { ok: false, code: 'independence_claim_missing' };
  return {
    ok: true,
    independence: {
      established: claim.established,
      policy: claim.policy,
      detail: {
        reasonCode: claim.reasonCode,
        required: claim.required,
        conflict: claim.conflict,
        candidate: claim.candidate,
        comparedAgainst: claim.comparedAgainst.slice(0, MAX_COMPARED),
        selectedIdentityHash: resolution.selected.identityHash,
      },
    },
  };
}
