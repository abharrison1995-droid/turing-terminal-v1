import { execFile as callbackExecFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { hasSuspectedSecret, isSensitivePath } from './executionBroker.js';
import { redactSecrets } from './security.js';

/**
 * Goal-owned integration refs (design section 7). Deterministic Git mechanics only: no supervisor, no AI, no
 * evidence or review logic. The Goal ref refs/heads/turing/goal/<goal-id> is never checked out and is moved only
 * with `git update-ref <ref> <new> <expected-old>`, a native compare-and-swap. Nothing here mutates the user's
 * branch; final apply is preflight-only until the approval layer exists.
 */

const execFile = promisify(callbackExecFile);

const GOAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_BRANCH = /^turing\/[0-9a-f]{8}$/;
const OBJECT_ID = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ } as const;
const INTEGRATION_PURPOSES = new Set(['execution', 'remediation']);
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024;
const DEFAULT_PREVIEW_CHARS = 12_000;

export type ObjectFormat = 'sha1' | 'sha256';

export class GoalGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface IntegrationCheck {
  check: string;
  ok: boolean;
  detail?: unknown;
}

/** Narrow deterministic policy supplied by trusted server code (never parsed from model text). */
export interface IntegrationPolicy {
  /** Goal statuses in which integration may proceed. Default: ['running'] (design check C1). */
  allowedGoalStatuses?: readonly string[];
  /**
   * Repo-root-relative path prefixes the active milestone permits, each inside the project subtree. Omitted means
   * the whole project subtree. A changed path (old and new) must fall under one of them.
   */
  allowedPaths?: readonly string[];
  /** Upper bound on diff bytes scanned for secrets; exceeding it fails closed. */
  maxScanBytes?: number;
}

export interface IntegrationHooks {
  /** Test seam: runs after checks and the planned op are written, immediately before the compare-and-swap. */
  beforeCas?: () => void | Promise<void>;
}

export type InitResult =
  | { outcome: 'initialized'; opId: string; ref: string; head: string; baseBranch: string }
  | { outcome: 'refused'; code: string; message: string }
  | { outcome: 'conflict'; code: 'goal_ref_conflict'; opId: string };

export type AdvanceResult =
  | { outcome: 'advanced'; opId: string; from: string; to: string; changedPaths: string[] }
  | { outcome: 'no_change'; head: string }
  | { outcome: 'rejected'; code: string; message: string; checks: IntegrationCheck[] }
  | { outcome: 'conflict'; code: 'goal_ref_conflict'; opId: string };

export type RecoveryResult = {
  opId: string;
  op: string;
  outcome: 'completed' | 'aborted' | 'goal_ref_changed' | 'skipped';
  observedRef: string | null;
};

export type FinalApplyStatus =
  | 'ready_for_approved_apply'
  | 'base_diverged'
  | 'wrong_branch'
  | 'dirty_checkout'
  | 'goal_ref_changed'
  | 'not_fast_forward'
  | 'unsafe_changes'
  | 'goal_not_initialized';

export interface FinalApplyPreflight {
  status: FinalApplyStatus;
  recordedBaseBranch: string | null;
  recordedBaseCommit: string | null;
  currentBranch: string | null;
  currentHead: string | null;
  dirty: boolean | null;
  integrationHead: string | null;
  goalRef: string | null;
  fastForwardPossible: boolean | null;
  /** Commits only on the checkout (ahead) and only on the Goal ref (behind) relative to each other. */
  ahead: number | null;
  behind: number | null;
  changedPaths: string[];
  safety: { ok: boolean; violations: Array<{ path?: string; code: string }> };
  diffStat: string;
  /** Bounded and redacted for display only; never a security boundary. */
  diffPreview: string;
  diffPreviewTruncated: boolean;
}

interface GoalContext {
  goalId: string;
  status: string;
  projectId: string;
  repoRoot: string;
  /** Project folder relative to the repository root, POSIX separators; '' when the project is the root. */
  scope: string;
  branch: string;
  ref: string;
}

interface OpRow {
  id: string;
  goal_id: string;
  cycle_id: string | null;
  run_id: string | null;
  op: string;
  expected_old: string | null;
  new_commit: string;
  status: string;
  checks_json: string;
}

