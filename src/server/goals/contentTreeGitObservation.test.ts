import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTENT_TREE_MAX_HISTORY_COMMITS, observeContentTree } from './contentTreeGitObservation.js';
import type { ContentTreeGitCommandResult, ContentTreeGitObservation } from './contentTreeGitObservation.js';
import { compareContentTrees } from './contentTreeComparison.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

const roots: string[] = [];

function cleanup(): void {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
}

afterEach(cleanup);

function canInitializeSha256(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ctgo-sha256-'));
  roots.push(root);
  const result = spawnSync('git', ['init', '--quiet', '--object-format=sha256', root], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

interface TestRepository {
  root: string;
  path: string;
  git: (...args: string[]) => string;
  gitTry: (...args: string[]) => ReturnType<typeof spawnSync>;
  write: (relativePath: string, content: string) => void;
  commit: (message: string) => string;
  commitAt: (message: string, date: string) => string;
  mergeAt: (branch: string, message: string, date?: string) => string;
  head: () => string;
}

function createRepository(format: 'sha1' | 'sha256' = 'sha1'): TestRepository {
  const root = mkdtempSync(join(tmpdir(), 'ctgo-repo-'));
  roots.push(root);
  const path = join(root, 'repo');
  mkdirSync(path);
  const initialized = spawnSync(
    'git',
    ['init', '--quiet', '--initial-branch=main', `--object-format=${format}`, path],
    { encoding: 'utf8' },
  );
  if (initialized.status !== 0) throw new Error(`git init failed: ${initialized.stderr}`);
  const baseEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const gitWithEnv = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      env: { ...baseEnv, ...env },
    }).trimEnd();
  const git = (...args: string[]) => gitWithEnv({}, ...args);
  const gitTry = (...args: string[]) =>
    spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', env: baseEnv });
  git('config', 'user.name', 'Content Tree Git Observation Test');
  git('config', 'user.email', 'ctgo@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const write = (relativePath: string, content: string) => {
    const target = join(path, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const commitAt = (message: string, date: string) => {
    git('add', '-A');
    gitWithEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, 'commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const commit = (message: string) => commitAt(message, '2024-01-01 00:00:00 +0000');
  const mergeAt = (branch: string, message: string, date?: string) => {
    const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    gitWithEnv(env, 'merge', '--no-ff', '--quiet', '-m', message, branch);
    return git('rev-parse', 'HEAD');
  };
  const head = () => git('rev-parse', 'HEAD');
  return { root, path, git, gitTry, write, commit, commitAt, mergeAt, head };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  visit(root);
  return result;
}

function okCommandResult(stdout: Buffer = Buffer.alloc(0)): ContentTreeGitCommandResult {
  return {
    ok: true,
    stdout,
    stderr: Buffer.alloc(0),
    exitCode: 0,
    timedOut: false,
    truncated: false,
  };
}

function failedCommandResult(stderr: string, exitCode = 128): ContentTreeGitCommandResult {
  return {
    ok: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
    exitCode,
    timedOut: false,
    truncated: false,
  };
}

function realGitResult(
  repoPath: string,
  args: readonly string[],
  input?: Buffer,
): ContentTreeGitCommandResult {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  const result = spawnSync('git', ['-C', repoPath, ...args], { input, env });
  return {
    ok: result.status === 0 && !result.error,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(result.stderr ?? []),
    exitCode: result.status,
    timedOut: false,
    truncated: false,
  };
}

function commandKey(args: readonly string[]): string {
  if (args[0] === 'rev-parse') {
    if (args[1] === '--show-toplevel') return 'rev-parse --show-toplevel';
    if (args[1] === '--show-object-format') return 'rev-parse --show-object-format';
    if (args[1] === '--is-shallow-repository') return 'rev-parse --is-shallow-repository';
  }
  if (args[0] === 'cat-file') {
    if (args[1] === '--batch') return 'cat-file --batch';
    if (args[1]?.includes('%(objectsize)')) return 'cat-file sizes';
    return 'cat-file check';
  }
  if (args[0] === 'rev-list' && args.includes('--first-parent')) return 'rev-list first-parent';
  if (args[0] === 'rev-list' && args.includes('--ancestry-path')) return 'rev-list ancestry-path';
  return args[0] ?? '';
}

type MockHandler = (
  args: readonly string[],
  options: { input?: Buffer; env?: NodeJS.ProcessEnv },
) => ContentTreeGitCommandResult;

interface SeenInvocation {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function strictRunner(
  repoPath: string,
  overrides: Record<string, MockHandler> = {},
  seen: SeenInvocation[] = [],
): {
  run: (
    args: readonly string[],
    options: { input?: Buffer; env?: NodeJS.ProcessEnv },
  ) => Promise<ContentTreeGitCommandResult>;
} {
  const handlers: Record<string, MockHandler> = {
    'rev-parse --show-toplevel': () => okCommandResult(Buffer.from(`${repoPath}\n`)),
    'rev-parse --show-object-format': () => okCommandResult(Buffer.from('sha1\n')),
    'rev-parse --is-shallow-repository': () => okCommandResult(Buffer.from('false\n')),
    'cat-file check': (args, options) => realGitResult(repoPath, args, options.input),
    'cat-file sizes': (args, options) => realGitResult(repoPath, args, options.input),
    'cat-file --batch': (args, options) => realGitResult(repoPath, args, options.input),
    'merge-base': (args) => realGitResult(repoPath, args),
    'rev-list first-parent': (args) => realGitResult(repoPath, args),
    'rev-list ancestry-path': (args) => realGitResult(repoPath, args),
    'diff-tree': (args) => realGitResult(repoPath, args),
    'ls-tree': (args) => realGitResult(repoPath, args),
    'check-attr': (args, options) => realGitResult(repoPath, args, options.input),
  };
  return {
    async run(args, options) {
      seen.push({ args: [...args], env: options?.env });
      const key = commandKey(args);
      const handler = overrides[key] ?? handlers[key];
      if (!handler) throw new Error(`unexpected git command: ${args.join(' ')}`);
      return handler(args, options);
    },
  };
}

function echoCheckAttr(input?: Buffer): ContentTreeGitCommandResult {
  const source = input ?? Buffer.alloc(0);
  const paths: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== 0) continue;
    if (i > start) paths.push(source.subarray(start, i));
    start = i + 1;
  }
  const chunks: Buffer[] = [];
  for (const path of paths) {
    chunks.push(Buffer.concat([path, Buffer.from([0])]));
    chunks.push(Buffer.concat([Buffer.from('filter', 'ascii'), Buffer.from([0])]));
    chunks.push(Buffer.concat([Buffer.from('unspecified', 'ascii'), Buffer.from([0])]));
  }
  return okCommandResult(Buffer.concat(chunks));
}

function makePaths(count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, (_, i) => Buffer.from(`path-${i}.txt\0`, 'utf8')));
}

