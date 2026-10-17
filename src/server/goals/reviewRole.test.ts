import { describe, expect, it } from 'vitest';
import type { GoalReviewKind } from '../../shared/goals.js';
import { GOAL_REVIEW_ROLES, isGoalReviewRole, reviewRoleForKind } from './reviewRole.js';

describe('review kind to reviewer role', () => {
  it.each<[GoalReviewKind, string]>([
    ['periodic', 'routine_reviewer'],
    ['repeated_failure', 'routine_reviewer'],
    ['scope_change', 'routine_reviewer'],
    ['milestone', 'milestone_reviewer'],
    ['final', 'final_reviewer'],
  ])('maps %s to %s', (kind, role) => {
    expect(reviewRoleForKind(kind)).toBe(role);
    expect(isGoalReviewRole(role)).toBe(true);
  });

  it('refuses an unknown kind and recognises only the three reviewer roles', () => {
    expect(() => reviewRoleForKind('bogus' as GoalReviewKind)).toThrow(/Unknown review kind/);
    expect([...GOAL_REVIEW_ROLES]).toEqual(['routine_reviewer', 'milestone_reviewer', 'final_reviewer']);
    for (const value of ['implementer', 'orchestrator', '', undefined, 3, null])
      expect(isGoalReviewRole(value)).toBe(false);
  });
});
