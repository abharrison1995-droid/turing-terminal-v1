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

import { observeContentTree } from './contentTreeGitObservation.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';

const roots: string[] = [];

function cleanup(): void {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
}

afterEach(cleanup);

function canInitializeSha256(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ctgo-sha256-'));
  roots.push(root);
  const result = spawnSync('git', ['init', '--quiet', '--object-format=sha256', root], { encoding: 'utf8' });
  return result.status === 0;
}

function createRepository(format: 'sha1' | 'sha256' = 'sha1'): {
  root: string;
  path: string;
  git: (...args: string[]) => string;
  write: (relativePath: string, content: string) => void;
  commit: (message: string) => string;
  head: () => string;
} {
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
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    }).trimEnd();
  git('config', 'user.name', 'Content Tree Git Observation Test');
  git('config', 'user.email', 'ctgo@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const write = (relativePath: string, content: string) => {
    const target = join(path, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const head = () => git('rev-parse', 'HEAD');
  return { root, path, git, write, commit, head };
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

function okCommandResult(stdout: Buffer = Buffer.alloc(0)): {
  ok: true;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  timedOut: false;
  truncated: false;
} {
  return { ok: true, stdout, stderr: Buffer.alloc(0), exitCode: 0, timedOut: false, truncated: false };
}

function batchCommitStdout(input?: Buffer): Buffer {
  const oid = (input ?? Buffer.alloc(0)).toString('ascii').trim();
  return Buffer.from(`${oid} commit\n`);
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('observed');
      if (result.ok) {
        const changed = result.changedPaths.map((p) => Buffer.from(p).toString('utf8'));
        expect(changed).toContain('added.txt');
        expect(changed).toContain('modified.txt');
        expect(changed).toContain('deleted.txt');
      }
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha256',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sourceEntries[0]?.oid).toMatch(/^[0-9a-f]{64}$/);
      }
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: missing,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('git_object_missing');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'returns malformed output outcome from injected runner',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const runner = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return okCommandResult(batchCommitStdout(options?.input));
          }
          if (args[0] === 'diff-tree') {
            return okCommandResult(Buffer.concat([Buffer.from('file.txt', 'utf8'), Buffer.from([0])]));
          }
          if (args[0] === 'ls-tree') {
            return okCommandResult(Buffer.from('not-a-valid-record\0'));
          }
          if (args[0] === 'check-attr') {
            return okCommandResult(Buffer.from('bad\0'));
          }
          return okCommandResult();
        },
      };

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner,
      });
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('lfs_filter_refused');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'accepts exactly 10000 changed paths and refuses 10001 via injected runner',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      const makePaths = (count: number) =>
        Buffer.concat(Array.from({ length: count }, (_, i) => Buffer.from(`path-${i}.txt\0`, 'utf8')));

      const makeCheckAttr = (input: Buffer) => {
        const paths: Buffer[] = [];
        let start = 0;
        for (let i = 0; i < input.length; i += 1) {
          if (input[i] === 0) {
            if (i > start) paths.push(input.subarray(start, i));
            start = i + 1;
          }
        }
        const chunks: Buffer[] = [];
        for (const path of paths) {
          chunks.push(Buffer.concat([path, Buffer.from([0])]));
          chunks.push(Buffer.concat([Buffer.from('filter', 'ascii'), Buffer.from([0])]));
          chunks.push(Buffer.concat([Buffer.from('unspecified', 'ascii'), Buffer.from([0])]));
        }
        return Buffer.concat(chunks);
      };

      const runnerAtCap = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return okCommandResult(batchCommitStdout(options?.input));
          }
          if (args[0] === 'diff-tree') {
            return okCommandResult(makePaths(10_000));
          }
          if (args[0] === 'ls-tree') {
            return okCommandResult(Buffer.alloc(0));
          }
          if (args[0] === 'check-attr') {
            return okCommandResult(makeCheckAttr(options?.input ?? Buffer.alloc(0)));
          }
          return okCommandResult();
        },
      };
      const atCap = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: runnerAtCap,
      });
      expect(atCap.ok).toBe(true);
      if (atCap.ok) expect(atCap.changedPaths.length).toBe(10_000);

      const runnerOverCap = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return okCommandResult(batchCommitStdout(options?.input));
          }
          if (args[0] === 'diff-tree') {
            return okCommandResult(makePaths(10_001));
          }
          return okCommandResult();
        },
      };
      const overCap = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: runnerOverCap,
      });
      expect(overCap.ok).toBe(false);
      expect(overCap.status).toBe('too_many_changed_paths');
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
        run: async () => ({
          ok: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: null,
          timedOut: true,
          truncated: false,
        }),
      };
      const timeoutResult = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: timeoutRunner,
      });
      expect(timeoutResult.status).toBe('git_command_timed_out');

      const failureRunner = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return okCommandResult(batchCommitStdout(options?.input));
          }
          return {
            ok: false,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('fatal: boom'),
            exitCode: 128,
            timedOut: false,
            truncated: false,
          };
        },
      };
      const failureResult = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: failureRunner,
      });
      expect(failureResult.status).toBe('git_command_failed');

      const boundsRunner = {
        run: async () => ({
          ok: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: null,
          timedOut: false,
          truncated: true,
        }),
      };
      const boundsResult = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: boundsRunner,
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });

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
      const runner = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return okCommandResult(batchCommitStdout(options?.input));
          }
          if (args[0] === 'diff-tree') {
            return okCommandResult(Buffer.concat([Buffer.from('changed.txt', 'utf8'), Buffer.from([0])]));
          }
          if (args[0] === 'ls-tree') {
            const stdout = Buffer.concat([
              Buffer.from(`100755 blob ${oid}` + String.fromCharCode(9) + 'exec.txt', 'utf8'),
              Buffer.from([0]),
              Buffer.from(`120000 blob ${oid}` + String.fromCharCode(9) + 'link.txt', 'utf8'),
              Buffer.from([0]),
              Buffer.from(`160000 commit ${oid}` + String.fromCharCode(9) + 'sub', 'utf8'),
              Buffer.from([0]),
              Buffer.from(`160000 commit ${longOid}` + String.fromCharCode(9) + 'longsub', 'utf8'),
              Buffer.from([0]),
            ]);
            return okCommandResult(stdout);
          }
          if (args[0] === 'check-attr') {
            const input = options?.input ?? Buffer.alloc(0);
            const paths: Buffer[] = [];
            let start = 0;
            for (let i = 0; i < input.length; i += 1) {
              if (input[i] === 0) {
                if (i > start) paths.push(input.subarray(start, i));
                start = i + 1;
              }
            }
            const chunks: Buffer[] = [];
            for (const path of paths) {
              chunks.push(Buffer.concat([path, Buffer.from([0])]));
              chunks.push(Buffer.concat([Buffer.from('filter', 'ascii'), Buffer.from([0])]));
              chunks.push(Buffer.concat([Buffer.from('unspecified', 'ascii'), Buffer.from([0])]));
            }
            return okCommandResult(Buffer.concat(chunks));
          }
          return okCommandResult();
        },
      };

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner,
      });

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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });

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
      const runner = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return okCommandResult(batchCommitStdout(options?.input));
          }
          if (args[0] === 'diff-tree') {
            return okCommandResult(Buffer.concat([Buffer.from('changed.txt', 'utf8'), Buffer.from([0])]));
          }
          if (args[0] === 'ls-tree') {
            return okCommandResult(
              Buffer.concat([
                Buffer.from(`120777 blob ${oid}` + String.fromCharCode(9) + 'bad.txt', 'utf8'),
                Buffer.from([0]),
              ]),
            );
          }
          if (args[0] === 'check-attr') {
            const input = options?.input ?? Buffer.alloc(0);
            const paths: Buffer[] = [];
            let start = 0;
            for (let i = 0; i < input.length; i += 1) {
              if (input[i] === 0) {
                if (i > start) paths.push(input.subarray(start, i));
                start = i + 1;
              }
            }
            const chunks: Buffer[] = [];
            for (const path of paths) {
              chunks.push(Buffer.concat([path, Buffer.from([0])]));
              chunks.push(Buffer.concat([Buffer.from('filter', 'ascii'), Buffer.from([0])]));
              chunks.push(Buffer.concat([Buffer.from('unspecified', 'ascii'), Buffer.from([0])]));
            }
            return okCommandResult(Buffer.concat(chunks));
          }
          return okCommandResult();
        },
      };

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner,
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe('malformed_git_output');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not write refs, index or worktree',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');

      // Symlink creation can require privileges on Windows; only attempt it when available.
      try {
        symlinkSync('file.txt', join(repo.path, 'link.txt'));
      } catch {
        // Ignore unsupported or privileged symlink creation.
      }

      const gitDir = join(repo.path, '.git');
      function snapshotLogs(): { path: string; bytes: string }[] {
        return walkFiles(join(gitDir, 'logs')).map((file) => ({
          path: file.slice(gitDir.length),
          bytes: readFileSync(file).toString('base64'),
        }));
      }
      function snapshotLocks(): string[] {
        return walkFiles(gitDir)
          .filter((file) => file.endsWith('.lock'))
          .map((file) => file.slice(gitDir.length))
          .sort();
      }
      function snapshotObjectStore(): string[] {
        return walkFiles(join(gitDir, 'objects'))
          .map((file) => file.slice(gitDir.length))
          .sort();
      }
      function snapshotPackedRefs(): string {
        const packedRefs = join(gitDir, 'packed-refs');
        return existsSync(packedRefs) ? readFileSync(packedRefs).toString('base64') : '';
      }
      function snapshotSymlinks(root: string): { path: string; target: string }[] {
        const result: { path: string; target: string }[] = [];
        const visit = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name !== '.git') visit(full);
            } else if (entry.isSymbolicLink()) {
              result.push({ path: full.slice(root.length + 1), target: readlinkSync(full) });
            }
          }
        };
        visit(root);
        return result.sort((a, b) => a.path.localeCompare(b.path));
      }
      const before = {
        refs: repo.git('for-each-ref'),
        headSym: repo.git('symbolic-ref', 'HEAD'),
        headSha: repo.git('rev-parse', 'HEAD'),
        indexBytes: readFileSync(join(gitDir, 'index')).toString('base64'),
        staged: repo.git('ls-files', '--stage'),
        file: readFileSync(join(repo.path, 'file.txt')).toString('base64'),
        symlinks: snapshotSymlinks(repo.path),
        config: readFileSync(join(gitDir, 'config')).toString('base64'),
        exclude: readFileSync(join(gitDir, 'info', 'exclude')).toString('base64'),
        logs: snapshotLogs(),
        locks: snapshotLocks(),
        objectStore: snapshotObjectStore(),
        packedRefs: snapshotPackedRefs(),
      };
      expect(before.locks).toEqual([]);

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });

      expect(result.ok).toBe(true);
      const after = {
        refs: repo.git('for-each-ref'),
        headSym: repo.git('symbolic-ref', 'HEAD'),
        headSha: repo.git('rev-parse', 'HEAD'),
        indexBytes: readFileSync(join(gitDir, 'index')).toString('base64'),
        staged: repo.git('ls-files', '--stage'),
        file: readFileSync(join(repo.path, 'file.txt')).toString('base64'),
        symlinks: snapshotSymlinks(repo.path),
        config: readFileSync(join(gitDir, 'config')).toString('base64'),
        exclude: readFileSync(join(gitDir, 'info', 'exclude')).toString('base64'),
        logs: snapshotLogs(),
        locks: snapshotLocks(),
        objectStore: snapshotObjectStore(),
        packedRefs: snapshotPackedRefs(),
      };
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
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('invalid_input');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'distinguishes missing commit from command failure',
    async () => {
      const repo = createRepository();
      repo.write('file.txt', 'v1\n');
      const base = repo.commit('base');
      repo.write('file.txt', 'v2\n');
      const source = repo.commit('source');
      const missing = '0'.repeat(40);

      const missingRunner = {
        run: async (args: readonly string[], options?: { input?: Buffer }) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            const oid = (options?.input ?? Buffer.alloc(0)).toString('ascii').trim();
            if (oid === missing) {
              return okCommandResult(Buffer.from(`${missing} missing\n`));
            }
            return okCommandResult(Buffer.from(`${oid} commit\n`));
          }
          return okCommandResult();
        },
      };
      const missingResult = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: missing,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: missingRunner,
      });
      expect(missingResult.status).toBe('git_object_missing');

      const failureRunner = {
        run: async (args: readonly string[]) => {
          if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
            return okCommandResult(Buffer.from(`${repo.path}\n`));
          }
          if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
            return okCommandResult(Buffer.from('sha1\n'));
          }
          if (args[0] === 'cat-file') {
            return {
              ok: false,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from('fatal: bad object'),
              exitCode: 128,
              timedOut: false,
              truncated: false,
            };
          }
          return okCommandResult();
        },
      };
      const failureResult = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
        runner: failureRunner,
      });
      expect(failureResult.status).toBe('git_command_failed');
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

      const result = await observeContentTree({
        repoRoot: repo.path,
        expectedBaseCommit: base,
        acceptedSourceCommit: source,
        destinationObservationCommit: source,
        objectFormat: 'sha1',
      });
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
        const seenEnvs: NodeJS.ProcessEnv[] = [];
        const seenArgs: string[][] = [];
        const runner = {
          run: async (args: readonly string[], options?: { input?: Buffer; env?: NodeJS.ProcessEnv }) => {
            seenArgs.push([...args]);
            if (options?.env) seenEnvs.push(options.env);
            if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
              return okCommandResult(Buffer.from(`${repo.path}\n`));
            }
            if (args[0] === 'rev-parse' && args[1] === '--show-object-format') {
              return okCommandResult(Buffer.from('sha1\n'));
            }
            if (args[0] === 'cat-file') {
              return okCommandResult(batchCommitStdout(options?.input));
            }
            if (args[0] === 'diff-tree') {
              return okCommandResult(Buffer.concat([Buffer.from('changed.txt', 'utf8'), Buffer.from([0])]));
            }
            if (args[0] === 'ls-tree') {
              return okCommandResult(Buffer.alloc(0));
            }
            if (args[0] === 'check-attr') {
              const input = options?.input ?? Buffer.alloc(0);
              const paths: Buffer[] = [];
              let start = 0;
              for (let i = 0; i < input.length; i += 1) {
                if (input[i] === 0) {
                  if (i > start) paths.push(input.subarray(start, i));
                  start = i + 1;
                }
              }
              const chunks: Buffer[] = [];
              for (const path of paths) {
                chunks.push(Buffer.concat([path, Buffer.from([0])]));
                chunks.push(Buffer.concat([Buffer.from('filter', 'ascii'), Buffer.from([0])]));
                chunks.push(Buffer.concat([Buffer.from('unspecified', 'ascii'), Buffer.from([0])]));
              }
              return okCommandResult(Buffer.concat(chunks));
            }
            return okCommandResult();
          },
        };

        const result = await observeContentTree({
          repoRoot: repo.path,
          expectedBaseCommit: base,
          acceptedSourceCommit: source,
          destinationObservationCommit: source,
          objectFormat: 'sha1',
          runner,
        });

        expect(result.ok).toBe(true);
        expect(seenEnvs.length).toBeGreaterThan(0);
        for (const env of seenEnvs) {
          expect(env.GIT_DIR).toBeUndefined();
          expect(env.GIT_INDEX_FILE).toBeUndefined();
          expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
          expect(env.GIT_CONFIG_COUNT).toBeUndefined();
          expect(env.GIT_ATTR_NOSYSTEM).toBe('1');
          expect(env.GIT_PAGER).toBe('cat');
        }
        const diffInvocation = seenArgs.find((args) => args[0] === 'diff-tree');
        expect(diffInvocation).toBeDefined();
        expect(diffInvocation).toContain('--no-ext-diff');
        expect(diffInvocation).toContain('--no-textconv');
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
