import type { GoalReviewKind } from '../../shared/goals.js';

export const GOAL_REVIEW_KINDS: readonly GoalReviewKind[] = [
  'periodic',
  'milestone',
  'repeated_failure',
  'scope_change',
  'final',
];

/**
 * What a review cycle was created to do. It is persisted write-once in `goal_cycles.outcome_json.reviewPlan` (the
 * cycle's identity columns cannot carry it) and is re-read and re-validated on every tick; a corrupt or missing plan
 * fails the cycle closed, never silently defaulted.
 */
export interface ReviewPlan {
  reviewKind: GoalReviewKind;
  /** Server-derived and clamped when the cycle was created; the executor recomputes and refuses a mismatch. */
  reviewerCount: number;
  /** The honest start of the reviewed range (null = the whole relevant history). `createReview` proves ancestry. */
  reviewedFromCommit: string | null;
}

export const REVIEW_PLAN_LIMITS = { maxReviewers: 8 } as const;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The strict normal form of a persisted plan, or null when it is absent or not exactly valid. */
export function readReviewPlan(outcome: unknown): ReviewPlan | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const raw = (outcome as { reviewPlan?: unknown }).reviewPlan;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const plan = raw as Record<string, unknown>;
  if (Object.keys(plan).sort().join(',') !== 'reviewKind,reviewedFromCommit,reviewerCount') return null;
  if (!(GOAL_REVIEW_KINDS as readonly unknown[]).includes(plan.reviewKind)) return null;
  const count = plan.reviewerCount;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > REVIEW_PLAN_LIMITS.maxReviewers
  )
    return null;
  const from = plan.reviewedFromCommit;
  if (from !== null && (typeof from !== 'string' || !COMMIT.test(from))) return null;
  return { reviewKind: plan.reviewKind as GoalReviewKind, reviewerCount: count, reviewedFromCommit: from };
}
