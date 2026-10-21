import type { Db } from '../db.js';
import type { RunEngine } from '../runEngine.js';
import { startQueuedRun } from '../runLauncher.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import { createGoalSupervisor, type GoalSupervisor, type StartRunResult } from './supervisor.js';
import { TuringGoalExecutor } from './turingExecutor.js';

export interface ProductionGoalComposition {
  supervisor: GoalSupervisor;
  executor: TuringGoalExecutor;
  planner: ResolvedGoalRunPlanProvider;
}

/**
 * The production Goal composition: the supervisor decides, the executor plans through the persisted routing
 * resolution of the cycle, and every child run is an ordinary run started by the one RunEngine. No route is chosen
 * here; `ResolvedGoalRunPlanProvider` re-reads the write-once per-role resolution from the cycle.
 */
export function createProductionGoalComposition(input: {
  db: Db;
  engine: RunEngine;
  /** Startup seam: production defers this until the listener is bound; tests may inject their own. */
  startRun?: (runId: string) => StartRunResult;
  /** Startup seam: production defers this until the listener is bound; tests may inject their own. */
  resumeRun?: (runId: string) => void | Promise<void>;
}): ProductionGoalComposition {
  const planner = new ResolvedGoalRunPlanProvider(input.db, {
    observe: () => observeRouteSnapshot(input.db),
  });
  const executor = new TuringGoalExecutor(input.db, planner, { requireResolvedRoutes: true });
  const supervisor = createGoalSupervisor({
    db: input.db,
    executor,
    startRun: input.startRun ?? ((runId) => startQueuedRun(input.db, input.engine, runId)),
    resumeRun: input.resumeRun ?? ((runId) => input.engine.start(runId, true)),
  });
  return { supervisor, executor, planner };
}
