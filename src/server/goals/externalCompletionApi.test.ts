import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GoalExternalCompletionCompleted,
  GoalExternalCompletionDecisionRecorded,
  GoalExternalCompletionPreflightResponse,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi.js';
import { call, disabledSupervisor, goalApp } from './apiKit.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
import { completeGoal } from './completion.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import {
  completeGoalFromExternalDecision,
  EXTERNAL_COMPLETION_ERROR_CODES,
  ExternalCompletionError,
} from './externalCompletion.js';
import {
  EXTERNAL_COMPLETION_DECISION_ERROR_CODES,
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  passDeterministic,
  REAL_GIT_TEST_TIMEOUT_MS,
  simpleDefinition,
} from './repoKit.js';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import { externalCompletionError, externalCompletionStatus } from './goalRoutes.js';

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
      // R4 reads the completion identity from the standing, which has no preflight digest. The POST response keeps it.
      expect(completed.body.completion).toEqual(
        stored.state === 'completed'
          ? {
              proofId: stored.proofId,
              proofDigest: stored.proofDigest,
              approvalId: stored.approvalId,
              actionDigest: stored.actionDigest,
              attestationId,
              observedAt: stored.observedAt,
              completedAt: stored.completedAt,
            }
          : null,
      );
      expect(completed.body.completion).not.toHaveProperty('preflightDigest');
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
          eligibility: 'invalid',
          correctionStanding: null,
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

// --- The user's completion decision (R2) ---------------------------------------------------------------------------------

const FORMATS = ['sha1', 'sha256'] as const;

const decisionUrl = (goalId: string) => `/api/goals/${goalId}/completion-decision`;

/** Counts every row of one table that belongs to a Goal, for assertions that name a table. */
function countRows(fx: GoalFixture, table: string): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

function completionApprovals(fx: GoalFixture) {
  return fx.db
    .prepare(
      `SELECT id, gate, risk, requested_by, decided_by, status, external_completion_action_digest
       FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL ORDER BY rowid`,
    )
    .all(fx.goalId) as {
    id: string;
    gate: string;
    risk: string;
    requested_by: string;
    decided_by: string | null;
    status: string;
    external_completion_action_digest: string;
  }[];
}

