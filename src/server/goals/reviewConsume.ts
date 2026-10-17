import type { Db } from '../db.js';
import { loadDefinitionVersion } from './definitions.js';
import { recordEvidence } from './evidence.js';
import type { CycleRow } from './cycles.js';
import type { GoalReviewRow } from './reviews.js';
import { listVerifiers } from './verifierDigest.js';

/** True when the review is for the Goal's current definition version AND current integration head (so it may act). */
export function isReviewCurrent(db: Db, review: GoalReviewRow): boolean {
  const goal = db
    .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
    .get(review.goalId) as { v: number | null } | undefined;
  const head = (
    db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(review.goalId) as
      { integration_head: string | null } | undefined
  )?.integration_head;
  return goal?.v === review.definitionVersion && head === review.reviewedToCommit;
}

/**
 * Records `review_verdict` evidence for a consumed, CURRENT completed review, through the existing `recordEvidence`
 * (which derives the verdict from the stored review and reuses the row when a restart repeats it). Only milestone and
 * final reviews can satisfy a verifier, and only a verifier of exactly that review kind; a milestone review satisfies
 * only the criteria its milestone owns. A stale review (an older definition or head) is lifecycle- and evidence-inert.
 * Returns the number of verifiers recorded or reused.
 */
export async function recordReviewEvidence(
  db: Db,
  input: { review: GoalReviewRow; cycle: CycleRow; runId: string; now: string },
): Promise<number> {
  const { review, cycle } = input;
  if (review.status !== 'completed') return 0;
  if (review.reviewKind !== 'milestone' && review.reviewKind !== 'final') return 0;
  if (!isReviewCurrent(db, review)) return 0;
  const definition = loadDefinitionVersion(db, review.goalId, review.definitionVersion)?.definition;
  if (!definition) return 0;
  const milestone =
    review.reviewKind === 'milestone'
      ? definition.milestones.find((item) => item.key === cycle.milestoneKey)
      : undefined;
  if (review.reviewKind === 'milestone' && !milestone) return 0;
  let recorded = 0;
  for (const verifier of listVerifiers(definition)) {
    if (verifier.spec.kind !== 'review_verdict' || verifier.spec.reviewKind !== review.reviewKind) continue;
    if (milestone && !milestone.criteria.includes(verifier.criterionKey)) continue;
    await recordEvidence(db, {
      goalId: review.goalId,
      definitionVersion: review.definitionVersion,
      criterionKey: verifier.criterionKey,
      verifierDigest: verifier.digest,
      kind: 'review_verdict',
      reviewId: review.id,
      cycleId: cycle.id,
      runId: input.runId,
      now: input.now,
    });
    recorded += 1;
  }
  return recorded;
}