let noHooksDirectory: string | null = null;
function disabledHooksPath(): string {
  if (!noHooksDirectory) {
    noHooksDirectory = join(tmpdir(), 'turing-goal-git-no-hooks');
    mkdirSync(noHooksDirectory, { recursive: true, mode: 0o700 });
  }
  return noHooksDirectory;
}

async function gitTry(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitTry(cwd, args);
  if (!result.ok)
    throw new GoalGitError('git_failed', `git ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The Goal ref for a server-created Goal id. Validated twice: id shape, then Git's own ref-format rules. */
export function goalBranchName(goalId: string): string {
  if (!GOAL_ID.test(goalId))
    throw new GoalGitError('invalid_goal_id', 'Goal id is not a server-created UUID.');
  return `turing/goal/${goalId}`;
}

export async function goalRefName(goalId: string, cwd = process.cwd()): Promise<string> {
  const ref = `refs/heads/${goalBranchName(goalId)}`;
  const result = await gitTry(cwd, ['check-ref-format', ref]);
  if (!result.ok) throw new GoalGitError('invalid_goal_ref', 'The Goal ref is not a valid Git ref name.');
  return ref;
}

export async function repositoryObjectFormat(repoRoot: string): Promise<ObjectFormat> {
  const format = await git(repoRoot, ['rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256')
    throw new GoalGitError('unsupported_object_format', `Unsupported Git object format: ${format}.`);
  return format;
}

export function zeroObjectId(format: ObjectFormat): string {
  return '0'.repeat(format === 'sha256' ? 64 : 40);
}

function isObjectId(value: string, format: ObjectFormat): boolean {
  return OBJECT_ID[format].test(value);
}

async function readRef(repoRoot: string, ref: string): Promise<string | null> {
  const result = await gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

/** Returns the worktree path that has the branch checked out, if any (the main worktree included). */
async function checkedOutAt(repoRoot: string, ref: string): Promise<string | null> {
  const listing = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  let current: string | null = null;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch ${ref}`) return current;
  }
  return null;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function loadContext(db: Db, goalId: string): GoalContext {
  const branch = goalBranchName(goalId);
  const row = db
    .prepare(
      `SELECT g.status, g.project_id, p.path, p.git_root FROM goals g
       JOIN projects p ON p.id = g.project_id WHERE g.id = ?`,
    )
    .get(goalId) as { status: string; project_id: string; path: string; git_root: string | null } | undefined;
  if (!row) throw new GoalGitError('goal_not_found', 'The Goal does not exist.');
  if (!row.git_root) throw new GoalGitError('project_not_git', 'The Goal project is not a Git repository.');
  const repoRoot = realpathSync(row.git_root);
  const scope = toPosix(relative(repoRoot, realpathSync(row.path)));
  if (scope === '..' || scope.startsWith('../'))
    throw new GoalGitError('project_outside_repository', 'The registered project is outside its Git root.');
  return {
    goalId,
    status: row.status,
    projectId: row.project_id,
    repoRoot,
    scope: scope === '.' ? '' : scope,
    branch,
    ref: `refs/heads/${branch}`,
  };
}

function runtimeRow(db: Db, goalId: string) {
  return db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(goalId) as
    | {
        goal_branch: string | null;
        integration_head: string | null;
        base_branch: string | null;
        base_commit: string | null;
      }
    | undefined;
}

