import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { activeWorkBlocker } from './activeWork.js';
import { getGoalApproval } from './approvals.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { createCycle, finalizeCycle } from './cycles.js';
import { writeGoalEvent } from './events.js';
import {
  PreflightRefusal,
  readPreflightSnapshotIdentity,
  type SnapshotIdentity,
} from './externalCompletionPreflight.js';
import {
  consumeExternalCompletionDecision,
  EXTERNAL_COMPLETION_TERMINAL_ERROR_CODES,
  ExternalCompletionTerminalError,
  externalCompletionProofRowCount,
  readStoredCompletion,
  selectCompletionDecision,
  type ValidatedCompletionDecision,
} from './externalCompletionTerminal.js';
import type { ExternalCompletionProofV1 } from './externalCompletionProof.js';
import { buildManualHandoffSnapshot } from './manualHandoff.js';
import { createGoalDraft } from './definitions.js';
import { completionProofForDecision, databaseSnapshot, v2DecidedFixture } from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS, simpleDefinition } from './repoKit.js';
import { createReview } from './reviews.js';
import { GoalStateError, transitionGoal, type TransitionRequest } from './stateMachine.js';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';

/**
 * Tests of the proof-bound terminal authority. Every fixture is real SQLite with the production migrations; the only
 * changes to the database are the explicit trigger drops and raw row edits named in each test. Refusals are asserted by
 * their exact code and detail, never by a bare throw.
 */

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;
const OBSERVED_AT = '2026-10-11T09:00:00.000Z';
// Later than the real decision time that the fixture records (the consumer refuses a `now` before the decision), and
// canonical. The decision is recorded at the wall clock, so a fixed earlier instant would be refused.
const NOW = '2030-01-01T00:00:00.000Z';

type Proof = ExternalCompletionProofV1;

/** A running, attested Goal whose user decision is recorded, plus the proof and identity a caller would hold. */
async function decided(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const attested = await v2DecidedFixture(objectFormat);
  const { db, goalId } = attested.fx;
  const decision = selectCompletionDecision(db, goalId, attested.recorded.approvalId);
  const proof = completionProofForDecision(decision, OBSERVED_AT);
  const expected = readPreflightSnapshotIdentity(db, goalId, attested.attestationId, {
    allowRecordedDecision: true,
  });
  return {
    fx: attested.fx,
    db,
    goalId,
    attestationId: attested.attestationId,
    approvalId: attested.recorded.approvalId,
    decision,
    proof,
    expected,
  };
}

/** Consumes inside the production shape: the caller owns one BEGIN IMMEDIATE transaction around the consumer. */
function consumeInTransaction(
  db: Db,
  decision: ValidatedCompletionDecision,
  proof: Proof,
  expected: SnapshotIdentity,
) {
  return db
    .transaction(() => consumeExternalCompletionDecision(db, decision, proof, expected, NOW))
    .immediate();
}

/** The terminal error an attempt raises. Fails the test when the attempt succeeds or raises something else. */
function refusal(attempt: () => unknown): ExternalCompletionTerminalError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof ExternalCompletionTerminalError) return error;
    throw error;
  }
  throw new Error('the call succeeded but a refusal was expected');
}

/** The preflight refusal an identity read raises. Fails the test when the read succeeds or raises something else. */
function preflightRefusal(attempt: () => unknown): PreflightRefusal {
  try {
    attempt();
  } catch (error) {
    if (error instanceof PreflightRefusal) return error;
    throw error;
  }
  throw new Error('the identity read succeeded but a refusal was expected');
}

function stateRefusal(attempt: () => unknown): GoalStateError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof GoalStateError) return error;
    throw error;
  }
  throw new Error('the transition succeeded but a refusal was expected');
}

async function manualHandoffRefusal(db: Db, goalId: string): Promise<unknown> {
  try {
    await buildManualHandoffSnapshot(db, goalId);
  } catch (error) {
    return error;
  }
  throw new Error('the manual handoff snapshot was built but a refusal was expected');
}

