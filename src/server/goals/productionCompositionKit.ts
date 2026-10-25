import { expect } from 'vitest';
import type { Db } from '../db.js';
import type { RunEngine } from '../runEngine.js';
import { DisabledGoalExecutor } from './executor.js';
import { createProductionGoalComposition } from './productionComposition.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { TuringGoalExecutor } from './turingExecutor.js';

const inertEngine = { start: () => undefined } as unknown as RunEngine;

/**
 * Test support: proves at runtime that the production composition uses the persisted-route executor, not the disabled
 * sentinel. The engine is inert because this check starts nothing.
 */
export async function expectProductionGoalCompositionEnabled(db: Db): Promise<void> {
  const composition = createProductionGoalComposition({ db, engine: inertEngine });
  expect(composition.executor).toBeInstanceOf(TuringGoalExecutor);
  expect(composition.executor.id).toBe('turing');
  expect(composition.planner).toBeInstanceOf(ResolvedGoalRunPlanProvider);
  expect(composition.supervisor).toBeDefined();
  // The real executor's persisted-run fast path is not the disabled executor's sentinel.
  await expect(composition.executor.readProposal('missing-run')).resolves.toEqual({
    ok: false,
    code: 'proposal_run_invalid',
  });
  await expect(new DisabledGoalExecutor().readProposal()).resolves.toEqual({
    ok: false,
    code: 'executor_disabled',
  });
}
