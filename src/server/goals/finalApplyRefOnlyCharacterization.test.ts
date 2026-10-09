import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

type ObjectFormat = 'sha1' | 'sha256';

interface RefFixture {
  parent: string;
  repo: string;
  linked: string;
  base: string;
  baseTree: string;
  approved: string;
  approvedTree: string;
  goalRef: string;
  deliveryRef: string;
}

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitResult(
  cwd: string,
  args: string[],
  input?: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: failure.status ?? 1,
      stdout: String(failure.stdout ?? '').trim(),
      stderr: String(failure.stderr ?? '').trim(),
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = gitResult(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function createFixture(format: ObjectFormat = 'sha1'): RefFixture {
  const parent = mkdtempSync(join(tmpdir(), `tt-final-apply-ref-${randomUUID()}-`));
  fixtureRoots.push(parent);
  const repo = join(parent, 'repo');
  const linked = join(parent, 'linked');
  const formatArgs = format === 'sha256' ? ['--object-format=sha256'] : [];
  mkdirSync(repo);
  const init = gitResult(repo, ['init', '--quiet', '--initial-branch=main', ...formatArgs]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  git(repo, 'config', 'user.name', 'Ref-Only Safety Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.logAllRefUpdates', 'true');
  writeFileSync(join(repo, 'tracked.txt'), 'BASE-TRACKED-BYTES\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const baseTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  const goalId = randomUUID();
  const goalBranch = `turing/goal/${goalId}`;
  git(repo, 'switch', '--quiet', '-c', goalBranch);
  writeFileSync(join(repo, 'tracked.txt'), 'APPROVED-TRACKED-BYTES\n');
  writeFileSync(join(repo, 'result.txt'), 'APPROVED-RESULT-BYTES\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'approved Goal result');
  const approved = git(repo, 'rev-parse', 'HEAD');
  const approvedTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  const goalRef = `refs/heads/${goalBranch}`;
  const deliveryRef = `refs/heads/turing/delivery/${goalId}`;
  return { parent, repo, linked, base, baseTree, approved, approvedTree, goalRef, deliveryRef };
}

function worktreeTokens(repo: string): string[] {
  const listing = git(repo, 'worktree', 'list', '--porcelain', '-z');
  return listing.split('\0').filter(Boolean);
}

function refTransaction(
  repo: string,
  sourceRef: string,
  expectedSource: string,
  destinationRef: string,
  newDestination: string,
  expectedDestination: string,
): { status: number; stderr: string } {
  const input = [
    'start',
    `verify ${sourceRef} ${expectedSource}`,
    `update ${destinationRef} ${newDestination} ${expectedDestination}`,
    'prepare',
    'commit',
    '',
  ].join('\n');
  const result = gitResult(repo, ['update-ref', '--stdin'], input);
  return { status: result.status, stderr: result.stderr };
}

describe('Git ref-only final-apply characterization', () => {
  it('allows checkout occupancy to race between worktree snapshot and destination ref CAS', () => {
    const fixture = createFixture();
    const destinationRef = 'refs/heads/main';
    const snapshot = worktreeTokens(fixture.repo);
    expect(snapshot).not.toContain(`branch ${destinationRef}`);

    // Deterministic interleaving: a separate Git process checks out the branch after the occupancy snapshot.
    expect(gitResult(fixture.repo, ['worktree', 'add', '--quiet', fixture.linked, 'main']).status).toBe(0);
    expect(worktreeTokens(fixture.repo)).toContain(`branch ${destinationRef}`);
    expect(git(fixture.linked, 'rev-parse', 'HEAD')).toBe(fixture.base);
    expect(git(fixture.linked, 'write-tree')).toBe(fixture.baseTree);
    expect(gitResult(fixture.repo, ['switch', 'main']).status).not.toBe(0);
    expect(gitResult(fixture.repo, ['checkout', 'main']).status).not.toBe(0);
    expect(gitResult(fixture.repo, ['switch', '--ignore-other-worktrees', 'main']).status).toBe(0);
    const linkedGitDir = git(fixture.linked, 'rev-parse', '--absolute-git-dir');
    const linkedIndexLock = join(linkedGitDir, 'index.lock');
    writeFileSync(linkedIndexLock, 'held by an unrelated checkout operation\n');

    // The porcelain branch command refuses this update, but low-level ref CAS does not inspect worktree occupancy.
    const guardedBranchCommand = gitResult(fixture.repo, ['branch', '-f', 'main', fixture.approved]);
    expect(guardedBranchCommand.status).not.toBe(0);
    expect(guardedBranchCommand.stderr).toMatch(/checked out|worktree/i);
    expect(
      gitResult(fixture.repo, [
        'update-ref',
        '-m',
        'ref-only-race-test',
        destinationRef,
        fixture.approved,
        fixture.base,
      ]).status,
    ).toBe(0);
    rmSync(linkedIndexLock, { force: true });

    // HEAD is a symbolic ref, so it now resolves to the new commit while the checkout remains on the old index/tree.
    expect(git(fixture.linked, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(git(fixture.linked, 'rev-parse', 'HEAD')).toBe(fixture.approved);
    expect(git(fixture.linked, 'rev-parse', 'HEAD^{tree}')).toBe(fixture.approvedTree);
    expect(git(fixture.linked, 'write-tree')).toBe(fixture.baseTree);
    expect(readFileSync(join(fixture.linked, 'tracked.txt'), 'utf8')).toBe('BASE-TRACKED-BYTES\n');
    expect(existsSync(join(fixture.linked, 'result.txt'))).toBe(false);
  });

  it('checks out a ref-only update consistently when the CAS completes before checkout begins', () => {
    const fixture = createFixture();
    const destinationRef = 'refs/heads/main';
    expect(worktreeTokens(fixture.repo)).not.toContain(`branch ${destinationRef}`);
    expect(
      gitResult(fixture.repo, [
        'update-ref',
        '-m',
        'ref-only-before-checkout-test',
        destinationRef,
        fixture.approved,
        fixture.base,
      ]).status,
    ).toBe(0);

    expect(gitResult(fixture.repo, ['worktree', 'add', '--quiet', fixture.linked, 'main']).status).toBe(0);
    expect(git(fixture.linked, 'rev-parse', 'HEAD')).toBe(fixture.approved);
    expect(git(fixture.linked, 'write-tree')).toBe(fixture.approvedTree);
    expect(readFileSync(join(fixture.linked, 'tracked.txt'), 'utf8')).toBe('APPROVED-TRACKED-BYTES\n');
    expect(readFileSync(join(fixture.linked, 'result.txt'), 'utf8')).toBe('APPROVED-RESULT-BYTES\n');
  });

  it('atomically refuses a transaction when the approved source ref moved after it was read', () => {
    const fixture = createFixture();
    const thirdCommit = git(
      fixture.repo,
      'commit-tree',
      `${fixture.base}^{tree}`,
      '-p',
      fixture.base,
      '-m',
      'external Goal movement',
    );
    expect(
      gitResult(fixture.repo, ['update-ref', fixture.goalRef, thirdCommit, fixture.approved]).status,
    ).toBe(0);

    const result = refTransaction(
      fixture.repo,
      fixture.goalRef,
      fixture.approved,
      'refs/heads/main',
      fixture.approved,
      fixture.base,
    );

    expect(result.status).not.toBe(0);
    expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(fixture.base);
    expect(git(fixture.repo, 'rev-parse', fixture.goalRef)).toBe(thirdCommit);
  });

  it('atomically refuses a transaction when the destination ref moved after it was read', () => {
    const fixture = createFixture();
    const thirdCommit = git(
      fixture.repo,
      'commit-tree',
      `${fixture.base}^{tree}`,
      '-p',
      fixture.base,
      '-m',
      'external base movement',
    );
    expect(gitResult(fixture.repo, ['update-ref', 'refs/heads/main', thirdCommit, fixture.base]).status).toBe(
      0,
    );

    const result = refTransaction(
      fixture.repo,
      fixture.goalRef,
      fixture.approved,
      'refs/heads/main',
      fixture.approved,
      fixture.base,
    );

    expect(result.status).not.toBe(0);
    expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(thirdCommit);
    expect(git(fixture.repo, 'rev-parse', fixture.goalRef)).toBe(fixture.approved);
  });

  it('honors the common-dir lock for a destination ref, without treating it as a worktree lock', () => {
    const fixture = createFixture();
    const commonDir = git(fixture.repo, 'rev-parse', '--git-common-dir');
    const lockPath = join(fixture.repo, commonDir, 'refs', 'heads', 'main.lock');
    writeFileSync(lockPath, 'held by an unrelated ref update\n', { flag: 'wx' });

    const blocked = gitResult(fixture.repo, [
      'update-ref',
      'refs/heads/main',
      fixture.approved,
      fixture.base,
    ]);
    expect(blocked.status).not.toBe(0);
    expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(fixture.base);

    rmSync(lockPath, { force: true });
    expect(
      gitResult(fixture.repo, ['update-ref', 'refs/heads/main', fixture.approved, fixture.base]).status,
    ).toBe(0);
    expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(fixture.approved);
  });

  it('reports stale linked-worktree metadata as prunable until explicit pruning', () => {
    const fixture = createFixture();
    expect(gitResult(fixture.repo, ['worktree', 'add', '--quiet', fixture.linked, 'main']).status).toBe(0);
    const live = worktreeTokens(fixture.repo);
    expect(live).toContain(`branch refs/heads/main`);

    // Only remove the test-created linked directory; intentionally leave Git's administrative registration behind.
    rmSync(fixture.linked, { recursive: true, force: true });
    const stale = worktreeTokens(fixture.repo);
    expect(stale).toContain('prunable gitdir file points to non-existent location');
    expect(stale).toContain('branch refs/heads/main');

    expect(gitResult(fixture.repo, ['worktree', 'prune', '--expire=now']).status).toBe(0);
    expect(worktreeTokens(fixture.repo)).not.toContain('branch refs/heads/main');
  });

  it.each(['sha1', 'sha256'] as const)(
    'creates a non-overwriting delivery ref with a reflog in %s format',
    (format) => {
      const fixture = createFixture(format);
      const zero = '0'.repeat(format === 'sha256' ? 64 : 40);
      const created = gitResult(fixture.repo, [
        'update-ref',
        '-m',
        'turing-delivery:test-operation',
        fixture.deliveryRef,
        fixture.approved,
        zero,
      ]);
      expect(created.status).toBe(0);
      expect(git(fixture.repo, 'rev-parse', fixture.deliveryRef)).toBe(fixture.approved);
      expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(fixture.base);
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.approved);
      expect(git(fixture.repo, 'write-tree')).toBe(fixture.approvedTree);
      expect(git(fixture.repo, 'reflog', 'show', '--format=%gs', '-1', fixture.deliveryRef)).toBe(
        'turing-delivery:test-operation',
      );

      const duplicateCreate = gitResult(fixture.repo, [
        'update-ref',
        fixture.deliveryRef,
        fixture.approved,
        zero,
      ]);
      expect(duplicateCreate.status).not.toBe(0);
      expect(git(fixture.repo, 'rev-parse', fixture.deliveryRef)).toBe(fixture.approved);
    },
  );

  it('does not overwrite a pre-existing delivery-ref collision', () => {
    const fixture = createFixture();
    const zero = '0'.repeat(40);
    const unrelated = git(
      fixture.repo,
      'commit-tree',
      `${fixture.base}^{tree}`,
      '-p',
      fixture.base,
      '-m',
      'unrelated existing delivery name',
    );
    expect(gitResult(fixture.repo, ['update-ref', fixture.deliveryRef, unrelated, zero]).status).toBe(0);

    const createAttempt = gitResult(fixture.repo, [
      'update-ref',
      fixture.deliveryRef,
      fixture.approved,
      zero,
    ]);

    expect(createAttempt.status).not.toBe(0);
    expect(git(fixture.repo, 'rev-parse', fixture.deliveryRef)).toBe(unrelated);
    expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(fixture.base);
  });

  it('can make an unborn linked delivery checkout resolve to a new ref with an empty stale index', () => {
    const fixture = createFixture();
    const branch = fixture.deliveryRef.slice('refs/heads/'.length);
    const zero = '0'.repeat(40);
    const added = gitResult(fixture.repo, [
      'worktree',
      'add',
      '--quiet',
      '--orphan',
      '-b',
      branch,
      fixture.linked,
    ]);
    expect(added.status).toBe(0);
    expect(gitResult(fixture.repo, ['show-ref', '--verify', '--quiet', fixture.deliveryRef]).status).not.toBe(
      0,
    );
    expect(worktreeTokens(fixture.repo)).toContain(`branch ${fixture.deliveryRef}`);
    expect(git(fixture.linked, 'symbolic-ref', 'HEAD')).toBe(fixture.deliveryRef);

    const created = gitResult(fixture.repo, [
      'update-ref',
      '-m',
      'unborn-delivery-race-test',
      fixture.deliveryRef,
      fixture.approved,
      zero,
    ]);

    expect(created.status).toBe(0);
    expect(git(fixture.linked, 'rev-parse', 'HEAD')).toBe(fixture.approved);
    expect(git(fixture.linked, 'write-tree')).not.toBe(fixture.approvedTree);
    expect(existsSync(join(fixture.linked, 'tracked.txt'))).toBe(false);
    expect(existsSync(join(fixture.linked, 'result.txt'))).toBe(false);
  });

  it('observes a committed ref-only operation from a fresh Git process after the writer exits', () => {
    const fixture = createFixture();
    expect(
      gitResult(fixture.repo, [
        'update-ref',
        '-m',
        'ref-only-restart-test',
        'refs/heads/main',
        fixture.approved,
        fixture.base,
      ]).status,
    ).toBe(0);

    // Each git() call starts a separate process, so the ref and reflog are read after the updater exited.
    expect(git(fixture.repo, 'rev-parse', 'refs/heads/main')).toBe(fixture.approved);
    expect(git(fixture.repo, 'reflog', 'show', '--format=%gs', '-1', 'refs/heads/main')).toBe(
      'ref-only-restart-test',
    );
    expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.approved);
    expect(git(fixture.repo, 'write-tree')).toBe(fixture.approvedTree);
  });
});
