import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import { completeGoal } from './completion.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { call, goalApp } from './apiKit.js';
import { appendCorrectionForTest, v2DecidedFixture } from './goalV2TestKit.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  passDeterministic,
  REAL_GIT_TEST_TIMEOUT_MS,
  simpleDefinition,
} from './repoKit.js';

/**
 * The Goal detail route (`GET /api/goals/:goalId`), exercised through `goalApp(db)` and `app.inject`, the same path the
 * other Goal API tests use. Each Goal is real: real Git fixtures and real SQLite with the production migrations. The
 * standing is composed in goalRoutes.ts and is additive, so these tests read only the new field and the status fields.
 */

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

const LATER_CLOCK_MS = 5;
function letClockAdvance(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LATER_CLOCK_MS));
}

/** The request a user would send for one reviewed decision. Copied from completionStandingService.test.ts. */
function requestFor(decided: Awaited<ReturnType<typeof v2DecidedFixture>>) {
  return {
    goalId: decided.fx.goalId,
    attestationId: decided.attestationId,
    reviewedPreflightDigest: decided.digest,
    acknowledgeContentNotProven: true,
  };
}

describe('Goal detail route carries the completion standing', () => {
  it(
    'W1: a completed version-2 Goal is uncontested, then withdrawn after a post-completion withdrawal, and stays completed',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId } = decided.fx;
      const { completion } = await completeGoalFromExternalDecision(db, requestFor(decided));
      app = goalApp(db);

      const before = await call(app, 'GET', `/api/goals/${goalId}`);
      expect(before.status).toBe(200);
      expect(before.body.goal.status).toBe('completed');
      expect(before.body.goal.completedAt).toBe(completion.completedAt);
      expect(before.body.goal.completionStanding).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: {
          unqualifiedSuccessAllowed: true,
          trustedForDownstream: true,
          qualifier: 'none',
          contentPreservation: 'not_proven',
        },
      });

      await letClockAdvance();
      appendCorrectionForTest(decided.fx, decided.attestationId, 'withdraw');

      const after = await call(app, 'GET', `/api/goals/${goalId}`);
      expect(after.status).toBe(200);
      expect(after.body.goal.status).toBe('completed');
      expect(after.body.goal.completedAt).toBe(completion.completedAt);
      expect(after.body.goal.completionStanding).toMatchObject({
        kind: 'v2',
        standing: 'withdrawn',
        status: {
          goalStatus: 'completed',
          completedAt: completion.completedAt,
          reasonCode: EXTERNAL_COMPLETION_REASON,
        },
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'withdrawn_by_user',
          contentPreservation: 'not_proven',
        },
        correction: { standing: 'withdrawn', correctionCount: 1, correctedAfterCompletion: true },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'W2: a Goal that is not completed has kind not_completed and a null standing, and an unknown Goal is still a 404',
    async () => {
      const fx = goalRepoFixture({ definition: simpleDefinition() });
      const row = fx.db
        .prepare('SELECT status, status_reason_code FROM goals WHERE id = ?')
        .get(fx.goalId) as {
        status: string;
        status_reason_code: string | null;
      };
      app = goalApp(fx.db);

      const detail = await call(app, 'GET', `/api/goals/${fx.goalId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.goal.status).toBe(row.status);
      expect(detail.body.goal.completionStanding).toEqual({
        schemaVersion: 1,
        goalId: fx.goalId,
        kind: 'not_completed',
        standing: null,
        status: {
          goalStatus: row.status,
          completedAt: null,
          reasonCode: row.status_reason_code,
        },
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'not_completed',
          contentPreservation: 'not_applicable',
        },
      });
      expect(detail.body.goal.completionStanding.standing).toBeNull();

      expect((await call(app, 'GET', '/api/goals/missing-goal')).status).toBe(404);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'W3: a legacy version-1 completion made by the real completeGoal path is historical_legacy and not trusted',
    async () => {
      const fx = goalRepoFixture({ definition: simpleDefinition() });
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      fx.advance({ 'src/work.ts': 'w' });
      await passDeterministic(fx);
      const result = await completeGoal(fx.db, fx.goalId);
      expect(result.completed).toBe(true);
      const row = fx.db.prepare('SELECT completed_at FROM goals WHERE id = ?').get(fx.goalId) as {
        completed_at: string | null;
      };
      app = goalApp(fx.db);

      const response = await call(app, 'GET', `/api/goals/${fx.goalId}`);
      expect(response.status).toBe(200);
      expect(response.body.goal.completionStanding).toEqual({
        schemaVersion: 1,
        goalId: fx.goalId,
        kind: 'legacy',
        standing: 'historical_legacy',
        status: { goalStatus: 'completed', completedAt: row.completed_at, reasonCode: 'completion_verified' },
        proof: { state: 'legacy_no_proof' },
        correction: null,
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'legacy_not_v2_attested',
          contentPreservation: 'not_applicable',
        },
        classification: { trust: 'qualified', reconciliation: 'none', reasons: ['legacy_completion'] },
        otherAttestations: [],
        otherAttestationsTruncated: false,
      });
      expect(response.body.goal.completedAt).toBe(row.completed_at);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
