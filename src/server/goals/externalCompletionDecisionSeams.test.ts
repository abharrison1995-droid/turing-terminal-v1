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
import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';
import { completeGoalFromExternalDecision } from './externalCompletion.js';
import {
  appendCorrectionForTest,
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
  /** Runs once after the decision transaction's identity read returns, inside that transaction (D11d, D11e). */
  afterIdentity: null as null | ((db: Db, goalId: string) => void),
  beforeValidate: [] as ((db: Db, goalId: string) => void)[],
  preflightCalls: 0,
  /** Ordered marks: `observed` once the real preflight has returned, before any afterPreflight hook runs. */
  order: [] as string[],
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
      seam.order.push('observed');
      const hook = seam.afterPreflight;
      seam.afterPreflight = null;
      hook?.(db, goalId);
      return result;
    },
    readPreflightSnapshotIdentity: (
      db: Db,
      goalId: string,
      attestationId: string,
      options?: Parameters<typeof actual.readPreflightSnapshotIdentity>[3],
    ) => {
      const result = actual.readPreflightSnapshotIdentity(db, goalId, attestationId, options);
      const hook = seam.afterIdentity;
      seam.afterIdentity = null;
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
  seam.afterIdentity = null;
  seam.beforeValidate = [];
  seam.preflightCalls = 0;
  seam.order = [];
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
        contentOutcomeAcknowledged: true,
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
        contentOutcomeAcknowledged: true,
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

describe('external completion decision: UNIQUE-violation path inside the decision transaction', () => {
  it(
    'D11d a pending row with the same action digest committed inside the transaction refuses as completion_history_invalid and rolls back',
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
      const action = buildExternalCompletionAction({
        ...report.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: report.digest,
      })!;
      const before = databaseSnapshot(db);

      // Written after the identity read and before the decision's own write: the write trips the unique index, and the
      // re-classification sees a pending row, which is class 5.
      seam.afterIdentity = (hookDb, hookGoalId) => {
        requestGoalApproval(hookDb, {
          goalId: hookGoalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'Pending completion row committed inside the decision transaction.',
          requestedBy: 'user',
          detail: { ...action },
          externalCompletionActionDigest: action.actionDigest,
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

      expect(seam.afterIdentity).toBeNull();
      expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
      expect(error).toMatchObject({ code: 'preflight_refused', detail: 'completion_history_invalid' });
      // The hook's row was written inside the transaction, so the refusal rolls it back with everything else.
      expect(databaseSnapshot(db)).toEqual(before);
      expect(completionRowIds(db, goalId)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D11e an approved same-digest row and an approved eligible decision for the first attestation, committed inside the transaction, refuse as competing_decision',
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
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: first.digest,
      })!;
      git(attested.fx.repo, 'update-ref', attested.handoff.target.baseRef, moveTip(attested));
      const second = await reattestAtCurrentTip(attested);
      const digest = await reviewedDigest({ fx: attested.fx, attestationId: second.attestationId });
      const report = await computeExternalCompletionPreflight(
        db,
        goalId,
        { attestationId: second.attestationId },
        { allowRecordedDecision: true },
      );
      const action = buildExternalCompletionAction({
        ...report.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: report.digest,
      })!;
      const before = databaseSnapshot(db);

      // Both rows are written inside the transaction, after the identity read. The same-digest row trips the unique
      // index, and the re-classification finds an eligible competitor on the first attestation: class 4.
      seam.afterIdentity = (hookDb, hookGoalId) => {
        seedApprovedCompletion(hookDb, hookGoalId, action);
        seedApprovedCompletion(hookDb, hookGoalId, firstAction);
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

      expect(seam.afterIdentity).toBeNull();
      expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
      expect(error).toMatchObject({ code: 'competing_decision', detail: null });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(completionRowIds(db, goalId)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'D11f a dispute of the attestation committed inside the transaction, on the UNIQUE re-classification path, refuses as own_decision_ineligible and rolls back',
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
      const action = buildExternalCompletionAction({
        ...report.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: report.digest,
      })!;
      const before = databaseSnapshot(db);

      // The first authorityOutcome sees no own row, so the decision records. Inside the transaction, after the identity
      // read, an approved row with the same digest commits and the attestation is disputed. The write trips the unique
      // index, and the re-classification finds the exact row, which the dispute made ineligible.
      seam.afterIdentity = (hookDb, hookGoalId) => {
        seedApprovedCompletion(hookDb, hookGoalId, action);
        appendCorrectionForTest(attested.fx, attested.attestationId, 'dispute');
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

      expect(seam.afterIdentity).toBeNull();
      expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
      expect(error).toMatchObject({
        code: 'authority_changed_during_decision',
        detail: 'own_decision_ineligible',
      });
      // The seeded row and the dispute were written inside the refused transaction, so both roll back.
      expect(databaseSnapshot(db)).toEqual(before);
      expect(completionRowIds(db, goalId)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

type Attested = Awaited<ReturnType<typeof v2RunningAttestedFixture>>;

function decisionRequest(goalId: string, attestationId: string, reviewedPreflightDigest: string) {
  return { goalId, attestationId, reviewedPreflightDigest, acknowledgeContentNotProven: true };
}

/** Moves the destination to a new commit that keeps the attested tree, so the next attestation is a new observation. */
function advanceTip(attested: Attested): void {
  const repo = attested.fx.repo;
  const base = attested.handoff.target.baseRef;
  const current = git(repo, 'rev-parse', base);
  const tree = git(repo, 'rev-parse', `${current}^{tree}`);
  const next = git(repo, 'commit-tree', tree, '-p', current, '-m', `destination moved ${randomUUID()}`);
  git(repo, 'update-ref', base, next);
}

/** Points the destination back at the commit the fixture attested, so the first attestation is fresh again. */
function restoreTip(attested: Attested): void {
  git(
    attested.fx.repo,
    'update-ref',
    attested.handoff.target.baseRef,
    attested.attestation.destination.observedCommit,
  );
}

function rowOf(db: Db, approvalId: string): string {
  return JSON.stringify(db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(approvalId));
}

/** The rows a refused decision must not change: completion rows, proofs and every event of the Goal. */
function completionCounts(db: Db, goalId: string) {
  return {
    completionRows: completionRowIds(db, goalId),
    proofs: (db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get() as { n: number })
      .n,
    events: (
      db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId) as { n: number }
    ).n,
  };
}

/**
 * Records A's decision, then repeats the same request while a correction of A (dispute, withdraw or supersede) commits
 * after the Git observation and before the decision transaction. The repeat must refuse, not reuse.
 */
async function repeatAfterCorrectionOfA(kind: 'dispute' | 'withdraw' | 'supersede') {
  const attested = await v2RunningAttestedFixture('sha1');
  const db = attested.fx.db;
  const goalId = attested.fx.goalId;
  const attestationId = attested.attestationId;
  const digest = await reviewedDigest(attested);
  const first = await recordExternalCompletionDecision(db, decisionRequest(goalId, attestationId, digest));
  let replacementId: string | null = null;
  if (kind === 'supersede') {
    advanceTip(attested);
    replacementId = (await reattestAtCurrentTip(attested)).attestationId;
    restoreTip(attested);
  }
  const rowBefore = rowOf(db, first.approvalId);

  let snapshot: ReturnType<typeof databaseSnapshot> | null = null;
  let counts: ReturnType<typeof completionCounts> | null = null;
  seam.order = [];
  seam.afterPreflight = (hookDb, hookGoalId) => {
    seam.order.push('correction');
    appendCorrectionForTest(attested.fx, attestationId, kind, replacementId);
    snapshot = databaseSnapshot(hookDb);
    counts = completionCounts(hookDb, hookGoalId);
  };
  const error = await recordExternalCompletionDecision(
    db,
    decisionRequest(goalId, attestationId, digest),
  ).then(
    () => null,
    (caught: unknown) => caught,
  );

  expect(seam.afterPreflight).toBeNull();
  // The Git observation ran before the correction, and the refusal came from the transaction, after both.
  expect(seam.order).toEqual(['observed', 'correction']);
  expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
  expect(error).toMatchObject({
    code: 'authority_changed_during_decision',
    detail: 'own_decision_ineligible',
  });
  expect(databaseSnapshot(db)).toEqual(snapshot);
  expect(completionCounts(db, goalId)).toEqual(counts);
  expect(completionRowIds(db, goalId)).toEqual([first.approvalId]);
  expect(rowOf(db, first.approvalId)).toBe(rowBefore);
}

describe('external completion decision: class 2 reuses only an eligible exact decision', () => {
  it(
    'R1-1 control: an eligible exact decision is still reused, and the repeat writes nothing',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const first = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attested.attestationId, digest),
      );
      const before = databaseSnapshot(db);

      seam.afterPreflight = () => undefined;
      const repeat = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attested.attestationId, digest),
      );

      expect(seam.afterPreflight).toBeNull();
      expect(repeat).toEqual({ ...first, reused: true });
      expect(repeat).toMatchObject({ approvalId: first.approvalId, actionDigest: first.actionDigest });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-2 a dispute of A committed after the Git read refuses the repeat as own_decision_ineligible, with nothing written',
    async () => {
      await repeatAfterCorrectionOfA('dispute');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-3a a withdrawal of A committed after the Git read refuses the repeat as own_decision_ineligible, with nothing written',
    async () => {
      await repeatAfterCorrectionOfA('withdraw');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-3b a supersede of A by a replacement B committed after the Git read refuses the repeat as own_decision_ineligible',
    async () => {
      await repeatAfterCorrectionOfA('supersede');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-4 an invalid correction chain on A, committed after the Git read, refuses the repeat as completion_history_invalid',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const attestationId = attested.attestationId;
      const digest = await reviewedDigest(attested);
      const first = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attestationId, digest),
      );

      let snapshot: ReturnType<typeof databaseSnapshot> | null = null;
      seam.afterPreflight = (hookDb) => {
        // The forged payload is written the way the classifier's chain test writes it (completionAuthorityPolicy.test.ts).
        appendCorrectionForTest(attested.fx, attestationId, 'dispute');
        const stored = hookDb
          .prepare(
            'SELECT payload_json FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?',
          )
          .get(goalId, attestationId) as { payload_json: string };
        const forged = {
          ...(JSON.parse(stored.payload_json) as Record<string, unknown>),
          correctionDigest: 'f'.repeat(64),
        };
        hookDb.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
        hookDb
          .prepare(
            'UPDATE goal_attestation_corrections SET payload_json = ?, correction_digest = ? WHERE goal_id = ? AND attestation_id = ?',
          )
          .run(JSON.stringify(forged), 'f'.repeat(64), goalId, attestationId);
        snapshot = databaseSnapshot(hookDb);
      };
      const error = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attestationId, digest),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(seam.afterPreflight).toBeNull();
      expect(error).toBeInstanceOf(ExternalCompletionDecisionError);
      expect(error).toMatchObject({ code: 'preflight_refused', detail: 'completion_history_invalid' });
      expect(databaseSnapshot(db)).toEqual(snapshot);
      expect(completionRowIds(db, goalId)).toEqual([first.approvalId]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-6 after a refused repeat, a decision for another valid attestation records and completes the Goal once, and A row is unchanged',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const attestationId = attested.attestationId;
      const digest = await reviewedDigest(attested);
      const first = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attestationId, digest),
      );
      const rowA = rowOf(db, first.approvalId);

      seam.afterPreflight = () => {
        appendCorrectionForTest(attested.fx, attestationId, 'dispute');
      };
      const refused = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attestationId, digest),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(refused).toMatchObject({
        code: 'authority_changed_during_decision',
        detail: 'own_decision_ineligible',
      });
      expect(rowOf(db, first.approvalId)).toBe(rowA);

      advanceTip(attested);
      const b = await reattestAtCurrentTip(attested);
      const digestB = await reviewedDigest({ fx: attested.fx, attestationId: b.attestationId });
      const recordedB = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, b.attestationId, digestB),
      );
      expect(recordedB).toMatchObject({ reused: false, status: 'approved' });
      expect(rowOf(db, first.approvalId)).toBe(rowA);

      const completed = await completeGoalFromExternalDecision(
        db,
        decisionRequest(goalId, b.attestationId, digestB),
      );
      expect(completed).toMatchObject({ reused: false });
      const again = await completeGoalFromExternalDecision(
        db,
        decisionRequest(goalId, b.attestationId, digestB),
      );
      expect(again).toMatchObject({ reused: true });
      expect(db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId)).toEqual({
        status: 'completed',
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 1 });
      expect(rowOf(db, first.approvalId)).toBe(rowA);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-8 a repeat after completion and a later dispute refuses as completion_already_recorded, and nothing changes',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const attestationId = attested.attestationId;
      const digest = await reviewedDigest(attested);
      const first = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attestationId, digest),
      );
      await completeGoalFromExternalDecision(db, decisionRequest(goalId, attestationId, digest));
      appendCorrectionForTest(attested.fx, attestationId, 'dispute');
      const before = databaseSnapshot(db);
      const countsBefore = completionCounts(db, goalId);

      const refused = await recordExternalCompletionDecision(
        db,
        decisionRequest(goalId, attestationId, digest),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(refused).toBeInstanceOf(ExternalCompletionDecisionError);
      // The preflight checks the Goal status before the classifier, so a completed Goal refuses as goal_not_running. The
      // classifier still reports the terminal state (class 6) for the same attestation.
      expect(refused).toMatchObject({ code: 'preflight_refused', detail: 'goal_not_running' });
      expect(classifyCompletionAuthority(db, goalId, attestationId)).toMatchObject({ class: 6 });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(completionCounts(db, goalId)).toEqual(countsBefore);
      expect(completionRowIds(db, goalId)).toEqual([first.approvalId]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-9a two identical concurrent decisions under the FIFO lock create one approval and reuse it exactly',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);
      const request = () =>
        recordExternalCompletionDecision(db, decisionRequest(goalId, attested.attestationId, digest));

      const results = await Promise.all([request(), request()]);

      const created = results.filter((result) => !result.reused);
      expect(created).toHaveLength(1);
      expect(results.filter((result) => result.reused)).toEqual([{ ...created[0]!, reused: true }]);
      expect(completionRowIds(db, goalId)).toEqual([created[0]!.approvalId]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'R1-9b a dispute that lands between two identical concurrent decisions refuses the second and keeps the first recorded',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const db = attested.fx.db;
      const goalId = attested.fx.goalId;
      const digest = await reviewedDigest(attested);

      // The first observation (the creating request) is left alone. The second observation runs after the first commits,
      // because the Goal lock is FIFO, and its hook disputes the attestation before the second transaction.
      let observations = 0;
      const disputeBeforeSecond = () => {
        observations += 1;
        if (observations === 1) {
          seam.afterPreflight = disputeBeforeSecond;
          return;
        }
        appendCorrectionForTest(attested.fx, attested.attestationId, 'dispute');
      };
      seam.afterPreflight = disputeBeforeSecond;
      const request = () =>
        recordExternalCompletionDecision(db, decisionRequest(goalId, attested.attestationId, digest)).then(
          (result) => ({ result, error: null as unknown }),
          (caught: unknown) => ({ result: null, error: caught }),
        );

      const [first, second] = await Promise.all([request(), request()]);

      expect(first).toMatchObject({ result: { reused: false } });
      expect(second).toMatchObject({
        error: { code: 'authority_changed_during_decision', detail: 'own_decision_ineligible' },
      });
      expect(completionRowIds(db, goalId)).toEqual([first.result!.approvalId]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
