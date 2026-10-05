import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import { ActiveTimeTracker } from './activeTime.js';
import type { ChildRunRequest } from './executor.js';
import { FakeGoalExecutor } from './fakeExecutor.js';
import { goalRepoFixture, milestone, simpleDefinition, type GoalRepoFixture } from './repoKit.js';
import { GoalSupervisor, type TickAction } from './supervisor.js';

/** Test harness: a real temporary Git repository, a Goal with an approved definition, a fake executor and fake time. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export const GOOD_TASK = {
  milestoneKey: 'm1',
  title: 'Add a',
  instructions: 'Create src/a.ts exporting a.',
  targetCriteria: ['build'],
  expectedPaths: ['src/a.ts'],
  rationale: 'The build criterion needs the module.',
};

export interface Harness {
  fx: GoalRepoFixture;
  supervisor: GoalSupervisor;
  executor: FakeGoalExecutor;
  tracker: ActiveTimeTracker;
  clock: { ms: number };
  startRun: ReturnType<typeof vi.fn<(runId: string) => void>>;
  resumeRun: ReturnType<typeof vi.fn<(runId: string) => void>>;
  /** Files the next queued run commits in its worktree. */
  files: { current: Record<string, string | null> };
  tick(): Promise<TickAction>;
  /** Ticks until the predicate on the returned action holds (at most `max` ticks); returns all actions. */
  until(stop: TickAction, max?: number): Promise<TickAction[]>;
  status(): { status: string; reason: string | null };
  cycle(): { id: string; status: string; kind: string; outcome: Record<string, unknown> | null } | undefined;
  runs(): Array<{ id: string; status: string; goal_cycle_id: string | null }>;
  setRunStatus(runId: string, status: string): void;
  start(): Promise<void>;
}

export function harness(
  options: { definition?: GoalDefinition; tune?: (definition: GoalDefinition) => void } = {},
): Harness {
  const definition =
    options.definition ??
    simpleDefinition({ milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])] });
  delete definition.review.periodic;
  delete definition.review.onRepeatedFailure;
  options.tune?.(definition);
  const fx = goalRepoFixture({ definition });
  const { db } = fx;
  const clock = { ms: 5_000_000_000 };
  const tracker = new ActiveTimeTracker(db, { nowMs: () => clock.ms }, 15_000);
  const files = { current: { 'src/a.ts': 'export const a = 1;\n' } as Record<string, string | null> };

  const makeRun = (request: ChildRunRequest): string => {
    const runId = randomUUID();
    const branch = `turing/${runId.slice(0, 8)}`;
    const worktree = join(dirname(fx.repo), `wt-${runId.slice(0, 8)}`);
    git(fx.repo, 'worktree', 'add', '-q', '-b', branch, worktree, request.baseCommit);
    for (const [path, content] of Object.entries(files.current)) {
      const full = join(worktree, path);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    git(worktree, 'add', '-A');
    if (git(worktree, 'status', '--porcelain'))
      git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'work');
    const machine = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status,
         created_at, branch, worktree_path, summary, goal_cycle_id, goal_run_purpose, goal_base_commit)
       VALUES (?, ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 'task', 'economy', 'normal', 'queued', ?, ?, ?, 'Did the work', ?, ?, ?)`,
    ).run(
      runId,
      machine,
      fx.projectId,
      new Date().toISOString(),
      branch,
      worktree,
      request.cycleId,
      request.purpose,
      request.baseCommit,
    );
    return runId;
  };

  const executor = new FakeGoalExecutor(makeRun);
  const startRun = vi.fn<(runId: string) => void>((runId) => {
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  });
  const resumeRun = vi.fn<(runId: string) => void>();
  const supervisor = new GoalSupervisor({ db, executor, startRun, resumeRun, activeTime: tracker });
  const h: Harness = {
    fx,
    supervisor,
    executor,
    tracker,
    clock,
    startRun,
    resumeRun,
    files,
    async tick() {
      return (await supervisor.tickGoal(fx.goalId)).action;
    },
    async until(stop, max = 30) {
      const seen: TickAction[] = [];
      for (let index = 0; index < max; index++) {
        const action = await h.tick();
        seen.push(action);
        if (action === stop) return seen;
      }
      throw new Error(`never reached ${stop}: ${seen.join(', ')}`);
    },
    status: () =>
      db.prepare('SELECT status, status_reason_code AS reason FROM goals WHERE id = ?').get(fx.goalId) as {
        status: string;
        reason: string | null;
      },
    cycle: () =>
      (
        db
          .prepare(
            `SELECT id, status, kind, outcome_json FROM goal_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .all(fx.goalId) as Array<{ id: string; status: string; kind: string; outcome_json: string | null }>
      ).map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.kind,
        outcome: row.outcome_json ? (JSON.parse(row.outcome_json) as Record<string, unknown>) : null,
      }))[0],
    runs: () =>
      db
        .prepare('SELECT id, status, goal_cycle_id FROM runs WHERE goal_cycle_id IS NOT NULL ORDER BY rowid')
        .all() as Array<{
        id: string;
        status: string;
        goal_cycle_id: string | null;
      }>,
    setRunStatus: (runId, status) => {
      db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
    },
    async start() {
      const result = await supervisor.startGoal(fx.goalId);
      if (!result.ok) throw new Error(`start failed: ${result.code}`);
    },
  };
  return h;
}
