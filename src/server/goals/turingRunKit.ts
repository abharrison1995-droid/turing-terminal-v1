import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import { createApp } from '../app.js';
import { RunEngine } from '../runEngine.js';
import { startQueuedRun } from '../runLauncher.js';
import { ActiveTimeTracker } from './activeTime.js';
import { goalRepoFixture, milestone, simpleDefinition, type GoalRepoFixture } from './repoKit.js';
import { GoalSupervisor } from './supervisor.js';
import { TuringGoalExecutor } from './turingExecutor.js';
import { FixedGoalRunPlanProvider, type FixedRoute } from './testPlanProvider.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export interface RealRunHarness {
  fx: GoalRepoFixture;
  engine: RunEngine;
  app: ReturnType<typeof createApp>;
  plans: FixedGoalRunPlanProvider;
  executor: TuringGoalExecutor;
  supervisor: GoalSupervisor;
  /** A supervisor and executor on the same database, as after a process restart (a fresh engine too). */
  restart(): { executor: TuringGoalExecutor; supervisor: GoalSupervisor; engine: RunEngine };
  /** Writes through the broker the provider token carries, exactly as a provider CLI tool call would. */
  broker(
    token: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ error?: string; result?: string }>;
  tick(): Promise<string>;
  /** Ticks until the action is seen, waiting for the real engine between ticks. */
  until(action: string, max?: number): Promise<string[]>;
  baseCommit: string;
  worktrees(): string[];
  cycleId(): string;
  runRow(runId: string): Record<string, unknown>;
  close(): Promise<void>;
}

export const BUILT_IN_WORKFLOWS = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
} as const;

/**
 * A real temporary Git repository, real SQLite, the real RunEngine and Fastify app, and the production
 * `TuringGoalExecutor`. Only the provider process boundary (`providers.js`) is mocked by the calling test file.
 */
export async function realRunHarness(
  options: {
    route?: FixedRoute;
    mutate?: ConstructorParameters<typeof FixedGoalRunPlanProvider>[1];
    definition?: GoalDefinition;
  } = {},
): Promise<RealRunHarness> {
  const definition =
    options.definition ??
    simpleDefinition({
      milestones: [
        milestone('m1', ['build', 'tests'], { allowedScope: { includeGlobs: ['src/**'], excludeGlobs: [] } }),
      ],
    });
  delete definition.review.periodic;
  delete definition.review.onRepeatedFailure;
  definition.routing.workflows = { ...BUILT_IN_WORKFLOWS };
  const fx = goalRepoFixture({ definition });
  const { db } = fx;
  const root = dirname(fx.repo);
  const previousDataDir = process.env.TT_DATA_DIR;
  process.env.TT_DATA_DIR = join(root, 'engine-data');

  const buildOk = `node -e "console.log('build-ok')"`;
  fx.advance(
    {
      'package.json': JSON.stringify({
        scripts: { build: buildOk, test: `node -e "console.log('test-ok')"` },
      }),
    },
    'project scripts',
  );
  db.prepare('UPDATE projects SET build_command_json = ?, test_command_json = ? WHERE id = ?').run(
    JSON.stringify(['npm', 'run', 'build']),
    JSON.stringify(['npm', 'run', 'test']),
    fx.projectId,
  );

  let engine = new RunEngine(db, () => undefined);
  const app = createApp({ database: db, engine });
  await app.ready();
  const tracker = new ActiveTimeTracker(db, { nowMs: () => 5_000_000_000 }, 15_000);
  const plans = new FixedGoalRunPlanProvider(options.route, options.mutate);
  const make = (runEngine: RunEngine) => {
    const executor = new TuringGoalExecutor(db, plans);
    return {
      executor,
      supervisor: new GoalSupervisor({
        db,
        executor,
        startRun: (runId) => startQueuedRun(db, runEngine, runId),
        resumeRun: (runId) => runEngine.start(runId, true),
        activeTime: tracker,
      }),
    };
  };
  const first = make(engine);
  const settle = async () => {
    await vi.waitFor(
      () => {
        const active = db
          .prepare(
            "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','preparing','retrying','cancelling')",
          )
          .get() as { n: number };
        // A queued run is waiting for the supervisor, not the engine.
        const engineActive = db
          .prepare("SELECT id FROM runs WHERE status IN ('running','preparing','retrying','cancelling')")
          .all() as Array<{ id: string }>;
        if (engineActive.some((row) => engine.isActive(row.id))) throw new Error('engine busy');
        return active;
      },
      { timeout: 15_000, interval: 25 },
    );
  };
  const harness: RealRunHarness = {
    fx,
    engine,
    app,
    plans,
    ...first,
    baseCommit: fx.head(),
    restart() {
      engine = new RunEngine(db, () => undefined);
      harness.engine = engine;
      return { ...make(engine), engine };
    },
    async broker(token, toolName, input) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/provider-tools',
        headers: { authorization: `Bearer ${token}` },
        payload: { toolName, input },
      });
      return response.json() as { error?: string; result?: string };
    },
    async tick() {
      return (await harness.supervisor.tickGoal(fx.goalId)).action;
    },
    async until(action, max = 40) {
      const seen: string[] = [];
      for (let index = 0; index < max; index++) {
        const next = await harness.tick();
        seen.push(next);
        if (next === action) return seen;
        await settle();
      }
      throw new Error(`never reached ${action}: ${seen.join(', ')}`);
    },
    worktrees() {
      const dir = join(process.env.TT_DATA_DIR!, 'worktrees');
      return existsSync(dir) ? readdirSync(dir) : [];
    },
    cycleId() {
      return (
        db
          .prepare('SELECT id FROM goal_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1')
          .get(fx.goalId) as { id: string }
      ).id;
    },
    runRow: (runId) => db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown>,
    async close() {
      await settle().catch(() => undefined);
      await app.close();
      if (previousDataDir === undefined) delete process.env.TT_DATA_DIR;
      else process.env.TT_DATA_DIR = previousDataDir;
    },
  };
  void git;
  return harness;
}
