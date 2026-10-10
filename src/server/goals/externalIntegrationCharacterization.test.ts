import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ObjectFormat = 'sha1' | 'sha256';

interface Repository {
  root: string;
  path: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (message: string) => string;
  head: () => string;
  tree: (commit: string) => string;
  ancestor: (older: string, newer: string) => boolean;
}

const roots: string[] = [];
const FIXED_DATE = '2001-01-01T00:00:00Z';

function gitResult(cwd: string, args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    },
  });
}

function createRepository(format: ObjectFormat = 'sha1'): Repository {
  const root = mkdtempSync(join(tmpdir(), 'goal-external-integration-'));
  roots.push(root);
  const path = join(root, 'repo');
  mkdirSync(path);
  const initialized = spawnSync(
    'git',
    ['init', '--quiet', '--initial-branch=main', `--object-format=${format}`, path],
    {
      encoding: 'utf8',
    },
  );
  if (initialized.status !== 0)
    throw new Error(`Git repository initialization failed (${format}): ${initialized.stderr}`);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
      },
    }).trimEnd();
  git('config', 'user.name', 'External Integration Test');
  git('config', 'user.email', 'external-integration@example.invalid');
  const write = (relativePath: string, content: string) => {
    const fullPath = join(path, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const head = () => git('rev-parse', 'HEAD');
  const tree = (commitId: string) => git('rev-parse', `${commitId}^{tree}`);
  const ancestor = (older: string, newer: string) => {
    const result = gitResult(path, ['merge-base', '--is-ancestor', older, newer]);
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`git merge-base failed: ${result.stderr}`);
    return result.status === 0;
  };
  return { root, path, git, write, commit, head, tree, ancestor };
}

function patchId(repo: Repository, commit: string): string {
  const patch = repo.git('show', '--pretty=format:', '--no-ext-diff', commit);
  const output = execFileSync('git', ['patch-id', '--stable'], { input: patch, encoding: 'utf8' }).trim();
  return output.split(/\s+/)[0] ?? '';
}

