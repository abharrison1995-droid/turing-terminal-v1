import type { GoalRole } from '../../shared/goals.js';
import type { GoalPreview, GoalRouteResolutionSummary } from '../../shared/goalApi.js';
import type { Db } from '../db.js';
import { storedProviders } from '../modelCatalog.js';
import { evaluateBounds } from './bounds.js';
import { activeCycle } from './cycles.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import { openFindingCounts } from './findings.js';
import {
  completionView,
  deriveNextAction,
  evaluateForRead,
  GoalReadError,
  pendingApprovalViews,
  proposalRequired,
  summariseResolution,
  taskView,
  usageSummary,
} from './readModel.js';
import { resolveGoalRepository } from './repository.js';
import { loadStoredEnvironment, previewGoalRoutes, RouteResolutionError } from './routeResolution.js';
import { observeProfiles } from './routingSnapshot.js';
import type { RouteSnapshot } from './routeIdentity.js';
import { READINESS_ROLES, workflowBillingTerms } from './routePlan.js';
import { TuringExecutorError, registeredGoalWorkflow } from './turingExecutor.js';

/**
 * The Goal Preview: "what would Turing do next, and is it allowed" without doing any of it. It is a pure read
 * of persisted rows, in-memory observations and Git objects at the Goal head:
 *   - no provider call, no provider discovery, no network request, no probe, no model catalog write;
 *   - no run, cycle, route resolution, approval, event or Goal status change is created, and no pool rotates;
 *   - the proposal is NOT generated: only an already persisted validated task is shown, otherwise `task` is null.
 * Routing uses a stored observation (the provider status already held in memory plus the cached catalog and the stored
 * profile/credential observations), so a provider that was never observed in this process shows as unavailable here
 * rather than being discovered by a GET.
 */
export interface PreviewDeps {
  /** The provider/profile observation. Defaults to the stored one; tests may supply a fixed snapshot. */
  observe?: () => Promise<RouteSnapshot>;
  now?: () => string;
}

const storedSnapshot = async (db: Db): Promise<RouteSnapshot> => ({
  providers: await storedProviders(db),
  profiles: observeProfiles(db),
});

