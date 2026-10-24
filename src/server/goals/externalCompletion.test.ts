import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { writeGoalEvent } from './events.js';
import {
  completeGoalFromExternalDecision,
  EXTERNAL_COMPLETION_ERROR_CODES,
  ExternalCompletionError,
  type ExternalCompletionResult,
} from './externalCompletion.js';
import {
  parseExternalCompletionProof,
  readExternalCompletionProof,
  type ExternalCompletionProofV1,
} from './externalCompletionProof.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { createReview } from './reviews.js';
import { computeExternalCompletionPreflightWithIdentity } from './externalCompletionPreflight.js';
import { readStoredCompletion, selectCompletionDecision } from './externalCompletionTerminal.js';
import {
  databaseSnapshot,
  git,
  repositoryState,
  reviewedDigest,
  v2DecidedFixture,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { transitionGoal, type TransitionRequest } from './stateMachine.js';
import { EXTERNAL_COMPLETION_REASON, GOAL_TRANSITIONS } from '../../shared/goals.js';

/**
 * Tests of the internal version-2 completion service. Real Git (goalV2TestKit fixtures) and real SQLite with the
 * production migrations. Every refusal is asserted by its exact code and detail, never by a bare throw. Pinned details
 * were observed on the first run and are named where they are asserted.
 */

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;
type Decided = Awaited<ReturnType<typeof v2DecidedFixture>>;

interface Snapshot {
  db: ReturnType<typeof databaseSnapshot>;
  repo: unknown;
  events: GoalEventRow[];
  approval: unknown;
}

interface GoalEventRow {
  seq: number;
  id: string;
  goal_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

/** The request a user would send for one reviewed decision. */
function requestFor(decided: Decided, overrides: Record<string, unknown> = {}) {
  return {
    goalId: decided.fx.goalId,
    attestationId: decided.attestationId,
    reviewedPreflightDigest: decided.digest,
    acknowledgeContentNotProven: true,
    ...overrides,
  };
}

/** The refusal an attempt raises, by code and detail. Fails the test on success or on any other kind of error. */
async function refusal(attempt: Promise<unknown>): Promise<{ code: string; detail: string | null }> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalCompletionError) return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('the completion succeeded but a refusal was expected');
}

function goalEvents(db: Db, goalId: string): GoalEventRow[] {
  return db
    .prepare(
      'SELECT rowid AS seq, id, goal_id, type, payload_json, created_at FROM goal_events WHERE goal_id = ? ORDER BY rowid',
    )
    .all(goalId) as GoalEventRow[];
}

function goalRow(
  db: Db,
  goalId: string,
): { status: string; completed_at: string | null; status_reason_code: string | null } {
  return db
    .prepare('SELECT status, completed_at, status_reason_code FROM goals WHERE id = ?')
    .get(goalId) as { status: string; completed_at: string | null; status_reason_code: string | null };
}

function proofRows(db: Db, goalId: string): { id: string; proof_digest: string; payload_json: string }[] {
  return db
    .prepare('SELECT id, proof_digest, payload_json FROM goal_external_completion_proofs WHERE goal_id = ?')
    .all(goalId) as { id: string; proof_digest: string; payload_json: string }[];
}

function snapshotOf(fx: GoalFixture, approvalId: string | null): Snapshot {
  return {
    db: databaseSnapshot(fx.db),
    repo: repositoryState(fx.repo),
    events: goalEvents(fx.db, fx.goalId),
    approval: approvalId === null ? null : getGoalApproval(fx.db, approvalId),
  };
}

/** Nothing was written: database snapshot, events, proofs, repository state, no open transaction. */
function expectNothingWritten(fx: GoalFixture, before: Snapshot): void {
  expect(databaseSnapshot(fx.db)).toEqual(before.db);
  expect(goalEvents(fx.db, fx.goalId)).toEqual(before.events);
  expect(proofRows(fx.db, fx.goalId)).toEqual([]);
  expect(repositoryState(fx.repo)).toEqual(before.repo);
  expect(fx.db.inTransaction).toBe(false);
}

/** A refused completion of a running Goal: nothing written, and the Goal is still running and not completed. */
function expectNoCompletion(fx: GoalFixture, before: Snapshot): void {
  expectNothingWritten(fx, before);
  expect(goalRow(fx.db, fx.goalId)).toMatchObject({ status: 'running', completed_at: null });
}

/** Tables whose rows a completion is allowed to change. Every other table must keep its digest. */
const TABLES_A_COMPLETION_CHANGES = new Set([
  'goals',
  'goal_content_verifications',
  'goal_events',
  'goal_external_completion_proofs',
  'goal_runtime',
]);

