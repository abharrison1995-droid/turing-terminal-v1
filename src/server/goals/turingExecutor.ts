import type { NextTask } from '../../shared/goals.js';
import {
  goalBuiltinById,
  GOAL_PROPOSE_STAGE_KEY,
  isReservedGoalWorkflowId,
} from '../../shared/goalWorkflows.js';
import type { WorkflowDefinition, WorkflowStage } from '../../shared/types.js';
import { canonicalGoalBuiltin, canonicalStoredWorkflow } from '../db.js';
import type { Db } from '../db.js';
import { buildPreview, createRunOrigin, queueRun } from '../runLauncher.js';
import { toWorkflow } from '../serialize.js';
import { getCycle, type CycleRow } from './cycles.js';
import { loadDefinitionVersion } from './definitions.js';
import type {
  ChildRunRequest,
  GoalExecutor,
  ProposalRequest,
  ProposalResult,
  RouteReadiness,
} from './executor.js';
import { formatExecutionTask, formatPlanningTask, narrowWorkflowToMilestone } from './goalPrompts.js';
import { rebuildGoalMemory } from './memory.js';
import type { GoalRunPlanProvider } from './runPlan.js';

/** Stable, bounded failure codes. The supervisor records a queue failure as a bounded failed cycle. */
export type TuringExecutorErrorCode =
  | 'goal_not_found'
  | 'cycle_not_found'
  | 'cycle_goal_mismatch'
  | 'cycle_terminal'
  | 'definition_mismatch'
  | 'definition_superseded'
  | 'base_commit_mismatch'
  | 'task_mismatch'
  | 'workflow_not_found'
  | 'reserved_workflow_conflict'
  | 'plan_unavailable'
  | 'plan_workflow_mismatch'
  | 'plan_not_isolated'
  | 'plan_forbidden_stage'
  | 'plan_permission_mode'
  | 'plan_billing_exceeds_goal'
  | 'preview_unavailable'
  | 'preview_not_startable';

export class TuringExecutorError extends Error {
  constructor(
    readonly code: TuringExecutorErrorCode | string,
    message: string,
  ) {
    super(message);
    this.name = 'TuringExecutorError';
  }
}

/** Bounds the persisted output read back as a proposal, before any JSON parsing. */
export const PROPOSAL_LIMITS = { outputJsonChars: 80_000, textChars: 40_000 } as const;

const MODE_RANK = { 'subscriptions-only': 0, 'subscriptions-plus-decision-budget': 1, custom: 2 } as const;
const FORBIDDEN_STAGES = new Set(['gitMerge', 'gitPush', 'gitRollback']);
/** Fields a run plan may fill in: the concrete route. Everything else must equal the registered workflow. */
const ROUTE_FIELDS = [
  'backendId',
  'providerId',
  'modelId',
  'reasoning',
  'connectionProfileId',
  'modelDisplayName',
  'variantId',
  'nativeSettings',
  'modelSnapshot',
  'billingLane',
] as const;

const withoutRoute = (stage: WorkflowStage): string => {
  const copy: Record<string, unknown> = { ...stage };
  for (const key of ROUTE_FIELDS) delete copy[key];
  return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b))));
};

interface Loaded {
  goalId: string;
  projectId: string;
  cycle: CycleRow;
  definition: NonNullable<ReturnType<typeof loadDefinitionVersion>>['definition'];
}

/**
 * The real, run-backed Goal executor. It turns a Goal cycle into an ordinary persisted run through the same
 * `buildPreview` → `queueRun` path every run uses, with a trusted RunOrigin. It never starts a run (the supervisor
 * does, once), never receives the RunEngine, never reads provider output except the persisted planning stage, and
 * never selects a route: a `GoalRunPlanProvider` supplies the already-concrete workflow.
 *
 * Stage 4A does not wire this into production; `src/server/index.ts` keeps `DisabledGoalExecutor` until Stage 5.
 */
export class TuringGoalExecutor implements GoalExecutor {
  readonly id = 'turing';

  constructor(
    private readonly db: Db,
    private readonly plans: GoalRunPlanProvider,
  ) {}

  checkRoutes(goalId: string): Promise<RouteReadiness> {
    return this.plans.checkRoutes(goalId);
  }

  private existing(cycleId: string, purpose: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = ?')
      .get(cycleId, purpose) as { id: string } | undefined;
    return row?.id;
  }