export async function previewGoal(db: Db, goalId: string, deps: PreviewDeps = {}): Promise<GoalPreview> {
  const goal = db
    .prepare(
      `SELECT status, status_reason_code, status_detail_json, current_definition_version, active_milestone_id
       FROM goals WHERE id = ?`,
    )
    .get(goalId) as
    | {
        status: GoalPreview['status'];
        status_reason_code: string | null;
        status_detail_json: string | null;
        current_definition_version: number | null;
        active_milestone_id: string | null;
      }
    | undefined;
  if (!goal) throw new GoalReadError('goal_not_found', 'The Goal does not exist.');
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const runtime = db.prepare('SELECT * FROM goal_runtime WHERE goal_id = ?').get(goalId) as
    | {
        cycles_executed: number;
        consecutive_failed_cycles: number;
        remediation_attempts_json: string;
        active_ms: number;
        goal_branch: string | null;
        integration_head: string | null;
      }
    | undefined;
  const stored =
    goal.current_definition_version === null
      ? undefined
      : loadDefinitionVersion(db, goalId, goal.current_definition_version);
  const cycle = activeCycle(db, goalId);
  const evaluation = await evaluateForRead(db, goalId);
  const completion = evaluation ? completionView(evaluation) : null;
  const repository = stored ? await resolveGoalRepository(db, goalId) : null;
  const milestoneRow = goal.active_milestone_id
    ? (db
        .prepare('SELECT milestone_key AS key FROM goal_milestones WHERE id = ? AND goal_id = ?')
        .get(goal.active_milestone_id, goalId) as { key: string } | undefined)
    : undefined;
  const runtimeView = {
    cyclesExecuted: runtime?.cycles_executed ?? 0,
    consecutiveFailedCycles: runtime?.consecutive_failed_cycles ?? 0,
    remediationAttempts: (() => {
      try {
        return JSON.parse(runtime?.remediation_attempts_json ?? '{}') as Record<string, number>;
      } catch {
        return {};
      }
    })(),
    activeMs: runtime?.active_ms ?? 0,
  };
  const spend = usageSummary(db, goalId).meteredSpendUsd;

  let limits: GoalPreview['limits'] = null;
  let billing: GoalPreview['billing'] = null;
  if (stored) {
    const hard = stored.definition.limits;
    const breach = evaluateBounds(db, goalId, { now });
    const activeMinutes = Math.floor(runtimeView.activeMs / 60_000);
    const baseline = db.prepare('SELECT approved_at, started_at FROM goals WHERE id = ?').get(goalId) as {
      approved_at: string | null;
      started_at: string | null;
    };
    const since = baseline.approved_at ?? baseline.started_at;
    const elapsedDays = since ? Math.max(0, (Date.parse(now) - Date.parse(since)) / 86_400_000) : 0;
    limits = {
      hard: {
        maxExecutionCycles: hard.maxExecutionCycles,
        maxConsecutiveFailedCycles: hard.maxConsecutiveFailedCycles,
        maxRemediationAttempts: hard.maxRemediationAttempts,
        maxActiveMinutes: hard.maxActiveMinutes,
        maxWallClockDays: hard.maxWallClockDays,
        maxParallelAgents: hard.maxParallelAgents,
        maxMeteredUsd: hard.maxMeteredUsd,
        billingMode: hard.billingMode,
      },
      remaining: {
        executionCycles: Math.max(0, hard.maxExecutionCycles - runtimeView.cyclesExecuted),
        consecutiveFailedCycles: Math.max(
          0,
          hard.maxConsecutiveFailedCycles - runtimeView.consecutiveFailedCycles,
        ),
        activeMinutes: Math.max(0, hard.maxActiveMinutes - activeMinutes),
        wallClockDays: Math.max(0, Math.floor(hard.maxWallClockDays - elapsedDays)),
        meteredUsd:
          hard.billingMode === 'subscriptions-only'
            ? 0
            : hard.maxMeteredUsd === null
              ? null
              : Math.max(0, hard.maxMeteredUsd - spend),
      },
      breach: breach ? { reason: breach.reason, limit: breach.limit, observed: breach.observed } : null,
    };
    billing = { mode: hard.billingMode, maxMeteredUsd: hard.maxMeteredUsd, meteredSpendUsd: spend };
  }

  let routing: GoalPreview['routing'] = null;
  if (stored && stored.status === 'approved' && verifyDefinitionHash(stored)) {
    const snapshot = await (deps.observe ?? (() => storedSnapshot(db)))();
    const environment = loadStoredEnvironment(db, {
      goalId,
      definition: stored.definition,
      now,
      providers: snapshot.providers,
      profiles: snapshot.profiles,
      // The active cycle's own persisted routes are not prior round-robin history (as the supervisor's readiness check).
      ...(cycle ? { excludeCycleId: cycle.id } : {}),
    });
    const workflows = stored.definition.routing.workflows;
    const workflowFor: Partial<Record<GoalRole, string>> = {
      orchestrator: workflows.planning,
      implementer: workflows.execution,
    };
    const roles: NonNullable<GoalPreview['routing']>['roles'] = [];
    for (const role of READINESS_ROLES) {
      try {
        const billingTerms = workflowBillingTerms(
          registeredGoalWorkflow(db, workflowFor[role] ?? workflows.execution),
        );
        const { result } = previewGoalRoutes(db, {
          goalId,
          environment,
          roles: [role],
          billing: billingTerms,
          // The active cycle's persisted routes are re-proven, never recomputed.
          ...(cycle ? { cycleId: cycle.id } : {}),
        });
        const outcome = result.roles[role];
        if (!outcome) roles.push({ role, status: 'refused', code: 'route_not_defined' });
        else if (outcome.status === 'resolved')
          roles.push({
            role,
            status: 'resolved',
            source: outcome.source,
            selection: summariseResolution(outcome.resolution) as GoalRouteResolutionSummary,
          });
        else roles.push({ role, status: 'refused', code: outcome.code });
      } catch (error) {
        if (error instanceof RouteResolutionError) roles.push({ role, status: 'refused', code: error.code });
        else if (error instanceof TuringExecutorError)
          roles.push({ role, status: 'refused', code: error.code });
        else throw error;
      }
    }
    routing = { observation: 'stored', ok: roles.every((entry) => entry.status === 'resolved'), roles };
  }

  const detail = (() => {
    try {
      return goal.status_detail_json && goal.status_detail_json.length <= 4_000
        ? (JSON.parse(goal.status_detail_json) as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  })();
  return {
    goalId,
    status: goal.status,
    reasonCode: goal.status_reason_code,
    definition: stored ? { version: stored.version, definitionHash: stored.definitionHash } : null,
    activeMilestone: milestoneRow
      ? {
          key: milestoneRow.key,
          title:
            stored?.definition.milestones.find((spec) => spec.key === milestoneRow.key)?.title ??
            milestoneRow.key,
        }
      : null,
    runtime: runtimeView,
    limits,
    integration: {
      branch: runtime?.goal_branch ?? null,
      head: runtime?.integration_head ?? null,
      tree: repository?.ok ? repository.state.tree : null,
    },
    currentCycle: cycle
      ? {
          id: cycle.id,
          sequence: cycle.sequence,
          kind: cycle.kind,
          status: cycle.status,
          triggerCode: cycle.triggerCode,
          finishedAt: cycle.finishedAt,
          milestoneKey: cycle.milestoneKey,
        }
      : null,
    routing,
    billing,
    proposalRequired: proposalRequired(goal.status, cycle),
    task: taskView(cycle?.validatedTask ?? null),
    completion,
    blockers: evaluation?.failures ?? [],
    pendingApprovals: pendingApprovalViews(db, goalId),
    openFindingCounts: openFindingCounts(db, goalId),
    nextAction: deriveNextAction(
      db,
      goalId,
      { status: goal.status, reasonCode: goal.status_reason_code, detail },
      completion,
    ),
  };
}
