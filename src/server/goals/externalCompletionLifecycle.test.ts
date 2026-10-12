import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { completeGoal } from './completion.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import { createGoalDraft, approveDefinition } from './definitions.js';
import { recordEvidence } from './evidence.js';
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
  appendCorrectionForTest,
  approveExternalObservation,
  databaseSnapshot,
  git,
  integratedExternalFixture,
  repositoryState,
  reviewedDigest,
  v2RunningAttestedFixture,
  type GoalFixture,
} from './goalV2TestKit.js';
import { BUILD, cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS, simpleDefinition, TESTS } from './repoKit.js';
import { transitionGoal } from './stateMachine.js';
import { verifierDigest } from './verifierDigest.js';
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

interface RepoState {
  refs: string;
  symbolicHead: string;
  config: string;
  exclude: string;
  worktrees: string;
  files: Record<string, string>;
}

const repoState = (repo: string): RepoState => repositoryState(repo) as RepoState;

/** Ref name to commit for every ref in the repository, from `git show-ref`. */
function refMap(repo: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of git(repo, 'show-ref').split('\n')) {
    const [sha, name] = line.split(' ');
    map[name!] = sha!;
  }
  return map;
}

/** The stored proof rows of a Goal, serialised: a byte comparison of what the proof table holds for it. */
function proofRowsJson(db: Db, goalId: string): string {
  return JSON.stringify(
    db.prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? ORDER BY rowid').all(goalId),
  );
}

/**
 * A digest of every row that belongs to one Goal: its `goals` row, and every row of every table with a `goal_id`
 * column, in rowid order. Tables without `goal_id` are not Goal-scoped and are not included.
 */
function goalScopedDigests(db: Db, goalId: string): Record<string, string> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const digests: Record<string, string> = {};
  for (const { name } of tables) {
    const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (column) => column.name,
    );
    let rows: unknown[] | null = null;
    if (name === 'goals') rows = db.prepare('SELECT * FROM goals WHERE id = ? ORDER BY rowid').all(goalId);
    else if (columns.includes('goal_id'))
      rows = db.prepare(`SELECT * FROM "${name}" WHERE goal_id = ? ORDER BY rowid`).all(goalId);
    if (rows !== null) digests[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return digests;
}

/**
 * A running version-2 Goal, reviewed and decided through the real services, then completed. Returns the request that
 * produced the completion, so a test can repeat that exact request.
 */
async function decideAndComplete(attested: Awaited<ReturnType<typeof runningAttested>>) {
  const digest = await readyDigest(attested);
  const request = {
    goalId: attested.fx.goalId,
    attestationId: attested.attestationId,
    reviewedPreflightDigest: digest,
    acknowledgeContentNotProven: true,
  };
  await recordExternalCompletionDecision(attested.fx.db, request);
  const completed = await completeGoalFromExternalDecision(attested.fx.db, request);
  return { request, completed };
}

/**
 * A version-1 Goal in the same database and project as `fx`, completed through the real `completeGoal` path. Its setup
 * mirrors goalRepoFixture for its own Goal: an approved definition, its own Goal ref and runtime head, and a running
 * status. A version-1 completion needs no final review, so no independence fixture is involved.
 */
