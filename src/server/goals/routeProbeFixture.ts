import { execFile as callbackExecFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PROBE_FIXTURE, PROBE_FIXTURE_FILES } from '../../shared/routeProbe.js';
import type { Db } from '../db.js';
import { localMachine } from '../serialize.js';

const execFile = promisify(callbackExecFile);

/**
 * The Turing-owned route-validation fixture repository. It is created from `PROBE_FIXTURE_FILES` with a fixed
 * author, committer and time, so the same content always yields the same tree and commit. It is never a user project,
 * never a copy of one, and is verified before every probe. A mismatch fails closed: nothing is repaired or reset.
 */

/** Tree and commit of the canonical fixture. Pinned by a test that rebuilds the fixture from `PROBE_FIXTURE_FILES`. */
export const FIXTURE_TREE_SHA = '17f5e7bb572f80aa3f952daa43b42dd19610c3c1';
export const FIXTURE_COMMIT_SHA = 'd909029737430d80e8d372d4147752a7026ff420';

export const dataDirectory = (): string =>
  resolve(
    process.env.TT_DATA_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.turing-terminal'),
  );

export const fixtureDirectory = (): string => join(dataDirectory(), PROBE_FIXTURE.directoryName);

export type FixtureCheck =
  | { ok: true; path: string; commit: string; tree: string }
  | { ok: false; code: 'fixture_missing' | 'fixture_mismatch' | 'fixture_dirty' | 'fixture_unreadable' };

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
  });
}

/** Builds the fixture repository at `path` (which must not exist yet) and returns its commit and tree. */
export async function buildFixtureRepository(path: string): Promise<{ commit: string; tree: string }> {
  if (existsSync(path)) throw new Error('The fixture path already exists.');
  mkdirSync(path, { recursive: true });
  await git(path, ['init', '--quiet']);
  await git(path, ['symbolic-ref', 'HEAD', `refs/heads/${PROBE_FIXTURE.branch}`]);
  for (const [file, content] of Object.entries(PROBE_FIXTURE_FILES)) {
    const target = join(path, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: 'utf8' });
  }
  await git(path, ['add', '-A']);
  const { name, email, date } = PROBE_FIXTURE.identity;
  await git(path, ['commit', '--quiet', '--no-verify', '-m', PROBE_FIXTURE.commitMessage], {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  });
  const commit = (await git(path, ['rev-parse', 'HEAD'])).stdout.trim();
  const tree = (await git(path, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  return { commit, tree };
}

/** Read-only verification: HEAD is the pinned commit, its tree is the pinned tree, the branch and checkout are clean. */
export async function verifyFixture(path = fixtureDirectory()): Promise<FixtureCheck> {
  if (!existsSync(path)) return { ok: false, code: 'fixture_missing' };
  try {
    const real = realpathSync(path);
    const [commit, tree, branch, status] = await Promise.all([
      git(real, ['rev-parse', 'HEAD']),
      git(real, ['rev-parse', 'HEAD^{tree}']),
      git(real, ['branch', '--show-current']),
      git(real, ['status', '--porcelain', '--untracked-files=all']),
    ]);
    if (
      commit.stdout.trim() !== FIXTURE_COMMIT_SHA ||
      tree.stdout.trim() !== FIXTURE_TREE_SHA ||
      branch.stdout.trim() !== PROBE_FIXTURE.branch
    )
      return { ok: false, code: 'fixture_mismatch' };
    if (status.stdout.trim()) return { ok: false, code: 'fixture_dirty' };
    return { ok: true, path: real, commit: commit.stdout.trim(), tree: tree.stdout.trim() };
  } catch {
    return { ok: false, code: 'fixture_unreadable' };
  }
}

/**
 * Creates the fixture only when it is absent, then verifies it. An existing directory is never modified: if it does not
 * verify, the result is the failure, and the user must inspect it.
 */
export async function ensureFixture(path = fixtureDirectory()): Promise<FixtureCheck> {
  if (!existsSync(path)) {
    try {
      await buildFixtureRepository(path);
    } catch {
      return { ok: false, code: 'fixture_unreadable' };
    }
  }
  return verifyFixture(path);
}

/**
 * Registers the verified fixture as an internal project so a probe is an ordinary run on an ordinary project. The row is
 * only ever created, never rewritten, and a row pointing elsewhere makes the fixture unavailable.
 */
export function ensureFixtureProject(db: Db, path: string): boolean {
  const existing = db
    .prepare('SELECT path, git_root FROM projects WHERE id = ?')
    .get(PROBE_FIXTURE.projectId) as { path: string; git_root: string | null } | undefined;
  if (existing) return existing.path === path && existing.git_root === path;
  try {
    db.prepare(
      `INSERT INTO projects (id, machine_id, name, path, git_root, branch, dirty, package_manager, languages_json,
        frameworks_json, build_command_json, test_command_json, lint_command_json, readme_path, instruction_files_json,
        created_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, '[]', '[]', NULL, NULL, NULL, 'README.md', '[]', ?)`,
    ).run(
      PROBE_FIXTURE.projectId,
      String(localMachine(db).id),
      PROBE_FIXTURE.projectName,
      path,
      path,
      PROBE_FIXTURE.branch,
      new Date().toISOString(),
    );
    return true;
  } catch {
    return false;
  }
}
