import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { TERMINAL_RUN_STATUSES } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { gitTry, GoalGitError, loadContext } from '../goalGit.js';
import { writeGoalEvent } from './events.js';

/**
 * Goal run retention (design Q6, conservative V1): a Goal run's worktree may be removed, by a proven-safe specific run
 * id only, when nothing can still need it. The run BRANCH is always retained, so every historical commit stays
 * reachable. Nothing here calls a model, sweeps directories, runs `git worktree prune`, or uses `--force`.
 */
export type RetentionReason =
  | 'run_not_found'
  | 'not_goal_run'
  | 'unsupported_purpose'
  | 'run_not_terminal'
  | 'cycle_missing'
  | 'cycle_not_terminal'
  | 'proposal_not_consumed'
  | 'authoring_not_consumed'
  | 'planned_integration_op'
  | 'evidence_not_collected'
  | 'integration_not_proven'
  | 'repository_unavailable'
  | 'worktree_missing'
  | 'worktree_mismatch'
  | 'branch_missing'
  | 'worktree_head_mismatch'
  | 'worktree_dirty';

export type RetentionInspection =
  | { state: 'already_pruned'; reasons: [] }
  | { state: 'refused'; reasons: RetentionReason[] }
  | { state: 'eligible'; reasons: []; worktreePath: string; branch: string; tip: string; repoRoot: string };

export type PruneResult =
  | { status: 'pruned'; reasons: []; branch: string }
  | { status: 'already_pruned'; reasons: [] }
  | { status: 'refused'; reasons: RetentionReason[] }
  | { status: 'failed'; reasons: ['worktree_remove_failed']; error: string };

const TERMINAL_RUN = TERMINAL_RUN_STATUSES;
const TERMINAL_CYCLE = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);
/** Purposes whose results are extracted into evidence before the worktree may go. */
const EVIDENCE_PURPOSES = new Set(['execution', 'remediation', 'verification', 'review']);
const RUN_BRANCH = /^turing\/[0-9a-f]{8}$/;

interface RunRow {
  id: string;
  project_id: string;
  status: string;
  branch: string | null;
  worktree_path: string | null;
  goal_cycle_id: string | null;
  goal_run_purpose: string | null;
}

interface CycleRow {
  id: string;
  goal_id: string;
  status: string;
  kind: string;
  validated_task_json: string | null;
  result_integration_commit: string | null;
}

const samePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};

/**
 * An authoring run's output is durably consumed only when its cycle is terminal AND the matching record exists: for a
 * success the `goal_authoring_completed` event for this run and cycle plus the proposed (or later decided) version 1
 * authored by an authoring run; for a failed or cancelled cycle the `goal_authoring_failed` record for this run.
 */
function authoringConsumed(db: Db, cycle: CycleRow, runId: string): boolean {
  const event = (type: string) =>
    db
      .prepare(
        `SELECT 1 FROM goal_events WHERE goal_id = ? AND type = ?
           AND json_extract(payload_json, '$.runId') = ? AND json_extract(payload_json, '$.cycleId') = ? LIMIT 1`,
      )
      .get(cycle.goal_id, type, runId, cycle.id);
  if (cycle.status === 'succeeded')
    return (
      !!event('goal_authoring_completed') &&
      !!db
        .prepare(
          "SELECT 1 FROM goal_definition_versions WHERE goal_id = ? AND version = 1 AND created_by = 'authoring_run'",
        )
        .get(cycle.goal_id)
    );
  if (cycle.status === 'failed' || cycle.status === 'cancelled') return !!event('goal_authoring_failed');
  return false;
}