  private load(goalId: string, cycleId: string, baseCommit: string): Loaded {
    const goal = this.db
      .prepare('SELECT id, project_id, current_definition_version AS version FROM goals WHERE id = ?')
      .get(goalId) as { id: string; project_id: string; version: number | null } | undefined;
    if (!goal) throw new TuringExecutorError('goal_not_found', 'The Goal does not exist.');
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new TuringExecutorError('cycle_not_found', 'The cycle does not exist.');
    if (cycle.goalId !== goalId)
      throw new TuringExecutorError('cycle_goal_mismatch', 'The cycle belongs to another Goal.');
    if (['succeeded', 'failed', 'cancelled', 'rejected'].includes(cycle.status))
      throw new TuringExecutorError('cycle_terminal', 'The cycle has already finished.');
    if (cycle.definitionVersion === null)
      throw new TuringExecutorError('definition_mismatch', 'The cycle has no definition version.');
    if (cycle.definitionVersion !== goal.version)
      throw new TuringExecutorError('definition_superseded', 'The cycle belongs to an older definition.');
    if (!cycle.baseIntegrationCommit || cycle.baseIntegrationCommit !== baseCommit)
      throw new TuringExecutorError(
        'base_commit_mismatch',
        'The requested base is not the cycle base commit.',
      );
    const definition = loadDefinitionVersion(this.db, goalId, cycle.definitionVersion)?.definition;
    if (!definition || definition.milestones.length === 0)
      throw new TuringExecutorError('definition_mismatch', 'The approved definition is unavailable.');
    return { goalId, projectId: goal.project_id, cycle, definition };
  }

  /** The registered workflow row for a purpose; a reserved id that differs from Turing's built-in is refused. */
  private registeredWorkflow(workflowId: string): WorkflowDefinition {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as
      Record<string, unknown> | undefined;
    if (!row)
      throw new TuringExecutorError('workflow_not_found', `Workflow "${workflowId}" is not registered.`);
    if (isReservedGoalWorkflowId(workflowId)) {
      const expected = goalBuiltinById(workflowId);
      if (!expected || canonicalStoredWorkflow(row) !== canonicalGoalBuiltin(expected))
        throw new TuringExecutorError(
          'reserved_workflow_conflict',
          `Reserved Goal workflow "${workflowId}" differs from Turing's built-in definition.`,
        );
    }
    return toWorkflow(row);
  }

  /** The plan must be the registered workflow plus routes, never a different or more permissive workflow. */
  private verifyPlan(
    plan: WorkflowDefinition,
    registered: WorkflowDefinition,
    definition: Loaded['definition'],
  ): WorkflowDefinition {
    if (plan.id !== registered.id)
      throw new TuringExecutorError('plan_workflow_mismatch', 'The run plan is for a different workflow.');
    if (!plan.isolatedWorktree || !registered.isolatedWorktree)
      throw new TuringExecutorError('plan_not_isolated', 'Goal runs require an isolated worktree workflow.');
    if (plan.stages.some((stage) => FORBIDDEN_STAGES.has(stage.kind)))
      throw new TuringExecutorError(
        'plan_forbidden_stage',
        'Goal workflows cannot merge, push or roll back.',
      );
    if (
      plan.permissionMode === 'enigma' ||
      plan.permissionMode !== registered.permissionMode ||
      plan.executionProfile !== registered.executionProfile ||
      plan.maxRemediationRounds !== registered.maxRemediationRounds ||
      plan.promptRefinementDefault !== registered.promptRefinementDefault
    )
      throw new TuringExecutorError(
        'plan_permission_mode',
        'The run plan changes the registered workflow permission mode or behaviour.',
      );
    const planMode = plan.billingMode ?? (plan.subscriptionOnly === false ? 'custom' : 'subscriptions-only');
    if (MODE_RANK[planMode] > MODE_RANK[definition.limits.billingMode])
      throw new TuringExecutorError(
        'plan_billing_exceeds_goal',
        'The run plan is more permissive in billing than the approved Goal.',
      );
    if (
      plan.stages.length !== registered.stages.length ||
      plan.stages.some((stage, index) => withoutRoute(stage) !== withoutRoute(registered.stages[index]!))
    )
      throw new TuringExecutorError(
        'plan_workflow_mismatch',
        'The run plan changes the registered workflow stages.',
      );
    // Deterministic parallelism clamp: the plan can never exceed the approved Goal.
    const maxParallelAgents = Math.max(
      1,
      Math.min(plan.maxParallelAgents, definition.limits.maxParallelAgents),
    );
    return {
      ...plan,
      maxParallelAgents,
      stages: plan.stages.map((stage) =>
        stage.kind === 'parallelReview'
          ? { ...stage, parallelism: Math.min(stage.parallelism ?? 1, maxParallelAgents) }
          : stage,
      ),
    };
  }