function pendingOp(db: Db, goalId: string): OpRow | undefined {
  return db
    .prepare("SELECT * FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned'")
    .get(goalId) as OpRow | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Initialisation

/**
 * Creates the Goal ref at the registered checkout's current commit, only if it does not exist, through the same
 * durable planned -> CAS -> applied pattern used for advancement. The user's checkout may be dirty; only its
 * committed HEAD is used.
 */
export async function initGoalRef(db: Db, goalId: string, hooks: IntegrationHooks = {}): Promise<InitResult> {
  const refuse = (code: string, message: string): InitResult => ({ outcome: 'refused', code, message });
  let context: GoalContext;
  try {
    context = loadContext(db, goalId);
  } catch (error) {
    if (error instanceof GoalGitError) return refuse(error.code, error.message);
    throw error;
  }
  const { repoRoot, ref, branch } = context;
  if (runtimeRow(db, goalId)?.integration_head)
    return refuse('already_initialized', 'The Goal already has an integration head.');
  if (pendingOp(db, goalId))
    return refuse('pending_operation', 'A previous integration operation is unresolved; run recovery first.');
  const format = await repositoryObjectFormat(repoRoot);
  const baseBranch = await git(repoRoot, ['branch', '--show-current']);
  if (!baseBranch) return refuse('detached_head', 'The registered checkout is on a detached HEAD.');
  const baseCommit = await git(repoRoot, ['rev-parse', 'HEAD']);
  const valid =
    isObjectId(baseCommit, format) &&
    (await gitTry(repoRoot, ['cat-file', '-e', `${baseCommit}^{commit}`])).ok;
  if (!valid)
    return refuse('invalid_base_commit', 'The base commit is not a valid commit in this repository.');
  if (await readRef(repoRoot, ref))
    return refuse('goal_ref_exists', 'The Goal ref already exists; refusing to overwrite it.');
  if (await checkedOutAt(repoRoot, ref))
    return refuse('goal_branch_checked_out', 'The Goal branch is checked out in a worktree.');

  const opId = randomUUID();
  const checks: IntegrationCheck[] = [
    { check: 'init', ok: true, detail: { ref, baseBranch, baseCommit, objectFormat: format } },
  ];
  db.prepare(
    `INSERT INTO goal_integration_ops (id, goal_id, op, expected_old, new_commit, status, checks_json, created_at)
     VALUES (?, ?, 'init_ref', NULL, ?, 'planned', ?, ?)`,
  ).run(opId, goalId, baseCommit, JSON.stringify(checks), new Date().toISOString());
  await hooks.beforeCas?.();
  const created = await gitTry(repoRoot, [
    '-c',
    `core.hooksPath=${disabledHooksPath()}`,
    'update-ref',
    '-m',
    `turing goal ${goalId} init`,
    ref,
    baseCommit,
    zeroObjectId(format),
  ]);
  if (!created.ok) {
    resolveOp(db, opId, 'failed', 'goal_ref_conflict', {
      stderr: redactSecrets(created.stderr.slice(0, 500)),
    });
    return { outcome: 'conflict', code: 'goal_ref_conflict', opId };
  }
  completeOp(db, readOp(db, opId)!);
  return { outcome: 'initialized', opId, ref: branch, head: baseCommit, baseBranch };
}

function readOp(db: Db, id: string): OpRow | undefined {
  return db.prepare('SELECT * FROM goal_integration_ops WHERE id = ?').get(id) as OpRow | undefined;
}

function resolveOp(
  db: Db,
  id: string,
  status: 'applied' | 'aborted' | 'failed',
  errorCode: string | null,
  recovery?: unknown,
): boolean {
  const result = db
    .prepare(
      `UPDATE goal_integration_ops SET status = ?, error_code = ?, finished_at = ?, recovery_json = ?
       WHERE id = ? AND status = 'planned'`,
    )
    .run(
      status,
      errorCode,
      new Date().toISOString(),
      recovery === undefined ? null : JSON.stringify(recovery),
      id,
    );
  return result.changes > 0;
}

/** Database side of a Git mutation that has happened. Idempotent: a resolved op is left untouched. */
function completeOp(db: Db, op: OpRow): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    if (!resolveOp(db, op.id, 'applied', null)) return false;
    if (op.op === 'init_ref') {
      const detail = (JSON.parse(op.checks_json) as IntegrationCheck[])[0]?.detail as {
        baseBranch: string;
        baseCommit: string;
        ref: string;
      };
      const upsert = db
        .prepare(
          `INSERT INTO goal_runtime (goal_id, goal_branch, integration_head, base_branch, base_commit, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (goal_id) DO UPDATE SET goal_branch = excluded.goal_branch,
           integration_head = excluded.integration_head, base_branch = excluded.base_branch,
           base_commit = excluded.base_commit, updated_at = excluded.updated_at`,
        )
        .run(
          op.goal_id,
          goalBranchName(op.goal_id),
          op.new_commit,
          detail.baseBranch,
          detail.baseCommit,
          now,
        );
      if (upsert.changes !== 1)
        throw new GoalGitError(
          'bookkeeping_invariant',
          'The Goal runtime row was not written; the op stays planned.',
        );
    } else if (op.op === 'advance') {
      const runtimeUpdate = db
        .prepare('UPDATE goal_runtime SET integration_head = ?, updated_at = ? WHERE goal_id = ?')
        .run(op.new_commit, now, op.goal_id);
      if (runtimeUpdate.changes !== 1)
        throw new GoalGitError(
          'bookkeeping_invariant',
          'The Goal runtime row is missing; the op stays planned.',
        );
      if (op.cycle_id) {
        const cycleUpdate = db
          .prepare('UPDATE goal_cycles SET result_integration_commit = ? WHERE id = ? AND goal_id = ?')
          .run(op.new_commit, op.cycle_id, op.goal_id);
        if (cycleUpdate.changes !== 1)
          throw new GoalGitError('bookkeeping_invariant', 'The cycle row is missing; the op stays planned.');
      }
    }
    return true;
  })();
}