/** Read-only. Never mutates the database, the repository or the filesystem. */
export async function inspectRunRetention(db: Db, runId: string): Promise<RetentionInspection> {
  const run = db
    .prepare(
      `SELECT id, project_id, status, branch, worktree_path, goal_cycle_id, goal_run_purpose FROM runs WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (!run) return { state: 'refused', reasons: ['run_not_found'] };
  if (!run.goal_cycle_id || !run.goal_run_purpose) return { state: 'refused', reasons: ['not_goal_run'] };
  if (run.worktree_path === null) return { state: 'already_pruned', reasons: [] };

  const reasons: RetentionReason[] = [];
  const purpose = run.goal_run_purpose;
  if (purpose !== 'proposal' && purpose !== 'authoring' && !EVIDENCE_PURPOSES.has(purpose))
    reasons.push('unsupported_purpose');
  if (!TERMINAL_RUN.has(run.status)) reasons.push('run_not_terminal');

  const cycle = db
    .prepare(
      `SELECT id, goal_id, status, kind, validated_task_json, result_integration_commit FROM goal_cycles WHERE id = ?`,
    )
    .get(run.goal_cycle_id) as CycleRow | undefined;
  if (!cycle) reasons.push('cycle_missing');
  const cycleTerminal = cycle ? TERMINAL_CYCLE.has(cycle.status) : false;

  if (cycle && purpose === 'proposal') {
    // A proposal is consumed once its validated task is persisted, or the cycle terminally recorded the outcome.
    if (cycle.validated_task_json === null && !cycleTerminal) reasons.push('proposal_not_consumed');
  } else if (cycle && !cycleTerminal) {
    reasons.push('cycle_not_terminal');
  } else if (cycle && purpose === 'authoring' && !authoringConsumed(db, cycle, run.id)) {
    reasons.push('authoring_not_consumed');
  }

  const planned = db
    .prepare(
      "SELECT 1 FROM goal_integration_ops WHERE status = 'planned' AND (run_id = ? OR cycle_id = ?) LIMIT 1",
    )
    .get(run.id, run.goal_cycle_id);
  if (planned) reasons.push('planned_integration_op');

  if (cycle && EVIDENCE_PURPOSES.has(purpose)) {
    const marker = db
      .prepare(
        `SELECT 1 FROM goal_events WHERE goal_id = ? AND type = 'run_evidence_collected'
           AND json_extract(payload_json, '$.runId') = ? LIMIT 1`,
      )
      .get(cycle.goal_id, run.id);
    if (!marker) reasons.push('evidence_not_collected');
  }
  if (reasons.length > 0) return { state: 'refused', reasons };

  // --- Repository state (reached only when every persisted precondition holds) ---------------------------------------
  const cycleRow = cycle!;
  let repoRoot: string;
  let goalRef: string;
  try {
    const context = loadContext(db, cycleRow.goal_id);
    repoRoot = context.repoRoot;
    goalRef = context.ref;
  } catch (error) {
    if (error instanceof GoalGitError) return { state: 'refused', reasons: ['repository_unavailable'] };
    throw error;
  }
  const project = db.prepare('SELECT git_root FROM projects WHERE id = ?').get(run.project_id) as
    { git_root: string | null } | undefined;
  if (!project?.git_root || !samePath(project.git_root, repoRoot))
    return { state: 'refused', reasons: ['worktree_mismatch'] };

  const worktreePath = run.worktree_path;
  if (!existsSync(worktreePath)) return { state: 'refused', reasons: ['worktree_missing'] };
  const expectedBranch = `turing/${run.id.slice(0, 8)}`;
  if (!run.branch || run.branch !== expectedBranch || !RUN_BRANCH.test(run.branch))
    return { state: 'refused', reasons: ['worktree_mismatch'] };

  const [commonRepo, commonWorktree, topLevel, listing, currentBranch, head, tip, status] = await Promise.all(
    [
      gitTry(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      gitTry(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      gitTry(worktreePath, ['rev-parse', '--show-toplevel']),
      gitTry(repoRoot, ['worktree', 'list', '--porcelain']),
      gitTry(worktreePath, ['branch', '--show-current']),
      gitTry(worktreePath, ['rev-parse', 'HEAD']),
      gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}^{commit}`]),
      gitTry(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']),
    ],
  );
  const registered = listing.ok
    ? listing.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
    : [];
  if (
    !commonRepo.ok ||
    !commonWorktree.ok ||
    !samePath(commonRepo.stdout.trim(), commonWorktree.stdout.trim()) ||
    !topLevel.ok ||
    !samePath(topLevel.stdout.trim(), worktreePath) ||
    samePath(worktreePath, repoRoot) ||
    !registered.some((entry) => samePath(entry, worktreePath)) ||
    !currentBranch.ok ||
    currentBranch.stdout.trim() !== run.branch
  )
    return { state: 'refused', reasons: ['worktree_mismatch'] };
  const tipCommit = tip.ok ? tip.stdout.trim() : '';
  if (!tipCommit) return { state: 'refused', reasons: ['branch_missing'] };
  if (!head.ok || head.stdout.trim() !== tipCommit)
    return { state: 'refused', reasons: ['worktree_head_mismatch'] };
  if (!status.ok || status.stdout.trim()) return { state: 'refused', reasons: ['worktree_dirty'] };

  // An integrated execution/remediation result must be proven part of the current Goal history.
  if (cycleRow.status === 'succeeded' && (purpose === 'execution' || purpose === 'remediation')) {
    const applied = db
      .prepare(
        "SELECT new_commit FROM goal_integration_ops WHERE run_id = ? AND cycle_id = ? AND op = 'advance' AND status = 'applied'",
      )
      .get(run.id, cycleRow.id) as { new_commit: string } | undefined;
    if (!applied || applied.new_commit !== cycleRow.result_integration_commit)
      return { state: 'refused', reasons: ['integration_not_proven'] };
    const goalHead = await gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `${goalRef}^{commit}`]);
    if (!goalHead.ok) return { state: 'refused', reasons: ['integration_not_proven'] };
    const ancestor = await gitTry(repoRoot, [
      'merge-base',
      '--is-ancestor',
      applied.new_commit,
      goalHead.stdout.trim(),
    ]);
    if (!ancestor.ok) return { state: 'refused', reasons: ['integration_not_proven'] };
  }
  return {
    state: 'eligible',
    reasons: [],
    worktreePath,
    branch: run.branch,
    tip: tipCommit,
    repoRoot,
  };
}