  private async queue(
    loaded: Loaded,
    purpose: 'proposal' | 'execution' | 'remediation',
    workflowId: string,
    baseCommit: string,
    taskText: string,
    task: NextTask | undefined,
  ): Promise<{ runId: string }> {
    const registered = this.registeredWorkflow(workflowId);
    const plan = await this.plans.planRun({
      goalId: loaded.goalId,
      cycleId: loaded.cycle.id,
      purpose,
      definitionVersion: loaded.cycle.definitionVersion!,
      workflowId,
      baseCommit,
      ...(task ? { task } : {}),
    });
    if (!plan.ready)
      throw new TuringExecutorError('plan_unavailable', `${plan.code}: ${plan.message}`.slice(0, 300));
    const milestone = loaded.definition.milestones.find((item) => item.key === loaded.cycle.milestoneKey);
    if (!milestone)
      throw new TuringExecutorError('definition_mismatch', 'The cycle milestone is not in the definition.');
    const verified = narrowWorkflowToMilestone(
      this.verifyPlan(plan.workflowOverride, registered, loaded.definition),
      milestone.allowedScope,
    );
    // No billing, mode, budget or lane field is passed: effective authority stays the stricter of Goal, plan and the
    // existing desktop budget, evaluated by buildPreview exactly as for any run.
    const preview = await buildPreview(
      this.db,
      { task: taskText, projectId: loaded.projectId, workflowId },
      verified,
      { origin: createRunOrigin(loaded.cycle.id, purpose, baseCommit) },
    );
    if (!preview)
      throw new TuringExecutorError('preview_unavailable', 'The project or workflow is not registered.');
    if (!preview.canStart)
      throw new TuringExecutorError(
        'preview_not_startable',
        `The run preview refused to start: ${preview.warnings.slice(0, 3).join(' | ')}`.slice(0, 400),
      );
    return { runId: queueRun(this.db, preview).runId };
  }

  async queueProposalRun(request: ProposalRequest): Promise<{ runId: string }> {
    const already = this.existing(request.cycleId, 'proposal');
    if (already) return { runId: already };
    const loaded = this.load(request.goalId, request.cycleId, request.baseCommit);
    if (loaded.cycle.definitionVersion !== request.definitionVersion)
      throw new TuringExecutorError(
        'definition_mismatch',
        'The requested definition is not the cycle definition.',
      );
    const milestone = loaded.definition.milestones.find((item) => item.key === request.milestone.key);
    if (!milestone)
      throw new TuringExecutorError('definition_mismatch', 'The milestone is not in the definition.');
    const text = formatPlanningTask({
      definition: loaded.definition,
      milestone,
      memory: request.memory,
    });
    return this.queue(
      loaded,
      'proposal',
      loaded.definition.routing.workflows.planning,
      request.baseCommit,
      text,
      undefined,
    );
  }

  async queueChildRun(request: ChildRunRequest): Promise<{ runId: string }> {
    const already = this.existing(request.cycleId, request.purpose);
    if (already) return { runId: already };
    const loaded = this.load(request.goalId, request.cycleId, request.baseCommit);
    if (
      !loaded.cycle.validatedTask ||
      JSON.stringify(loaded.cycle.validatedTask) !== JSON.stringify(request.task)
    )
      throw new TuringExecutorError('task_mismatch', "The task is not the cycle's validated task.");
    const milestone = loaded.definition.milestones.find((item) => item.key === request.task.milestoneKey);
    if (!milestone || milestone.key !== loaded.cycle.milestoneKey)
      throw new TuringExecutorError('definition_mismatch', 'The task milestone is not the cycle milestone.');
    const workflowId = loaded.definition.routing.workflows.execution;
    if (request.task.workflowId !== undefined && request.task.workflowId !== workflowId)
      throw new TuringExecutorError(
        'task_mismatch',
        'The task names a workflow the definition does not permit.',
      );
    const text = formatExecutionTask({
      definition: loaded.definition,
      milestone,
      task: request.task,
      memory: rebuildGoalMemory(this.db, request.goalId),
      purpose: request.purpose,
    });
    return this.queue(loaded, request.purpose, workflowId, request.baseCommit, text, request.task);
  }

  async readProposal(runId: string): Promise<ProposalResult> {
    const run = this.db
      .prepare('SELECT status, goal_cycle_id, goal_run_purpose FROM runs WHERE id = ?')
      .get(runId) as
      { status: string; goal_cycle_id: string | null; goal_run_purpose: string | null } | undefined;
    if (!run || run.goal_run_purpose !== 'proposal' || !run.goal_cycle_id || run.status !== 'completed')
      return { ok: false, code: 'proposal_run_invalid' };
    const stage = this.db
      .prepare(
        "SELECT output_json FROM stages WHERE run_id = ? AND stage_key = ? AND kind = 'planner' AND status = 'passed'",
      )
      .get(runId, GOAL_PROPOSE_STAGE_KEY) as { output_json: string | null } | undefined;
    if (!stage?.output_json) return { ok: false, code: 'proposal_output_missing' };
    if (stage.output_json.length > PROPOSAL_LIMITS.outputJsonChars)
      return { ok: false, code: 'proposal_output_invalid' };
    let text: unknown;
    try {
      text = (JSON.parse(stage.output_json) as { text?: unknown }).text;
    } catch {
      return { ok: false, code: 'proposal_output_invalid' };
    }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'proposal_output_missing' };
    if (text.length > PROPOSAL_LIMITS.textChars) return { ok: false, code: 'proposal_output_invalid' };
    try {
      return { ok: true, proposal: JSON.parse(text.trim()) as unknown };
    } catch {
      return { ok: false, code: 'proposal_output_invalid' };
    }
  }
}