function historyOutput(
  oids: readonly string[],
  parentsAt: (index: number) => readonly string[] = () => [],
): Buffer {
  return Buffer.from(
    oids.map((oid, index) => [oid, ...parentsAt(index)].join(' ')).join('\n') + '\n',
    'ascii',
  );
}

async function observe(
  repo: TestRepository,
  base: string,
  source: string,
  tip: string,
  overrides: {
    runner?: ReturnType<typeof strictRunner>;
    limits?: {
      timeoutMs?: number;
      maxStdoutBytes?: number;
      maxStderrBytes?: number;
      maxOutputBytes?: number;
      maxChangedPaths?: number;
    };
    maxChangedPaths?: number;
    objectFormat?: 'sha1' | 'sha256';
  } = {},
): Promise<ContentTreeGitObservation> {
  return observeContentTree({
    repoRoot: repo.path,
    expectedBaseCommit: base,
    acceptedSourceCommit: source,
    destinationTipCommit: tip,
    objectFormat: overrides.objectFormat ?? 'sha1',
    runner: overrides.runner,
    limits: overrides.limits,
    maxChangedPaths: overrides.maxChangedPaths,
  });
}

function compare(result: ContentTreeGitObservation) {
  if (!result.ok) throw new Error(`observation failed: ${result.status}`);
  return compareContentTrees({
    changedPaths: result.changedPaths,
    sourceEntries: result.sourceEntries,
    destinationEntries: result.destinationEntries,
  });
}

function entryAt(result: ContentTreeGitObservation, path: string): { mode: string; oid: string } | undefined {
  if (!result.ok) throw new Error(`observation failed: ${result.status}`);
  return result.sourceEntries.find((entry) => Buffer.from(entry.path).toString('utf8') === path);
}

function destinationEntryAt(
  result: ContentTreeGitObservation,
  path: string,
): { mode: string; oid: string } | undefined {
  if (!result.ok) throw new Error(`observation failed: ${result.status}`);
  return result.destinationEntries.find((entry) => Buffer.from(entry.path).toString('utf8') === path);
}

function createPreservingMerge(format: 'sha1' | 'sha256' = 'sha1'): {
  repo: TestRepository;
  base: string;
  source: string;
  merge: string;
} {
  const repo = createRepository(format);
  repo.write('goal.txt', 'v1\n');
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'side', base);
  repo.write('goal.txt', 'v2\n');
  const source = repo.commit('source');
  repo.git('checkout', '--quiet', 'main');
  repo.write('main.txt', 'main advance\n');
  repo.commit('main advance');
  const merge = repo.mergeAt('side', 'merge source');
  return { repo, base, source, merge };
}

