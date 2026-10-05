import type { NextTask } from '../../shared/goals.js';
import {
  goalBuiltinById,
  GOAL_PROPOSE_STAGE_KEY,
  GOAL_WORKFLOW_IDS,
  isReservedGoalWorkflowId,
} from '../../shared/goalWorkflows.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import { isModelBackedStage } from '../../shared/workflowKinds.js';
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
  VerificationRunRequest,
} from './executor.js';
import { applyGoalScope, formatExecutionTask, formatPlanningTask } from './goalPrompts.js';
import { rebuildGoalMemory } from './memory.js';
import type { GoalRunPlanProvider } from './runPlan.js';
import { normalizeVerifierDigests } from './verifierDigest.js';
import {
  materializeVerification,
  milestoneDeterministicVerifiers,
  parseVerificationStageId,
  verificationWorkflow,
} from './verification.js';

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
  | 'preview_not_startable'
  | 'verification_invalid'
  | 'verification_unmaterializable'
  | 'verification_inputs_mismatch'
  | 'verification_run_inconsistent';

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
/**
 * The only stage properties a run plan may set or change, and only on model-backed stages: the concrete route.
 * `modelSnapshot` is deliberately absent: it is observed metadata produced by the preview/catalog path, never plan
 * authority, so a plan that carries or changes one is refused like any other non-route difference.
 */
export const PLAN_ROUTE_FIELDS = [
  'backendId',
  'providerId',
  'billingLane',
  'modelId',
  'reasoning',
  'connectionProfileId',
  'modelDisplayName',
  'variantId',
  'nativeSettings',
] as const;

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;

/**
 * The single comparison a run plan is held to: everything about a workflow except `createdAt`/`updatedAt` and the
 * route fields of model-backed stages. Deterministic stages keep every property, so a route field added to one differs.
 */
export function canonicalNonRouteWorkflow(workflow: WorkflowDefinition): string {
  const { createdAt: _created, updatedAt: _updated, ...rest } = workflow;
  void _created;
  void _updated;
  return JSON.stringify(
    stable({
      ...rest,
      stages: workflow.stages.map((stage) => {
        if (!isModelBackedStage(stage.kind)) return stage;
        const copy: Record<string, unknown> = { ...stage };
        for (const key of PLAN_ROUTE_FIELDS) delete copy[key];
        return copy;
      }),
    }),
  );
}

