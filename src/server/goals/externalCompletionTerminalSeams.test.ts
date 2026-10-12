import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import {
  appendCorrectionForTest,
  completionProofForDecision,
  databaseSnapshot,
  v2DecidedFixture,
} from './goalV2TestKit.js';
import {
  ExternalCompletionTerminalError,
  consumeExternalCompletionDecision,
  externalCompletionProofRowCount,
  readStoredCompletion,
  selectCompletionDecision,
  type ValidatedCompletionDecision,
} from './externalCompletionTerminal.js';
import { readPreflightSnapshotIdentity, type SnapshotIdentity } from './externalCompletionPreflight.js';
import type { ExternalCompletionProofV1 } from './externalCompletionProof.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

/**
 * Terminal refusals that only a seam can reach. The seam wraps `readPreflightSnapshotIdentity`, the terminal's own
 * identity read at the start of the completion checks, and runs one hook after the real read returns. The hook runs
 * inside the consumer's open transaction, so everything it writes is rolled back with the refusal.
 */
const seam = vi.hoisted(() => ({
  afterIdentity: null as null | ((db: Db, goalId: string) => void),
}));

vi.mock('./externalCompletionPreflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./externalCompletionPreflight.js')>();
  return {
    ...actual,
    readPreflightSnapshotIdentity: (
      db: Db,
      goalId: string,
      attestationId: string,
      options?: Parameters<typeof actual.readPreflightSnapshotIdentity>[3],
    ): SnapshotIdentity => {
      const result = actual.readPreflightSnapshotIdentity(db, goalId, attestationId, options);
      const hook = seam.afterIdentity;
      seam.afterIdentity = null;
      hook?.(db, goalId);
      return result;
    },
  };
});

afterEach(() => {
  seam.afterIdentity = null;
  cleanupRepoFixtures();
});

const OBSERVED_AT = '2026-10-11T09:00:00.000Z';
const NOW = '2030-01-01T00:00:00.000Z';

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

function consumeInTransaction(
  db: Db,
  decision: ValidatedCompletionDecision,
  proof: ExternalCompletionProofV1,
  expected: SnapshotIdentity,
) {
  return db
    .transaction(() => consumeExternalCompletionDecision(db, decision, proof, expected, NOW))
    .immediate();
}

/** The trigger set, so a test can see that a rollback also restored a trigger the hook dropped. */
function triggerNames(db: Db): unknown {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
}

describe('external completion terminal seams: Slice 2c refusals reached only after the identity read', () => {
  it(
    'B4 refuses when the approval stops being approved inside the transaction, and rolls the hook back',
    async () => {
      const attested = await v2DecidedFixture('sha1');
      const { fx } = attested;
      const db = fx.db;
      const goalId = fx.goalId;
      const approvalId = attested.recorded.approvalId;
      const decision = selectCompletionDecision(db, goalId, approvalId);
      const proof = completionProofForDecision(decision, OBSERVED_AT);
      const expected = readPreflightSnapshotIdentity(db, goalId, attested.attestationId, {
        allowRecordedDecision: true,
      });
      const before = databaseSnapshot(db);
      const triggersBefore = triggerNames(db);

      seam.afterIdentity = (hookDb) => {
        hookDb.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
        hookDb.prepare("UPDATE goal_approvals SET status = 'denied' WHERE id = ?").run(approvalId);
      };
      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'authority_changed_during_completion',
        detail: 'approval_status',
      });
      expect(seam.afterIdentity).toBeNull();
      expect(databaseSnapshot(db)).toEqual(before);
      expect(triggerNames(db)).toEqual(triggersBefore);
      expect(getGoalApproval(db, approvalId)).toMatchObject({ status: 'approved' });
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'not_completed' });
      expect(externalCompletionProofRowCount(db, goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'B5 refuses when the only decision is corrected inside the transaction, after the identity read, and writes nothing',
    async () => {
      const attested = await v2DecidedFixture('sha1');
      const { fx } = attested;
      const db = fx.db;
      const goalId = fx.goalId;
      const attestationId = attested.attestationId;
      const decision = selectCompletionDecision(db, goalId, attested.recorded.approvalId);
      const proof = completionProofForDecision(decision, OBSERVED_AT);
      const expected = readPreflightSnapshotIdentity(db, goalId, attestationId, {
        allowRecordedDecision: true,
      });
      const before = databaseSnapshot(db);

      seam.afterIdentity = () => {
        appendCorrectionForTest(fx, attestationId, 'dispute');
      };
      expect(refusal(() => consumeInTransaction(db, decision, proof, expected))).toMatchObject({
        code: 'authority_changed_during_completion',
        detail: 'own_decision_ineligible',
      });
      expect(seam.afterIdentity).toBeNull();
      expect(databaseSnapshot(db)).toEqual(before);
      expect(readStoredCompletion(db, goalId)).toEqual({ state: 'not_completed' });
      expect(externalCompletionProofRowCount(db, goalId)).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