// ---------------------------------------------------------------------------------------------------------------
// Changed-path and content inspection

interface ChangedEntry {
  status: string;
  oldPath: string | null;
  newPath: string | null;
  newMode: string;
}

/**
 * Complete changed-path set for from..to as NUL-delimited raw records, with rename and copy detection so both the
 * source and destination of a move or copy are reported. Independent of any display diff.
 */
export async function changedEntries(repoRoot: string, from: string, to: string): Promise<ChangedEntry[]> {
  const raw = await git(repoRoot, [
    'diff',
    '--raw',
    '-z',
    '-M',
    '-C',
    '--find-copies-harder',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    from,
    to,
    '--',
  ]);
  const tokens = raw.split('\0');
  const entries: ChangedEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const meta = tokens[index]!;
    if (!meta.startsWith(':')) continue;
    const [, newMode = '', , , statusField = ''] = meta.split(' ');
    const status = statusField[0] ?? '';
    if (status === 'R' || status === 'C') {
      entries.push({
        status,
        oldPath: tokens[index + 1] ?? null,
        newPath: tokens[index + 2] ?? null,
        newMode,
      });
      index += 2;
    } else {
      const path = tokens[index + 1] ?? null;
      entries.push({
        status,
        oldPath: status === 'A' ? null : path,
        newPath: status === 'D' ? null : path,
        newMode,
      });
      index += 1;
    }
  }
  return entries;
}

export function changedPathSet(entries: ChangedEntry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.oldPath) paths.add(entry.oldPath);
    if (entry.newPath) paths.add(entry.newPath);
  }
  return [...paths].sort();
}

function underPrefix(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

interface PathViolation {
  path?: string;
  code: string;
}

/** Scope, repository-metadata, sensitive-path and file-mode checks over every old and new path. */
export function checkChangedPaths(
  entries: ChangedEntry[],
  scope: string,
  allowedPaths?: readonly string[],
): PathViolation[] {
  const violations: PathViolation[] = [];
  const prefixes = allowedPaths?.map(normalizePrefix);
  for (const entry of entries) {
    if ((entry.newMode === '120000' || entry.newMode === '160000') && entry.newPath)
      violations.push({ path: entry.newPath, code: 'unsupported_file_mode' });
    for (const path of [entry.oldPath, entry.newPath]) {
      if (!path) continue;
      const parts = path.split('/');
      if (path.startsWith('/') || parts.includes('..')) violations.push({ path, code: 'path_out_of_scope' });
      else if (!underPrefix(path, scope)) violations.push({ path, code: 'path_out_of_scope' });
      else if (parts.some((part) => part.toLowerCase() === '.git'))
        violations.push({ path, code: 'path_protected' });
      else if (isSensitivePath(path)) violations.push({ path, code: 'path_sensitive' });
      else if (prefixes && !prefixes.some((prefix) => underPrefix(path, prefix)))
        violations.push({ path, code: 'milestone_scope_violation' });
    }
  }
  return violations;
}

export type ScanResult =
  | { ok: true; scannedBytes: number }
  | { ok: false; code: 'secret_detected' | 'scan_limit_exceeded' | 'scan_failed'; detail?: string };

/**
 * Exhaustive secret scan: streams the complete `git diff` of from..to (binary content included via --text, no
 * textconv or external diff, no rename shortcuts) and tests every added line, however large the diff. A scan that
 * cannot complete fails closed. The bounded display preview is a separate, non-security artefact.
 */
export function scanChangedContent(
  repoRoot: string,
  from: string,
  to: string,
  maxBytes = DEFAULT_MAX_SCAN_BYTES,
): Promise<ScanResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'git',
      [
        'diff',
        '--text',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '-U0',
        from,
        to,
        '--',
      ],
      { cwd: repoRoot, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    );
    let pending = '';
    let scanned = 0;
    let settled = false;
    let stderr = '';
    const finish = (result: ScanResult) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolvePromise(result);
    };
    const testLine = (line: string): boolean => line.startsWith('+') && hasSuspectedSecret(line.slice(1));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 2_000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      scanned += chunk.length;
      if (scanned > maxBytes) return finish({ ok: false, code: 'scan_limit_exceeded' });
      pending += chunk.toString('latin1');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (testLine(line)) return finish({ ok: false, code: 'secret_detected' });
      if (pending.length > 1_048_576) {
        // A single enormous line: test it in full, then keep an overlap so a match cannot straddle the cut.
        if (testLine(pending)) return finish({ ok: false, code: 'secret_detected' });
        pending = `+${pending.slice(-4_096)}`;
      }
    });
    child.on('error', (error) => finish({ ok: false, code: 'scan_failed', detail: String(error) }));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish({ ok: false, code: 'scan_failed', detail: stderr.trim() });
      if (testLine(pending)) return finish({ ok: false, code: 'secret_detected' });
      finish({ ok: true, scannedBytes: scanned });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Advancement

