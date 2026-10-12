import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { call, goalApp } from './apiKit.js';
import { abandonGoal } from './goalCommands.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  repositoryState,
  v2AttestedFixture,
  v2DecidedFixture,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * HTTP tests for the correction request route and its read additions (D.4D), through `app.inject` on the production app.
 * Fixtures are the D.3F seeding path (kit-created attestations, real Git, real SQLite). Each refusal asserts whole-database
 * and repository equality. Nothing here executes a real withdraw or supersede from a Git observation.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

type AttestedFixture = Awaited<ReturnType<typeof v2AttestedFixture>>;

const requestUrl = (goalId: string, handoffId: string, attestationId: string) =>
  `/api/goals/${goalId}/handoffs/${handoffId}/external-integration/attestations/${attestationId}/corrections`;
const decisionUrl = (goalId: string, approvalId: string) =>
  `/api/goals/${goalId}/attestation-corrections/${approvalId}/decision`;
const quoted = (digest: string) => ({ 'if-match': `"${digest}"` });

const dispute = {
  correctionKind: 'dispute',
  reasonCode: 'observation_error',
  explanation: null,
  replacementAttestationId: null,
} as const;

/** Whole state: every table and the repository. A refused request must leave both unchanged. */
function wholeState(fixture: GoalFixture) {
  return { db: databaseSnapshot(fixture.db), repo: repositoryState(fixture.repo) };
}

/** Tables whose digest or count changed, sorted. */
function changedTables(
  before: ReturnType<typeof databaseSnapshot>,
  after: ReturnType<typeof databaseSnapshot>,
): string[] {
  return Object.keys(after.digests)
    .filter(
      (table) =>
        after.digests[table] !== before.digests[table] || after.counts[table] !== before.counts[table],
    )
    .sort();
}

/** The chain position a GET reports for this attestation, which is the If-Match value a request must carry. */
async function reviewedPosition(application: FastifyInstance, attested: AttestedFixture): Promise<string> {
  const { fx } = attested;
  const read = await call(
    application,
    'GET',
    requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
  );
  expect(read.status).toBe(200);
  return read.body.chainPosition as string;
}

/** Observes a second, independent attestation at a moved destination tip, then restores the tip (D.3F fixture path). */
async function attestAnotherAtMovedTip(attested: AttestedFixture) {
  const { repo } = attested.fx;
  const baseRef = attested.handoff.target.baseRef;
  const proofTip = git(repo, 'rev-parse', baseRef);
  const tree = git(repo, 'rev-parse', `${proofTip}^{tree}`);
  git(
    repo,
    'update-ref',
    baseRef,
    git(repo, 'commit-tree', tree, '-p', proofTip, '-m', 'destination moved for a replacement'),
  );
  const other = await reattestAtCurrentTip(attested);
  git(repo, 'update-ref', baseRef, proofTip);
  return other;
}

