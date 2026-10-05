import { afterAll, describe, expect, it } from 'vitest';
import { listGoalEvents } from './events.js';
import { cleanupRepoFixtures, goalRepoFixture, newFinding, reportOf } from './repoKit.js';
import { GoalReviewError, closeReview, completeReview, createReview, getReview } from './reviews.js';

afterAll(cleanupRepoFixtures);

const final = (fx: ReturnType<typeof goalRepoFixture>) =>
  createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' });

describe('createReview', () => {
  it('binds the review to the commit and tree read from Git, never from the caller', async () => {
    const fx = goalRepoFixture();
    const created = await final(fx);
    expect(created).toMatchObject({ reviewedToCommit: fx.head(), reviewedToTree: fx.tree() });
    const row = getReview(fx.db, created.id)!;
    expect(row).toMatchObject({ status: 'pending', verdict: null, report: null, completedAt: null });
    expect(row.reviewedToTree).toBe(fx.tree());
  });

  it('keeps the binding immutable', async () => {
    const fx = goalRepoFixture();
    const { id } = await final(fx);
    for (const column of ['reviewed_to_tree', 'reviewed_to_commit', 'goal_id', 'definition_version'])
      expect(() =>
        fx.db.prepare(`UPDATE goal_reviews SET ${column} = ? WHERE id = ?`).run('x', id),
      ).toThrow();
  });

  it('refuses unknown ownership, a missing milestone for a milestone review and a foreign start commit', async () => {
    const fx = goalRepoFixture();
    const other = goalRepoFixture();
    const refused = (input: Record<string, unknown>, code: string) =>
      expect(
        createReview(fx.db, {
          goalId: fx.goalId,
          definitionVersion: 1,
          reviewKind: 'final',
          ...input,
        } as never),
      ).rejects.toMatchObject({ code });
    await refused({ goalId: 'ghost' }, 'goal_not_found');
    await refused({ definitionVersion: 5 }, 'definition_not_found');
    await refused({ reviewKind: 'milestone' }, 'milestone_required');
    await refused({ milestoneId: other.milestoneId('m1') }, 'milestone_not_found');
    await refused({ cycleId: 'ghost' }, 'cycle_not_found');
    await refused({ runId: 'ghost' }, 'run_not_in_goal');
    await refused({ reviewedFromCommit: fx.sideCommit({ 'src/s.ts': 's' }) }, 'from_commit_invalid');
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_reviews').get()).toEqual({ n: 0 });
  });

  it('reports an unusable Goal ref', async () => {
    const fx = goalRepoFixture();
    fx.git('update-ref', '-d', `refs/heads/turing/goal/${fx.goalId}`);
    await expect(final(fx)).rejects.toMatchObject({ code: 'repository_unavailable' });
  });
});

describe('completeReview', () => {
  it('completes once from a valid report and derives blocking', async () => {
    const fx = goalRepoFixture();
    const { id } = await final(fx);
    const row = completeReview(fx.db, {
      reviewId: id,
      report: reportOf({ verdict: 'block' }),
      now: '2026-01-02T00:00:00Z',
    });
    expect(row).toMatchObject({
      status: 'completed',
      verdict: 'block',
      blocking: true,
      completedAt: '2026-01-02T00:00:00Z',
    });
    expect(listGoalEvents(fx.db, fx.goalId).at(-1)).toMatchObject({
      type: 'review_completed',
      payload: { reviewId: id, verdict: 'block', blocking: true, reviewedToTree: fx.tree() },
    });
    expect(() => completeReview(fx.db, { reviewId: id, report: reportOf() })).toThrow(
      expect.objectContaining({ code: 'review_not_pending' }),
    );
    expect(getReview(fx.db, id)!.verdict).toBe('block');
  });

  it('does not block on a periodic block verdict unless the definition says so', async () => {
    const fx = goalRepoFixture();
    const { id } = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      reviewKind: 'periodic',
    });
    const blocks = fx.definition.review.blocking.periodic;
    expect(completeReview(fx.db, { reviewId: id, report: reportOf({ verdict: 'block' }) }).blocking).toBe(
      blocks,
    );
  });

  it('rejects malformed, extra-key and inconsistent reports without changing the review', async () => {
    const fx = goalRepoFixture();
    const { id } = await final(fx);
    const bad: unknown[] = [
      null,
      'pass',
      {},
      { ...reportOf(), verdict: 'maybe' },
      { ...reportOf(), extra: 1 },
      reportOf({ newFindings: [newFinding({ severity: 'urgent' })] as never }),
      reportOf({ newFindings: [newFinding({ affectedFiles: ['../etc/passwd'] })] as never }),
      reportOf({ newFindings: [newFinding({ affectedFiles: ['/abs'] })] as never }),
      reportOf({ criterionProgress: [{ criterionKey: 'ghost', assessment: 'met', basis: '' }] }),
      reportOf({ existingFindings: [{ goalFindingId: 'ghost', status: 'resolved', basis: '' }] }),
    ];
    for (const report of bad)
      expect(() => completeReview(fx.db, { reviewId: id, report })).toThrow(GoalReviewError);
    expect(getReview(fx.db, id)).toMatchObject({ status: 'pending', report: null });
  });

  it('records independence only as supplied and validates its shape', async () => {
    const fx = goalRepoFixture();
    const a = await final(fx);
    const b = await final(fx);
    expect(completeReview(fx.db, { reviewId: a.id, report: reportOf() }).independence).toBeNull();
    expect(
      completeReview(fx.db, {
        reviewId: b.id,
        report: reportOf(),
        independence: { established: true, policy: 'different-family' },
      }).independence,
    ).toEqual({ established: true, policy: 'different-family' });
    const c = await final(fx);
    expect(() =>
      completeReview(fx.db, { reviewId: c.id, report: reportOf(), independence: { established: 'yes' } }),
    ).toThrow(expect.objectContaining({ code: 'independence_invalid' }));
  });

  it('refuses an unknown review', () => {
    const fx = goalRepoFixture();
    expect(() => completeReview(fx.db, { reviewId: 'ghost', report: reportOf() })).toThrow(
      expect.objectContaining({ code: 'review_not_found' }),
    );
  });
});

describe('closeReview', () => {
  it('fails or cancels a pending review terminally with no report', async () => {
    const fx = goalRepoFixture();
    for (const status of ['failed', 'cancelled'] as const) {
      const { id } = await final(fx);
      closeReview(fx.db, { reviewId: id, status });
      expect(getReview(fx.db, id)).toMatchObject({ status, report: null, verdict: null });
      expect(() => completeReview(fx.db, { reviewId: id, report: reportOf() })).toThrow(
        expect.objectContaining({ code: 'review_not_pending' }),
      );
      expect(() => closeReview(fx.db, { reviewId: id, status: 'failed' })).toThrow(
        expect.objectContaining({ code: 'review_not_pending' }),
      );
    }
    expect(() => closeReview(fx.db, { reviewId: 'ghost', status: 'failed' })).toThrow(
      expect.objectContaining({ code: 'review_not_found' }),
    );
  });

  it('cannot reopen a completed review', async () => {
    const fx = goalRepoFixture();
    const { id } = await final(fx);
    completeReview(fx.db, { reviewId: id, report: reportOf() });
    expect(() => closeReview(fx.db, { reviewId: id, status: 'cancelled' })).toThrow(GoalReviewError);
    expect(() => fx.db.prepare("UPDATE goal_reviews SET status = 'pending' WHERE id = ?").run(id)).toThrow();
  });
});
