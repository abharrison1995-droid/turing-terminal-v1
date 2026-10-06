import type { ReviewIndependence } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import type { GoalReviewRow } from './reviews.js';
import { reproveRoleResolution } from './routing.js';
import { evaluateIndependence, type IndependenceResult } from './independence.js';
import { loadAuthoritySet, readStoredResolutions } from './routeResolution.js';

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
  // The route itself is authentic from here on. What remains is the POST-RUN outcome: it is history, never an
  // authority failure. It is re-derived with the canonical Stage-5 evaluator over the work that actually entered the
  // Goal and the identity the review run actually resolved to, and it can only ever make independence harder to
  // establish than the route-time claim: contradicting telemetry is a conflict, never a convenient choice.
  const policy = stored.definition.routing.independence;
  let result: Pick<IndependenceResult, 'established' | 'reasonCode' | 'conflict' | 'required'> & {
    candidate: IndependenceResult['candidate'];
    comparedAgainst: IndependenceResult['comparedAgainst'];
  } = claim;
  if (policy.finalReview !== 'none') {
    const resolvedIds = reviewResolvedModels(db, review.runId);
    const authority = loadAuthoritySet(db, review.goalId, policy.against);
    const evaluations = (resolvedIds.length > 0 ? resolvedIds : [null]).map((resolvedModelId) =>
      evaluateIndependence({
        policy: policy.finalReview,
        against: policy.against,
        candidate: {
          configuredModelId: resolution.selected.configuration.modelId ?? '',
          resolvedModelId,
          identityKind: resolution.selected.identityKind,
        },
        authority,
      }),
    );
    // Several distinct resolved models in one review run contradict each other: report the worst, never the best.
    const worst =
      evaluations.find((entry) => entry.conflict) ?? evaluations.find((entry) => !entry.established);
    const post = worst ?? evaluations[0]!;
    // The route-time claim must also have established independence (a floating candidate whose identity was unproven
    // at selection stays unestablished even if telemetry later names a model).
    result =
      post.established && !claim.established
        ? { ...post, established: false, reasonCode: claim.reasonCode }
        : post;
  }
  return {
    ok: true,
    independence: {
      established: result.established,
      policy: claim.policy,
      detail: {
        reasonCode: result.reasonCode,
        required: result.required,
        conflict: result.conflict,
        candidate: result.candidate,
        comparedAgainst: result.comparedAgainst.slice(0, MAX_COMPARED),
        selectedIdentityHash: resolution.selected.identityHash,
      },
    },
  };
}

/** Distinct `resolved_model_id` values the review run's usage telemetry reported (bounded). */
function reviewResolvedModels(db: Db, runId: string | null): string[] {
  if (!runId) return [];
  return (
    db
      .prepare(
        'SELECT DISTINCT resolved_model_id AS id FROM usage_events WHERE run_id = ? AND resolved_model_id IS NOT NULL LIMIT 8',
      )
      .all(runId) as Array<{ id: string }>
  ).map((row) => row.id);
}
