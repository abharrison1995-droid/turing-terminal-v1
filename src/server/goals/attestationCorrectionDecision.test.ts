import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
import { requestAttestationCorrectionApproval } from './attestationCorrection.js';
import { decideAttestationCorrectionAsUser } from './attestationCorrectionDecision.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import { abandonGoal, decideGoalApprovalAsUser } from './goalCommands.js';
import {
  databaseSnapshot,
  repositoryState,
  v2AttestedFixture,
  v2DecidedFixture,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Correction-decision authority (D.4C). Fixture path: the D.3F seeding route. `completedFixture` mirrors the
 * `completed(format)` helper of completionStandingService.test.ts (v2DecidedFixture, then the real completion service).
 * `runningFixture` is `v2RunningAttestedFixture` and `attestedFixture` is `v2AttestedFixture`. Real Git is used for every
 * fixture. Review and acceptance are seeded through these fixtures, not through real execution, and each test that relies
 * on them says so in its own comment.
 */

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;

/** A version-2 Goal completed on its decided attestation, through the real completion service (D.3F fixture path). */
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

function goalStatus(db: Db, goalId: string) {
  return (db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string }).status;
}

/** A pending dispute of one attestation, requested through the existing request service (D.3F fixture path). */
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

/** The typed refusal code of a synchronous attempt, or undefined when the attempt succeeds. */
function codeOf(attempt: () => unknown): string | undefined {
  try {
    attempt();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** The dedicated decision input for one approval, named by its stored digest unless a test overrides it. */
function approve(
  goalId: string,
  approvalId: string,
  attested: { attestationId: string },
  reviewedActionDigest: string,
  correctionKind: 'dispute' | 'withdraw' | 'supersede' = 'dispute',
  explanation: string | null = null,
) {
  return {
    goalId,
    approvalId,
    reviewedActionDigest,
    decision: 'approved' as const,
    attestationId: attested.attestationId,
    correctionKind,
    explanation,
  };
}

describe('correction decision: generic route authority', () => {
  it(
    'D4C-1 (sha1, completed Goal): the generic decision refuses a pending correction approval for approve and deny, and writes nothing',
    async () => {
      // Fixture: completed() path. Real Git. The correction is requested through the existing request service.
      const decided = await completedFixture('sha1');
      const { db, goalId } = decided.fx;
      const { approval } = requestDispute(db, goalId, decided.attestationId);
      const before = databaseSnapshot(db);

      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'denied' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });

      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });
      expect(goalStatus(db, goalId)).toBe('completed');
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-1b (sha1, active Goal): the generic decision refuses a pending correction approval, and an approved one, on a running Goal',
    async () => {
      // Fixture: v2RunningAttestedFixture (running Goal, no completion). Real Git. This is the gap the guard closes:
      // before D.4C a pending correction approval on an active Goal could be approved through the generic route.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const { approval } = requestDispute(db, goalId, attested.attestationId);
      const before = databaseSnapshot(db);

      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'denied' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(db)).toEqual(before);

      // An already-approved correction approval is refused too, for either decision, with no write. The approval is
      // decided here by the test-only service path (decideGoalApproval as the user), as the D.3F fixtures do.
      decideGoalApproval(db, { goalId, approvalId: approval.id, decision: 'approved', decidedBy: 'user' });
      const approvedBefore = databaseSnapshot(db);
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'denied' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'approved', decidedBy: 'user' });
      expect(databaseSnapshot(db)).toEqual(approvedBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-1c (sha1, completed Goal): an unrelated pending approval on the same Goal still refuses with goal_terminal and writes nothing',
    async () => {
      // Fixture: completed() path. Real Git. The unrelated approval is a plain user_confirmation request, not a correction.
      const decided = await completedFixture('sha1');
      const { db, goalId } = decided.fx;
      const unrelated = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'medium',
        reason: 'Unrelated pending approval.',
        requestedBy: 'system',
      });
      const before = databaseSnapshot(db);

      await expect(
        decideGoalApprovalAsUser(db, { approvalId: unrelated.id, decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'goal_terminal' });
      expect(getGoalApproval(db, unrelated.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'D4C-1 format check (%s): the generic refusal holds on each object format for a completed Goal',
    async (format) => {
      // Fixture: completed() path on each object format. Real Git.
      const decided = await completedFixture(format);
      const { db, goalId } = decided.fx;
      const { approval } = requestDispute(db, goalId, decided.attestationId);
      await expect(
        decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'correction_decision_requires_dedicated_service' });
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('correction decision: dedicated user service', () => {
  it(
    'D4C-2 (sha1, abandoned Goal): the dedicated decision refuses goal_terminal for approve and deny, and writes nothing',
    async () => {
      // Fixture: v2AttestedFixture (Goal not started), then the real abandon service. Real Git. The correction is
      // requested after abandonment, so it is a pending approval the dedicated path must still refuse.
      const attested = await v2AttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      abandonGoal(db, goalId);
      const { approval, actionDigest } = requestDispute(db, goalId, attested.attestationId);
      const before = databaseSnapshot(db);

      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(db, approve(goalId, approval.id, attested, actionDigest)),
        ),
      ).toBe('goal_terminal');
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(db, {
            goalId,
            approvalId: approval.id,
            reviewedActionDigest: actionDigest,
            decision: 'denied',
          }),
        ),
      ).toBe('goal_terminal');
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'D4C-3 (%s, completed Goal): the dedicated decision approves and appends a dispute after completion',
    async (format) => {
      // Fixture: completed() path. Real Git. The decision goes through the dedicated service, not the generic route.
      const decided = await completedFixture(format);
      const { db, goalId } = decided.fx;
      const { approval, actionDigest } = requestDispute(db, goalId, decided.attestationId);
      expect(readGoalCompletionStanding(db, goalId).standing).toBe('uncontested');

      const result = decideAttestationCorrectionAsUser(
        db,
        approve(goalId, approval.id, decided, actionDigest),
      );

      expect(result).toMatchObject({
        approvalId: approval.id,
        status: 'approved',
        actionDigest,
        sequence: 1,
        reused: false,
      });
      expect(result.correctionId).toEqual(expect.any(String));
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'approved', decidedBy: 'user' });
      const chain = db
        .prepare(
          'SELECT correction_kind, sequence, approval_id FROM goal_attestation_corrections WHERE goal_id = ?',
        )
        .all(goalId);
      expect(chain).toEqual([{ correction_kind: 'dispute', sequence: 1, approval_id: approval.id }]);
      expect(readGoalCompletionStanding(db, goalId).standing).toBe('disputed');
      expect(goalStatus(db, goalId)).toBe('completed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-3b (sha1, completed Goal): the dedicated correction leaves the completion untouched and changes only the correction, approval and event tables',
    async () => {
      // Fixture: completed() path. Real Git. This is the section 5 completion-untouched proof, through the dedicated path.
      const decided = await completedFixture('sha1');
      const { db, goalId, repo } = decided.fx;
      const { approval, actionDigest } = requestDispute(db, goalId, decided.attestationId);
      const snapshotBefore = databaseSnapshot(db);
      const repoBefore = repositoryState(repo);
      const goalBefore = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
      const proofsBefore = db.prepare('SELECT * FROM goal_external_completion_proofs ORDER BY rowid').all();
      const eventsBefore = db.prepare('SELECT * FROM goal_events ORDER BY rowid').all();
      const storedBefore = readStoredCompletion(db, goalId);
      const standingBefore = readGoalCompletionStanding(db, goalId);

      decideAttestationCorrectionAsUser(db, approve(goalId, approval.id, decided, actionDigest));

      const snapshotAfter = databaseSnapshot(db);
      const changed = Object.keys(snapshotAfter.digests)
        .filter(
          (table) =>
            snapshotAfter.digests[table] !== snapshotBefore.digests[table] ||
            snapshotAfter.counts[table] !== snapshotBefore.counts[table],
        )
        .sort();
      expect(changed).toEqual(['goal_approvals', 'goal_attestation_corrections', 'goal_events']);
      expect(db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId)).toEqual(goalBefore);
      expect(db.prepare('SELECT * FROM goal_external_completion_proofs ORDER BY rowid').all()).toEqual(
        proofsBefore,
      );
      const eventsAfter = db.prepare('SELECT * FROM goal_events ORDER BY rowid').all();
      expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
      expect(readStoredCompletion(db, goalId)).toEqual(storedBefore);
      expect(readStoredCompletion(db, goalId)).toMatchObject({ state: 'completed' });
      expect(readGoalCompletionStanding(db, goalId).status.completedAt).toBe(
        standingBefore.status.completedAt,
      );
      expect(readGoalCompletionStanding(db, goalId).standing).toBe('disputed');
      expect(repositoryState(repo)).toEqual(repoBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-4 (sha1, running Goal): each mismatched or invalid decision is refused with its code and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. The dispute carries an explanation, so the explanation check runs.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const dispute = requestDispute(db, goalId, attested.attestationId, 'Recorded by a test.');
      const plain = requestGoalApproval(db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'medium',
        reason: 'Plain approval.',
        requestedBy: 'system',
      });
      const digest = dispute.actionDigest;
      const before = databaseSnapshot(db);

      // A plain approval is not a correction at all.
      expect(
        codeOf(() => decideAttestationCorrectionAsUser(db, approve(goalId, plain.id, attested, digest))),
      ).toBe('correction_action_mismatch');
      // An approval of another Goal is not found for this Goal.
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(db, approve(randomUUID(), dispute.approval.id, attested, digest)),
        ),
      ).toBe('approval_not_found');
      // An If-Match for another action.
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(
            db,
            approve(goalId, dispute.approval.id, attested, 'f'.repeat(64)),
          ),
        ),
      ).toBe('correction_action_mismatch');
      // A different attestation, and a different correction kind.
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(
            db,
            approve(goalId, dispute.approval.id, { attestationId: randomUUID() }, digest),
          ),
        ),
      ).toBe('correction_action_mismatch');
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(
            db,
            approve(goalId, dispute.approval.id, attested, digest, 'withdraw'),
          ),
        ),
      ).toBe('correction_action_mismatch');
      // A wrong or missing explanation for an approved correction that carries one.
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(
            db,
            approve(goalId, dispute.approval.id, attested, digest, 'dispute', 'Different text.'),
          ),
        ),
      ).toBe('explanation_invalid');
      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(
            db,
            approve(goalId, dispute.approval.id, attested, digest, 'dispute', null),
          ),
        ),
      ).toBe('explanation_invalid');

      expect(getGoalApproval(db, dispute.approval.id)).toMatchObject({ status: 'pending' });
      expect(getGoalApproval(db, plain.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-4 (sha1, running Goal): a denied correction cannot later be approved, and a repeated denial is a stable no-op',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const { approval, actionDigest } = requestDispute(db, goalId, attested.attestationId);

      const denied = decideAttestationCorrectionAsUser(db, {
        goalId,
        approvalId: approval.id,
        reviewedActionDigest: actionDigest,
        decision: 'denied',
      });
      expect(denied).toMatchObject({ status: 'denied', correctionId: null, reused: false });
      const afterDenial = databaseSnapshot(db);

      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(db, approve(goalId, approval.id, attested, actionDigest)),
        ),
      ).toBe('already_decided');
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'denied', decidedBy: 'user' });
      expect(databaseSnapshot(db)).toEqual(afterDenial);

      const repeat = decideAttestationCorrectionAsUser(db, {
        goalId,
        approvalId: approval.id,
        reviewedActionDigest: actionDigest,
        decision: 'denied',
      });
      expect(repeat).toMatchObject({ status: 'denied', reused: true });
      expect(databaseSnapshot(db)).toEqual(afterDenial);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-5 (sha1, running Goal): the same decision repeated is a reused no-op, and a second approval of the same digest is refused by the schema',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. The plan expected a second approval of the same digest to reach
      // idempotency_conflict. It cannot: migration 028 (lines 43-44) has a UNIQUE index on
      // (goal_id, attestation_correction_action_digest) for every approval status, so the second request is refused by
      // SQLite before any approval exists. The test asserts that real refusal and that nothing is written.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const first = requestDispute(db, goalId, attested.attestationId);

      // A second request of the same digest, made while the first is still pending, is refused by the unique index.
      const beforeSecond = databaseSnapshot(db);
      expect(() => requestDispute(db, goalId, attested.attestationId)).toThrow(
        /UNIQUE constraint failed: goal_approvals/,
      );
      expect(databaseSnapshot(db)).toEqual(beforeSecond);

      const applied = decideAttestationCorrectionAsUser(
        db,
        approve(goalId, first.approval.id, attested, first.actionDigest),
      );
      expect(applied).toMatchObject({ reused: false, sequence: 1 });
      const afterFirst = databaseSnapshot(db);

      const replay = decideAttestationCorrectionAsUser(
        db,
        approve(goalId, first.approval.id, attested, first.actionDigest),
      );
      expect(replay).toMatchObject({ status: 'approved', reused: true, correctionId: applied.correctionId });
      expect(databaseSnapshot(db)).toEqual(afterFirst);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-6 (sha1, running Goal): a stale review refuses with correction_chain_changed, the decision rolls back, and the first approval wins',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. Two pending approvals of different kinds are requested from the same
      // empty tip. The first decision moves the tip, so the second decision's sequence and previous digest are stale.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const dispute = requestDispute(db, goalId, attested.attestationId);
      const withdraw = requestAttestationCorrectionApproval(db, {
        goalId,
        attestationId: attested.attestationId,
        correctionKind: 'withdraw',
        reasonCode: 'integration_not_performed',
        explanation: null,
        replacementAttestationId: null,
      });

      decideAttestationCorrectionAsUser(
        db,
        approve(goalId, dispute.approval.id, attested, dispute.actionDigest),
      );
      const beforeStale = databaseSnapshot(db);

      expect(
        codeOf(() =>
          decideAttestationCorrectionAsUser(
            db,
            approve(goalId, withdraw.approval.id, attested, withdraw.actionDigest, 'withdraw'),
          ),
        ),
      ).toBe('correction_chain_changed');
      expect(getGoalApproval(db, withdraw.approval.id)).toMatchObject({ status: 'pending' });
      expect(getGoalApproval(db, dispute.approval.id)).toMatchObject({ status: 'approved' });
      expect(databaseSnapshot(db)).toEqual(beforeStale);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-7 (sha1, running Goal): a transition the chain does not allow is refused at request time and writes nothing',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. Dispute, then withdraw, are both decided through the dedicated path.
      // After a withdrawal the tip is not a dispute, so a new dispute is not an allowed transition.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const dispute = requestDispute(db, goalId, attested.attestationId);
      decideAttestationCorrectionAsUser(
        db,
        approve(goalId, dispute.approval.id, attested, dispute.actionDigest),
      );
      const withdraw = requestAttestationCorrectionApproval(db, {
        goalId,
        attestationId: attested.attestationId,
        correctionKind: 'withdraw',
        reasonCode: 'integration_not_performed',
        explanation: null,
        replacementAttestationId: null,
      });
      decideAttestationCorrectionAsUser(
        db,
        approve(goalId, withdraw.approval.id, attested, withdraw.actionDigest, 'withdraw'),
      );
      const before = databaseSnapshot(db);

      expect(
        codeOf(() =>
          requestAttestationCorrectionApproval(db, {
            goalId,
            attestationId: attested.attestationId,
            correctionKind: 'dispute',
            reasonCode: 'observation_error',
            explanation: null,
            replacementAttestationId: null,
          }),
        ),
      ).toBe('correction_transition_not_allowed');
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D4C-4b: the existing service refuses an undecided or system-decided correction, with no write',
    async () => {
      // Fixture: v2RunningAttestedFixture. Real Git. This checks the gate on the existing services the dedicated path uses.
      const attested = await v2RunningAttestedFixture('sha1');
      const { db, goalId } = attested.fx;
      const { approval } = requestDispute(db, goalId, attested.attestationId);
      const before = databaseSnapshot(db);

      expect(
        codeOf(() =>
          decideGoalApproval(db, {
            goalId,
            approvalId: approval.id,
            decision: 'approved',
            decidedBy: 'system',
          }),
        ),
      ).toBe('user_decision_required');
      expect(getGoalApproval(db, approval.id)).toMatchObject({ status: 'pending' });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
