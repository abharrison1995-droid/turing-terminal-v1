import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { RunEngine } from './runEngine.js';
import {
  advanceGoalRef,
  goalRefName,
  initGoalRef,
  preflightFinalApply,
  recoverIntegrationOps,
  scanChangedContent,
  verifyGoalRef,
  zeroObjectId,
  type IntegrationPolicy,
} from './goalGit.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './goals/repoKit.js';

const NOW = '2026-01-01T00:00:00.000Z';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

interface Harness {
  root: string;
  repo: string;
  db: ReturnType<typeof openDatabase>;
  goalId: string;
  ref: string;
  base: string;
  format: 'sha1' | 'sha256';
  closeApp: () => Promise<void>;
  newCycle: () => string;
  makeRun: (
    cycleId: string,
    files: Record<string, string | null>,
    options?: { purpose?: string; baseCommit?: string; status?: string },
  ) => { runId: string; worktree: string; tip: string };
}

const harnesses: Harness[] = [];
const previousDataDir = process.env.TT_DATA_DIR;

async function setup(
  format: 'sha1' | 'sha256' = 'sha1',
  options: { subdir?: boolean } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'turing-goal-git-'));
  process.env.TT_DATA_DIR = join(root, 'engine-data');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', `--object-format=${format}`, repo]);
  git(repo, 'config', 'user.email', 'turing-test@example.invalid');
  git(repo, 'config', 'user.name', 'Turing Test');
  const project = options.subdir ? join(repo, 'packages', 'app') : repo;
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'app.txt'), 'base\n');
  writeFileSync(join(repo, 'outside.txt'), 'outside\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const db = openDatabase(join(root, 'state'));
  const app = createApp({ database: db, engine: new RunEngine(db, () => undefined) });
  await app.ready();
  const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: project } });
  const projectId = added.json().project.id as string;
  const workflowId = (
    await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'wf',
        description: 'wf',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: true,
        stages: [{ id: 'gate', label: 'Gate', kind: 'humanApproval' }],
      },
    })
  ).json().workflow.id as string;
  const machine = (
    db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
  ).value;
  const goalId = randomUUID();
  db.prepare(
    `INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'G', 'running', ?, ?)`,
  ).run(goalId, machine, projectId, NOW, NOW);
  const approvalId = `${goalId}-approval`;
  db.prepare(
    `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
     VALUES (?, ?, 'definition', 'low', 'seed', 'user', '{"version":1,"definitionHash":"h"}', 'pending', ?)`,
  ).run(approvalId, goalId, NOW);
  db.prepare(
    "UPDATE goal_approvals SET status = 'approved', decided_by = 'user', responded_at = ? WHERE id = ?",
  ).run(NOW, approvalId);
  db.prepare(
    `INSERT INTO goal_definition_versions (goal_id, version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
     definition_hash, change_summary, created_by, approved_by, approval_id, created_at, approved_at)
     VALUES (?, 1, 'approved', '{}', '[]', '{}', '{}', '{}', 'h', 's', 'user', 'user', ?, ?, ?)`,
  ).run(goalId, approvalId, NOW, NOW);
  let sequence = 0;
  const harness: Harness = {
    root,
    repo,
    db,
    goalId,
    ref: `refs/heads/turing/goal/${goalId}`,
    base: git(repo, 'rev-parse', 'HEAD'),
    format,
    closeApp: () => app.close(),
    newCycle: () => {
      const id = randomUUID();
      sequence += 1;
      // Migration 020 allows one unfinished cycle per Goal; a fixture that opens another closes the previous one.
      db.prepare(
        "UPDATE goal_cycles SET status = 'cancelled', finished_at = ? WHERE goal_id = ? AND status NOT IN ('succeeded','failed','cancelled','rejected')",
      ).run(NOW, goalId);
      const head = (
        db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as
          { integration_head: string } | undefined
      )?.integration_head;
      db.prepare(
        `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, created_at)
         VALUES (?, ?, 1, ?, 'execution', 't', 'running', ?, ?)`,
      ).run(id, goalId, sequence, head ?? null, NOW);
      return id;
    },
    makeRun: (cycleId, files, opts = {}) => {
      const runId = randomUUID();
      const branch = `turing/${runId.slice(0, 8)}`;
      const worktree = join(root, `wt-${runId.slice(0, 8)}`);
      const baseCommit = opts.baseCommit ?? git(repo, 'rev-parse', harness.ref);
      git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseCommit);
      for (const [path, content] of Object.entries(files)) {
        const full = join(worktree, path);
        if (content === null) rmSync(full);
        else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
        }
      }
      git(worktree, 'add', '-A');
      if (git(worktree, 'status', '--porcelain')) git(worktree, 'commit', '-qm', 'work');
      const tip = git(worktree, 'rev-parse', 'HEAD');
      db.prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at,
           branch, worktree_path, goal_cycle_id, goal_run_purpose, goal_base_commit)
         VALUES (?, ?, ?, ?, '{}', 'task', 'economy', 'normal', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        machine,
        projectId,
        workflowId,
        opts.status ?? 'completed',
        NOW,
        branch,
        worktree,
        cycleId,
        opts.purpose ?? 'execution',
        baseCommit,
      );
      return { runId, worktree, tip };
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length) {
    const h = harnesses.pop()!;
    await h.closeApp();
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
  if (previousDataDir === undefined) delete process.env.TT_DATA_DIR;
  else process.env.TT_DATA_DIR = previousDataDir;
});

