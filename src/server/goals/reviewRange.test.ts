import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cleanupRepoFixtures, goalRepoFixture, reportOf, simpleDefinition } from './repoKit.js';
import { selectReviewRange } from './reviewCycle.js';
import { completeReview, createReview } from './reviews.js';

afterEach(cleanupRepoFixtures);

const completedReview = async (fx: ReturnType<typeof goalRepoFixture>) => {
  const { id } = await createReview(fx.db, {
    goalId: fx.goalId,
    definitionVersion: 1,
    reviewKind: 'final',
  });
  completeReview(fx.db, { reviewId: id, report: reportOf({ verdict: 'pass' }) });
  return fx.head();
};

describe('selectReviewRange', () => {
  it('uses the whole history for a final review, even after earlier reviews', async () => {
    const fx = goalRepoFixture();
    await completedReview(fx);
    fx.advance({ 'src/a.ts': 'a' }, 'more');
    expect(await selectReviewRange(fx.db, fx.goalId, 'final')).toBeNull();
  });

  it('starts at the previous completed review for since_last_review kinds, and at null without one', async () => {
    const definition = simpleDefinition();
    definition.review.periodic = { everyNExecutionCycles: 3, reviewerCount: 2, scope: 'since_last_review' };
    const fx = goalRepoFixture({ definition });
    for (const kind of ['periodic', 'repeated_failure', 'scope_change'] as const)
      expect(await selectReviewRange(fx.db, fx.goalId, kind)).toBeNull();
    const reviewed = await completedReview(fx);
    fx.advance({ 'src/b.ts': 'b' }, 'later');
    for (const kind of ['periodic', 'repeated_failure', 'scope_change'] as const)
      expect(await selectReviewRange(fx.db, fx.goalId, kind)).toBe(reviewed);
  });

  it('uses the full history for a periodic review whose policy scope is full_diff', async () => {
    const definition = simpleDefinition();
    definition.review.periodic = { everyNExecutionCycles: 3, reviewerCount: 2, scope: 'full_diff' };
    const fx = goalRepoFixture({ definition });
    await completedReview(fx);
    fx.advance({ 'src/b.ts': 'b' }, 'later');
    expect(await selectReviewRange(fx.db, fx.goalId, 'periodic')).toBeNull();
    // The other kinds still use the last review.
    expect(await selectReviewRange(fx.db, fx.goalId, 'repeated_failure')).not.toBeNull();
  });

  it('drops a previous review commit that is no longer in the Goal history', async () => {
    const fx = goalRepoFixture();
    const first = fx.head();
    fx.advance({ 'src/b.ts': 'b' }, 'second');
    await completedReview(fx);
    // Rewind the Goal ref behind the reviewed commit: the reviewed commit is no longer an ancestor of the head.
    fx.git('update-ref', `refs/heads/turing/goal/${fx.goalId}`, first);
    expect(await selectReviewRange(fx.db, fx.goalId, 'repeated_failure')).toBeNull();
  });

  it('starts a milestone review at the base of its first succeeded execution cycle', async () => {
    const fx = goalRepoFixture();
    const base = fx.head();
    const milestoneId = fx.milestoneId('m1');
    const insert = (status: string, sequence: number, commit: string) =>
      fx.db
        .prepare(
          `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, milestone_id, created_at, finished_at)
           VALUES (?, ?, 1, ?, 'execution', 't', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')`,
        )
        .run(randomUUID(), fx.goalId, sequence, status, commit, milestoneId);
    insert('failed', 1, fx.orphanCommit());
    insert('succeeded', 2, base);
    fx.advance({ 'src/b.ts': 'b' }, 'work');
    expect(await selectReviewRange(fx.db, fx.goalId, 'milestone', { milestoneKey: 'm1' })).toBe(base);
    expect(await selectReviewRange(fx.db, fx.goalId, 'milestone', { milestoneKey: 'unknown' })).toBeNull();
    expect(await selectReviewRange(fx.db, fx.goalId, 'milestone')).toBeNull();
  });
});