function canInitializeSha256(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'goal-sha256-probe-'));
  try {
    const result = spawnSync('git', ['init', '--quiet', '--object-format=sha256', root], {
      encoding: 'utf8',
    });
    return result.status === 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('external integration Git characterization (disposable repositories only)', () => {
  it('proves source-history ancestry for fast-forward and merge commits, including later unrelated commits', () => {
    const ff = createRepository();
    ff.write('base.txt', 'base\n');
    const base = ff.commit('base');
    ff.git('switch', '--quiet', '-c', 'goal');
    ff.write('goal.txt', 'accepted result\n');
    const source = ff.commit('goal result');
    ff.git('switch', '--quiet', 'main');
    ff.git('merge', '--quiet', '--ff-only', 'goal');
    expect(ff.ancestor(base, ff.head())).toBe(true);
    expect(ff.ancestor(source, ff.head())).toBe(true);
    expect(ff.tree(source)).toBe(ff.tree(ff.head()));

    const merged = createRepository();
    merged.write('base.txt', 'base\n');
    const mergeBase = merged.commit('base');
    merged.git('switch', '--quiet', '-c', 'goal');
    merged.write('goal.txt', 'accepted result\n');
    const mergeSource = merged.commit('goal result');
    merged.git('switch', '--quiet', 'main');
    merged.write('target.txt', 'independent target advancement\n');
    const targetAdvance = merged.commit('target advance');
    merged.git('merge', '--quiet', '--no-ff', '-m', 'integrate goal', 'goal');
    const mergeCommit = merged.head();
    expect(merged.ancestor(mergeBase, mergeCommit)).toBe(true);
    expect(merged.ancestor(targetAdvance, mergeCommit)).toBe(true);
    expect(merged.ancestor(mergeSource, mergeCommit)).toBe(true);
    expect(merged.tree(mergeSource)).not.toBe(merged.tree(mergeCommit));

    merged.write('later.txt', 'unrelated post-integration commit\n');
    const later = merged.commit('unrelated later work');
    expect(merged.ancestor(mergeSource, later)).toBe(true);
    expect(merged.ancestor(mergeBase, later)).toBe(true);
  });

  it('shows git merge -s ours satisfies ancestry while dropping the accepted source content', () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('accepted-result.txt', 'accepted result that must be reviewed\n');
    const source = repo.commit('accepted Goal result');
    repo.git('switch', '--quiet', 'main');
    repo.write('destination-only.txt', 'independent destination content\n');
    repo.commit('destination change');
    const targetBeforeMerge = repo.head();

    repo.git('merge', '--quiet', '--no-ff', '-s', 'ours', '-m', 'intentionally omit source tree', 'goal');
    const destination = repo.head();

    expect(repo.ancestor(base, destination)).toBe(true);
    expect(repo.ancestor(source, destination)).toBe(true);
    expect(repo.ancestor(targetBeforeMerge, destination)).toBe(true);
    expect(repo.tree(source)).not.toBe(repo.tree(destination));
    expect(repo.git('ls-tree', '-r', '--name-only', destination)).not.toContain('accepted-result.txt');
    expect(repo.git('ls-tree', '-r', '--name-only', destination)).toContain('destination-only.txt');
  });

  it('shows squash, cherry-pick and rebase create non-ancestral commit identities even when patches match', () => {
    for (const mode of ['squash', 'cherry-pick'] as const) {
      const repo = createRepository();
      repo.write('base.txt', 'base\n');
      const base = repo.commit('base');
      repo.git('switch', '--quiet', '-c', 'goal');
      repo.write('goal.txt', 'accepted result\n');
      const source = repo.commit('goal result');
      repo.git('switch', '--quiet', 'main');
      repo.write('target.txt', 'unrelated target advancement\n');
      const advancedTarget = repo.commit('target advance');
      if (mode === 'squash') {
        repo.git('merge', '--squash', 'goal');
        const result = repo.commit('squashed goal result');
        expect(repo.ancestor(source, result)).toBe(false);
        expect(repo.ancestor(advancedTarget, result)).toBe(true);
        expect(patchId(repo, source)).toBe(patchId(repo, result));
      } else {
        repo.git('cherry-pick', source);
        const result = repo.head();
        expect(repo.ancestor(source, result)).toBe(false);
        expect(repo.ancestor(advancedTarget, result)).toBe(true);
        expect(patchId(repo, source)).toBe(patchId(repo, result));
      }
      expect(repo.ancestor(base, repo.head())).toBe(true);
    }

    const rebased = createRepository();
    rebased.write('base.txt', 'base\n');
    const base = rebased.commit('base');
    rebased.git('switch', '--quiet', '-c', 'goal');
    rebased.write('goal.txt', 'accepted result\n');
    const originalSource = rebased.commit('goal result');
    rebased.git('switch', '--quiet', 'main');
    rebased.write('target.txt', 'target advance\n');
    const advancedTarget = rebased.commit('target advance');
    rebased.git('switch', '--quiet', 'goal');
    rebased.git('rebase', '--quiet', 'main');
    const rebasedSource = rebased.head();
    rebased.git('switch', '--quiet', 'main');
    rebased.git('merge', '--quiet', '--ff-only', 'goal');
    expect(rebasedSource).not.toBe(originalSource);
    expect(rebased.ancestor(originalSource, rebased.head())).toBe(false);
    expect(rebased.ancestor(rebasedSource, rebased.head())).toBe(true);
    expect(rebased.ancestor(advancedTarget, rebased.head())).toBe(true);
    expect(rebased.ancestor(base, rebased.head())).toBe(true);
    expect(patchId(rebased, originalSource)).toBe(patchId(rebased, rebasedSource));
  });

  it('does not infer complete integration from patch identity when cherry-picked content is partial', () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('one.txt', 'accepted one\n');
    repo.write('two.txt', 'accepted two\n');
    const source = repo.commit('two accepted changes');
    repo.git('switch', '--quiet', 'main');
    repo.git('cherry-pick', '--no-commit', source);
    repo.git('restore', '--source=HEAD', '--staged', '--worktree', 'two.txt');
    const partial = repo.commit('partial integration');
    expect(repo.ancestor(source, partial)).toBe(false);
    expect(repo.ancestor(base, partial)).toBe(true);
    expect(repo.tree(source)).not.toBe(repo.tree(partial));
    expect(patchId(repo, source)).not.toBe(patchId(repo, partial));
    expect(() => readFileSync(join(repo.path, 'two.txt'))).toThrow();
  });

  it('shows ancestry preserves source history but cannot prove conflict-resolved tree content', () => {
    const repo = createRepository();
    repo.write('shared.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('shared.txt', 'goal version\n');
    const source = repo.commit('goal change');
    repo.git('switch', '--quiet', 'main');
    repo.write('shared.txt', 'target version\n');
    repo.commit('target change');
    const merge = gitResult(repo.path, ['merge', '--no-commit', '--no-ff', 'goal']);
    expect(merge.status).not.toBe(0);
    repo.write('shared.txt', 'human conflict resolution\n');
    repo.git('add', 'shared.txt');
    const resolved = repo.commit('integrate with conflict resolution');
    expect(repo.ancestor(base, resolved)).toBe(true);
    expect(repo.ancestor(source, resolved)).toBe(true);
    expect(repo.tree(source)).not.toBe(repo.tree(resolved));
    expect(readFileSync(join(repo.path, 'shared.txt'), 'utf8')).toBe('human conflict resolution\n');
  });

  it('detects an external destination-ref move between observation reads without an atomic reservation', async () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('branch', 'destination', base);
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('goal.txt', 'accepted result\n');
    const source = repo.commit('goal result');
    const observedBefore = repo.git('rev-parse', 'refs/heads/destination');

    // A separate Git CLI process moves the ref at a deterministic barrier between reads.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['-C', repo.path, 'update-ref', 'refs/heads/destination', source, base], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr || `git exited ${code}`)),
      );
    });
    const observedAfter = repo.git('rev-parse', 'refs/heads/destination');
    expect(observedBefore).toBe(base);
    expect(observedAfter).toBe(source);
    expect(observedAfter).not.toBe(observedBefore);
    expect(repo.ancestor(source, observedAfter)).toBe(true);
  });

  it('allows an external low-level ref move while a linked worktree has the branch checked out', () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('branch', 'destination', base);
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('goal.txt', 'accepted result\n');
    const source = repo.commit('goal result');
    repo.git('switch', '--quiet', 'main');
    const linked = join(repo.root, 'linked-destination');
    repo.git('worktree', 'add', '--quiet', linked, 'destination');

    const update = spawnSync('git', ['-C', repo.path, 'update-ref', 'refs/heads/destination', source, base], {
      encoding: 'utf8',
    });
    expect(update.status, update.stderr).toBe(0);
    expect(execFileSync('git', ['-C', linked, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
      'refs/heads/destination',
    );
    expect(execFileSync('git', ['-C', linked, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
      source,
    );
    expect(execFileSync('git', ['-C', linked, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()).toBe(
      repo.tree(source),
    );
    expect(() => readFileSync(join(linked, 'goal.txt'))).toThrow();
    expect(execFileSync('git', ['-C', linked, 'rev-parse', ':base.txt'], { encoding: 'utf8' }).trim()).toBe(
      repo.git('rev-parse', `${base}:base.txt`),
    );
    expect(
      execFileSync('git', ['-C', linked, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    ).not.toBe('');
  });

  it('requires repository and destination identity because Git object IDs alone are portable', () => {
    const first = createRepository();
    first.write('same.txt', 'same content\n');
    const firstCommit = first.commit('same commit');
    const second = createRepository();
    second.write('same.txt', 'same content\n');
    const secondCommit = second.commit('same commit');
    expect(secondCommit).toBe(firstCommit);
    const firstCommonDir = first.git('rev-parse', '--path-format=absolute', '--git-common-dir');
    const secondCommonDir = second.git('rev-parse', '--path-format=absolute', '--git-common-dir');
    expect(firstCommonDir).not.toBe(secondCommonDir);

    first.git('branch', 'wrong-destination', firstCommit);
    first.git('switch', '--quiet', '-c', 'goal');
    first.write('goal.txt', 'accepted result\n');
    const source = first.commit('goal result');
    expect(first.ancestor(source, first.git('rev-parse', 'refs/heads/wrong-destination'))).toBe(false);
  });

  it('refuses an unrelated destination-ref move even when its tree exactly matches the handoff source', () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('goal.txt', 'accepted result\n');
    const source = repo.commit('goal result');
    const sourceTree = repo.tree(source);
    const unrelatedCommit = repo.git('commit-tree', sourceTree, '-m', 'same tree, unrelated history');

    // Simulate an unconditional external ref move; this does not touch a production repository.
    repo.git('update-ref', 'refs/heads/main', unrelatedCommit);
    expect(repo.tree(unrelatedCommit)).toBe(sourceTree);
    expect(repo.ancestor(base, unrelatedCommit)).toBe(false);
    expect(repo.ancestor(source, unrelatedCommit)).toBe(false);
  });

  it('treats moved or pruned source identities as stale or unavailable, even if a patch was once prepared', () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    repo.commit('base');
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('goal.txt', 'accepted result\n');
    const preparedSource = repo.commit('goal result');
    const sourceRef = 'refs/heads/turing/goal/example';
    repo.git('update-ref', sourceRef, preparedSource);
    const alternate = repo.git('commit-tree', repo.tree(preparedSource), '-m', 'moved source');
    repo.git('update-ref', sourceRef, alternate, preparedSource);
    repo.git('update-ref', 'refs/heads/goal', alternate, preparedSource);
    expect(repo.git('rev-parse', sourceRef)).toBe(alternate);
    expect(repo.git('cat-file', '-e', `${preparedSource}^{commit}`)).toBe('');

    // Removing the remaining reference and pruning makes the old commit unavailable for proof.
    repo.git('update-ref', '-d', sourceRef, alternate);
    repo.git('reflog', 'expire', '--expire=now', '--all');
    repo.git('gc', '--prune=now', '--quiet');
    const oldObject = gitResult(repo.path, ['cat-file', '-e', `${preparedSource}^{commit}`]);
    expect(oldObject.status).not.toBe(0);
  });

  it('separates committed integration from dirty target-worktree content', () => {
    const repo = createRepository();
    repo.write('base.txt', 'base\n');
    const base = repo.commit('base');
    repo.git('switch', '--quiet', '-c', 'goal');
    repo.write('goal.txt', 'accepted result\n');
    const source = repo.commit('goal result');
    repo.git('switch', '--quiet', 'main');
    repo.git('merge', '--quiet', '--ff-only', 'goal');
    expect(repo.ancestor(source, repo.head())).toBe(true);
    repo.write('uncommitted.txt', 'not in observed destination commit\n');
    repo.write('base.txt', 'uncommitted edit\n');
    expect(repo.git('status', '--porcelain')).not.toBe('');
    expect(repo.tree(repo.head())).toBe(repo.tree(source));
    expect(readFileSync(join(repo.path, 'uncommitted.txt'), 'utf8')).toContain('not in observed');
    expect(repo.ancestor(base, repo.head())).toBe(true);
  });

  it('records repository object format and object-ID width for SHA-1 and SHA-256', () => {
    const sha1 = createRepository('sha1');
    sha1.write('identity.txt', 'format probe\n');
    sha1.commit('format probe');
    expect(sha1.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(sha1.tree(sha1.head())).toMatch(/^[0-9a-f]{40}$/);
  });

  it.skipIf(!canInitializeSha256())('records SHA-256 commit and tree identities at 64 hex characters', () => {
    const sha256 = createRepository('sha256');
    sha256.write('identity.txt', 'format probe\n');
    sha256.commit('format probe');
    expect(sha256.git('rev-parse', '--show-object-format')).toBe('sha256');
    expect(sha256.head()).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256.tree(sha256.head())).toMatch(/^[0-9a-f]{64}$/);
  });
});
