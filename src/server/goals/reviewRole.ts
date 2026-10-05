import type { GoalReviewKind } from '../../shared/goals.js';

/** The three reviewer roles a Goal review run can draw its route from. */
export type GoalReviewRole = 'routine_reviewer' | 'milestone_reviewer' | 'final_reviewer';

export const GOAL_REVIEW_ROLES: readonly GoalReviewRole[] = [
  'routine_reviewer',
  'milestone_reviewer',
  'final_reviewer',
];

export const isGoalReviewRole = (value: unknown): value is GoalReviewRole =>
  typeof value === 'string' && (GOAL_REVIEW_ROLES as readonly string[]).includes(value);

/**
 * The ONE server-owned mapping from a review kind to the reviewer role that performs it. Periodic, repeated-failure and
 * scope-change reviews are routine; milestone and final reviews have their own roles. Nothing else (no model output,
 * route, prompt or request field) may choose a role.
 */
const ROLE_FOR_KIND: Readonly<Record<GoalReviewKind, GoalReviewRole>> = {
  periodic: 'routine_reviewer',
  repeated_failure: 'routine_reviewer',
  scope_change: 'routine_reviewer',
  milestone: 'milestone_reviewer',
  final: 'final_reviewer',
};

export function reviewRoleForKind(kind: GoalReviewKind): GoalReviewRole {
  const role = ROLE_FOR_KIND[kind];
  if (!role) throw new Error(`Unknown review kind: ${String(kind)}.`);
  return role;
}
