import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import {
  getAttestationCorrectionStanding,
  requestAttestationCorrectionApproval,
} from './attestationCorrection.js';
import { call, goalApp } from './apiKit.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { recordExternalCompletionDecision } from './externalCompletionDecision.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
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
 * HTTP tests for the correction decision route (D.4C), through `app.inject` on the production Fastify app. Each test uses
 * the real correction, approval, Git and completion services on real Git and real SQLite. Fixtures are the D.3F seeding
 * path: review and acceptance are seeded through `v2RunningAttestedFixture` and `v2DecidedFixture`, not real execution.
 * The correction is requested through the existing request service, since no request route exists until D.4D.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

const decisionUrl = (goalId: string, approvalId: string) =>
  `/api/goals/${goalId}/attestation-corrections/${approvalId}/decision`;

const ifMatch = (digest: string) => ({ 'if-match': `"${digest}"` });

/** Whole-state equality: every table and the repository. A refused or replayed decision must leave both unchanged. */
function wholeState(fx: GoalFixture) {
  return { db: databaseSnapshot(fx.db), repo: repositoryState(fx.repo) };
}

/** A pending dispute request through the existing request service (D.3F fixture path). */
function requestDispute(db: Db, goalId: string, attestationId: string, explanation: string | null = null) {
  return requestAttestationCorrectionApproval(db, {
    goalId,
    attestationId,
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    explanation,
    replacementAttestationId: null,
  });
}

const approvedBody = (attestationId: string, explanation: string | null = null) => ({
  decision: 'approved',
  attestationId,
  correctionKind: 'dispute',
  explanation,
});

/** Moves the destination to a new commit on top of its current tip, as the D.3F completion fixture does. */
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

/**
 * Attestation A completed on its decision, with `others` independent attestations (B) made before completion, as the
 * D.3F B-tests build them. Each independent attestation is observed at a moved destination tip, then the tip is reset.
 */
async function completedWithIndependent(others: number) {
  const attested = await v2RunningAttestedFixture('sha1');
  const { fx } = attested;
  const proofTip = git(fx.repo, 'rev-parse', attested.handoff.target.baseRef);
  const independent: Awaited<ReturnType<typeof reattestAtCurrentTip>>[] = [];
  for (let index = 1; index <= others; index += 1) {
    advanceDestination(attested, `destination moved for independent attestation ${index}`);
    independent.push(await reattestAtCurrentTip(attested));
  }
  git(fx.repo, 'update-ref', attested.handoff.target.baseRef, proofTip);
  const digest = await reviewedDigest(attested);
  const input = {
    goalId: fx.goalId,
    attestationId: attested.attestationId,
    reviewedPreflightDigest: digest,
    acknowledgeContentNotProven: true,
  };
  await recordExternalCompletionDecision(fx.db, input);
  await completeGoalFromExternalDecision(fx.db, input);
  return { attested, independent, fx };
}