/**
 * Advances the Goal ref from the cycle's base commit to the tip of the run's branch. All Git values are derived
 * from persisted state and the repository; the caller supplies only identities, the expected current head and a
 * deterministic policy. Cycle status transitions and Goal state changes stay supervisor-owned.
 */
export async function advanceGoalRef(
  db: Db,
  input: { goalId: string; cycleId: string; runId: string; expectedHead: string },
  policy: IntegrationPolicy = {},
  hooks: IntegrationHooks = {},
): Promise<AdvanceResult> {
  const checks: IntegrationCheck[] = [];
  const reject = (code: string, message: string, detail?: unknown): AdvanceResult => {
    checks.push({ check: code, ok: false, ...(detail === undefined ? {} : { detail }) });
    return { outcome: 'rejected', code, message, checks };
  };
  const pass = (check: string, detail?: unknown) =>
    checks.push({ check, ok: true, ...(detail === undefined ? {} : { detail }) });

  let context: GoalContext;
  try {
    context = loadContext(db, input.goalId);
  } catch (error) {
    if (error instanceof GoalGitError) return reject(error.code, error.message);
    throw error;
  }
  const { repoRoot, ref } = context;
  const format = await repositoryObjectFormat(repoRoot);
  const h0 = input.expectedHead;
  if (!isObjectId(h0, format))
    return reject('invalid_expected_head', 'Expected head is not a full object id.');

  const allowed = policy.allowedGoalStatuses ?? ['running'];
  if (!allowed.includes(context.status))
    return reject('goal_status', `The Goal is ${context.status}.`, { status: context.status });
  pass('goal_status', context.status);

  const runtime = runtimeRow(db, input.goalId);
  if (!runtime?.integration_head || runtime.goal_branch !== context.branch)
    return reject('goal_not_initialized', 'The Goal has no initialised integration ref.');
  if (pendingOp(db, input.goalId))
    return reject('pending_operation', 'An earlier integration operation is unresolved; run recovery first.');

  const cycle = db.prepare('SELECT * FROM goal_cycles WHERE id = ?').get(input.cycleId) as
    { goal_id: string; base_integration_commit: string | null } | undefined;
  if (!cycle || cycle.goal_id !== input.goalId)
    return reject('cycle_mismatch', 'The cycle does not belong to the Goal.');
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as
    | {
        goal_cycle_id: string | null;
        goal_run_purpose: string | null;
        goal_base_commit: string | null;
        status: string;
        branch: string | null;
        worktree_path: string | null;
        project_id: string;
      }
    | undefined;
  if (!run || run.goal_cycle_id !== input.cycleId)
    return reject('run_mismatch', 'The run does not belong to the cycle.');
  if (run.project_id !== context.projectId)
    return reject('run_mismatch', 'The run belongs to a different project.');
  if (!run.goal_run_purpose || !INTEGRATION_PURPOSES.has(run.goal_run_purpose))
    return reject('run_purpose', `A ${run.goal_run_purpose} run is not integrated.`);
  pass('identity');
  if (
    !run.goal_base_commit ||
    run.goal_base_commit !== h0 ||
    cycle.base_integration_commit !== h0 ||
    runtime.integration_head !== h0
  )
    return reject(
      'base_mismatch',
      'Run base, cycle base, runtime head and the expected head must all agree.',
      {
        expected: h0,
        run: run.goal_base_commit,
        cycle: cycle.base_integration_commit,
        runtime: runtime.integration_head,
      },
    );
  pass('base_agreement', h0);

  const actualRef = await readRef(repoRoot, ref);
  if (!actualRef) return reject('goal_ref_missing', 'The Goal ref does not exist.');
  if (actualRef !== h0)
    return reject('goal_ref_changed', 'The Goal ref is not at the expected head.', { actualRef });
  const occupied = await checkedOutAt(repoRoot, ref);
  if (occupied)
    return reject('goal_branch_checked_out', 'The Goal branch is checked out in a worktree.', { occupied });
  pass('goal_ref', actualRef);

  if (run.status !== 'completed') return reject('run_not_completed', `The run is ${run.status}.`);
  pass('run_completed');
  const unclean = db
    .prepare(
      `SELECT stage_key, status FROM stages WHERE run_id = ? AND status NOT IN ('passed', 'skipped') ORDER BY sequence`,
    )
    .all(input.runId) as Array<{ stage_key: string; status: string }>;
  if (unclean.length) {
    // continueOnFailure lets a run reach 'completed' past a failed stage; that outcome is never integration-safe.
    const failed = unclean.filter((stage) => stage.status === 'failed' || stage.status === 'cancelled');
    return reject(
      failed.length ? 'run_stage_failed' : 'run_stage_incomplete',
      `${unclean.length} stage(s) did not conclude cleanly.`,
      { stages: unclean.slice(0, 20) },
    );
  }
  pass('stages_clean');

  const expectedBranch = `turing/${input.runId.slice(0, 8)}`;
  if (!run.branch || run.branch !== expectedBranch || !RUN_BRANCH.test(run.branch))
    return reject('worktree_mismatch', 'The run branch is not the expected run branch.');
  if (!run.worktree_path || !existsSync(run.worktree_path))
    return reject('worktree_missing', 'The run worktree no longer exists.');
  const [commonRepo, commonWorktree, worktreeBranch, worktreeHead, tip] = await Promise.all([
    gitTry(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitTry(run.worktree_path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitTry(run.worktree_path, ['branch', '--show-current']),
    gitTry(run.worktree_path, ['rev-parse', 'HEAD']),
    gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}^{commit}`]),
  ]);
  if (
    !commonRepo.ok ||
    !commonWorktree.ok ||
    realpathSync(commonRepo.stdout.trim()) !== realpathSync(commonWorktree.stdout.trim())
  )
    return reject('worktree_mismatch', 'The run worktree does not belong to the registered repository.');
  if (!worktreeBranch.ok || worktreeBranch.stdout.trim() !== run.branch)
    return reject('worktree_mismatch', 'The run worktree is not on the recorded run branch.');
  const t = tip.ok ? tip.stdout.trim() : '';
  if (!t) return reject('worktree_mismatch', 'The run branch does not exist.');
  if (!worktreeHead.ok || worktreeHead.stdout.trim() !== t)
    return reject('worktree_head_mismatch', 'The run worktree HEAD is not the run branch tip.');
  const status = await gitTry(run.worktree_path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok || status.stdout.trim())
    return reject('worktree_dirty', 'The run worktree has uncommitted or untracked changes.');
  pass('worktree', { branch: run.branch, tip: t });

  if (t === h0) return { outcome: 'no_change', head: h0 };
  const ancestor = await gitTry(repoRoot, ['merge-base', '--is-ancestor', h0, t]);
  if (!ancestor.ok)
    return reject('not_descendant', 'The run tip is not a strict descendant of the Goal head.', { h0, t });
  pass('descendant', { h0, t });

  const entries = await changedEntries(repoRoot, h0, t);
  const violations = checkChangedPaths(entries, context.scope, policy.allowedPaths);
  if (violations.length)
    return reject(
      violations[0]!.code,
      `Changed paths violate the integration policy (${violations.length}).`,
      {
        violations: violations.slice(0, 50),
      },
    );
  const changedPaths = changedPathSet(entries);
  pass('paths', { count: changedPaths.length });

  const scan = await scanChangedContent(repoRoot, h0, t, policy.maxScanBytes);
  if (!scan.ok)
    return reject(scan.code, 'The complete changed content could not be cleared by the secret scan.', scan);
  pass('secret_scan', { scannedBytes: scan.scannedBytes });

  const opId = randomUUID();
  db.prepare(
    `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, run_id, op, expected_old, new_commit, status, checks_json, created_at)
     VALUES (?, ?, ?, ?, 'advance', ?, ?, 'planned', ?, ?)`,
  ).run(
    opId,
    input.goalId,
    input.cycleId,
    input.runId,
    h0,
    t,
    JSON.stringify(checks),
    new Date().toISOString(),
  );
  await hooks.beforeCas?.();
  const moved = await gitTry(repoRoot, [
    '-c',
    `core.hooksPath=${disabledHooksPath()}`,
    'update-ref',
    '-m',
    `turing goal ${input.goalId} cycle ${input.cycleId}`,
    ref,
    t,
    h0,
  ]);
  if (!moved.ok) {
    resolveOp(db, opId, 'failed', 'goal_ref_conflict', {
      observedRef: await readRef(repoRoot, ref),
      stderr: redactSecrets(moved.stderr.slice(0, 500)),
    });
    return { outcome: 'conflict', code: 'goal_ref_conflict', opId };
  }
  completeOp(db, readOp(db, opId)!);
  return { outcome: 'advanced', opId, from: h0, to: t, changedPaths };
}

// ---------------------------------------------------------------------------------------------------------------
// Recovery

/**
 * Resolves unresolved (planned) operations by reading the ref; it never performs a ref update itself.
 *   ref == new_commit   -> the CAS happened: finish the database side
 *   ref == expected_old -> the CAS did not happen: abort the op (the supervisor re-runs checks before retrying)
 *   ref absent (init)   -> the creation did not happen: abort
 *   anything else       -> goal_ref_changed; the op stays planned, nothing is moved or rewritten
 * Safe to call repeatedly.
 */
export async function recoverIntegrationOps(db: Db, goalId: string): Promise<RecoveryResult[]> {
  const context = loadContext(db, goalId);
  const results: RecoveryResult[] = [];
  const ops = db
    .prepare(
      "SELECT * FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned' ORDER BY created_at",
    )
    .all(goalId) as OpRow[];
  for (const op of ops) {
    if (op.op === 'apply_to_base') {
      results.push({ opId: op.id, op: op.op, outcome: 'skipped', observedRef: null });
      continue;
    }
    const observed = await readRef(context.repoRoot, context.ref);
    if (observed === op.new_commit) {
      completeOp(db, op);
      results.push({ opId: op.id, op: op.op, outcome: 'completed', observedRef: observed });
    } else if (
      (op.op === 'advance' && observed === op.expected_old) ||
      (op.op === 'init_ref' && observed === null)
    ) {
      resolveOp(db, op.id, 'aborted', 'cas_not_applied', { observedRef: observed });
      results.push({ opId: op.id, op: op.op, outcome: 'aborted', observedRef: observed });
    } else {
      results.push({ opId: op.id, op: op.op, outcome: 'goal_ref_changed', observedRef: observed });
    }
  }
  return results;
}

export type GoalRefVerification =
  | { ok: true; head: string }
  | {
      ok: false;
      code: 'goal_not_initialized' | 'goal_ref_missing' | 'goal_ref_changed' | 'goal_branch_checked_out';
    };

/** Preflight for every Goal start/resume: the ref exists, equals the recorded head, and is not checked out. */
export async function verifyGoalRef(db: Db, goalId: string): Promise<GoalRefVerification> {
  const context = loadContext(db, goalId);
  const runtime = runtimeRow(db, goalId);
  if (!runtime?.integration_head) return { ok: false, code: 'goal_not_initialized' };
  const actual = await readRef(context.repoRoot, context.ref);
  if (!actual) return { ok: false, code: 'goal_ref_missing' };
  if (actual !== runtime.integration_head) return { ok: false, code: 'goal_ref_changed' };
  if (await checkedOutAt(context.repoRoot, context.ref))
    return { ok: false, code: 'goal_branch_checked_out' };
  return { ok: true, head: actual };
}

// ---------------------------------------------------------------------------------------------------------------
// Final apply (preflight only)

/**
 * Read-only preflight for applying the Goal ref to the user's base branch. The actual fast-forward is not exposed
 * here: it must sit behind the future final_apply approval, which re-runs these checks immediately before acting.
 */
export async function preflightFinalApply(
  db: Db,
  goalId: string,
  options: { previewChars?: number } = {},
): Promise<FinalApplyPreflight> {
  const context = loadContext(db, goalId);
  const runtime = runtimeRow(db, goalId);
  const result: FinalApplyPreflight = {
    status: 'goal_not_initialized',
    recordedBaseBranch: runtime?.base_branch ?? null,
    recordedBaseCommit: runtime?.base_commit ?? null,
    currentBranch: null,
    currentHead: null,
    dirty: null,
    integrationHead: runtime?.integration_head ?? null,
    goalRef: null,
    fastForwardPossible: null,
    ahead: null,
    behind: null,
    changedPaths: [],
    safety: { ok: true, violations: [] },
    diffStat: '',
    diffPreview: '',
    diffPreviewTruncated: false,
  };
  if (!runtime?.integration_head || !runtime.base_branch || !runtime.base_commit) return result;
  const { repoRoot } = context;
  const head = runtime.integration_head;
  const base = runtime.base_commit;
  const goalRef = await readRef(repoRoot, context.ref);
  result.goalRef = goalRef;
  result.currentBranch = (await gitTry(repoRoot, ['branch', '--show-current'])).stdout.trim() || null;
  const currentHead = await gitTry(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  result.currentHead = currentHead.ok ? currentHead.stdout.trim() : null;
  const porcelain = await gitTry(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  result.dirty = porcelain.ok ? porcelain.stdout.trim().length > 0 : null;

  if (goalRef && result.currentHead) {
    const counts = await gitTry(repoRoot, [
      'rev-list',
      '--left-right',
      '--count',
      `${result.currentHead}...${goalRef}`,
    ]);
    if (counts.ok) {
      const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
      result.ahead = left ?? null;
      result.behind = right ?? null;
    }
    result.fastForwardPossible = (
      await gitTry(repoRoot, ['merge-base', '--is-ancestor', result.currentHead, goalRef])
    ).ok;
  }
  // Complete path and content safety over base_commit..integration_head, independent of the display preview.
  const baseKnown = (await gitTry(repoRoot, ['cat-file', '-e', `${base}^{commit}`])).ok;
  const headKnown = (await gitTry(repoRoot, ['cat-file', '-e', `${head}^{commit}`])).ok;
  if (baseKnown && headKnown) {
    const entries = await changedEntries(repoRoot, base, head);
    result.changedPaths = changedPathSet(entries);
    const violations: PathViolation[] = checkChangedPaths(entries, context.scope);
    const scan = await scanChangedContent(repoRoot, base, head);
    if (!scan.ok) violations.push({ code: scan.code });
    result.safety = { ok: violations.length === 0, violations: violations.slice(0, 50) };
    result.diffStat = redactSecrets(
      (await gitTry(repoRoot, ['diff', '--stat', '--no-color', '--no-ext-diff', base, head, '--'])).stdout,
    );
    const diff = redactSecrets(
      (await gitTry(repoRoot, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', base, head, '--']))
        .stdout,
    );
    const limit = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
    result.diffPreviewTruncated = diff.length > limit;
    result.diffPreview = diff.slice(0, limit);
  }

  if (goalRef !== head || (await checkedOutAt(repoRoot, context.ref))) result.status = 'goal_ref_changed';
  else if (result.currentBranch !== runtime.base_branch) result.status = 'wrong_branch';
  else if (result.dirty !== false) result.status = 'dirty_checkout';
  else if (result.currentHead !== base) result.status = 'base_diverged';
  else if (result.fastForwardPossible !== true) result.status = 'not_fast_forward';
  else if (!result.safety.ok) result.status = 'unsafe_changes';
  else result.status = 'ready_for_approved_apply';
  return result;
}
