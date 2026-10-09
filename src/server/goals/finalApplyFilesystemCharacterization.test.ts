import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

interface CheckoutFixture {
  root: string;
  old: string;
  next: string;
}

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function checkoutFixture(
  baseFiles: Record<string, string>,
  goalFiles: Record<string, string>,
  remove: string[] = [],
  ignored: string[] = [],
): CheckoutFixture {
  const root = mkdtempSync(join(tmpdir(), `tt-final-apply-fs-${randomUUID()}-`));
  fixtureRoots.push(root);
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Filesystem Safety Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  const initialFiles = Object.keys(baseFiles).length > 0 ? baseFiles : { 'baseline.txt': 'BASELINE-BYTES\n' };
  for (const [path, bytes] of Object.entries(initialFiles)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'base');
  const old = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--quiet', '-b', 'turing/goal');
  for (const path of remove) rmSync(join(root, path), { recursive: true, force: true });
  for (const [path, bytes] of Object.entries(goalFiles)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'approved Goal');
  const next = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--quiet', 'main');
  if (ignored.length)
    writeFileSync(join(root, '.git', 'info', 'exclude'), `${ignored.map((path) => `/${path}`).join('\n')}\n`);
  return { root, old, next };
}

function moveCheckedOutBaseRef(fixture: CheckoutFixture): void {
  git(fixture.root, 'update-ref', 'refs/heads/main', fixture.next, fixture.old);
}

function readTree(fixture: CheckoutFixture): { status: number; stderr: string } {
  try {
    git(fixture.root, 'read-tree', '-m', '-u', fixture.old, fixture.next);
    return { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? 128, stderr: failure.stderr?.trim() ?? '' };
  }
}

const liveCheckoutCases = describe.skipIf(process.platform === 'win32');

