import type { GoalRole, NextTask } from '../../shared/goals.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import type { FirstUseRequest, GoalRunPurpose, RouteReadiness } from './executor.js';

/**
 * The Stage 4 / Stage 5 seam. Stage 4 consumes an ALREADY CONCRETE workflow (a registered Goal workflow whose AI stages
 * carry an exact route); Stage 5 will later decide which exact route produced it. Nothing on this side inspects route
 * pools, picks members, rotates, evaluates validation freshness, refreshes catalogs, probes, infers fallbacks, or writes
 * route-resolution records.
 */
export interface GoalRunPlanRequest {
  goalId: string;
  cycleId: string;
  purpose: Extract<GoalRunPurpose, 'proposal' | 'execution' | 'remediation'>;
  definitionVersion: number;
  /** The registered workflow the approved definition selects for this purpose. */
  workflowId: string;
  baseCommit: string;
  /** Present for execution and remediation. */
  task?: NextTask;
}

export type GoalRunPlan =
  | {
      ready: true;
      workflowOverride: WorkflowDefinition;
      /**
       * Present when the route came from a persisted 5A resolution: the role and the selected identity the executor must
       * re-prove against the cycle's stored resolution before anything is queued.
       */
      routeBinding?: { role: GoalRole; identityHash: string };
    }
  | {
      ready: false;
      code: 'route_unavailable' | 'provider_unavailable' | 'provider_exhausted';
      message: string;
    }
  | {
      ready: false;
      code: 'approval_required' | 'approval_pending';
      message: string;
      approval: FirstUseRequest;
    };

export interface GoalRunPlanProvider {
  checkRoutes(goalId: string): Promise<RouteReadiness>;
  planRun(request: GoalRunPlanRequest): Promise<GoalRunPlan>;
}

/** The only provider shipped in Stage 4A: no routes exist until Stage 5, so nothing is ever ready. */
export class UnroutedGoalRunPlanProvider implements GoalRunPlanProvider {
  async checkRoutes(): Promise<RouteReadiness> {
    return {
      ready: false,
      code: 'route_unavailable',
      message: 'Goal route resolution is not available in this build.',
    };
  }

  async planRun(): Promise<GoalRunPlan> {
    return {
      ready: false,
      code: 'route_unavailable',
      message: 'Goal route resolution is not available in this build.',
    };
  }
}