function snapshotGitState(repo: TestRepository) {
  const gitDir = join(repo.path, '.git');
  const snapshotLogs = () =>
    walkFiles(join(gitDir, 'logs')).map((file) => ({
      path: file.slice(gitDir.length),
      bytes: readFileSync(file).toString('base64'),
    }));
  const snapshotLocks = () =>
    walkFiles(gitDir)
      .filter((file) => file.endsWith('.lock'))
      .map((file) => file.slice(gitDir.length))
      .sort();
  const snapshotObjectStore = () =>
    walkFiles(join(gitDir, 'objects'))
      .map((file) => file.slice(gitDir.length))
      .sort();
  const snapshotPackedRefs = () => {
    const packedRefs = join(gitDir, 'packed-refs');
    return existsSync(packedRefs) ? readFileSync(packedRefs).toString('base64') : '';
  };
  const snapshotSymlinks = () => {
    const result: { path: string; target: string }[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git') visit(full);
        } else if (entry.isSymbolicLink()) {
          result.push({ path: full.slice(repo.path.length + 1), target: readlinkSync(full) });
        }
      }
    };
    visit(repo.path);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  };
  return {
    refs: repo.git('for-each-ref'),
    headSym: repo.git('symbolic-ref', 'HEAD'),
    headSha: repo.git('rev-parse', 'HEAD'),
    indexBytes: readFileSync(join(gitDir, 'index')).toString('base64'),
    staged: repo.git('ls-files', '--stage'),
    file: readFileSync(join(repo.path, 'goal.txt')).toString('base64'),
    symlinks: snapshotSymlinks(),
    config: readFileSync(join(gitDir, 'config')).toString('base64'),
    exclude: readFileSync(join(gitDir, 'info', 'exclude')).toString('base64'),
    logs: snapshotLogs(),
    locks: snapshotLocks(),
    objectStore: snapshotObjectStore(),
    packedRefs: snapshotPackedRefs(),
  };
}