describe('correction decision route: request shape and authority', () => {
  it(
    'D4C-8 (sha1, running Goal): a correct decision is 201, a repeat is 200 reused, and the body carries no actor or status',
    async () => {
      // Fixture: v2RunningAttestedFixture (before completion). Real Git. The dispute is requested through the request service.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);
      const url = decisionUrl(fx.goalId, approval.id);

      const created = await call(
        app,
        'POST',
        url,
        approvedBody(attested.attestationId),
        ifMatch(actionDigest),
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        approvalId: approval.id,
        status: 'approved',
        actionDigest,
        sequence: 1,
        reused: false,
      });
      expect(created.body.correctionId).toEqual(expect.any(String));
      expect(created.body.completionStanding).toMatchObject({ goalId: fx.goalId, kind: 'not_completed' });
      expect(getGoalApproval(fx.db, approval.id)).toMatchObject({ status: 'approved', decidedBy: 'user' });
      const afterFirst = wholeState(fx);

      const repeat = await call(
        app,
        'POST',
        url,
        approvedBody(attested.attestationId),
        ifMatch(actionDigest),
      );
      expect(repeat.status).toBe(200);
      expect(repeat.body).toMatchObject({
        approvalId: approval.id,
        reused: true,
        correctionId: created.body.correctionId,
      });
      expect(wholeState(fx)).toEqual(afterFirst);

      // The client cannot name an actor or a status in the body.
      const withActor = await call(
        app,
        'POST',
        url,
        { ...approvedBody(attested.attestationId), actor: 'user' },
        ifMatch(actionDigest),
      );
      expect(withActor).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      const withStatus = await call(
        app,
        'POST',
        url,
        { decision: 'denied', status: 'approved' },
        ifMatch(actionDigest),
      );
      expect(withStatus).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      expect(wholeState(fx)).toEqual(afterFirst);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 precondition (sha1): a missing If-Match is 428, a malformed one is 400, and nothing is written',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);
      const url = decisionUrl(fx.goalId, approval.id);
      const before = wholeState(fx);

      expect(await call(app, 'POST', url, approvedBody(attested.attestationId), {})).toMatchObject({
        status: 428,
        body: { code: 'reviewed_action_precondition_required' },
      });
      const malformed = [
        actionDigest,
        `W/"${actionDigest}"`,
        `"${actionDigest.toUpperCase()}"`,
        `"${actionDigest.slice(0, 40)}"`,
      ];
      for (const value of malformed) {
        expect(
          await call(app, 'POST', url, approvedBody(attested.attestationId), { 'if-match': value }),
        ).toMatchObject({ status: 400, body: { code: 'reviewed_action_precondition_invalid' } });
      }
      expect(getGoalApproval(fx.db, approval.id)).toMatchObject({ status: 'pending' });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 malformed bodies and identities (sha1): each is refused with its status and no write',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);
      const before = wholeState(fx);
      const headers = ifMatch(actionDigest);
      const url = decisionUrl(fx.goalId, approval.id);

      expect(await call(app, 'POST', url, { decision: 'maybe' }, headers)).toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
      expect(await call(app, 'POST', url, approvedBody('not-a-uuid'), headers)).toMatchObject({
        status: 400,
        body: { code: 'invalid_request' },
      });
      expect(
        await call(
          app,
          'POST',
          url,
          { ...approvedBody(attested.attestationId), correctionKind: 'replace' },
          headers,
        ),
      ).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      expect(
        await call(
          app,
          'POST',
          decisionUrl('not-a-uuid', approval.id),
          approvedBody(attested.attestationId),
          headers,
        ),
      ).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 unknown identities (sha1): an unknown Goal is 404 goal_not_found, an unknown approval is 404 approval_not_found',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);
      const before = wholeState(fx);
      const body = approvedBody(attested.attestationId);

      expect(
        await call(app, 'POST', decisionUrl(randomUUID(), approval.id), body, ifMatch(actionDigest)),
      ).toMatchObject({ status: 404, body: { code: 'goal_not_found' } });
      expect(
        await call(app, 'POST', decisionUrl(fx.goalId, randomUUID()), body, ifMatch(actionDigest)),
      ).toMatchObject({ status: 404, body: { code: 'approval_not_found' } });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 stale or mismatched decisions (sha1): each refusal has its code and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. A dispute and a withdrawal are requested from the same empty tip.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const dispute = requestDispute(fx.db, fx.goalId, attested.attestationId, 'Recorded by a route test.');
      const withdraw = requestAttestationCorrectionApproval(fx.db, {
        goalId: fx.goalId,
        attestationId: attested.attestationId,
        correctionKind: 'withdraw',
        reasonCode: 'integration_not_performed',
        explanation: null,
        replacementAttestationId: null,
      });
      app = goalApp(fx.db);
      const disputeUrl = decisionUrl(fx.goalId, dispute.approval.id);
      const withExplanation = (attestationId: string) =>
        approvedBody(attestationId, 'Recorded by a route test.');
      const before = wholeState(fx);

      // An If-Match for another action, a wrong attestation, a wrong kind and a wrong explanation are refused, unwritten.
      expect(
        await call(app, 'POST', disputeUrl, withExplanation(attested.attestationId), ifMatch('f'.repeat(64))),
      ).toMatchObject({ status: 409, body: { code: 'correction_action_mismatch' } });
      expect(
        await call(app, 'POST', disputeUrl, withExplanation(randomUUID()), ifMatch(dispute.actionDigest)),
      ).toMatchObject({ status: 409, body: { code: 'correction_action_mismatch' } });
      expect(
        await call(
          app,
          'POST',
          disputeUrl,
          { ...withExplanation(attested.attestationId), correctionKind: 'withdraw' },
          ifMatch(dispute.actionDigest),
        ),
      ).toMatchObject({ status: 409, body: { code: 'correction_action_mismatch' } });
      expect(
        await call(
          app,
          'POST',
          disputeUrl,
          approvedBody(attested.attestationId, 'Other text.'),
          ifMatch(dispute.actionDigest),
        ),
      ).toMatchObject({ status: 400, body: { code: 'explanation_invalid' } });
      expect(getGoalApproval(fx.db, dispute.approval.id)).toMatchObject({ status: 'pending' });
      expect(wholeState(fx)).toEqual(before);

      // A stale review: the withdrawal decision moves the tip first, so the dispute's sequence and previous digest are
      // stale. The append checks the chain position before the transition, so the code is correction_chain_changed.
      expect(
        await call(
          app,
          'POST',
          decisionUrl(fx.goalId, withdraw.approval.id),
          { ...approvedBody(attested.attestationId), correctionKind: 'withdraw' },
          ifMatch(withdraw.actionDigest),
        ),
      ).toMatchObject({ status: 201, body: { sequence: 1 } });
      const beforeStale = wholeState(fx);
      expect(
        await call(
          app,
          'POST',
          disputeUrl,
          withExplanation(attested.attestationId),
          ifMatch(dispute.actionDigest),
        ),
      ).toMatchObject({ status: 409, body: { code: 'correction_chain_changed' } });
      expect(getGoalApproval(fx.db, dispute.approval.id)).toMatchObject({ status: 'pending' });
      expect(wholeState(fx)).toEqual(beforeStale);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 denied then approved (sha1): a denial is 201, a repeated denial is 200, and a later approval is 409 already_decided',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);
      const url = decisionUrl(fx.goalId, approval.id);

      expect(await call(app, 'POST', url, { decision: 'denied' }, ifMatch(actionDigest))).toMatchObject({
        status: 201,
        body: { status: 'denied', correctionId: null, reused: false },
      });
      const afterDenial = wholeState(fx);
      expect(await call(app, 'POST', url, { decision: 'denied' }, ifMatch(actionDigest))).toMatchObject({
        status: 200,
        body: { status: 'denied', reused: true },
      });
      expect(
        await call(app, 'POST', url, approvedBody(attested.attestationId), ifMatch(actionDigest)),
      ).toMatchObject({
        status: 409,
        body: { code: 'already_decided' },
      });
      expect(getGoalApproval(fx.db, approval.id)).toMatchObject({ status: 'denied', decidedBy: 'user' });
      expect(wholeState(fx)).toEqual(afterDenial);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 generic route (sha1): the generic approval route refuses the same correction with its dedicated code and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. Mirrors the D.4A generic-route refusal (externalCompletionApi.test.ts).
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);
      const before = wholeState(fx);

      expect(
        await call(app, 'POST', `/api/goal-approvals/${approval.id}/decision`, { decision: 'approved' }),
      ).toMatchObject({ status: 409, body: { code: 'correction_decision_requires_dedicated_service' } });
      expect(getGoalApproval(fx.db, approval.id)).toMatchObject({ status: 'pending' });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction decision route: completion and independence', () => {
  it(
    'D4C-8 completion (sha1): a route correction after completion leaves the completion, its proof and the events untouched',
    async () => {
      // Fixture: v2DecidedFixture, then the real completion service (D.3F fixture path). Real Git. The correction is
      // decided through the route.
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      await completeGoalFromExternalDecision(fx.db, {
        goalId: fx.goalId,
        attestationId: decided.attestationId,
        reviewedPreflightDigest: decided.digest,
        acknowledgeContentNotProven: true,
      });
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, decided.attestationId);
      app = goalApp(fx.db);
      const snapshotBefore = databaseSnapshot(fx.db);
      const repoBefore = repositoryState(fx.repo);
      const goalBefore = fx.db.prepare('SELECT * FROM goals WHERE id = ?').get(fx.goalId);
      const proofsBefore = fx.db
        .prepare('SELECT * FROM goal_external_completion_proofs ORDER BY rowid')
        .all();
      const eventsBefore = fx.db.prepare('SELECT * FROM goal_events ORDER BY rowid').all();
      const storedBefore = readStoredCompletion(fx.db, fx.goalId);

      const response = await call(
        app,
        'POST',
        decisionUrl(fx.goalId, approval.id),
        approvedBody(decided.attestationId),
        ifMatch(actionDigest),
      );
      expect(response).toMatchObject({
        status: 201,
        body: { status: 'approved', sequence: 1, completionStanding: { standing: 'disputed', kind: 'v2' } },
      });

      const snapshotAfter = databaseSnapshot(fx.db);
      const changed = Object.keys(snapshotAfter.digests)
        .filter(
          (table) =>
            snapshotAfter.digests[table] !== snapshotBefore.digests[table] ||
            snapshotAfter.counts[table] !== snapshotBefore.counts[table],
        )
        .sort();
      expect(changed).toEqual(['goal_approvals', 'goal_attestation_corrections', 'goal_events']);
      expect(fx.db.prepare('SELECT * FROM goals WHERE id = ?').get(fx.goalId)).toEqual(goalBefore);
      expect(fx.db.prepare('SELECT * FROM goal_external_completion_proofs ORDER BY rowid').all()).toEqual(
        proofsBefore,
      );
      const eventsAfter = fx.db.prepare('SELECT * FROM goal_events ORDER BY rowid').all();
      expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
      expect(readStoredCompletion(fx.db, fx.goalId)).toEqual(storedBefore);
      expect(repositoryState(fx.repo)).toEqual(repoBefore);
      expect(readGoalCompletionStanding(fx.db, fx.goalId).standing).toBe('disputed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 independence (sha1, B5 shape): withdrawing A through the route leaves the Goal withdrawn and independent B with its own standing',
    async () => {
      // Fixture: completedWithIndependent (A completed, independent B attested before completion, as in B5). Real Git.
      const made = await completedWithIndependent(1);
      const { fx, attested } = made;
      const independent = made.independent[0]!;
      const { approval, actionDigest } = requestAttestationCorrectionApproval(fx.db, {
        goalId: fx.goalId,
        attestationId: attested.attestationId,
        correctionKind: 'withdraw',
        reasonCode: 'integration_not_performed',
        explanation: null,
        replacementAttestationId: null,
      });
      const independentBefore = getAttestationCorrectionStanding(fx.db, fx.goalId, independent.attestationId);
      app = goalApp(fx.db);

      const response = await call(
        app,
        'POST',
        decisionUrl(fx.goalId, approval.id),
        {
          decision: 'approved',
          attestationId: attested.attestationId,
          correctionKind: 'withdraw',
          explanation: null,
        },
        ifMatch(actionDigest),
      );
      expect(response).toMatchObject({
        status: 201,
        body: {
          completionStanding: {
            kind: 'v2',
            standing: 'withdrawn',
            proof: { attestationId: attested.attestationId },
          },
        },
      });
      expect(response.body.completionStanding.otherAttestations).toEqual([
        {
          attestationId: independent.attestationId,
          recordDigest: independent.recordDigest,
          standing: 'active_uncontested',
          isReplacementOfProofAttestation: false,
          restoresCompletion: false,
        },
      ]);
      expect(getAttestationCorrectionStanding(fx.db, fx.goalId, independent.attestationId)).toEqual(
        independentBefore,
      );
      expect(response.body.completionStanding).toEqual(
        JSON.parse(JSON.stringify(readGoalCompletionStanding(fx.db, fx.goalId))),
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-8 independence (sha1, B2 shape): a dispute before completion makes the completion preflight refuse and leaves the Goal running',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. The dispute is decided through the route before any completion.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { approval, actionDigest } = requestDispute(fx.db, fx.goalId, attested.attestationId);
      app = goalApp(fx.db);

      expect(
        await call(
          app,
          'POST',
          decisionUrl(fx.goalId, approval.id),
          approvedBody(attested.attestationId),
          ifMatch(actionDigest),
        ),
      ).toMatchObject({ status: 201, body: { status: 'approved', sequence: 1 } });
      const preflight = await computeExternalCompletionPreflight(fx.db, fx.goalId, {
        attestationId: attested.attestationId,
      });
      expect(preflight.outcome).not.toBe('ready');
      expect(preflight.reasons.map((reason) => reason.code)).toContain('attestation_disputed');
      expect(fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(fx.goalId)).toEqual({
        status: 'running',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
