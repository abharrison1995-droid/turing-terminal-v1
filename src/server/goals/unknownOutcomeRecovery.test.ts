import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, goalApp } from './apiKit.js';
import { getGoalApproval } from './approvals.js';
import {
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Unknown-outcome recovery over HTTP (D.4E). Each test models a write whose response the client never used: the write
 * committed (or did not), and the client recovers by a read or by replaying the same reviewed digest. Every assertion is
 * whole-state (every table and the repository) through `app.inject` on the production app, with real Git and real SQLite.
 * This file adds tests only. No production code is changed; the one stub is a one-shot read fault (D4E-S6) that is
 * restored by its own call, never left behind.
 */

// The post-commit read fault (D4E-S6) is a one-shot stub of the standing reader. Only the route's final read is affected,
// because the services do not read the standing themselves.
const injected = vi.hoisted(() => ({ failNextStandingRead: false }));
vi.mock('./completionStanding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./completionStanding.js')>();
  return {
    ...actual,
    readGoalCompletionStanding: (...args: Parameters<typeof actual.readGoalCompletionStanding>) => {
      if (injected.failNextStandingRead) {
        injected.failNextStandingRead = false;
        throw new Error('injected post-commit read fault');
      }
      return actual.readGoalCompletionStanding(...args);
    },
  };
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  injected.failNextStandingRead = false;
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

type AttestedFixture = Awaited<ReturnType<typeof v2RunningAttestedFixture>>;
type DecidedFixture = Awaited<ReturnType<typeof v2DecidedFixture>>;

const decisionUrl = (goalId: string) => `/api/goals/${goalId}/completion-decision`;
const completionUrl = (goalId: string) => `/api/goals/${goalId}/completion`;
const decideUrl = (goalId: string, approvalId: string) =>
  `/api/goals/${goalId}/attestation-corrections/${approvalId}/decision`;
const requestUrl = (goalId: string, handoffId: string, attestationId: string) =>
  `/api/goals/${goalId}/handoffs/${handoffId}/external-integration/attestations/${attestationId}/corrections`;
const quoted = (digest: string) => ({ 'if-match': `"${digest}"` });

const recordBody = (attestationId: string) => ({
  decision: 'record_completion_decision',
  attestationId,
  acknowledgeContentNotProven: true,
});
const completeBody = { decision: 'complete_goal', acknowledgeContentNotProven: true };
const explanation = 'Explained once; the same text must be sent again.';
const disputeRequest = {
  correctionKind: 'dispute',
  reasonCode: 'observation_error',
  explanation,
  replacementAttestationId: null,
} as const;
const disputeDecision = (attestationId: string) => ({
  decision: 'approved',
  attestationId,
  correctionKind: 'dispute',
  explanation,
});

/** Whole state: every table and the repository. A lost or replayed write must leave both as the first write left them. */
function wholeState(fx: GoalFixture) {
  return { db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) };
}

/** The chain position a GET reports for this attestation: the If-Match value a correction request must carry. */
async function chainPosition(application: FastifyInstance, attested: AttestedFixture): Promise<string> {
  const read = await call(
    application,
    'GET',
    requestUrl(attested.fx.goalId, attested.handoff.handoffId, attested.attestationId),
  );
  expect(read.status).toBe(200);
  return read.body.chainPosition as string;
}

/** Moves the destination to a new commit on its current tip, as the D.3F fixtures do. */
function advanceDestination(
  attested: { fx: GoalFixture; handoff: { target: { baseRef: string } } },
  label: string,
) {
  const { repo } = attested.fx;
  const baseRef = attested.handoff.target.baseRef;
  const current = git(repo, 'rev-parse', baseRef);
  const tree = git(repo, 'rev-parse', `${current}^{tree}`);
  git(repo, 'update-ref', baseRef, git(repo, 'commit-tree', tree, '-p', current, '-m', label));
}

