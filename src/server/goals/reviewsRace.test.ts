import { afterEach, describe, expect, it, vi } from 'vitest';

// A deterministic seam in the asynchronous Git boundary: after the real repository read resolves, a test-supplied
// hook runs, standing in for "an amendment was approved while createReview was awaiting Git". No timers involved.
const hooks = vi.hoisted(() => ({ afterResolve: undefined as undefined | (() => void) }));
vi.mock('./repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repository.js')>();
  return {
    ...original,
    resolveGoalRepository: async (...args: Parameters<typeof original.resolveGoalRepository>) => {
      const result = await original.resolveGoalRepository(...args);
      hooks.afterResolve?.();
      return result;
    },
  };
});

import { approveDefinition, beginAmendment } from './definitions.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  newFinding,
  reportOf,
  type GoalRepoFixture,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { applyReviewFindings } from './findings.js';
import { completeReview, createReview, listReviews } from './reviews.js';

afterEach(() => {
  hooks.afterResolve = undefined;
  cleanupRepoFixtures();
});

function amendAndApprove(fx: GoalRepoFixture): number {
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  const amended = structuredClone(fx.definition);
  amended.limits.maxExecutionCycles += 1;
  const { version } = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user', definition: amended });
  approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
  return version;
}

describe('createReview authority race', () => {
  it(
    'inserts nothing when the definition changes between the first check and the insert',
    async () => {
      const fx = goalRepoFixture();
      hooks.afterResolve = () => {
        hooks.afterResolve = undefined;
        expect(amendAndApprove(fx)).toBe(2);
      };
      await expect(
        createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' }),
      ).rejects.toMatchObject({ name: 'GoalReviewError', code: 'definition_not_current' });
      expect(listReviews(fx.db, fx.goalId)).toEqual([]);
      expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_reviews').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'inserts nothing when the repository head moves in the same window (unchanged behaviour)',
    async () => {
      const fx = goalRepoFixture();
      hooks.afterResolve = () => {
        hooks.afterResolve = undefined;
        fx.advance({ 'src/later.ts': 'x' });
      };
      await expect(
        createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' }),
      ).rejects.toMatchObject({ code: 'repository_changed' });
      expect(listReviews(fx.db, fx.goalId)).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'still creates when nothing moved',
    async () => {
      const fx = goalRepoFixture();
      await expect(
        createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' }),
      ).resolves.toMatchObject({ reviewedToTree: fx.tree() });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not invalidate a review inserted while current: it completes as history and cannot mutate findings',
    async () => {
      const fx = goalRepoFixture();
      const { id } = await createReview(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        reviewKind: 'final',
      });
      amendAndApprove(fx);
      completeReview(fx.db, {
        reviewId: id,
        report: reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding()] as never }),
      });
      expect(listReviews(fx.db, fx.goalId).map((row) => row.status)).toEqual(['completed']);
      await expect(applyReviewFindings(fx.db, { reviewId: id })).rejects.toMatchObject({
        code: 'review_not_current',
      });
      expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_findings').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
