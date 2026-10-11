import { afterEach, describe, expect, it } from 'vitest';
import {
  GoalFindingError,
  applyReviewFindings,
  decideFinding,
  findingFingerprint,
  getGoalFinding,
  listGoalFindings,
  openFindingCounts,
} from './findings.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  newFinding,
  passDeterministic,
  reportOf,
  type GoalRepoFixture,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { listGoalEvents } from './events.js';
import { completeReview, createReview, listReviews } from './reviews.js';
import type { ReviewReport } from '../../shared/goals.js';

afterEach(cleanupRepoFixtures);

async function review(fx: GoalRepoFixture, report: ReviewReport, extra: { runId?: string } = {}) {
  const { id } = await createReview(fx.db, {
    goalId: fx.goalId,
    definitionVersion: 1,
    reviewKind: 'final',
    ...extra,
  });
  completeReview(fx.db, { reviewId: id, report });
  return id;
}
const apply = async (fx: GoalRepoFixture, report: ReviewReport, runFindingIds?: never) =>
  applyReviewFindings(fx.db, { reviewId: await review(fx, report), runFindingIds });
const open = async (fx: GoalRepoFixture, over: Record<string, unknown> = {}) => {
  const result = await apply(
    fx,
    reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding(over)] as never }),
  );
  return result.opened[0]!;
};
const entry = (id: string, status: 'still_open' | 'resolved' | 'not_assessed') => ({
  goalFindingId: id,
  status,
  basis: 'b',
});

describe('fingerprint', () => {
  it('ignores case, whitespace, severity wording and file order, and changes with category, text and files', () => {
    const base = {
      category: 'Correctness',
      description: 'Parser  drops the last token',
      affectedFiles: ['b.ts', 'a.ts'],
    };
    const same = {
      category: ' correctness ',
      description: 'parser drops the LAST token',
      affectedFiles: ['a.ts', 'b.ts', 'a.ts'],
    };
    expect(findingFingerprint(base)).toBe(findingFingerprint(same));
    expect(findingFingerprint(base)).not.toBe(findingFingerprint({ ...base, category: 'perf' }));
    expect(findingFingerprint(base)).not.toBe(findingFingerprint({ ...base, description: 'other' }));
    expect(findingFingerprint(base)).not.toBe(findingFingerprint({ ...base, affectedFiles: ['a.ts'] }));
  });
});

