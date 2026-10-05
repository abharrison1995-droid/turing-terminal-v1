import type { GoalRole } from '../../shared/goals.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import { isModelBackedStage } from '../../shared/workflowKinds.js';
import type { Db } from '../db.js';
import { activeCycle, getCycle } from './cycles.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import type { FirstUseRequest, RouteReadiness } from './executor.js';
import type { RoleOutcome, RoleRefusal, RoleResolution } from './routeAudit.js';
import type { RouteSnapshot } from './routeIdentity.js';
import {
  loadStoredEnvironment,
  previewGoalRoutes,
  readStoredResolutions,
  resolveRolesForCycle,
  RouteResolutionError,
  type RoutingBillingTerms,
} from './routeResolution.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import type { RoutingEnvironment } from './routing.js';
import type { GoalRunPlan, GoalRunPlanProvider, GoalRunPlanRequest } from './runPlan.js';
import { PLAN_ROUTE_FIELDS, TuringExecutorError, registeredGoalWorkflow } from './turingExecutor.js';

/**
 * The roles a Goal's run purposes draw their route from. Verification is deterministic and route-free, and Stage 6
 * (reviewer runs) is not planned here. Proposal is made by the orchestrator; execution and remediation by the implementer.
 */
export const PURPOSE_ROLE: Readonly<Record<GoalRunPlanRequest['purpose'], GoalRole>> = {
  proposal: 'orchestrator',
  execution: 'implementer',
  remediation: 'implementer',
};

/** The only roles `checkRoutes` requires today. */
export const READINESS_ROLES: readonly GoalRole[] = ['orchestrator', 'implementer'];

/** Reasons that mean the provider itself (not the model, billing or approval) is why a member cannot be used. */
const PROVIDER_REASONS = new Set([
  'provider_missing',
  'provider_not_detected',
  'provider_execution_unsupported',
  'provider_disconnected',
  'subscription_auth_unverified',
  'profile_missing',
  'profile_mismatch',
  'profile_not_ready',
]);

export interface ResolvedPlanDeps {
  /** The provider/profile observation. Defaults to the live infrastructure every run uses. */
  observe?: () => Promise<RouteSnapshot>;
  now?: () => string;
}

type Unready = Extract<GoalRunPlan, { ready: false }>;

function firstUseOf(refusal: RoleRefusal): FirstUseRequest | null {
  const candidate = refusal.candidate;
  if (!candidate) return null;
  return {
    poolId: candidate.poolId,
    memberIdentityHash: candidate.memberIdentityHash,
    role: refusal.role,
    memberIndex: candidate.memberIndex,
    ...(candidate.approvalId ? { approvalId: candidate.approvalId } : {}),
  };
}

/**
 * The finite mapping of a routing refusal into what the supervisor understands. A corrupt persisted resolution, an
 * unproven independence and a missing route all stop the work (route_unavailable) with the refusal code kept in the
 * message; only a first-use requirement becomes a gate, and nothing is ever substituted. `provider_exhausted` is never
 * produced here: no authoritative quota signal exists in the provider observation.
 */
export function mapRefusal(refusal: RoleRefusal): Unready {
  if (refusal.code === 'approval_required' || refusal.code === 'approval_pending') {
    const approval = firstUseOf(refusal);
    if (approval)
      return {
        ready: false,
        code: refusal.code,
        message: `${refusal.role}: a pool member needs first-use approval.`,
        approval,
      };
    return {
      ready: false,
      code: 'route_unavailable',
      message: `${refusal.role}: ${refusal.code} (no candidate).`,
    };
  }
  if (
    refusal.code === 'route_unavailable' &&
    refusal.evaluatedMembers.length > 0 &&
    refusal.evaluatedMembers.every((member) => member.reasons.some((reason) => PROVIDER_REASONS.has(reason)))
  )
    return {
      ready: false,
      code: 'provider_unavailable',
      message: `${refusal.role}: no provider is available.`,
    };
  return { ready: false, code: 'route_unavailable', message: `${refusal.role}: ${refusal.code}.` };
}

function refusalOf(outcome: RoleOutcome | undefined, role: GoalRole): RoleRefusal | null {
  if (!outcome)
    return {
      status: 'refused',
      role,
      code: 'route_not_defined',
      definitionVersion: 0,
      definitionHash: '',
      routeKind: null,
      poolId: null,
      evaluatedMembers: [],
    };
  return outcome.status === 'refused' ? outcome : null;
}

