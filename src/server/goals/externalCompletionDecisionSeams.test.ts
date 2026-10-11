import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { requestGoalApproval } from './approvals.js';
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { databaseSnapshot, reviewedDigest, v2RunningAttestedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * `afterPreflight` runs once, after the real preflight has read Git and returned, and before the decision transaction.
 * `beforeValidate` queues hooks that run once each, inside the Git validation of the next preflight, which sits between
 * the two identity snapshots of that preflight. `preflightCalls` counts preflight invocations made by the decision.
 */
const seam = vi.hoisted(() => ({
  afterPreflight: null as null | ((db: Db, goalId: string) => void),
  beforeValidate: [] as ((db: Db, goalId: string) => void)[],
  preflightCalls: 0,
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
      seam.preflightCalls += 1;
      const result = await actual.computeExternalCompletionPreflightWithIdentity(db, goalId, input, options);
      const hook = seam.afterPreflight;
      seam.afterPreflight = null;
      hook?.(db, goalId);
      return result;
    },
  };
});

vi.mock('./externalIntegration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalIntegration.js')>();
  return {
    ...actual,
    validateExternalIntegrationAttestation: (
      db: Db,
      goalId: string,
      attestationId: string,
    ): ReturnType<typeof actual.validateExternalIntegrationAttestation> => {
      seam.beforeValidate.shift()?.(db, goalId);
      return actual.validateExternalIntegrationAttestation(db, goalId, attestationId);
    },
  };
});

afterEach(() => {
  seam.afterPreflight = null;
  seam.beforeValidate = [];
  seam.preflightCalls = 0;
  cleanupRepoFixtures();
});

describe('external completion decision: authority race between Git and commit', () => {
  it(
    'D11 refuses when Goal authority changes after the Git read, and records no completion row',
    async () => {
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
      expect(error).toMatchObject({
        code: 'authority_changed_during_decision',
        detail: 'handoff_fingerprint',
      });
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
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['sha1', 'sha256'] as const)(
    'E4 retries an observation_changed refusal once with no delay and records the decision under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      seam.preflightCalls = 0;
      seam.beforeValidate = [
        (raceDb, raceGoalId) => {
          requestGoalApproval(raceDb, {
            goalId: raceGoalId,
            gate: 'final_acceptance',
            risk: 'high',
            reason: 'Authority changed during the first observation.',
            requestedBy: 'user',
            detail: { race: 'first' },
          });
        },
      ];

      const result = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId: attested.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });

      expect(result).toMatchObject({ reused: false, status: 'approved', preflightDigest: digest });
      expect(seam.preflightCalls).toBe(2);
      expect(seam.beforeValidate).toEqual([]);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL',
          )
          .get(goalId),
      ).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(['sha1', 'sha256'] as const)(
    'E4b refuses with preflight_refused/observation_changed after exactly two observations under %s',
    async (objectFormat) => {
      const attested = await v2RunningAttestedFixture(objectFormat);
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const beforeApprovals = (
        db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(goalId) as { n: number }
      ).n;
      seam.preflightCalls = 0;
      seam.beforeValidate = ['first', 'second'].map((label) => (raceDb: Db, raceGoalId: string) => {
        requestGoalApproval(raceDb, {
          goalId: raceGoalId,
          gate: 'final_acceptance',
          risk: 'high',
          reason: `Authority changed during ${label} observation.`,
          requestedBy: 'user',
          detail: { race: label },
        });
      });

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
      expect(error).toMatchObject({ code: 'preflight_refused', detail: 'observation_changed' });
      expect(seam.preflightCalls).toBe(2);
      expect(seam.beforeValidate).toEqual([]);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL',
          )
          .get(goalId),
      ).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
      expect(
        (
          db.prepare('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?').get(goalId) as {
            n: number;
          }
        ).n,
      ).toBe(beforeApprovals + 2);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
