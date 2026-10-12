import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getGoalApproval } from './approvals.js';
import { getAttestationCorrectionChainPosition } from './attestationCorrection.js';
import { decideAttestationCorrectionAsUser } from './attestationCorrectionDecision.js';
import {
  requestAttestationCorrectionAsUser,
  type AttestationCorrectionRequestInput,
} from './attestationCorrectionRequest.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { abandonGoal } from './goalCommands.js';
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
 * Correction request service (D.4D). Fixture path: the D.3F seeding route. The attestations are kit-created through the
 * real persistence service, and the Goal is completed through the real completion service where a test needs it. The
 * replacement attestation is observed at a moved destination tip and the tip is restored afterwards, as in the D.4C
 * route tests. Real Git is used for every fixture. Nothing here executes a real withdraw or supersede from a Git
 * observation; those tests are the fixture path, not real execution.
 */

afterEach(() => {
  cleanupRepoFixtures();
});

type AttestedFixture = Awaited<ReturnType<typeof v2AttestedFixture>>;

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

/** A complete, valid request for one attestation. Overrides replace single fields; the position defaults to the current one. */
function requestFor(
  attested: { fx: GoalFixture; attestationId: string; handoff: { handoffId: string } },
  overrides: Partial<AttestationCorrectionRequestInput> = {},
): AttestationCorrectionRequestInput {
  const { fx } = attested;
  return {
    goalId: fx.goalId,
    handoffId: attested.handoff.handoffId,
    attestationId: attested.attestationId,
    expectedChainPosition: getAttestationCorrectionChainPosition(fx.db, fx.goalId, attested.attestationId),
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    explanation: null,
    replacementAttestationId: null,
    ...overrides,
  };
}

