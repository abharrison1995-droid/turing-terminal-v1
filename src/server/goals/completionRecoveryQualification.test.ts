import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';
import { goalApp } from './apiKit.js';
import { requestGoalApproval, decideGoalApproval } from './approvals.js';
import { getAttestationCorrectionStanding } from './attestationCorrection.js';
import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { createCycle } from './cycles.js';
import { completeGoalFromExternalDecision, ExternalCompletionError } from './externalCompletion.js';
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { buildExternalCompletionAction } from './externalCompletionProof.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import {
  appendCorrectionForTest,
  databaseSnapshot,
  type GoalFixture,
  git,
  reattestAtCurrentTip,
  repositoryState,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
} from './goalV2TestKit.js';
import { createReview } from './reviews.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Adversarial qualification of the owner's 21 completion-authority cases, on the public services, real SQLite and real
 * Git. Nothing is faked except the external provider boundary, which these fixtures do not reach. Seeded state is written
 * with raw SQL (the triggers are dropped for disposable fixtures only) or through the approval primitives, and each such
 * test says so in its title. Seam tests use two test-only passthrough wrappers of production exports: `afterPreflight`
 * runs synchronously after the first preflight read, and `beforeValidate` runs inside the Git validation of the next
 * preflight. No production code is changed and no hook is exported.
 *
 * Refusals are asserted by exact code and detail, and every refusal path asserts whole-database and repository equality.
 * New completed proofs retain the ancestry subproof's legacy `not_proven` limitation and bind separate verified content evidence.
 */

const seam = vi.hoisted(() => ({
  /** Runs once after the first preflight read of the next computeExternalCompletionPreflightWithIdentity call. */
  afterPreflight: null as null | ((db: Db, goalId: string) => void),
  /** Queued hooks, one per Git validation of an attestation, in call order. */
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
      options?: Parameters<typeof actual.computeExternalCompletionPreflightWithIdentity>[3],
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

const FORMATS = ['sha1', 'sha256'] as const;
type Attested = Awaited<ReturnType<typeof v2RunningAttestedFixture>>;
type Kind = 'dispute' | 'withdraw' | 'supersede';

interface GoalEventRow {
  seq: number;
  id: string;
  goal_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

/** Tables a completion is allowed to change. Every other table must keep its digest. */
const TABLES_A_COMPLETION_CHANGES = new Set([
  'goals',
  'goal_events',
  'goal_content_verifications',
  'goal_external_completion_proofs',
  'goal_runtime',
]);

/** Moves the destination base ref to a new commit on top of the current tip, keeping the current tree. */
function moveTip(attested: Attested): string {
  const repo = attested.fx.repo;
  const base = attested.handoff.target.baseRef;
  const current = git(repo, 'rev-parse', base);
  const tree = git(repo, 'rev-parse', `${current}^{tree}`);
  const commit = git(repo, 'commit-tree', tree, '-p', current, '-m', `destination moved ${randomUUID()}`);
  git(repo, 'update-ref', base, commit);
  return commit;
}

/** Moves the tip, then attests the new tip as a new observation of the same handoff. */
async function attestAtNewTip(attested: Attested) {
  moveTip(attested);
  return reattestAtCurrentTip(attested);
}

/** A disputed A, and B attested at a new tip. Nothing about B is decided yet. */
async function disputedAWithAttestedB(objectFormat: 'sha1' | 'sha256') {
  const a = await v2DecidedFixture(objectFormat);
  appendCorrectionForTest(a.fx, a.attestationId, 'dispute');
  const b = await attestAtNewTip(a);
  return { fx: a.fx, a, bId: b.attestationId, b };
}

/** A disputed A, then B attested, reviewed, and decided (the decision is recorded through the public service). */
async function disputedAThenDecidedB(objectFormat: 'sha1' | 'sha256') {
  const { fx, a, bId } = await disputedAWithAttestedB(objectFormat);
  const digest = await reviewedDigest({ fx, attestationId: bId });
  const recorded = await recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest));
  return { fx, a, bId, digest, recorded };
}

const requestFor = (goalId: string, attestationId: string, reviewedPreflightDigest: string) => ({
  goalId,
  attestationId,
  reviewedPreflightDigest,
  acknowledgeContentNotProven: true,
});

/** The refusal an attempt raises, by code and detail. Fails the test on success or on any other kind of error. */
async function refusalOf(attempt: Promise<unknown>): Promise<{ code: string; detail: string | null }> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalCompletionDecisionError || error instanceof ExternalCompletionError)
      return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('the call succeeded but a refusal was expected');
}

/** The preflight refusal of one attestation, read the same way the decision reads it. */
async function preflightReason(fx: GoalFixture, attestationId: string) {
  const report = await computeExternalCompletionPreflight(
    fx.db,
    fx.goalId,
    { attestationId },
    { allowRecordedDecision: true },
  );
  return { outcome: report.outcome, reason: report.reasons[0] ?? null, digest: report.digest };
}

function approvalRow(db: Db, approvalId: string): unknown {
  return db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(approvalId);
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

function proofCount(db: Db, goalId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?').get(goalId) as {
      n: number;
    }
  ).n;
}

function goalEvents(db: Db, goalId: string): GoalEventRow[] {
  return db
    .prepare(
      'SELECT rowid AS seq, id, goal_id, type, payload_json, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid',
    )
    .all(goalId) as GoalEventRow[];
}

function eventCountsByType(db: Db, goalId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { type } of goalEvents(db, goalId)) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function goalRow(
  db: Db,
  goalId: string,
): { status: string; completed_at: string | null; status_reason_code: string | null } {
  return db
    .prepare('SELECT status, completed_at, status_reason_code FROM goals WHERE id = ?')
    .get(goalId) as { status: string; completed_at: string | null; status_reason_code: string | null };
}

/** The whole database and the repository, plus the Goal's events in order (the events are also in the database). */
interface WholeState {
  db: ReturnType<typeof databaseSnapshot>;
  repo: unknown;
  events: GoalEventRow[];
}

function wholeState(fx: GoalFixture): WholeState {
  return {
    db: databaseSnapshot(fx.db),
    repo: repositoryState(fx.repo),
    events: goalEvents(fx.db, fx.goalId),
  };
}