describe('correction request route: request shape and If-Match', () => {
  it(
    'D4D-R1 (sha1, running Goal): a dispute is 201 with one pending gate, and only the approval table and one event change',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. The chain position is read from the GET, as the client does.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const before = wholeState(fx);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        dispute,
        quoted(position),
      );

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'pending',
        reused: false,
        actionDigest: expect.any(String),
      });
      expect(response.body.detail).toMatchObject({
        correctionKind: 'dispute',
        sequence: 1,
        previousCorrectionDigest: null,
      });
      expect(changedTables(before.db, databaseSnapshot(fx.db))).toEqual(['goal_approvals', 'goal_events']);
      expect(repositoryState(fx.repo)).toEqual(before.repo);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R2 (sha1, running Goal): an identical pending request is 200 with the same gate, and adds no row',
    async () => {
      // Fixture: v2RunningAttestedFixture. The second request reuses the same reviewed position.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const position = await reviewedPosition(app, attested);
      const first = await call(app, 'POST', url, dispute, quoted(position));
      const afterFirst = wholeState(fx);

      const second = await call(app, 'POST', url, dispute, quoted(position));

      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ approvalId: first.body.approvalId, reused: true });
      expect(wholeState(fx)).toEqual(afterFirst);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R3 (sha1, running Goal): a missing If-Match is 428 and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. No precondition header is sent.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const before = wholeState(fx);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        dispute,
        {},
      );

      expect(response.status).toBe(428);
      expect(response.body.code).toBe('reviewed_action_precondition_required');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R4 (sha1, running Goal): a malformed If-Match (unquoted, weak, uppercase, short or duplicated) is 400 and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. Each malformed value fails the single quoted lowercase SHA-256 rule.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const before = wholeState(fx);
      const malformed = [
        position,
        `W/"${position}"`,
        `"${position.toUpperCase()}"`,
        `"${position.slice(1)}"`,
        `"${position}", "${position}"`,
      ];

      for (const value of malformed) {
        const response = await call(app, 'POST', url, dispute, { 'if-match': value });
        expect(response.status, value).toBe(400);
        expect(response.body.code, value).toBe('reviewed_action_precondition_invalid');
      }
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R5 (sha1, running Goal): a stale If-Match is 409 correction_chain_changed and writes nothing',
    async () => {
      // Fixture: the GET position is read, then a dispute is applied through the kit, so that position is stale.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const stale = await reviewedPosition(app, attested);
      appendCorrectionForTest(fx, attested.attestationId, 'dispute');
      const before = wholeState(fx);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        { ...dispute, correctionKind: 'withdraw', reasonCode: 'integration_not_performed' },
        quoted(stale),
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('correction_chain_changed');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R6 (sha1, running Goal): the GET position is the record digest when no correction exists, and the tip digest after a dispute',
    async () => {
      // Fixture: v2RunningAttestedFixture, then a kit dispute. The GET position must link the next request.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      expect(await reviewedPosition(app, attested)).toBe(attested.attestation.recordDigest);
      const { record } = appendCorrectionForTest(fx, attested.attestationId, 'dispute');
      expect(await reviewedPosition(app, attested)).toBe(record.correctionDigest);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        { ...dispute, correctionKind: 'withdraw', reasonCode: 'integration_not_performed' },
        quoted(record.correctionDigest),
      );

      expect(response.status).toBe(201);
      expect(response.body.detail).toMatchObject({
        sequence: 2,
        previousCorrectionDigest: record.correctionDigest,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction request route: strict body and kind rules', () => {
  it(
    'D4D-R7 (sha1, running Goal): extra keys (actor, digest, status, approval, previous digest) are 400 invalid_request and write nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. Each extra key is refused by the strict body before any read.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const before = wholeState(fx);
      const extras = [
        { actor: 'user' },
        { decidedBy: 'user' },
        { actionDigest: 'a'.repeat(64) },
        { approvalId: randomUUID() },
        { previousCorrectionDigest: position },
        { status: 'approved' },
        { goalId: randomUUID() },
      ];

      for (const extra of extras) {
        const response = await call(app, 'POST', url, { ...dispute, ...extra }, quoted(position));
        expect(response.status, JSON.stringify(extra)).toBe(400);
        expect(response.body.code).toBe('invalid_request');
      }
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R8 (sha1, running Goal): a supersede without a replacement, and a replacement on a dispute, are 400 invalid_request',
    async () => {
      // Fixture: v2RunningAttestedFixture. The rule is checked by the body before any read or write.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const before = wholeState(fx);

      const noReplacement = await call(
        app,
        'POST',
        url,
        { ...dispute, correctionKind: 'supersede', reasonCode: 'superseded_by_new_observation' },
        quoted(position),
      );
      const withReplacement = await call(
        app,
        'POST',
        url,
        { ...dispute, replacementAttestationId: randomUUID() },
        quoted(position),
      );

      expect(noReplacement.status).toBe(400);
      expect(noReplacement.body.code).toBe('invalid_request');
      expect(withReplacement.status).toBe(400);
      expect(withReplacement.body.code).toBe('invalid_request');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R9 (sha1, running Goal): a supersede with a compatible replacement is 201 and names it in the reviewed action',
    async () => {
      // Fixture: v2RunningAttestedFixture plus a second attestation observed at a moved tip (D.3F fixture path).
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const replacement = await attestAnotherAtMovedTip(attested);
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        {
          correctionKind: 'supersede',
          reasonCode: 'superseded_by_new_observation',
          explanation: null,
          replacementAttestationId: replacement.attestationId,
        },
        quoted(position),
      );

      expect(response.status).toBe(201);
      expect(response.body.detail).toMatchObject({
        replacementAttestationId: replacement.attestationId,
        replacementRecordDigest: replacement.recordDigest,
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R10 (sha1, running Goal): a supersede that names itself is 422 replacement_invalid and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. The attestation is named as its own replacement.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const before = wholeState(fx);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        {
          correctionKind: 'supersede',
          reasonCode: 'superseded_by_new_observation',
          explanation: null,
          replacementAttestationId: attested.attestationId,
        },
        quoted(position),
      );

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('replacement_invalid');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R11 (sha1, running Goal): an explanation over the limit is 400 explanation_invalid, and an empty one is refused the same way',
    async () => {
      // Fixture: v2RunningAttestedFixture. The body accepts up to 10,000 characters; the service enforces 1,000.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const before = wholeState(fx);

      const long = await call(
        app,
        'POST',
        url,
        { ...dispute, explanation: 'a'.repeat(1_001) },
        quoted(position),
      );
      const empty = await call(app, 'POST', url, { ...dispute, explanation: '' }, quoted(position));

      expect(long.status).toBe(400);
      expect(long.body.code).toBe('explanation_invalid');
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('explanation_invalid');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction request route: competing requests and refusals', () => {
  it(
    'D4D-R12 (sha1, running Goal): a different pending correction is 409 correction_request_pending, and an identical denied one is 409 correction_request_already_decided',
    async () => {
      // Fixture: v2RunningAttestedFixture. The dispute is denied through the D.4C route, then the identical request is made.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const position = await reviewedPosition(app, attested);
      const pending = await call(app, 'POST', url, dispute, quoted(position));
      const competing = await call(
        app,
        'POST',
        url,
        { ...dispute, correctionKind: 'withdraw', reasonCode: 'integration_not_performed' },
        quoted(position),
      );
      expect(competing.status).toBe(409);
      expect(competing.body.code).toBe('correction_request_pending');

      const denied = await call(
        app,
        'POST',
        decisionUrl(fx.goalId, pending.body.approvalId),
        { decision: 'denied' },
        quoted(pending.body.actionDigest),
      );
      expect(denied.status).toBe(201);
      const before = wholeState(fx);

      const again = await call(app, 'POST', url, dispute, quoted(position));
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('correction_request_already_decided');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R13 (sha1, running Goal): a transition the chain does not allow is 409 correction_transition_not_allowed',
    async () => {
      // Fixture: a withdraw applied through the kit, then a dispute is requested against its tip.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const { record } = appendCorrectionForTest(fx, attested.attestationId, 'withdraw');
      const before = wholeState(fx);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        dispute,
        quoted(record.correctionDigest),
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('correction_transition_not_allowed');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R14 (sha1, running Goal): a wrong handoff in the path is 404 attestation_not_found, and an unknown Goal is 404 goal_not_found; both write nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. The path names a handoff or a Goal that does not own this attestation.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const before = wholeState(fx);

      const wrongHandoff = await call(
        app,
        'POST',
        requestUrl(fx.goalId, randomUUID(), attested.attestationId),
        dispute,
        quoted(position),
      );
      const unknownGoal = await call(
        app,
        'POST',
        requestUrl(randomUUID(), attested.handoff.handoffId, attested.attestationId),
        dispute,
        quoted(position),
      );

      expect(wrongHandoff.status).toBe(404);
      expect(wrongHandoff.body.code).toBe('attestation_not_found');
      expect(unknownGoal.status).toBe(404);
      expect(unknownGoal.body.code).toBe('goal_not_found');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R15 (sha1, abandoned Goal): a request is 409 goal_terminal and writes nothing',
    async () => {
      // Fixture: v2AttestedFixture (not started), then the real abandon service. Real Git.
      const attested = await v2AttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      abandonGoal(fx.db, fx.goalId);
      const position = await reviewedPosition(app, attested);
      const before = wholeState(fx);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        dispute,
        quoted(position),
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('goal_terminal');
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R16 (sha1, completed Goal): a request changes only approvals and one event, and the completion standing is unchanged',
    async () => {
      // Fixture: completed() path (v2DecidedFixture, then the real completion service). Real Git.
      const decided = await v2DecidedFixture('sha1');
      await completeGoalFromExternalDecision(decided.fx.db, {
        goalId: decided.fx.goalId,
        attestationId: decided.attestationId,
        reviewedPreflightDigest: decided.digest,
        acknowledgeContentNotProven: true,
      });
      const { fx } = decided;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, decided);
      const before = databaseSnapshot(fx.db);
      const standingBefore = readGoalCompletionStanding(fx.db, fx.goalId);

      const response = await call(
        app,
        'POST',
        requestUrl(fx.goalId, decided.handoff.handoffId, decided.attestationId),
        dispute,
        quoted(position),
      );

      expect(response.status).toBe(201);
      expect(changedTables(before, databaseSnapshot(fx.db))).toEqual(['goal_approvals', 'goal_events']);
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toEqual(standingBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R17 (sha1, running Goal): the request then the D.4C decision ends in one recorded correction (fixture path)',
    async () => {
      // Fixture: v2RunningAttestedFixture. The two-step path goes through the two real routes; no Git observation is executed.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const position = await reviewedPosition(app, attested);
      const requested = await call(
        app,
        'POST',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
        dispute,
        quoted(position),
      );
      expect(requested.status).toBe(201);

      const decided = await call(
        app,
        'POST',
        decisionUrl(fx.goalId, requested.body.approvalId),
        {
          decision: 'approved',
          attestationId: attested.attestationId,
          correctionKind: 'dispute',
          explanation: null,
        },
        quoted(requested.body.actionDigest),
      );

      expect(decided.status).toBe(201);
      expect(decided.body).toMatchObject({ status: 'approved', sequence: 1, reused: false });
      const read = await call(
        app,
        'GET',
        requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId),
      );
      expect(read.body.standing).toMatchObject({ standing: 'disputed' });
      expect(read.body.pending).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a pending correction gate on a completed Goal is refused by the generic route and changes nothing',
    async () => {
      // Fixture: completed() path (v2DecidedFixture, then the real completion service). Real Git. The gate is requested through the D.4D route.
      const decided = await v2DecidedFixture('sha1');
      await completeGoalFromExternalDecision(decided.fx.db, {
        goalId: decided.fx.goalId,
        attestationId: decided.attestationId,
        reviewedPreflightDigest: decided.digest,
        acknowledgeContentNotProven: true,
      });
      const { fx } = decided;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, decided.handoff.handoffId, decided.attestationId);
      const position = await reviewedPosition(app, decided);
      const requested = await call(app, 'POST', url, dispute, quoted(position));
      expect(requested.status).toBe(201);
      const goalBefore = fx.db.prepare('SELECT status, completed_at FROM goals WHERE id = ?').get(fx.goalId);
      expect(goalBefore).toEqual({ status: 'completed', completed_at: expect.any(String) });
      const before = databaseSnapshot(fx.db);

      // The generic approval route is not the correction decision; it refuses before any status check or write.
      const refused = await call(app, 'POST', `/api/goal-approvals/${requested.body.approvalId}/decision`, {
        decision: 'approved',
      });

      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('correction_decision_requires_dedicated_service');
      expect(databaseSnapshot(fx.db)).toEqual(before);
      expect(fx.db.prepare('SELECT status, completed_at FROM goals WHERE id = ?').get(fx.goalId)).toEqual(
        goalBefore,
      );
      expect((await call(app, 'GET', url)).body.pending).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction history route: read-only additions', () => {
  it(
    'D4D-R18 (sha1): the GET writes nothing, with and without a pending gate, on a running Goal and on a completed Goal',
    async () => {
      // Fixture: v2RunningAttestedFixture (no gate, then a pending gate), then a completed Goal. Real Git.
      const running = await v2RunningAttestedFixture('sha1');
      const { fx } = running;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, running.handoff.handoffId, running.attestationId);
      const beforeNoGate = wholeState(fx);
      expect((await call(app, 'GET', url)).status).toBe(200);
      expect(wholeState(fx)).toEqual(beforeNoGate);

      const position = await reviewedPosition(app, running);
      await call(app, 'POST', url, dispute, quoted(position));
      const beforePending = wholeState(fx);
      expect((await call(app, 'GET', url)).status).toBe(200);
      expect(wholeState(fx)).toEqual(beforePending);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R19 (sha1, completed Goal): the GET writes nothing, with a pending gate present (whole database)',
    async () => {
      // Fixture: completed() path. Real Git. A pending gate is requested through the route, then the GET is read.
      const decided = await v2DecidedFixture('sha1');
      await completeGoalFromExternalDecision(decided.fx.db, {
        goalId: decided.fx.goalId,
        attestationId: decided.attestationId,
        reviewedPreflightDigest: decided.digest,
        acknowledgeContentNotProven: true,
      });
      const { fx } = decided;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, decided.handoff.handoffId, decided.attestationId);
      const position = await reviewedPosition(app, decided);
      expect((await call(app, 'POST', url, dispute, quoted(position))).status).toBe(201);
      const before = wholeState(fx);

      const read = await call(app, 'GET', url);

      expect(read.status).toBe(200);
      expect(read.body.pending).toHaveLength(1);
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-R20 (sha1, running Goal): the GET lists each pending request with explanationRequired, and never shows explanation text',
    async () => {
      // Fixture: v2RunningAttestedFixture. One pending request carries an explanation, so the decision must re-send it.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      app = goalApp(fx.db);
      const url = requestUrl(fx.goalId, attested.handoff.handoffId, attested.attestationId);
      const position = await reviewedPosition(app, attested);
      const explanation = 'An explanation that the read must never echo back.';
      const requested = await call(app, 'POST', url, { ...dispute, explanation }, quoted(position));
      expect(requested.status).toBe(201);

      const read = await call(app, 'GET', url);

      expect(read.body.chainPosition).toBe(position);
      expect(read.body.pendingUnreadableCount).toBe(0);
      expect(read.body.pending).toEqual([
        expect.objectContaining({
          approvalId: requested.body.approvalId,
          actionDigest: requested.body.actionDigest,
          correctionKind: 'dispute',
          reasonCode: 'observation_error',
          sequence: 1,
          previousCorrectionDigest: null,
          replacementAttestationId: null,
          explanationRequired: true,
          requestedAt: expect.any(String),
        }),
      ]);
      expect(JSON.stringify(read.body)).not.toContain(explanation);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