liveCheckoutCases('Git live-checkout filesystem characterization', () => {
  it('overwrites an ignored file created at the final boundary and reports a clean checkout', () => {
    const fixture = checkoutFixture({}, { 'src/new.txt': 'APPROVED-GOAL-BYTES\n' }, [], ['src/new.txt']);
    moveCheckedOutBaseRef(fixture);
    const target = join(fixture.root, 'src', 'new.txt');
    const original = 'USER-ORIGINAL-IGNORED-BYTES\n';
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, original);

    const before = readFileSync(target, 'utf8');
    const result = readTree(fixture);
    const after = existsSync(target) ? readFileSync(target, 'utf8') : '<missing>';

    expect(before).toBe(original);
    expect(result.status).toBe(0);
    expect(after).toBe('APPROVED-GOAL-BYTES\n');
    expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(fixture.next);
    expect(git(fixture.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  });

  it('refuses an ordinary untracked target and preserves its bytes', () => {
    const fixture = checkoutFixture({}, { 'src/new.txt': 'APPROVED-GOAL-BYTES\n' });
    moveCheckedOutBaseRef(fixture);
    const target = join(fixture.root, 'src', 'new.txt');
    const original = 'USER-ORDINARY-UNTRACKED-BYTES\n';
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, original);

    const result = readTree(fixture);

    expect(result.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(git(fixture.root, 'rev-parse', 'refs/heads/main')).toBe(fixture.next);
  });

  it('refuses a tracked-file edit after validation and preserves the editor bytes', () => {
    const fixture = checkoutFixture({ 'tracked.txt': 'BASE-BYTES\n' }, { 'tracked.txt': 'APPROVED-BYTES\n' });
    moveCheckedOutBaseRef(fixture);
    const target = join(fixture.root, 'tracked.txt');
    const original = 'USER-EDITED-TRACKED-BYTES\n';
    writeFileSync(target, original);

    const result = readTree(fixture);

    expect(result.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('refuses a staged index change made after validation and preserves the staged bytes', () => {
    const fixture = checkoutFixture(
      { 'tracked.txt': 'BASE-BYTES\n' },
      { 'tracked.txt': 'APPROVED-BYTES\n', 'new.txt': 'APPROVED-NEW-BYTES\n' },
    );
    moveCheckedOutBaseRef(fixture);
    const target = join(fixture.root, 'tracked.txt');
    const original = 'USER-STAGED-TRACKED-BYTES\n';
    writeFileSync(target, original);
    git(fixture.root, 'add', 'tracked.txt');

    const result = readTree(fixture);

    expect(result.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(git(fixture.root, 'status', '--porcelain=v1')).toContain('M  tracked.txt');
  });

  it('refuses a symlink at a new target without following it', () => {
    const fixture = checkoutFixture({}, { 'src/new.txt': 'APPROVED-GOAL-BYTES\n' });
    moveCheckedOutBaseRef(fixture);
    const target = join(fixture.root, 'src', 'new.txt');
    const outside = join(fixtureRoots[0]!, 'outside-sentinel.txt');
    writeFileSync(outside, 'OUTSIDE-SENTINEL-BYTES\n');
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(outside, target);

    const result = readTree(fixture);

    expect(result.status).not.toBe(0);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(outside);
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE-SENTINEL-BYTES\n');
  });

  it('refuses a parent directory replaced by a symlink without writing outside the repository', () => {
    const fixture = checkoutFixture({}, { 'parent/new.txt': 'APPROVED-GOAL-BYTES\n' });
    moveCheckedOutBaseRef(fixture);
    const externalRoot = join(fixtureRoots[0]!, 'external');
    mkdirSync(externalRoot);
    const outside = join(externalRoot, 'new.txt');
    writeFileSync(outside, 'OUTSIDE-SENTINEL-BYTES\n');
    symlinkSync(externalRoot, join(fixture.root, 'parent'));

    const result = readTree(fixture);

    expect(result.status).not.toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE-SENTINEL-BYTES\n');
  });

  it('refuses file-to-directory and directory-to-file transitions with concurrent user children', () => {
    const fileToDirectory = checkoutFixture(
      { node: 'BASE-FILE\n' },
      { 'node/goal.txt': 'APPROVED-GOAL-BYTES\n' },
      ['node'],
    );
    moveCheckedOutBaseRef(fileToDirectory);
    const nodePath = join(fileToDirectory.root, 'node');
    rmSync(nodePath);
    mkdirSync(nodePath);
    writeFileSync(join(nodePath, 'user.txt'), 'USER-DIRECTORY-CHILD\n');
    const first = readTree(fileToDirectory);

    const directoryToFile = checkoutFixture(
      { 'node/base.txt': 'BASE-CHILD\n' },
      { node: 'APPROVED-GOAL-BYTES\n' },
      ['node'],
    );
    moveCheckedOutBaseRef(directoryToFile);
    const directoryPath = join(directoryToFile.root, 'node');
    writeFileSync(join(directoryPath, 'user.txt'), 'USER-DIRECTORY-CHILD\n');
    const second = readTree(directoryToFile);

    expect(first.status).not.toBe(0);
    expect(readFileSync(join(nodePath, 'user.txt'), 'utf8')).toBe('USER-DIRECTORY-CHILD\n');
    expect(second.status).not.toBe(0);
    expect(readFileSync(join(directoryPath, 'user.txt'), 'utf8')).toBe('USER-DIRECTORY-CHILD\n');
  });

  it('refuses index-lock contention and leaves the lock file untouched', () => {
    const fixture = checkoutFixture({}, { 'new.txt': 'APPROVED-GOAL-BYTES\n' });
    moveCheckedOutBaseRef(fixture);
    const lock = join(fixture.root, '.git', 'index.lock');
    writeFileSync(lock, 'USER-OR-OTHER-PROCESS-LOCK\n');

    const result = readTree(fixture);

    expect(result.status).not.toBe(0);
    expect(readFileSync(lock, 'utf8')).toBe('USER-OR-OTHER-PROCESS-LOCK\n');
    rmSync(lock);
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses filesystem permission failure without claiming a complete sync',
    () => {
      const fixture = checkoutFixture({}, { 'blocked/new.txt': 'APPROVED-GOAL-BYTES\n' });
      moveCheckedOutBaseRef(fixture);
      const blocked = join(fixture.root, 'blocked');
      mkdirSync(blocked);
      chmodSync(blocked, 0o555);

      const result = readTree(fixture);

      chmodSync(blocked, 0o755);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(blocked, 'new.txt'))).toBe(false);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'can partially update earlier paths before a later permission failure',
    () => {
      const fixture = checkoutFixture(
        { 'z/keep.txt': 'BASE-BYTES\n' },
        { 'a-new.txt': 'FIRST-GOAL-BYTES\n', 'z/blocked.txt': 'SECOND-GOAL-BYTES\n' },
      );
      moveCheckedOutBaseRef(fixture);
      const blocked = join(fixture.root, 'z');
      chmodSync(blocked, 0o555);

      const result = readTree(fixture);

      chmodSync(blocked, 0o755);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(fixture.root, 'a-new.txt'), 'utf8')).toBe('FIRST-GOAL-BYTES\n');
      expect(existsSync(join(blocked, 'blocked.txt'))).toBe(false);
    },
  );
});