/** Tables whose digest differs between two database snapshots, sorted. */
function changedTables(
  before: ReturnType<typeof databaseSnapshot>,
  after: ReturnType<typeof databaseSnapshot>,
): string[] {
  return Object.keys(before.digests)
    .filter((table) => before.digests[table] !== after.digests[table])
    .sort();
}

/**
 * The completion wrote exactly one proof and exactly two new events, changed only the tables a completion may change,
 * left the repository and the decision row unchanged, and left no transaction open.
 */
function expectCompletedOnce(
  fx: GoalFixture,
  before: WholeState,
  approvalId: string,
  approvalBefore: unknown,
): void {
  expect(proofCount(fx.db, fx.goalId)).toBe(1);
  const after = goalEvents(fx.db, fx.goalId);
  expect(after.slice(0, before.events.length)).toEqual(before.events);
  const added = after.slice(before.events.length);
  expect(added.map((event) => event.type)).toEqual(['external_completion_recorded', 'state_changed']);
  expect(JSON.parse(added[1]!.payload_json)).toEqual({
    from: 'running',
    to: 'completed',
    reasonCode: EXTERNAL_COMPLETION_REASON,
    actor: 'user',
  });
  expect(goalRow(fx.db, fx.goalId)).toMatchObject({
    status: 'completed',
    status_reason_code: EXTERNAL_COMPLETION_REASON,
    completed_at: added[1]!.created_at,
  });
  const changed = changedTables(before.db, databaseSnapshot(fx.db));
  expect(changed.filter((table) => !TABLES_A_COMPLETION_CHANGES.has(table))).toEqual([]);
  expect(repositoryState(fx.repo)).toEqual(before.repo);
  expect(approvalRow(fx.db, approvalId)).toEqual(approvalBefore);
  expect(fx.db.inTransaction).toBe(false);
}

/** The classifier's entry for one attestation, or null when no completion row names it. */
function entryOf(fx: GoalFixture, attestationId: string) {
  return classifyCompletionAuthority(fx.db, fx.goalId, attestationId).entries.find(
    (entry) => entry.attestationId === attestationId,
  );
}

