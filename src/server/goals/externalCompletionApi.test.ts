import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GoalExternalCompletionPreflightResponse,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi.js';
import { disabledSupervisor, goalApp } from './apiKit.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import {
  databaseSnapshot,
  repositoryState,
  reviewedDigest,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * HTTP tests for the version-2 completion routes, through `app.inject` on the production Fastify app. Each test uses the
 * real handoff, Git observation, attestation, decision and completion services on real Git and real SQLite. Only the
 * fixtures are test code; no service, Git call or database write is stubbed.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

/** Every table's row count and content digest, plus the repository's full state. A read must leave both unchanged. */
function wholeState(fx: GoalFixture) {
  return { db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo), inTransaction: fx.db.inTransaction };
}

async function get<T>(url: string): Promise<{ status: number; etag: string | undefined; body: T }> {
  const response = await app!.inject({ method: 'GET', url });
  return {
    status: response.statusCode,
    etag: response.headers.etag as string | undefined,
    body: JSON.parse(response.body) as T,
  };
}

const preflightUrl = (goalId: string, attestationId: string) =>
  `/api/goals/${goalId}/completion-preflight?attestationId=${attestationId}`;

describe('external completion preflight GET (read-only)', () => {
  it(
    'T1 GET preflight is read-only',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const before = wholeState(fx);

      const first = await get<GoalExternalCompletionPreflightResponse>(
        preflightUrl(fx.goalId, attestationId),
      );
      const second = await get<GoalExternalCompletionPreflightResponse>(
        preflightUrl(fx.goalId, attestationId),
      );

      expect(first.status).toBe(200);
      expect(first.body.preflight.outcome).toBe('ready');
      expect(first.body.preflight.digest).toBe(digest);
      expect(first.etag).toBe(`"${digest}"`);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(second.etag).toBe(first.etag);
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T2 GET preflight refusals are data',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      // A second database: its attestation identifier does not exist in this Goal's database.
      const elsewhere = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const base = `/api/goals/${fx.goalId}/completion-preflight`;
      const before = wholeState(fx);

      const foreign = await get<GoalExternalCompletionPreflightResponse>(
        preflightUrl(fx.goalId, elsewhere.attestationId),
      );
      expect(foreign.status).toBe(200);
      expect(foreign.body.preflight).toMatchObject({ outcome: 'refused', actionFields: null });
      expect(foreign.body.preflight.reasons).toEqual([{ code: 'attestation_not_found', detail: null }]);
      expect(foreign.etag).toBe(`"${foreign.body.preflight.digest}"`);

      const missing = await get<GoalExternalCompletionPreflightResponse>(
        preflightUrl(fx.goalId, randomUUID()),
      );
      expect(missing.status).toBe(200);
      expect(missing.body.preflight.reasons).toEqual([{ code: 'attestation_not_found', detail: null }]);

      expect((await get(base)).status).toBe(400);
      expect((await get(`${base}?attestationId=not-a-uuid`)).status).toBe(400);
      expect((await get(`${base}?attestationId=${attestationId}&extra=1`)).status).toBe(400);
      const unknownGoal = await get<{ code: string }>(preflightUrl(randomUUID(), attestationId));
      expect(unknownGoal).toMatchObject({ status: 404, body: { code: 'goal_not_found' } });

      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion status GET (read-only)', () => {
  it(
    'T14 R4 is read-only',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const statusUrl = `/api/goals/${fx.goalId}/completion`;
      const digest = await reviewedDigest(attested);
      const request = {
        goalId: fx.goalId,
        attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      };

      // not_completed: no decision, no proof.
      let before = wholeState(fx);
      const notCompleted = await get<GoalExternalCompletionStatus>(statusUrl);
      expect(notCompleted.status).toBe(200);
      expect(notCompleted.body).toMatchObject({
        goalId: fx.goalId,
        state: 'not_completed',
        decisions: [],
        completion: null,
      });
      expect(notCompleted.body.completionStanding).toEqual(readGoalCompletionStanding(fx.db, fx.goalId));
      expect(wholeState(fx)).toEqual(before);

      // decided: one valid approved decision, the Goal is still running.
      await recordExternalCompletionDecision(fx.db, request);
      before = wholeState(fx);
      const decided = await get<GoalExternalCompletionStatus>(statusUrl);
      expect(decided.status).toBe(200);
      expect(decided.body.state).toBe('decided');
      expect(decided.body.completion).toBeNull();
      expect(decided.body.decisions).toHaveLength(1);
      expect(decided.body.decisions[0]).toMatchObject({
        attestationId,
        status: 'approved',
        valid: true,
        invalidReason: null,
      });
      const actionDigest = decided.body.decisions[0]!.actionDigest!;
      expect(actionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(wholeState(fx)).toEqual(before);

      // completed: the stored proof identity is returned as recorded.
      await completeGoalFromExternalDecision(fx.db, request);
      before = wholeState(fx);
      const completed = await get<GoalExternalCompletionStatus>(statusUrl);
      expect(completed.status).toBe(200);
      expect(completed.body.state).toBe('completed');
      const stored = readStoredCompletion(fx.db, fx.goalId);
      expect(stored.state).toBe('completed');
      expect(completed.body.completion).toEqual(
        stored.state === 'completed'
          ? {
              proofId: stored.proofId,
              proofDigest: stored.proofDigest,
              approvalId: stored.approvalId,
              actionDigest: stored.actionDigest,
              preflightDigest: stored.preflightDigest,
              observedAt: stored.observedAt,
              completedAt: stored.completedAt,
            }
          : null,
      );
      expect(completed.body.completionStanding).toEqual(readGoalCompletionStanding(fx.db, fx.goalId));
      expect(wholeState(fx)).toEqual(before);

      // The exact-action filter: a matching digest keeps its decision and completion; another digest matches nothing.
      const exact = await get<GoalExternalCompletionStatus>(`${statusUrl}?actionDigest=${actionDigest}`);
      expect(exact.status).toBe(200);
      expect(exact.body.decisions.map((row) => row.actionDigest)).toEqual([actionDigest]);
      expect(exact.body.completion?.actionDigest).toBe(actionDigest);
      const other = await get<GoalExternalCompletionStatus>(`${statusUrl}?actionDigest=${'0'.repeat(64)}`);
      expect(other.status).toBe(200);
      expect(other.body).toMatchObject({ state: 'completed', decisions: [], completion: null });
      expect((await get(`${statusUrl}?actionDigest=${actionDigest.toUpperCase()}`)).status).toBe(400);
      expect((await get(`${statusUrl}?unknown=1`)).status).toBe(400);
      expect((await get(`/api/goals/${randomUUID()}/completion`)).status).toBe(404);
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T14 R4 is read-only for an invalid stored decision',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const recorded = await recordExternalCompletionDecision(fx.db, {
        goalId: fx.goalId,
        attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });
      // Tamper with the stored decision through raw SQL, as the decision tests do: the detail no longer matches its digest.
      const detail = fx.db
        .prepare('SELECT detail_json FROM goal_approvals WHERE id = ?')
        .get(recorded.approvalId) as { detail_json: string };
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity;');
      fx.db.exec('DROP TRIGGER trg_goal_approval_terminal;');
      fx.db
        .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
        .run(detail.detail_json.replace(digest, 'e'.repeat(64)), recorded.approvalId);

      const before = wholeState(fx);
      const response = await get<GoalExternalCompletionStatus>(`/api/goals/${fx.goalId}/completion`);
      expect(response.status).toBe(200);
      expect(response.body.state).toBe('invalid');
      expect(response.body.completion).toBeNull();
      expect(response.body.decisions).toEqual([
        {
          approvalId: recorded.approvalId,
          actionDigest: null,
          attestationId: null,
          status: null,
          valid: false,
          invalidReason: 'digest_mismatch',
        },
      ]);
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('no GET mutation across the completion routes', () => {
  it(
    'T16 GET part: no GET mutation across the preflight and status routes at every state',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const statusUrl = `/api/goals/${fx.goalId}/completion`;
      const preflightGet = preflightUrl(fx.goalId, attestationId);
      const request = {
        goalId: fx.goalId,
        attestationId,
        reviewedPreflightDigest: await reviewedDigest(attested),
        acknowledgeContentNotProven: true,
      };

      // Both GET routes are called at each state, and the whole state must be identical after the calls.
      const readBoth = async () => {
        const before = wholeState(fx);
        expect((await get(preflightGet)).status).toBe(200);
        expect((await get(preflightGet)).status).toBe(200);
        expect((await get(statusUrl)).status).toBe(200);
        expect((await get(statusUrl)).status).toBe(200);
        expect(wholeState(fx)).toEqual(before);
      };

      await readBoth();
      await recordExternalCompletionDecision(fx.db, request);
      await readBoth();
      await completeGoalFromExternalDecision(fx.db, request);
      await readBoth();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
