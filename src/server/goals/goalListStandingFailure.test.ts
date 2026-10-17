import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, goalApp } from './apiKit.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { createGoalDraft } from './definitions.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { v2DecidedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS, simpleDefinition } from './repoKit.js';

/**
 * A dedicated file for the forced reader failure, so the module mock below cannot reach the other list tests. The mock
 * passes every call through to the real reader, and throws only for the Goal a test names. No production hook exists.
 */
vi.mock('./completionStanding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./completionStanding.js')>();
  return { ...actual, readGoalCompletionStanding: vi.fn(actual.readGoalCompletionStanding) };
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  cleanupRepoFixtures();
});

describe('GET /api/goals when the completion standing reader fails for one completed row', () => {
  it(
    'L4: the failing row reads unreadable, the other completed row keeps its own brief, and the list is a 200',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { db, goalId: failingId, projectId } = decided.fx;
      await completeGoalFromExternalDecision(db, {
        goalId: failingId,
        attestationId: decided.attestationId,
        reviewedPreflightDigest: decided.digest,
        acknowledgeContentNotProven: true,
      });
      // A second completed row in the same database. No proof backs it, so the real reader reports an invalid standing.
      const otherId = createGoalDraft(db, {
        projectId,
        title: 'Second completed',
        definition: simpleDefinition(),
      }).goalId;
      db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").run(otherId);

      const realReader =
        await vi.importActual<typeof import('./completionStanding.js')>('./completionStanding.js');
      const expectedOther = realReader.readGoalCompletionStanding(db, otherId);
      vi.mocked(readGoalCompletionStanding).mockImplementation((database, goalId) => {
        if (goalId === failingId) throw new Error('forced reader failure for this test');
        return realReader.readGoalCompletionStanding(database, goalId);
      });
      app = goalApp(db);

      const response = await call(app, 'GET', '/api/goals');
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(2);
      const rows = response.body.goals as Array<{
        id: string;
        status: string;
        completionStandingBrief?: unknown;
      }>;
      const failing = rows.find((row) => row.id === failingId);
      const other = rows.find((row) => row.id === otherId);
      expect(failing?.status).toBe('completed');
      expect(failing?.completionStandingBrief).toEqual({ state: 'unreadable' });
      expect(other?.status).toBe('completed');
      expect(other?.completionStandingBrief).toEqual({
        state: 'ready',
        standing: expectedOther.standing,
        qualifier: expectedOther.claim.qualifier,
        trusted: expectedOther.claim.trustedForDownstream,
        contentPreservation: expectedOther.claim.contentPreservation,
      });
      expect(vi.mocked(readGoalCompletionStanding).mock.calls.map(([, goalId]) => goalId)).toEqual(
        expect.arrayContaining([failingId, otherId]),
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
