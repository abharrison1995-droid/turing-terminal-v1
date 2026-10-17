import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, goalApp } from './apiKit.js';
import { createGoalDraft } from './definitions.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { listGoals } from './readModel.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  REAL_GIT_TEST_TIMEOUT_MS,
  simpleDefinition,
} from './repoKit.js';

/**
 * The list route (`GET /api/goals`) with the completion standing brief. Each Goal is real: real Git fixtures and real
 * SQLite with the production migrations, through `goalApp(db)` and `app.inject`. The brief is composed in goalRoutes.ts
 * and is additive, so every non-brief field must match the read model's own output.
 */

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  cleanupRepoFixtures();
});

type ListBody = { goals: Array<Record<string, unknown> & { id: string }>; total: number; limit: number };

const rowOf = (body: ListBody, goalId: string) => {
  const row = body.goals.find((goal) => goal.id === goalId);
  if (!row) throw new Error(`no list row for ${goalId}`);
  return row;
};

/** The response with the brief fields removed, so it can be compared with the read model's own output. */
function withoutBriefs(body: ListBody): ListBody {
  return {
    ...body,
    goals: body.goals.map(({ completionStandingBrief: _brief, ...rest }) => rest),
  };
}

const requestFor = (decided: Awaited<ReturnType<typeof v2DecidedFixture>>) => ({
  goalId: decided.fx.goalId,
  attestationId: decided.attestationId,
  reviewedPreflightDigest: decided.digest,
  acknowledgeContentNotProven: true,
});

/**
 * Moves the clock forward after completion, so the correction is strictly later than the completion. The correction code
 * reads `new Date()`, so the fake clock is set explicitly. Nothing waits and no timer fires.
 */
function correctionClockAfter(completedAt: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(completedAt) + 1_000);
}

/** A version-2 Goal completed on its decided attestation, then corrected after completion. */
async function completedAndCorrected(kind: 'dispute' | 'withdraw') {
  const decided = await v2DecidedFixture('sha1');
  const { completion } = await completeGoalFromExternalDecision(decided.fx.db, requestFor(decided));
  correctionClockAfter(completion.completedAt);
  appendCorrectionForTest(decided.fx, decided.attestationId, kind);
  return decided.fx;
}

/**
 * A version-2 Goal completed on proof attestation A, with an independent compatible replacement B attested before
 * completion. A is then superseded by B after completion. The shape follows completionStandingService.test.ts.
 */
async function completedAndSuperseded() {
  const attested = await v2RunningAttestedFixture('sha1');
  const { fx } = attested;
  const baseRef = attested.handoff.target.baseRef;
  const proofTip = git(fx.repo, 'rev-parse', baseRef);
  const current = git(fx.repo, 'rev-parse', baseRef);
  const tree = git(fx.repo, 'rev-parse', `${current}^{tree}`);
  git(
    fx.repo,
    'update-ref',
    baseRef,
    git(fx.repo, 'commit-tree', tree, '-p', current, '-m', 'destination moved'),
  );
  const replacement = await reattestAtCurrentTip(attested);
  git(fx.repo, 'update-ref', baseRef, proofTip);
  const digest = await reviewedDigest(attested);
  await recordExternalCompletionDecision(fx.db, {
    goalId: fx.goalId,
    attestationId: attested.attestationId,
    reviewedPreflightDigest: digest,
    acknowledgeContentNotProven: true,
  });
  const { completion } = await completeGoalFromExternalDecision(fx.db, {
    goalId: fx.goalId,
    attestationId: attested.attestationId,
    reviewedPreflightDigest: digest,
    acknowledgeContentNotProven: true,
  });
  correctionClockAfter(completion.completedAt);
  appendCorrectionForTest(fx, attested.attestationId, 'supersede', replacement.attestationId);
  return fx;
}