async function completeLegacyGoal(fx: GoalFixture): Promise<string> {
  const definition = simpleDefinition();
  const { goalId } = createGoalDraft(fx.db, { projectId: fx.projectId, title: 'Legacy G', definition });
  approveDefinition(fx.db, { goalId, version: 1, actor: 'user' });
  const work = fx.sideCommit({ 'src/work.ts': 'legacy work\n' });
  git(fx.repo, 'update-ref', `refs/heads/turing/goal/${goalId}`, work);
  fx.db
    .prepare(
      'UPDATE goal_runtime SET integration_head = ?, goal_branch = ?, base_branch = ?, base_commit = ? WHERE goal_id = ?',
    )
    .run(work, `turing/goal/${goalId}`, 'main', fx.baseCommit, goalId);
  transitionGoal(fx.db, {
    goalId,
    to: 'running',
    reasonCode: 'user_start',
    actor: 'user',
    preconditions: [{ code: 'preflight', ok: true }],
  });
  const tree = git(fx.repo, 'rev-parse', `${work}^{tree}`);
  for (const [criterion, kind] of [
    [BUILD, 'build_result'],
    [TESTS, 'test_result'],
  ] as const)
    await recordEvidence(fx.db, {
      goalId,
      definitionVersion: 1,
      criterionKey: criterion.key,
      verifierDigest: verifierDigest(criterion.key, criterion.verification[0]!),
      kind,
      verdict: 'satisfies',
      subjectTree: tree,
    });
  expect(await completeGoal(fx.db, goalId)).toMatchObject({ completed: true });
  return goalId;
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
          // Observed value, pending an owner decision on whether a not_proven content-preservation completion may read as
          // unqualified success. Do not treat as intended behaviour.
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

describe('external completion lifecycle: destination movement after completion (Q4)', () => {
  it.each(FORMATS)(
    'keeps the proof, completed_at, standing and replay unchanged when main advances after completion (%s)',
    async (format) => {
      const attested = await runningAttested(format, 'merge');
      const { fx } = attested;
      const { request, completed } = await decideAndComplete(attested);
      expect(completed.reused).toBe(false);

      const replayBefore = await completeGoalFromExternalDecision(fx.db, request);
      expect(replayBefore).toEqual({ reused: true, completion: completed.completion });
      const proofId = proofRows(fx.db, fx.goalId)[0]!.id;
      const proofBytes = proofRowsJson(fx.db, fx.goalId);
      const completedAt = goalRow(fx.db, fx.goalId).completed_at;
      const standing = readGoalCompletionStanding(fx.db, fx.goalId);
      const mergeCommit = git(fx.repo, 'rev-parse', 'main');
      const refsBefore = refMap(fx.repo);
      const repoBefore = repoState(fx.repo);

      // The user's own commit on main, made outside Turing. Only main may move, and the file is the only addition.
      writeFileSync(join(fx.repo, 'after-completion.txt'), 'user commit after completion\n');
      git(fx.repo, 'add', 'after-completion.txt');
      git(fx.repo, 'commit', '-q', '-m', 'user commit after completion');
      const userCommit = git(fx.repo, 'rev-parse', 'main');
      expect(userCommit).not.toBe(mergeCommit);
      expect(refMap(fx.repo)).toEqual({ ...refsBefore, 'refs/heads/main': userCommit });
      const movedFull = repositoryState(fx.repo);
      const moved = repoState(fx.repo);
      expect(moved.symbolicHead).toBe(repoBefore.symbolicHead);
      expect(moved.config).toBe(repoBefore.config);
      expect(moved.exclude).toBe(repoBefore.exclude);
      // The worktree listing prints HEAD's commit, which is the user's commit now; nothing else in it may change.
      expect(moved.worktrees).toBe(repoBefore.worktrees.split(mergeCommit).join(userCommit));
      expect(moved.files).toEqual({
        ...repoBefore.files,
        'after-completion.txt': Buffer.from('user commit after completion\n').toString('base64'),
      });

      // Turing reads only after the move: the replay, the standing and a new preflight.
      const databaseBefore = databaseSnapshot(fx.db);
      const replayAfter = await completeGoalFromExternalDecision(fx.db, request);
      expect(replayAfter).toEqual({ reused: true, completion: completed.completion });
      expect(proofRows(fx.db, fx.goalId).map((row) => row.id)).toEqual([proofId]);
      expect(proofRowsJson(fx.db, fx.goalId)).toBe(proofBytes);
      expect(goalRow(fx.db, fx.goalId).completed_at).toBe(completedAt);
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toEqual(standing);

      // A new preflight for the same attestation refuses. The Goal is completed, so the refusal is at the goal-status
      // check, one step before the completion-already-recorded check (T7 reaches that code only for a running Goal).
      const report = await computeExternalCompletionPreflight(fx.db, fx.goalId, {
        attestationId: attested.attestationId,
      });
      expect(report.outcome).toBe('refused');
      expect(report.reasons).toEqual([{ code: 'goal_not_running', detail: 'completed' }]);

      expect(databaseSnapshot(fx.db)).toEqual(databaseBefore);
      expect(repositoryState(fx.repo)).toEqual(movedFull);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion lifecycle: cross-Goal isolation (Q5, two databases; same-database NOT producible)', () => {
  // A same-database claim was NOT producible. A second Goal in the same database needs its own handoff, and a handoff
  // needs an accepted final review and acceptance (buildManualHandoffSnapshot, ensureCompletionReady). Only the kit's
  // acceptance fixture records that review, with fixture independence, and this slice does not use that bypass. The
  // second Goal therefore lives in its own database, so the claim below is weaker: it shows that a correction in one
  // database leaves a second database untouched, not that one database's Goals are isolated from each other.
  it.each(FORMATS)(
    'a dispute in one database leaves a running Goal in another database untouched (two databases, %s)',
    async (format) => {
      const completedGoal = await runningAttested(format, 'merge');
      await decideAndComplete(completedGoal);

      const other = await v2RunningAttestedFixture(format);
      const otherDigest = await reviewedDigest(other);
      const otherDatabase = databaseSnapshot(other.fx.db);
      const otherStanding = readGoalCompletionStanding(other.fx.db, other.fx.goalId);
      const otherPreflight = await computeExternalCompletionPreflight(other.fx.db, other.fx.goalId, {
        attestationId: other.attestationId,
      });
      expect(otherStanding).toMatchObject({ kind: 'not_completed', standing: null });

      appendCorrectionForTest(completedGoal.fx, completedGoal.attestationId, 'dispute');
      expect(readGoalCompletionStanding(completedGoal.fx.db, completedGoal.fx.goalId)).toMatchObject({
        kind: 'v2',
        standing: 'disputed',
      });

      expect(databaseSnapshot(other.fx.db)).toEqual(otherDatabase);
      expect(readGoalCompletionStanding(other.fx.db, other.fx.goalId)).toEqual(otherStanding);
      expect(await reviewedDigest(other)).toBe(otherDigest);
      expect(
        await computeExternalCompletionPreflight(other.fx.db, other.fx.goalId, {
          attestationId: other.attestationId,
        }),
      ).toEqual(otherPreflight);

      // The other database never held the first Goal's attestation, so its preflight refuses that id by exact code.
      const foreign = await computeExternalCompletionPreflight(other.fx.db, other.fx.goalId, {
        attestationId: completedGoal.attestationId,
      });
      expect(foreign.outcome).toBe('refused');
      expect(foreign.reasons).toEqual([{ code: 'attestation_not_found', detail: null }]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion lifecycle: version 1 beside version 2 (Q6)', () => {
  it.each(FORMATS)(
    'keeps a completed version-1 Goal in the same database unchanged by a version-2 dispute (%s)',
    async (format) => {
      const attested = await runningAttested(format, 'merge');
      const { fx } = attested;
      await decideAndComplete(attested);
      const v2Before = readGoalCompletionStanding(fx.db, fx.goalId);
      expect(v2Before).toMatchObject({
        kind: 'v2',
        standing: 'uncontested',
        claim: { unqualifiedSuccessAllowed: true, trustedForDownstream: true, qualifier: 'none' },
      });

      const legacyId = await completeLegacyGoal(fx);
      const legacyStanding = readGoalCompletionStanding(fx.db, legacyId);
      expect(legacyStanding).toMatchObject({
        kind: 'legacy',
        standing: 'historical_legacy',
        claim: {
          unqualifiedSuccessAllowed: false,
          trustedForDownstream: false,
          qualifier: 'legacy_not_v2_attested',
        },
      });
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toEqual(v2Before);
      const legacyRows = goalScopedDigests(fx.db, legacyId);
      expect(Object.keys(legacyRows)).toEqual(
        expect.arrayContaining(['goals', 'goal_events', 'goal_approvals']),
      );

      appendCorrectionForTest(fx, attested.attestationId, 'dispute');
      expect(readGoalCompletionStanding(fx.db, fx.goalId)).toMatchObject({
        kind: 'v2',
        standing: 'disputed',
      });
      expect(goalScopedDigests(fx.db, legacyId)).toEqual(legacyRows);
      expect(readGoalCompletionStanding(fx.db, legacyId)).toEqual(legacyStanding);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('external completion lifecycle: repeated requests across a correction (Q8)', () => {
  it.each(FORMATS)(
    'replays the original completion three times and refuses an exact repeated decision, after a dispute (%s)',
    async (format) => {
      const attested = await runningAttested(format, 'merge');
      const { fx } = attested;
      const { request, completed } = await decideAndComplete(attested);
      const proofId = proofRows(fx.db, fx.goalId)[0]!.id;
      appendCorrectionForTest(fx, attested.attestationId, 'dispute');

      const before = databaseSnapshot(fx.db);
      const eventsBefore = goalEvents(fx.db, fx.goalId);
      for (let repeat = 0; repeat < 3; repeat += 1)
        expect(await completeGoalFromExternalDecision(fx.db, request)).toEqual({
          reused: true,
          completion: completed.completion,
        });
      expect(databaseSnapshot(fx.db)).toEqual(before);
      expect(goalEvents(fx.db, fx.goalId)).toEqual(eventsBefore);
      expect(proofRows(fx.db, fx.goalId).map((row) => row.id)).toEqual([proofId]);

      // D17 defines `decision_conflict` for a different decision on the same attestation while the Goal is running. An
      // exact repeat after completion is not a conflict: the decision service refuses at its preflight, because the
      // Goal is no longer running. The refusal writes nothing.
      expect(await refusal(recordExternalCompletionDecision(fx.db, request))).toEqual({
        code: 'preflight_refused',
        detail: 'goal_not_running',
      });
      expect(databaseSnapshot(fx.db)).toEqual(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
