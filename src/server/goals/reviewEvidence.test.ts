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

const definition = (policy: 'different-family' | 'none' = 'different-family'): GoalDefinition => {
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
  def.routing.independence.finalReview = policy;
  return def;
};

type Claim = 'established' | 'unestablished' | 'none-recorded';
const claimOf = (claim: Claim, policy: 'different-family' | 'none') =>
  claim === 'none-recorded' ? undefined : { established: claim === 'established', policy, detail: {} };

async function reviewed(
  kind: GoalReviewKind,
  report: Partial<ReviewReport>,
  options: { policy?: 'different-family' | 'none'; claim?: Claim } = {},
) {
  const policy = options.policy ?? 'different-family';
  const fx = goalRepoFixture({ definition: definition(policy) });
  const { id } = await createReview(fx.db, {
    goalId: fx.goalId,
    definitionVersion: 1,
    reviewKind: kind,
    ...(kind === 'milestone' ? { milestoneId: fx.milestoneId('m1') } : {}),
  });
  completeReview(fx.db, {
    reviewId: id,
    report: reportOf(report),
    ...(kind === 'final' && options.claim
      ? { independence: claimOf(options.claim, policy === 'none' ? 'none' : policy) }
      : {}),
  });
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
    ['final', 'pass_with_findings', 'inconclusive'],
    ['final', 'block', 'contradicts'],
  ];
  it.each(table)('%s review with %s is %s', async (kind, verdict, expected) => {
    const { fx, record, key } = await reviewed(kind, { verdict });
    await record();
    expect(verdictOf(fx, key)).toEqual([expected]);
  });

  const finals: Array<[string, ReviewReport['verdict'], 'different-family' | 'none', Claim, string]> = [
    ['pass, independence required and established', 'pass', 'different-family', 'established', 'satisfies'],
    [
      'pass, independence required and unestablished',
      'pass',
      'different-family',
      'unestablished',
      'inconclusive',
    ],
    [
      'pass, independence required and nothing recorded',
      'pass',
      'different-family',
      'none-recorded',
      'inconclusive',
    ],
    ['pass, policy none', 'pass', 'none', 'unestablished', 'satisfies'],
    [
      'pass_with_findings, established',
      'pass_with_findings',
      'different-family',
      'established',
      'inconclusive',
    ],
    ['block, established', 'block', 'different-family', 'established', 'contradicts'],
    ['block, unestablished', 'block', 'different-family', 'unestablished', 'contradicts'],
  ];
  it.each(finals)('final review: %s', async (_name, verdict, policy, claim, expected) => {
    const { fx, record, key } = await reviewed('final', { verdict }, { policy, claim });
    await record();
    expect(verdictOf(fx, key)).toEqual([expected]);
  });

  it('milestone evidence ignores final-review independence entirely', async () => {
    const { fx, record, key } = await reviewed('milestone', { verdict: 'pass' });
    await record();
    expect(verdictOf(fx, key)).toEqual(['satisfies']);
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