describe('external completion decision (R2)', () => {
  it.each(FORMATS)(
    'T3 decision requires If-Match (%s)',
    async (format) => {
      const attested = await v2RunningAttestedFixture(format);
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const body = {
        decision: 'record_completion_decision',
        attestationId,
        acknowledgeContentNotProven: true,
      };
      const before = wholeState(fx);

      expect(await call(app, 'POST', decisionUrl(fx.goalId), body)).toMatchObject({
        status: 428,
        body: { code: 'reviewed_action_precondition_required' },
      });
      expect(
        await call(app, 'POST', decisionUrl(fx.goalId), body, { 'if-match': 'not-a-digest' }),
      ).toMatchObject({
        status: 400,
        body: { code: 'reviewed_action_precondition_invalid' },
      });
      expect(
        await call(app, 'POST', decisionUrl(fx.goalId), body, { 'if-match': `"${digest.toUpperCase()}"` }),
      ).toMatchObject({ status: 400, body: { code: 'reviewed_action_precondition_invalid' } });
      for (const extra of [{ decidedBy: 'user' }, { actor: 'user' }, { attestationDigest: 'a'.repeat(64) }]) {
        expect(
          await call(
            app,
            'POST',
            decisionUrl(fx.goalId),
            { ...body, ...extra },
            { 'if-match': `"${digest}"` },
          ),
        ).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      }
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'T3 a digest of another ready preflight is refused with 412 (%s)',
    async (format) => {
      const attested = await v2RunningAttestedFixture(format);
      const other = await v2RunningAttestedFixture(format);
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const substituted = await reviewedDigest(other);
      const before = wholeState(fx);

      expect(
        await call(
          app,
          'POST',
          decisionUrl(fx.goalId),
          { decision: 'record_completion_decision', attestationId, acknowledgeContentNotProven: true },
          { 'if-match': `"${substituted}"` },
        ),
      ).toMatchObject({ status: 412, body: { code: 'reviewed_preflight_changed' } });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // The plan expected 412 `reviewed_preflight_changed` for a digest made stale by a correction. The code refuses the
  // disputed attestation at its correction-standing check (externalCompletionPreflight.ts), before the digest is compared,
  // so the observed response is 409 `preflight_refused` with detail `attestation_disputed`. 412 is pinned by the
  // substituted-digest test above. Pinned as observed; no write either way.
  it(
    'T3 a digest made stale by a correction is refused with 409 preflight_refused (attestation_disputed)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const staleDigest = await reviewedDigest(attested);
      appendCorrectionForTest(fx, attestationId, 'dispute');
      const before = wholeState(fx);

      expect(
        await call(
          app,
          'POST',
          decisionUrl(fx.goalId),
          { decision: 'record_completion_decision', attestationId, acknowledgeContentNotProven: true },
          { 'if-match': `"${staleDigest}"` },
        ),
      ).toMatchObject({
        status: 409,
        body: { code: 'preflight_refused', detail: 'attestation_disputed' },
      });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T4 acknowledgement required',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const before = wholeState(fx);

      expect(
        await call(
          app,
          'POST',
          decisionUrl(fx.goalId),
          { decision: 'record_completion_decision', attestationId, acknowledgeContentNotProven: false },
          { 'if-match': `"${digest}"` },
        ),
      ).toMatchObject({ status: 400, body: { code: 'acknowledgement_required' } });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'T5 decision happy path records one approval and completes nothing (%s)',
    async (format) => {
      const attested = await v2RunningAttestedFixture(format);
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const before = wholeState(fx);
      const eventsBefore = fx.db
        .prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?')
        .get(fx.goalId);

      const response = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        {
          decision: 'record_completion_decision',
          attestationId,
          acknowledgeContentNotProven: true,
          note: 'Reviewed.',
        },
        { 'if-match': `"${digest}"` },
      );
      expect(response.status).toBe(201);
      const body = response.body as GoalExternalCompletionDecisionRecorded;
      expect(body).toEqual({
        approvalId: body.approvalId,
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        preflightDigest: digest,
        status: 'approved',
        reused: false,
      });

      const approvals = completionApprovals(fx);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        id: body.approvalId,
        gate: 'user_confirmation',
        risk: 'high',
        requested_by: 'user',
        decided_by: 'user',
        status: 'approved',
        external_completion_action_digest: body.actionDigest,
      });
      expect(
        fx.db.prepare('SELECT status, completed_at FROM goals WHERE id = ?').get(fx.goalId),
      ).toMatchObject({
        status: 'running',
        completed_at: null,
      });
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(0);
      const added = fx.db
        .prepare('SELECT type FROM goal_events WHERE goal_id = ? ORDER BY rowid')
        .all(fx.goalId)
        .slice((eventsBefore as { n: number }).n) as { type: string }[];
      expect(added.map((event) => event.type)).toEqual(['approval_requested', 'approval_decided']);
      expect(repositoryState(fx.repo)).toEqual(before.repo);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'T6 decision repeat reuses the same approval and writes nothing (%s)',
    async (format) => {
      const attested = await v2RunningAttestedFixture(format);
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const request = {
        decision: 'record_completion_decision',
        attestationId,
        acknowledgeContentNotProven: true,
      };
      const first = await call(app, 'POST', decisionUrl(fx.goalId), request, { 'if-match': `"${digest}"` });
      expect(first.status).toBe(201);
      const before = wholeState(fx);

      const again = await call(app, 'POST', decisionUrl(fx.goalId), request, { 'if-match': `"${digest}"` });
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ...first.body, reused: true });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T7 decision conflict is refused and nothing is merged',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      // A different approved decision for the same attestation, seeded through the approval primitives as the decision
      // tests do (D17). Production cannot otherwise hold two digests for one attestation.
      const report = await computeExternalCompletionPreflight(
        fx.db,
        fx.goalId,
        { attestationId },
        { allowRecordedDecision: true },
      );
      const conflicting = buildExternalCompletionAction({
        ...report.actionFields!,
        userReviewedPreflightDigest: 'f'.repeat(64),
      })!;
      const seeded = requestGoalApproval(fx.db, {
        goalId: fx.goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Conflicting decision for the same attestation.',
        requestedBy: 'user',
        detail: { ...conflicting },
        externalCompletionActionDigest: conflicting.actionDigest,
      });
      decideGoalApproval(fx.db, {
        goalId: fx.goalId,
        approvalId: seeded.id,
        decision: 'approved',
        decidedBy: 'user',
      });
      const before = wholeState(fx);

      expect(
        await call(
          app,
          'POST',
          decisionUrl(fx.goalId),
          { decision: 'record_completion_decision', attestationId, acknowledgeContentNotProven: true },
          { 'if-match': `"${digest}"` },
        ),
      ).toMatchObject({ status: 409, body: { code: 'decision_conflict' } });
      expect(wholeState(fx)).toEqual(before);
      expect(completionApprovals(fx).map((row) => row.id)).toEqual([seeded.id]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T13 the generic approval route cannot decide a pending completion approval',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      // A pending completion approval, seeded through the approval primitive. The decision service never leaves one pending.
      const report = await computeExternalCompletionPreflight(
        fx.db,
        fx.goalId,
        { attestationId },
        { allowRecordedDecision: true },
      );
      const action = buildExternalCompletionAction({
        ...report.actionFields!,
        userReviewedPreflightDigest: digest,
      })!;
      const pending = requestGoalApproval(fx.db, {
        goalId: fx.goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Pending completion decision.',
        requestedBy: 'user',
        detail: { ...action },
        externalCompletionActionDigest: action.actionDigest,
      });
      const before = wholeState(fx);

      expect(
        await call(app, 'POST', `/api/goal-approvals/${pending.id}/decision`, { decision: 'approved' }),
      ).toMatchObject({ status: 409, body: { code: 'completion_decision_requires_dedicated_service' } });
      expect(getGoalApproval(fx.db, pending.id)?.status).toBe('pending');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

// --- Status mapping and the bounded error body (T15) ---------------------------------------------------------------------

/** A reply that records what the mapper sends, for the mapper's unit assertions. */
function recordingReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply;
}

describe('external completion error mapping (T15)', () => {
  it('T15 every completion service code has one explicit HTTP status', () => {
    // The expected table is written out here, separately from the route file, so that a changed status fails this test.
    const expected: Record<string, number> = {
      decision_input_invalid: 400,
      completion_input_invalid: 400,
      acknowledgement_required: 400,
      goal_not_found: 404,
      decision_not_found: 404,
      reviewed_preflight_changed: 412,
      decision_corrupt: 422,
      completion_corrupt: 422,
      proof_invalid: 422,
      completion_proof_required: 422,
      completion_busy: 429,
      decision_persistence_failed: 503,
      completion_persistence_failed: 503,
      completion_read_failed: 503,
      completion_internal_state: 503,
      manual_reconciliation_required: 409,
      preflight_refused: 409,
      authority_changed_during_decision: 409,
      authority_changed_during_completion: 409,
      decision_conflict: 409,
      competing_decision: 409,
      completion_conflict: 409,
      completion_already_recorded: 409,
      goal_not_running: 409,
      goal_work_in_flight: 409,
      destination_changed: 409,
      decision_action_mismatch: 409,
      proof_action_mismatch: 409,
    };
    const codes = [
      ...new Set([...EXTERNAL_COMPLETION_ERROR_CODES, ...EXTERNAL_COMPLETION_DECISION_ERROR_CODES]),
    ];
    expect([...codes].sort()).toEqual(Object.keys(expected).sort());
    for (const code of codes) expect(externalCompletionStatus(code, null), code).toBe(expected[code]);
  });

  it('T15 a preflight refusal takes its status from the refusal detail', () => {
    const detailStatus: Record<string, number> = {
      goal_not_found: 404,
      attestation_not_found: 404,
      verification_busy: 429,
      git_unavailable: 503,
      preflight_unavailable: 503,
      attestation_invalid: 422,
      observation_changed: 409,
    };
    for (const [detail, status] of Object.entries(detailStatus))
      expect(externalCompletionStatus('preflight_refused', detail), detail).toBe(status);
    expect(externalCompletionStatus('preflight_refused', null)).toBe(409);
  });

  it('T15 a bounded detail is returned and an unbounded one is dropped', () => {
    const reply = recordingReply();
    externalCompletionError(
      new ExternalCompletionDecisionError('preflight_refused', 'observation_changed'),
      reply as unknown as FastifyReply,
    );
    expect(reply).toMatchObject({
      statusCode: 409,
      body: {
        code: 'preflight_refused',
        detail: 'observation_changed',
        error: expect.any(String),
      },
    });
    const unbounded = recordingReply();
    externalCompletionError(
      new ExternalCompletionError('completion_conflict', 'Not A Snake Detail!'),
      unbounded as unknown as FastifyReply,
    );
    expect(unbounded.statusCode).toBe(409);
    expect(unbounded.body).not.toHaveProperty('detail');
  });

  it('T15 an unexpected failure is a generic 503 with no stack, SQL or service text', () => {
    const reply = recordingReply();
    externalCompletionError(
      new Error('SQLITE_ERROR: no such table goal_external_completion_proofs at /private/db/path.sqlite'),
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toEqual({
      error: 'External completion could not be verified or recorded safely.',
      code: 'external_completion_unavailable',
    });
    expect(JSON.stringify(reply.body)).not.toMatch(/SQLITE|private|stack|goal_external/);
  });

  it('T15 a service refusal is never a generic 503', () => {
    const reply = recordingReply();
    externalCompletionError(
      new ExternalCompletionError('completion_read_failed', 'decision_read'),
      reply as unknown as FastifyReply,
    );
    expect(reply).toMatchObject({
      statusCode: 503,
      body: { code: 'completion_read_failed', detail: 'decision_read' },
    });
  });
});

// --- The explicit completion (R3) -------------------------------------------------------------------------------------

type Attested = Awaited<ReturnType<typeof v2RunningAttestedFixture>>;

const completionUrl = (goalId: string) => `/api/goals/${goalId}/completion`;
const completeBody = { decision: 'complete_goal', acknowledgeContentNotProven: true };

/** Records the user decision through R2 for the ready preflight, and returns the decision response (R2's action digest). */
async function decideOverHttp(app: FastifyInstance, attested: Attested) {
  const digest = await reviewedDigest(attested);
  const response = await call(
    app,
    'POST',
    decisionUrl(attested.fx.goalId),
    {
      decision: 'record_completion_decision',
      attestationId: attested.attestationId,
      acknowledgeContentNotProven: true,
    },
    { 'if-match': `"${digest}"` },
  );
  expect(response.status).toBe(201);
  return response.body as GoalExternalCompletionDecisionRecorded;
}

/** The Goal's status and the reason code that completed it, read directly from the table. */
function goalStatusRow(fx: GoalFixture) {
  return fx.db.prepare('SELECT status, status_reason_code FROM goals WHERE id = ?').get(fx.goalId) as {
    status: string;
    status_reason_code: string | null;
  };
}

/** Moves the destination branch by one commit made outside Turing, the way the lifecycle tests do. Returns the new tip. */
function advanceDestination(repo: string, fileName: string): string {
  writeFileSync(join(repo, fileName), `${fileName}\n`);
  git(repo, 'add', fileName);
  git(repo, 'commit', '-q', '-m', `user commit ${fileName}`);
  return git(repo, 'rev-parse', 'main');
}

describe('external completion (R3)', () => {
  it(
    'T8 completion refused without a decision: 404 decision_not_found, no write; header errors are refused without a write',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const digest = await reviewedDigest(attested);
      const before = wholeState(fx);

      // A random digest names no decision; so does a preflight digest, which is not an action digest.
      for (const named of [randomBytes(32).toString('hex'), digest]) {
        expect(
          await call(app, 'POST', completionUrl(fx.goalId), completeBody, { 'if-match': `"${named}"` }),
        ).toMatchObject({ status: 404, body: { code: 'decision_not_found' } });
      }
      expect(await call(app, 'POST', completionUrl(fx.goalId), completeBody, {})).toMatchObject({
        status: 428,
        body: { code: 'reviewed_action_precondition_required' },
      });
      expect(
        await call(app, 'POST', completionUrl(fx.goalId), completeBody, { 'if-match': 'not-a-digest' }),
      ).toMatchObject({ status: 400, body: { code: 'reviewed_action_precondition_invalid' } });
      expect(
        await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
          'if-match': `"${digest.toUpperCase()}"`,
        }),
      ).toMatchObject({ status: 400, body: { code: 'reviewed_action_precondition_invalid' } });

      expect(wholeState(fx)).toEqual(before);
      expect(goalStatusRow(fx).status).toBe('running');
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T9 completion happy path: 201, one proof, Goal completed by the user-confirmed reason, ids equal the stored completion',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      // Read before the decision: once a completion decision exists, the default preflight refuses every attestation
      // with completion_already_recorded (externalCompletionPreflight.ts, plan section 0).
      const digest = await reviewedDigest(attested);
      const decided = await decideOverHttp(app, attested);

      const response = await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
        'if-match': `"${decided.actionDigest}"`,
      });
      expect(response.status).toBe(201);
      const body = response.body as GoalExternalCompletionCompleted;
      const stored = readStoredCompletion(fx.db, fx.goalId);
      expect(stored.state).toBe('completed');
      expect(body).toEqual({
        reused: false,
        completion: {
          proofId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          proofDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          approvalId: decided.approvalId,
          actionDigest: decided.actionDigest,
          preflightDigest: digest,
          observedAt: expect.any(String),
          completedAt: expect.any(String),
        },
        completionStanding: readGoalCompletionStanding(fx.db, fx.goalId),
      });
      if (stored.state !== 'completed') throw new Error('unreachable');
      expect(body.completion).toEqual({
        proofId: stored.proofId,
        proofDigest: stored.proofDigest,
        approvalId: stored.approvalId,
        actionDigest: stored.actionDigest,
        preflightDigest: stored.preflightDigest,
        observedAt: stored.observedAt,
        completedAt: stored.completedAt,
      });
      expect(goalStatusRow(fx)).toEqual({
        status: 'completed',
        status_reason_code: EXTERNAL_COMPLETION_REASON,
      });
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T10 completion repeat, destination movement after completion, and R4 by action digest all return the same completion',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      const request = { 'if-match': `"${decided.actionDigest}"` };
      const first = await call(app, 'POST', completionUrl(fx.goalId), completeBody, request);
      expect(first.status).toBe(201);
      const proofId = first.body.completion.proofId as string;

      // A repeat with the same digest writes nothing (the replay answers first, before any Git).
      const beforeRepeat = wholeState(fx);
      const repeat = await call(app, 'POST', completionUrl(fx.goalId), completeBody, request);
      expect(repeat.status).toBe(200);
      expect(repeat.body).toEqual({ ...first.body, reused: true });
      expect(wholeState(fx)).toEqual(beforeRepeat);
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(1);

      // Pinned: the destination branch moves after completion. The stored completion still replays, with no write to Turing.
      const databaseBeforeMove = databaseSnapshot(fx.db);
      const movedTip = advanceDestination(fx.repo, 'after-completion.txt');
      expect(git(fx.repo, 'rev-parse', 'main')).toBe(movedTip);
      const afterMove = await call(app, 'POST', completionUrl(fx.goalId), completeBody, request);
      expect(afterMove.status).toBe(200);
      expect(afterMove.body).toEqual({ ...first.body, reused: true });
      expect(databaseSnapshot(fx.db)).toEqual(databaseBeforeMove);
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(1);

      // R4 names the same completion for this exact action digest.
      const status = await call(
        app,
        'GET',
        `/api/goals/${fx.goalId}/completion?actionDigest=${decided.actionDigest}`,
      );
      expect(status.status).toBe(200);
      expect(status.body.state).toBe('completed');
      // R4's record is the POST identity without preflightDigest (the standing does not carry it).
      expect(status.body.completion).toEqual({
        proofId: first.body.completion.proofId,
        proofDigest: first.body.completion.proofDigest,
        approvalId: first.body.completion.approvalId,
        actionDigest: first.body.completion.actionDigest,
        attestationId: attested.attestationId,
        observedAt: first.body.completion.observedAt,
        completedAt: first.body.completion.completedAt,
      });
      expect(status.body.completion).not.toHaveProperty('preflightDigest');
      expect(status.body.completion.proofId).toBe(proofId);
      expect(status.body.completionStanding).toEqual(readGoalCompletionStanding(fx.db, fx.goalId));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T11 pending A and B for one attestation: neither completes; B is decision_conflict, A is reviewed_preflight_changed, nothing written (pinned)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      // B is the real decision for the current ready preflight, recorded through R2.
      const decidedB = await decideOverHttp(app, attested);
      // A is a second approved decision for the same attestation with a different reviewed digest, seeded through the
      // approval primitives as T7 does. Its action is internally consistent, so it is a valid stored decision.
      const report = await computeExternalCompletionPreflight(
        fx.db,
        fx.goalId,
        { attestationId },
        { allowRecordedDecision: true },
      );
      const otherAction = buildExternalCompletionAction({
        ...report.actionFields!,
        userReviewedPreflightDigest: 'f'.repeat(64),
      })!;
      const seededA = requestGoalApproval(fx.db, {
        goalId: fx.goalId,
        gate: 'user_confirmation',
        risk: 'high',
        reason: 'Second decision for the same attestation.',
        requestedBy: 'user',
        detail: { ...otherAction },
        externalCompletionActionDigest: otherAction.actionDigest,
      });
      decideGoalApproval(fx.db, {
        goalId: fx.goalId,
        approvalId: seededA.id,
        decision: 'approved',
        decidedBy: 'user',
      });
      expect(completionApprovals(fx).map((row) => row.id)).toEqual([decidedB.approvalId, seededA.id]);
      const before = wholeState(fx);

      // Observed, not the planned "B completes": the terminal writer requires exactly one own classifier entry for the
      // attestation (externalCompletionTerminal.ts, own-count !== 1), so B is refused with decision_conflict after Git,
      // inside a transaction that rolls back. A's reviewed digest is not the current preflight, so A is refused earlier
      // with 412 reviewed_preflight_changed (externalCompletion.ts, the reviewed digest comparison). Neither is consumed.
      expect(
        await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
          'if-match': `"${decidedB.actionDigest}"`,
        }),
      ).toMatchObject({ status: 409, body: { code: 'decision_conflict' } });
      expect(
        await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
          'if-match': `"${otherAction.actionDigest}"`,
        }),
      ).toMatchObject({ status: 412, body: { code: 'reviewed_preflight_changed' } });
      expect(wholeState(fx)).toEqual(before);
      expect(goalStatusRow(fx).status).toBe('running');
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T11 pinned: R2 refuses a decision for another attestation Y while X is approved and unconsumed (competing decision)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decidedX = await decideOverHttp(app, attested);
      // The destination moves, so X no longer matches the tip. Y attests the new tip. A second attestation cannot be made
      // at the same tip (UNIQUE goal_approvals external_integration_action_digest), so the tip must move first.
      advanceDestination(fx.repo, 'second-tip.txt');
      const attestationY = await reattestAtCurrentTip(attested);

      // Observed: while X's decision is eligible, the read-only preflight refuses Y as a competing decision.
      const readPreflightY = await get<GoalExternalCompletionPreflightResponse>(
        preflightUrl(fx.goalId, attestationY.attestationId),
      );
      expect(readPreflightY.body.preflight.outcome).toBe('refused');
      expect(readPreflightY.body.preflight.reasons[0]?.code).toBe('completion_already_recorded');
      expect(readPreflightY.body.preflight.reasons[0]?.detail).toBe('competing_decision');
      // The digest for Y comes from the same preflight the decision service uses (allowRecordedDecision). That option
      // never waives a competing decision, so this digest belongs to a refused report.
      const digestY = (
        await computeExternalCompletionPreflight(
          fx.db,
          fx.goalId,
          { attestationId: attestationY.attestationId },
          { allowRecordedDecision: true },
        )
      ).digest;

      // X is now refused at its fresh preflight: the destination moved away from its decided tip.
      const beforeX = wholeState(fx);
      expect(
        await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
          'if-match': `"${decidedX.actionDigest}"`,
        }),
      ).toMatchObject({
        status: 409,
        body: { code: 'preflight_refused', detail: 'destination_advanced_after_observation' },
      });
      expect(wholeState(fx)).toEqual(beforeX);

      // R2 refuses a decision for Y while X's eligible decision exists. The option does not waive class 4.
      const beforeY = wholeState(fx);
      const refusedY = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        {
          decision: 'record_completion_decision',
          attestationId: attestationY.attestationId,
          acknowledgeContentNotProven: true,
        },
        { 'if-match': `"${digestY}"` },
      );
      // The decision service reports the competing decision by its own code, with no detail.
      expect(refusedY).toMatchObject({ status: 409, body: { code: 'competing_decision' } });
      expect(refusedY.body).not.toHaveProperty('detail');
      expect(wholeState(fx)).toEqual(beforeY);
      expect(completionApprovals(fx).map((row) => row.id)).toEqual([decidedX.approvalId]);
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'T12 completion refused after the destination moved writes nothing and the Goal stays running (%s)',
    async (format) => {
      const attested = await v2RunningAttestedFixture(format);
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      advanceDestination(fx.repo, 'moved-before-completion.txt');
      const before = wholeState(fx);

      // Observed (plan expected destination_changed or reviewed_preflight_changed): the fresh preflight refuses first, with
      // detail destination_advanced_after_observation. The service's own destination comparison is never reached here.
      const response = await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
        'if-match': `"${decided.actionDigest}"`,
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'preflight_refused',
        detail: 'destination_advanced_after_observation',
      });
      expect(wholeState(fx)).toEqual(before);
      expect(goalStatusRow(fx).status).toBe('running');
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T13 completion body: a missing decision, or any extra key (attestationId, decidedBy, actor), is 400 invalid_request with no write',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      const header = { 'if-match': `"${decided.actionDigest}"` };
      const before = wholeState(fx);

      const invalidBodies = [
        { acknowledgeContentNotProven: true },
        { ...completeBody, decision: 'record_completion_decision' },
        { ...completeBody, attestationId },
        { ...completeBody, decidedBy: 'user' },
        { ...completeBody, decidedBy: 'supervisor' },
        { ...completeBody, actor: 'user' },
      ];
      for (const body of invalidBodies)
        expect(
          await call(app, 'POST', completionUrl(fx.goalId), body, header),
          JSON.stringify(body),
        ).toMatchObject({
          status: 400,
          body: { code: 'invalid_request' },
        });
      expect(wholeState(fx)).toEqual(before);
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T13 the generic approval route refuses a pending completion approval; an approved one is an idempotent no-op (pinned)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      const before = wholeState(fx);

      // Observed: the dedicated-service refusal (goalCommands.ts, inside `existing.status === 'pending'`) applies only to a
      // pending row. An approved completion row falls through to decideGoalApproval, which reports no change. No write.
      expect(
        await call(app, 'POST', `/api/goal-approvals/${decided.approvalId}/decision`, {
          decision: 'approved',
        }),
      ).toMatchObject({
        status: 200,
        body: { approvalId: decided.approvalId, changed: false, status: 'approved' },
      });
      expect(wholeState(fx)).toEqual(before);
      expect(completionApprovals(fx).map((row) => row.status)).toEqual(['approved']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'T16 rest: every refused completion POST, at each state, leaves the whole state unchanged',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const refusedAt = async (digest: string | null) => {
        const header = digest === null ? {} : { 'if-match': `"${digest}"` };
        const before = wholeState(fx);
        const unknown = randomBytes(32).toString('hex');
        // Refusals that need no decision: a missing or malformed header, and an unknown digest.
        expect((await call(app!, 'POST', completionUrl(fx.goalId), completeBody, {})).status).toBe(428);
        expect(
          (await call(app!, 'POST', completionUrl(fx.goalId), completeBody, { 'if-match': 'x' })).status,
        ).toBe(400);
        expect(
          (await call(app!, 'POST', completionUrl(fx.goalId), completeBody, { 'if-match': `"${unknown}"` }))
            .status,
        ).toBe(404);
        if (digest !== null) {
          expect(
            (
              await call(
                app!,
                'POST',
                completionUrl(fx.goalId),
                { ...completeBody, acknowledgeContentNotProven: false },
                header,
              )
            ).body.code,
          ).toBe('acknowledgement_required');
        }
        expect(wholeState(fx)).toEqual(before);
      };

      // not_completed: no decision exists.
      await refusedAt(null);
      // decided: one valid decision waits.
      const decided = await decideOverHttp(app, attested);
      await refusedAt(decided.actionDigest);
      // completed: the stored completion stands; a refused acknowledgement still writes nothing.
      expect(
        (
          await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
            'if-match': `"${decided.actionDigest}"`,
          })
        ).status,
      ).toBe(201);
      await refusedAt(decided.actionDigest);
      expect(countRows(fx, 'goal_external_completion_proofs')).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