describe('unknown outcome recovery: completion decision (lost response)', () => {
  it(
    'D4E-S1 decision: a lost response is recovered by replaying the same digest, with no extra approval, proof or event',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db);
      const digest = await reviewedDigest(attested);

      // The first POST commits. Its response is discarded, as if the connection dropped.
      const first = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        recordBody(attestationId),
        quoted(digest),
      );
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ status: 'approved', reused: false, preflightDigest: digest });
      const afterFirst = wholeState(fx);

      // Recovery reads the saved state first; it shows the decision for this attestation.
      const status = await call(app, 'GET', completionUrl(fx.goalId));
      expect(status.body).toMatchObject({
        state: 'decided',
        decisions: [{ valid: true, attestationId, actionDigest: first.body.actionDigest }],
      });

      // The replay of the same reviewed digest reuses the decision and writes nothing.
      const replay = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        recordBody(attestationId),
        quoted(digest),
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, reused: true });
      expect(wholeState(fx)).toEqual(afterFirst);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: complete goal (lost response)', () => {
  it(
    'D4E-S2 complete: a lost response is recovered by replaying the stored action digest, also after the destination moves',
    async () => {
      const decided: DecidedFixture = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const actionDigest = decided.recorded.actionDigest;
      app = goalApp(fx.db);

      // The first POST commits; its response is discarded.
      const first = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ reused: false, completion: { actionDigest } });
      const afterFirst = wholeState(fx);
      expect(afterFirst.db.counts.goal_external_completion_proofs).toBe(1);

      const replay = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(replay.status).toBe(200);
      expect(replay.body.reused).toBe(true);
      expect(replay.body.completion).toEqual(first.body.completion);
      expect(wholeState(fx)).toEqual(afterFirst);

      // A later move of the destination does not change the completed Goal: the replay still names the same completion.
      advanceDestination(decided, 'destination moved after completion');
      const later = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(later.status).toBe(200);
      expect(later.body).toMatchObject({ reused: true, completion: first.body.completion });
      expect(databaseSnapshot(fx.db)).toEqual(afterFirst.db);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: correction request and decision (lost response)', () => {
  it(
    'D4E-S3 correction: a lost request and a lost decision are each recovered by replaying the same body, with no extra approval, correction or event',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await chainPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);

      // The request commits; its response is lost.
      const requested = await call(app, 'POST', url, disputeRequest, quoted(position));
      expect(requested.status).toBe(201);
      const approvalId = requested.body.approvalId as string;
      const actionDigest = requested.body.actionDigest as string;
      const afterRequest = wholeState(fx);

      // Recovery reads the history: the pending row is the request that was sent.
      const history = await call(app, 'GET', url);
      expect(history.body.pending).toEqual([
        expect.objectContaining({
          approvalId,
          actionDigest,
          correctionKind: 'dispute',
          reasonCode: 'observation_error',
        }),
      ]);
      expect(history.body.pendingUnreadableCount).toBe(0);

      // Replaying the same position and body is reused, not a second gate.
      const requestReplay = await call(app, 'POST', url, disputeRequest, quoted(position));
      expect(requestReplay.status).toBe(200);
      expect(requestReplay.body).toMatchObject({ approvalId, actionDigest, status: 'pending', reused: true });
      expect(wholeState(fx)).toEqual(afterRequest);

      // The decision commits; its response is lost.
      const decisionPath = decideUrl(fx.goalId, approvalId);
      const decided = await call(
        app,
        'POST',
        decisionPath,
        disputeDecision(attested.attestationId),
        quoted(actionDigest),
      );
      expect(decided.status).toBe(201);
      expect(decided.body).toMatchObject({
        approvalId,
        status: 'approved',
        actionDigest,
        sequence: 1,
        reused: false,
      });
      const afterDecision = wholeState(fx);

      // Recovery reads the history: the correction is recorded and no request is pending.
      const recovered = await call(app, 'GET', url);
      expect(recovered.body.corrections).toEqual([expect.objectContaining({ approvalId })]);
      expect(recovered.body.pending).toEqual([]);

      // Replaying the same digest and explanation is reused, with the same correction.
      const decisionReplay = await call(
        app,
        'POST',
        decisionPath,
        disputeDecision(attested.attestationId),
        quoted(actionDigest),
      );
      expect(decisionReplay.status).toBe(200);
      expect(decisionReplay.body).toMatchObject({
        approvalId,
        status: 'approved',
        actionDigest,
        correctionId: decided.body.correctionId,
        sequence: 1,
        reused: true,
      });
      expect(wholeState(fx)).toEqual(afterDecision);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: truncated history', () => {
  it(
    'D4E-S4 with 21 other attestations, the status lists 20 and is marked truncated, and it is stable across a replayed completion',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      const proofTip = git(fx.repo, 'rev-parse', attested.handoff.target.baseRef);
      const others: string[] = [];
      for (let index = 1; index <= 21; index += 1) {
        advanceDestination(attested, `destination moved for independent attestation ${index}`);
        others.push((await reattestAtCurrentTip(attested)).attestationId);
      }
      git(fx.repo, 'update-ref', attested.handoff.target.baseRef, proofTip);
      app = goalApp(fx.db);
      const digest = await reviewedDigest(attested);
      const recorded = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        recordBody(attestationId),
        quoted(digest),
      );
      expect(recorded.status).toBe(201);
      const actionDigest = recorded.body.actionDigest as string;
      const completed = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(completed.status).toBe(201);
      const afterFirst = wholeState(fx);

      const before = await call(app, 'GET', completionUrl(fx.goalId));
      expect(before.body.completionStanding).toMatchObject({
        standing: 'uncontested',
        otherAttestationsTruncated: true,
      });
      expect(
        before.body.completionStanding.otherAttestations.map(
          (other: { attestationId: string }) => other.attestationId,
        ),
      ).toEqual(others.slice(0, 20));

      const replay = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(replay.status).toBe(200);
      expect(replay.body.reused).toBe(true);

      const after = await call(app, 'GET', completionUrl(fx.goalId));
      expect(after.body).toEqual(before.body);
      expect(wholeState(fx)).toEqual(afterFirst);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: a real write fault is not written', () => {
  it(
    'D4E-S5 decision: a fault on the decision event is 503 decision_persistence_failed, writes nothing, and the same digest succeeds once the fault is gone',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx, attestationId } = attested;
      app = goalApp(fx.db);
      const digest = await reviewedDigest(attested);
      fx.db.exec(
        "CREATE TRIGGER fault_decision_event BEFORE INSERT ON goal_events WHEN NEW.type = 'approval_decided' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      );
      const before = wholeState(fx);

      const failed = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        recordBody(attestationId),
        quoted(digest),
      );
      expect(failed).toMatchObject({ status: 503, body: { code: 'decision_persistence_failed' } });
      expect(wholeState(fx)).toEqual(before);
      expect(fx.db.inTransaction).toBe(false);

      // Confirmed absence: the saved state shows no decision.
      const status = await call(app, 'GET', completionUrl(fx.goalId));
      expect(status.body).toMatchObject({ state: 'not_completed', decisions: [] });

      fx.db.exec('DROP TRIGGER fault_decision_event;');
      const recovered = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        recordBody(attestationId),
        quoted(digest),
      );
      expect(recovered.status).toBe(201);
      expect(recovered.body.reused).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4E-S5 complete: a fault on the proof insert is 503 completion_persistence_failed with the step as detail, writes nothing, and the same digest succeeds once the fault is gone',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const actionDigest = decided.recorded.actionDigest;
      app = goalApp(fx.db);
      fx.db.exec(
        "CREATE TRIGGER fault_proof_insert BEFORE INSERT ON goal_external_completion_proofs BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      );
      const before = wholeState(fx);

      const failed = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(failed).toMatchObject({
        status: 503,
        body: { code: 'completion_persistence_failed', detail: 'proof_insert' },
      });
      expect(wholeState(fx)).toEqual(before);
      const status = await call(app, 'GET', completionUrl(fx.goalId));
      expect(status.body.state).toBe('decided');

      fx.db.exec('DROP TRIGGER fault_proof_insert;');
      const recovered = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(recovered.status).toBe(201);
      expect(recovered.body.reused).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4E-S5 correction request: a fault on the pending approval is 503 persistence_failed, writes nothing, and the same request succeeds once the fault is gone',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await chainPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      fx.db.exec(
        "CREATE TRIGGER fault_correction_request BEFORE INSERT ON goal_approvals WHEN NEW.attestation_correction_action_digest IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      );
      const before = wholeState(fx);

      const failed = await call(app, 'POST', url, disputeRequest, quoted(position));
      expect(failed).toMatchObject({ status: 503, body: { code: 'persistence_failed' } });
      expect(wholeState(fx)).toEqual(before);
      const history = await call(app, 'GET', url);
      expect(history.body.pending).toEqual([]);

      fx.db.exec('DROP TRIGGER fault_correction_request;');
      const recovered = await call(app, 'POST', url, disputeRequest, quoted(position));
      expect(recovered.status).toBe(201);
      expect(recovered.body.reused).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4E-S5 correction decision: a fault on the decision event is 503 persistence_failed, leaves the request pending, and the same decision succeeds once the fault is gone',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await chainPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const requested = await call(app, 'POST', url, disputeRequest, quoted(position));
      expect(requested.status).toBe(201);
      const approvalId = requested.body.approvalId as string;
      const actionDigest = requested.body.actionDigest as string;
      fx.db.exec(
        "CREATE TRIGGER fault_correction_decision BEFORE INSERT ON goal_events WHEN NEW.type = 'approval_decided' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      );
      const before = wholeState(fx);
      const decisionPath = decideUrl(fx.goalId, approvalId);

      const failed = await call(
        app,
        'POST',
        decisionPath,
        disputeDecision(attested.attestationId),
        quoted(actionDigest),
      );
      expect(failed).toMatchObject({ status: 503, body: { code: 'persistence_failed' } });
      expect(wholeState(fx)).toEqual(before);
      expect(getGoalApproval(fx.db, approvalId)).toMatchObject({ status: 'pending' });

      fx.db.exec('DROP TRIGGER fault_correction_decision;');
      const recovered = await call(
        app,
        'POST',
        decisionPath,
        disputeDecision(attested.attestationId),
        quoted(actionDigest),
      );
      expect(recovered.status).toBe(201);
      expect(recovered.body).toMatchObject({ status: 'approved', reused: false, sequence: 1 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: a post-commit read fault', () => {
  it(
    'D4E-S6 correction decision: a read fault after the commit is 503 with the decision committed, and the replay is reused',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await chainPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const requested = await call(app, 'POST', url, disputeRequest, quoted(position));
      expect(requested.status).toBe(201);
      const approvalId = requested.body.approvalId as string;
      const actionDigest = requested.body.actionDigest as string;
      const decisionPath = decideUrl(fx.goalId, approvalId);

      injected.failNextStandingRead = true;
      const failed = await call(
        app,
        'POST',
        decisionPath,
        disputeDecision(attested.attestationId),
        quoted(actionDigest),
      );
      expect(failed).toMatchObject({ status: 503, body: { code: 'attestation_correction_unavailable' } });
      expect(injected.failNextStandingRead).toBe(false);
      expect(getGoalApproval(fx.db, approvalId)).toMatchObject({ status: 'approved' });
      const committed = wholeState(fx);
      const recovered = await call(app, 'GET', url);
      expect(recovered.body.corrections).toEqual([expect.objectContaining({ approvalId })]);

      const replay = await call(
        app,
        'POST',
        decisionPath,
        disputeDecision(attested.attestationId),
        quoted(actionDigest),
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ approvalId, status: 'approved', reused: true, sequence: 1 });
      expect(wholeState(fx)).toEqual(committed);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4E-S6 complete: a read fault after the commit is 503 with the Goal completed, and the replay is reused',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const actionDigest = decided.recorded.actionDigest;
      app = goalApp(fx.db);

      injected.failNextStandingRead = true;
      const failed = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(failed).toMatchObject({ status: 503, body: { code: 'external_completion_unavailable' } });
      expect(injected.failNextStandingRead).toBe(false);
      const committed = wholeState(fx);
      const status = await call(app, 'GET', completionUrl(fx.goalId));
      expect(status.body.state).toBe('completed');

      const replay = await call(app, 'POST', completionUrl(fx.goalId), completeBody, quoted(actionDigest));
      expect(replay.status).toBe(200);
      expect(replay.body.reused).toBe(true);
      expect(wholeState(fx)).toEqual(committed);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: an invalid stored row', () => {
  it(
    'D4E-S7 a tampered decision reads as invalid, and both the replayed decision and the completion are decision_corrupt with nothing written',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx, attestationId, recorded } = decided;
      app = goalApp(fx.db);
      // Tamper with the stored decision through raw SQL, as the existing invalid-row test does.
      const detail = fx.db
        .prepare('SELECT detail_json FROM goal_approvals WHERE id = ?')
        .get(recorded.approvalId) as { detail_json: string };
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity;');
      fx.db.exec('DROP TRIGGER trg_goal_approval_terminal;');
      fx.db
        .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
        .run(detail.detail_json.replace(decided.digest, 'e'.repeat(64)), recorded.approvalId);
      const before = wholeState(fx);

      const status = await call(app, 'GET', completionUrl(fx.goalId));
      expect(status.body).toMatchObject({
        state: 'invalid',
        completion: null,
        decisions: [{ approvalId: recorded.approvalId, valid: false, invalidReason: 'digest_mismatch' }],
      });
      expect(wholeState(fx)).toEqual(before);

      const replayed = await call(
        app,
        'POST',
        decisionUrl(fx.goalId),
        recordBody(attestationId),
        quoted(decided.digest),
      );
      expect(replayed).toMatchObject({ status: 422, body: { code: 'decision_corrupt' } });
      expect(wholeState(fx)).toEqual(before);

      const completed = await call(
        app,
        'POST',
        completionUrl(fx.goalId),
        completeBody,
        quoted(recorded.actionDigest),
      );
      expect(completed).toMatchObject({ status: 422, body: { code: 'decision_corrupt' } });
      expect(wholeState(fx)).toEqual(before);
      expect(fx.db.inTransaction).toBe(false);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unknown outcome recovery: pending requests on A and B (existing behaviour, named)', () => {
  it(
    'D4E-S8 completion: a decision recorded for A is what the status shows, and B is refused as already recorded (T11, unchanged)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      app = goalApp(fx.db);
      advanceDestination(decided, 'second tip for attestation B');
      const attestationB = await reattestAtCurrentTip(decided);

      const preflightB = await call(
        app,
        'GET',
        `/api/goals/${fx.goalId}/completion-preflight?attestationId=${attestationB.attestationId}`,
      );
      expect(preflightB.body.preflight).toMatchObject({
        outcome: 'refused',
        reasons: [{ code: 'completion_already_recorded' }],
      });
      const status = await call(app, 'GET', completionUrl(fx.goalId));
      expect(status.body.state).toBe('decided');
      expect(status.body.decisions).toEqual([
        expect.objectContaining({ attestationId: decided.attestationId, valid: true }),
      ]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4E-S8 correction: a second, different request on A is correction_request_pending (D4D-8), while B is not blocked (D4D-9)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await chainPosition(app, attested);
      const urlA = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const pendingA = await call(app, 'POST', urlA, disputeRequest, quoted(position));
      expect(pendingA.status).toBe(201);

      const different = { ...disputeRequest, reasonCode: 'wrong_source' as const, explanation: null };
      const refused = await call(app, 'POST', urlA, different, quoted(position));
      expect(refused).toMatchObject({ status: 409, body: { code: 'correction_request_pending' } });

      const identical = await call(app, 'POST', urlA, disputeRequest, quoted(position));
      expect(identical).toMatchObject({
        status: 200,
        body: { approvalId: pendingA.body.approvalId, reused: true },
      });

      advanceDestination(attested, 'destination moved for attestation B');
      const attestationB = await reattestAtCurrentTip(attested);
      const urlB = requestUrl(fx.goalId, attested.handoff.handoffId, attestationB.attestationId);
      const positionB = await chainPosition(app, { ...attested, attestationId: attestationB.attestationId });
      const pendingB = await call(app, 'POST', urlB, disputeRequest, quoted(positionB));
      expect(pendingB.status).toBe(201);
      expect(pendingB.body.approvalId).not.toBe(pendingA.body.approvalId);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
