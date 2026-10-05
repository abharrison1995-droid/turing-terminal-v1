import type { BillingLane, WorkflowDefinition, WorkflowStage } from '../../shared/types.js';
import type { RouteReadiness } from './executor.js';
import type { GoalRunPlan, GoalRunPlanProvider, GoalRunPlanRequest } from './runPlan.js';
import { goalBuiltinById } from '../../shared/goalWorkflows.js';

/** A fixed concrete route for every AI stage. Test-only: production has no plan provider until Stage 5. */
export interface FixedRoute {
  backendId: string;
  providerId: string;
  modelId: string;
  billingLane: BillingLane;
}

export const SUBSCRIPTION_TEST_ROUTE: FixedRoute = {
  backendId: 'claude-code',
  providerId: 'anthropic-subscription',
  modelId: 'claude-sonnet-5-5',
  billingLane: 'claude-subscription',
};

export const METERED_TEST_ROUTE: FixedRoute = {
  backendId: 'opencode',
  providerId: 'anthropic',
  modelId: 'anthropic/claude-sonnet-5-5',
  billingLane: 'anthropic-api',
};

const AI = new Set(['planner', 'implementer', 'parallelReview', 'consolidate', 'finalGate', 'remediation']);

/** Applies one route to the AI stages of a built-in workflow and lets a test mutate the result. */
export class FixedGoalRunPlanProvider implements GoalRunPlanProvider {
  readonly requests: GoalRunPlanRequest[] = [];
  /** Registered non-built-in workflows a test planned against. */
  readonly custom = new Map<string, WorkflowDefinition>();
  ready: RouteReadiness = { ready: true };

  constructor(
    private readonly route: FixedRoute = SUBSCRIPTION_TEST_ROUTE,
    private readonly mutate: (workflow: WorkflowDefinition, request: GoalRunPlanRequest) => void = () => {},
  ) {}

  async checkRoutes(): Promise<RouteReadiness> {
    return this.ready;
  }

  async planRun(request: GoalRunPlanRequest): Promise<GoalRunPlan> {
    this.requests.push(request);
    const builtin = this.custom.get(request.workflowId) ?? goalBuiltinById(request.workflowId);
    if (!builtin) return { ready: false, code: 'route_unavailable', message: 'No built-in workflow.' };
    const workflow = structuredClone(builtin) as WorkflowDefinition;
    workflow.stages = workflow.stages.map((stage): WorkflowStage =>
      AI.has(stage.kind) ? { ...stage, ...this.route } : stage,
    );
    this.mutate(workflow, request);
    return { ready: true, workflowOverride: workflow };
  }
}