describe('GET /api/goals carries the completion standing brief on completed rows', () => {
  it(
    'L1: a completed Goal whose standing is uncontested carries a ready, trusted brief with content not proven',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      await completeGoalFromExternalDecision(db, requestFor(decided));
      app = goalApp(db);

      const response = await call(app, 'GET', '/api/goals');
      expect(response.status).toBe(200);
      const row = rowOf(response.body, goalId);
      expect(row.status).toBe('completed');
      expect(row.completionStandingBrief).toEqual({
        state: 'ready',
        standing: 'uncontested',
        qualifier: 'none',
        trusted: true,
        contentPreservation: 'not_proven',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['dispute', 'disputed', 'disputed_by_user'],
    ['withdraw', 'withdrawn', 'withdrawn_by_user'],
    ['supersede', 'superseded', 'superseded_by_user'],
  ] as const)(
    'L2 [%s]: a completed Goal corrected after completion carries the %s standing, not trusted',
    async (correction, standing, qualifier) => {
      const fx =
        correction === 'supersede' ? await completedAndSuperseded() : await completedAndCorrected(correction);
      app = goalApp(fx.db);

      const response = await call(app, 'GET', '/api/goals');
      expect(response.status).toBe(200);
      const row = rowOf(response.body, fx.goalId);
      expect(row.status).toBe('completed');
      expect(row.completionStandingBrief).toEqual({
        state: 'ready',
        standing,
        qualifier,
        trusted: false,
        contentPreservation: 'not_proven',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'L3: a Goal that is not completed has no completionStandingBrief property, on the same page as a completed Goal',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId, projectId } = decided.fx;
      await completeGoalFromExternalDecision(db, requestFor(decided));
      const running = createGoalDraft(db, {
        projectId,
        title: 'Still running',
        definition: simpleDefinition(),
      }).goalId;
      db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(running);
      app = goalApp(db);

      const response = await call(app, 'GET', '/api/goals');
      expect(response.status).toBe(200);
      const runningRow = rowOf(response.body, running);
      expect(runningRow.status).toBe('running');
      expect('completionStandingBrief' in runningRow).toBe(false);
      expect(rowOf(response.body, goalId).completionStandingBrief).toMatchObject({
        state: 'ready',
        trusted: true,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'L5: the list with its brief fields removed equals the read model output, for each page shape',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, projectId } = decided.fx;
      await completeGoalFromExternalDecision(db, requestFor(decided));
      const running = createGoalDraft(db, {
        projectId,
        title: 'Still running',
        definition: simpleDefinition(),
      }).goalId;
      db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(running);
      app = goalApp(db);

      const cases: Array<[string, Parameters<typeof listGoals>[1]]> = [
        ['', {}],
        ['?limit=1', { limit: 1 }],
        ['?limit=2', { limit: 2 }],
        ['?status=completed', { status: 'completed' }],
        ['?status=running&limit=1', { status: 'running', limit: 1 }],
      ];
      for (const [query, options] of cases) {
        const response = await call(app, 'GET', `/api/goals${query}`);
        expect(response.status).toBe(200);
        expect(withoutBriefs(response.body as ListBody)).toEqual(listGoals(db, options));
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'L6: a GET writes nothing: the full database snapshot is unchanged',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db } = decided.fx;
      await completeGoalFromExternalDecision(db, requestFor(decided));
      app = goalApp(db);
      const before = databaseSnapshot(db);

      const response = await call(app, 'GET', '/api/goals');
      expect(response.status).toBe(200);

      const after = databaseSnapshot(db);
      expect(after.counts).toEqual(before.counts);
      expect(after.digests).toEqual(before.digests);
      for (const table of ['goals', 'goal_approvals', 'goal_events', 'goal_external_completion_proofs']) {
        expect(after.counts[table]).toBe(before.counts[table]);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'L7: a malformed list query still returns the existing 400 refusal',
    async () => {
      const fx = goalRepoFixture({ definition: simpleDefinition() });
      app = goalApp(fx.db);

      for (const query of ['?limit=0', '?limit=abc', '?unknown=1']) {
        const response = await call(app, 'GET', `/api/goals${query}`);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('invalid_request');
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
