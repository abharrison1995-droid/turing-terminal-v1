import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { completeGoalFromExternalDecision, ExternalCompletionError } from './externalCompletion.js';
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
} from './externalCompletionDecision.js';
import { readExternalCompletionProof } from './externalCompletionProof.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { readStoredCompletion } from './externalCompletionTerminal.js';
import { persistExternalIntegrationAttestation } from './externalIntegration.js';
import {
  approveExternalObservation,
  databaseSnapshot,
  git,
  integratedExternalFixture,
  repositoryState,
  type GoalFixture,
} from './goalV2TestKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { EXTERNAL_COMPLETION_REASON } from '../../shared/goals.js';

/**
 * Lifecycle qualification of the version-2 completion for the two merge shapes that the ff-only fixtures never reach: a
 * normal two-parent merge (Q3) and `merge -s ours`, which discards the accepted content (Q2). Both run through the real
 * handoff, Git observation, attestation, preflight, decision and completion services, on real Git and real SQLite with
 * the production migrations. Only the Git fixtures are test code; no service, Git or database call is stubbed.
 */

afterEach(() => {
  cleanupRepoFixtures();
});

const FORMATS = ['sha1', 'sha256'] as const;

interface GoalEventRow {
  seq: number;
  id: string;
  goal_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

interface Snapshot {
  db: ReturnType<typeof databaseSnapshot>;
  repo: unknown;
  events: GoalEventRow[];
  approval: unknown;
}

/** Tables whose rows a completion is allowed to change. Every other table must keep its digest. */
const TABLES_A_COMPLETION_CHANGES = new Set([
  'goals',
  'goal_events',
  'goal_external_completion_proofs',
  'goal_runtime',
]);

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

/** Exactly one proof and exactly two new events, in order; the rest of the Goal's state is unchanged. */
function expectCompleted(fx: GoalFixture, before: Snapshot, approvalId: string): void {
  expect(proofRows(fx.db, fx.goalId)).toHaveLength(1);

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

/** The refusal an attempt raises, by code and detail. Fails the test on success or on any other kind of error. */
async function refusal(attempt: Promise<unknown>): Promise<{ code: string; detail: string | null }> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ExternalCompletionError || error instanceof ExternalCompletionDecisionError)
      return { code: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('the attempt succeeded but a refusal was expected');
}

/**
 * A running version-2 Goal whose observed integration (`strategy`) is attested through the same services that
 * `v2AttestedFixture` uses. Composed here because that kit helper accepts only the fast-forward and ours strategies.
 */
async function runningAttested(objectFormat: 'sha1' | 'sha256', strategy: 'merge' | 'ours') {
  const integrated = await integratedExternalFixture(objectFormat, strategy, {
    completionContractVersion2: true,
    running: true,
  });
  const approval = approveExternalObservation(integrated.fx, integrated.observation);
  const persisted = await persistExternalIntegrationAttestation(integrated.fx.db, {
    goalId: integrated.fx.goalId,
    handoffId: integrated.handoff.handoffId,
    observation: integrated.observation,
    approvalId: approval.id,
  });
  return { ...integrated, approval, attestationId: persisted.record.attestationId };
}

/** The ready preflight digest a user reviews. Refuses the test when the preflight is not ready. */
async function readyDigest(attested: { fx: GoalFixture; attestationId: string }): Promise<string> {
  const report = await computeExternalCompletionPreflight(attested.fx.db, attested.fx.goalId, {
    attestationId: attested.attestationId,
  });
  expect(report.outcome).toBe('ready');
  return report.digest;
}

describe('external completion lifecycle: normal merge (Q3)', () => {
  it.each(FORMATS)(
    'completes a normal two-parent merge with the merge commit as the proven destination (%s)',
    async (format) => {
      const attested = await runningAttested(format, 'merge');
      const { fx } = attested;
      const digest = await readyDigest(attested);
      const decision = await recordExternalCompletionDecision(fx.db, {
        goalId: fx.goalId,
        attestationId: attested.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });
      const before = snapshotOf(fx, decision.approvalId);

      const result = await completeGoalFromExternalDecision(fx.db, {
        goalId: fx.goalId,
        attestationId: attested.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: true,
      });

      expect(result.reused).toBe(false);
      expect(result.completion).toMatchObject({
        state: 'completed',
        approvalId: decision.approvalId,
        actionDigest: decision.actionDigest,
        preflightDigest: digest,
      });
      expectCompleted(fx, before, decision.approvalId);
      expect(repositoryState(fx.repo)).toEqual(before.repo);
      expect(readStoredCompletion(fx.db, fx.goalId)).toEqual(result.completion);

      // The destination on main is the merge commit: a commit with exactly two parents, whose first parent is the
      // destination-only commit and whose second parent is the accepted source.
      const mergeCommit = git(fx.repo, 'rev-parse', 'main');
      const parentLine = git(fx.repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ');
      expect(parentLine).toHaveLength(3);
      expect(parentLine[0]).toBe(mergeCommit);
      expect(parentLine[2]).toBe(attested.sourceCommit);

      const [row] = proofRows(fx.db, fx.goalId);
      const read = readExternalCompletionProof(fx.db, fx.goalId, row!.id);
      expect(read.state).toBe('valid');
      if (read.state !== 'valid') return;
      const proof = read.proof;

      expect(proof.destination.observedCommit).toBe(mergeCommit);
      expect(proof.destination.observedTree).toBe(git(fx.repo, 'rev-parse', 'main^{tree}'));
      expect(proof.source.commit).toBe(attested.sourceCommit);
      expect(git(fx.repo, 'merge-base', attested.sourceCommit, mergeCommit)).toBe(attested.sourceCommit);

      // The destination-only file survives the merge, and the accepted result is present in the merged tree.
      expect(git(fx.repo, 'show', 'main:unrelated.txt')).toBe('destination-only change');
      expect(git(fx.repo, 'show', 'main:src/result.txt')).toBe('prepared result');

      expect(proof.proofLimitations.contentPreservation).toBe('not_proven');
      const standing = readGoalCompletionStanding(fx.db, fx.goalId);
      expect(standing).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: { contentPreservation: 'not_proven' },
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion lifecycle: merge -s ours disclosure (Q2)', () => {
  it(
    'records the merge -s ours completion with content not proven: refused without the acknowledgement with nothing written, completed with it (sha1)',
    async () => {
      const attested = await runningAttested('sha1', 'ours');
      const { fx } = attested;
      const digest = await readyDigest(attested);
      const decisionRequest = {
        goalId: fx.goalId,
        attestationId: attested.attestationId,
        reviewedPreflightDigest: digest,
      };

      // The decision itself is refused without the disclosure, and nothing is written.
      const beforeDecision = snapshotOf(fx, null);
      expect(
        await refusal(
          recordExternalCompletionDecision(fx.db, { ...decisionRequest, acknowledgeContentNotProven: false }),
        ),
      ).toEqual({ code: 'acknowledgement_required', detail: null });
      expectNothingWritten(fx, beforeDecision);

      const decision = await recordExternalCompletionDecision(fx.db, {
        ...decisionRequest,
        acknowledgeContentNotProven: true,
      });
      const before = snapshotOf(fx, decision.approvalId);

      // The completion is refused without the disclosure, and the whole state is unchanged.
      expect(
        await refusal(
          completeGoalFromExternalDecision(fx.db, {
            ...decisionRequest,
            acknowledgeContentNotProven: false,
          }),
        ),
      ).toEqual({ code: 'acknowledgement_required', detail: null });
      expectNoCompletion(fx, before);

      const result = await completeGoalFromExternalDecision(fx.db, {
        ...decisionRequest,
        acknowledgeContentNotProven: true,
      });
      expect(result.reused).toBe(false);
      expectCompleted(fx, before, decision.approvalId);

      const [row] = proofRows(fx.db, fx.goalId);
      const read = readExternalCompletionProof(fx.db, fx.goalId, row!.id);
      expect(read.state).toBe('valid');
      if (read.state !== 'valid') return;
      expect(read.proof.proofLimitations.contentPreservation).toBe('not_proven');

      // The standing reader reports the completion as uncontested, with the content-preservation dimension unproven.
      const standing = readGoalCompletionStanding(fx.db, fx.goalId);
      expect(standing).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        status: { goalStatus: 'completed' },
        claim: {
          unqualifiedSuccessAllowed: true,
          trustedForDownstream: true,
          qualifier: 'none',
          contentPreservation: 'not_proven',
        },
      });

      // The accepted result was discarded: the merged main tree has no src/result.txt and matches the attested tree.
      const files = git(fx.repo, 'ls-tree', '-r', '--name-only', 'main').split('\n');
      expect(files).not.toContain('src/result.txt');
      expect(git(fx.repo, 'rev-parse', 'main^{tree}')).toBe(read.proof.destination.observedTree);
      // `git cat-file -e` exits 128 for a path that does not exist in the commit (not a generic failure).
      const probe = spawnSync('git', ['-C', fx.repo, 'cat-file', '-e', 'main:src/result.txt']);
      expect(probe.status).toBe(128);
      expect(String(probe.stderr)).toContain("path 'src/result.txt' does not exist in 'main'");
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
