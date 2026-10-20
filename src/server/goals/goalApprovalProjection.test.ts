import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { call, goalApp } from './apiKit.js';
import { getGoalApproval, requestGoalApproval } from './approvals.js';
import { requestAttestationCorrectionApproval } from './attestationCorrection.js';
import { observeReviewedPreflight, recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import { databaseSnapshot, reviewedDigest, v2RunningAttestedFixture } from './goalV2TestKit.js';
import { unifiedApprovals } from './readModel.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { transitionGoal } from './stateMachine.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

/**
 * Projection of dedicated-service approvals in the unified inbox. A pending correction approval, and a pending
 * completion approval, are decided only by their dedicated services. The inbox must therefore never offer a generic
 * decision for them (`decidable: false`), must say where the decision is made (`dedicatedDecision`), and must keep them
 * in every history. The generic decision route keeps refusing them with the same codes, whatever the client shows.
 */

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

/** A pending dispute of one attestation, requested through the existing correction request service. */
function requestDispute(
  db: Parameters<typeof requestAttestationCorrectionApproval>[0],
  goalId: string,
  attestationId: string,
) {
  return requestAttestationCorrectionApproval(db, {
    goalId,
    attestationId,
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    explanation: null,
    replacementAttestationId: null,
  });
}

/**
 * A pending completion approval, built as the decision service would build it (the production action builder and the
 * request service) but NOT decided. The decision service approves in the same step, so it cannot yield a pending row.
 */
async function requestPendingCompletion(
  fx: Awaited<ReturnType<typeof v2RunningAttestedFixture>>['fx'],
  attestationId: string,
) {
  const observed = await observeReviewedPreflight(fx.db, fx.goalId, attestationId);
  if (observed.report.outcome !== 'ready' || observed.identity === null)
    throw new Error('requestPendingCompletion: the preflight is not ready');
  const action = buildExternalCompletionAction({
    ...observed.report.actionFields,
    userReviewedPreflightDigest: observed.report.digest,
  });
  if (action === null) throw new Error('requestPendingCompletion: the action did not build');
  return requestGoalApproval(fx.db, {
    goalId: fx.goalId,
    gate: 'user_confirmation',
    risk: 'high',
    reason: 'Completion decision awaiting the user.',
    requestedBy: 'user',
    detail: { ...action },
    externalCompletionActionDigest: action.actionDigest,
  });
}

function pendingRow(approvals: Array<{ id: string }>, id: string) {
  return approvals.find((row) => row.id === id);
}

/**
 * Simulates out-of-band corruption of one stored approval detail: a direct UPDATE on this test database. The schema's
 * json_valid CHECK, the approval identity trigger and the JSON-reading triggers would refuse a malformed detail through
 * normal writes, so they are suspended for this one statement and restored in `finally`, exactly as they were.
 */
function corruptStoredDetail(db: Db, approvalId: string, detailJson: string): void {
  const guards = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'goal_approvals'")
    .all() as Array<{ name: string; sql: string }>;
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  db.pragma('ignore_check_constraints = ON');
  try {
    db.prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?').run(detailJson, approvalId);
  } finally {
    db.pragma('ignore_check_constraints = OFF');
    for (const guard of guards) db.exec(guard.sql);
  }
}

/** A run approval on the Goal's real child run, inserted as goalApiReads.test.ts does. */
function runApproval(h: Harness, runId: string, id: string) {
  const db = h.fx.db;
  db.prepare(
    `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, started_at, logs)
     VALUES (?, ?, 'approval', 'humanApproval', 'Approval', 99, 'waiting_for_approval', ?, '')`,
  ).run(`stage-${id}`, runId, new Date().toISOString());
  db.prepare(
    `INSERT INTO approvals (id, run_id, stage_id, operation, reason, risk, status, created_at)
     VALUES (?, ?, ?, 'Write files', 'Needs a write', 'high', 'pending', ?)`,
  ).run(id, runId, `stage-${id}`, new Date().toISOString());
  return id;
}

describe('unified inbox projection of dedicated-service approvals', () => {
  it(
    'a pending correction approval is not decidable in the inbox, names its dedicated decision, and stays in history',
    async () => {
      // Fixture: v2RunningAttestedFixture (running Goal, real Git). The correction is requested through the request service.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const { approval } = requestDispute(db, goalId, attested.attestationId);

      const pending = unifiedApprovals(db, { status: 'pending' }).approvals;
      expect(pendingRow(pending, approval.id)).toMatchObject({
        source: 'goal',
        status: 'pending',
        decidable: false,
        dedicatedDecision: 'correction',
      });

      const all = unifiedApprovals(db, { status: 'all' }).approvals;
      expect(pendingRow(all, approval.id)).toMatchObject({
        decidable: false,
        dedicatedDecision: 'correction',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an ordinary Goal approval in the same Goal stays decidable and carries no dedicated decision',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const { approval: correction } = requestDispute(db, goalId, attested.attestationId);
      const ordinary = requestGoalApproval(db, {
        goalId,
        gate: 'final_acceptance',
        risk: 'medium',
        reason: 'An ordinary decision in the same Goal.',
        requestedBy: 'system',
      });

      const pending = unifiedApprovals(db, { status: 'pending' }).approvals;
      expect(pendingRow(pending, ordinary.id)).toMatchObject({ decidable: true });
      expect(pendingRow(pending, ordinary.id)).not.toHaveProperty('dedicatedDecision');
      expect(pendingRow(pending, correction.id)).toMatchObject({
        decidable: false,
        dedicatedDecision: 'correction',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a pending completion approval is not decidable in the inbox and names the completion decision',
    async () => {
      // Fixture: v2RunningAttestedFixture (real Git). The completion approval is requested, not decided.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const completion = await requestPendingCompletion(fx, attested.attestationId);

      const pending = unifiedApprovals(fx.db, { status: 'pending' }).approvals;
      expect(pendingRow(pending, completion.id)).toMatchObject({
        status: 'pending',
        decidable: false,
        dedicatedDecision: 'completion',
      });
      const all = unifiedApprovals(fx.db, { status: 'all' }).approvals;
      expect(pendingRow(all, completion.id)).toMatchObject({
        decidable: false,
        dedicatedDecision: 'completion',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the generic decision route still refuses the pending correction approval with its dedicated code, and writes nothing',
    async () => {
      // Authority is unchanged by the projection: a client that ignores the flag is still refused (D.4C-8 pattern).
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const { approval } = requestDispute(db, goalId, attested.attestationId);
      app = goalApp(db);
      const before = databaseSnapshot(db);

      for (const decision of ['approved', 'denied']) {
        expect(
          await call(app, 'POST', `/api/goal-approvals/${approval.id}/decision`, { decision }),
        ).toMatchObject({ status: 409, body: { code: 'correction_decision_requires_dedicated_service' } });
      }
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the generic decision route still refuses the pending completion approval with its dedicated code, and writes nothing',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const completion = await requestPendingCompletion(fx, attested.attestationId);
      app = goalApp(fx.db);
      const before = databaseSnapshot(fx.db);

      expect(
        await call(app, 'POST', `/api/goal-approvals/${completion.id}/decision`, { decision: 'approved' }),
      ).toMatchObject({ status: 409, body: { code: 'completion_decision_requires_dedicated_service' } });
      expect(getGoalApproval(fx.db, completion.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a malformed stored approval detail does not fail the inbox: its row stays listed, read-only, and the other rows still project',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const ordinary = requestGoalApproval(db, {
        goalId,
        gate: 'final_acceptance',
        risk: 'medium',
        reason: 'An ordinary decision in the same Goal.',
        requestedBy: 'system',
      });
      const corrupt = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'medium',
        reason: 'A row whose stored detail is corrupt.',
        requestedBy: 'system',
      });
      corruptStoredDetail(db, corrupt.id, '{not json');

      const all = unifiedApprovals(db, { status: 'all' }).approvals;
      expect(pendingRow(all, corrupt.id)).toMatchObject({
        status: 'pending',
        decidable: false,
        gate: 'user_confirmation',
      });
      expect(pendingRow(all, corrupt.id)).not.toHaveProperty('dedicatedDecision');
      expect(pendingRow(all, ordinary.id)).toMatchObject({ status: 'pending', decidable: true });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a malformed gate approval named by a needs_user(gate_pending) Goal does not fail the inbox: sibling rows stay listed, read-only',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const sibling = requestGoalApproval(db, {
        goalId,
        gate: 'final_acceptance',
        risk: 'medium',
        reason: 'An ordinary pending decision in the same Goal.',
        requestedBy: 'system',
      });
      const gate = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'medium',
        reason: 'The gate this Goal waits on, whose stored detail is corrupt.',
        requestedBy: 'system',
      });
      transitionGoal(db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'gate_pending',
        actor: 'supervisor',
        detail: { approvalId: gate.id, gate: 'user_confirmation' },
      });
      corruptStoredDetail(db, gate.id, '{not json');

      const all = unifiedApprovals(db, { status: 'all' }).approvals;
      expect(pendingRow(all, gate.id)).toMatchObject({
        status: 'pending',
        decidable: false,
        gate: 'user_confirmation',
      });
      expect(pendingRow(all, gate.id)).not.toHaveProperty('dedicatedDecision');
      expect(pendingRow(all, sibling.id)).toMatchObject({ status: 'pending', decidable: false });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an approved completion approval is history: it is not decidable and carries no dedicated decision',
    async () => {
      // The dedicated completion service records the approved row itself (the route checks pending rows only).
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const digest = await reviewedDigest(attested);
      const recorded = await recordExternalCompletionDecision(fx.db, {
        goalId: fx.goalId,
        attestationId: attested.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });

      const all = unifiedApprovals(fx.db, { status: 'all' }).approvals;
      expect(pendingRow(all, recorded.approvalId)).toMatchObject({ status: 'approved', decidable: false });
      expect(pendingRow(all, recorded.approvalId)).not.toHaveProperty('dedicatedDecision');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a run approval is projected unchanged: no decidable flag and no dedicated decision',
    async () => {
      const h = harness();
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await h.start();
      await h.until('waiting_for_run');
      const runId = h.runs().at(-1)!.id;
      const runRow = runApproval(h, runId, 'run-approval-projection');

      const pending = unifiedApprovals(h.fx.db, { status: 'pending' }).approvals;
      const run = pendingRow(pending, runRow);
      expect(run).toMatchObject({ source: 'run', runId, status: 'pending' });
      expect(run).not.toHaveProperty('decidable');
      expect(run).not.toHaveProperty('dedicatedDecision');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