describe('completion recovery: B after a corrected or decided A, real services and real Git', () => {
  // Case 1 (cannot be waived): a disputed A allows an independent B through record and a separate Complete.
  it.each(FORMATS)(
    'QR01 a disputed A allows an independent B through record and a separate Complete (%s)',
    async (objectFormat) => {
      const { fx, a, bId, b } = await disputedAWithAttestedB(objectFormat);
      const rowA = approvalRow(fx.db, a.recorded.approvalId);
      const digestB = await reviewedDigest({ fx, attestationId: bId });
      expect(await preflightReason(fx, bId)).toMatchObject({ outcome: 'ready', reason: null });

      const recorded = await recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digestB));
      expect(recorded).toMatchObject({ status: 'approved', reused: false, preflightDigest: digestB });
      expect(recorded.approvalId).not.toBe(a.recorded.approvalId);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId, recorded.approvalId]);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
      expect(entryOf(fx, a.attestationId)).toMatchObject({ eligible: false, standing: 'disputed' });
      expect(entryOf(fx, bId)).toMatchObject({ eligible: true });

      const before = { ...wholeState(fx) };
      const approvalB = approvalRow(fx.db, recorded.approvalId);
      const completed = await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digestB));
      expect(completed).toMatchObject({
        reused: false,
        completion: { state: 'completed', approvalId: recorded.approvalId, preflightDigest: digestB },
      });
      expectCompletedOnce(fx, before, recorded.approvalId, approvalB);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(entryOf(fx, a.attestationId)).toMatchObject({ eligible: false });
      expect(readStoredCompletion(fx.db, fx.goalId)).toMatchObject({
        state: 'completed',
        approvalId: recorded.approvalId,
      });
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        otherAttestations: [
          expect.objectContaining({ attestationId: a.attestationId, standing: 'disputed' }),
        ],
      });
      expect(b.attestationId).toBe(bId);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 2: a withdrawn A (withdraw alone, and dispute then withdraw) allows an independent B.
  const WITHDRAWN_CHAINS: ReadonlyArray<readonly [string, readonly Kind[]]> = [
    ['withdraw', ['withdraw']],
    ['dispute then withdraw', ['dispute', 'withdraw']],
  ];
  it.each(
    FORMATS.flatMap((format) => WITHDRAWN_CHAINS.map(([label, chain]) => [format, label, chain] as const)),
  )(
    'QR02 a withdrawn A (%s) allows an independent B (%s)',
    async (objectFormat, _label, chain) => {
      const a = await v2DecidedFixture(objectFormat);
      const { fx } = a;
      const rowA = approvalRow(fx.db, a.recorded.approvalId);
      for (const kind of chain) appendCorrectionForTest(fx, a.attestationId, kind);
      const b = await attestAtNewTip(a);
      const digestB = await reviewedDigest({ fx, attestationId: b.attestationId });
      const recorded = await recordExternalCompletionDecision(
        fx.db,
        requestFor(fx.goalId, b.attestationId, digestB),
      );
      expect(recorded).toMatchObject({ reused: false, status: 'approved' });
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId, recorded.approvalId]);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(entryOf(fx, a.attestationId)).toMatchObject({ eligible: false });

      const before = wholeState(fx);
      const approvalB = approvalRow(fx.db, recorded.approvalId);
      await expect(
        completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, b.attestationId, digestB)),
      ).resolves.toMatchObject({ reused: false, completion: { approvalId: recorded.approvalId } });
      expectCompletedOnce(fx, before, recorded.approvalId, approvalB);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        otherAttestations: [
          expect.objectContaining({ attestationId: a.attestationId, standing: 'withdrawn' }),
        ],
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 3: a superseded A creates no decision for its replacement B and never retargets A's decision.
  it(
    "QR03 a superseded A names B but creates no decision for B and never retargets A's decision (sha1)",
    async () => {
      const a = await v2DecidedFixture('sha1');
      const { fx } = a;
      const rowA = approvalRow(fx.db, a.recorded.approvalId);
      const b = await attestAtNewTip(a);
      appendCorrectionForTest(fx, a.attestationId, 'supersede', b.attestationId);

      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(entryOf(fx, a.attestationId)).toMatchObject({ eligible: false, standing: 'superseded' });

      // A's own completion is refused by its superseded standing, and nothing is written.
      const beforeRefusal = wholeState(fx);
      expect(
        await refusalOf(
          completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, a.attestationId, a.digest)),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_superseded' });
      expect(wholeState(fx)).toEqual(beforeRefusal);

      // B has no decision until it is recorded explicitly, with its own fresh digest.
      const digestB = await reviewedDigest({ fx, attestationId: b.attestationId });
      const recorded = await recordExternalCompletionDecision(
        fx.db,
        requestFor(fx.goalId, b.attestationId, digestB),
      );
      expect(recorded).toMatchObject({ reused: false, status: 'approved' });
      expect(recorded.approvalId).not.toBe(a.recorded.approvalId);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId, recorded.approvalId]);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);

      const before = wholeState(fx);
      const approvalB = approvalRow(fx.db, recorded.approvalId);
      await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, b.attestationId, digestB));
      expectCompletedOnce(fx, before, recorded.approvalId, approvalB);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 20 (cannot be waived): the valid B completion gives exactly one proof and one transition, with its details.
  it.each(FORMATS)(
    'QR20 B after a corrected, decided A completes with exactly one proof, one event pair and verified content evidence (%s)',
    async (objectFormat) => {
      const { fx, bId, digest, recorded } = await disputedAThenDecidedB(objectFormat);
      const before = wholeState(fx);
      const approvalB = approvalRow(fx.db, recorded.approvalId);
      const completed = await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest));
      expect(completed.completion).toMatchObject({ state: 'completed', approvalId: recorded.approvalId });
      expectCompletedOnce(fx, before, recorded.approvalId, approvalB);

      const changed = changedTables(before.db, databaseSnapshot(fx.db));
      expect(changed).toEqual(
        expect.arrayContaining(['goals', 'goal_events', 'goal_external_completion_proofs']),
      );
      const proof = fx.db
        .prepare('SELECT payload_json FROM goal_external_completion_proofs WHERE goal_id = ?')
        .get(fx.goalId) as { payload_json: string };
      const body = JSON.parse(proof.payload_json) as {
        decision: { approvalId: string };
        contentVerificationDigest: string;
        proofLimitations: { contentPreservation: string };
      };
      expect(body.decision.approvalId).toBe(recorded.approvalId);
      expect(body.contentVerificationDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(body.proofLimitations.contentPreservation).toBe('not_proven');
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        claim: { contentPreservation: 'verified' },
      });
      expect(completed.completion.proofId).toBeTruthy();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 21: a correction after B's completion moves standing and nothing else (dispute, withdraw, supersede).
  it.each(['dispute', 'withdraw', 'supersede'] as const)(
    'QR21 a %s correction after B completes changes standing and leaves the proof and both decisions identical (sha1)',
    async (kind) => {
      const { fx, a, bId, digest, recorded } = await disputedAThenDecidedB('sha1');
      // The replacement must exist before completion (attesting is refused once the Goal is completed). Its observation
      // needs a new tip, so the tip moves, is attested, and is restored to B's tip before completion.
      const base = a.handoff.target.baseRef;
      const tipOfB = git(fx.repo, 'rev-parse', base);
      let replacement: Awaited<ReturnType<typeof reattestAtCurrentTip>> | null = null;
      if (kind === 'supersede') {
        moveTip(a);
        replacement = await reattestAtCurrentTip(a);
        git(fx.repo, 'update-ref', base, tipOfB);
      }
      await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest));
      const proofBytes = JSON.stringify(
        fx.db
          .prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid')
          .all(fx.goalId),
      );
      const decisionA = approvalRow(fx.db, a.recorded.approvalId);
      const decisionB = approvalRow(fx.db, recorded.approvalId);
      const before = databaseSnapshot(fx.db);

      appendCorrectionForTest(fx, bId, kind, replacement?.attestationId ?? null);

      // The correction writes its approval row, its correction row, and its events. Nothing else in the database moves.
      expect(changedTables(before, databaseSnapshot(fx.db))).toEqual([
        'goal_approvals',
        'goal_attestation_corrections',
        'goal_events',
      ]);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(decisionA);
      expect(approvalRow(fx.db, recorded.approvalId)).toEqual(decisionB);
      expect(
        JSON.stringify(
          fx.db
            .prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid')
            .all(fx.goalId),
        ),
      ).toBe(proofBytes);
      expect(goalRow(fx.db, fx.goalId)).toMatchObject({ status: 'completed' });
      const standingOfB = readGoalCompletionStanding(fx.db, fx.goalId);
      const expected = kind === 'dispute' ? 'disputed' : kind === 'withdraw' ? 'withdrawn' : 'superseded';
      expect(standingOfB).toMatchObject({ kind: 'v2', standing: expected });
      const replay = await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest));
      expect(replay).toMatchObject({ reused: true, completion: { approvalId: recorded.approvalId } });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

/** Requests and user-approves one completion decision row, as a competing or conflicting writer would (seam hooks only). */
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

/** Drops the approval identity and terminal guards on a disposable fixture, so a seeded row can be tampered with. */
function dropApprovalGuards(db: Db): void {
  db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
}