/** The typed refusal code of a synchronous attempt, or undefined when the attempt succeeds. */
function codeOf(attempt: () => unknown): string | undefined {
  try {
    attempt();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Tables whose digest or row count changed between two whole-database snapshots, sorted. */
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

/** A version-2 Goal completed on its decided attestation through the real completion service (D.3F fixture path). */
async function completedFixture(format: 'sha1' | 'sha256') {
  const decided = await v2DecidedFixture(format);
  await completeGoalFromExternalDecision(decided.fx.db, {
    goalId: decided.fx.goalId,
    attestationId: decided.attestationId,
    reviewedPreflightDigest: decided.digest,
    acknowledgeContentNotProven: true,
  });
  return decided;
}

describe('correction request service: a new pending gate', () => {
  it(
    'D4D-1 (sha1, running Goal): a dispute request creates one pending gate and changes only the approval table and one event',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. The empty chain's position is the attestation record digest.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const before = databaseSnapshot(db);

      const result = requestAttestationCorrectionAsUser(
        db,
        requestFor(attested, { explanation: 'A private explanation that must not be stored in the gate.' }),
      );

      expect(result).toMatchObject({ status: 'pending', reused: false, actionDigest: expect.any(String) });
      expect(result.detail).toMatchObject({
        correctionKind: 'dispute',
        sequence: 1,
        previousCorrectionDigest: null,
        attestationId: attested.attestationId,
        attestationRecordDigest: attested.attestation.recordDigest,
        explanationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(getGoalApproval(db, result.approvalId)).toMatchObject({
        status: 'pending',
        gate: 'user_confirmation',
        risk: 'high',
        requestedBy: 'user',
        attestationCorrectionActionDigest: result.actionDigest,
      });
      expect(JSON.stringify(getGoalApproval(db, result.approvalId))).not.toContain('private explanation');
      expect(changedTables(before, databaseSnapshot(db))).toEqual(['goal_approvals', 'goal_events']);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_attestation_corrections').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT goal_id, type FROM goal_events ORDER BY rowid DESC LIMIT 1').get()).toEqual({
        goal_id: goalId,
        type: 'approval_requested',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-2 (sha1, running Goal): a withdraw request creates one pending gate and writes no correction',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. Withdraw is requested only; it is never executed here.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db } = attested.fx;
      const before = databaseSnapshot(db);

      const result = requestAttestationCorrectionAsUser(
        db,
        requestFor(attested, { correctionKind: 'withdraw', reasonCode: 'integration_not_performed' }),
      );

      expect(result).toMatchObject({ status: 'pending', reused: false });
      expect(result.detail).toMatchObject({ correctionKind: 'withdraw', replacementAttestationId: null });
      expect(changedTables(before, databaseSnapshot(db))).toEqual(['goal_approvals', 'goal_events']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-3 (sha1, running Goal): a supersede request names its compatible replacement in the reviewed action',
    async () => {
      // Fixture: v2RunningAttestedFixture plus a second attestation B observed at a moved tip (D.3F fixture path).
      const attested = await v2RunningAttestedFixture('sha1');
      const replacement = await attestAnotherAtMovedTip(attested);
      const { db } = attested.fx;

      const result = requestAttestationCorrectionAsUser(
        db,
        requestFor(attested, {
          correctionKind: 'supersede',
          reasonCode: 'superseded_by_new_observation',
          replacementAttestationId: replacement.attestationId,
        }),
      );

      expect(result.detail).toMatchObject({
        correctionKind: 'supersede',
        replacementAttestationId: replacement.attestationId,
        replacementRecordDigest: replacement.recordDigest,
      });
      expect(result).toMatchObject({ status: 'pending', reused: false });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-4 (sha1, running Goal): the tip digest is the chain position after a dispute, and the next request links to it',
    async () => {
      // Fixture: appendCorrectionForTest (kit path) applies a dispute; the withdraw is then requested against its tip.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { record } = appendCorrectionForTest(fx, attested.attestationId, 'dispute');
      const before = databaseSnapshot(fx.db);

      const result = requestAttestationCorrectionAsUser(
        fx.db,
        requestFor(attested, {
          correctionKind: 'withdraw',
          reasonCode: 'integration_not_performed',
          expectedChainPosition: record.correctionDigest,
        }),
      );

      expect(result.detail).toMatchObject({
        sequence: 2,
        previousCorrectionDigest: record.correctionDigest,
      });
      expect(changedTables(before, databaseSnapshot(fx.db))).toEqual(['goal_approvals', 'goal_events']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction request service: the chain position precondition', () => {
  it(
    'D4D-5 (sha1, running Goal): a stale chain position is refused with correction_chain_changed and writes nothing',
    async () => {
      // Fixture: the record digest was reviewed, then a dispute was applied through the kit, so the review is stale.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const reviewed = attested.attestation.recordDigest;
      appendCorrectionForTest(fx, attested.attestationId, 'dispute');
      const before = databaseSnapshot(fx.db);

      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            fx.db,
            requestFor(attested, {
              correctionKind: 'withdraw',
              reasonCode: 'integration_not_performed',
              expectedChainPosition: reviewed,
            }),
          ),
        ),
      ).toBe('correction_chain_changed');
      expect(databaseSnapshot(fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-6 (sha1, running Goal): a chain position that is not a digest of this chain is refused and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. The position is a random digest, so it matches neither the record nor the tip.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db } = attested.fx;
      const before = databaseSnapshot(db);

      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            db,
            requestFor(attested, { expectedChainPosition: 'a'.repeat(64) }),
          ),
        ),
      ).toBe('correction_chain_changed');
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction request service: identical and competing requests', () => {
  it(
    'D4D-7 (sha1, running Goal): an identical pending request returns the same gate, reused, and adds no row',
    async () => {
      // Fixture: v2RunningAttestedFixture. The second request uses the same reviewed position, so nothing has changed.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db } = attested.fx;
      const first = requestAttestationCorrectionAsUser(db, requestFor(attested));
      const afterFirst = databaseSnapshot(db);

      const second = requestAttestationCorrectionAsUser(db, requestFor(attested));

      expect(second).toMatchObject({
        approvalId: first.approvalId,
        actionDigest: first.actionDigest,
        status: 'pending',
        reused: true,
      });
      expect(databaseSnapshot(db)).toEqual(afterFirst);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-8 (sha1, running Goal): a different correction on the same attestation while one is pending is correction_request_pending',
    async () => {
      // Fixture: v2RunningAttestedFixture. A dispute is pending; a withdraw of the same attestation is a different action.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db } = attested.fx;
      requestAttestationCorrectionAsUser(db, requestFor(attested));
      const before = databaseSnapshot(db);

      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            db,
            requestFor(attested, { correctionKind: 'withdraw', reasonCode: 'integration_not_performed' }),
          ),
        ),
      ).toBe('correction_request_pending');
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-9 (sha1, running Goal): a pending gate on attestation A does not block a request on attestation B',
    async () => {
      // Fixture: v2RunningAttestedFixture for A and an independent attestation B at a moved tip.
      const attested = await v2RunningAttestedFixture('sha1');
      const other = await attestAnotherAtMovedTip(attested);
      const { db, goalId } = attested.fx;
      requestAttestationCorrectionAsUser(db, requestFor(attested));

      const forB = requestAttestationCorrectionAsUser(db, {
        goalId,
        handoffId: attested.handoff.handoffId,
        attestationId: other.attestationId,
        expectedChainPosition: other.recordDigest,
        correctionKind: 'dispute',
        reasonCode: 'observation_error',
        explanation: null,
        replacementAttestationId: null,
      });

      expect(forB).toMatchObject({ status: 'pending', reused: false });
      expect(forB.detail.attestationId).toBe(other.attestationId);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-10 (sha1, running Goal): an identical request after a denial is correction_request_already_decided and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. The pending gate is denied through the dedicated D.4C service, then requested again.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const first = requestAttestationCorrectionAsUser(db, requestFor(attested));
      decideAttestationCorrectionAsUser(db, {
        goalId,
        approvalId: first.approvalId,
        reviewedActionDigest: first.actionDigest,
        decision: 'denied',
      });
      const before = databaseSnapshot(db);

      expect(codeOf(() => requestAttestationCorrectionAsUser(db, requestFor(attested)))).toBe(
        'correction_request_already_decided',
      );
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-11 (sha1, running Goal): a transition the chain does not allow is refused and writes nothing',
    async () => {
      // Fixture: a withdraw applied through the kit. A withdraw is terminal, so any further request is refused.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const { record } = appendCorrectionForTest(fx, attested.attestationId, 'withdraw');
      const before = databaseSnapshot(fx.db);

      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            fx.db,
            requestFor(attested, { expectedChainPosition: record.correctionDigest }),
          ),
        ),
      ).toBe('correction_transition_not_allowed');
      expect(databaseSnapshot(fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction request service: refusals write nothing', () => {
  it(
    'D4D-12 (sha1, running Goal): supersede without a replacement, and a replacement that is not valid, are refused with replacement_invalid',
    async () => {
      // Fixture: v2RunningAttestedFixture. B is observed; the replacement is refused when it is A, unknown, or corrected.
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const other = await attestAnotherAtMovedTip(attested);
      appendCorrectionForTest(fx, other.attestationId, 'dispute');
      const before = databaseSnapshot(fx.db);
      const supersede = {
        correctionKind: 'supersede' as const,
        reasonCode: 'superseded_by_new_observation' as const,
      };

      expect(
        codeOf(() => requestAttestationCorrectionAsUser(fx.db, requestFor(attested, { ...supersede }))),
      ).toBe('replacement_invalid');
      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            fx.db,
            requestFor(attested, { ...supersede, replacementAttestationId: attested.attestationId }),
          ),
        ),
      ).toBe('replacement_invalid');
      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            fx.db,
            requestFor(attested, { ...supersede, replacementAttestationId: randomUUID() }),
          ),
        ),
      ).toBe('replacement_invalid');
      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(
            fx.db,
            requestFor(attested, { ...supersede, replacementAttestationId: other.attestationId }),
          ),
        ),
      ).toBe('replacement_invalid');
      expect(databaseSnapshot(fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-13 (sha1, running Goal): an explanation that is empty or has control characters is refused with explanation_invalid',
    async () => {
      // Fixture: v2RunningAttestedFixture. Nothing is recorded for either explanation.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db } = attested.fx;
      const before = databaseSnapshot(db);

      expect(
        codeOf(() => requestAttestationCorrectionAsUser(db, requestFor(attested, { explanation: '' }))),
      ).toBe('explanation_invalid');
      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(db, requestFor(attested, { explanation: 'bad\u0007control' })),
        ),
      ).toBe('explanation_invalid');
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-14 (sha1, running Goal): an attestation under another handoff, or an unknown Goal, is refused and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. The handoff and the Goal are replaced with identifiers that do not match.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db } = attested.fx;
      const before = databaseSnapshot(db);

      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(db, requestFor(attested, { handoffId: randomUUID() })),
        ),
      ).toBe('attestation_not_found');
      expect(
        codeOf(() => requestAttestationCorrectionAsUser(db, requestFor(attested, { goalId: randomUUID() }))),
      ).toBe('goal_not_found');
      expect(
        codeOf(() =>
          requestAttestationCorrectionAsUser(db, requestFor(attested, { attestationId: randomUUID() })),
        ),
      ).toBe('attestation_not_found');
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4D-15 (sha1, abandoned Goal): a request is refused with goal_terminal and writes nothing',
    async () => {
      // Fixture: v2AttestedFixture (not started), then the real abandon service. Real Git.
      const attested = await v2AttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      abandonGoal(db, goalId);
      const before = databaseSnapshot(db);

      expect(codeOf(() => requestAttestationCorrectionAsUser(db, requestFor(attested)))).toBe(
        'goal_terminal',
      );
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction request service: a completed Goal', () => {
  it.each(['sha1', 'sha256'] as const)(
    'D4D-16 (%s, completed Goal): a request adds only one approval and one event, and the completion standing is unchanged',
    async (format) => {
      // Fixture: completed() path (v2DecidedFixture then the real completion service). Real Git.
      const decided = await completedFixture(format);
      const { db, goalId, repo } = decided.fx;
      const goalBefore = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
      const standingBefore = readGoalCompletionStanding(db, goalId);
      const repoBefore = repositoryState(repo);
      const before = databaseSnapshot(db);

      const result = requestAttestationCorrectionAsUser(db, requestFor(decided));

      expect(result).toMatchObject({ status: 'pending', reused: false });
      expect(changedTables(before, databaseSnapshot(db))).toEqual(['goal_approvals', 'goal_events']);
      expect(db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId)).toEqual(goalBefore);
      expect(readGoalCompletionStanding(db, goalId)).toEqual(standingBefore);
      expect(readGoalCompletionStanding(db, goalId).standing).toBe('uncontested');
      expect(repositoryState(repo)).toEqual(repoBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
