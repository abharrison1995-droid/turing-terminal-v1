import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import {
  databaseSnapshot,
  git,
  reattestAtCurrentTip,
  reviewedDigest,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
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

/** Moves the destination base ref to a commit that keeps the attested tree, as the decision test does. */
function moveTip(attested: Awaited<ReturnType<typeof v2RunningAttestedFixture>>): string {
  return git(
    attested.fx.repo,
    'commit-tree',
    attested.attestation.destination.observedTree,
    '-p',
    attested.attestation.destination.observedCommit,
    '-m',
    'destination moved after observation',
  );
}

function completionRowIds(db: Db, goalId: string): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM goal_approvals WHERE goal_id = ? AND external_completion_action_digest IS NOT NULL
         ORDER BY created_at, rowid`,
      )
      .all(goalId) as { id: string }[]
  ).map((row) => row.id);
}

/** Requests and user-approves one completion decision row, as a competing or conflicting writer would. */
function seedApprovedCompletion(
  db: Db,
  goalId: string,
  action: NonNullable<ReturnType<typeof buildExternalCompletionAction>>,
): string {
  const approval = requestGoalApproval(db, {
    goalId,
    gate: 'user_confirmation',
    risk: 'high',
    reason: 'Completion decision committed between Git and commit.',
    requestedBy: 'user',
    detail: { ...action },
    externalCompletionActionDigest: action.actionDigest,
  });
  decideGoalApproval(db, { goalId, approvalId: approval.id, decision: 'approved', decidedBy: 'user' });
  return approval.id;
}

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

  it(
    'D11b a competing decision committed between Git and commit refuses as competing_decision, not as an authority race',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      // The competing decision names the first attestation, built from its preflight before the destination moves.
      const first = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        { allowRecordedDecision: true },
      );
      const firstAction = buildExternalCompletionAction({
        ...first.actionFields!,
        userReviewedPreflightDigest: first.digest,
      })!;
      git(attested.fx.repo, 'update-ref', attested.handoff.target.baseRef, moveTip(attested));
      const second = await reattestAtCurrentTip(attested);
      const digest = await reviewedDigest({ fx: attested.fx, attestationId: second.attestationId });

      let competing: string | null = null;
      seam.afterPreflight = (raceDb, raceGoalId) => {
        competing = seedApprovedCompletion(raceDb, raceGoalId, firstAction);
      };
      const error = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId: second.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );

      // The classifier runs before the snapshot comparison, so the competing row is reported as the competing decision.
      // Without that order the comparison would name the completion row count as an authority change instead.
      expect(seam.afterPreflight).toBeNull();
      expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
      expect(error).toMatchObject({ code: 'competing_decision', detail: null });
      expect(completionRowIds(db, goalId)).toEqual([competing]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D11c a completion row for a fabricated attestation committed between Git and commit refuses as completion_history_invalid',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const report = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: attested.attestationId },
        { allowRecordedDecision: true },
      );
      // The same fabricated-attestation construction as D17b, written in the window after the Git read.
      const foreign = randomUUID();
      const fields = report.actionFields as Record<string, Record<string, unknown>>;
      const foreignAction = buildExternalCompletionAction({
        ...fields,
        attestation: { ...fields.attestation, id: foreign },
        correctionChain: { ...fields.correctionChain, attestationId: foreign },
        userReviewedPreflightDigest: 'e'.repeat(64),
      })!;

      let seeded: string | null = null;
      seam.afterPreflight = (raceDb, raceGoalId) => {
        seeded = seedApprovedCompletion(raceDb, raceGoalId, foreignAction);
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

      expect(seam.afterPreflight).toBeNull();
      expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
      expect(error).toMatchObject({ code: 'preflight_refused', detail: 'completion_history_invalid' });
      // The refused decision wrote nothing: the only completion row is the race row.
      expect(completionRowIds(db, goalId)).toEqual([seeded]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