describe('applyReviewFindings', () => {
  it(
    'opens findings with a first observation and an event, once per review',
    async () => {
      const fx = goalRepoFixture();
      const id = await review(
        fx,
        reportOf({
          verdict: 'pass_with_findings',
          newFindings: [
            newFinding(),
            newFinding({ severity: 'low', category: 'style', description: 'naming' }),
          ] as never,
        }),
      );
      const result = await applyReviewFindings(fx.db, { reviewId: id });
      expect(result.opened).toHaveLength(2);
      expect(listGoalFindings(fx.db, fx.goalId, 'open')).toHaveLength(2);
      expect(openFindingCounts(fx.db, fx.goalId)).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
      expect(
        fx.db.prepare('SELECT observation FROM goal_finding_observations WHERE review_id = ?').all(id),
      ).toEqual([{ observation: 'new' }, { observation: 'new' }]);
      await expect(applyReviewFindings(fx.db, { reviewId: id })).rejects.toMatchObject({
        code: 'review_findings_already_applied',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a pending, failed or unknown review',
    async () => {
      const fx = goalRepoFixture();
      const pending = await createReview(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        reviewKind: 'final',
      });
      await expect(applyReviewFindings(fx.db, { reviewId: pending.id })).rejects.toMatchObject({
        code: 'review_not_completed',
      });
      await expect(applyReviewFindings(fx.db, { reviewId: 'ghost' })).rejects.toMatchObject({
        code: 'review_not_found',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'de-duplicates by fingerprint: a repeat adds an observation, not a second open finding',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      const again = await apply(
        fx,
        reportOf({
          verdict: 'pass_with_findings',
          newFindings: [newFinding({ severity: 'low', evidence: 'different' })] as never,
        }),
      );
      expect(again.opened).toEqual([]);
      expect(listGoalFindings(fx.db, fx.goalId)).toHaveLength(1);
      expect(getGoalFinding(fx.db, id)!.severity).toBe('high');
      expect(
        fx.db
          .prepare('SELECT COUNT(*) AS n FROM goal_finding_observations WHERE goal_finding_id = ?')
          .get(id),
      ).toEqual({ n: 2 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps an open finding open when a later review omits it (absence never resolves)',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      await passDeterministic(fx);
      const result = await apply(fx, reportOf());
      expect(result).toMatchObject({ resolved: [], observed: 0 });
      expect(getGoalFinding(fx.db, id)!.status).toBe('open');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'records explicit still_open and not_assessed without changing status',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      await apply(fx, reportOf({ existingFindings: [entry(id, 'still_open')] }));
      await apply(fx, reportOf({ existingFindings: [entry(id, 'not_assessed')] }));
      expect(getGoalFinding(fx.db, id)!.status).toBe('open');
      expect(
        fx.db
          .prepare(
            'SELECT observation FROM goal_finding_observations WHERE goal_finding_id = ? ORDER BY rowid',
          )
          .all(id),
      ).toEqual([{ observation: 'new' }, { observation: 'still_open' }, { observation: 'not_assessed' }]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to resolve a high finding without fresh deterministic evidence and records the attempt',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      const result = await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }));
      expect(result.resolved).toEqual([]);
      expect(result.resolutionsRefused).toEqual([
        { goalFindingId: id, code: 'deterministic_evidence_missing' },
      ]);
      expect(getGoalFinding(fx.db, id)!.status).toBe('open');
      expect(
        fx.db
          .prepare(
            'SELECT basis FROM goal_finding_observations WHERE goal_finding_id = ? ORDER BY rowid DESC',
          )
          .get(id),
      ).toMatchObject({
        basis: expect.stringContaining('resolution_refused:deterministic_evidence_missing'),
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses when the passing evidence belongs to an older tree',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      await passDeterministic(fx);
      fx.advance({ 'src/new.ts': 'n' });
      const result = await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }));
      expect(result.resolutionsRefused).toHaveLength(1);
      expect(getGoalFinding(fx.db, id)!.status).toBe('open');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'resolves a high finding with fresh head-bound build and test evidence at the reviewed tree',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      await passDeterministic(fx);
      const result = await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }));
      expect(result.resolved).toEqual([id]);
      const finding = getGoalFinding(fx.db, id)!;
      expect(finding.status).toBe('resolved');
      expect(finding.resolvedByReviewId).toBeTruthy();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'resolves a medium finding on the review alone',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx, { severity: 'medium' });
      expect((await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }))).resolved).toEqual([
        id,
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'cannot resolve a high finding when the definition has no build or test verifier',
    async () => {
      const { simpleDefinition, milestone } = await import('./repoKit.js');
      const fx = goalRepoFixture({
        definition: simpleDefinition({
          criteria: [
            {
              key: 'doc',
              statement: 's',
              required: true,
              verification: [{ kind: 'file_exists', path: 'docs/README.md' }],
            },
          ],
          milestones: [milestone('m1', ['doc'])],
        }),
      });
      const id = await open(fx);
      const result = await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }));
      expect(result.resolutionsRefused).toEqual([{ goalFindingId: id, code: 'no_deterministic_verifier' }]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reopens a resolved finding when it is reported again or still_open',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx, { severity: 'medium' });
      await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }));
      expect(getGoalFinding(fx.db, id)!.status).toBe('resolved');
      const again = await apply(
        fx,
        reportOf({
          verdict: 'pass_with_findings',
          newFindings: [newFinding({ severity: 'medium' })] as never,
        }),
      );
      expect(again.reopened).toEqual([id]);
      expect(getGoalFinding(fx.db, id)).toMatchObject({ status: 'open', resolvedByReviewId: null });
      expect(listGoalFindings(fx.db, fx.goalId)).toHaveLength(1);
      await apply(fx, reportOf({ existingFindings: [entry(id, 'resolved')] }));
      const viaStillOpen = await apply(fx, reportOf({ existingFindings: [entry(id, 'still_open')] }));
      expect(viaStillOpen.reopened).toEqual([id]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a stale-version repository change guard',
    async () => {
      const fx = goalRepoFixture();
      const id = await review(fx, reportOf());
      fx.git('update-ref', '-d', `refs/heads/turing/goal/${fx.goalId}`);
      await expect(applyReviewFindings(fx.db, { reviewId: id })).rejects.toMatchObject({
        code: 'repository_unavailable',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('run-finding ownership', () => {
  it(
    'refuses a cited run finding when the review has no run',
    async () => {
      const fx = goalRepoFixture();
      const id = await review(
        fx,
        reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding()] as never }),
      );
      await expect(
        applyReviewFindings(fx.db, { reviewId: id, runFindingIds: { new: ['some-run-finding'] } }),
      ).rejects.toMatchObject({ code: 'run_finding_mismatch' });
      expect(listGoalFindings(fx.db, fx.goalId)).toEqual([]); // the whole application rolled back
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('decideFinding', () => {
  const approval = (
    fx: GoalRepoFixture,
    findingId: string,
    decision: string,
    over: Record<string, unknown> = {},
    outcome: 'approved' | 'denied' = 'approved',
  ) =>
    fx.approval(
      'finding_decision',
      { findingId, decision, definitionVersion: 1, definitionHash: fx.currentHash(), ...over },
      outcome,
    );

  it(
    'accepts or dismisses an open finding only with a bound user approval',
    async () => {
      const fx = goalRepoFixture();
      const a = await open(fx);
      const b = await open(fx, { category: 'other', description: 'something else' });
      expect(
        decideFinding(fx.db, {
          goalId: fx.goalId,
          findingId: a,
          decision: 'accepted_by_user',
          approvalId: approval(fx, a, 'accepted_by_user'),
          actor: 'user',
        }).status,
      ).toBe('accepted_by_user');
      expect(
        decideFinding(fx.db, {
          goalId: fx.goalId,
          findingId: b,
          decision: 'dismissed_by_user',
          approvalId: approval(fx, b, 'dismissed_by_user'),
          actor: 'user',
        }).status,
      ).toBe('dismissed_by_user');
      expect(openFindingCounts(fx.db, fx.goalId).high).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'persists the approval pointer with the status, and the event references the same approval',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      const approvalId = approval(fx, id, 'dismissed_by_user');
      const decided = decideFinding(fx.db, {
        goalId: fx.goalId,
        findingId: id,
        decision: 'dismissed_by_user',
        approvalId,
        actor: 'user',
      });
      expect(decided).toMatchObject({ status: 'dismissed_by_user', decisionApprovalId: approvalId });
      expect(getGoalFinding(fx.db, id)!.decisionApprovalId).toBe(approvalId);
      const event = listGoalEvents(fx.db, fx.goalId).find((entry) => entry.type === 'finding_decided')!;
      expect(event.payload).toMatchObject({ goalFindingId: id, decision: 'dismissed_by_user', approvalId });
      // Every non-user-decided finding has no pointer.
      const open2 = await open(fx, { category: 'other', description: 'x' });
      expect(getGoalFinding(fx.db, open2)!.decisionApprovalId).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses non-user actors and approvals bound to something else',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      const other = await open(fx, { category: 'other', description: 'x' });
      const call = (
        approvalId: string,
        decision: 'accepted_by_user' | 'dismissed_by_user' = 'accepted_by_user',
        actor: 'user' = 'user',
      ) => decideFinding(fx.db, { goalId: fx.goalId, findingId: id, decision, approvalId, actor });
      for (const actor of ['model', 'supervisor', 'system'])
        expect(() => call(approval(fx, id, 'accepted_by_user'), 'accepted_by_user', actor as never)).toThrow(
          expect.objectContaining({ code: 'user_authority_required' }),
        );
      const bad = [
        approval(fx, other, 'accepted_by_user'),
        approval(fx, id, 'dismissed_by_user'),
        approval(fx, id, 'accepted_by_user', { definitionHash: 'h' }),
        approval(fx, id, 'accepted_by_user', { definitionVersion: 9 }),
        approval(fx, id, 'accepted_by_user', {}, 'denied'),
        fx.approval('start', {
          findingId: id,
          decision: 'accepted_by_user',
          definitionVersion: 1,
          definitionHash: fx.currentHash(),
        }),
        'ghost',
      ];
      for (const approvalId of bad)
        expect(() => call(approvalId)).toThrow(expect.objectContaining({ code: 'approval_invalid' }));
      expect(getGoalFinding(fx.db, id)!.status).toBe('open');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'cannot decide a finding twice, a missing finding, or another Goal finding',
    async () => {
      const fx = goalRepoFixture();
      const other = goalRepoFixture();
      const id = await open(fx);
      const approvalId = approval(fx, id, 'accepted_by_user');
      decideFinding(fx.db, {
        goalId: fx.goalId,
        findingId: id,
        decision: 'accepted_by_user',
        approvalId,
        actor: 'user',
      });
      expect(() =>
        decideFinding(fx.db, {
          goalId: fx.goalId,
          findingId: id,
          decision: 'accepted_by_user',
          approvalId,
          actor: 'user',
        }),
      ).toThrow(expect.objectContaining({ code: 'finding_not_open' }));
      expect(() =>
        decideFinding(fx.db, {
          goalId: fx.goalId,
          findingId: 'ghost',
          decision: 'accepted_by_user',
          approvalId,
          actor: 'user',
        }),
      ).toThrow(GoalFindingError);
      expect(() =>
        decideFinding(other.db, {
          goalId: other.goalId,
          findingId: id,
          decision: 'accepted_by_user',
          approvalId,
          actor: 'user',
        }),
      ).toThrow(GoalFindingError);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps the user decision when a later review reports the same finding again',
    async () => {
      const fx = goalRepoFixture();
      const id = await open(fx);
      decideFinding(fx.db, {
        goalId: fx.goalId,
        findingId: id,
        decision: 'dismissed_by_user',
        approvalId: approval(fx, id, 'dismissed_by_user'),
        actor: 'user',
      });
      const again = await apply(
        fx,
        reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding()] as never }),
      );
      expect(again).toMatchObject({ opened: [], reopened: [] });
      expect(getGoalFinding(fx.db, id)!.status).toBe('dismissed_by_user');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

/** Counts of everything a finding lifecycle write could touch, to prove a refused review changed nothing. */
function lifecycleSnapshot(fx: GoalRepoFixture) {
  const count = (sql: string) => (fx.db.prepare(sql).get(fx.goalId) as { n: number }).n;
  return {
    findings: fx.db.prepare('SELECT * FROM goal_findings WHERE goal_id = ? ORDER BY id').all(fx.goalId),
    observations: count('SELECT COUNT(*) AS n FROM goal_finding_observations WHERE goal_id = ?'),
    events: fx.db.prepare('SELECT type FROM goal_events WHERE goal_id = ? ORDER BY rowid').all(fx.goalId),
  };
}

async function amend(fx: GoalRepoFixture): Promise<number> {
  const { beginAmendment, approveDefinition } = await import('./definitions.js');
  const amended = structuredClone(fx.definition);
  amended.limits.maxExecutionCycles += 1;
  const { version } = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user', definition: amended });
  approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
  return version;
}

describe('stale reviews are lifecycle-inert', () => {
  const refuses = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({ name: 'GoalFindingError', code: 'review_not_current' });

  it(
    'refuses a review of an older tree: no new finding, no reopen, no resolve, no observation, no event',
    async () => {
      const fx = goalRepoFixture();
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const resolvedId = await open(fx, { severity: 'medium', description: 'resolved one' });
      await apply(fx, reportOf({ existingFindings: [entry(resolvedId, 'resolved')] }));
      const openId = await open(fx, { severity: 'medium', description: 'open one' });

      const newer = await review(
        fx,
        reportOf({
          verdict: 'pass_with_findings',
          newFindings: [newFinding({ description: 'brand new' })] as never,
        }),
      );
      const reopen = await review(
        fx,
        reportOf({ existingFindings: [entry(resolvedId, 'still_open'), entry(openId, 'resolved')] }),
      );
      const observe = await review(fx, reportOf({ existingFindings: [entry(openId, 'still_open')] }));
      fx.advance({ 'src/later.ts': 'later' });
      const before = lifecycleSnapshot(fx);
      for (const reviewId of [newer, reopen, observe])
        await refuses(applyReviewFindings(fx.db, { reviewId }));
      expect(lifecycleSnapshot(fx)).toEqual(before);
      expect(getGoalFinding(fx.db, resolvedId)!.status).toBe('resolved');
      expect(getGoalFinding(fx.db, openId)!.status).toBe('open');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a review of an earlier definition version even though the tree is unchanged',
    async () => {
      const fx = goalRepoFixture();
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const resolvedId = await open(fx, { severity: 'medium', description: 'resolved one' });
      await apply(fx, reportOf({ existingFindings: [entry(resolvedId, 'resolved')] }));
      const openId = await open(fx, { severity: 'medium', description: 'open one' });
      const newer = await review(
        fx,
        reportOf({
          verdict: 'pass_with_findings',
          newFindings: [newFinding({ description: 'brand new' })] as never,
        }),
      );
      const reopen = await review(
        fx,
        reportOf({ existingFindings: [entry(resolvedId, 'still_open'), entry(openId, 'resolved')] }),
      );

      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      expect(await amend(fx)).toBe(2);
      const before = lifecycleSnapshot(fx);
      for (const reviewId of [newer, reopen]) await refuses(applyReviewFindings(fx.db, { reviewId }));
      expect(lifecycleSnapshot(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps the stale review as immutable, visible history',
    async () => {
      const fx = goalRepoFixture();
      const reviewId = await review(fx, reportOf());
      fx.advance({ 'src/later.ts': 'later' });
      await refuses(applyReviewFindings(fx.db, { reviewId }));
      expect(listReviews(fx.db, fx.goalId).map((row) => [row.id, row.status])).toEqual([
        [reviewId, 'completed'],
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a review created and completed after an amendment may apply',
    async () => {
      const fx = goalRepoFixture();
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const version = await amend(fx);
      const { id } = await createReview(fx.db, {
        goalId: fx.goalId,
        definitionVersion: version,
        reviewKind: 'final',
      });
      completeReview(fx.db, {
        reviewId: id,
        report: reportOf({ verdict: 'pass_with_findings', newFindings: [newFinding()] as never }),
      });
      expect((await applyReviewFindings(fx.db, { reviewId: id })).opened).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
