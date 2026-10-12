import type { Db } from '../db.js';
import { afterEach, describe, expect, it } from 'vitest';
import { getGoalApproval, decideGoalApproval, requestGoalApproval } from './approvals.js';
import { requestAttestationCorrectionApproval } from './attestationCorrection.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import { decideGoalApprovalAsUser } from './goalCommands.js';
import { databaseSnapshot, v2DecidedFixture, v2RunningAttestedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Correction-decision authority (D.4C). Fixture path: the D.3F seeding route. `completedFixture` mirrors the
 * `completed(format)` helper of completionStandingService.test.ts (v2DecidedFixture, then the real completion service),
 * and `runningFixture` is `v2RunningAttestedFixture`. Real Git is used for every fixture. Review and acceptance are
 * seeded through these fixtures, not through real execution, and this file says so for each test that relies on them.
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
function requestDispute(db: Db, goalId: string, attestationId: string) {
  return requestAttestationCorrectionApproval(db, {
    goalId,
    attestationId,
    correctionKind: 'dispute',
    reasonCode: 'observation_error',
    explanation: null,
    replacementAttestationId: null,
  });
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
