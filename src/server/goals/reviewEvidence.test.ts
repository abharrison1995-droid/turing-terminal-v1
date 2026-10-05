import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition, GoalReviewKind, ReviewReport } from '../../shared/goals.js';
import { recordEvidence } from './evidence.js';
import { listEvidence } from './evidence.js';
import { listGoalEvents } from './events.js';
import {
  BUILD,
  cleanupRepoFixtures,
  goalRepoFixture,
  milestone,
  reportOf,
  simpleDefinition,
  TESTS,
} from './repoKit.js';
import { completeReview, createReview } from './reviews.js';
import { listVerifiers } from './verifierDigest.js';

afterEach(cleanupRepoFixtures);

const definition = (): GoalDefinition => {
  const def = simpleDefinition({
    criteria: [
      BUILD,
      TESTS,
      {
        key: 'm-review',
        statement: 'Milestone reviewed',
        verification: [{ kind: 'test' }, { kind: 'review_verdict', reviewKind: 'milestone' }],
        required: true,
      },
      {
        key: 'f-review',
        statement: 'Finally reviewed',
        verification: [{ kind: 'test' }, { kind: 'review_verdict', reviewKind: 'final' }],
        required: true,
      },
    ],
    milestones: [milestone('m1', ['build', 'tests', 'm-review', 'f-review'])],
  });
  def.review.onMilestoneComplete = true;
  def.review.final = true;
  const reviewer = def.routing.roles.implementer!;
  def.routing.roles.milestone_reviewer = reviewer;
  def.routing.roles.final_reviewer = reviewer;
  return def;
};

async function reviewed(kind: GoalReviewKind, report: Partial<ReviewReport>) {
  const fx = goalRepoFixture({ definition: definition() });
  const { id } = await createReview(fx.db, {
    goalId: fx.goalId,
    definitionVersion: 1,
    reviewKind: kind,
    ...(kind === 'milestone' ? { milestoneId: fx.milestoneId('m1') } : {}),
  });
  completeReview(fx.db, { reviewId: id, report: reportOf(report) });
  const key = kind === 'milestone' ? 'm-review' : 'f-review';
  const verifier = listVerifiers(fx.definition).find(
    (v) => v.criterionKey === key && v.spec.kind === 'review_verdict',
  )!;
  const record = () =>
    recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: key,
      verifierDigest: verifier.digest,
      kind: 'review_verdict',
      reviewId: id,
    });
  return { fx, id, verifier, record, key };
}
const verdictOf = (fx: ReturnType<typeof goalRepoFixture>, key: string) =>
  listEvidence(fx.db, fx.goalId, key).map((row) => (row as { verdict: string }).verdict);

describe('review_verdict evidence semantics (aligned with completion)', () => {
  const table: Array<[GoalReviewKind, ReviewReport['verdict'], string]> = [
    ['milestone', 'pass', 'satisfies'],
    ['milestone', 'pass_with_findings', 'satisfies'],
    ['milestone', 'block', 'contradicts'],
    ['final', 'pass', 'satisfies'],
    ['final', 'pass_with_findings', 'inconclusive'],
    ['final', 'block', 'contradicts'],
  ];
  it.each(table)('%s review with %s is %s', async (kind, verdict, expected) => {
    const { fx, record, key } = await reviewed(kind, { verdict });
    await record();
    expect(verdictOf(fx, key)).toEqual([expected]);
  });

  it('a final pass_with_findings is never recorded as satisfying the verifier completion needs', async () => {
    const { fx, record, key } = await reviewed('final', { verdict: 'pass_with_findings' });
    await record();
    expect(verdictOf(fx, key)).not.toContain('satisfies');
  });
});

describe('review_verdict evidence idempotency', () => {
  it('reuses the stored row for the same review and verifier instead of adding one', async () => {
    const { fx, record, key } = await reviewed('milestone', { verdict: 'pass' });
    const first = await record();
    const second = await record();
    expect(second).toEqual(first);
    expect(verdictOf(fx, key)).toHaveLength(1);
    expect(
      listGoalEvents(fx.db, fx.goalId).filter((event) => event.type === 'evidence_recorded'),
    ).toHaveLength(1);
  });

  it('is also enforced by the database (migration 022)', async () => {
    const { fx, id, verifier, record, key } = await reviewed('milestone', { verdict: 'pass' });
    await record();
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO goal_evidence (id, goal_id, definition_version, criterion_key, verifier_digest, kind, verdict, review_id,
             reviewed_to_commit, reviewed_to_tree, ref_json, recorded_at)
           SELECT 'dup', goal_id, definition_version, criterion_key, verifier_digest, kind, verdict, review_id,
             reviewed_to_commit, reviewed_to_tree, ref_json, recorded_at FROM goal_evidence WHERE review_id = ?`,
        )
        .run(id),
    ).toThrow(/UNIQUE/);
    expect(verdictOf(fx, key)).toHaveLength(1);
    expect(verifier.criterionKey).toBe(key);
  });

  it('refuses a periodic review for a milestone verifier', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const { id } = await createReview(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      reviewKind: 'periodic',
    });
    completeReview(fx.db, { reviewId: id, report: reportOf() });
    const verifier = listVerifiers(fx.definition).find(
      (v) => v.criterionKey === 'm-review' && v.spec.kind === 'review_verdict',
    )!;
    await expect(
      recordEvidence(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        criterionKey: 'm-review',
        verifierDigest: verifier.digest,
        kind: 'review_verdict',
        reviewId: id,
      }),
    ).rejects.toMatchObject({ code: 'review_mismatch' });
  });
});