/**
 * Removes one proven-safe run worktree through Git (`git worktree remove <path>`, never `--force`), verifies it is
 * gone, and only then clears `runs.worktree_path`. The run branch, `starting_commit`, `goal_base_commit` and all run,
 * stage, evidence and event history are untouched. Repeating it is a no-op.
 */
export async function pruneRunWorktree(db: Db, runId: string): Promise<PruneResult> {
  const inspection = await inspectRunRetention(db, runId);
  if (inspection.state === 'already_pruned') return { status: 'already_pruned', reasons: [] };
  if (inspection.state === 'refused') return { status: 'refused', reasons: inspection.reasons };

  const removed = await gitTry(inspection.repoRoot, ['worktree', 'remove', inspection.worktreePath]);
  const listing = await gitTry(inspection.repoRoot, ['worktree', 'list', '--porcelain']);
  const stillRegistered =
    !listing.ok ||
    listing.stdout
      .split('\n')
      .some(
        (line) =>
          line.startsWith('worktree ') && samePath(line.slice('worktree '.length), inspection.worktreePath),
      );
  if (!removed.ok || existsSync(inspection.worktreePath) || stillRegistered)
    return {
      status: 'failed',
      reasons: ['worktree_remove_failed'],
      error: removed.stderr.trim().slice(0, 300),
    };
  db.prepare('UPDATE runs SET worktree_path = NULL WHERE id = ? AND worktree_path = ?').run(
    runId,
    inspection.worktreePath,
  );
  return { status: 'pruned', reasons: [], branch: inspection.branch };
}

/**
 * The persisted "evidence extraction complete" marker. A Stage 4 collector calls this only after every evidence row
 * for the run is durably recorded (zero rows is a valid, recorded outcome). It validates what it can: the run belongs
 * to the cycle and Goal, is terminal, the cycle's definition version is stated truthfully, and the count equals the
 * evidence rows actually stored for the run. It is idempotent (one marker per run). Retention never writes it.
 */
export function recordRunEvidenceCollected(
  db: Db,
  input: { goalId: string; runId: string; evidenceCount: number; now?: string },
): { recorded: boolean } {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT r.status, r.goal_cycle_id, c.goal_id, c.definition_version FROM runs r
           JOIN goal_cycles c ON c.id = r.goal_cycle_id WHERE r.id = ?`,
      )
      .get(input.runId) as
      | { status: string; goal_cycle_id: string; goal_id: string; definition_version: number | null }
      | undefined;
    if (!row || row.goal_id !== input.goalId) throw new Error('The run does not belong to this Goal.');
    if (!TERMINAL_RUN.has(row.status)) throw new Error('Evidence is collected only from a terminal run.');
    if (row.definition_version === null) throw new Error('The cycle has no definition version.');
    const stored = (
      db
        .prepare('SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? AND run_id = ?')
        .get(input.goalId, input.runId) as { n: number }
    ).n;
    if (stored !== input.evidenceCount)
      throw new Error(`The run has ${stored} stored evidence row(s), not ${input.evidenceCount}.`);
    const existing = db
      .prepare(
        "SELECT 1 FROM goal_events WHERE goal_id = ? AND type = 'run_evidence_collected' AND json_extract(payload_json, '$.runId') = ?",
      )
      .get(input.goalId, input.runId);
    if (existing) return { recorded: false };
    writeGoalEvent(
      db,
      input.goalId,
      'run_evidence_collected',
      {
        runId: input.runId,
        cycleId: row.goal_cycle_id,
        definitionVersion: row.definition_version,
        evidenceCount: stored,
      },
      input.now,
    );
    return { recorded: true };
  })();
}
