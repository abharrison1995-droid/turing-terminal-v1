import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { RunEngine } from '../runEngine.js';
import { readStoredResolutions } from './routeResolution.js';
import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import {
  closeLifecycle,
  driveToVerifiedHandoff,
  installFakeProviders,
  lifecycle,
  openGoal,
  runFor,
} from './goalLifecycleKit.js';
import { createProductionGoalComposition } from './productionComposition.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { TuringGoalExecutor } from './turingExecutor.js';

/**
 * Runtime acceptance for the production Goal composition. The provider process boundary and the route-validation rows
 * are fakes; the composition function, the persisted-route planner, the executor, the supervisor, the unmodified
 * RunEngine, the broker, Git and SQLite are real.
 */
vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Live provider calls are disabled in production composition tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

beforeEach(() => installFakeProviders());
afterEach(async () => closeLifecycle());

const routeOf = (configuration: Record<string, unknown>) => ({
  backendId: configuration.backendId,
  providerId: configuration.providerId,
  billingLane: configuration.billingLane,
  modelId: configuration.modelId,
});

describe('production Goal composition', () => {
  it(
    'runs one bounded child run on the persisted exact route through the unmodified engine and stops at manual handoff',
    async () => {
      const harness = await openGoal('gpt-5.5', 'sha1');
      const { db, goalId } = harness.fx;
      const base = harness.baseCommit;
      const composition = createProductionGoalComposition({ db, engine: harness.engine });
      expect(composition.executor).toBeInstanceOf(TuringGoalExecutor);
      expect(composition.planner).toBeInstanceOf(ResolvedGoalRunPlanProvider);

      // Record what the real planner persisted after each of its calls, so write-once is observed on the live path.
      const planHistory: Array<{ cycleId: string; json: string | null }> = [];
      const originalPlanRun = composition.planner.planRun.bind(composition.planner);
      composition.planner.planRun = async (request) => {
        const result = await originalPlanRun(request);
        const row = db
          .prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ?')
          .get(request.cycleId) as { json: string | null } | undefined;
        planHistory.push({ cycleId: request.cycleId, json: row?.json ?? null });
        return result;
      };

      // Drive the whole Goal through the composed supervisor and app: approval, proposal, child run, review, acceptance.
      harness.supervisor = composition.supervisor;
      const serving = createApp({
        database: db,
        engine: harness.engine,
        goalSupervisor: composition.supervisor,
      });
      await serving.ready();
      lifecycle.serving = serving;
      harness.restart = () => {
        const engine = new RunEngine(db, () => undefined);
        harness.engine = engine;
        const next = createProductionGoalComposition({ db, engine });
        return { supervisor: next.supervisor, executor: next.executor, engine };
      };

      const result = await driveToVerifiedHandoff(harness, 'fast-forward');

      const executionRun = runFor(db, goalId, 'execution');
      const proposalRun = runFor(db, goalId, 'proposal');
      const executionCycleId = (
        db.prepare('SELECT goal_cycle_id AS id FROM runs WHERE id = ?').get(executionRun.id) as { id: string }
      ).id;
      const cycleRow = db
        .prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ?')
        .get(executionCycleId) as { json: string };
      const stored = readStoredResolutions(cycleRow.json);
      expect(stored.orchestrator?.selected.configuration.modelId).toBe('claude-sonnet-5-5');
      expect(stored.implementer?.selected.configuration.modelId).toBe('claude-opus-5-5');

      const stagesOf = (runId: string) =>
        db
          .prepare(
            `SELECT DISTINCT backend_id AS backendId, provider_id AS providerId,
                    billing_lane AS billingLane, model_id AS modelId
             FROM stages WHERE run_id = ? AND model_id IS NOT NULL
             ORDER BY model_id`,
          )
          .all(runId) as Array<Record<string, unknown>>;
      expect(stagesOf(proposalRun.id)).toEqual([
        routeOf(stored.orchestrator!.selected.configuration as unknown as Record<string, unknown>),
      ]);
      expect(stagesOf(executionRun.id)).toEqual([
        routeOf(stored.implementer!.selected.configuration as unknown as Record<string, unknown>),
      ]);

      const implementerCalls = lifecycle.providerCalls.filter((call) => call.role === 'implementer');
      expect(implementerCalls.length).toBeGreaterThan(0);
      for (const call of implementerCalls) {
        expect(call).toMatchObject({
          ...stored.implementer!.selected.configuration,
        });
        // The provider process ran in the run's isolated worktree, not in the user's checkout.
        expect(call.cwd.startsWith(`${process.env.TT_DATA_DIR}/worktrees/`)).toBe(true);
        expect(call.cwd).not.toBe(harness.fx.repo);
      }

      // The route resolution is write-once: once a role is persisted on a cycle, every later plan of that cycle keeps
      // the exact same entry. The history is the planner's own post-call view of the cycle row.
      const written = new Map<string, string>();
      for (const { cycleId, json } of planHistory) {
        const resolutions = readStoredResolutions(json);
        for (const [role, resolution] of Object.entries(resolutions)) {
          if (!resolution) continue;
          const key = `${cycleId}:${role}`;
          const entry = JSON.stringify(resolution);
          if (written.has(key)) expect(entry).toBe(written.get(key));
          else written.set(key, entry);
        }
      }
      expect(written.has(`${executionCycleId}:orchestrator`)).toBe(true);
      expect(written.has(`${executionCycleId}:implementer`)).toBe(true);

      // The user's base branch was not written: the handoff only observed it, and integration was the test's user action.
      expect(result.integratedHead).not.toBe(base);
      expect(result.handoffId).toBeTruthy();
      expect(
        db
          .prepare(
            `SELECT source_commit AS source, observed_base_commit AS observed
             FROM goal_result_handoffs WHERE id = ?`,
          )
          .get(result.handoffId),
      ).toEqual({ source: result.integratedHead, observed: base });

      // The role readiness path still reports the persisted routes as ready after the lifecycle.
      expect(await composition.planner.checkRoutes(goalId)).toEqual({ ready: true });
      await serving.close();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
