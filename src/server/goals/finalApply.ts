import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Db } from '../db.js';
import {
  changedEntries,
  changedPathSet,
  disabledHooksPath,
  loadContext,
  repositoryObjectFormat,
  type RecoveryResult,
} from '../goalGit.js';
import {
  assertFinalApplyOperationDatabaseCurrent,
  validateFinalApplyAuthority,
  type FinalApplyIntent,
  type PlannedFinalApplyAllowance,
} from './finalApplyAuthority.js';
import {
  createFinalApplyOperationRecord,
  computeFinalApplyRepositoryIdentity,
  findApplyRefLogEvidence,
  parseFinalApplyOperationRecord,
  parseFinalApplyRecoveryProof,
  validateFinalApplyOperationApproval,
  type FinalApplyOperationRecord,
  type FinalApplyRecoveryProof,
} from './finalApplyOperation.js';

export type FinalApplyRefusalReason = 'stale_approval' | 'changed_git_state' | 'unresolved_prior_operation';

export type FinalApplyResult =
  | { outcome: 'applied'; operationId: string; commit: string }
  | { outcome: 'already_applied'; operationId: string; commit: string }
  | { outcome: 'refused'; reason: FinalApplyRefusalReason; code: string }
  | { outcome: 'concurrent_ref_conflict'; operationId: string; code: 'ref_compare_and_swap_failed' }
  | { outcome: 'git_operation_failed'; operationId?: string; code: 'git_operation_failed' }
  | { outcome: 'checkout_index_sync_incomplete'; operationId: string; code: 'checkout_index_sync_incomplete' }
  | {
      outcome: 'manual_reconciliation_required';
      operationId?: string;
      code: 'manual_reconciliation_required';
    };

/** Deterministic crash/race seams. They are optional and are only used by direct isolated-repository tests. */
export interface FinalApplyHooks {
  beforePlanPersist?: () => void;
  afterPlanPersist?: () => void;
  beforeCas?: () => void;
  afterCas?: () => void;
  beforeCheckoutSync?: () => void;
  beforeReadTree?: () => void;
  afterCheckoutSync?: () => void;
  beforeAppliedRecord?: () => void;
  afterAppliedRecord?: () => void;
}

export class FinalApplyInjectedCrash extends Error {
  constructor(readonly boundary: string) {
    super(`Injected final-apply crash at ${boundary}.`);
    this.name = 'FinalApplyInjectedCrash';
  }
}

interface ApplyOpRow {
  id: string;
  goal_id: string;
  approval_id: string | null;
  op: string;
  expected_old: string | null;
  new_commit: string;
  status: string;
  checks_json: string;
  recovery_json: string | null;
  created_at: string;
  finished_at: string | null;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  code: number;
}

class ApplyIssue extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  return env;
}

function gitResult(cwd: string, args: string[], input?: string): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnvironment(),
    });
    return { ok: true, stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number | null };
    return { ok: false, stdout: failure.stdout ?? '', code: failure.status ?? 128 };
  }
}

function gitRead(cwd: string, args: string[], code = 'git_operation_failed'): string {
  const result = gitResult(cwd, args);
  if (!result.ok) throw new ApplyIssue(code);
  return result.stdout.trim();
}

function gitReadRaw(cwd: string, args: string[], code = 'git_operation_failed'): string {
  const result = gitResult(cwd, args);
  if (!result.ok) throw new ApplyIssue(code);
  return result.stdout;
}

function readCommitRef(cwd: string, ref: string): string | null {
  const result = gitResult(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

function commandIsClean(cwd: string, args: string[]): boolean {
  return gitResult(cwd, args).code === 0;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

function parseWorktrees(raw: string): WorktreeEntry[] {
  return raw
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const pathLine = lines.find((line) => line.startsWith('worktree '));
      return {
        path: pathLine?.slice('worktree '.length) ?? '',
        branch: lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? null,
        detached: lines.includes('detached'),
        bare: lines.includes('bare'),
      };
    });
}

function currentWorktreeLayout(repoRoot: string): { entries: WorktreeEntry[]; digest: string } {
  const raw = gitRead(repoRoot, ['worktree', 'list', '--porcelain'], 'worktree_state_unreadable');
  const entries = parseWorktrees(raw);
  // Git includes each worktree's current HEAD in this output. The registered layout must remain
  // stable when the approved destination ref advances, so hash registration details without HEAD.
  const normalized = raw
    .trim()
    .split(/\n\n+/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !line.startsWith('HEAD '))
        .join('\n'),
    )
    .sort()
    .join('\n\n');
  return { entries, digest: sha256(normalized) };
}

function objectFormatAt(repoRoot: string): 'sha1' | 'sha256' {
  const format = gitRead(repoRoot, ['rev-parse', '--show-object-format'], 'wrong_repository');
  if (format !== 'sha1' && format !== 'sha256') throw new ApplyIssue('unsupported_object_format');
  return format;
}

function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function assertRefName(repoRoot: string, ref: string): void {
  if (!ref.startsWith('refs/heads/') || !gitResult(repoRoot, ['check-ref-format', ref]).ok)
    throw new ApplyIssue('invalid_git_ref');
  if (gitResult(repoRoot, ['symbolic-ref', '--quiet', ref]).ok)
    throw new ApplyIssue('symbolic_branch_ref_unsupported');
}

