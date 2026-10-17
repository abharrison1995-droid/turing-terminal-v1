import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { RunEngine } from './runEngine.js';
import {
  buildPreview,
  createRun,
  createRunOrigin,
  queueRun,
  recoverQueuedRunsAfterRestart,
  RunOriginError,
  startQueuedRun,
  type RunPreview,
} from './runLauncher.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './goals/repoKit.js';

const NOW = '2026-01-01T00:00:00.000Z';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

describe('Goal-origin run launch', () => {
  let root = '';
  let repo = '';
  let baseCommit = '';
  let headCommit = '';
  let db: ReturnType<typeof openDatabase>;
  let engine: RunEngine;
  let app: ReturnType<typeof createApp>;
  let projectId = '';
  let gateWorkflowId = '';
  let buildWorkflowId = '';
  let plainWorkflowId = '';
  let previousDataDir: string | undefined;

  const workflowPayload = (
    name: string,
    isolatedWorktree: boolean,
    stages: unknown[],
    permissionMode = 'normal',
  ) => ({
    name,
    description: name,
    template: 'test',
    executionProfile: 'economy',
    permissionMode,
    maxRemediationRounds: 0,
    maxParallelAgents: 1,
    isolatedWorktree,
    stages,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'turing-goal-origin-'));
    previousDataDir = process.env.TT_DATA_DIR;
    process.env.TT_DATA_DIR = join(root, 'engine-data');
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'turing-test@example.invalid');
    git(repo, 'config', 'user.name', 'Turing Test');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { build: 'node -e "console.log(\'build-ok\')"' } }),
    );
    writeFileSync(join(repo, 'app.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    baseCommit = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'app.txt'), 'moved on\n');
    git(repo, 'commit', '-qam', 'user moved the branch');
    headCommit = git(repo, 'rev-parse', 'HEAD');

    db = openDatabase(join(root, 'state'));
    engine = new RunEngine(db, () => undefined);
    app = createApp({ database: db, engine });
    await app.ready();
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repo } });
    projectId = added.json().project.id as string;
    const create = async (payload: unknown) =>
      (await app.inject({ method: 'POST', url: '/api/workflows', payload })).json().workflow.id as string;
    gateWorkflowId = await create(
      workflowPayload('Isolated gate', true, [{ id: 'gate', label: 'Gate', kind: 'humanApproval' }]),
    );
    buildWorkflowId = await create(
      workflowPayload('Isolated build', true, [{ id: 'build', label: 'Build', kind: 'build' }], 'yolo'),
    );
    plainWorkflowId = await create(
      workflowPayload('In place', false, [{ id: 'gate', label: 'Gate', kind: 'humanApproval' }]),
    );
  }, REAL_GIT_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await app.close();
    db.close();
    if (previousDataDir === undefined) delete process.env.TT_DATA_DIR;
    else process.env.TT_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  const machineId = () =>
    (db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string })
      .value;

  function seedGoal(id = 'goal-1', forProject = projectId, status = 'draft') {
    db.prepare(
      `INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'G', ?, ?, ?)`,
    ).run(id, machineId(), forProject, status, NOW, NOW);
    const approvalId = `${id}-approval`;
    db.prepare(
      `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, created_at)
       VALUES (?, ?, 'definition', 'low', 'seed', 'user', '{"version":1,"definitionHash":"h"}', 'pending', ?)`,
    ).run(approvalId, id, NOW);
    db.prepare(
      "UPDATE goal_approvals SET status = 'approved', decided_by = 'user', responded_at = ? WHERE id = ?",
    ).run(NOW, approvalId);
    db.prepare(
      `INSERT INTO goal_definition_versions (goal_id, version, status, contract_json, milestones_json, routing_json, review_json, limits_json,
         definition_hash, change_summary, created_by, approved_by, approval_id, created_at, approved_at)
       VALUES (?, 1, 'approved', '{}', '[]', '{}', '{}', '{}', 'h', 's', 'user', 'user', ?, ?, ?)`,
    ).run(id, approvalId, NOW, NOW);
    db.prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at)
       VALUES (?, ?, 1, 1, 'execution', 't', 'planned', ?)`,
    ).run(`${id}-cycle`, id, NOW);
    return `${id}-cycle`;
  }

  const input = (workflowId: string) => ({ task: 'Goal child task.', projectId, workflowId });
  const rowOf = (runId: string) =>
    db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown>;

  async function goalPreview(
    workflowId = gateWorkflowId,
    cycleId = seedGoal(),
    purpose = 'execution' as const,
  ) {
    const preview = await buildPreview(db, input(workflowId), undefined, {
      origin: createRunOrigin(cycleId, purpose, baseCommit),
    });
    expect(preview).not.toBeNull();
    return preview!;
  }

  describe('trust boundary', () => {
    it('ignores Goal fields sent in an HTTP run body', async () => {
      const cycleId = seedGoal();
      const response = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          ...input(plainWorkflowId),
          goalCycleId: cycleId,
          goalRunPurpose: 'execution',
          goalBaseCommit: baseCommit,
          origin: { goalCycleId: cycleId },
          ignoreDirty: true,
          allowDirty: true,
        },
      });
      expect(response.statusCode).toBe(202);
      const row = rowOf(response.json().run.id);
      expect(row).toMatchObject({ goal_cycle_id: null, goal_run_purpose: null, goal_base_commit: null });
    });

    it('does not let HTTP preview fields bypass a dirty checkout', async () => {
      writeFileSync(join(repo, 'dirty.txt'), 'user change\n');
      const response = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          ...input(gateWorkflowId),
          goalBaseCommit: baseCommit,
          ignoreDirty: true,
          allowDirty: true,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });

    it('rejects origins not produced by createRunOrigin', async () => {
      const cycleId = seedGoal();
      const forged = { goalCycleId: cycleId, goalRunPurpose: 'execution', goalBaseCommit: baseCommit };
      await expect(
        buildPreview(db, input(gateWorkflowId), undefined, { origin: forged as never }),
      ).rejects.toThrow(RunOriginError);
      const genuine = createRunOrigin(cycleId, 'execution', baseCommit);
      const roundTripped = JSON.parse(JSON.stringify(genuine));
      await expect(
        buildPreview(db, input(gateWorkflowId), undefined, { origin: roundTripped }),
      ).rejects.toThrow(RunOriginError);
      const preview = await goalPreview(gateWorkflowId, cycleId);
      const tampered = { ...preview, origin: forged } as unknown as RunPreview;
      expect(() => queueRun(db, tampered)).toThrow(RunOriginError);
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });

    it('freezes a trusted origin so it cannot change between preview and queueing', async () => {
      const cycleId = seedGoal();
      const origin = createRunOrigin(cycleId, 'execution', baseCommit);
      expect(Object.isFrozen(origin)).toBe(true);
      const mutable = origin as unknown as Record<string, unknown>;
      for (const [key, value] of [
        ['goalCycleId', 'other-cycle'],
        ['goalRunPurpose', 'review'],
        ['goalBaseCommit', 'f'.repeat(40)],
      ] as const) {
        expect(() => {
          mutable[key] = value;
        }).toThrow(TypeError);
        expect(() => {
          delete mutable[key];
        }).toThrow(TypeError);
      }
      expect(() => {
        mutable.extra = true;
      }).toThrow(TypeError);
      const preview = await buildPreview(db, input(gateWorkflowId), undefined, { origin });
      expect(preview!.origin).toBe(origin);
      const { runId } = queueRun(db, preview!);
      expect(rowOf(runId)).toMatchObject({
        goal_cycle_id: cycleId,
        goal_run_purpose: 'execution',
        goal_base_commit: baseCommit,
      });
    });

    it('validates origin construction and the base commit', async () => {
      expect(() => createRunOrigin('c', 'execution', 'abc')).toThrow(RunOriginError);
      expect(() => createRunOrigin('c', 'execution', baseCommit.toUpperCase())).toThrow(RunOriginError);
      expect(() => createRunOrigin('c', 'bogus' as never)).toThrow(RunOriginError);
      expect(() => createRunOrigin('', 'execution')).toThrow(RunOriginError);
      const cycleId = seedGoal();
      await expect(
        buildPreview(db, input(gateWorkflowId), undefined, {
          origin: createRunOrigin(cycleId, 'execution', 'f'.repeat(40)),
        }),
      ).rejects.toThrow(/does not exist/);
      await expect(
        buildPreview(db, input(plainWorkflowId), undefined, {
          origin: createRunOrigin(cycleId, 'execution', baseCommit),
        }),
      ).rejects.toThrow(/isolated worktree/);
    });

    it('rejects a cycle that belongs to another project or does not exist', async () => {
      const other = join(root, 'other');
      mkdirSync(other);
      const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: other } });
      const otherCycle = seedGoal('goal-other', added.json().project.id as string);
      const preview = await goalPreview(gateWorkflowId, otherCycle);
      expect(() => queueRun(db, preview)).toThrow(/different project/);
      const missing = await buildPreview(db, input(gateWorkflowId), undefined, {
        origin: createRunOrigin('no-such-cycle', 'authoring'),
      });
      expect(() => queueRun(db, missing!)).toThrow(/does not exist/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    });
  });

  describe('preview with a dirty registered checkout', () => {
    it('blocks an ordinary isolated run but not a valid Goal-origin run', async () => {
      writeFileSync(join(repo, 'dirty.txt'), 'uncommitted user work\n');
      const ordinary = await buildPreview(db, input(gateWorkflowId));
      expect(ordinary!.project.dirty).toBe(true);
      expect(ordinary!.canStart).toBe(false);
      expect(ordinary!.warnings.join(' ')).toContain('uncommitted changes');

      const goal = await goalPreview();
      expect(goal.project.dirty).toBe(true);
      expect(goal.canStart).toBe(true);
      expect(goal.branchStrategy).toBe('worktree');
      expect(goal.warnings.join(' ')).not.toContain('uncommitted changes');
      expect(goal.origin).toMatchObject({ goalCycleId: 'goal-1-cycle', goalBaseCommit: baseCommit });
    });

    it('keeps blocking when the origin carries no base commit (initial authoring)', async () => {
      writeFileSync(join(repo, 'dirty.txt'), 'uncommitted user work\n');
      const cycleId = seedGoal();
      const preview = await buildPreview(db, input(gateWorkflowId), undefined, {
        origin: createRunOrigin(cycleId, 'authoring'),
      });
      expect(preview!.canStart).toBe(false);
    });

    it('leaves ordinary previews without an origin key', async () => {
      const ordinary = await buildPreview(db, input(gateWorkflowId));
      expect(ordinary).not.toHaveProperty('origin');
    });

    it(
      'starts a Goal run from the trusted commit while the checkout is dirty and has moved on',
      async () => {
        writeFileSync(join(repo, 'dirty.txt'), 'uncommitted user work\n');
        writeFileSync(join(repo, 'app.txt'), 'uncommitted edit\n');
        const preview = await goalPreview();
        const { runId } = queueRun(db, preview);
        expect(startQueuedRun(db, engine, runId)).toEqual({ started: true });
        await vi.waitFor(() => expect(rowOf(runId).status).toBe('waiting_for_approval'));
        const row = rowOf(runId);
        expect(row.starting_commit).toBe(baseCommit);
        expect(row.starting_commit).not.toBe(headCommit);
        expect(row.base_branch).toBeNull();
        expect(row.branch).toBe(`turing/${runId.slice(0, 8)}`);
        const worktree = String(row.worktree_path);
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(baseCommit);
        expect(existsSync(join(worktree, 'dirty.txt'))).toBe(false);
        expect(git(worktree, 'show', 'HEAD:app.txt')).toBe('base');
        // The user's checkout is untouched.
        expect(git(repo, 'status', '--porcelain')).toContain('dirty.txt');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );

    it('still records HEAD and the base branch for an ordinary run on a clean checkout', async () => {
      const preview = await buildPreview(db, input(gateWorkflowId));
      const run = createRun(db, engine, preview!);
      await vi.waitFor(() => expect(rowOf(run.id).status).toBe('waiting_for_approval'));
      expect(rowOf(run.id)).toMatchObject({ starting_commit: headCommit, base_branch: 'main' });
    });
  });

  describe('queue, idempotency and recovery', () => {
    it('writes origin, stages, rules snapshot and queued event in one transaction without starting', async () => {
      const start = vi.spyOn(engine, 'start');
      const preview = await goalPreview();
      const { runId, existed } = queueRun(db, preview);
      expect(existed).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(rowOf(runId)).toMatchObject({
        status: 'queued',
        goal_cycle_id: 'goal-1-cycle',
        goal_run_purpose: 'execution',
        goal_base_commit: baseCommit,
      });
      expect(db.prepare('SELECT stage_key FROM stages WHERE run_id = ?').all(runId)).toEqual([
        { stage_key: 'gate' },
      ]);
      const events = db
        .prepare('SELECT type, payload_json FROM run_events WHERE run_id = ?')
        .all(runId) as Array<{
        type: string;
        payload_json: string;
      }>;
      expect(events.map((event) => event.type)).toEqual(['run_queued']);
      expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
        goalCycleId: 'goal-1-cycle',
        goalRunPurpose: 'execution',
      });
      expect(JSON.parse(String(rowOf(runId).rules_snapshot_json))).toEqual(preview.effectiveRules);
      expect(db.prepare('SELECT run_id, goal_id, purpose FROM goal_runs').all()).toEqual([
        { run_id: runId, goal_id: 'goal-1', purpose: 'execution' },
      ]);
    });

    it('returns the existing run for a duplicate (cycle, purpose) and creates nothing else', async () => {
      const preview = await goalPreview();
      const first = queueRun(db, preview);
      const second = queueRun(db, preview);
      expect(second).toEqual({ runId: first.runId, existed: true });
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM stages').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM run_events').get()).toEqual({ n: 1 });
      // A different purpose on the same cycle is a distinct run.
      const review = await goalPreview(gateWorkflowId, 'goal-1-cycle', 'review');
      expect(queueRun(db, review).existed).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 2 });
    });

    it('rolls the whole queue transaction back when any part fails', async () => {
      const preview = await goalPreview();
      db.exec(
        `CREATE TRIGGER fail_event BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
      );
      expect(() => queueRun(db, preview)).toThrow(/boom/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM stages').get()).toEqual({ n: 0 });
    });

    it('starts a queued run once and refuses a second start while it is active', async () => {
      const start = vi.spyOn(engine, 'start');
      const { runId } = queueRun(db, await goalPreview());
      expect(startQueuedRun(db, engine, runId)).toEqual({ started: true });
      const again = startQueuedRun(db, engine, runId);
      expect(again.started).toBe(false);
      expect(start).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(rowOf(runId).status).toBe('waiting_for_approval'));
      expect(startQueuedRun(db, engine, runId)).toEqual({ started: false, reason: 'not-queued' });
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('never re-enters terminal, paused, waiting or unknown runs through the fresh-start path', async () => {
      const start = vi.spyOn(engine, 'start');
      const { runId } = queueRun(db, await goalPreview());
      for (const status of [
        'completed',
        'failed',
        'cancelled',
        'paused',
        'waiting_for_user',
        'waiting_for_approval',
        'running',
        'preparing',
      ]) {
        db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
        expect(startQueuedRun(db, engine, runId)).toEqual({ started: false, reason: 'not-queued' });
      }
      expect(startQueuedRun(db, engine, 'missing')).toEqual({ started: false, reason: 'not-found' });
      expect(start).not.toHaveBeenCalled();
    });

    it('reconciles a committed queued Goal run by starting it exactly once', async () => {
      const start = vi.spyOn(engine, 'start');
      const { runId } = queueRun(db, await goalPreview());
      // Simulated restart: the run is committed and linked but was never started.
      engine.reconcileInterruptedRuns();
      expect(rowOf(runId).status).toBe('queued');
      const recover = () => {
        const queued = db
          .prepare("SELECT id FROM goal_runs g JOIN runs r ON r.id = g.run_id WHERE r.status = 'queued'")
          .all() as Array<{ id: string }>;
        return queued.map((row) => startQueuedRun(db, engine, row.id));
      };
      expect(recover()).toEqual([{ started: true }]);
      expect(recover()).toEqual([]);
      expect(start).toHaveBeenCalledExactlyOnceWith(runId);
      await vi.waitFor(() => expect(rowOf(runId).status).toBe('waiting_for_approval'));
    });

    it('refuses a user cancel of a queued Goal-owned run: its Grand Project owns the cancellation', async () => {
      const { runId } = queueRun(db, await goalPreview());
      const response = await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Grand Project/);
      expect(rowOf(runId).status).toBe('queued');
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_cancelled'")
          .get(runId),
      ).toEqual({ n: 0 });
    });

    it('does not let engine recovery start a queued Goal-owned run (HR-Q4)', async () => {
      const { runId } = queueRun(db, await goalPreview());
      const restarted = new RunEngine(db, () => undefined);
      const start = vi.spyOn(restarted, 'start');
      restarted.reconcileInterruptedRuns();
      recoverQueuedRunsAfterRestart(db, restarted);
      expect(start).not.toHaveBeenCalled();
      expect(rowOf(runId).status).toBe('queued');
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_recovered_after_restart'",
          )
          .get(runId),
      ).toEqual({ n: 0 });
    });
  });

  describe('subject state during a Goal run', () => {
    it(
      'records subjectTree and subjectCommit for build stages of Goal runs only',
      async () => {
        const goalRun = queueRun(db, await goalPreview(buildWorkflowId));
        startQueuedRun(db, engine, goalRun.runId);
        await vi.waitFor(() => expect(rowOf(goalRun.runId).status).toBe('completed'), { timeout: 15_000 });
        const output = JSON.parse(
          String(
            (
              db
                .prepare("SELECT output_json FROM stages WHERE run_id = ? AND stage_key = 'build'")
                .get(goalRun.runId) as {
                output_json: string;
              }
            ).output_json,
          ),
        ) as Record<string, unknown>;
        expect(output.exitCode).toBe(0);
        expect(output.subjectCommit).toBe(baseCommit);
        expect(output.subjectTree).toBe(git(repo, 'rev-parse', `${baseCommit}^{tree}`));
        expect(output.subjectScope).toBe('');

        // Ordinary runs keep byte-identical stage output (no subject fields).
        const ordinaryPreview = await buildPreview(db, input(buildWorkflowId));
        expect(ordinaryPreview!.canStart).toBe(true);
        const ordinary = createRun(db, engine, ordinaryPreview!);
        await vi.waitFor(() => expect(rowOf(ordinary.id).status).toBe('completed'), { timeout: 15_000 });
        const plain = JSON.parse(
          String(
            (
              db
                .prepare("SELECT output_json FROM stages WHERE run_id = ? AND stage_key = 'build'")
                .get(ordinary.id) as {
                output_json: string;
              }
            ).output_json,
          ),
        ) as Record<string, unknown>;
        expect(plain).not.toHaveProperty('subjectTree');
        expect(plain).not.toHaveProperty('subjectCommit');
      },
      REAL_GIT_TEST_TIMEOUT_MS,
    );
  });
});