/** Exactly one proof and exactly two new events, in order; the rest of the Goal's state is unchanged. */
function expectCompleted(fx: GoalFixture, before: Snapshot, approvalId: string): void {
  const proofs = proofRows(fx.db, fx.goalId);
  expect(proofs).toHaveLength(1);
  const storedProof = readExternalCompletionProof(fx.db, fx.goalId, proofs[0]!.id);
  expect(storedProof.state).toBe('valid');
  if (storedProof.state !== 'valid') throw new Error(`completion proof is ${storedProof.state}`);
  expect(storedProof.proof.contentVerificationDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(
    fx.db
      .prepare('SELECT content_verification_digest FROM goal_external_completion_proofs WHERE id = ?')
      .get(proofs[0]!.id),
  ).toEqual({ content_verification_digest: storedProof.proof.contentVerificationDigest });
  expect(
    fx.db.prepare('SELECT COUNT(*) AS n FROM goal_content_verifications WHERE goal_id = ?').get(fx.goalId),
  ).toEqual({ n: 1 });

  const after = goalEvents(fx.db, fx.goalId);
  expect(after.slice(0, before.events.length)).toEqual(before.events);
  const added = after.slice(before.events.length);
  expect(added.map((event) => event.type)).toEqual(['external_completion_recorded', 'state_changed']);

  const goal = goalRow(fx.db, fx.goalId);
  expect(goal.status).toBe('completed');
  expect(goal.status_reason_code).toBe(EXTERNAL_COMPLETION_REASON);
  const stateEvent = added[1]!;
  expect(goal.completed_at).toBe(stateEvent.created_at);
  expect(JSON.parse(stateEvent.payload_json)).toEqual({
    from: 'running',
    to: 'completed',
    reasonCode: EXTERNAL_COMPLETION_REASON,
    actor: 'user',
  });

  const afterSnapshot = databaseSnapshot(fx.db);
  for (const table of Object.keys(before.db.digests))
    if (!TABLES_A_COMPLETION_CHANGES.has(table))
      expect(afterSnapshot.digests[table], `table ${table} changed`).toBe(before.db.digests[table]);
  expect(getGoalApproval(fx.db, approvalId)).toEqual(before.approval);
  expect(repositoryState(fx.repo)).toEqual(before.repo);
  expect(fx.db.inTransaction).toBe(false);
}

/** Canonical JSON written out here, not imported, so the expected digest is independent of the production helper. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function independentProofDigest(proof: ExternalCompletionProofV1): string {
  const { proofDigest: _recorded, ...body } = proof;
  void _recorded;
  return createHash('sha256')
    .update('turing-goal-external-completion-proof-v2')
    .update('\0')
    .update(canonical(body))
    .digest('hex');
}

/** Moves the destination base ref to a commit that keeps the attested tree but drops the accepted source. */
function movedTip(decided: Decided): string {
  return git(
    decided.fx.repo,
    'commit-tree',
    decided.attestation.destination.observedTree,
    '-p',
    decided.attestation.destination.observedCommit,
    '-m',
    'destination moved after observation',
  );
}

describe('external completion service: the accepted completion', () => {
  it.each(FORMATS)(
    'completes a running Goal once from its decision and writes exactly one proof (%s)',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      const { fx } = decided;
      const before = snapshotOf(fx, decided.recorded.approvalId);

      const result = await completeGoalFromExternalDecision(fx.db, requestFor(decided));

      expect(result.reused).toBe(false);
      expect(result.completion).toMatchObject({
        state: 'completed',
        approvalId: decided.recorded.approvalId,
        actionDigest: decided.recorded.actionDigest,
        preflightDigest: decided.digest,
      });
      expectCompleted(fx, before, decided.recorded.approvalId);
      expect(readStoredCompletion(fx.db, fx.goalId)).toEqual(result.completion);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'writes a proof whose fields equal the decided action and whose digest is independent (%s)',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      const { fx } = decided;
      const approvalId = decided.recorded.approvalId;
      const approval = getGoalApproval(fx.db, approvalId);
      const action = selectCompletionDecision(fx.db, fx.goalId, approvalId).action;

      await completeGoalFromExternalDecision(fx.db, requestFor(decided));

      const [row] = proofRows(fx.db, fx.goalId);
      const read = readExternalCompletionProof(fx.db, fx.goalId, row!.id);
      expect(read.state).toBe('valid');
      if (read.state !== 'valid') return;
      const proof = read.proof;

      expect(proof).toMatchObject({
        goalId: action.goalId,
        definition: action.definition,
        handoff: action.handoff,
        attestation: action.attestation,
        repository: action.repository,
        source: action.source,
        destination: action.destination,
        correctionChain: action.correctionChain,
        userReviewedPreflightDigest: action.userReviewedPreflightDigest,
        decision: {
          approvalId,
          actionDigest: action.actionDigest,
          decidedAt: approval!.respondedAt,
          classification: 'user_confirmed_historical_external_integration',
        },
        proofLimitations: { contentPreservation: 'not_proven' },
      });
      expect(proof.gitProof).toEqual({ ...action.proof, observedAt: proof.gitProof.observedAt });
      expect(Date.parse(proof.gitProof.observedAt)).toBeGreaterThanOrEqual(
        Date.parse(approval!.respondedAt!),
      );
      expect(proof.proofDigest).toBe(independentProofDigest(proof));
      expect(row!.proof_digest).toBe(proof.proofDigest);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion service: replay and recovery', () => {
  it.each(FORMATS)(
    'returns the stored completion for an exact duplicate with no write (%s)',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      const first = await completeGoalFromExternalDecision(decided.fx.db, requestFor(decided));
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      const second = await completeGoalFromExternalDecision(decided.fx.db, requestFor(decided));

      expect(second.reused).toBe(true);
      expect(second.completion).toEqual(first.completion);
      expect(second.completion.proofId).toBe(first.completion.proofId);
      expect(second.completion.proofDigest).toBe(first.completion.proofDigest);
      expect(databaseSnapshot(decided.fx.db)).toEqual(before.db);
      expect(repositoryState(decided.fx.repo)).toEqual(before.repo);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'recovers the stored completion after a lost response (%s)',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      await completeGoalFromExternalDecision(decided.fx.db, requestFor(decided));

      const again = await completeGoalFromExternalDecision(decided.fx.db, requestFor(decided));

      expect(again.reused).toBe(true);
      const events = goalEvents(decided.fx.db, decided.fx.goalId);
      const toCompleted = events.filter(
        (event) => event.type === 'state_changed' && JSON.parse(event.payload_json).to === 'completed',
      );
      expect(toCompleted).toHaveLength(1);
      expect(events.filter((event) => event.type === 'external_completion_recorded')).toHaveLength(1);
      expect(proofRows(decided.fx.db, decided.fx.goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reads the same completed Goal after a restart on a fresh connection (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const first = await completeGoalFromExternalDecision(fx.db, requestFor(decided));
      const root = dirname(fx.repo);
      fx.db.close();

      const reopened = openDatabase(root);
      try {
        expect(readStoredCompletion(reopened, fx.goalId)).toEqual(first.completion);
        expect(goalRow(reopened, fx.goalId)).toMatchObject({ status: 'completed' });
        const [row] = proofRows(reopened, fx.goalId);
        const parsed = parseExternalCompletionProof(JSON.parse(row!.payload_json));
        expect(parsed).toMatchObject({ valid: true, digest: row!.proof_digest });
        expect(row!.proof_digest).toBe(first.completion.proofDigest);
      } finally {
        reopened.close();
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(FORMATS)(
    'lets two concurrent identical requests produce one completion and one reuse (%s)',
    async (format) => {
      const decided = await v2DecidedFixture(format);
      const { fx } = decided;
      const before = snapshotOf(fx, decided.recorded.approvalId);

      const results = await Promise.all([
        completeGoalFromExternalDecision(fx.db, requestFor(decided)),
        completeGoalFromExternalDecision(fx.db, requestFor(decided)),
      ]);

      const created = results.filter((result: ExternalCompletionResult) => !result.reused);
      const reused = results.filter((result: ExternalCompletionResult) => result.reused);
      expect(created).toHaveLength(1);
      expect(reused).toHaveLength(1);
      expect(reused[0]!.completion.proofId).toBe(created[0]!.completion.proofId);
      expect(reused[0]!.completion.proofDigest).toBe(created[0]!.completion.proofDigest);
      expectCompleted(fx, before, decided.recorded.approvalId);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion service: Git refusals, nothing written', () => {
  it(
    'refuses a source ref that moved before the call (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const moved = fx.sideCommit({ 'src/moved.txt': 'the source moved\n' });
      git(fx.repo, 'update-ref', decided.handoff.source.goalRef, moved);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // Pinned from the first run: the completion evaluation (check 8) fails before the identity check (check 9).
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'completion_not_ready',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a destination that advanced before the call and leaves the attestation unchanged (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      git(fx.repo, 'update-ref', decided.handoff.target.baseRef, movedTip(decided));
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'destination_advanced_after_observation',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a repository whose identity changed after the decision (sha1)',
    async () => {
      // The decision is recorded first (v2DecidedFixture), then the repository is re-pointed at a clone with another identity.
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const clone = join(dirname(fx.repo), 'clone');
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', fx.repo, clone]);
      git(
        clone,
        'branch',
        decided.handoff.source.goalRef.slice('refs/heads/'.length),
        decided.handoff.source.commit,
      );
      fx.db
        .prepare('UPDATE projects SET path = ?, git_root = ? WHERE id = ?')
        .run(clone, clone, fx.projectId);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'attestation_stale',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses when Git is unavailable and restores the repository for the comparison (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const beforeRepo = repositoryState(fx.repo);
      const beforeDb = databaseSnapshot(fx.db);
      const beforeEvents = goalEvents(fx.db, fx.goalId);

      const gitDir = join(fx.repo, '.git');
      const hidden = join(fx.repo, '.git-hidden');
      renameSync(gitDir, hidden);
      let outcome: { code: string; detail: string | null };
      try {
        outcome = await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)));
      } finally {
        renameSync(hidden, gitDir);
      }

      // Pinned from the first run: the completion evaluation (check 8) fails before the Git observation (check 9).
      expect(outcome).toEqual({ code: 'preflight_refused', detail: 'completion_not_ready' });
      expect(databaseSnapshot(fx.db)).toEqual(beforeDb);
      expect(goalEvents(fx.db, fx.goalId)).toEqual(beforeEvents);
      expect(repositoryState(fx.repo)).toEqual(beforeRepo);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion service: transaction faults', () => {
  const FAULTS = [
    {
      name: 'proof insert',
      trigger: 'fault_proof_insert',
      sql: "CREATE TRIGGER fault_proof_insert BEFORE INSERT ON goal_external_completion_proofs BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      detail: 'proof_insert',
    },
    {
      name: 'recorded event',
      trigger: 'fault_recorded_event',
      sql: "CREATE TRIGGER fault_recorded_event BEFORE INSERT ON goal_events WHEN NEW.type = 'external_completion_recorded' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      detail: 'recorded_event',
    },
    {
      name: 'terminal update',
      trigger: 'fault_terminal_update',
      sql: "CREATE TRIGGER fault_terminal_update BEFORE UPDATE OF status ON goals WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      detail: 'terminal_update',
    },
    {
      name: 'state event',
      trigger: 'fault_state_event',
      sql: "CREATE TRIGGER fault_state_event BEFORE INSERT ON goal_events WHEN NEW.type = 'state_changed' AND json_extract(NEW.payload_json, '$.to') = 'completed' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
      detail: 'state_event',
    },
  ] as const;

  for (const format of FORMATS)
    for (const fault of FAULTS)
      it(
        `rolls back a ${fault.name} fault and completes on retry (${format})`,
        async () => {
          const decided = await v2DecidedFixture(format);
          const { fx } = decided;
          const approvalId = decided.recorded.approvalId;
          fx.db.exec(fault.sql);
          const before = snapshotOf(fx, approvalId);

          expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
            code: 'completion_persistence_failed',
            detail: fault.detail,
          });
          expectNoCompletion(fx, before);
          expect(getGoalApproval(fx.db, approvalId)).toEqual(before.approval);

          fx.db.exec(`DROP TRIGGER ${fault.trigger};`);
          const result = await completeGoalFromExternalDecision(fx.db, requestFor(decided));
          expect(result.reused).toBe(false);
          expectCompleted(fx, before, approvalId);
        },
        REAL_GIT_TEST_TIMEOUT_MS,
      );

  for (const format of FORMATS)
    it(
      `refuses a busy database with database_busy and completes after the other writer rolls back (${format})`,
      async () => {
        const decided = await v2DecidedFixture(format);
        const { fx } = decided;
        const before = snapshotOf(fx, decided.recorded.approvalId);

        const other = new Database(fx.db.name);
        other.exec('BEGIN IMMEDIATE');
        fx.db.pragma('busy_timeout = 0');
        try {
          expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
            code: 'completion_persistence_failed',
            detail: 'database_busy',
          });
        } finally {
          other.exec('ROLLBACK');
          other.close();
        }
        expectNoCompletion(fx, before);

        const result = await completeGoalFromExternalDecision(fx.db, requestFor(decided));
        expect(result.reused).toBe(false);
        expectCompleted(fx, before, decided.recorded.approvalId);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
});

describe('external completion service: input and decision negatives', () => {
  it(
    'refuses a Goal with no decision for this attestation and digest (sha1)',
    async () => {
      const attested = await v2RunningAttestedFixture('sha1');
      const digest = await reviewedDigest(attested);
      const fx = attested.fx;
      const before = snapshotOf(fx, null);

      expect(
        await refusal(
          completeGoalFromExternalDecision(fx.db, {
            goalId: fx.goalId,
            attestationId: attested.attestationId,
            reviewedPreflightDigest: digest,
            acknowledgeContentNotProven: true,
          }),
        ),
      ).toEqual({ code: 'decision_not_found', detail: null });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a decision that belongs to another attestation (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      expect(
        await refusal(
          completeGoalFromExternalDecision(
            decided.fx.db,
            requestFor(decided, { attestationId: randomUUID() }),
          ),
        ),
      ).toEqual({ code: 'decision_not_found', detail: null });
      expectNoCompletion(decided.fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a decision for another reviewed preflight digest (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      expect(
        await refusal(
          completeGoalFromExternalDecision(
            decided.fx.db,
            requestFor(decided, { reviewedPreflightDigest: 'f'.repeat(64) }),
          ),
        ),
      ).toEqual({ code: 'decision_not_found', detail: null });
      expectNoCompletion(decided.fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an extra input key with completion_input_invalid (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      expect(
        await refusal(
          completeGoalFromExternalDecision(decided.fx.db, requestFor(decided, { actor: 'user' })),
        ),
      ).toEqual({ code: 'completion_input_invalid', detail: null });
      expectNoCompletion(decided.fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an unacknowledged request with acknowledgement_required (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      expect(
        await refusal(
          completeGoalFromExternalDecision(
            decided.fx.db,
            requestFor(decided, { acknowledgeContentNotProven: false }),
          ),
        ),
      ).toEqual({ code: 'acknowledgement_required', detail: null });
      expectNoCompletion(decided.fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to start inside an open SQLite transaction (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      decided.fx.db.exec('BEGIN');
      try {
        expect(await refusal(completeGoalFromExternalDecision(decided.fx.db, requestFor(decided)))).toEqual({
          code: 'completion_internal_state',
          detail: 'open_transaction',
        });
      } finally {
        decided.fx.db.exec('ROLLBACK');
      }
      expectNoCompletion(decided.fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a manual reconciliation Goal with preflight_refused (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      fx.db
        .prepare("UPDATE goals SET status = 'needs_user', status_reason_code = 'base_diverged' WHERE id = ?")
        .run(fx.goalId);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'manual_reconciliation_required',
      });
      expectNothingWritten(fx, before);
      expect(goalRow(fx.db, fx.goalId)).toMatchObject({ status: 'needs_user', completed_at: null });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion service: no generic transition edge', () => {
  it(
    'leaves completion unreachable from transitionGoal and keeps the service out of the transition table',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      expect(JSON.stringify(GOAL_TRANSITIONS)).not.toContain(EXTERNAL_COMPLETION_REASON);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      const user = (() => {
        try {
          transitionGoal(fx.db, {
            goalId: fx.goalId,
            to: 'completed',
            reasonCode: 'completion_verified',
            actor: 'user',
          });
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect(user).toMatchObject({ code: 'actor_not_allowed' });

      const reason = (() => {
        try {
          transitionGoal(fx.db, {
            goalId: fx.goalId,
            to: 'completed',
            reasonCode: EXTERNAL_COMPLETION_REASON as TransitionRequest['reasonCode'],
            actor: 'user',
          });
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect(reason).toMatchObject({ code: 'unknown_reason_code' });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion service: adversarial matrix', () => {
  const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  it(
    'refuses a request for a Goal that does not exist with goal_not_found and writes nothing (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const before = snapshotOf(decided.fx, decided.recorded.approvalId);

      expect(
        await refusal(
          completeGoalFromExternalDecision(decided.fx.db, requestFor(decided, { goalId: randomUUID() })),
        ),
      ).toEqual({ code: 'goal_not_found', detail: null });
      expectNothingWritten(decided.fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a Goal completed by another reason code with completion_conflict and writes nothing (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      fx.db
        .prepare(
          "UPDATE goals SET status = 'completed', completed_at = ?, status_reason_code = 'legacy_manual' WHERE id = ?",
        )
        .run(new Date().toISOString(), fx.goalId);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'completion_conflict',
        detail: null,
      });
      expect(databaseSnapshot(fx.db)).toEqual(before.db);
      expect(goalEvents(fx.db, fx.goalId)).toEqual(before.events);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['a different reviewed preflight digest', { reviewedPreflightDigest: 'e'.repeat(64) }],
    ['a different attestation', { attestationId: randomUUID() }],
  ] as const)(
    'replays a completed Goal for %s with completion_conflict and no write (sha1)',
    async (_label, overrides) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      await completeGoalFromExternalDecision(fx.db, requestFor(decided));
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided, overrides)))).toEqual({
        code: 'completion_conflict',
        detail: null,
      });
      expect(databaseSnapshot(fx.db)).toEqual(before.db);
      expect(goalEvents(fx.db, fx.goalId)).toEqual(before.events);
      expect(proofRows(fx.db, fx.goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      'a proof re-pointed to another Goal',
      (fx: GoalFixture, proofId: string) => {
        fx.db.pragma('foreign_keys = OFF');
        fx.db.pragma('ignore_check_constraints = ON');
        fx.db.exec('DROP TRIGGER trg_goal_external_completion_proof_immutable;');
        fx.db
          .prepare('UPDATE goal_external_completion_proofs SET goal_id = ? WHERE id = ?')
          .run(randomUUID(), proofId);
      },
      'proof_missing',
    ],
    [
      'a second state_changed event to completed',
      (fx: GoalFixture) => {
        writeGoalEvent(
          fx.db,
          fx.goalId,
          'state_changed',
          { from: 'running', to: 'completed', reasonCode: EXTERNAL_COMPLETION_REASON, actor: 'user' },
          new Date().toISOString(),
        );
      },
      'state_event_count',
    ],
    [
      'a completed_at that differs from the recorded event',
      (fx: GoalFixture) => {
        fx.db
          .prepare('UPDATE goals SET completed_at = ? WHERE id = ?')
          .run('2030-02-01T00:00:00.000Z', fx.goalId);
      },
      'recorded_event_mismatch',
    ],
    [
      'a completed_at that is null',
      (fx: GoalFixture) => {
        fx.db.prepare('UPDATE goals SET completed_at = NULL WHERE id = ?').run(fx.goalId);
      },
      'completed_at_missing',
    ],
  ] as const)(
    'replays a completed Goal with %s as completion_corrupt, never reused (sha1)',
    async (_label, tamper, reason) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const first = await completeGoalFromExternalDecision(fx.db, requestFor(decided));
      tamper(fx, first.completion.proofId);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'completion_corrupt',
        detail: reason,
      });
      expect(databaseSnapshot(fx.db)).toEqual(before.db);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a Goal whose completion decision row is no longer approved with decision_corrupt (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      fx.db
        .prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?")
        .run(decided.recorded.approvalId);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // The decision list reads the row's fields before the proof reader's approval check: approval_fields_invalid.
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'decision_corrupt',
        detail: 'approval_fields_invalid',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses two valid decisions for one attestation and digest with decision_corrupt multiple_decisions (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const approvalId = decided.recorded.approvalId;
      // The unique index on the completion action digest is lifted for this disposable duplicate only.
      fx.db.exec(
        'DROP INDEX idx_goal_approval_external_completion_action; DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;',
      );
      const copyId = randomUUID();
      fx.db.exec('DROP TABLE IF EXISTS temp.dup_approval;');
      fx.db
        .prepare('CREATE TEMP TABLE dup_approval AS SELECT * FROM goal_approvals WHERE id = ?')
        .run(approvalId);
      fx.db.prepare('UPDATE temp.dup_approval SET id = ?').run(copyId);
      // The insert guards are lifted for this disposable duplicate only: a copy of an approved row is otherwise refused.
      const triggers = fx.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'goal_approvals'")
        .all() as { name: string }[];
      for (const { name } of triggers) fx.db.exec(`DROP TRIGGER ${name};`);
      fx.db.exec('INSERT INTO goal_approvals SELECT * FROM temp.dup_approval;');
      fx.db.exec('DROP TABLE temp.dup_approval;');
      const before = snapshotOf(fx, approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'decision_corrupt',
        detail: 'multiple_decisions',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a Goal whose attestation approval is no longer approved with completion_history_invalid (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const attestation = fx.db
        .prepare('SELECT approval_id FROM goal_external_integration_attestations WHERE id = ?')
        .get(decided.attestationId) as { approval_id: string };
      expect(attestation.approval_id).not.toBe(decided.recorded.approvalId);
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      fx.db.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(attestation.approval_id);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // The Goal's own completion row fails the classifier (its standing read is unavailable), so check 4
      // refuses with completion_history_invalid before the attestation's standing check is reached.
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'completion_history_invalid',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      'an unrelated root commit with the attested tree',
      (decided: Decided) =>
        git(
          decided.fx.repo,
          'commit-tree',
          decided.attestation.destination.observedTree,
          '-m',
          'unrelated root',
        ),
      'destination_not_integrated',
    ],
    [
      'a child commit with a different tree',
      (decided: Decided) =>
        git(
          decided.fx.repo,
          'commit-tree',
          EMPTY_TREE_SHA1,
          '-p',
          decided.attestation.destination.observedCommit,
          '-m',
          'tree changed',
        ),
      'destination_advanced_after_observation',
    ],
  ] as const)(
    'refuses a destination moved to %s with preflight_refused and writes nothing (sha1)',
    async (_label, makeCommit, detail) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const moved = makeCommit(decided);
      git(fx.repo, 'update-ref', decided.attestation.destination.ref, moved);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail,
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses the tenth of ten concurrent requests with completion_busy and completes the other nine (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;

      const settled = await Promise.allSettled(
        Array.from({ length: 10 }, () => completeGoalFromExternalDecision(fx.db, requestFor(decided))),
      );

      const rejected = settled.filter((outcome) => outcome.status === 'rejected');
      const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'completion_busy', detail: null });
      expect(fulfilled).toHaveLength(9);
      expect(fulfilled.filter((outcome) => !outcome.value.reused)).toHaveLength(1);
      expect(fulfilled.filter((outcome) => outcome.value.reused)).toHaveLength(8);
      expect(proofRows(fx.db, fx.goalId)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a failed active-work read as completion_read_failed and writes nothing (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      fx.db.pragma('foreign_keys = OFF');
      fx.db.exec('DROP VIEW goal_runs;');
      fx.db.pragma('foreign_keys = ON');
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'completion_read_failed',
        detail: 'active_work',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails a replay read closed as completion_corrupt, never completed, and writes nothing (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      fx.db.pragma('foreign_keys = OFF');
      fx.db.exec('DROP TABLE goal_external_completion_proofs;');
      fx.db.pragma('foreign_keys = ON');
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // The terminal read reports a failed read as an invalid state, so the replay check fails closed (observed). It is
      // not reported as completion_read_failed, which the planned matrix predicted. The proofs table is gone, so the
      // check reads the Goal row and the database snapshot directly.
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'completion_corrupt',
        detail: 'integrity_check_failed',
      });
      expect(databaseSnapshot(fx.db)).toEqual(before.db);
      expect(goalEvents(fx.db, fx.goalId)).toEqual(before.events);
      expect(goalRow(fx.db, fx.goalId)).toMatchObject({ status: 'running', completed_at: null });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('keeps every code the service throws in its declared list and every declared code in its messages', () => {
    const source = readFileSync(fileURLToPath(new URL('./externalCompletion.ts', import.meta.url)), 'utf8');
    const thrown = [...source.matchAll(/new ExternalCompletionError\(\s*'([a-z_]+)'/g)].map(
      (match) => match[1]!,
    );
    const declared = new Set<string>(EXTERNAL_COMPLETION_ERROR_CODES);
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown.filter((code) => !declared.has(code))).toEqual([]);
    const messageMapStart = source.indexOf('const MESSAGES:');
    const messageMapEnd = source.indexOf('\n};', messageMapStart);
    expect(messageMapStart).toBeGreaterThan(-1);
    expect(messageMapEnd).toBeGreaterThan(messageMapStart);
    const messageMap = source.slice(messageMapStart, messageMapEnd);
    const messageKeys = [...messageMap.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]!);
    expect(EXTERNAL_COMPLETION_ERROR_CODES.filter((code) => !messageKeys.includes(code))).toEqual([]);
  });
});

describe('external completion service: lineage, attestation approval and base history tampers', () => {
  /** The stored detail of one approval row, read raw so the test does not depend on a production parser. */
  function rawApprovalDetail(fx: GoalFixture, approvalId: string): Record<string, unknown> {
    const row = fx.db.prepare('SELECT detail_json FROM goal_approvals WHERE id = ?').get(approvalId) as {
      detail_json: string;
    };
    return JSON.parse(row.detail_json) as Record<string, unknown>;
  }

  /** The preflight's own first reason, with the decision bypass the service itself uses. Read-only. */
  async function preflightReason(fx: GoalFixture, attestationId: string) {
    const { report } = await computeExternalCompletionPreflightWithIdentity(
      fx.db,
      fx.goalId,
      { attestationId },
      { allowRecordedDecision: true },
    );
    return report.outcome === 'ready' ? null : (report.reasons[0] ?? null);
  }

  it(
    'refuses a decision whose stored definition lineage digest was tampered, with nothing written (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const approvalId = decided.recorded.approvalId;
      const detail = rawApprovalDetail(fx, approvalId);
      const definition = detail.definition as { lineageDigest: string };
      expect(definition.lineageDigest).toMatch(/^[0-9a-f]{64}$/);
      // Only the disposable decision row is changed: its identity and terminal guards are lifted for this one UPDATE.
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      fx.db
        .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
        .run(
          JSON.stringify({ ...detail, definition: { ...definition, lineageDigest: 'f'.repeat(64) } }),
          approvalId,
        );
      const before = snapshotOf(fx, approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'decision_corrupt',
        detail: 'digest_mismatch',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['gate', 'gate', 'user_confirmation'],
    ['risk', 'risk', 'medium'],
    ['requestedBy', 'requested_by', 'system'],
    ['respondedAt', 'responded_at', '2020-01-01T00:00:00.000Z'],
  ] as const)(
    'refuses an attestation approval whose %s was tampered, with nothing written (sha1)',
    async (_label, column, value) => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      // The attestation's own approval is the final_apply row. Its identity and terminal guards are lifted for this UPDATE.
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      fx.db.prepare(`UPDATE goal_approvals SET ${column} = ? WHERE id = ?`).run(value, decided.approval.id);
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // The approval no longer matches the attestation, so the Goal's own completion row fails the classifier at
      // check 4. The reason's detail is the classifier's integrity code, and the Git observation is never reached.
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'completion_history_invalid',
      });
      expect(await preflightReason(fx, decided.attestationId)).toEqual({
        code: 'completion_history_invalid',
        detail: 'correction_standing_unavailable',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an attestation whose recorded base tree was tampered, with nothing written (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      const stored = fx.db
        .prepare('SELECT payload_json FROM goal_external_integration_attestations WHERE id = ?')
        .get(decided.attestationId) as { payload_json: string };
      const payload = JSON.parse(stored.payload_json) as { destination: { expectedBaseTree: string } };
      expect(payload.destination.expectedBaseTree).toMatch(/^[0-9a-f]{40}$/);
      // The migration CHECK ties the indexed column to the payload, so the column is changed in the same disposable UPDATE.
      fx.db.exec('DROP TRIGGER trg_goal_external_attestation_immutable;');
      fx.db
        .prepare(
          'UPDATE goal_external_integration_attestations SET payload_json = ?, expected_base_tree = ? WHERE id = ?',
        )
        .run(
          JSON.stringify({
            ...payload,
            destination: { ...payload.destination, expectedBaseTree: '1'.repeat(40) },
          }),
          '1'.repeat(40),
          decided.attestationId,
        );
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // The Goal's own completion row is class 5 (its attestation cannot be read), so check 4 refuses first.
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'completion_history_invalid',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a decided Goal whose required criterion is no longer met at the source head, with completion_not_ready (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      // A real Git change, not a seam: the deliverable is deleted on the Goal's source ref after the decision. A
      // file_exists criterion cannot be contradicted by evidence (evidence_kind_mismatch), so the head itself is changed.
      fx.advance({ 'src/result.txt': null }, 'remove the deliverable after the decision');
      const criterion = (await evaluateCompletion(fx.db, fx.goalId)).criteria.find(
        (entry) => entry.key === 'deliverable',
      );
      // Pinned from the first run: the artifact evidence is bound to the previous tree, so the required criterion is stale.
      expect(criterion).toMatchObject({ key: 'deliverable', required: true, state: 'stale' });
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'completion_not_ready',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a pending final review that exists before the call with preflight_refused pending_review (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      await createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' });
      const before = snapshotOf(fx, decided.recorded.approvalId);

      // The service's own pre-check (before any preflight or Git) refuses the open review, so the preflight never runs.
      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'pending_review',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a base ref rewritten to an unrelated history as not integrated, with nothing written (sha1)',
    async () => {
      const decided = await v2DecidedFixture('sha1');
      const { fx } = decided;
      git(fx.repo, 'update-ref', decided.attestation.destination.ref, fx.orphanCommit());
      const before = snapshotOf(fx, decided.recorded.approvalId);

      expect(await refusal(completeGoalFromExternalDecision(fx.db, requestFor(decided)))).toEqual({
        code: 'preflight_refused',
        detail: 'destination_not_integrated',
      });
      expect(await preflightReason(fx, decided.attestationId)).toEqual({
        code: 'destination_not_integrated',
        detail: 'base_not_ancestor',
      });
      expectNoCompletion(fx, before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion service: exports', () => {
  it('exports only the service, its error class and its code list', async () => {
    const service = await import('./externalCompletion.js');
    expect(Object.keys(service).sort()).toEqual([
      'EXTERNAL_COMPLETION_ERROR_CODES',
      'ExternalCompletionError',
      'completeGoalFromExternalDecision',
    ]);
  });
});