function isSparseCheckout(repoRoot: string): boolean {
  const sparseCheckout = gitResult(repoRoot, ['config', '--bool', 'core.sparseCheckout']);
  const sparseIndex = gitResult(repoRoot, ['config', '--bool', 'core.sparseIndex']);
  return (
    (sparseCheckout.ok && sparseCheckout.stdout.trim() === 'true') ||
    (sparseIndex.ok && sparseIndex.stdout.trim() === 'true')
  );
}

function hasGitlinks(repoRoot: string, commit: string): boolean {
  const tree = gitResult(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  if (!tree.ok) throw new ApplyIssue('git_object_unreadable');
  return tree.stdout.split('\0').some((entry) => entry.split(' ')[0] === '160000');
}

function indexLockPath(repoRoot: string): string {
  const path = gitRead(repoRoot, ['rev-parse', '--git-path', 'index.lock'], 'index_unreadable');
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function untrackedPaths(repoRoot: string): string[] {
  const output = gitReadRaw(repoRoot, ['ls-files', '--others', '-z', '--full-name'], 'checkout_unreadable');
  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replace(/\/$/, ''));
}

function overlapsFileOrDirectory(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function hasUntrackedTargetCollision(repoRoot: string, writePaths: readonly string[]): boolean {
  const loose = untrackedPaths(repoRoot);
  return writePaths.some((target) => loose.some((path) => overlapsFileOrDirectory(path, target)));
}

function assertWorktreeLayout(
  repoRoot: string,
  record: FinalApplyOperationRecord,
  expectedDigest: string,
): void {
  assertRefName(repoRoot, record.destination.ref);
  assertRefName(repoRoot, record.source.ref);
  if (gitRead(repoRoot, ['rev-parse', '--is-bare-repository'], 'wrong_repository') !== 'false')
    throw new ApplyIssue('unsupported_checkout_layout');
  const topLevel = gitRead(repoRoot, ['rev-parse', '--show-toplevel'], 'wrong_repository');
  if (canonicalPath(topLevel) !== repoRoot) throw new ApplyIssue('registered_checkout_changed');
  const layout = currentWorktreeLayout(repoRoot);
  if (layout.digest !== expectedDigest) throw new ApplyIssue('worktree_registration_changed');
  const baseWorktrees = layout.entries.filter((entry) => entry.branch === record.destination.ref);
  if (baseWorktrees.length !== 1 || canonicalPath(baseWorktrees[0]!.path) !== repoRoot)
    throw new ApplyIssue('destination_worktree_mismatch');
  if (layout.entries.some((entry) => entry.branch === record.source.ref))
    throw new ApplyIssue('goal_branch_checked_out');
  if (isSparseCheckout(repoRoot)) throw new ApplyIssue('unsupported_sparse_checkout');
  if (existsSync(indexLockPath(repoRoot))) throw new ApplyIssue('index_locked');
  if (gitRead(repoRoot, ['ls-files', '-u', '-z'], 'index_unreadable')) throw new ApplyIssue('unmerged_index');
  if (
    hasGitlinks(repoRoot, record.destination.expectedBaseCommit) ||
    hasGitlinks(repoRoot, record.source.integrationHead)
  )
    throw new ApplyIssue('unsupported_submodule_checkout');
}

function assertRepositoryIdentity(db: Db, goalId: string, record: FinalApplyOperationRecord): string {
  const context = loadContext(db, goalId);
  if (context.goalId !== record.goalId || context.ref !== record.source.ref)
    throw new ApplyIssue('wrong_repository');
  const commonPath = gitRead(context.repoRoot, ['rev-parse', '--git-common-dir'], 'wrong_repository');
  const commonDir = canonicalPath(
    isAbsolute(commonPath) ? commonPath : resolve(context.repoRoot, commonPath),
  );
  if (!commonDir) throw new ApplyIssue('wrong_repository');
  const identity = computeFinalApplyRepositoryIdentity(
    context.projectId,
    context.repoRoot,
    commonDir,
    context.scope,
  );
  if (identity !== record.repositoryIdentity) throw new ApplyIssue('wrong_repository');
  return commonDir;
}

function assertBeforeCas(db: Db, record: FinalApplyOperationRecord, writePaths: readonly string[]): void {
  const context = loadContext(db, record.goalId);
  const { repoRoot } = context;
  if (objectFormatAt(repoRoot) !== record.objectFormat) throw new ApplyIssue('object_format_changed');
  assertRepositoryIdentity(db, record.goalId, record);
  assertWorktreeLayout(repoRoot, record, record.preflight.worktreeLayoutDigest);
  const branch = gitRead(
    repoRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'detached_or_wrong_checkout',
  );
  const head = readCommitRef(repoRoot, 'HEAD');
  const destination = readCommitRef(repoRoot, record.destination.ref);
  const source = readCommitRef(repoRoot, record.source.ref);
  if (branch !== record.intent.destination.baseBranch || head !== record.destination.expectedBaseCommit)
    throw new ApplyIssue('checkout_changed');
  if (destination !== record.destination.expectedBaseCommit || source !== record.source.integrationHead)
    throw new ApplyIssue('ref_changed');
  const status = gitRead(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (status.trim()) throw new ApplyIssue('dirty_checkout');
  if (
    !commandIsClean(repoRoot, [
      'diff-index',
      '--cached',
      '--quiet',
      record.destination.expectedBaseCommit,
      '--',
    ])
  )
    throw new ApplyIssue('index_changed');
  if (!commandIsClean(repoRoot, ['diff-files', '--quiet', '--'])) throw new ApplyIssue('worktree_changed');
  const ancestor = gitResult(repoRoot, [
    'merge-base',
    '--is-ancestor',
    record.destination.expectedBaseCommit,
    record.source.integrationHead,
  ]);
  if (!ancestor.ok) throw new ApplyIssue('not_fast_forward');
  if (hasUntrackedTargetCollision(repoRoot, writePaths)) throw new ApplyIssue('untracked_target_collision');
}

function assertReadyForCheckoutSync(
  db: Db,
  record: FinalApplyOperationRecord,
  writePaths: readonly string[],
): void {
  const context = loadContext(db, record.goalId);
  const { repoRoot } = context;
  assertRepositoryIdentity(db, record.goalId, record);
  assertWorktreeLayout(repoRoot, record, record.preflight.worktreeLayoutDigest);
  const branch = gitRead(
    repoRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'detached_or_wrong_checkout',
  );
  const head = readCommitRef(repoRoot, 'HEAD');
  const destination = readCommitRef(repoRoot, record.destination.ref);
  const source = readCommitRef(repoRoot, record.source.ref);
  if (
    branch !== record.intent.destination.baseBranch ||
    head !== record.source.integrationHead ||
    destination !== record.source.integrationHead ||
    source !== record.source.integrationHead
  )
    throw new ApplyIssue('ref_or_checkout_changed_after_cas');
  if (
    !commandIsClean(repoRoot, [
      'diff-index',
      '--cached',
      '--quiet',
      record.destination.expectedBaseCommit,
      '--',
    ])
  )
    throw new ApplyIssue('index_changed_after_cas');
  if (!commandIsClean(repoRoot, ['diff-files', '--quiet', '--']))
    throw new ApplyIssue('worktree_changed_after_cas');
  if (hasUntrackedTargetCollision(repoRoot, writePaths)) throw new ApplyIssue('untracked_target_collision');
}

function buildSuccessProof(
  repoRoot: string,
  record: FinalApplyOperationRecord,
  commonDir: string,
): FinalApplyRecoveryProof {
  const branch = gitRead(
    repoRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'checkout_index_sync_incomplete',
  );
  const head = readCommitRef(repoRoot, 'HEAD');
  const destination = readCommitRef(repoRoot, record.destination.ref);
  const source = readCommitRef(repoRoot, record.source.ref);
  if (
    branch !== record.intent.destination.baseBranch ||
    head !== record.source.integrationHead ||
    destination !== record.source.integrationHead ||
    source !== record.source.integrationHead
  )
    throw new ApplyIssue('checkout_index_sync_incomplete');
  if (!commandIsClean(repoRoot, ['diff-index', '--cached', '--quiet', record.source.integrationHead, '--']))
    throw new ApplyIssue('checkout_index_sync_incomplete');
  if (!commandIsClean(repoRoot, ['diff-files', '--quiet', '--']))
    throw new ApplyIssue('checkout_index_sync_incomplete');
  const status = gitRead(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (status.trim()) throw new ApplyIssue('checkout_index_sync_incomplete');
  assertWorktreeLayout(repoRoot, record, record.preflight.worktreeLayoutDigest);
  const reflog = findApplyRefLogEvidence(
    commonDir,
    record.destination.ref,
    record.destination.expectedBaseCommit,
    record.source.integrationHead,
    record.reflogMessage,
  );
  if (!reflog) throw new ApplyIssue('manual_reconciliation_required');
  return {
    schemaVersion: 1,
    operationDigest: record.operationDigest,
    refLog: {
      message: record.reflogMessage,
      oldCommit: record.destination.expectedBaseCommit,
      newCommit: record.source.integrationHead,
      lineDigest: reflog.lineDigest,
    },
    checkout: {
      branch,
      head,
      baseRef: record.destination.ref,
      indexMatchesHead: true,
      worktreeMatchesIndex: true,
      clean: true,
      registeredCheckout: true,
      noTargetCollision: true,
    },
    verifiedAt: new Date().toISOString(),
  };
}

function updateObservation(db: Db, id: string, observation: Record<string, unknown>): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE goal_integration_ops SET recovery_json = ?
       WHERE id = ? AND op = 'apply_to_base' AND status = 'planned'`,
    ).run(JSON.stringify(observation), id);
  })();
}

function finishAborted(db: Db, id: string, observation: Record<string, unknown>): boolean {
  const result = db
    .prepare(
      `UPDATE goal_integration_ops SET status = 'aborted', error_code = 'cas_not_applied',
         finished_at = ?, recovery_json = ?
       WHERE id = ? AND op = 'apply_to_base' AND status = 'planned'`,
    )
    .run(new Date().toISOString(), JSON.stringify(observation), id);
  return result.changes === 1;
}

function finishApplied(db: Db, id: string, proof: FinalApplyRecoveryProof): boolean {
  const result = db
    .prepare(
      `UPDATE goal_integration_ops SET status = 'applied', error_code = NULL, finished_at = ?, recovery_json = ?
       WHERE id = ? AND op = 'apply_to_base' AND status = 'planned'`,
    )
    .run(new Date().toISOString(), JSON.stringify(proof), id);
  return result.changes === 1;
}

function readApplyOp(db: Db, id: string): ApplyOpRow | undefined {
  return db.prepare('SELECT * FROM goal_integration_ops WHERE id = ?').get(id) as ApplyOpRow | undefined;
}

function authorityAllowance(record: FinalApplyOperationRecord): PlannedFinalApplyAllowance {
  return {
    operationId: record.operationId,
    approvalId: record.approvalId,
    operationDigest: record.operationDigest,
    intent: record.intent,
  };
}

function mapAuthorityRefusal(code: string): FinalApplyResult {
  if (code === 'integration_operation_in_progress')
    return { outcome: 'refused', reason: 'unresolved_prior_operation', code };
  if (code.startsWith('preflight_') || code === 'preflight_not_ready')
    return { outcome: 'refused', reason: 'changed_git_state', code };
  return { outcome: 'refused', reason: 'stale_approval', code };
}

function inspectWritePaths(
  entries: Awaited<ReturnType<typeof changedEntries>>,
  intent: FinalApplyIntent,
): {
  writePaths: string[];
  pathCount: number;
  digest: string;
} {
  const paths = changedPathSet(entries).sort();
  const digest = sha256(JSON.stringify(paths));
  if (digest !== intent.review.changedPathDigest) throw new ApplyIssue('changed_path_set_changed');
  return {
    writePaths: [
      ...new Set(entries.map((entry) => entry.newPath).filter((path): path is string => path !== null)),
    ],
    pathCount: paths.length,
    digest,
  };
}

function hasStaleSubmoduleChange(repoRoot: string, record: FinalApplyOperationRecord): boolean {
  return (
    hasGitlinks(repoRoot, record.destination.expectedBaseCommit) ||
    hasGitlinks(repoRoot, record.source.integrationHead)
  );
}

function checkInitialLayout(db: Db, record: FinalApplyOperationRecord): void {
  const context = loadContext(db, record.goalId);
  const { repoRoot } = context;
  if (objectFormatAt(repoRoot) !== record.objectFormat) throw new ApplyIssue('object_format_changed');
  assertRepositoryIdentity(db, record.goalId, record);
  assertRefName(repoRoot, record.destination.ref);
  assertRefName(repoRoot, record.source.ref);
  if (gitRead(repoRoot, ['rev-parse', '--is-bare-repository'], 'wrong_repository') !== 'false')
    throw new ApplyIssue('unsupported_checkout_layout');
  if (canonicalPath(gitRead(repoRoot, ['rev-parse', '--show-toplevel'], 'wrong_repository')) !== repoRoot)
    throw new ApplyIssue('registered_checkout_changed');
  if (isSparseCheckout(repoRoot)) throw new ApplyIssue('unsupported_sparse_checkout');
  if (existsSync(indexLockPath(repoRoot))) throw new ApplyIssue('index_locked');
  const layout = currentWorktreeLayout(repoRoot);
  if (layout.digest !== record.preflight.worktreeLayoutDigest)
    throw new ApplyIssue('worktree_registration_changed');
  const baseWorktrees = layout.entries.filter((entry) => entry.branch === record.destination.ref);
  if (baseWorktrees.length !== 1 || canonicalPath(baseWorktrees[0]!.path) !== repoRoot)
    throw new ApplyIssue('destination_worktree_mismatch');
  if (layout.entries.some((entry) => entry.branch === record.source.ref))
    throw new ApplyIssue('goal_branch_checked_out');
  if (hasStaleSubmoduleChange(repoRoot, record)) throw new ApplyIssue('unsupported_submodule_checkout');
  const branch = gitRead(
    repoRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'detached_or_wrong_checkout',
  );
  const head = readCommitRef(repoRoot, 'HEAD');
  const destination = readCommitRef(repoRoot, record.destination.ref);
  const source = readCommitRef(repoRoot, record.source.ref);
  if (branch !== record.intent.destination.baseBranch || head !== record.destination.expectedBaseCommit)
    throw new ApplyIssue('checkout_changed');
  if (destination !== record.destination.expectedBaseCommit || source !== record.source.integrationHead)
    throw new ApplyIssue('ref_changed');
  const status = gitRead(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (status.trim()) throw new ApplyIssue('dirty_checkout');
  if (
    !commandIsClean(repoRoot, [
      'diff-index',
      '--cached',
      '--quiet',
      record.destination.expectedBaseCommit,
      '--',
    ])
  )
    throw new ApplyIssue('index_changed');
  if (!commandIsClean(repoRoot, ['diff-files', '--quiet', '--'])) throw new ApplyIssue('worktree_changed');
}

function saveRefMovedObservation(db: Db, record: FinalApplyOperationRecord, lineDigest: string): void {
  const result = db
    .prepare(
      `UPDATE goal_integration_ops SET recovery_json = ?
       WHERE id = ? AND op = 'apply_to_base' AND status = 'planned' AND approval_id = ?`,
    )
    .run(
      JSON.stringify({
        stage: 'ref_moved',
        operationDigest: record.operationDigest,
        refLog: {
          message: record.reflogMessage,
          oldCommit: record.destination.expectedBaseCommit,
          newCommit: record.source.integrationHead,
          lineDigest,
        },
      }),
      record.operationId,
      record.approvalId,
    );
  if (result.changes !== 1) throw new ApplyIssue('operation_record_changed');
}

function executeCas(record: FinalApplyOperationRecord, repoRoot: string): GitResult {
  const protocol = [
    'start',
    `verify ${record.source.ref} ${record.source.integrationHead}`,
    `update ${record.destination.ref} ${record.source.integrationHead} ${record.destination.expectedBaseCommit}`,
    'prepare',
    'commit',
    '',
  ].join('\n');
  return gitResult(
    repoRoot,
    [
      '-c',
      `core.hooksPath=${disabledHooksPath()}`,
      'update-ref',
      '--no-deref',
      '--create-reflog',
      '-m',
      record.reflogMessage,
      '--stdin',
    ],
    protocol,
  );
}

async function loadWritePaths(
  db: Db,
  record: FinalApplyOperationRecord,
): Promise<{ writePaths: string[]; pathCount: number; digest: string }> {
  const context = loadContext(db, record.goalId);
  const entries = await changedEntries(
    context.repoRoot,
    record.destination.expectedBaseCommit,
    record.source.integrationHead,
  );
  return inspectWritePaths(entries, record.intent);
}

function makeProofForRecord(
  db: Db,
  record: FinalApplyOperationRecord,
  writePaths: readonly string[],
): FinalApplyRecoveryProof {
  const context = loadContext(db, record.goalId);
  if (objectFormatAt(context.repoRoot) !== record.objectFormat) throw new ApplyIssue('object_format_changed');
  const commonDir = assertRepositoryIdentity(db, record.goalId, record);
  const snapshot = buildSuccessProof(context.repoRoot, record, commonDir);
  if (hasUntrackedTargetCollision(context.repoRoot, writePaths))
    throw new ApplyIssue('checkout_index_sync_incomplete');
  return snapshot;
}

function sameRowAuthority(row: ApplyOpRow, record: FinalApplyOperationRecord): boolean {
  return (
    row.id === record.operationId &&
    row.goal_id === record.goalId &&
    row.approval_id === record.approvalId &&
    row.op === 'apply_to_base' &&
    row.expected_old === record.destination.expectedBaseCommit &&
    row.new_commit === record.source.integrationHead
  );
}

function readAppliedForApproval(db: Db, goalId: string, approvalId: string): ApplyOpRow | undefined {
  return db
    .prepare(
      `SELECT * FROM goal_integration_ops
       WHERE goal_id = ? AND approval_id = ? AND op = 'apply_to_base' AND status = 'applied'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(goalId, approvalId) as ApplyOpRow | undefined;
}

async function verifyAlreadyApplied(db: Db, row: ApplyOpRow): Promise<boolean> {
  const record = parseFinalApplyOperationRecord(row.checks_json);
  const proof = parseFinalApplyRecoveryProof(row.recovery_json);
  if (!record || !proof || !sameRowAuthority(row, record) || !validateFinalApplyOperationApproval(db, record))
    return false;
  try {
    const paths = await loadWritePaths(db, record);
    const observed = makeProofForRecord(db, record, paths.writePaths);
    return (
      observed.operationDigest === proof.operationDigest &&
      observed.refLog.lineDigest === proof.refLog.lineDigest &&
      observed.refLog.message === proof.refLog.message &&
      observed.refLog.oldCommit === proof.refLog.oldCommit &&
      observed.refLog.newCommit === proof.refLog.newCommit &&
      observed.checkout.head === proof.checkout.head &&
      observed.checkout.baseRef === proof.checkout.baseRef &&
      observed.checkout.branch === proof.checkout.branch
    );
  } catch {
    return false;
  }
}

function readPlannedForGoal(db: Db, goalId: string): ApplyOpRow | undefined {
  return db
    .prepare("SELECT * FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned' LIMIT 1")
    .get(goalId) as ApplyOpRow | undefined;
}

function refusalFromIssue(issue: ApplyIssue): FinalApplyResult {
  if (issue.code === 'git_operation_failed')
    return { outcome: 'git_operation_failed', code: 'git_operation_failed' };
  if (issue.code === 'manual_reconciliation_required')
    return { outcome: 'manual_reconciliation_required', code: 'manual_reconciliation_required' };
  return { outcome: 'refused', reason: 'changed_git_state', code: issue.code };
}

function resultForOutstandingRecovery(result: RecoveryResult, operationId: string): FinalApplyResult {
  if (result.outcome === 'checkout_index_sync_incomplete')
    return { outcome: 'checkout_index_sync_incomplete', operationId, code: 'checkout_index_sync_incomplete' };
  if (result.outcome === 'manual_reconciliation_required' || result.outcome === 'goal_ref_changed')
    return { outcome: 'manual_reconciliation_required', operationId, code: 'manual_reconciliation_required' };
  return { outcome: 'refused', reason: 'unresolved_prior_operation', code: result.outcome };
}

/**
 * Performs only the exact approved final apply. The prospective approval, operation plan, CAS and checkout sync are
 * deliberately server-internal; this module is not called by an HTTP route or background supervisor.
 */
export async function applyApprovedGoalToBase(
  db: Db,
  input: { goalId: string; approvalId: string },
  hooks: FinalApplyHooks = {},
): Promise<FinalApplyResult> {
  const priorApplied = readAppliedForApproval(db, input.goalId, input.approvalId);
  if (priorApplied) {
    if (await verifyAlreadyApplied(db, priorApplied))
      return { outcome: 'already_applied', operationId: priorApplied.id, commit: priorApplied.new_commit };
    return {
      outcome: 'manual_reconciliation_required',
      operationId: priorApplied.id,
      code: 'manual_reconciliation_required',
    };
  }

  const priorPlanned = readPlannedForGoal(db, input.goalId);
  if (priorPlanned) {
    if (priorPlanned.approval_id !== input.approvalId)
      return {
        outcome: 'refused',
        reason: 'unresolved_prior_operation',
        code: 'integration_operation_in_progress',
      };
    const recovery = recoverPlannedFinalApplyOperation(db, input.goalId, priorPlanned.id);
    const reconciled = readApplyOp(db, priorPlanned.id);
    if (reconciled?.status === 'applied' && (await verifyAlreadyApplied(db, reconciled)))
      return { outcome: 'already_applied', operationId: reconciled.id, commit: reconciled.new_commit };
    if (reconciled?.status !== 'aborted') return resultForOutstandingRecovery(recovery, priorPlanned.id);
  }

  const validation = await validateFinalApplyAuthority(db, input.goalId, input.approvalId, {
    expectedStatus: 'approved',
  });
  if (!validation.ok) return mapAuthorityRefusal(validation.code);
  const authority = validation.authority;
  let context;
  try {
    context = loadContext(db, input.goalId);
  } catch {
    return { outcome: 'refused', reason: 'changed_git_state', code: 'wrong_repository' };
  }

  let format: 'sha1' | 'sha256';
  let layout: { entries: WorktreeEntry[]; digest: string };
  let paths: { writePaths: string[]; pathCount: number; digest: string };
  try {
    format = await repositoryObjectFormat(context.repoRoot);
    layout = currentWorktreeLayout(context.repoRoot);
    const entries = await changedEntries(
      context.repoRoot,
      authority.intent.destination.expectedBaseCommit,
      authority.intent.source.integrationHead,
    );
    paths = inspectWritePaths(entries, authority.intent);
    if (paths.pathCount > 100_000) throw new ApplyIssue('changed_path_set_too_large');
  } catch (error) {
    const issue = error instanceof ApplyIssue ? error : new ApplyIssue('git_operation_failed');
    return refusalFromIssue(issue);
  }

  const operationId = randomUUID();
  const reflogMessage = `turing-final-apply:${operationId}`;
  const record = createFinalApplyOperationRecord({
    schemaVersion: 1,
    kind: 'turing_goal_final_apply_operation',
    operationId,
    goalId: input.goalId,
    approvalId: input.approvalId,
    intentDigest: authority.intent.intentDigest,
    intent: authority.intent,
    repositoryProjectId: authority.repositoryProjectId,
    repositoryIdentity: authority.intent.destination.repoIdentity,
    objectFormat: format,
    source: {
      ref: authority.intent.source.goalRef,
      integrationHead: authority.intent.source.integrationHead,
      integrationTree: authority.intent.source.integrationTree,
    },
    destination: {
      ref: authority.intent.destination.baseRef,
      expectedBaseCommit: authority.intent.destination.expectedBaseCommit,
      newCommit: authority.intent.source.integrationHead,
    },
    preflight: {
      status: 'ready_for_approved_apply',
      changedPathDigest: paths.digest,
      changedPathCount: paths.pathCount,
      worktreeLayoutDigest: layout.digest,
      fastForward: true,
      checkoutClean: true,
      registeredCheckout: true,
    },
    reflogMessage,
  });

  try {
    checkInitialLayout(db, record);
    if (hasUntrackedTargetCollision(context.repoRoot, paths.writePaths))
      throw new ApplyIssue('untracked_target_collision');
  } catch (error) {
    const issue = error instanceof ApplyIssue ? error : new ApplyIssue('git_operation_failed');
    return refusalFromIssue(issue);
  }

  hooks.beforePlanPersist?.();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO goal_integration_ops
         (id, goal_id, approval_id, op, expected_old, new_commit, status, checks_json, created_at)
         VALUES (?, ?, ?, 'apply_to_base', ?, ?, 'planned', ?, ?)`,
      ).run(
        record.operationId,
        record.goalId,
        record.approvalId,
        record.destination.expectedBaseCommit,
        record.source.integrationHead,
        JSON.stringify(record),
        new Date().toISOString(),
      );
    })();
  } catch {
    return { outcome: 'refused', reason: 'unresolved_prior_operation', code: 'planned_operation_conflict' };
  }
  hooks.afterPlanPersist?.();

  const allowance = authorityAllowance(record);
  const authorityDataVersion = db.pragma('data_version', { simple: true }) as number;
  const revalidated = await validateFinalApplyAuthority(db, input.goalId, input.approvalId, {
    expectedStatus: 'approved',
    allowPlannedOperation: allowance,
  });
  if (!revalidated.ok) {
    const recovered = recoverPlannedFinalApplyOperation(db, input.goalId, operationId);
    const op = readApplyOp(db, operationId);
    if (op?.status !== 'aborted') return resultForOutstandingRecovery(recovered, operationId);
    return mapAuthorityRefusal(revalidated.code);
  }

  let refreshedPaths: { writePaths: string[]; pathCount: number; digest: string };
  try {
    refreshedPaths = await loadWritePaths(db, record);
    if (refreshedPaths.digest !== record.preflight.changedPathDigest)
      throw new ApplyIssue('changed_path_set_changed');
  } catch (error) {
    const recovered = recoverPlannedFinalApplyOperation(db, input.goalId, operationId);
    const op = readApplyOp(db, operationId);
    if (op?.status !== 'aborted') return resultForOutstandingRecovery(recovered, operationId);
    const issue = error instanceof ApplyIssue ? error : new ApplyIssue('git_operation_failed');
    return { outcome: 'refused', reason: 'changed_git_state', code: issue.code };
  }

  try {
    db.transaction(() => {
      const current = readApplyOp(db, operationId);
      if (!current || current.status !== 'planned' || !sameRowAuthority(current, record))
        throw new ApplyIssue('operation_record_changed');
      assertBeforeCas(db, record, refreshedPaths.writePaths);
      hooks.beforeCas?.();
      if ((db.pragma('data_version', { simple: true }) as number) !== authorityDataVersion)
        throw new ApplyIssue('database_state_changed');
      try {
        assertFinalApplyOperationDatabaseCurrent(db, input.goalId, input.approvalId, allowance);
      } catch {
        throw new ApplyIssue('database_state_changed');
      }
      const contextAtCas = loadContext(db, input.goalId);
      const transaction = executeCas(record, contextAtCas.repoRoot);
      if (!transaction.ok) {
        const source = readCommitRef(contextAtCas.repoRoot, record.source.ref);
        const destination = readCommitRef(contextAtCas.repoRoot, record.destination.ref);
        if (source !== record.source.integrationHead || destination !== record.destination.expectedBaseCommit)
          throw new ApplyIssue('ref_compare_and_swap_failed');
        throw new ApplyIssue('git_operation_failed');
      }
      const commonDir = assertRepositoryIdentity(db, input.goalId, record);
      const reflog = findApplyRefLogEvidence(
        commonDir,
        record.destination.ref,
        record.destination.expectedBaseCommit,
        record.source.integrationHead,
        record.reflogMessage,
      );
      if (!reflog) throw new ApplyIssue('manual_reconciliation_required');
      saveRefMovedObservation(db, record, reflog.lineDigest);
    })();
  } catch (error) {
    if (error instanceof FinalApplyInjectedCrash) throw error;
    const recovery = recoverPlannedFinalApplyOperation(db, input.goalId, operationId);
    const row = readApplyOp(db, operationId);
    if (row?.status === 'applied' && (await verifyAlreadyApplied(db, row)))
      return { outcome: 'already_applied', operationId, commit: row.new_commit };
    const issue = error instanceof ApplyIssue ? error : new ApplyIssue('git_operation_failed');
    if (issue.code === 'ref_compare_and_swap_failed' || issue.code === 'ref_changed')
      return { outcome: 'concurrent_ref_conflict', operationId, code: 'ref_compare_and_swap_failed' };
    if (issue.code === 'git_operation_failed')
      return { outcome: 'git_operation_failed', operationId, code: 'git_operation_failed' };
    if (
      issue.code === 'manual_reconciliation_required' ||
      recovery.outcome === 'manual_reconciliation_required'
    )
      return {
        outcome: 'manual_reconciliation_required',
        operationId,
        code: 'manual_reconciliation_required',
      };
    if (row?.status === 'aborted')
      return { outcome: 'refused', reason: 'changed_git_state', code: issue.code };
    return resultForOutstandingRecovery(recovery, operationId);
  }

  hooks.afterCas?.();
  hooks.beforeCheckoutSync?.();
  try {
    const contextAfterCas = loadContext(db, input.goalId);
    assertReadyForCheckoutSync(db, record, refreshedPaths.writePaths);
    hooks.beforeReadTree?.();
    if (hasUntrackedTargetCollision(contextAfterCas.repoRoot, refreshedPaths.writePaths))
      throw new ApplyIssue('checkout_index_sync_incomplete');
    const sync = gitResult(contextAfterCas.repoRoot, [
      'read-tree',
      '-m',
      '-u',
      record.destination.expectedBaseCommit,
      record.source.integrationHead,
    ]);
    if (!sync.ok) throw new ApplyIssue('checkout_index_sync_incomplete');
    hooks.afterCheckoutSync?.();
    hooks.beforeAppliedRecord?.();
    const proof = makeProofForRecord(db, record, refreshedPaths.writePaths);
    if (!finishApplied(db, operationId, proof)) throw new ApplyIssue('manual_reconciliation_required');
    hooks.afterAppliedRecord?.();
    return { outcome: 'applied', operationId, commit: record.source.integrationHead };
  } catch (error) {
    if (error instanceof FinalApplyInjectedCrash) throw error;
    const issue = error instanceof ApplyIssue ? error : new ApplyIssue('checkout_index_sync_incomplete');
    const recovery = recoverPlannedFinalApplyOperation(db, input.goalId, operationId);
    const row = readApplyOp(db, operationId);
    if (row?.status === 'applied' && (await verifyAlreadyApplied(db, row)))
      return { outcome: 'already_applied', operationId, commit: row.new_commit };
    if (row?.status === 'applied')
      return {
        outcome: 'manual_reconciliation_required',
        operationId,
        code: 'manual_reconciliation_required',
      };
    if (
      issue.code === 'manual_reconciliation_required' ||
      recovery.outcome === 'manual_reconciliation_required'
    )
      return {
        outcome: 'manual_reconciliation_required',
        operationId,
        code: 'manual_reconciliation_required',
      };
    return { outcome: 'checkout_index_sync_incomplete', operationId, code: 'checkout_index_sync_incomplete' };
  }
}

/**
 * Observation-only recovery for one planned base operation. The SQLite write lock prevents a concurrent Turing
 * recovery from aborting a plan while its synchronous ref CAS is in progress. This function never writes a Git ref,
 * index, or worktree file.
 */
export function recoverPlannedFinalApplyOperation(
  db: Db,
  goalId: string,
  operationId: string,
): RecoveryResult {
  return db.transaction((): RecoveryResult => {
    const row = readApplyOp(db, operationId);
    if (!row || row.goal_id !== goalId || row.op !== 'apply_to_base' || row.status !== 'planned')
      return { opId: operationId, op: 'apply_to_base', outcome: 'skipped', observedRef: null };
    const record = parseFinalApplyOperationRecord(row.checks_json);
    if (!record || !sameRowAuthority(row, record) || !validateFinalApplyOperationApproval(db, record)) {
      updateObservation(db, operationId, {
        stage: 'manual_reconciliation_required',
        reason: 'invalid_operation_provenance',
      });
      return {
        opId: operationId,
        op: 'apply_to_base',
        outcome: 'manual_reconciliation_required',
        observedRef: null,
      };
    }

    let context;
    let commonDir: string;
    try {
      context = loadContext(db, goalId);
      commonDir = assertRepositoryIdentity(db, goalId, record);
      assertRefName(context.repoRoot, record.destination.ref);
      assertRefName(context.repoRoot, record.source.ref);
      if (objectFormatAt(context.repoRoot) !== record.objectFormat)
        throw new ApplyIssue('object_format_changed');
    } catch {
      updateObservation(db, operationId, {
        stage: 'manual_reconciliation_required',
        reason: 'repository_identity_changed',
      });
      return {
        opId: operationId,
        op: 'apply_to_base',
        outcome: 'manual_reconciliation_required',
        observedRef: null,
      };
    }

    const observedRef = readCommitRef(context.repoRoot, record.destination.ref);
    const observedSource = readCommitRef(context.repoRoot, record.source.ref);
    const reflog = findApplyRefLogEvidence(
      commonDir,
      record.destination.ref,
      record.destination.expectedBaseCommit,
      record.source.integrationHead,
      record.reflogMessage,
    );

    if (observedRef === record.destination.expectedBaseCommit && !reflog) {
      if (observedSource !== record.source.integrationHead) {
        updateObservation(db, operationId, {
          stage: 'manual_reconciliation_required',
          reason: 'approved_source_ref_changed',
          observedRef,
        });
        return {
          opId: operationId,
          op: 'apply_to_base',
          outcome: 'manual_reconciliation_required',
          observedRef,
        };
      }
      finishAborted(db, operationId, {
        stage: 'cas_not_applied',
        reason: 'destination_still_expected_old_without_operation_reflog',
        observedRef,
        observedSource,
      });
      return { opId: operationId, op: 'apply_to_base', outcome: 'aborted', observedRef };
    }

    if (
      observedRef !== record.source.integrationHead ||
      observedSource !== record.source.integrationHead ||
      !reflog
    ) {
      updateObservation(db, operationId, {
        stage: 'manual_reconciliation_required',
        reason: 'destination_or_source_does_not_prove_exact_operation',
        observedRef,
        observedSource,
      });
      return {
        opId: operationId,
        op: 'apply_to_base',
        outcome: 'manual_reconciliation_required',
        observedRef,
      };
    }

    try {
      const paths = gitResult(context.repoRoot, [
        'diff',
        '--raw',
        '-z',
        '-M',
        '-C',
        '--find-copies-harder',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        record.destination.expectedBaseCommit,
        record.source.integrationHead,
        '--',
      ]);
      if (!paths.ok) throw new ApplyIssue('git_operation_failed');
      const entries = parseChangedEntriesSynchronously(paths.stdout);
      const writePaths = entries
        .map((entry) => entry.newPath)
        .filter((path): path is string => path !== null);
      const proof = buildSuccessProof(context.repoRoot, record, commonDir);
      if (hasUntrackedTargetCollision(context.repoRoot, writePaths))
        throw new ApplyIssue('checkout_index_sync_incomplete');
      if (proof.refLog.lineDigest !== reflog.lineDigest)
        throw new ApplyIssue('manual_reconciliation_required');
      if (!finishApplied(db, operationId, proof)) {
        const current = readApplyOp(db, operationId);
        if (current?.status !== 'applied') throw new ApplyIssue('manual_reconciliation_required');
      }
      return { opId: operationId, op: 'apply_to_base', outcome: 'completed', observedRef };
    } catch (error) {
      const issue = error instanceof ApplyIssue ? error : new ApplyIssue('checkout_index_sync_incomplete');
      updateObservation(db, operationId, {
        stage: 'checkout_index_sync_incomplete',
        reason: issue.code,
        observedRef,
        observedSource,
      });
      return {
        opId: operationId,
        op: 'apply_to_base',
        outcome:
          issue.code === 'manual_reconciliation_required'
            ? 'manual_reconciliation_required'
            : 'checkout_index_sync_incomplete',
        observedRef,
      };
    }
  })();
}

function parseChangedEntriesSynchronously(raw: string) {
  // Kept synchronous for recovery: parsing raw diff metadata cannot mutate Git state or await a child process.
  const tokens = raw.split('\0');
  const entries: Array<{ oldPath: string | null; newPath: string | null }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const meta = tokens[index]!;
    if (!meta.startsWith(':')) continue;
    const [, , , , statusField = ''] = meta.split(' ');
    const status = statusField[0] ?? '';
    if (status === 'R' || status === 'C') {
      entries.push({ oldPath: tokens[index + 1] ?? null, newPath: tokens[index + 2] ?? null });
      index += 2;
    } else {
      const path = tokens[index + 1] ?? null;
      entries.push({ oldPath: status === 'A' ? null : path, newPath: status === 'D' ? null : path });
      index += 1;
    }
  }
  return entries;
}