/** Applies exactly the selected configuration to a stage's route fields (and removes every other route field). */
export function applyExactRoute(
  workflow: WorkflowDefinition,
  configuration: RoleResolution['selected']['configuration'],
): WorkflowDefinition {
  return {
    ...workflow,
    stages: workflow.stages.map((stage) => {
      if (!isModelBackedStage(stage.kind)) return stage;
      const copy: Record<string, unknown> = { ...stage };
      for (const key of PLAN_ROUTE_FIELDS) delete copy[key];
      for (const [key, value] of Object.entries(configuration)) if (value !== undefined) copy[key] = value;
      return copy as unknown as typeof stage;
    }),
  };
}

const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** True when every model-backed stage carries exactly the selected configuration, field for field. */
export function stagesCarryRoute(
  workflow: WorkflowDefinition,
  configuration: RoleResolution['selected']['configuration'],
): boolean {
  const fields = [
    'backendId',
    'providerId',
    'billingLane',
    'modelId',
    'connectionProfileId',
    'variantId',
    'reasoning',
    'nativeSettings',
  ] as const;
  const modelBacked = workflow.stages.filter((stage) => isModelBackedStage(stage.kind));
  if (modelBacked.length === 0) return false;
  return modelBacked.every((stage) =>
    fields.every((field) =>
      sameValue((stage as unknown as Record<string, unknown>)[field], configuration[field]),
    ),
  );
}

/**
 * The real Goal run-plan provider: it asks the Stage 5A routing authority which exact route a role uses and returns the
 * registered workflow with exactly that route. It starts nothing, writes only the write-once role resolution of the
 * cycle (through 5A), requests no approval (the supervisor owns gates) and never substitutes a model, lane or member.
 * Every call builds a FRESH environment: current provider snapshot, canonical validations, first-use approvals, the
 * Goal's resolution history, the current time and the approved definition.
 */
/** The billing authority of one registered workflow: its mode and (custom mode) its allowed lanes. */
export function workflowBillingTerms(
  registered: ReturnType<typeof registeredGoalWorkflow>,
): RoutingBillingTerms {
  return {
    workflowBilling: {
      mode:
        registered.billingMode ?? (registered.subscriptionOnly === false ? 'custom' : 'subscriptions-only'),
      ...(registered.customAllowedLanes ? { customAllowedLanes: registered.customAllowedLanes } : {}),
    },
  };
}

export class ResolvedGoalRunPlanProvider implements GoalRunPlanProvider {
  constructor(
    private readonly db: Db,
    private readonly deps: ResolvedPlanDeps = {},
  ) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private async environment(goalId: string, excludeCycleId?: string): Promise<RoutingEnvironment | null> {
    const goal = this.db
      .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
      .get(goalId) as { version: number | null } | undefined;
    const stored = goal?.version == null ? undefined : loadDefinitionVersion(this.db, goalId, goal.version);
    if (!stored || stored.status !== 'approved' || !verifyDefinitionHash(stored)) return null;
    const snapshot = await (this.deps.observe ?? (() => observeRouteSnapshot(this.db)))();
    return loadStoredEnvironment(this.db, {
      goalId,
      definition: stored.definition,
      now: this.now(),
      providers: snapshot.providers,
      profiles: snapshot.profiles,
      ...(excludeCycleId ? { excludeCycleId } : {}),
    });
  }