async function initialised(options: { subdir?: boolean; format?: 'sha1' | 'sha256' } = {}) {
  const h = await setup(options.format ?? 'sha1', { subdir: options.subdir });
  const result = await initGoalRef(h.db, h.goalId);
  expect(result.outcome).toBe('initialized');
  return h;
}

async function advance(h: Harness, files: Record<string, string | null>, policy?: IntegrationPolicy) {
  const cycle = h.newCycle();
  const run = h.makeRun(cycle, files);
  const head = git(h.repo, 'rev-parse', h.ref);
  return {
    cycle,
    run,
    head,
    result: await advanceGoalRef(
      h.db,
      { goalId: h.goalId, cycleId: cycle, runId: run.runId, expectedHead: head },
      policy,
    ),
  };
}

const ops = (h: Harness) =>
  h.db
    .prepare('SELECT * FROM goal_integration_ops WHERE goal_id = ? ORDER BY created_at')
    .all(h.goalId) as Array<Record<string, string | null>>;
const runtime = (h: Harness) =>
  h.db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(h.goalId) as Record<string, string | null>;

describe('Goal ref identity', () => {
  it(
    'derives the ref from a validated server id only',
    async () => {
      const h = await setup();
      expect(await goalRefName(h.goalId, h.repo)).toBe(h.ref);
      for (const bad of ['main', '../x', 'refs/heads/main', `${h.goalId}/x`, '', 'goal 1'])
        await expect(goalRefName(bad, h.repo)).rejects.toThrow();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it('uses the right zero object id per format', () => {
    expect(zeroObjectId('sha1')).toHaveLength(40);
    expect(zeroObjectId('sha256')).toHaveLength(64);
  });
});

describe('initGoalRef', () => {
  it(
    'creates the ref at the checkout commit and records the runtime atomically',
    async () => {
      const h = await setup();
      const result = await initGoalRef(h.db, h.goalId);
      expect(result).toMatchObject({ outcome: 'initialized', head: h.base, baseBranch: 'main' });
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
      expect(runtime(h)).toMatchObject({
        goal_branch: `turing/goal/${h.goalId}`,
        integration_head: h.base,
        base_branch: 'main',
        base_commit: h.base,
      });
      expect(ops(h)).toMatchObject([
        { op: 'init_ref', status: 'applied', expected_old: null, new_commit: h.base },
      ]);
      expect(await verifyGoalRef(h.db, h.goalId)).toEqual({ ok: true, head: h.base });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an unexpected existing ref and never overwrites it',
    async () => {
      const h = await setup();
      writeFileSync(join(h.repo, 'later.txt'), 'x');
      git(h.repo, 'add', '.');
      git(h.repo, 'commit', '-qm', 'later');
      git(h.repo, 'update-ref', h.ref, git(h.repo, 'rev-parse', 'HEAD'));
      const before = git(h.repo, 'rev-parse', h.ref);
      const result = await initGoalRef(h.db, h.goalId);
      expect(result).toMatchObject({ outcome: 'refused', code: 'goal_ref_exists' });
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(before);
      expect(ops(h)).toHaveLength(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'treats a ref created between the check and the CAS as a conflict',
    async () => {
      const h = await setup();
      const result = await initGoalRef(h.db, h.goalId, {
        beforeCas: () => {
          git(h.repo, 'update-ref', h.ref, h.base);
        },
      });
      expect(result).toMatchObject({ outcome: 'conflict', code: 'goal_ref_conflict' });
      expect(ops(h)).toMatchObject([{ status: 'failed', error_code: 'goal_ref_conflict' }]);
      expect(runtime(h)).toBeUndefined();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses when the Goal branch is checked out in a worktree',
    async () => {
      const h = await setup();
      git(h.repo, 'branch', `turing/goal/${h.goalId}`);
      git(h.repo, 'worktree', 'add', '-q', join(h.root, 'occupied'), `turing/goal/${h.goalId}`);
      // The ref pre-exists, so init refuses; verify detects the checkout once initialised by other means.
      expect(await initGoalRef(h.db, h.goalId)).toMatchObject({ outcome: 'refused' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is not repeatable once initialised',
    async () => {
      const h = await initialised();
      expect(await initGoalRef(h.db, h.goalId)).toMatchObject({
        outcome: 'refused',
        code: 'already_initialized',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'works with a SHA-256 repository',
    async () => {
      const h = await initialised({ format: 'sha256' });
      expect(h.base).toHaveLength(64);
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
      const { result } = await advance(h, { 'app.txt': 'sha256 change\n' });
      expect(result.outcome).toBe('advanced');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'recovers a crash after the CAS by completing the database side',
    async () => {
      const h = await setup();
      await expect(
        initGoalRef(h.db, h.goalId, {
          beforeCas: () => {
            git(h.repo, 'update-ref', h.ref, h.base);
            throw new Error('crash');
          },
        }),
      ).rejects.toThrow('crash');
      expect(ops(h)[0]!.status).toBe('planned');
      const first = await recoverIntegrationOps(h.db, h.goalId);
      expect(first).toMatchObject([{ outcome: 'completed' }]);
      expect(runtime(h)).toMatchObject({ integration_head: h.base, base_branch: 'main' });
      expect(await recoverIntegrationOps(h.db, h.goalId)).toEqual([]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'recovers a crash before the CAS by aborting, then allows a retry',
    async () => {
      const h = await setup();
      await expect(
        initGoalRef(h.db, h.goalId, {
          beforeCas: () => {
            throw new Error('crash');
          },
        }),
      ).rejects.toThrow('crash');
      expect(await initGoalRef(h.db, h.goalId)).toMatchObject({
        outcome: 'refused',
        code: 'pending_operation',
      });
      expect(await recoverIntegrationOps(h.db, h.goalId)).toMatchObject([{ outcome: 'aborted' }]);
      expect(await initGoalRef(h.db, h.goalId)).toMatchObject({ outcome: 'initialized' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'recovery leaves a third-party ref alone and is repeatable',
    async () => {
      const h = await setup();
      await expect(
        initGoalRef(h.db, h.goalId, {
          beforeCas: () => {
            writeFileSync(join(h.repo, 'x.txt'), 'x');
            git(h.repo, 'add', '.');
            git(h.repo, 'commit', '-qm', 'x');
            git(h.repo, 'update-ref', h.ref, git(h.repo, 'rev-parse', 'HEAD'));
            throw new Error('crash');
          },
        }),
      ).rejects.toThrow('crash');
      const other = git(h.repo, 'rev-parse', h.ref);
      for (let i = 0; i < 2; i += 1)
        expect(await recoverIntegrationOps(h.db, h.goalId)).toMatchObject([
          { outcome: 'goal_ref_changed', observedRef: other },
        ]);
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(other);
      expect(ops(h)[0]!.status).toBe('planned');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('advanceGoalRef', () => {
  it(
    'advances the ref by CAS and records the result',
    async () => {
      const h = await initialised();
      const { result, cycle, run, head } = await advance(h, { 'app.txt': 'changed\n', 'new.txt': 'n\n' });
      expect(result).toMatchObject({
        outcome: 'advanced',
        from: head,
        to: run.tip,
        changedPaths: ['app.txt', 'new.txt'],
      });
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(run.tip);
      expect(runtime(h).integration_head).toBe(run.tip);
      expect(
        (
          h.db.prepare('SELECT result_integration_commit FROM goal_cycles WHERE id = ?').get(cycle) as Record<
            string,
            string
          >
        ).result_integration_commit,
      ).toBe(run.tip);
      const op = ops(h).at(-1)!;
      expect(op).toMatchObject({ op: 'advance', status: 'applied', expected_old: head, new_commit: run.tip });
      expect(JSON.parse(op.checks_json!).every((c: { ok: boolean }) => c.ok)).toBe(true);
      // The user's branch is untouched.
      expect(git(h.repo, 'rev-parse', 'main')).toBe(h.base);
      expect(await verifyGoalRef(h.db, h.goalId)).toEqual({ ok: true, head: run.tip });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'chains a second cycle from the new head',
    async () => {
      const h = await initialised();
      await advance(h, { 'a.txt': '1\n' });
      const second = await advance(h, { 'b.txt': '2\n' });
      expect(second.result.outcome).toBe('advanced');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a CAS conflict when another actor moves the ref after the checks',
    async () => {
      const h = await initialised();
      const cycle = h.newCycle();
      const run = h.makeRun(cycle, { 'app.txt': 'mine\n' });
      const other = h.makeRun(h.newCycle(), { 'other.txt': 'theirs\n' });
      const result = await advanceGoalRef(
        h.db,
        { goalId: h.goalId, cycleId: cycle, runId: run.runId, expectedHead: h.base },
        {},
        { beforeCas: () => void git(h.repo, 'update-ref', h.ref, other.tip) },
      );
      expect(result).toMatchObject({ outcome: 'conflict', code: 'goal_ref_conflict' });
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(other.tip);
      expect(runtime(h).integration_head).toBe(h.base);
      expect(ops(h).at(-1)).toMatchObject({ status: 'failed', error_code: 'goal_ref_conflict' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is a deterministic no-op when the run made no change',
    async () => {
      const h = await initialised();
      const { result, head } = await advance(h, {});
      expect(result).toEqual({ outcome: 'no_change', head });
      expect(ops(h)).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  describe('history', () => {
    it(
      'rejects a rewind and a non-descendant',
      async () => {
        const h = await initialised();
        const first = await advance(h, { 'a.txt': '1\n' });
        expect(first.result.outcome).toBe('advanced');
        const cycle = h.newCycle();
        // Run based on the old base while the head has moved: base mismatch.
        const stale = h.makeRun(cycle, { 'b.txt': '2\n' }, { baseCommit: h.base });
        const result = await advanceGoalRef(h.db, {
          goalId: h.goalId,
          cycleId: cycle,
          runId: stale.runId,
          expectedHead: first.run.tip,
        });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'base_mismatch' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a run branch that has been rewound or moved sideways',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        git(run.worktree, 'reset', '-q', '--hard', 'HEAD~1');
        git(run.worktree, 'commit', '-q', '--allow-empty', '-m', 'sideways');
        writeFileSync(join(run.worktree, 's.txt'), 's');
        git(run.worktree, 'add', '.');
        git(run.worktree, 'commit', '-qm', 's');
        // Reset to the base's parent-less sibling: build an unrelated root commit.
        git(run.worktree, 'checkout', '-q', '--orphan', 'tmp-orphan');
        git(run.worktree, 'commit', '-q', '--allow-empty', '-m', 'orphan');
        const orphan = git(run.worktree, 'rev-parse', 'HEAD');
        git(run.worktree, 'checkout', '-q', `turing/${run.runId.slice(0, 8)}`);
        git(run.worktree, 'reset', '-q', '--hard', orphan);
        const result = await advanceGoalRef(h.db, {
          goalId: h.goalId,
          cycleId: cycle,
          runId: run.runId,
          expectedHead: h.base,
        });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'not_descendant' });
        expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a run whose tip is an ancestor of the head (rewind)',
      async () => {
        const h = await initialised();
        const first = await advance(h, { 'a.txt': '1\n' });
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, {}, { baseCommit: first.run.tip });
        git(run.worktree, 'reset', '-q', '--hard', h.base);
        const result = await advanceGoalRef(h.db, {
          goalId: h.goalId,
          cycleId: cycle,
          runId: run.runId,
          expectedHead: first.run.tip,
        });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'not_descendant' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('identity and run state', () => {
    it(
      'rejects a stale expected head, wrong cycle, wrong purpose and incomplete runs',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        const input = { goalId: h.goalId, cycleId: cycle, runId: run.runId, expectedHead: h.base };
        expect(await advanceGoalRef(h.db, { ...input, expectedHead: run.tip })).toMatchObject({
          code: 'base_mismatch',
        });
        expect(await advanceGoalRef(h.db, { ...input, cycleId: h.newCycle() })).toMatchObject({
          code: 'run_mismatch',
        });
        const review = h.makeRun(h.newCycle(), { 'a.txt': '1\n' }, { purpose: 'review' });
        const reviewCycle = (
          h.db.prepare('SELECT goal_cycle_id FROM runs WHERE id = ?').get(review.runId) as Record<
            string,
            string
          >
        ).goal_cycle_id!;
        expect(
          await advanceGoalRef(h.db, { ...input, cycleId: reviewCycle, runId: review.runId }),
        ).toMatchObject({ code: 'run_purpose' });
        const failed = h.makeRun(h.newCycle(), { 'a.txt': '1\n' }, { status: 'failed' });
        const failedCycle = (
          h.db.prepare('SELECT goal_cycle_id FROM runs WHERE id = ?').get(failed.runId) as Record<
            string,
            string
          >
        ).goal_cycle_id!;
        expect(
          await advanceGoalRef(h.db, { ...input, cycleId: failedCycle, runId: failed.runId }),
        ).toMatchObject({ code: 'run_not_completed' });
        expect(await advanceGoalRef(h.db, input, { allowedGoalStatuses: ['paused'] })).toMatchObject({
          code: 'goal_status',
        });
        expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a Goal ref that moved outside Turing',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        git(h.repo, 'update-ref', h.ref, run.tip);
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle,
            runId: run.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({ code: 'goal_ref_changed' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('worktree', () => {
    const attempt = (h: Harness, cycle: string, runId: string) =>
      advanceGoalRef(h.db, { goalId: h.goalId, cycleId: cycle, runId, expectedHead: h.base });

    it(
      'rejects a dirty worktree, including untracked files',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        writeFileSync(join(run.worktree, 'untracked.txt'), 'u');
        expect(await attempt(h, cycle, run.runId)).toMatchObject({ code: 'worktree_dirty' });
        rmSync(join(run.worktree, 'untracked.txt'));
        writeFileSync(join(run.worktree, 'a.txt'), 'edited\n');
        expect(await attempt(h, cycle, run.runId)).toMatchObject({ code: 'worktree_dirty' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a missing worktree',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        rmSync(run.worktree, { recursive: true, force: true });
        expect(await attempt(h, cycle, run.runId)).toMatchObject({ code: 'worktree_missing' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a worktree on the wrong branch or with a mismatched HEAD',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        git(run.worktree, 'checkout', '-q', '-b', 'something-else');
        expect(await attempt(h, cycle, run.runId)).toMatchObject({ code: 'worktree_mismatch' });
        const cycle2 = h.newCycle();
        const run2 = h.makeRun(cycle2, { 'b.txt': '1\n' });
        git(run2.worktree, 'checkout', '-q', '--detach');
        expect(await attempt(h, cycle2, run2.runId)).toMatchObject({ code: 'worktree_mismatch' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a worktree whose branch was moved underneath it',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        git(h.repo, 'update-ref', `refs/heads/turing/${run.runId.slice(0, 8)}`, h.base);
        expect(await attempt(h, cycle, run.runId)).toMatchObject({ code: 'worktree_dirty' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('path scope', () => {
    const rejected = async (
      h: Harness,
      files: Record<string, string | null>,
      code: string,
      policy?: IntegrationPolicy,
    ) => {
      const { result } = await advance(h, files, policy);
      expect(result).toMatchObject({ outcome: 'rejected', code });
      expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
    };

    it(
      'rejects modify, add and delete outside the project subtree',
      async () => {
        const h = await initialised({ subdir: true });
        await rejected(h, { 'outside.txt': 'changed\n' }, 'path_out_of_scope');
        await rejected(h, { 'added.txt': 'x\n' }, 'path_out_of_scope');
        await rejected(h, { 'outside.txt': null }, 'path_out_of_scope');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'accepts changes inside the project subtree',
      async () => {
        const h = await initialised({ subdir: true });
        const { result } = await advance(h, { 'packages/app/app.txt': 'inside\n' });
        expect(result.outcome).toBe('advanced');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a rename or copy that touches paths outside, in either direction',
      async () => {
        const h = await initialised({ subdir: true });
        // Rename out of scope: source inside, destination outside.
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, {});
        git(run.worktree, 'mv', 'packages/app/app.txt', 'moved-out.txt');
        git(run.worktree, 'commit', '-qm', 'mv');
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle,
            runId: run.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({ code: 'path_out_of_scope' });
        // Rename in: both inside scope.
        const inside = await advance(h, {});
        expect(inside.result.outcome).toBe('no_change');
        const cycle2 = h.newCycle();
        const run2 = h.makeRun(cycle2, {});
        git(run2.worktree, 'mv', 'packages/app/app.txt', 'packages/app/renamed.txt');
        git(run2.worktree, 'commit', '-qm', 'mv');
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle2,
            runId: run2.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({
          outcome: 'advanced',
          changedPaths: ['packages/app/app.txt', 'packages/app/renamed.txt'],
        });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'detects a copy whose source is outside the scope',
      async () => {
        const h = await initialised({ subdir: true });
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, {});
        writeFileSync(join(run.worktree, 'packages', 'app', 'copy.txt'), 'outside\n');
        git(run.worktree, 'add', '.');
        git(run.worktree, 'commit', '-qm', 'copy');
        const result = await advanceGoalRef(h.db, {
          goalId: h.goalId,
          cycleId: cycle,
          runId: run.runId,
          expectedHead: h.base,
        });
        // The copy is the only change; git may report it as an add or as a copy from outside.txt. Either way the
        // entry is inspected in full and never silently dropped.
        expect(['advanced', 'rejected']).toContain(result.outcome);
        if (result.outcome === 'rejected') expect(result.code).toBe('path_out_of_scope');
        if (result.outcome === 'advanced') expect(result.changedPaths).toContain('packages/app/copy.txt');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects sensitive and protected paths',
      async () => {
        const h = await initialised();
        await rejected(h, { '.env': 'A=1\n' }, 'path_sensitive');
        await rejected(h, { 'keys/id_rsa': 'k\n' }, 'path_sensitive');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rejects symlinks',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, {});
        execFileSync('ln', ['-s', '/etc/passwd', join(run.worktree, 'link')]);
        git(run.worktree, 'add', '.');
        git(run.worktree, 'commit', '-qm', 'link');
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle,
            runId: run.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({ code: 'unsupported_file_mode' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'enforces an explicit milestone scope on both old and new paths',
      async () => {
        const h = await initialised();
        await rejected(h, { 'docs/readme.md': 'x\n' }, 'milestone_scope_violation', {
          allowedPaths: ['src'],
        });
        const { result } = await advance(h, { 'src/a.ts': 'x\n' }, { allowedPaths: ['src'] });
        expect(result.outcome).toBe('advanced');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('secret scanning', () => {
    const SECRET = 'api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"\n';

    it(
      'rejects a planted secret',
      async () => {
        const h = await initialised();
        const { result } = await advance(h, { 'config.txt': SECRET });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'secret_detected' });
        expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'finds a secret planted far beyond the UI diff preview size',
      async () => {
        const h = await initialised();
        const filler = 'const harmless = 1;\n'.repeat(40_000);
        const { result } = await advance(h, { 'big.ts': filler + SECRET });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'secret_detected' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'finds a secret in a binary-looking file',
      async () => {
        const h = await initialised();
        const { result } = await advance(h, { 'blob.bin': `\0\0\0${SECRET}\0` });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'secret_detected' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'fails closed when the scan limit is exceeded',
      async () => {
        const h = await initialised();
        const { result } = await advance(h, { 'big.txt': 'x'.repeat(10_000) }, { maxScanBytes: 1_000 });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'scan_limit_exceeded' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'fails closed when git cannot be read',
      async () => {
        const h = await initialised();
        expect(await scanChangedContent(h.repo, 'deadbeef', 'cafebabe')).toMatchObject({
          ok: false,
          code: 'scan_failed',
        });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('stage outcomes', () => {
    const addStages = (h: Harness, runId: string, statuses: string[]) =>
      statuses.forEach((status, index) =>
        h.db
          .prepare(
            `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status) VALUES (?, ?, ?, 'build', 'S', ?, ?)`,
          )
          .run(randomUUID(), runId, `s${index}`, index, status),
      );

    it(
      'refuses a completed run containing a failed continueOnFailure stage',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        // The run reached 'completed' although the middle stage failed and carried continueOnFailure.
        h.db
          .prepare('UPDATE runs SET workflow_snapshot_json = ? WHERE id = ?')
          .run(JSON.stringify({ stages: [{ id: 's1', continueOnFailure: true }] }), run.runId);
        addStages(h, run.runId, ['passed', 'failed', 'passed']);
        const result = await advanceGoalRef(h.db, {
          goalId: h.goalId,
          cycleId: cycle,
          runId: run.runId,
          expectedHead: h.base,
        });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'run_stage_failed' });
        if (result.outcome === 'rejected')
          expect(result.checks.at(-1)!.detail).toEqual({ stages: [{ stage_key: 's1', status: 'failed' }] });
        expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
        expect(ops(h).filter((op) => op.op === 'advance')).toHaveLength(0);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it.each(['cancelled'])(
      'refuses a %s stage as failed',
      async (status) => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        addStages(h, run.runId, ['passed', status]);
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle,
            runId: run.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({ code: 'run_stage_failed' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it.each(['pending', 'running', 'waiting_for_user', 'waiting_for_approval', 'unknown_state'])(
      'refuses a completed run with a %s stage as incomplete',
      async (status) => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        addStages(h, run.runId, ['passed', status]);
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle,
            runId: run.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({ code: 'run_stage_incomplete' });
        expect(ops(h)).toHaveLength(1);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'accepts passed and skipped stages',
      async () => {
        const h = await initialised();
        const cycle = h.newCycle();
        const run = h.makeRun(cycle, { 'a.txt': '1\n' });
        addStages(h, run.runId, ['passed', 'skipped', 'passed']);
        expect(
          await advanceGoalRef(h.db, {
            goalId: h.goalId,
            cycleId: cycle,
            runId: run.runId,
            expectedHead: h.base,
          }),
        ).toMatchObject({ outcome: 'advanced' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('bookkeeping invariants', () => {
    async function crashedAfterCas(h: Harness) {
      const cycle = h.newCycle();
      const run = h.makeRun(cycle, { 'a.txt': '1\n' });
      await expect(
        advanceGoalRef(
          h.db,
          { goalId: h.goalId, cycleId: cycle, runId: run.runId, expectedHead: h.base },
          {},
          {
            beforeCas: () => {
              git(h.repo, 'update-ref', h.ref, run.tip);
              throw new Error('crash');
            },
          },
        ),
      ).rejects.toThrow('crash');
      return { cycle, run };
    }

    it(
      'rolls back and leaves the op planned when the runtime row is missing',
      async () => {
        const h = await initialised();
        await crashedAfterCas(h);
        h.db.pragma('foreign_keys = OFF');
        h.db.prepare('DELETE FROM goal_runtime WHERE goal_id = ?').run(h.goalId);
        h.db.pragma('foreign_keys = ON');
        await expect(recoverIntegrationOps(h.db, h.goalId)).rejects.toMatchObject({
          code: 'bookkeeping_invariant',
        });
        expect(ops(h).at(-1)).toMatchObject({ status: 'planned', finished_at: null });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'rolls back the runtime update when the cycle row cannot be updated',
      async () => {
        const h = await initialised();
        const { cycle } = await crashedAfterCas(h);
        // Re-point the op at a cycle belonging to nobody by removing the cycle (planned ops are not FK-cascaded).
        h.db.pragma('foreign_keys = OFF');
        h.db.prepare('DELETE FROM goal_cycles WHERE id = ?').run(cycle);
        h.db.pragma('foreign_keys = ON');
        await expect(recoverIntegrationOps(h.db, h.goalId)).rejects.toMatchObject({
          code: 'bookkeeping_invariant',
        });
        expect(ops(h).at(-1)!.status).toBe('planned');
        expect(runtime(h).integration_head).toBe(h.base);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });

  describe('recovery', () => {
    async function crashed(h: Harness, mutate: (tip: string) => void) {
      const cycle = h.newCycle();
      const run = h.makeRun(cycle, { 'a.txt': '1\n' });
      await expect(
        advanceGoalRef(
          h.db,
          { goalId: h.goalId, cycleId: cycle, runId: run.runId, expectedHead: h.base },
          {},
          {
            beforeCas: () => {
              mutate(run.tip);
              throw new Error('crash');
            },
          },
        ),
      ).rejects.toThrow('crash');
      return { cycle, run };
    }

    it(
      'ref == new_commit: completes the database side, once',
      async () => {
        const h = await initialised();
        const { cycle, run } = await crashed(h, (tip) => void git(h.repo, 'update-ref', h.ref, tip));
        expect(runtime(h).integration_head).toBe(h.base);
        expect(await recoverIntegrationOps(h.db, h.goalId)).toMatchObject([{ outcome: 'completed' }]);
        expect(runtime(h).integration_head).toBe(run.tip);
        expect(
          (
            h.db
              .prepare('SELECT result_integration_commit FROM goal_cycles WHERE id = ?')
              .get(cycle) as Record<string, string>
          ).result_integration_commit,
        ).toBe(run.tip);
        expect(await recoverIntegrationOps(h.db, h.goalId)).toEqual([]);
        expect(ops(h).at(-1)!.status).toBe('applied');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'ref == expected_old: aborts without performing the CAS',
      async () => {
        const h = await initialised();
        await crashed(h, () => undefined);
        expect(await recoverIntegrationOps(h.db, h.goalId)).toMatchObject([{ outcome: 'aborted' }]);
        expect(git(h.repo, 'rev-parse', h.ref)).toBe(h.base);
        expect(ops(h).at(-1)).toMatchObject({ status: 'aborted' });
        expect(await recoverIntegrationOps(h.db, h.goalId)).toEqual([]);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'ref == third value: reports goal_ref_changed, moves nothing, repeatably',
      async () => {
        const h = await initialised();
        const other = h.makeRun(h.newCycle(), { 'o.txt': 'o\n' });
        await crashed(h, () => void git(h.repo, 'update-ref', h.ref, other.tip));
        for (let i = 0; i < 3; i += 1) {
          expect(await recoverIntegrationOps(h.db, h.goalId)).toMatchObject([
            { outcome: 'goal_ref_changed', observedRef: other.tip },
          ]);
          expect(git(h.repo, 'rev-parse', h.ref)).toBe(other.tip);
          expect(ops(h).at(-1)!.status).toBe('planned');
        }
        expect(runtime(h).integration_head).toBe(h.base);
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it(
      'blocks further advances while an operation is unresolved',
      async () => {
        const h = await initialised();
        await crashed(h, () => undefined);
        const { result } = await advance(h, { 'b.txt': '1\n' });
        expect(result).toMatchObject({ outcome: 'rejected', code: 'pending_operation' });
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });
});

describe('verifyGoalRef', () => {
  it(
    'detects a missing, moved or checked-out ref',
    async () => {
      const h = await initialised();
      git(h.repo, 'worktree', 'add', '-q', '--force', join(h.root, 'occupied'), `turing/goal/${h.goalId}`);
      expect(await verifyGoalRef(h.db, h.goalId)).toEqual({ ok: false, code: 'goal_branch_checked_out' });
      git(h.repo, 'worktree', 'remove', '--force', join(h.root, 'occupied'));
      const moved = h.makeRun(h.newCycle(), { 'a.txt': 'x\n' });
      git(h.repo, 'update-ref', h.ref, moved.tip);
      expect(await verifyGoalRef(h.db, h.goalId)).toEqual({ ok: false, code: 'goal_ref_changed' });
      git(h.repo, 'update-ref', '-d', h.ref);
      expect(await verifyGoalRef(h.db, h.goalId)).toEqual({ ok: false, code: 'goal_ref_missing' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('preflightFinalApply', () => {
  const gitState = (h: Harness) => ({
    refs: git(h.repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    headRef: git(h.repo, 'symbolic-ref', '-q', 'HEAD'),
    headCommit: git(h.repo, 'rev-parse', 'HEAD'),
    checkout: git(h.repo, 'status', '--porcelain=v1', '--untracked-files=all'),
    worktrees: git(h.repo, 'worktree', 'list', '--porcelain'),
  });

  async function readOnlyPreflight(h: Harness) {
    const before = gitState(h);
    const result = await preflightFinalApply(h.db, h.goalId);
    expect(gitState(h)).toEqual(before);
    return result;
  }

  async function advanced() {
    const h = await initialised();
    const step = await advance(h, { 'app.txt': 'goal change\n' });
    expect(step.result.outcome).toBe('advanced');
    return { h, tip: step.run.tip };
  }

  it(
    'reports not initialised before init',
    async () => {
      const h = await setup();
      expect((await readOnlyPreflight(h)).status).toBe('goal_not_initialized');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'is ready when the checkout is clean, on the base branch at the base commit',
    async () => {
      const { h, tip } = await advanced();
      const result = await readOnlyPreflight(h);
      expect(result).toMatchObject({
        status: 'ready_for_approved_apply',
        recordedBaseBranch: 'main',
        recordedBaseCommit: h.base,
        currentBranch: 'main',
        currentHead: h.base,
        dirty: false,
        integrationHead: tip,
        fastForwardPossible: true,
        ahead: 0,
        behind: 1,
        changedPaths: ['app.txt'],
      });
      expect(result.diffPreview).toContain('goal change');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a dirty checkout, including untracked files',
    async () => {
      const { h } = await advanced();
      writeFileSync(join(h.repo, 'untracked.txt'), 'u');
      expect((await readOnlyPreflight(h)).status).toBe('dirty_checkout');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports the wrong branch',
    async () => {
      const { h } = await advanced();
      git(h.repo, 'checkout', '-q', '-b', 'feature');
      expect((await readOnlyPreflight(h)).status).toBe('wrong_branch');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a diverged base branch',
    async () => {
      const { h } = await advanced();
      writeFileSync(join(h.repo, 'user.txt'), 'u');
      git(h.repo, 'add', '.');
      git(h.repo, 'commit', '-qm', 'user work');
      const result = await readOnlyPreflight(h);
      expect(result.status).toBe('base_diverged');
      expect(result).toMatchObject({ ahead: 1, behind: 1, fastForwardPossible: false });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports not_fast_forward when the checkout is at the base commit but history diverged from the Goal ref',
    async () => {
      const { h } = await advanced();
      // Reset the recorded base to the current head so that only the ancestry test can fail.
      git(h.repo, 'checkout', '-q', '--orphan', 'other');
      git(h.repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
      const unrelated = git(h.repo, 'rev-parse', 'HEAD');
      git(h.repo, 'checkout', '-q', 'main');
      git(h.repo, 'branch', '-q', '-D', 'other');
      h.db.prepare('UPDATE goal_runtime SET base_commit = ? WHERE goal_id = ?').run(unrelated, h.goalId);
      git(h.repo, 'reset', '-q', '--hard', unrelated);
      const result = await readOnlyPreflight(h);
      expect(result.status).toBe('not_fast_forward');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a moved Goal ref',
    async () => {
      const { h } = await advanced();
      git(h.repo, 'update-ref', h.ref, h.base);
      expect((await readOnlyPreflight(h)).status).toBe('goal_ref_changed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports a Goal ref checked out in another worktree without changing repository state',
    async () => {
      const { h } = await advanced();
      const occupied = join(h.root, 'occupied-goal-worktree');
      git(h.repo, 'worktree', 'add', '-q', occupied, `turing/goal/${h.goalId}`);
      expect((await readOnlyPreflight(h)).status).toBe('goal_ref_changed');
      git(h.repo, 'worktree', 'remove', '--force', occupied);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reports an unsafe path in an already advanced Goal ref without changing repository state',
    async () => {
      const h = await initialised();
      const cycle = h.newCycle();
      const run = h.makeRun(cycle, { '.env': 'NONSECRET_FIXTURE=value\\n' });
      git(h.repo, 'update-ref', h.ref, run.tip);
      h.db.prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?').run(run.tip, h.goalId);
      expect((await readOnlyPreflight(h)).status).toBe('unsafe_changes');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'truncates and redacts the display preview without weakening the safety scan',
    async () => {
      const h = await initialised();
      // Plant a secret in history that bypassed integration checks, to prove the preflight scan is independent.
      const cycle = h.newCycle();
      const run = h.makeRun(cycle, {
        'big.ts': `${'const harmless = 1;\n'.repeat(5_000)}api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"\n`,
      });
      git(h.repo, 'update-ref', h.ref, run.tip);
      h.db.prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?').run(run.tip, h.goalId);
      const before = gitState(h);
      const result = await preflightFinalApply(h.db, h.goalId, { previewChars: 500 });
      expect(gitState(h)).toEqual(before);
      expect(result.diffPreviewTruncated).toBe(true);
      expect(result.diffPreview.length).toBeLessThanOrEqual(500);
      expect(result.status).toBe('unsafe_changes');
      expect(result.safety.violations).toContainEqual({ code: 'secret_detected' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
