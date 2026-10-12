import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GoalExternalCompletionDecisionRecorded,
  GoalExternalCompletionPreflightResponse,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi.js';
import { call, disabledSupervisor, goalApp } from './apiKit.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
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
  repositoryState,
  reviewedDigest,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
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