  async checkRoutes(goalId: string): Promise<RouteReadiness> {
    const goalRow = this.db
      .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
      .get(goalId) as { version: number | null } | undefined;
    const stored =
      goalRow?.version == null ? undefined : loadDefinitionVersion(this.db, goalId, goalRow.version);
    if (!stored || stored.status !== 'approved' || !verifyDefinitionHash(stored))
      return {
        ready: false,
        code: 'route_unavailable',
        message: 'The Goal has no verified approved definition.',
      };
    // A non-terminal active cycle is the history being resumed. Its own persisted resolution is never counted as prior
    // round-robin history (as `planRun` excludes it), so preflight derives the very member the cycle already holds.
    const active = activeCycle(this.db, goalId);
    const environment = await this.environment(goalId, active?.id);
    if (!environment)
      return {
        ready: false,
        code: 'route_unavailable',
        message: 'The Goal has no verified approved definition.',
      };
    // Each role is judged under ITS OWN workflow's billing authority, exactly as the plan path resolves it.
    const workflows = stored.definition.routing.workflows;
    const workflowFor: Partial<Record<GoalRole, string>> = {
      orchestrator: workflows.planning,
      implementer: workflows.execution,
    };
    const refusals: RoleRefusal[] = [];
    for (const role of READINESS_ROLES) {
      let result;
      try {
        const billing = workflowBillingTerms(
          registeredGoalWorkflow(this.db, workflowFor[role] ?? workflows.execution),
        );
        result = previewGoalRoutes(this.db, {
          goalId,
          environment,
          roles: [role],
          billing,
        }).result;
      } catch (error) {
        if (error instanceof RouteResolutionError || error instanceof TuringExecutorError)
          return {
            ready: false,
            code: 'route_unavailable',
            message:
              error instanceof RouteResolutionError
                ? `Route resolution refused: ${error.code}.`
                : `${role}: the registered workflow is unavailable.`,
          };
        throw error;
      }
      const refusal = refusalOf(result.roles[role], role);
      if (refusal) refusals.push(refusal);
    }
    if (refusals.length === 0) return { ready: true };
    // Approval requests are reported after other refusals so a ready Goal can be asked about its pool member.
    const blocking = refusals.find((item) => !['approval_required', 'approval_pending'].includes(item.code));
    return mapRefusal(blocking ?? refusals[0]!);
  }

  async planRun(request: GoalRunPlanRequest): Promise<GoalRunPlan> {
    const role = PURPOSE_ROLE[request.purpose];
    if (!role) return { ready: false, code: 'route_unavailable', message: 'This purpose has no route role.' };
    // Re-prove the cycle, definition and base before resolving anything.
    const goal = this.db
      .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
      .get(request.goalId) as { version: number | null } | undefined;
    const cycle = getCycle(this.db, request.cycleId);
    if (
      !goal ||
      !cycle ||
      cycle.goalId !== request.goalId ||
      cycle.definitionVersion === null ||
      cycle.definitionVersion !== request.definitionVersion ||
      cycle.definitionVersion !== goal.version ||
      !cycle.baseIntegrationCommit ||
      cycle.baseIntegrationCommit !== request.baseCommit
    )
      return {
        ready: false,
        code: 'route_unavailable',
        message: 'The cycle is not the current definition and base.',
      };
    const registered = registeredGoalWorkflow(this.db, request.workflowId);
    const billing = workflowBillingTerms(registered);
    const environment = await this.environment(request.goalId, request.cycleId);
    if (!environment)
      return {
        ready: false,
        code: 'route_unavailable',
        message: 'The Goal has no verified approved definition.',
      };
    let result;
    try {
      result = resolveRolesForCycle(this.db, {
        goalId: request.goalId,
        cycleId: request.cycleId,
        roles: [role],
        environment,
        billing,
      });
    } catch (error) {
      if (error instanceof RouteResolutionError)
        return {
          ready: false,
          code: 'route_unavailable',
          message: `Route resolution refused: ${error.code}.`,
        };
      throw error;
    }
    const outcome = result.roles[role];
    const refusal = refusalOf(outcome, role);
    if (refusal) return mapRefusal(refusal);
    // The resolution must be PERSISTED and be the very one that is used: re-read it from the cycle row.
    const row = this.db
      .prepare('SELECT route_resolution_json AS json FROM goal_cycles WHERE id = ?')
      .get(request.cycleId) as { json: string | null } | undefined;
    const stored = readStoredResolutions(row?.json ?? null)[role];
    if (
      !stored ||
      outcome?.status !== 'resolved' ||
      stored.selected.identityHash !== outcome.resolution.selected.identityHash
    )
      return {
        ready: false,
        code: 'route_unavailable',
        message: `${role}: the resolution is not persisted.`,
      };
    const workflowOverride = applyExactRoute(registered, stored.selected.configuration);
    if (!stagesCarryRoute(workflowOverride, stored.selected.configuration))
      return {
        ready: false,
        code: 'route_unavailable',
        message: `${role}: the workflow has no model-backed stage.`,
      };
    return {
      ready: true,
      workflowOverride,
      routeBinding: { role, identityHash: stored.selected.identityHash },
    };
  }
}
