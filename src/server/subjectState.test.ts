import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureSubjectState } from './git.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './goals/repoKit.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

describe('subject state capture', () => {
  let root = '';
  let repo = '';
  let project = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'turing-subject-'));
    repo = join(root, 'repo');
    project = join(repo, 'apps', 'service');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(repo, 'libs'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'turing-test@example.invalid');
    git(repo, 'config', 'user.name', 'Turing Test');
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    writeFileSync(join(project, 'app.txt'), 'app\n');
    writeFileSync(join(project, 'remove-me.txt'), 'old\n');
    writeFileSync(join(repo, 'libs', 'shared.txt'), 'shared\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const headTree = () => git(repo, 'rev-parse', 'HEAD^{tree}');
  const indexBytes = () => readFileSync(join(repo, '.git', 'index'));

  /** The tree a real scoped commit of the working state produces. */
  function committedTree(scope: string): string {
    git(repo, 'add', '-A', '--', scope);
    git(repo, 'commit', '-qm', 'scoped', '--allow-empty');
    return headTree();
  }

  it(
    'returns the HEAD tree for a clean worktree',
    async () => {
      const state = await captureSubjectState(repo);
      expect(state).toEqual({
        subjectCommit: git(repo, 'rev-parse', 'HEAD'),
        subjectTree: headTree(),
        subjectScope: '',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'represents a modified tracked file, an added untracked file and a deletion inside scope',
    async () => {
      writeFileSync(join(project, 'app.txt'), 'changed\n');
      writeFileSync(join(project, 'new.txt'), 'added\n');
      unlinkSync(join(project, 'remove-me.txt'));
      const before = headTree();
      const state = await captureSubjectState(project);
      expect(state.subjectScope).toBe('apps/service');
      expect(state.subjectTree).not.toBe(before);
      expect(git(repo, 'ls-tree', '-r', '--name-only', state.subjectTree).split('\n')).toEqual([
        '.gitignore',
        'apps/service/app.txt',
        'apps/service/new.txt',
        'libs/shared.txt',
      ]);
      expect(git(repo, 'show', `${state.subjectTree}:apps/service/app.txt`)).toBe('changed');
      // It equals the tree a real scoped commit of that state produces.
      expect(committedTree(':(top,literal)apps/service')).toBe(state.subjectTree);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'keeps files outside the project scope exactly as HEAD has them',
    async () => {
      writeFileSync(join(repo, 'libs', 'shared.txt'), 'edited outside the project\n');
      writeFileSync(join(repo, 'libs', 'stray.txt'), 'new file outside the project\n');
      writeFileSync(join(project, 'app.txt'), 'in scope\n');
      const state = await captureSubjectState(project);
      expect(git(repo, 'show', `${state.subjectTree}:libs/shared.txt`)).toBe('shared');
      expect(git(repo, 'ls-tree', '-r', '--name-only', state.subjectTree)).not.toContain('stray.txt');
      expect(git(repo, 'show', `${state.subjectTree}:apps/service/app.txt`)).toBe('in scope');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not include ignored build output',
    async () => {
      mkdirSync(join(repo, 'dist'));
      writeFileSync(join(repo, 'dist', 'bundle.js'), 'built\n');
      const state = await captureSubjectState(repo);
      expect(state.subjectTree).toBe(headTree());
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'never mutates the real index, including a pre-staged change',
    async () => {
      writeFileSync(join(project, 'staged.txt'), 'staged\n');
      git(repo, 'add', 'apps/service/staged.txt');
      writeFileSync(join(project, 'app.txt'), 'unstaged edit\n');
      writeFileSync(join(project, 'untracked.txt'), 'untracked\n');
      const indexBefore = indexBytes();
      const statusBefore = git(repo, 'status', '--porcelain');
      const state = await captureSubjectState(project);
      expect(indexBytes().equals(indexBefore)).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
      expect(statusBefore).toContain('A  apps/service/staged.txt');
      expect(statusBefore).toContain('?? apps/service/untracked.txt');
      expect(git(repo, 'ls-tree', '-r', '--name-only', state.subjectTree)).toContain('untracked.txt');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'measures a run worktree built from a trusted commit, not the dirty source checkout',
    async () => {
      const base = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(project, 'app.txt'), 'user checkout edit\n');
      writeFileSync(join(project, 'user-only.txt'), 'user work\n');
      const worktree = join(root, 'worktree');
      git(repo, 'worktree', 'add', '-q', '-b', 'turing/test', worktree, base);
      writeFileSync(join(worktree, 'apps', 'service', 'app.txt'), 'run edit\n');
      const state = await captureSubjectState(join(worktree, 'apps', 'service'));
      expect(state.subjectCommit).toBe(base);
      expect(git(repo, 'show', `${state.subjectTree}:apps/service/app.txt`)).toBe('run edit');
      expect(git(repo, 'ls-tree', '-r', '--name-only', state.subjectTree)).not.toContain('user-only.txt');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('fails outside a Git repository so the engine can omit the fields', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await expect(captureSubjectState(plain)).rejects.toThrow();
  });
});