// --- The R4 status after a correction and for a version-1 completion ------------------------------------------------------

describe('external completion status after a correction and for a legacy completion (R4)', () => {
  it(
    'R4 a version-2 completion disputed afterwards is contested: the identity stays, the success claim does not',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      const completedResponse = await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
        'if-match': `"${decided.actionDigest}"`,
      });
      expect(completedResponse.status).toBe(201);
      const completion = completedResponse.body.completion as GoalExternalCompletionCompleted['completion'];

      // Before this fix R4 answered `completed` here, which the standing contradicts. It is now `contested`.
      appendCorrectionForTest(fx, attestationId, 'dispute');
      const before = wholeState(fx);
      const response = await get<GoalExternalCompletionStatus>(`/api/goals/${fx.goalId}/completion`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        goalId: fx.goalId,
        state: 'contested',
        decisions: [
          {
            approvalId: decided.approvalId,
            actionDigest: decided.actionDigest,
            attestationId,
            status: 'approved',
            valid: true,
            invalidReason: null,
            eligibility: 'ineligible',
            correctionStanding: 'disputed',
          },
        ],
        completion: {
          proofId: completion.proofId,
          proofDigest: completion.proofDigest,
          approvalId: completion.approvalId,
          actionDigest: completion.actionDigest,
          attestationId,
          observedAt: completion.observedAt,
          completedAt: completion.completedAt,
        },
        completionStanding: readGoalCompletionStanding(fx.db, fx.goalId),
      });
      expect(response.body.completionStanding).toMatchObject({
        kind: 'v2',
        standing: 'disputed',
        claim: { unqualifiedSuccessAllowed: false, trustedForDownstream: false },
      });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R4 a version-1 completion reports legacy, not invalid',
    async () => {
      // The legacy fixture of the completion standing tests: a version-1 completion made by the real completeGoal path.
      const fx = goalRepoFixture({ definition: simpleDefinition() });
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      fx.advance({ 'src/work.ts': 'w' });
      await passDeterministic(fx);
      expect((await completeGoal(fx.db, fx.goalId)).completed).toBe(true);
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const before = wholeState(fx);

      const response = await get<GoalExternalCompletionStatus>(`/api/goals/${fx.goalId}/completion`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        goalId: fx.goalId,
        state: 'legacy',
        decisions: [],
        completion: null,
        completionStanding: { kind: 'legacy', standing: 'historical_legacy' },
      });
      expect(response.body.completionStanding).toEqual(readGoalCompletionStanding(fx.db, fx.goalId));
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R4 a completion record has exactly the standing identity keys, and never a preflightDigest',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      expect(
        (
          await call(app, 'POST', completionUrl(fx.goalId), completeBody, {
            'if-match': `"${decided.actionDigest}"`,
          })
        ).status,
      ).toBe(201);

      const response = await get<GoalExternalCompletionStatus>(`/api/goals/${fx.goalId}/completion`);
      expect(response.body.state).toBe('completed');
      expect(Object.keys(response.body.completion ?? {}).sort()).toEqual([
        'actionDigest',
        'approvalId',
        'attestationId',
        'completedAt',
        'observedAt',
        'proofDigest',
        'proofId',
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

// --- Eligibility and the decided state ------------------------------------------------------------------------------------

/** Moves the destination branch to a commit made outside Turing and leaves it there. */
function moveDestination(fx: GoalFixture, baseRef: string, label: string): void {
  const current = git(fx.repo, 'rev-parse', baseRef);
  const tree = git(fx.repo, 'rev-parse', `${current}^{tree}`);
  git(fx.repo, 'update-ref', baseRef, git(fx.repo, 'commit-tree', tree, '-p', current, '-m', label));
}

/** The action body the preflight reports for one attestation, as the classifier tests build it. Test-only. */
async function actionBody(fx: GoalFixture, attestationId: string): Promise<Record<string, unknown>> {
  const report = await computeExternalCompletionPreflight(
    fx.db,
    fx.goalId,
    { attestationId },
    { allowRecordedDecision: true },
  );
  if (!report.actionFields) throw new Error('actionBody: the preflight reports no action fields');
  return { ...report.actionFields, userReviewedPreflightDigest: report.digest };
}

/** Writes one completion decision row for an action body and approves it as the user. Test-only seed. */
function seedApprovedRow(fx: GoalFixture, body: Record<string, unknown>): string {
  const action = buildExternalCompletionAction(body);
  if (action === null) throw new Error('seedApprovedRow: the action body is not valid');
  const approval = requestGoalApproval(fx.db, {
    goalId: fx.goalId,
    gate: 'user_confirmation',
    risk: 'high',
    reason: 'Seeded completion row for a status test.',
    requestedBy: 'user',
    detail: { ...action },
    externalCompletionActionDigest: action.actionDigest,
  });
  decideGoalApproval(fx.db, {
    goalId: fx.goalId,
    approvalId: approval.id,
    decision: 'approved',
    decidedBy: 'user',
  });
  return approval.id;
}

describe('external completion status eligibility and the decided state', () => {
  const statusUrl = (goalId: string) => `/api/goals/${goalId}/completion`;

  it.each([
    ['dispute', 'disputed'],
    ['withdraw', 'withdrawn'],
    ['supersede', 'superseded'],
  ] as const)(
    'S1/S2 a decision whose attestation is corrected by %s is ineligible, the Goal is not decided, and the GET writes nothing',
    async (kind, standing) => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      if (kind === 'supersede') {
        moveDestination(fx, attested.handoff.target.baseRef, 'destination moved before the replacement');
        const replacement = await reattestAtCurrentTip(attested);
        appendCorrectionForTest(fx, attestationId, kind, replacement.attestationId);
      } else appendCorrectionForTest(fx, attestationId, kind);
      const before = wholeState(fx);

      const first = await get<GoalExternalCompletionStatus>(statusUrl(fx.goalId));
      const second = await get<GoalExternalCompletionStatus>(statusUrl(fx.goalId));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        state: 'not_completed',
        completion: null,
        decisions: [
          {
            approvalId: decided.approvalId,
            actionDigest: decided.actionDigest,
            attestationId,
            valid: true,
            eligibility: 'ineligible',
            correctionStanding: standing,
          },
        ],
      });
      expect(first.body.completionStanding).toEqual(readGoalCompletionStanding(fx.db, fx.goalId));
      expect(first.body.completionStanding.claim.contentPreservation).not.toBe('proven');
      expect(second.body).toEqual(first.body);
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'S8 a decision whose attestation is uncorrected stays eligible when Git has moved past it',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const decided = await decideOverHttp(app, attested);
      moveDestination(fx, attested.handoff.target.baseRef, 'destination moved after the decision');

      const response = await get<GoalExternalCompletionStatus>(statusUrl(fx.goalId));
      expect(response.body.state).toBe('decided');
      expect(response.body.decisions).toEqual([
        expect.objectContaining({
          approvalId: decided.approvalId,
          valid: true,
          eligibility: 'eligible',
          correctionStanding: 'active_uncontested',
        }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'S3 after a dispute and a fresh attestation, the Goal is decided by the fresh decision; the exact filter returns only it',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      appendCorrectionForTest(fx, decided.attestationId, 'dispute');
      moveDestination(fx, decided.handoff.target.baseRef, 'destination moved for a fresh attestation');
      const fresh = await reattestAtCurrentTip(decided);
      const digest = await reviewedDigest({ fx, attestationId: fresh.attestationId });
      const recorded = await recordExternalCompletionDecision(fx.db, {
        goalId: fx.goalId,
        attestationId: fresh.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });

      const status = await get<GoalExternalCompletionStatus>(statusUrl(fx.goalId));
      expect(status.body.state).toBe('decided');
      expect(status.body.completion).toBeNull();
      expect(status.body.decisions).toEqual([
        expect.objectContaining({
          approvalId: decided.recorded.approvalId,
          attestationId: decided.attestationId,
          eligibility: 'ineligible',
          correctionStanding: 'disputed',
        }),
        expect.objectContaining({
          approvalId: recorded.approvalId,
          attestationId: fresh.attestationId,
          eligibility: 'eligible',
          correctionStanding: 'active_uncontested',
        }),
      ]);
      const freshDigest = status.body.decisions[1]!.actionDigest!;
      const exact = await get<GoalExternalCompletionStatus>(
        `${statusUrl(fx.goalId)}?actionDigest=${freshDigest}`,
      );
      expect(exact.body.state).toBe('decided');
      expect(exact.body.decisions).toEqual([status.body.decisions[1]]);
      expect(exact.body.completion).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'S4 two eligible decisions for different attestations (seeded through the approval primitives): both eligible, state decided',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      // Both bodies are read before the decisions exist, so each preflight is ready and internally consistent.
      const bodyFirst = await actionBody(fx, attestationId);
      moveDestination(fx, attested.handoff.target.baseRef, 'destination moved for a second attestation');
      const second = await reattestAtCurrentTip(attested);
      const bodySecond = await actionBody(fx, second.attestationId);
      const firstId = seedApprovedRow(fx, bodyFirst);
      const secondId = seedApprovedRow(fx, bodySecond);
      const before = wholeState(fx);

      const response = await get<GoalExternalCompletionStatus>(statusUrl(fx.goalId));
      expect(response.body.state).toBe('decided');
      expect(response.body.completion).toBeNull();
      expect(
        response.body.decisions.map((view) => [view.approvalId, view.attestationId, view.eligibility]),
      ).toEqual([
        [firstId, attestationId, 'eligible'],
        [secondId, second.attestationId, 'eligible'],
      ]);
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'S5 a completion row for a fabricated attestation is an invalid view, the Goal is invalid, and the GET writes nothing',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      app = goalApp(fx.db, disabledSupervisor(fx.db));
      const body = await actionBody(fx, decided.attestationId);
      const fabricated = randomUUID();
      const fabricatedId = seedApprovedRow(fx, {
        ...body,
        attestation: { ...(body.attestation as Record<string, unknown>), id: fabricated },
        correctionChain: { ...(body.correctionChain as Record<string, unknown>), attestationId: fabricated },
      });
      const before = wholeState(fx);

      const response = await get<GoalExternalCompletionStatus>(statusUrl(fx.goalId));
      expect(response.status).toBe(200);
      expect(response.body.state).toBe('invalid');
      expect(response.body.completion).toBeNull();
      expect(response.body.decisions).toContainEqual({
        approvalId: fabricatedId,
        actionDigest: null,
        attestationId: null,
        status: null,
        valid: false,
        invalidReason: 'attestation_not_found',
        eligibility: 'invalid',
        correctionStanding: null,
      });
      expect(response.body.decisions).toContainEqual(
        expect.objectContaining({
          approvalId: decided.recorded.approvalId,
          valid: true,
          eligibility: 'eligible',
        }),
      );
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
