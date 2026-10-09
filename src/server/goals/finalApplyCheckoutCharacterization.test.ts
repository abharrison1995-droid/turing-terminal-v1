import { afterEach, describe, expect, it } from 'vitest';
import { cleanupRepoFixtures, goalRepoFixture } from './repoKit.js';

afterEach(cleanupRepoFixtures);

describe('checked-out branch ref-only characterization', () => {
  it('leaves the index and worktree behind when the checked-out branch ref moves directly', () => {
    const fx = goalRepoFixture();
    const commit = fx.sideCommit({ 'src/ref-only.txt': 'new branch content\n' });

    // The Goal fixture has a separate source ref. Advancing main directly models a ref CAS
    // without the checkout synchronization that a complete final apply also needs.
    fx.git('update-ref', 'refs/heads/main', commit, fx.baseCommit);

    expect(fx.git('rev-parse', 'HEAD')).toBe(commit);
    expect(fx.git('rev-parse', 'refs/heads/main')).toBe(commit);
    expect(fx.git('diff', '--cached', '--name-status', '--')).toContain('src/ref-only.txt');
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).not.toBe('');

    fx.git('read-tree', '-m', '-u', fx.baseCommit, commit);
    expect(fx.git('rev-parse', 'HEAD')).toBe(commit);
    expect(fx.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(fx.git('show', 'HEAD:src/ref-only.txt')).toBe('new branch content');
  });
});