describe('content tree git observation', () => {
  it(
    'observes added, modified and deleted paths',
    async () => {
      const repo = createRepository();
      repo.write('deleted.txt', 'deleted\n');
      repo.write('modified.txt', 'modified v1\n');
      const base = repo.commit('base');
      repo.write('added.txt', 'added\n');
      repo.write('modified.txt', 'modified v2\n');
      rmSync(join(repo.path, 'deleted.txt'), { force: true });
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source);

      expect(result.ok).toBe(true);
      expect(result.status).toBe('observed');
      if (result.ok) {
        expect(result.comparisonCommit).toBe(source);
        const changed = result.changedPaths.map((p) => Buffer.from(p).toString('utf8'));
        expect(changed).toContain('added.txt');
        expect(changed).toContain('modified.txt');
        expect(changed).toContain('deleted.txt');
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'compares a fast-forward at the source even when the destination tip has later commits',
    async () => {
      const repo = createRepository();
      repo.write('goal.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('goal.txt', 'v2\n');
      const source = repo.commit('source');
      repo.write('later.txt', 'later\n');
      const tip = repo.commit('later');

      const result = await observe(repo, base, source, tip);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe('observed');
      expect(result.comparisonCommit).toBe(source);
      expect(compare(result).status).toBe('verified');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'compares a preserving true merge at the merge commit',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const result = await observe(repo, base, source, merge);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);
      expect(compare(result).status).toBe('verified');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'observes an ours merge at the merge commit and reports exactly one mismatch',
    async () => {
      const repo = createRepository();
      repo.write('goal.txt', 'v1\n');
      const base = repo.commit('base');
      repo.git('checkout', '--quiet', '-b', 'side', base);
      repo.write('goal.txt', 'v2\n');
      const source = repo.commit('source');
      repo.git('checkout', '--quiet', 'main');
      repo.write('main.txt', 'main advance\n');
      repo.commit('main advance');
      repo.git('merge', '--no-ff', '-s', 'ours', '--quiet', '-m', 'ours merge', 'side');
      const merge = repo.head();

      const result = await observe(repo, base, source, merge);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);
      const comparison = compare(result);
      expect(comparison.status).toBe('content_not_preserved');
      if (comparison.status === 'content_not_preserved') {
        expect(comparison.mismatchCount).toBe(1);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a conflict edit to a Goal path as a mismatch',
    async () => {
      const repo = createRepository();
      repo.write('goal.txt', 'v1\n');
      const base = repo.commit('base');
      repo.git('checkout', '--quiet', '-b', 'side', base);
      repo.write('goal.txt', 'side\n');
      const source = repo.commit('source');
      repo.git('checkout', '--quiet', 'main');
      repo.write('goal.txt', 'main\n');
      repo.commit('main');
      const conflicted = repo.gitTry('merge', '--no-ff', '-m', 'conflicted merge', 'side');
      expect(conflicted.status).not.toBe(0);
      repo.write('goal.txt', 'resolved\n');
      const merge = repo.commit('resolved merge');

      const result = await observe(repo, base, source, merge);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);
      const comparison = compare(result);
      expect(comparison.status).toBe('content_not_preserved');
      if (comparison.status === 'content_not_preserved') {
        expect(comparison.mismatchCount).toBe(1);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps comparing at the first source-containing merge after a later Goal path edit',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      repo.write('goal.txt', 'v3 after merge\n');
      const tip = repo.commit('destination-only goal edit');

      const result = await observe(repo, base, source, tip);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);
      expect(result.comparisonCommit).not.toBe(tip);
      expect(compare(result).status).toBe('verified');
      expect(destinationEntryAt(result, 'goal.txt')?.oid).toBe(entryAt(result, 'goal.txt')?.oid);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'picks the first merge when source was merged on a side branch before that branch reached the destination',
    async () => {
      const repo = createRepository();
      repo.write('goal.txt', 'v1\n');
      const base = repo.commit('base');
      repo.git('checkout', '--quiet', '-b', 'source', base);
      repo.write('goal.txt', 'v2\n');
      const source = repo.commit('source');
      repo.git('checkout', '--quiet', '-b', 'side', base);
      repo.write('side.txt', 'side\n');
      repo.commit('side work');
      const firstMerge = repo.mergeAt('source', 'side merges source');
      repo.git('checkout', '--quiet', 'main');
      repo.write('main.txt', 'main advance\n');
      repo.commit('main advance');
      const destinationMerge = repo.mergeAt('side', 'destination merges side');
      repo.write('later.txt', 'later\n');
      const tip = repo.commit('later');

      const result = await observe(repo, base, source, tip);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(firstMerge);
      expect(result.comparisonCommit).not.toBe(destinationMerge);
      expect(compare(result).status).toBe('verified');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'ignores a destination-only edit made after the comparison commit',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      repo.write('later.txt', 'destination-only\n');
      const tip = repo.commit('destination-only later');
      const result = await observe(repo, base, source, tip);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);
      expect(compare(result).status).toBe('verified');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'uses topology rather than skewed commit dates to pick the first merge',
    async () => {
      const repo = createRepository();
      repo.write('goal.txt', 'v1\n');
      const base = repo.commitAt('base', '2020-01-01 00:00:00 +0000');
      repo.git('checkout', '--quiet', '-b', 'source', base);
      repo.write('goal.txt', 'v2\n');
      const source = repo.commitAt('source', '2030-01-01 00:00:00 +0000');
      repo.git('checkout', '--quiet', '-b', 'side', base);
      repo.write('side.txt', 'side\n');
      repo.commitAt('side work', '2030-01-02 00:00:00 +0000');
      const firstMerge = repo.mergeAt('source', 'side merges source', '2030-01-03 00:00:00 +0000');
      repo.git('checkout', '--quiet', 'main');
      repo.write('main.txt', 'main advance\n');
      repo.commitAt('main advance', '2020-01-02 00:00:00 +0000');
      const destinationMerge = repo.mergeAt('side', 'destination merges side', '2020-01-03 00:00:00 +0000');

      const result = await observe(repo, base, source, destinationMerge);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(firstMerge);
      expect(compare(result).status).toBe('verified');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'returns distinct refusal statuses when the expected base or accepted source is not an ancestor',
    async () => {
      const repo = createRepository();
      repo.write('base.txt', 'base\n');
      const base = repo.commit('base');
      repo.git('checkout', '--quiet', '-b', 'source', base);
      repo.write('goal.txt', 'v2\n');
      const source = repo.commit('source');
      repo.git('checkout', '--quiet', 'main');
      repo.write('main.txt', 'main\n');
      const tip = repo.commit('main');

      const sourceResult = await observe(repo, base, source, tip);
      expect(sourceResult.ok).toBe(false);
      expect(sourceResult.status).toBe('source_not_ancestor');

      repo.git('checkout', '--quiet', '--orphan', 'unrelated');
      repo.write('unrelated.txt', 'unrelated\n');
      const unrelated = repo.commit('unrelated');
      const baseResult = await observe(repo, unrelated, source, tip);
      expect(baseResult.ok).toBe(false);
      expect(baseResult.status).toBe('base_not_ancestor');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed on a missing parent during history resolution',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const runner = strictRunner(repo.path, {
        'rev-list first-parent': () => failedCommandResult('fatal: bad object deadbeef'),
      });
      const result = await observe(repo, base, source, merge, { runner });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('git_object_missing');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed when the shallow probe fails',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const runner = strictRunner(repo.path, {
        'rev-parse --is-shallow-repository': () => failedCommandResult('fatal: boom'),
      });
      const result = await observe(repo, base, source, merge, { runner });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('shallow_probe_failed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not reject a shallow repository when the base and required history are present',
    async () => {
      const origin = createRepository();
      origin.write('root.txt', 'root\n');
      origin.commit('root');
      origin.write('goal.txt', 'v1\n');
      const base = origin.commit('base');
      origin.write('goal.txt', 'v2\n');
      const source = origin.commit('source');
      origin.write('later.txt', 'later\n');
      const tip = origin.commit('later');

      const cloneRoot = mkdtempSync(join(tmpdir(), 'ctgo-shallow-'));
      roots.push(cloneRoot);
      const clonePath = join(cloneRoot, 'clone');
      const cloned = spawnSync(
        'git',
        ['clone', '--quiet', '--depth', '3', `file://${origin.path}`, clonePath],
        { encoding: 'utf8' },
      );
      expect(cloned.status).toBe(0);
      const shallowProbe = spawnSync('git', ['-C', clonePath, 'rev-parse', '--is-shallow-repository'], {
        encoding: 'utf8',
      });
      expect(shallowProbe.stdout.trim()).toBe('true');

      const repo: TestRepository = { ...origin, path: clonePath };
      const result = await observe(repo, base, source, tip);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(source);
      expect(compare(result).status).toBe('verified');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'distinguishes a malformed caller OID from malformed or high-byte Git output',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();

      const invalid = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: 'not-an-oid',
        acceptedSourceCommit: source,
        destinationTipCommit: merge,
        objectFormat: 'sha1',
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.status).toBe('invalid_input');

      const highByte = strictRunner(repo.path, {
        'rev-parse --show-object-format': () => okCommandResult(Buffer.from([0xff, 0x0a])),
      });
      const malformed = await observe(repo, base, source, merge, { runner: highByte });
      expect(malformed.ok).toBe(false);
      expect(malformed.status).toBe('malformed_git_output');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'uses bounded resolver commands and deterministic topology',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const seen: SeenInvocation[] = [];
      const runner = strictRunner(repo.path, {}, seen);
      const result = await observe(repo, base, source, merge, { runner });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);

      const invocations = seen.map((entry) => entry.args);
      const ancestry = invocations.find((args) => args[0] === 'rev-list' && args.includes('--ancestry-path'));
      expect(ancestry).toBeDefined();
      expect(ancestry).toContain('--topo-order');
      expect(ancestry).toContain('--parents');
      expect(ancestry).toContain('--end-of-options');
      expect(ancestry).toContain(`${source}..${merge}`);
      expect(ancestry?.some((arg) => arg.startsWith('--max-count='))).toBe(true);

      const diff = invocations.find((args) => args[0] === 'diff-tree');
      expect(diff).toContain('--end-of-options');
      expect(diff).toContain('--no-ext-diff');
      expect(diff).toContain('--no-textconv');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an ambiguous ancestry-path history with more than one first merge',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const parents = Array.from({ length: 4 }, (_, index) => (index + 1).toString(16).padStart(40, '0'));
      const first = 'a'.repeat(40);
      const second = 'b'.repeat(40);
      const runner = strictRunner(repo.path, {
        'rev-list ancestry-path': () =>
          okCommandResult(historyOutput([second, first], () => parents.slice(0, 2))),
      });

      const result = await observe(repo, base, source, merge, { runner });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('comparison_commit_ambiguous');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a history one commit past the bound on either resolver',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const oids = Array.from({ length: CONTENT_TREE_MAX_HISTORY_COMMITS + 1 }, (_, index) =>
        index.toString(16).padStart(40, '0'),
      );

      for (const key of ['rev-list first-parent', 'rev-list ancestry-path']) {
        const runner = strictRunner(repo.path, {
          [key]: () => okCommandResult(historyOutput(oids)),
        });
        const result = await observe(repo, base, source, merge, { runner });
        expect(result.ok).toBe(false);
        expect(result.status).toBe('comparison_history_unbounded');
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'accepts exactly 10000 changed paths and refuses 10001 even with a raised caller limit',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const atCapRunner = strictRunner(repo.path, {
        'diff-tree': () => okCommandResult(makePaths(10_000)),
        'check-attr': (_args, options) => echoCheckAttr(options.input),
      });
      const atCap = await observe(repo, base, source, source, {
        runner: atCapRunner,
        limits: { maxChangedPaths: 50_000 },
      });
      expect(atCap.ok).toBe(true);
      if (atCap.ok) expect(atCap.changedPaths.length).toBe(10_000);

      const overCapRunner = strictRunner(repo.path, {
        'diff-tree': () => okCommandResult(makePaths(10_001)),
      });
      const overCap = await observe(repo, base, source, source, {
        runner: overCapRunner,
        limits: { maxChangedPaths: 50_000 },
        maxChangedPaths: 50_000,
      });
      expect(overCap.ok).toBe(false);
      expect(overCap.status).toBe('too_many_changed_paths');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'treats a rename as delete plus add',
    async () => {
      const repo = createRepository();
      repo.write('old.txt', 'content\n');
      const base = repo.commit('base');
      rmSync(join(repo.path, 'old.txt'));
      repo.write('new.txt', 'content\n');
      const source = repo.commit('rename');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const changed = result.changedPaths.map((p) => Buffer.from(p).toString('utf8'));
        expect(changed).toContain('old.txt');
        expect(changed).toContain('new.txt');
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'preserves unusual and non-UTF8 path bytes',
    async () => {
      const repo = createRepository();
      const unusual = Buffer.from([0x61, 0xff, 0x2e, 0x74, 0x78, 0x74]);
      writeFileSync(Buffer.concat([Buffer.from(repo.path + '/'), unusual]), 'content\n');
      const base = repo.commit('base');
      writeFileSync(Buffer.concat([Buffer.from(repo.path + '/'), unusual]), 'changed\n');
      const source = repo.commit('modify');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.changedPaths.length).toBe(1);
        expect(Buffer.from(result.changedPaths[0]!).equals(unusual)).toBe(true);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'works on SHA-256 repositories',
    async (ctx) => {
      if (!canInitializeSha256()) ctx.skip();
      const repo = createRepository('sha256');
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source, { objectFormat: 'sha256' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sourceEntries[0]?.oid).toMatch(/^[0-9a-f]{64}$/);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'compares a SHA-256 preserving true merge at the merge commit',
    async (ctx) => {
      if (!canInitializeSha256()) ctx.skip();
      const { repo, base, source, merge } = createPreservingMerge('sha256');
      const result = await observe(repo, base, source, merge, { objectFormat: 'sha256' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.comparisonCommit).toBe(merge);
      expect(result.comparisonCommit).not.toBe(source);
      expect(compare(result).status).toBe('verified');
      expect(entryAt(result, 'goal.txt')?.oid).toMatch(/^[0-9a-f]{64}$/);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'returns missing object outcome for unknown commits',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const source = repo.commit('source');
      const missing = '0'.repeat(40);

      const result = await observe(repo, missing, source, source);
      expect(result.ok).toBe(false);
      expect(result.status).toBe('git_object_missing');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'returns malformed output outcome from injected runner',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const runner = strictRunner(repo.path, {
        'ls-tree': () => okCommandResult(Buffer.from('not-a-valid-record\0')),
      });

      const result = await observe(repo, base, source, merge, { runner });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('malformed_git_output');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses LFS-filtered paths using committed .gitattributes',
    async () => {
      const repo = createRepository();
      repo.write('.gitattributes', '*.bin filter=lfs\n');
      repo.write('data.bin', 'pointer-ish\n');
      const base = repo.commit('base');
      repo.write('data.bin', 'changed\n');
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(false);
      expect(result.status).toBe('lfs_filter_refused');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a source LFS pointer even without committed filter attributes',
    async () => {
      const repo = createRepository();
      repo.write('data.bin', 'before\n');
      const base = repo.commit('base');
      repo.write(
        'data.bin',
        'version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 12\n',
      );
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(false);
      expect(result.status).toBe('lfs_filter_refused');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'covers timeout, command failure and output bounds via injected runner',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const timeoutRunner = {
        run: async (): Promise<ContentTreeGitCommandResult> => ({
          ok: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: null,
          timedOut: true,
          truncated: false,
        }),
      };
      const timeoutResult = await observe(repo, base, source, source, {
        runner: timeoutRunner as unknown as ReturnType<typeof strictRunner>,
      });
      expect(timeoutResult.status).toBe('git_command_timed_out');

      const failureRunner = strictRunner(repo.path, {
        'diff-tree': () => failedCommandResult('fatal: boom'),
      });
      const failureResult = await observe(repo, base, source, source, { runner: failureRunner });
      expect(failureResult.status).toBe('git_command_failed');

      const boundsRunner = {
        run: async (): Promise<ContentTreeGitCommandResult> => ({
          ok: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: null,
          timedOut: false,
          truncated: true,
        }),
      };
      const boundsResult = await observe(repo, base, source, source, {
        runner: boundsRunner as unknown as ReturnType<typeof strictRunner>,
      });
      expect(boundsResult.status).toBe('git_output_limit_exceeded');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'observes executable mode changes in real repositories',
    async () => {
      const repo = createRepository();
      repo.write('script.sh', '#!/bin/sh' + String.fromCharCode(10) + 'echo hi' + String.fromCharCode(10));
      const base = repo.commit('base');
      chmodSync(join(repo.path, 'script.sh'), 0o755);
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const changed = result.changedPaths.map((p) => Buffer.from(p).toString('utf8'));
        expect(changed).toContain('script.sh');
        const entry = result.sourceEntries.find((e) => Buffer.from(e.path).toString('utf8') === 'script.sh');
        expect(entry?.mode).toBe('100755');
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'parses symlink and gitlink entries from injected listings',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const oid = 'a'.repeat(40);
      const longOid = 'b'.repeat(64);
      const runner = strictRunner(repo.path, {
        'diff-tree': () =>
          okCommandResult(Buffer.concat([Buffer.from('changed.txt', 'utf8'), Buffer.from([0])])),
        'ls-tree': () =>
          okCommandResult(
            Buffer.concat([
              Buffer.from(`100755 blob ${oid}` + String.fromCharCode(9) + 'exec.txt', 'utf8'),
              Buffer.from([0]),
              Buffer.from(`120000 blob ${oid}` + String.fromCharCode(9) + 'link.txt', 'utf8'),
              Buffer.from([0]),
              Buffer.from(`160000 commit ${oid}` + String.fromCharCode(9) + 'sub', 'utf8'),
              Buffer.from([0]),
              Buffer.from(`160000 commit ${longOid}` + String.fromCharCode(9) + 'longsub', 'utf8'),
              Buffer.from([0]),
            ]),
          ),
        'check-attr': (_args, options) => echoCheckAttr(options.input),
      });

      const result = await observe(repo, base, source, source, { runner });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const modes = result.sourceEntries.map((e) => e.mode);
        expect(modes).toContain('100755');
        expect(modes).toContain('120000');
        expect(modes).toContain('160000');
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'observes a committed symlink as mode 120000',
    async (ctx) => {
      const probeDir = mkdtempSync(join(tmpdir(), 'ctgo-symlink-probe-'));
      roots.push(probeDir);
      const probePath = join(probeDir, 'probe-link');
      try {
        symlinkSync('target', probePath);
      } catch {
        ctx.skip();
        return;
      }
      rmSync(probePath, { force: true });

      const repo = createRepository();
      repo.write('target.txt', 'target\n');
      const base = repo.commit('base');
      try {
        symlinkSync('target.txt', join(repo.path, 'link.txt'));
      } catch {
        ctx.skip();
        return;
      }
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const entry = result.sourceEntries.find((e) => Buffer.from(e.path).toString('utf8') === 'link.txt');
        expect(entry?.mode).toBe('120000');
        expect(entry?.oid).toMatch(/^[0-9a-f]{40}$/);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'rejects 120777 blob entries as malformed output',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const oid = 'a'.repeat(40);
      const runner = strictRunner(repo.path, {
        'diff-tree': () =>
          okCommandResult(Buffer.concat([Buffer.from('changed.txt', 'utf8'), Buffer.from([0])])),
        'ls-tree': () =>
          okCommandResult(
            Buffer.concat([
              Buffer.from(`120777 blob ${oid}` + String.fromCharCode(9) + 'bad.txt', 'utf8'),
              Buffer.from([0]),
            ]),
          ),
        'check-attr': (_args, options) => echoCheckAttr(options.input),
      });

      const result = await observe(repo, base, source, source, { runner });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('malformed_git_output');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not write refs, index or worktree across a merge and a later tip commit',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      repo.write('later.txt', 'later\n');
      const tip = repo.commit('later');
      const before = snapshotGitState(repo);
      expect(before.locks).toEqual([]);

      const result = await observe(repo, base, source, tip);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.comparisonCommit).toBe(merge);

      const after = snapshotGitState(repo);
      expect(after.locks).toEqual([]);
      expect(after.refs).toBe(before.refs);
      expect(after.headSym).toBe(before.headSym);
      expect(after.headSha).toBe(before.headSha);
      expect(after.indexBytes).toBe(before.indexBytes);
      expect(after.staged).toBe(before.staged);
      expect(after.file).toBe(before.file);
      expect(after.symlinks).toEqual(before.symlinks);
      expect(after.config).toBe(before.config);
      expect(after.exclude).toBe(before.exclude);
      expect(after.logs).toEqual(before.logs);
      expect(after.locks).toEqual(before.locks);
      expect(after.objectStore).toEqual(before.objectStore);
      expect(after.packedRefs).toBe(before.packedRefs);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses subdirectory cwd',
    async () => {
      const repo = createRepository();
      repo.write('sub/file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('sub/file.txt', 'v2\n');
      const source = repo.commit('source');
      const result = await observeContentTree({
        repoRoot: join(repo.path, 'sub'),
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationTipCommit: source,
        objectFormat: 'sha1',
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('invalid_input');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'distinguishes missing object from command failure',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const missingRunner = strictRunner(repo.path, {
        'cat-file check': (args, options) => {
          const oid = (options.input ?? Buffer.alloc(0)).toString('ascii').trim();
          if (oid === base) return okCommandResult(Buffer.from(`${base} missing\n`));
          return realGitResult(repo.path, args, options.input);
        },
      });
      const missingResult = await observe(repo, base, source, source, { runner: missingRunner });
      expect(missingResult.status).toBe('git_object_missing');

      const badObjectRunner = strictRunner(repo.path, {
        'cat-file check': () => failedCommandResult('fatal: bad object deadbeef'),
      });
      const badObjectResult = await observe(repo, base, source, source, {
        runner: badObjectRunner,
      });
      expect(badObjectResult.status).toBe('git_object_missing');

      const failureRunner = strictRunner(repo.path, {
        'diff-tree': () => failedCommandResult('fatal: boom'),
      });
      const failureResult = await observe(repo, base, source, source, { runner: failureRunner });
      expect(failureResult.status).toBe('git_command_failed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed on missing or malformed blob batch output and on a missing merge-base object',
    async () => {
      const { repo, base, source, merge } = createPreservingMerge();
      const blobOid = repo.git('rev-parse', `${source}:goal.txt`);

      const sizesMissing = strictRunner(repo.path, {
        'cat-file sizes': () => okCommandResult(Buffer.from(`${blobOid} missing\n`, 'ascii')),
      });
      const sizesMissingResult = await observe(repo, base, source, merge, { runner: sizesMissing });
      expect(sizesMissingResult.ok).toBe(false);
      expect(sizesMissingResult.status).toBe('git_object_missing');

      const sizesMalformed = strictRunner(repo.path, {
        'cat-file sizes': () => okCommandResult(Buffer.from(`${blobOid} blob not-a-number\n`, 'ascii')),
      });
      const sizesMalformedResult = await observe(repo, base, source, merge, {
        runner: sizesMalformed,
      });
      expect(sizesMalformedResult.ok).toBe(false);
      expect(sizesMalformedResult.status).toBe('malformed_git_output');

      const contentsMissing = strictRunner(repo.path, {
        'cat-file sizes': () => okCommandResult(Buffer.from(`${blobOid} blob 2\n`, 'ascii')),
        'cat-file --batch': () => okCommandResult(Buffer.from(`${blobOid} missing\n`, 'ascii')),
      });
      const contentsMissingResult = await observe(repo, base, source, merge, {
        runner: contentsMissing,
      });
      expect(contentsMissingResult.ok).toBe(false);
      expect(contentsMissingResult.status).toBe('git_object_missing');

      const contentsMalformed = strictRunner(repo.path, {
        'cat-file sizes': () => okCommandResult(Buffer.from(`${blobOid} blob 2\n`, 'ascii')),
        'cat-file --batch': () => okCommandResult(Buffer.from(`${blobOid} blob not-a-number\n`, 'ascii')),
      });
      const contentsMalformedResult = await observe(repo, base, source, merge, {
        runner: contentsMalformed,
      });
      expect(contentsMalformedResult.ok).toBe(false);
      expect(contentsMalformedResult.status).toBe('malformed_git_output');

      const mergeBaseMissing = strictRunner(repo.path, {
        'merge-base': () => failedCommandResult('fatal: bad object deadbeef', 1),
      });
      const mergeBaseMissingResult = await observe(repo, base, source, merge, {
        runner: mergeBaseMissing,
      });
      expect(mergeBaseMissingResult.ok).toBe(false);
      expect(mergeBaseMissingResult.status).toBe('git_object_missing');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses non-LFS configured filter drivers',
    async () => {
      const repo = createRepository();
      repo.write('.gitattributes', '*.bin filter=foo\n');
      repo.write('data.bin', 'content\n');
      const base = repo.commit('base');
      repo.write('data.bin', 'changed\n');
      const source = repo.commit('source');

      const result = await observe(repo, base, source, source);
      expect(result.ok).toBe(false);
      expect(result.status).toBe('filter_driver_refused');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'cleans inherited GIT_ environment and disables external diff and textconv',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const previous = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
        GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
        GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      };
      process.env.GIT_DIR = '/poison/git';
      process.env.GIT_INDEX_FILE = '/poison/index';
      process.env.GIT_OBJECT_DIRECTORY = '/poison/objects';
      process.env.GIT_CONFIG_COUNT = '1';
      try {
        const seen: SeenInvocation[] = [];
        const runner = strictRunner(repo.path, {}, seen);
        const result = await observe(repo, base, source, source, { runner });

        expect(result.ok).toBe(true);
        expect(seen.length).toBeGreaterThan(0);
        for (const entry of seen) {
          expect(entry.env?.GIT_DIR).toBeUndefined();
          expect(entry.env?.GIT_INDEX_FILE).toBeUndefined();
          expect(entry.env?.GIT_OBJECT_DIRECTORY).toBeUndefined();
          expect(entry.env?.GIT_CONFIG_COUNT).toBeUndefined();
          expect(entry.env?.GIT_ATTR_NOSYSTEM).toBe('1');
          expect(entry.env?.GIT_PAGER).toBe('cat');
          expect(entry.env?.GIT_NO_LAZY_FETCH).toBe('1');
        }
        const diffInvocation = seen.find((entry) => entry.args[0] === 'diff-tree');
        expect(diffInvocation).toBeDefined();
        expect(diffInvocation?.args).toContain('--no-ext-diff');
        expect(diffInvocation?.args).toContain('--no-textconv');
        expect(diffInvocation?.args).toContain('--end-of-options');
      } finally {
        if (previous.GIT_DIR === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous.GIT_DIR;
        if (previous.GIT_INDEX_FILE === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = previous.GIT_INDEX_FILE;
        if (previous.GIT_OBJECT_DIRECTORY === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
        else process.env.GIT_OBJECT_DIRECTORY = previous.GIT_OBJECT_DIRECTORY;
        if (previous.GIT_CONFIG_COUNT === undefined) delete process.env.GIT_CONFIG_COUNT;
        else process.env.GIT_CONFIG_COUNT = previous.GIT_CONFIG_COUNT;
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
