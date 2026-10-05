import { execFile as callbackExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from '../db.js';
import { gitTry, loadContext, verifyGoalRef, type GoalContext } from '../goalGit.js';

const execFile = promisify(callbackExecFile);

/**
 * Read-only repository access for Goal evidence, always against the Goal's integration state: Git objects at the
 * recorded integration head, never the user's checkout or any worktree.
 */
export interface GoalRepositoryState {
  goalId: string;
  repoRoot: string;
  /** Project folder relative to the repository root, POSIX; '' when the project is the repository root. */
  scope: string;
  head: string;
  tree: string;
}

export type GoalRepositoryResult =
  { ok: true; state: GoalRepositoryState } | { ok: false; code: string; detail: string };

/**
 * Resolves integrationHead = goal_runtime.integration_head and integrationTree = integrationHead^{tree}, after
 * verifying that the actual Goal ref still equals the recorded head. Any divergence makes repository evidence
 * unusable (the supervisor, not this module, decides how to react).
 */
export async function resolveGoalRepository(db: Db, goalId: string): Promise<GoalRepositoryResult> {
  let context: GoalContext;
  try {
    context = loadContext(db, goalId);
  } catch (error) {
    return { ok: false, code: 'goal_repository_unavailable', detail: String((error as Error).message) };
  }
  let verification;
  try {
    verification = await verifyGoalRef(db, goalId);
  } catch (error) {
    return { ok: false, code: 'goal_repository_unavailable', detail: String((error as Error).message) };
  }
  if (!verification.ok)
    return {
      ok: false,
      code: verification.code,
      detail: `The Goal ref check reported ${verification.code}.`,
    };
  const tree = await gitTry(context.repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${verification.head}^{tree}`,
  ]);
  if (!tree.ok || !tree.stdout.trim())
    return { ok: false, code: 'goal_tree_unreadable', detail: 'The integration head has no readable tree.' };
  return {
    ok: true,
    state: {
      goalId,
      repoRoot: context.repoRoot,
      scope: context.scope,
      head: verification.head,
      tree: tree.stdout.trim(),
    },
  };
}

/** A project-relative path made safe for lookup: no absolute, drive, home, parent traversal, NUL or `.git`. */
export function safeProjectPath(path: string): string | null {
  if (!path.trim() || path.length > 256) return null;
  if (/[\0\\]/.test(path) || path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path))
    return null;
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  if (segments.includes('..') || segments.some((segment) => segment.toLowerCase() === '.git')) return null;
  return segments.join('/');
}

export function repositoryPath(state: GoalRepositoryState, projectPath: string): string {
  return state.scope ? `${state.scope}/${projectPath}` : projectPath;
}

export interface BlobAtCommit {
  blob: string;
  sha256: string;
  size: number;
}

/**
 * Reads a regular file (not a symlink, submodule or directory) at `commit:<project path>`. `null` when the path does
 * not exist or is not a regular file. The path must already be project-relative and safe.
 */
export async function readBlobAtCommit(
  state: GoalRepositoryState,
  projectPath: string,
  commit: string = state.head,
): Promise<BlobAtCommit | null> {
  const path = repositoryPath(state, projectPath);
  const listing = await gitTry(state.repoRoot, ['ls-tree', '-z', commit, '--', path]);
  if (!listing.ok) return null;
  const entry = listing.stdout.split('\0').find((line) => line.endsWith(`\t${path}`));
  if (!entry) return null;
  const [meta] = entry.split('\t');
  const [mode, type, blob] = (meta ?? '').split(' ');
  if (type !== 'blob' || !blob || mode === '120000') return null;
  try {
    const result = await execFile('git', ['cat-file', 'blob', blob], {
      cwd: state.repoRoot,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: 60_000,
    });
    const content = result.stdout as unknown as Buffer;
    return { blob, sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
  } catch {
    return null;
  }
}

/** True when `commit` exists and is an ancestor of, or equal to, the integration head. */
export async function isAncestorOfHead(state: GoalRepositoryState, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) return false;
  const result = await gitTry(state.repoRoot, ['merge-base', '--is-ancestor', commit, state.head]);
  return result.ok;
}

export async function objectType(
  state: Pick<GoalRepositoryState, 'repoRoot'>,
  objectId: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(objectId)) return null;
  const result = await gitTry(state.repoRoot, ['cat-file', '-t', objectId]);
  return result.ok ? result.stdout.trim() : null;
}

/** Memoises the Git reads made while evaluating one Goal at one integration head. */
export interface RepositoryReader {
  readonly state: GoalRepositoryState;
  blob(projectPath: string): Promise<BlobAtCommit | null>;
  isAncestor(commit: string): Promise<boolean>;
}

export function createRepositoryReader(state: GoalRepositoryState): RepositoryReader {
  const blobs = new Map<string, Promise<BlobAtCommit | null>>();
  const ancestors = new Map<string, Promise<boolean>>();
  return {
    state,
    blob(projectPath) {
      let cached = blobs.get(projectPath);
      if (!cached) {
        cached = readBlobAtCommit(state, projectPath);
        blobs.set(projectPath, cached);
      }
      return cached;
    },
    isAncestor(commit) {
      let cached = ancestors.get(commit);
      if (!cached) {
        cached = isAncestorOfHead(state, commit);
        ancestors.set(commit, cached);
      }
      return cached;
    },
  };
}