describe('completion recovery: B refused by eligible, corrupt, or invalid authority', () => {
  // Case 4: an eligible A, including a Git-stale uncorrected A, blocks every route to B.
  it(
    'QR04 an eligible A, including a Git-stale uncorrected A, blocks every route to B and writes nothing (sha1)',
    async () => {
      const a = await v2DecidedFixture('sha1');
      const { fx } = a;
      const b = await attestAtNewTip(a);
      // A is decided, uncorrected, and its destination has moved past its observation, so it is Git-stale but eligible.
      expect(entryOf(fx, a.attestationId)).toMatchObject({ eligible: true, standing: 'active_uncontested' });
      expect(classifyCompletionAuthority(fx.db, fx.goalId, b.attestationId).class).toBe(4);
      const app = goalApp(fx.db);
      try {
        await app.ready();
        const before = wholeState(fx);

        // Route 1: the read-only preflight of B.
        expect(await preflightReason(fx, b.attestationId)).toMatchObject({
          outcome: 'refused',
          reason: { code: 'completion_already_recorded', detail: 'competing_decision' },
        });
        // Route 2: the decision service, with an arbitrary digest (the preflight refuses before the digest is compared).
        expect(
          await refusalOf(
            recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, b.attestationId, 'e'.repeat(64))),
          ),
        ).toEqual({ code: 'competing_decision', detail: null });
        // Route 3: the completion service, which has no decision for B to complete.
        expect(
          await refusalOf(
            completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, b.attestationId, 'e'.repeat(64))),
          ),
        ).toEqual({ code: 'decision_not_found', detail: null });
        // Route 4: the HTTP decision route, with the same arbitrary digest in If-Match.
        const response = await app.inject({
          method: 'POST',
          url: `/api/goals/${fx.goalId}/completion-decision`,
          headers: { 'if-match': `"${'e'.repeat(64)}"` },
          payload: {
            decision: 'record_completion_decision',
            attestationId: b.attestationId,
            acknowledgeContentNotProven: true,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'competing_decision' });

        expect(wholeState(fx)).toEqual(before);
        expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
        expect(proofCount(fx.db, fx.goalId)).toBe(0);
      } finally {
        await app.close();
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 5: corrupt completion history blocks B. Seeded: the rows are tampered with raw SQL on disposable fixtures.
  // The tamper variants below are SEEDED. Each names the row it changes and the refusal it must produce.
  const CORRUPT_HISTORY_VARIANTS = [
    {
      label: 'the stored action digest of A is altered (SEEDED)',
      tamper: (fx: GoalFixture, ids: { approvalId: string }) => {
        dropApprovalGuards(fx.db);
        fx.db
          .prepare('UPDATE goal_approvals SET external_completion_action_digest = ? WHERE id = ?')
          .run('f'.repeat(64), ids.approvalId);
      },
      expected: { code: 'decision_corrupt', detail: 'digest_mismatch' },
    },
    {
      label: 'the status of A is set to denied (SEEDED)',
      tamper: (fx: GoalFixture, ids: { approvalId: string }) => {
        dropApprovalGuards(fx.db);
        fx.db.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(ids.approvalId);
      },
      expected: { code: 'decision_corrupt', detail: 'approval_fields_invalid' },
    },
    {
      label: 'the status of A is set back to pending (SEEDED)',
      tamper: (fx: GoalFixture, ids: { approvalId: string }) => {
        dropApprovalGuards(fx.db);
        fx.db
          .prepare(
            "UPDATE goal_approvals SET status = 'pending', decided_by = NULL, responded_at = NULL WHERE id = ?",
          )
          .run(ids.approvalId);
      },
      expected: { code: 'decision_corrupt', detail: 'approval_fields_invalid' },
    },
    {
      label:
        'a forged row whose detail names the completion kind but has no action digest (LIKE match, SEEDED)',
      tamper: (fx: GoalFixture, _ids: { approvalId: string; attestationId: string }) => {
        dropApprovalGuards(fx.db);
        fx.db.exec('DROP TRIGGER trg_goal_approval_external_completion_action_guard;');
        requestGoalApproval(fx.db, {
          goalId: fx.goalId,
          gate: 'user_confirmation',
          risk: 'high',
          reason: 'A forged completion row without an action digest.',
          requestedBy: 'user',
          detail: { kind: 'complete_goal_external_integration_v2' },
        });
      },
      expected: { code: 'decision_corrupt', detail: 'not_completion_approval' },
    },
    {
      label: 'a completion row for a fabricated attestation (SEEDED, the D17b construction)',
      tamper: (fx: GoalFixture, _ids: { approvalId: string; attestationId: string }, bId: string) => {
        const report = computeExternalCompletionPreflight(
          fx.db,
          fx.goalId,
          { attestationId: bId },
          { allowRecordedDecision: true },
        );
        return report.then((r) => {
          const foreign = randomUUID();
          const fields = r.actionFields as Record<string, Record<string, unknown>>;
          const foreignAction = buildExternalCompletionAction({
            ...fields,
            attestation: { ...fields.attestation, id: foreign },
            correctionChain: { ...fields.correctionChain, attestationId: foreign },
            contentOutcomeAcknowledged: true,
            userReviewedPreflightDigest: 'e'.repeat(64),
          })!;
          seedApprovedCompletion(fx.db, fx.goalId, foreignAction);
        });
      },
      expected: { code: 'preflight_refused', detail: 'completion_history_invalid' },
    },
    {
      label: 'the stored attestation record of A is altered (SEEDED, the T8 recipe)',
      tamper: (fx: GoalFixture, ids: { attestationId: string }) => {
        const aId = ids.attestationId;
        const row = fx.db
          .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
          .get(aId) as { payload_json: string };
        const tampered = {
          ...(JSON.parse(row.payload_json) as Record<string, unknown>),
          observedAt: '2020-01-01T00:00:00.000Z',
        };
        fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
        fx.db
          .prepare(
            'UPDATE goal_external_integration_attestations SET payload_json = ?, observed_at = ? WHERE id = ?',
          )
          .run(JSON.stringify(tampered), tampered.observedAt, aId);
      },
      expected: { code: 'preflight_refused', detail: 'completion_history_invalid' },
    },
  ] as const;

  it.each(CORRUPT_HISTORY_VARIANTS.map((variant) => [variant.label, variant] as const))(
    'QR05 corrupt completion history blocks B after A is corrected: %s',
    async (_label, variant) => {
      const { fx, a, bId } = await disputedAWithAttestedB('sha1');
      const digestB = await reviewedDigest({ fx, attestationId: bId });
      await variant.tamper(fx, { attestationId: a.attestationId, approvalId: a.recorded.approvalId }, bId);
      const before = wholeState(fx);
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digestB))),
      ).toEqual(variant.expected);
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 6: an invalid correction chain blocks B, on A's side and on B's own side (SEEDED: stored payload forged).
  it(
    'QR06a an invalid correction chain on A (SEEDED, forged payload) blocks B as completion_history_invalid',
    async () => {
      const { fx, a, bId } = await disputedAWithAttestedB('sha1');
      const digestB = await reviewedDigest({ fx, attestationId: bId });
      const stored = fx.db
        .prepare(
          'SELECT payload_json FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?',
        )
        .get(fx.goalId, a.attestationId) as { payload_json: string };
      const forged = {
        ...(JSON.parse(stored.payload_json) as Record<string, unknown>),
        correctionDigest: 'f'.repeat(64),
      };
      fx.db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      fx.db
        .prepare(
          'UPDATE goal_attestation_corrections SET payload_json = ?, correction_digest = ? WHERE goal_id = ? AND attestation_id = ?',
        )
        .run(JSON.stringify(forged), 'f'.repeat(64), fx.goalId, a.attestationId);
      const before = wholeState(fx);
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digestB))),
      ).toEqual({ code: 'preflight_refused', detail: 'completion_history_invalid' });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'QR06b an invalid correction chain on B itself (SEEDED, forged payload) refuses B as correction_standing_invalid',
    async () => {
      const { fx, bId } = await disputedAWithAttestedB('sha1');
      appendCorrectionForTest(fx, bId, 'dispute');
      const stored = fx.db
        .prepare(
          'SELECT payload_json FROM goal_attestation_corrections WHERE goal_id = ? AND attestation_id = ?',
        )
        .get(fx.goalId, bId) as { payload_json: string };
      const forged = {
        ...(JSON.parse(stored.payload_json) as Record<string, unknown>),
        correctionDigest: 'f'.repeat(64),
      };
      fx.db.exec('DROP TRIGGER trg_goal_attestation_correction_immutable;');
      fx.db
        .prepare(
          'UPDATE goal_attestation_corrections SET payload_json = ?, correction_digest = ? WHERE goal_id = ? AND attestation_id = ?',
        )
        .run(JSON.stringify(forged), 'f'.repeat(64), fx.goalId, bId);
      const invalidCode = getAttestationCorrectionStanding(fx.db, fx.goalId, bId).invalidCode;
      expect(invalidCode).not.toBeNull();
      const before = wholeState(fx);
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, 'e'.repeat(64)))),
      ).toEqual({ code: 'preflight_refused', detail: 'correction_standing_invalid' });
      expect(await preflightReason(fx, bId)).toMatchObject({
        reason: { code: 'correction_standing_invalid', detail: invalidCode },
      });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 7: a tampered selected B refuses as invalidity, not as competing_decision, while A is ineligible.
  it(
    'QR07 a tampered B attestation refuses after A is corrected, as attestation_invalid and not competing_decision (SEEDED)',
    async () => {
      const { fx, bId } = await disputedAWithAttestedB('sha1');
      const digestB = await reviewedDigest({ fx, attestationId: bId });
      const row = fx.db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(bId) as { payload_json: string };
      const tampered = {
        ...(JSON.parse(row.payload_json) as Record<string, unknown>),
        observedAt: '2020-01-01T00:00:00.000Z',
      };
      fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      fx.db
        .prepare(
          'UPDATE goal_external_integration_attestations SET payload_json = ?, observed_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(tampered), tampered.observedAt, bId);
      // The classifier reads A as the only completion row: class 3, so a competing decision is not the reason.
      expect(classifyCompletionAuthority(fx.db, fx.goalId, bId).class).toBe(3);
      const before = wholeState(fx);
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digestB))),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_invalid' });
      expect(wholeState(fx)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 8: a stale B refuses at record, and a decided B refuses at Complete once the tip moves past it.
  it(
    'QR08a a stale B refuses at record once the destination advanced past its observation (sha1)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const { fx } = attested;
      const digest = await reviewedDigest({ fx, attestationId: attested.attestationId });
      moveTip(attested);
      const before = wholeState(fx);
      expect(
        await refusalOf(
          recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, attested.attestationId, digest)),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'destination_advanced_after_observation' });
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'QR08b a decided B refuses at Complete once the destination advanced past it, and nothing is written (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      moveTip(decided);
      const before = wholeState(fx);
      expect(
        await refusalOf(
          completeGoalFromExternalDecision(
            fx.db,
            requestFor(fx.goalId, decided.attestationId, decided.digest),
          ),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'destination_advanced_after_observation' });
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
      expect(goalRow(fx.db, fx.goalId)).toMatchObject({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 9: destination Git changes after B's decision refuse Complete, with the pinned preflight code.
  type HandoffOf = Attested['handoff'];
  const DESTINATION_CHANGES: ReadonlyArray<
    readonly [string, (fx: GoalFixture, handoff: HandoffOf) => void, { code: string; detail: string }]
  > = [
    [
      'the base is rewritten to an unrelated root',
      (fx, handoff) => git(fx.repo, 'update-ref', handoff.target.baseRef, fx.orphanCommit()),
      { code: 'preflight_refused', detail: 'destination_not_integrated' },
    ],
    [
      'the base ref is deleted',
      (fx, handoff) => {
        // The base ref is the checked-out branch, so HEAD moves to a branch at the same commit first (the T21 recipe).
        git(fx.repo, 'branch', 'retained-head');
        git(fx.repo, 'symbolic-ref', 'HEAD', 'refs/heads/retained-head');
        git(fx.repo, 'update-ref', '-d', handoff.target.baseRef);
      },
      { code: 'preflight_refused', detail: 'attestation_stale' },
    ],
    [
      'the repository identity changes under the Goal (the T22 recipe)',
      (fx, handoff) => {
        const clone = join(dirname(fx.repo), 'clone');
        execFileSync('git', ['clone', '--quiet', '--no-hardlinks', fx.repo, clone]);
        git(clone, 'branch', handoff.source.goalRef.slice('refs/heads/'.length), handoff.source.commit);
        fx.db
          .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
          .run(clone, clone, fx.projectId);
      },
      { code: 'preflight_refused', detail: 'attestation_stale' },
    ],
  ] as const;

  it.each(
    FORMATS.flatMap((format) =>
      DESTINATION_CHANGES.map(([label, mutate, expected]) => [format, label, mutate, expected] as const),
    ),
  )(
    "QR09 destination Git changes after B's decision refuse Complete, with nothing written (%s, %s)",
    async (objectFormat, _label, mutate, expected) => {
      const { fx, a, bId, digest } = await disputedAThenDecidedB(objectFormat);
      mutate(fx, a.handoff);
      const before = wholeState(fx);
      expect(
        await refusalOf(completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual(expected);
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
      expect(goalRow(fx.db, fx.goalId)).toMatchObject({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 10: a stale final review or acceptance refuses B. The acceptance half has no production recipe that changes
  // only the acceptance, so it is reported as a PARTIAL: only the review and the source-criterion halves are asserted.
  it(
    'QR10a a source change that makes a required criterion stale refuses B with completion_not_ready (sha1)',
    async () => {
      const { fx, bId, digest } = await disputedAThenDecidedB('sha1');
      fx.advance({ 'src/result.txt': null }, 'remove the deliverable after the decision');
      const before = wholeState(fx);
      expect(
        await refusalOf(completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'completion_not_ready' });
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    "QR10b a pending final review refuses B's Complete before any Git work (sha1)",
    async () => {
      const { fx, bId, digest } = await disputedAThenDecidedB('sha1');
      await createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' });
      const before = wholeState(fx);
      expect(
        await refusalOf(completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'pending_review' });
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 11: active work refuses B's Complete before Git. Recording is not gated by active work (the probe below).
  it(
    "QR11a an active execution cycle refuses B's Complete before Git, with nothing written (sha1)",
    async () => {
      const { fx, bId, digest } = await disputedAThenDecidedB('sha1');
      createCycle(fx.db, {
        goalId: fx.goalId,
        kind: 'verification',
        triggerCode: 'handoff_test',
        milestoneKey: 'm1',
      });
      const before = wholeState(fx);
      expect(
        await refusalOf(completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'active_work' });
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'QR11b probe: recording B while a verification cycle is active is refused as attestation_stale with no writes (sha1)',
    async () => {
      const { fx, a, bId } = await disputedAWithAttestedB('sha1');
      const digest = await reviewedDigest({ fx, attestationId: bId });
      createCycle(fx.db, {
        goalId: fx.goalId,
        kind: 'verification',
        triggerCode: 'handoff_test',
        milestoneKey: 'm1',
      });
      // Probe result: with a cycle open, the record refuses at the Git observation of B. The refusal code is
      // attestation_stale and its reason detail is active_work (pinned below). QR11a pins the Complete refusal, active_work.
      const before = wholeState(fx);
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_stale' });
      // The stale state carries the active-work reason: the record refuses for active work through the attestation check.
      expect(await preflightReason(fx, bId)).toMatchObject({
        outcome: 'refused',
        reason: { code: 'attestation_stale', detail: 'active_work' },
      });
      expect(wholeState(fx)).toEqual(before);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 12: a correction after the preflight invalidates the authority the user reviewed. Windows (i) and (ii) are
  // real; window (iii) is a seam, because only a hook can run between the Git read and the decision commit.
  it.each(FORMATS)(
    'QR12i a dispute of B after review and before record refuses the record as attestation_disputed (%s)',
    async (objectFormat) => {
      const { fx, a, bId } = await disputedAWithAttestedB(objectFormat);
      const digest = await reviewedDigest({ fx, attestationId: bId });
      appendCorrectionForTest(fx, bId, 'dispute');
      const before = wholeState(fx);
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_disputed' });
      expect(wholeState(fx)).toEqual(before);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'QR12ii a dispute of decided B before Complete refuses Complete as attestation_disputed, rows unchanged (%s)',
    async (objectFormat) => {
      const { fx, a, bId, digest, recorded } = await disputedAThenDecidedB(objectFormat);
      appendCorrectionForTest(fx, bId, 'dispute');
      const rowA = approvalRow(fx.db, a.recorded.approvalId);
      const rowB = approvalRow(fx.db, recorded.approvalId);
      const before = wholeState(fx);
      expect(
        await refusalOf(completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_disputed' });
      expect(wholeState(fx)).toEqual(before);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(approvalRow(fx.db, recorded.approvalId)).toEqual(rowB);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'QR12iii (seam) a correction on the already-ineligible A between the Git read and the commit refuses B as authority_changed_during_decision with detail policy_digest',
    async () => {
      const { fx, a, bId } = await disputedAWithAttestedB('sha1');
      const digest = await reviewedDigest({ fx, attestationId: bId });
      let captured: ReturnType<typeof databaseSnapshot> | null = null;
      seam.afterPreflight = (hookDb) => {
        // A is already disputed and ineligible; withdrawing it changes the completion policy identity, not A's eligibility.
        appendCorrectionForTest(fx, a.attestationId, 'withdraw');
        captured = databaseSnapshot(hookDb);
      };
      const refusal = await refusalOf(
        recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest)),
      );
      expect(seam.afterPreflight).toBeNull();
      expect(refusal.code).toBe('authority_changed_during_decision');
      // The first difference observed is the completion policy digest (externalCompletionPreflight.ts policy_digest).
      expect(refusal.detail).toBe('policy_digest');
      expect(databaseSnapshot(fx.db)).toEqual(captured);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 13: a correction appended during the Git observation (seam: beforeValidate). Both formats.
  it.each(FORMATS)(
    'QR13a an unrelated approval committed during one observation is retried and the decision is recorded (seam, %s)',
    async (objectFormat) => {
      const { fx, a, bId } = await disputedAWithAttestedB(objectFormat);
      const digest = await reviewedDigest({ fx, attestationId: bId });
      seam.preflightCalls = 0;
      seam.beforeValidate = [
        (db, goalId) => {
          requestGoalApproval(db, {
            goalId,
            gate: 'final_acceptance',
            risk: 'high',
            reason: 'Unrelated approval committed during the first observation.',
            requestedBy: 'user',
            detail: { race: 'first' },
          });
        },
      ];
      const recorded = await recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest));
      expect(recorded).toMatchObject({ reused: false, status: 'approved', preflightDigest: digest });
      expect(seam.preflightCalls).toBe(2);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId, recorded.approvalId]);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'QR13b an unrelated approval committed during both observations refuses observation_changed and writes no decision (seam, %s)',
    async (objectFormat) => {
      const { fx, a, bId } = await disputedAWithAttestedB(objectFormat);
      const digest = await reviewedDigest({ fx, attestationId: bId });
      let captured: ReturnType<typeof databaseSnapshot> | null = null;
      seam.preflightCalls = 0;
      seam.beforeValidate = ['first', 'second'].map((label) => (db: Db, goalId: string) => {
        requestGoalApproval(db, {
          goalId,
          gate: 'final_acceptance',
          risk: 'high',
          reason: `Unrelated approval committed during the ${label} observation.`,
          requestedBy: 'user',
          detail: { race: label },
        });
        captured = databaseSnapshot(db);
      });
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'observation_changed' });
      expect(seam.preflightCalls).toBe(2);
      expect(databaseSnapshot(fx.db)).toEqual(captured);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'QR13c the selected B disputed during the first observation refuses on retry as attestation_disputed (seam, %s)',
    async (objectFormat) => {
      const { fx, a, bId } = await disputedAWithAttestedB(objectFormat);
      const digest = await reviewedDigest({ fx, attestationId: bId });
      let captured: ReturnType<typeof databaseSnapshot> | null = null;
      seam.preflightCalls = 0;
      seam.beforeValidate = [
        (db) => {
          appendCorrectionForTest(fx, bId, 'dispute');
          captured = databaseSnapshot(db);
        },
      ];
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest))),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_disputed' });
      expect(seam.preflightCalls).toBe(2);
      expect(databaseSnapshot(fx.db)).toEqual(captured);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 14: identical concurrent B requests give one authority, one row, one proof and one transition.
  it(
    'QR14 two simultaneous identical B decisions and two simultaneous B completions give one row, one proof and one transition (sha1)',
    async () => {
      const { fx, a, bId } = await disputedAWithAttestedB('sha1');
      const digest = await reviewedDigest({ fx, attestationId: bId });
      const records = await Promise.all([
        recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest)),
        recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest)),
      ]);
      expect(records.map((result) => result.reused).sort()).toEqual([false, true]);
      expect(new Set(records.map((result) => result.approvalId)).size).toBe(1);
      const approvalId = records[0]!.approvalId;
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId, approvalId]);

      const before = wholeState(fx);
      const approvalB = approvalRow(fx.db, approvalId);
      const completions = await Promise.all([
        completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest)),
        completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest)),
      ]);
      expect(completions.map((result) => result.reused).sort()).toEqual([false, true]);
      expect(completions[0]!.completion).toEqual(completions[1]!.completion);
      expectCompletedOnce(fx, before, approvalId, approvalB);
      expect(proofCount(fx.db, fx.goalId)).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 15: concurrent B and C never leave two eligible decisions (seam: afterPreflight, a seeded C decision).
  it(
    'QR15 B and C recorded concurrently never leave two eligible decisions (seam, true OS parallelism is not exercised)',
    async () => {
      const a = await v2RunningAttestedFixture('sha1');
      const { fx } = a;
      const bId = a.attestationId;
      const digestB = await reviewedDigest(a);
      const tipOne = a.attestation.destination.observedCommit;
      // C is attested at a second tip. Its decision is prepared at that tip, then the tip returns so B is current.
      moveTip(a);
      const c = await reattestAtCurrentTip(a);
      const cReport = await computeExternalCompletionPreflight(
        fx.db,
        fx.goalId,
        { attestationId: c.attestationId },
        { allowRecordedDecision: true },
      );
      expect(cReport.outcome).toBe('ready');
      const cAction = buildExternalCompletionAction({
        ...cReport.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: cReport.digest,
      })!;
      git(fx.repo, 'update-ref', a.handoff.target.baseRef, tipOne);

      let competing: string | null = null;
      let captured: ReturnType<typeof databaseSnapshot> | null = null;
      seam.afterPreflight = (hookDb) => {
        // C's decision commits after B's Git read and before B's decision transaction.
        competing = seedApprovedCompletion(hookDb, fx.goalId, cAction);
        captured = databaseSnapshot(hookDb);
      };
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digestB))),
      ).toEqual({ code: 'competing_decision', detail: null });
      expect(seam.afterPreflight).toBeNull();
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([competing]);
      expect(databaseSnapshot(fx.db)).toEqual(captured);
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
      const eligible = classifyCompletionAuthority(fx.db, fx.goalId, bId).entries.filter(
        (entry) => entry.eligible,
      );
      expect(eligible.map((entry) => entry.attestationId)).toEqual([c.attestationId]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 16: A and B both corrected permit an independent C, which completes.
  it.each(FORMATS)(
    'QR16 A and B both corrected permit C, and C completes with one proof (%s)',
    async (objectFormat) => {
      const { fx, a, bId, recorded: recordedB } = await disputedAThenDecidedB(objectFormat);
      const rowA = approvalRow(fx.db, a.recorded.approvalId);
      const rowB = approvalRow(fx.db, recordedB.approvalId);
      appendCorrectionForTest(fx, bId, 'withdraw');
      const c = await attestAtNewTip(a);
      const classC = classifyCompletionAuthority(fx.db, fx.goalId, c.attestationId);
      expect(classC.class).toBe(3);
      expect(classC.entries.map((entry) => [entry.attestationId, entry.eligible]).sort()).toEqual(
        [
          [a.attestationId, false],
          [bId, false],
        ].sort(),
      );
      const digestC = await reviewedDigest({ fx, attestationId: c.attestationId });
      const recordedC = await recordExternalCompletionDecision(
        fx.db,
        requestFor(fx.goalId, c.attestationId, digestC),
      );
      expect(recordedC).toMatchObject({ reused: false, status: 'approved' });
      const before = wholeState(fx);
      const approvalC = approvalRow(fx.db, recordedC.approvalId);
      await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, c.attestationId, digestC));
      expectCompletedOnce(fx, before, recordedC.approvalId, approvalC);
      expect(approvalRow(fx.db, a.recorded.approvalId)).toEqual(rowA);
      expect(approvalRow(fx.db, recordedB.approvalId)).toEqual(rowB);
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        otherAttestations: expect.arrayContaining([
          expect.objectContaining({ attestationId: a.attestationId, standing: 'disputed' }),
          expect.objectContaining({ attestationId: bId, standing: 'withdrawn' }),
        ]),
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 17: after A completes, B's record and Complete refuse. B's decision row is seeded (not creatable end to end).
  it(
    "QR17 after A completes, B's Complete refuses completion_conflict and its record refuses goal_not_running (B decision row SEEDED) (sha1)",
    async () => {
      const a = await v2RunningAttestedFixture('sha1');
      const { fx } = a;
      const digestA = await reviewedDigest(a);
      const tipOne = a.attestation.destination.observedCommit;
      // B is attested at a second tip, and its action is built while no decision exists (so the classifier allows it).
      moveTip(a);
      const b = await reattestAtCurrentTip(a);
      const bReport = await computeExternalCompletionPreflight(
        fx.db,
        fx.goalId,
        { attestationId: b.attestationId },
        { allowRecordedDecision: true },
      );
      expect(bReport.outcome).toBe('ready');
      const bAction = buildExternalCompletionAction({
        ...bReport.actionFields!,
        contentOutcomeAcknowledged: true,
        userReviewedPreflightDigest: bReport.digest,
      })!;
      git(fx.repo, 'update-ref', a.handoff.target.baseRef, tipOne);

      // A completes at its own tip. B's decision row is then seeded with the same primitives the decision service uses.
      await recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, a.attestationId, digestA));
      const completedA = await completeGoalFromExternalDecision(
        fx.db,
        requestFor(fx.goalId, a.attestationId, digestA),
      );
      expect(completedA.reused).toBe(false);
      const proofBytes = JSON.stringify(
        fx.db
          .prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid')
          .all(fx.goalId),
      );
      seedApprovedCompletion(fx.db, fx.goalId, bAction);
      const before = wholeState(fx);

      expect(
        await refusalOf(
          completeGoalFromExternalDecision(
            fx.db,
            requestFor(fx.goalId, b.attestationId, bAction.userReviewedPreflightDigest),
          ),
        ),
      ).toEqual({ code: 'completion_conflict', detail: null });
      // The record is refused by goal status first (the Goal is completed), before the class-6 check is reached.
      expect(
        await refusalOf(
          recordExternalCompletionDecision(
            fx.db,
            requestFor(fx.goalId, b.attestationId, bAction.userReviewedPreflightDigest),
          ),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'goal_not_running' });
      expect(wholeState(fx)).toEqual(before);
      expect(proofCount(fx.db, fx.goalId)).toBe(1);
      expect(
        JSON.stringify(
          fx.db
            .prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid')
            .all(fx.goalId),
        ),
      ).toBe(proofBytes);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 18: lost-response retries never duplicate the decision, the proof, or any event.
  it(
    "QR18 a lost response on B's record and Complete is recovered with no duplicate row, proof or event (sha1)",
    async () => {
      const { fx, a, bId } = await disputedAWithAttestedB('sha1');
      const digest = await reviewedDigest({ fx, attestationId: bId });
      const first = await recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest));
      const afterFirstRecord = databaseSnapshot(fx.db);
      // The first response is discarded, as if it were lost. The identical request is retried.
      const replayed = await recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, digest));
      expect(replayed).toEqual({ ...first, reused: true });
      expect(databaseSnapshot(fx.db)).toEqual(afterFirstRecord);
      expect(completionRowIds(fx.db, fx.goalId)).toEqual([a.recorded.approvalId, first.approvalId]);

      // Fixture events already include earlier state changes, so Complete is judged by the delta it adds.
      const countsBeforeComplete = eventCountsByType(fx.db, fx.goalId);
      await completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, digest));
      const countsAfterComplete = eventCountsByType(fx.db, fx.goalId);
      const afterComplete = databaseSnapshot(fx.db);
      const completionReplay = await completeGoalFromExternalDecision(
        fx.db,
        requestFor(fx.goalId, bId, digest),
      );
      expect(completionReplay.reused).toBe(true);
      expect(eventCountsByType(fx.db, fx.goalId)).toEqual(countsAfterComplete);
      expect(databaseSnapshot(fx.db)).toEqual(afterComplete);
      expect(proofCount(fx.db, fx.goalId)).toBe(1);
      expect(countsAfterComplete.external_completion_recorded).toBe(
        (countsBeforeComplete.external_completion_recorded ?? 0) + 1,
      );
      expect(countsAfterComplete.state_changed).toBe((countsBeforeComplete.state_changed ?? 0) + 1);
      expect(countsAfterComplete.approval_requested).toBeGreaterThanOrEqual(2);
      expect(countsAfterComplete.approval_decided).toBeGreaterThanOrEqual(2);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  // Case 19: wrong Goal, handoff or attestation bindings refuse, with nothing written.
  it(
    'QR19 wrong bindings refuse with exact codes and no writes: digest, attestation, Goal (sha1)',
    async () => {
      const { fx, a, bId, digest: digestB, recorded } = await disputedAThenDecidedB('sha1');
      const other = await v2RunningAttestedFixture('sha1');
      const before = wholeState(fx);
      // B's id with A's reviewed digest: the preflight of B is ready, so the digest comparison refuses.
      expect(
        await refusalOf(recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, bId, a.digest))),
      ).toEqual({ code: 'reviewed_preflight_changed', detail: null });
      // A's id with B's reviewed digest: B holds an eligible decision, so A is refused as a competing decision (class 4).
      expect(
        await refusalOf(
          recordExternalCompletionDecision(fx.db, requestFor(fx.goalId, a.attestationId, digestB)),
        ),
      ).toEqual({ code: 'competing_decision', detail: null });
      // B's id against another Goal (another database) names no attestation there.
      expect(
        await refusalOf(
          recordExternalCompletionDecision(other.fx.db, requestFor(other.fx.goalId, bId, digestB)),
        ),
      ).toEqual({ code: 'preflight_refused', detail: 'attestation_not_found' });
      // Complete with B's id and A's digest finds no decision.
      expect(
        await refusalOf(completeGoalFromExternalDecision(fx.db, requestFor(fx.goalId, bId, a.digest))),
      ).toEqual({ code: 'decision_not_found', detail: null });
      expect(wholeState(fx)).toEqual(before);
      expect(approvalRow(fx.db, recorded.approvalId)).toMatchObject({ status: 'approved' });
      expect(proofCount(fx.db, fx.goalId)).toBe(0);
      expect(wholeState(other.fx).db.counts.goal_external_completion_proofs).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
