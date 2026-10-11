import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { requestGoalApproval } from './approvals.js';
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { databaseSnapshot, reviewedDigest, v2RunningAttestedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures } from './repoKit.js';

/** Runs once, after the real preflight has read Git and returned, and before the decision transaction. */
const seam = vi.hoisted(() => ({
  afterPreflight: null as null | ((db: Db, goalId: string) => void),
}));

vi.mock('./externalCompletionPreflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalCompletionPreflight.js')>();
  return {
    ...actual,
    computeExternalCompletionPreflightWithIdentity: async (
      db: Db,
      goalId: string,
      input: { attestationId: string },
      options?: { allowRecordedDecision?: boolean },
    ) => {
      const result = await actual.computeExternalCompletionPreflightWithIdentity(db, goalId, input, options);
      const hook = seam.afterPreflight;
      seam.afterPreflight = null;
      hook?.(db, goalId);
      return result;
    },
  };
});

afterEach(() => {
  seam.afterPreflight = null;
  cleanupRepoFixtures();
});

describe('external completion decision: authority race between Git and commit', () => {
  it('D11 refuses when Goal authority changes after the Git read, and records no completion row', async () => {
    const attested = await v2RunningAttestedFixture('sha1');
    const db = attested.fx.db;
    const goalId = attested.fx.goalId;
    const digest = await reviewedDigest(attested);
    const before = databaseSnapshot(db);

    seam.afterPreflight = (raceDb, raceGoalId) => {
      requestGoalApproval(raceDb, {
        goalId: raceGoalId,
        gate: 'final_acceptance',
        risk: 'high',
        reason: 'Authority changed between Git and commit.',
        requestedBy: 'user',
        detail: { race: true },
      });
    };
    const error = await recordExternalCompletionDecision(db, {
      goalId,
      attestationId: attested.attestationId,
      reviewedPreflightDigest: digest,
      acknowledgeContentNotProven: true,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
    expect(error).toMatchObject({ code: 'authority_changed_during_decision', detail: 'handoff_fingerprint' });
    expect(seam.afterPreflight).toBeNull();
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL',
        )
        .get(goalId),
    ).toEqual({ n: 0 });
    const after = databaseSnapshot(db);
    expect(after.counts.goal_approvals).toBe(before.counts.goal_approvals + 1);
    expect(after.counts.goal_external_completion_proofs).toBe(0);
  }, 60_000);
});