function goalStatus(db: Db, goalId: string): unknown {
  return db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId);
}

function proofCount(db: Db, goalId: string): unknown {
  return db
    .prepare('SELECT COUNT(*) AS n FROM goal_external_completion_proofs WHERE goal_id = ?')
    .get(goalId);
}

describe('external completion terminal: the accepted terminal write', () => {
  it('exports only the consumer, the decision selector, the stored reader, the read-only proof count and the error type', async () => {
    const terminal = await import('./externalCompletionTerminal.js');
    expect(Object.keys(terminal).sort()).toEqual([
      'EXTERNAL_COMPLETION_TERMINAL_ERROR_CODES',
      'ExternalCompletionTerminalError',
      'consumeExternalCompletionDecision',
      'externalCompletionProofRowCount',
      'readStoredCompletion',
      'selectCompletionDecision',
    ]);
    expect([...EXTERNAL_COMPLETION_TERMINAL_ERROR_CODES]).toEqual([
      'completion_proof_required',
      'completion_internal_state',
      'goal_not_found',
      'goal_not_running',
      'completion_already_recorded',
      'decision_not_found',
      'decision_corrupt',
      'decision_conflict',
      'proof_invalid',
      'proof_action_mismatch',
      'authority_changed_during_completion',
      'goal_work_in_flight',
      'completion_persistence_failed',
    ]);
  });

  it.each(FORMATS)(
    'writes one proof, the recorded event and the completed status, once, under %s',
    async (objectFormat) => {
      const { db, goalId, decision, proof, expected } = await decided(objectFormat);
      const result = consumeInTransaction(db, decision, proof, expected);

      expect(result).toEqual({ from: 'running', to: 'completed', proofId: expect.any(String) });
      expect(readStoredCompletion(db, goalId)).toEqual({
        state: 'completed',
        proofId: result.proofId,
        proofDigest: proof.proofDigest,
        approvalId: decision.approval.id,
        actionDigest: decision.action.actionDigest,
        preflightDigest: proof.userReviewedPreflightDigest,
        observedAt: OBSERVED_AT,
        completedAt: NOW,
      });
      expect(
        db
          .prepare(
            'SELECT status, status_reason_code AS reason, completed_at AS completedAt FROM goals WHERE id = ?',
          )
          .get(goalId),
      ).toEqual({ status: 'completed', reason: 'external_completion_user_confirmed', completedAt: NOW });
      expect(
        db
          .prepare(
            `SELECT type, created_at AS createdAt FROM goal_events
             WHERE goal_id = ? AND (type = 'external_completion_recorded'
               OR (type = 'state_changed' AND json_extract(payload_json, '$.to') = 'completed'))
             ORDER BY rowid`,
          )
          .all(goalId),
      ).toEqual([
        { type: 'external_completion_recorded', createdAt: NOW },
        { type: 'state_changed', createdAt: NOW },
      ]);
      expect(proofCount(db, goalId)).toEqual({ n: 1 });
      // The completed state is final: no ordinary transition leaves it.
      expect(
        stateRefusal(() =>
          transitionGoal(db, { goalId, to: 'running', reasonCode: 'user_start', actor: 'user' }),
        ),
      ).toMatchObject({ code: 'terminal_state' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a second proof for the same Goal with completion_already_recorded',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      consumeInTransaction(db, decision, proof, expected);
      // A raw reset puts the Goal back to running while its proof row remains, the state a second consumer must refuse.
      db.prepare(
        "UPDATE goals SET status = 'running', status_reason_code = NULL, status_detail_json = NULL, completed_at = NULL WHERE id = ?",
      ).run(goalId);
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'completion_already_recorded',
        detail: null,
      });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

const WRITE_FAILURES = [
  [
    'proof_insert',
    'trg_test_fail_proof',
    "CREATE TRIGGER trg_test_fail_proof BEFORE INSERT ON goal_external_completion_proofs BEGIN SELECT RAISE(ABORT, 'injected proof failure'); END;",
  ],
  [
    'recorded_event',
    'trg_test_fail_recorded',
    "CREATE TRIGGER trg_test_fail_recorded BEFORE INSERT ON goal_events WHEN NEW.type = 'external_completion_recorded' BEGIN SELECT RAISE(ABORT, 'injected recorded failure'); END;",
  ],
  [
    'terminal_update',
    'trg_test_fail_terminal',
    "CREATE TRIGGER trg_test_fail_terminal BEFORE UPDATE ON goals WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;",
  ],
  [
    'state_event',
    'trg_test_fail_state',
    "CREATE TRIGGER trg_test_fail_state BEFORE INSERT ON goal_events WHEN NEW.type = 'state_changed' BEGIN SELECT RAISE(ABORT, 'injected state failure'); END;",
  ],
] as const;

describe('external completion terminal: T-TX1 a failed write rolls back every write', () => {
  it.each(WRITE_FAILURES)(
    'T-TX1 rolls back the proof, both events and the status when the %s step fails',
    async (step, trigger, createTrigger) => {
      const { db, goalId, decision, proof, expected } = await decided();
      const before = databaseSnapshot(db);
      db.exec(createTrigger);

      const error = refusal(() => consumeInTransaction(db, decision, proof, expected));
      db.exec(`DROP TRIGGER ${trigger};`);

      expect(error).toMatchObject({ code: 'completion_persistence_failed', detail: step });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
      expect(proofCount(db, goalId)).toEqual({ n: 0 });
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'not_completed' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: T-TX2 a stored completion that no longer matches fails closed', () => {
  const TAMPERS = [
    [
      'recorded event removed',
      (db: Db, goalId: string) => {
        db.exec('DROP TRIGGER trg_goal_event_no_delete;');
        db.prepare("DELETE FROM goal_events WHERE goal_id = ? AND type = 'external_completion_recorded'").run(
          goalId,
        );
      },
      'recorded_event_count',
    ],
    [
      'status detail rewritten',
      (db: Db, goalId: string) => {
        db.prepare("UPDATE goals SET status_detail_json = '{}' WHERE id = ?").run(goalId);
      },
      'status_detail_mismatch',
    ],
    [
      'reason code rewritten',
      (db: Db, goalId: string) => {
        db.prepare("UPDATE goals SET status_reason_code = 'completion_verified' WHERE id = ?").run(goalId);
      },
      'reason_code_mismatch',
    ],
  ] as const;

  it.each(TAMPERS)(
    'T-TX2 reads %s as invalid and refuses replay with goal_not_running',
    async (_label, tamper, reason) => {
      const { db, goalId, decision, proof, expected } = await decided();
      consumeInTransaction(db, decision, proof, expected);
      expect(readStoredCompletion(db, goalId)).toMatchObject({ state: 'completed' });

      tamper(db, goalId);
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'invalid', reason });

      const replayDecision = selectCompletionDecision(db, goalId, decision.approval.id);
      const before = databaseSnapshot(db);
      expect(refusal(() => consumeInTransaction(db, replayDecision, proof, expected))).toMatchObject({
        code: 'goal_not_running',
        detail: 'completed',
      });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: T-TX3 the bypass table (transitionGoal cannot reach completed)', () => {
  // actor, reason (cast where the type forbids it), proof kind, pinned code. `real` is a real evaluateCompletion result.
  const BYPASS_ROWS = [
    ['user', 'completion_verified', 'none', 'actor_not_allowed'],
    ['user', 'external_completion_user_confirmed', 'none', 'unknown_reason_code'],
    ['user', 'external_completion_user_confirmed', 'real', 'unknown_reason_code'],
    ['supervisor', 'completion_verified', 'none', 'completion_proof_required'],
    ['supervisor', 'completion_verified', 'real', 'external_completion_not_activated'],
    ['system', 'completion_verified', 'none', 'actor_not_allowed'],
    ['system', 'completion_verified', 'real', 'actor_not_allowed'],
    ['supervisor', 'external_completion_user_confirmed', 'none', 'unknown_reason_code'],
    ['supervisor', 'external_completion_user_confirmed', 'real', 'unknown_reason_code'],
  ] as const;

  it.each(BYPASS_ROWS)(
    'T-TX3 refuses actor %s, reason %s, proof %s with %s and writes nothing',
    async (actor, reason, proofKind, code) => {
      const { db, goalId } = await decided();
      const completionProof = proofKind === 'real' ? await evaluateCompletion(db, goalId) : undefined;
      const before = databaseSnapshot(db);
      const request = {
        goalId,
        to: 'completed',
        reasonCode: reason,
        actor,
        completionProof,
      } as unknown as TransitionRequest;

      expect(stateRefusal(() => transitionGoal(db, request))).toMatchObject({ code });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
      expect(proofCount(db, goalId)).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: T-TX4 an approval that changes inside the transaction', () => {
  // Slice 2a: a denied decision row is class 5, so the terminal's own identity read refuses before the approval status
  // is checked. The refusal therefore names completion_history_invalid, not approval_status. A snapshot captured after
  // the change cannot be read at all, so both variants consume with the identity captured before the change.
  it.each([
    ['captured before the change', 'before'],
    ['captured after the change', 'after'],
  ] as const)(
    'T-TX4 refuses the consume with completion_history_invalid when the approval was %s',
    async (_label, when) => {
      const { db, goalId, attestationId, approvalId, decision, proof, expected: captured } = await decided();
      db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      db.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(approvalId);
      expect(getGoalApproval(db, approvalId)).toMatchObject({ status: 'denied' });
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, captured))).toMatchObject({
        code: 'authority_changed_during_completion',
        detail: 'completion_history_invalid',
      });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'not_completed' });
      if (when === 'after')
        expect(
          preflightRefusal(() =>
            readPreflightSnapshotIdentity(db, goalId, attestationId, { allowRecordedDecision: true }),
          ),
        ).toMatchObject({ code: 'completion_history_invalid' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: forgery, transaction and proof refusals', () => {
  it(
    'refuses a decision that selectCompletionDecision did not issue, even as an exact copy',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      const before = databaseSnapshot(db);
      const copy = { approval: decision.approval, action: decision.action };
      const frozenCopy = Object.freeze({ ...decision });

      for (const forged of [copy, frozenCopy]) {
        expect(refusal(() => consumeInTransaction(db, forged, proof, expected))).toMatchObject({
          code: 'completion_proof_required',
          detail: null,
        });
      }
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a valid decision consumed outside an open transaction with completion_internal_state',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      const before = databaseSnapshot(db);

      expect(
        refusal(() => consumeExternalCompletionDecision(db, decision, proof, expected, NOW)),
      ).toMatchObject({ code: 'completion_internal_state', detail: null });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a selection for an approval the Goal does not hold with decision_not_found',
    async () => {
      const { db, goalId } = await decided();
      const before = databaseSnapshot(db);

      expect(refusal(() => selectCompletionDecision(db, goalId, randomUUID()))).toMatchObject({
        code: 'decision_not_found',
        detail: null,
      });
      expect(databaseSnapshot(db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a proof whose digest was edited after it was built with proof_invalid',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      const before = databaseSnapshot(db);

      expect(
        refusal(() =>
          consumeInTransaction(db, decision, { ...proof, proofDigest: '0'.repeat(64) }, expected),
        ),
      ).toMatchObject({ code: 'proof_invalid' });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  const MISMATCHES = [
    [
      'decision',
      'a proof built for a different approval',
      (decision: ValidatedCompletionDecision) =>
        completionProofForDecision(
          { approval: { ...decision.approval, id: randomUUID() }, action: decision.action },
          OBSERVED_AT,
        ),
    ],
    [
      'preflight_digest',
      'a proof built for a different reviewed preflight',
      (decision: ValidatedCompletionDecision) =>
        completionProofForDecision(
          {
            approval: decision.approval,
            action: { ...decision.action, userReviewedPreflightDigest: '0'.repeat(64) },
          },
          OBSERVED_AT,
        ),
    ],
    [
      'destination',
      'a proof built for a different observed destination commit',
      (decision: ValidatedCompletionDecision) =>
        completionProofForDecision(
          {
            approval: decision.approval,
            action: {
              ...decision.action,
              destination: {
                ...decision.action.destination,
                observedCommit: 'a'.repeat(decision.action.destination.observedCommit.length),
              },
            },
          },
          OBSERVED_AT,
        ),
    ],
  ] as const;

  it.each(MISMATCHES)(
    'refuses %s mismatches (%s) with proof_action_mismatch',
    async (detail, _label, build) => {
      const { db, goalId, decision, expected } = await decided();
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, build(decision), expected))).toMatchObject({
        code: 'proof_action_mismatch',
        detail,
      });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: active work refuses the terminal write (shared predicate)', () => {
  type Fx = Awaited<ReturnType<typeof decided>>['fx'];

  /** Seeds one blocker on a decided Goal, after its preflight identity was captured. */
  const BLOCKERS = [
    [
      'active_work',
      'an active execution cycle',
      (fx: Fx) => {
        createCycle(fx.db, {
          goalId: fx.goalId,
          kind: 'verification',
          triggerCode: 'handoff_test',
          milestoneKey: 'm1',
        });
      },
    ],
    [
      'active_work',
      'a non-terminal run under a finished cycle',
      (fx: Fx) => {
        createCycle(fx.db, {
          goalId: fx.goalId,
          kind: 'verification',
          triggerCode: 'handoff_test',
          milestoneKey: 'm1',
        });
        const cycle = fx.db.prepare('SELECT id FROM goal_cycles WHERE goal_id = ?').get(fx.goalId) as {
          id: string;
        };
        finalizeCycle(fx.db, { cycleId: cycle.id, to: 'cancelled', outcomeCode: 'handoff_test' });
        // Foreign keys are off for this raw insert, as the route-resolution tests do: only the goal link matters here.
        fx.db.pragma('foreign_keys = OFF');
        fx.db
          .prepare(
            `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, goal_cycle_id, goal_run_purpose)
           VALUES ('terminal-open-run', 'machine', 'project', 'quick-fix', '{}', 'test', 'balanced', 'supervised', 'running', ?, ?, 'execution')`,
          )
          .run(new Date().toISOString(), cycle.id);
        fx.db.pragma('foreign_keys = ON');
      },
    ],
    [
      'pending_review',
      'a pending final review',
      async (fx: Fx) => {
        await createReview(fx.db, { goalId: fx.goalId, definitionVersion: 1, reviewKind: 'final' });
      },
    ],
    [
      'integration_operation_in_progress',
      'a planned integration operation',
      (fx: Fx) => {
        fx.db
          .prepare(
            `INSERT INTO goal_integration_ops (id, goal_id, op, new_commit, status, checks_json, created_at)
           VALUES ('terminal-planned-op', ?, 'init_ref', ?, 'planned', '{}', ?)`,
          )
          .run(fx.goalId, fx.head(), new Date().toISOString());
      },
    ],
    [
      'manual_reconciliation_required',
      'a failed apply_to_base operation',
      (fx: Fx, sourceCommit: string) => {
        // A corruption-style fixture: the apply insert guard is bypassed only to model an uncertain earlier operation.
        fx.db.exec('DROP TRIGGER trg_goal_integration_op_apply_approval_insert;');
        fx.db
          .prepare(
            `INSERT INTO goal_integration_ops
           (id, goal_id, op, expected_old, new_commit, status, checks_json, created_at, approval_id)
           VALUES ('terminal-uncertain-apply', ?, 'apply_to_base', ?, ?, 'planned', '{}', ?, NULL)`,
          )
          .run(fx.goalId, fx.baseCommit, sourceCommit, new Date().toISOString());
        fx.db
          .prepare(
            `UPDATE goal_integration_ops SET status = 'failed', error_code = 'manual_reconciliation_required', finished_at = ?
           WHERE id = 'terminal-uncertain-apply'`,
          )
          .run(new Date().toISOString());
      },
    ],
  ] as const;

  it.each(BLOCKERS)(
    'refuses with goal_work_in_flight (%s) when the Goal has %s, matching ensureNoActiveWork',
    async (blocker, _label, seed) => {
      // The identity is captured after the work exists, so the shared predicate is the check that refuses.
      const { fx, db, goalId, attestationId, decision, proof } = await decided();
      await seed(fx, decision.action.source.commit);
      const expected = readPreflightSnapshotIdentity(db, goalId, attestationId, {
        allowRecordedDecision: true,
      });
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'goal_work_in_flight',
        detail: blocker,
      });
      expect(activeWorkBlocker(db, goalId)).toBe(blocker);
      expect(await manualHandoffRefusal(db, goalId)).toMatchObject({ code: blocker });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each(BLOCKERS)(
    'refuses work (%s, %s) that appears after the identity was captured, through the identity check first',
    async (_blocker, _label, seed) => {
      // The preflight identity covers the handoff fingerprint, which changes with live work. The consumer's identity
      // comparison therefore refuses first, before the predicate runs.
      const { fx, db, goalId, decision, proof, expected } = await decided();
      await seed(fx, decision.action.source.commit);
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'authority_changed_during_completion',
        detail: 'handoff_fingerprint',
      });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: F1 a stored completion that is tampered reads as invalid, never completed', () => {
  const TAMPERS: [string, (db: Db, goalId: string, proofId: string, approvalId: string) => void, string][] = [
    [
      'a proof re-pointed to another Goal',
      (db, _goalId, proofId) => {
        // The migration CHECK ties goal_id to the payload's goalId, so it is lifted for this disposable row only.
        db.pragma('foreign_keys = OFF');
        db.pragma('ignore_check_constraints = ON');
        db.exec('DROP TRIGGER trg_goal_external_completion_proof_immutable;');
        db.prepare('UPDATE goal_external_completion_proofs SET goal_id = ? WHERE id = ?').run(
          randomUUID(),
          proofId,
        );
      },
      'proof_missing',
    ],
    [
      'a second state_changed event to completed',
      (db, goalId) => {
        writeGoalEvent(
          db,
          goalId,
          'state_changed',
          { from: 'running', to: 'completed', reasonCode: EXTERNAL_COMPLETION_REASON, actor: 'user' },
          NOW,
        );
      },
      'state_event_count',
    ],
    [
      'a completed_at that differs from the recorded event',
      (db, goalId) => {
        db.prepare('UPDATE goals SET completed_at = ? WHERE id = ?').run('2030-02-01T00:00:00.000Z', goalId);
      },
      'recorded_event_mismatch',
    ],
    [
      'a completed_at that is null',
      (db, goalId) => {
        db.prepare('UPDATE goals SET completed_at = NULL WHERE id = ?').run(goalId);
      },
      'completed_at_missing',
    ],
    [
      'a decision row that is no longer approved',
      (db, _goalId, _proofId, approvalId) => {
        db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
        db.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(approvalId);
      },
      // The proof reader checks the completion approval row before readStoredCompletion reaches its decision check.
      'completion_approval_mismatch',
    ],
  ];

  it.each(TAMPERS)(
    'F1 reads %s as invalid, never completed',
    async (_label, tamper, reason) => {
      const { db, goalId, decision, proof, expected } = await decided();
      const result = consumeInTransaction(db, decision, proof, expected);
      expect(readStoredCompletion(db, goalId)).toMatchObject({ state: 'completed', proofId: result.proofId });

      tamper(db, goalId, result.proofId, decision.approval.id);
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'invalid', reason });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: F2 the proof is compared with the stored action, not the held copy', () => {
  it.each([
    [
      'a destination edited in memory',
      (decision: ValidatedCompletionDecision) => {
        (decision.action.destination as { observedCommit: string }).observedCommit = 'a'.repeat(
          decision.action.destination.observedCommit.length,
        );
      },
      { code: 'proof_action_mismatch', detail: 'destination' },
    ],
    [
      'an action digest edited in memory',
      (decision: ValidatedCompletionDecision) => {
        (decision.action as { actionDigest: string }).actionDigest = '1'.repeat(64);
      },
      { code: 'authority_changed_during_completion', detail: 'action_digest' },
    ],
  ] as const)(
    'F2 refuses a held decision with %s, builds the proof from that copy, and writes nothing',
    async (_label, edit, expectedRefusal) => {
      const { db, goalId, decision, expected } = await decided();
      edit(decision);
      // The proof is built from the edited copy, so only a comparison with the stored action can refuse it.
      const proof = completionProofForDecision(decision, OBSERVED_AT);
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject(
        expectedRefusal,
      );
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'not_completed' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: F3 timestamps are canonical and ordered', () => {
  it(
    'F3 refuses a non-canonical now with completion_internal_state and writes nothing',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      const before = databaseSnapshot(db);

      expect(
        refusal(() =>
          db
            .transaction(() =>
              consumeExternalCompletionDecision(db, decision, proof, expected, '2030-01-01T00:00:00Z'),
            )
            .immediate(),
        ),
      ).toMatchObject({ code: 'completion_internal_state', detail: 'clock_not_canonical' });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'F3 refuses a now before the stored decision with completion_internal_state',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      const before = databaseSnapshot(db);
      const beforeDecision = new Date(Date.parse(decision.approval.respondedAt!) - 1000).toISOString();

      expect(
        refusal(() =>
          db
            .transaction(() =>
              consumeExternalCompletionDecision(db, decision, proof, expected, beforeDecision),
            )
            .immediate(),
        ),
      ).toMatchObject({ code: 'completion_internal_state', detail: 'clock_before_decision' });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'F3 refuses a now before the observation the proof records with completion_internal_state',
    async () => {
      const { db, goalId, decision, expected } = await decided();
      const proof = completionProofForDecision(decision, '2030-06-01T00:00:00.000Z');
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'completion_internal_state',
        detail: 'clock_before_observation',
      });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    ['a decided time that differs from the stored decision', '2026-10-11T09:00:00.000Z'],
    ['a decided time that is not canonical', null],
  ] as const)(
    'F3 refuses a proof with %s with proof_action_mismatch/decided_at',
    async (_label, replacement) => {
      const { db, goalId, decision, expected } = await decided();
      const decidedAt = replacement ?? decision.approval.respondedAt!.replace(/\.(\d{3})Z$/, 'Z');
      const proof = completionProofForDecision(
        { approval: { ...decision.approval, respondedAt: decidedAt }, action: decision.action },
        OBSERVED_AT,
      );
      const before = databaseSnapshot(db);

      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'proof_action_mismatch',
        detail: 'decided_at',
      });
      expect(databaseSnapshot(db)).toEqual(before);
      expect(goalStatus(db, goalId)).toEqual({ status: 'running' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion terminal: the read-only proof row count', () => {
  it('counts zero proof rows for any Goal in a fresh database with no completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'tt-proof-count-'));
    const db = openDatabase(root);
    try {
      expect(externalCompletionProofRowCount(db, randomUUID())).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    'counts exactly one proof row for a Goal with one completed external completion',
    async () => {
      const { db, goalId, decision, proof, expected } = await decided();
      consumeInTransaction(db, decision, proof, expected);
      expect(externalCompletionProofRowCount(db, goalId)).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'isolates Goals in one database: a second Goal in the same database counts zero for its own id',
    async () => {
      const { db, fx, goalId, decision, proof, expected } = await decided();
      consumeInTransaction(db, decision, proof, expected);
      const second = createGoalDraft(db, {
        projectId: fx.projectId,
        title: 'Second Goal in the same database',
        definition: simpleDefinition(),
      });
      expect(externalCompletionProofRowCount(db, second.goalId)).toBe(0);
      expect(externalCompletionProofRowCount(db, goalId)).toBe(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