/** The registered workflow row; a reserved Goal id that differs from Turing's built-in definition is refused. */
export function registeredGoalWorkflow(db: Db, workflowId: string): WorkflowDefinition {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as
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

  /**
   * The idempotent fast path. A persisted `(cycle, purpose)` run is returned only after the cheap persisted authority
   * is re-proven (Goal owns the cycle, the definition is current, the base is the cycle base, and for child runs the
   * caller's task is still the cycle's validated task). It never asks the plan provider again.
   */
  private existing(
    goalId: string,
    cycleId: string,
    purpose: string,
    baseCommit: string,
    task?: NextTask,
    definitionVersion?: number,
  ): string | undefined {
    const row = this.db
      .prepare(
        'SELECT id, goal_cycle_id, goal_run_purpose FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = ?',
      )
      .get(cycleId, purpose) as { id: string; goal_cycle_id: string; goal_run_purpose: string } | undefined;
    if (!row) return undefined;
    const goal = this.db
      .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
      .get(goalId) as { version: number | null } | undefined;
    if (!goal) throw new TuringExecutorError('goal_not_found', 'The Goal does not exist.');
    const cycle = getCycle(this.db, cycleId);
    if (!cycle || cycle.goalId !== goalId)
      throw new TuringExecutorError('cycle_goal_mismatch', 'The cycle belongs to another Goal.');
    if (cycle.definitionVersion === null || cycle.definitionVersion !== goal.version)
      throw new TuringExecutorError('definition_superseded', 'The cycle belongs to an older definition.');
    if (definitionVersion !== undefined && definitionVersion !== cycle.definitionVersion)
      throw new TuringExecutorError(
        'definition_mismatch',
        'The requested definition is not the cycle definition.',
      );
    if (!cycle.baseIntegrationCommit || cycle.baseIntegrationCommit !== baseCommit)
      throw new TuringExecutorError(
        'base_commit_mismatch',
        'The requested base is not the cycle base commit.',
      );
    if (task && (!cycle.validatedTask || JSON.stringify(cycle.validatedTask) !== JSON.stringify(task)))
      throw new TuringExecutorError('task_mismatch', "The task is not the cycle's validated task.");
    return row.id;
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
    return registeredGoalWorkflow(this.db, workflowId);
  }

  /**
   * A plan is the registered workflow plus exact routes on model-backed stages, and nothing else. The specific refusals
   * come first for stable codes; the canonical comparison then closes every remaining property. Goal parallelism is a
   * Turing-side clamp applied only after the plan has been proven identical.
   */
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
    if (plan.permissionMode === 'enigma' || plan.permissionMode !== registered.permissionMode)
      throw new TuringExecutorError(
        'plan_permission_mode',
        'The run plan changes the registered workflow permission mode.',
      );
    const modeOf = (workflow: WorkflowDefinition) =>
      workflow.billingMode ?? (workflow.subscriptionOnly === false ? 'custom' : 'subscriptions-only');
    if (
      MODE_RANK[modeOf(plan)] > MODE_RANK[definition.limits.billingMode] ||
      MODE_RANK[modeOf(registered)] > MODE_RANK[definition.limits.billingMode]
    )
      throw new TuringExecutorError(
        'plan_billing_exceeds_goal',
        'The workflow or run plan is more permissive in billing than the approved Goal.',
      );
    if (canonicalNonRouteWorkflow(plan) !== canonicalNonRouteWorkflow(registered))
      throw new TuringExecutorError(
        'plan_workflow_mismatch',
        'The run plan changes more than the route fields of model-backed stages.',
      );
    const effective = Math.max(
      1,
      Math.min(registered.maxParallelAgents, definition.limits.maxParallelAgents),
    );
    return {
      ...plan,
      maxParallelAgents: effective,
      stages: plan.stages.map((stage) =>
        stage.kind === 'parallelReview'
          ? { ...stage, parallelism: Math.min(stage.parallelism ?? 1, effective) }
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
    const verified = applyGoalScope(
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
    const already = this.existing(
      request.goalId,
      request.cycleId,
      'proposal',
      request.baseCommit,
      undefined,
      request.definitionVersion,
    );
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
    const already = this.existing(
      request.goalId,
      request.cycleId,
      request.purpose,
      request.baseCommit,
      request.task,
    );
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

  /**
   * Queues the deterministic verification run of a verification cycle. The workflow is the registered, verified
   * `goal-verification-v1` with its stages replaced by `materializeVerifierStage` output for the requested verifiers
   * (each a required build/test/lint verifier of the cycle's milestone). No plan provider, route, model or provider is
   * involved, and every command is re-checked as a safe project command here.
   */
  /**
   * The idempotent fast path of a verification run. Before an existing run is returned, everything the caller supplied
   * is re-proven against persisted authority: the Goal owns the cycle, it is a verification cycle of the current
   * definition and milestone at the requested base, the requested set (normalised) equals the set persisted on the
   * cycle, every member is a required deterministic verifier of that milestone, and the run's `gv-<digest>` stages are
   * exactly that set. Any inconsistency fails closed; nothing is created or changed.
   */
  private existingVerification(request: VerificationRunRequest): string | undefined {
    const already = this.existing(request.goalId, request.cycleId, 'verification', request.baseCommit);
    if (!already) return undefined;
    const cycle = getCycle(this.db, request.cycleId)!;
    const goal = this.db
      .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
      .get(request.goalId) as { version: number | null };
    const definition =
      goal.version === null
        ? undefined
        : loadDefinitionVersion(this.db, request.goalId, goal.version)?.definition;
    if (cycle.kind !== 'verification' || !cycle.milestoneKey || !cycle.milestoneId || !definition)
      throw new TuringExecutorError('verification_invalid', 'The cycle is not a verification cycle.');
    const owned = this.db
      .prepare('SELECT 1 FROM goal_milestones WHERE goal_id = ? AND id = ? AND milestone_key = ?')
      .get(request.goalId, cycle.milestoneId, cycle.milestoneKey);
    if (!owned || !definition.milestones.some((milestone) => milestone.key === cycle.milestoneKey))
      throw new TuringExecutorError('definition_mismatch', 'The cycle milestone is not current.');
    const requested = normalizeVerifierDigests(request.verifierDigests);
    const persisted = normalizeVerifierDigests(cycle.outcome?.verifierDigests);
    if (!requested || !persisted || JSON.stringify(requested) !== JSON.stringify(persisted))
      throw new TuringExecutorError(
        'verification_inputs_mismatch',
        "The requested verifiers are not the cycle's verifier set.",
      );
    const allowed = new Set(
      milestoneDeterministicVerifiers(definition, cycle.milestoneKey).map((verifier) => verifier.digest),
    );
    if (requested.some((digest) => !allowed.has(digest)))
      throw new TuringExecutorError(
        'verification_invalid',
        'A requested verifier is not a required deterministic verifier of the cycle milestone.',
      );
    const stages = (
      this.db.prepare('SELECT stage_key FROM stages WHERE run_id = ?').all(already) as Array<{
        stage_key: string;
      }>
    )
      .map((row) => parseVerificationStageId(row.stage_key))
      .sort();
    const expected = requested.map((digest) => digest);
    const stageCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM stages WHERE run_id = ?').get(already) as { n: number }
    ).n;
    if (stages.length !== stageCount || JSON.stringify(stages) !== JSON.stringify(expected))
      throw new TuringExecutorError(
        'verification_run_inconsistent',
        "The existing run does not match the cycle's verifier set.",
      );
    return already;
  }

  async queueVerificationRun(request: VerificationRunRequest): Promise<{ runId: string }> {
    const existing = this.existingVerification(request);
    if (existing) return { runId: existing };
    const loaded = this.load(request.goalId, request.cycleId, request.baseCommit);
    if (loaded.cycle.kind !== 'verification' || !loaded.cycle.milestoneKey)
      throw new TuringExecutorError('verification_invalid', 'The cycle is not a verification cycle.');
    const allowed = milestoneDeterministicVerifiers(loaded.definition, loaded.cycle.milestoneKey);
    const digests = normalizeVerifierDigests(request.verifierDigests);
    const requested = (digests ?? []).map((digest) => allowed.find((verifier) => verifier.digest === digest));
    if (!digests || requested.some((verifier) => !verifier))
      throw new TuringExecutorError(
        'verification_invalid',
        'A requested verifier is not a required deterministic verifier of the cycle milestone.',
      );
    // The cycle's persisted verifier set is the authorisation: it must exist and the request must be exactly it.
    const persisted = normalizeVerifierDigests(loaded.cycle.outcome?.verifierDigests);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(digests))
      throw new TuringExecutorError(
        'verification_inputs_mismatch',
        "The requested verifiers are not the cycle's verifier set.",
      );
    const registered = this.registeredWorkflow(GOAL_WORKFLOW_IDS.verification);
    if (registered.stages.some((stage) => isModelBackedStage(stage.kind)) || !registered.isolatedWorktree)
      throw new TuringExecutorError(
        'plan_workflow_mismatch',
        'The verification workflow must be deterministic and isolated.',
      );
    const materialized = materializeVerification(
      this.db,
      loaded.projectId,
      requested as NonNullable<(typeof requested)[number]>[],
    );
    if (!materialized.ok)
      throw new TuringExecutorError(
        'verification_unmaterializable',
        `${materialized.code}: ${materialized.verifier.kind} verifier of ${materialized.verifier.criterionKey}`.slice(
          0,
          300,
        ),
      );
    const preview = await buildPreview(
      this.db,
      {
        task: `Verify the Goal head with ${materialized.stages.length} deterministic verifier(s).`,
        projectId: loaded.projectId,
        workflowId: registered.id,
      },
      verificationWorkflow(registered, materialized.stages),
      { origin: createRunOrigin(loaded.cycle.id, 'verification', request.baseCommit) },
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
