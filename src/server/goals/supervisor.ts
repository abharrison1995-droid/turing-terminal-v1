import type { GoalMilestoneSpec, MilestoneEvaluation } from '../../shared/goals.js';
import type { Db } from '../db.js';
import {
  advanceGoalRef,
  changedEntries,
  changedPathSet,
  GoalGitError,
  gitTry,
  loadContext,
  recoverIntegrationOps,
  verifyGoalRef,
} from '../goalGit.js';
import { getGoalApproval, pendingGoalApprovals, requestGoalApproval } from './approvals.js';
import { ActiveTimeTracker } from './activeTime.js';
import { enforceBounds } from './bounds.js';
import { completeGoal } from './completion.js';
import {
  activeCycle,
  createCycle,
  CycleError,
  finalizeCycle,
  reconcileCounters,
  transitionCycle,
  type CycleRow,
} from './cycles.js';
import { loadDefinitionVersion } from './definitions.js';
import type { GoalExecutor, GoalRunPurpose } from './executor.js';
import { evaluateCriteria } from './freshness.js';
import { rebuildGoalMemory } from './memory.js';
import { evaluateMilestones, syncMilestoneRuntime } from './milestones.js';
import { validateNextTask } from './nextTask.js';
import { runPreflight, type PreflightFailureCode } from './preflight.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';
import { pathInMilestoneScope, scopePrefixes } from './scope.js';
import { transitionGoal } from './stateMachine.js';
import type { GoalActor, GoalReasonCode } from '../../shared/goals.js';

/**
 * The Goal supervisor core (design 8.3, 12). `tickGoal` performs at most one meaningful persisted action for a Goal and
 * returns it; there is no loop and no recursion, so a run of ticks is a run of small, individually recoverable steps.
 * Work itself is delegated to an injected `GoalExecutor`; production wires a disabled one.
 */
export const TICK_ACTIONS = [
  'not_found',
  'busy',
  'shutting_down',
  'idle',
  'waiting_gate',
  'gate_requested',
  'gate_denied',
  'resumed',
  'preflight_failed',
  'bound_blocked',
  'ref_blocked',
  'cycle_created',
  'proposal_started',
  'proposal_queued',
  'proposal_run_started',
  'waiting_for_proposal',
  'proposal_recorded',
  'proposal_rejected',
  'launch_started',
  'run_queued',
  'run_started',
  'waiting_for_run',
  'run_interrupted',
  'collection_started',
  'integration_started',
  'cycle_succeeded',
  'cycle_failed',
  'integration_blocked',
  'completed',
  'completion_pending',
] as const;
export type TickAction = (typeof TICK_ACTIONS)[number];

export interface TickResult {
  action: TickAction;
  goalId: string;
  cycleId?: string;
  /** Machine-readable code for refusals and failures (a reason or outcome code). */
  code?: string;
}

/** The structured result of starting a persisted queued run; production returns `startQueuedRun`'s result as is. */
export type StartRunResult =
  { started: true } | { started: false; reason: 'not-found' | 'not-queued' | 'already-active' };

export interface GoalSupervisorDeps {
  db: Db;
  executor: GoalExecutor;
  /** Starts a persisted queued run (production: `startQueuedRun(db, engine, runId)`); the result is never discarded. */
  startRun: (runId: string) => StartRunResult;
  /** Resumes a paused run (production: `engine.start(runId, true)`). Called only after the Goal owns `running`. */
  resumeRun: (runId: string) => void | Promise<void>;
  activeTime?: ActiveTimeTracker;
  now?: () => string;
}

const ACTIVE_RUN = new Set([
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'retrying',
  'cancelling',
]);
const PAUSED_RUN = new Set(['paused', 'paused_limit_reached']);
const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);
const FAILED_RUN = new Set(['failed']);
const CANCELLED_RUN = new Set(['cancelled']);

interface RunRow {
  id: string;
  status: string;
  branch: string | null;
  summary: string | null;
}

export class GoalSupervisor {
  private readonly db: Db;
  private readonly executor: GoalExecutor;
  private readonly tracker: ActiveTimeTracker;
  private readonly ticking = new Set<string>();
  private shuttingDown = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: GoalSupervisorDeps) {
    this.db = deps.db;
    this.executor = deps.executor;
    this.tracker = deps.activeTime ?? new ActiveTimeTracker(deps.db);
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  // --- Scheduling -----------------------------------------------------------------------------------------------

  /** Setting `goal_max_running` (default 1): the global number of Goals that may be running at once. */
  maxRunning(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'goal_max_running'").get() as
      { value: string } | undefined;
    const value = Number.parseInt(row?.value ?? '', 10);
    return Number.isInteger(value) && value >= 1 ? Math.min(value, 8) : 1;
  }

  private runningGoals(): Array<{ id: string }> {
    return this.db
      .prepare("SELECT id FROM goals WHERE status IN ('running','reviewing') ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
  }

  /**
   * One scheduling pass: ticks each running Goal once in a deterministic order (created_at, then id), within the
   * global running limit. Blocked, paused and needs_user Goals take no slot and are not ticked here.
   */
  async runOnce(): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (const { id } of this.runningGoals().slice(0, this.maxRunning()))
      results.push(await this.tickGoal(id));
    return results;
  }

  /** Starts the periodic scheduler. Overlapping passes are skipped. */
  start(intervalMs = 5_000): void {
    if (this.timer || this.shuttingDown) return;
    this.timer = setInterval(() => {
      if (this.running || this.shuttingDown) return;
      this.running = true;
      void this.runOnce()
        .catch(() => undefined)
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  // --- Start / resume (user-driven services; the future API calls these) -------------------------------------------

  /**
   * ready/needs_user/blocked/paused -> running: scheduler slot, the full preflight, then the state machine edge with
   * the preflight precondition. On any failure nothing changes.
   */
  async resumeGoal(
    goalId: string,
    options: {
      actor: GoalActor;
      reasonCode: Extract<
        GoalReasonCode,
        | 'user_start'
        | 'user_resume'
        | 'gate_resolved'
        | 'run_resumed'
        | 'blocker_resolved'
        | 'amendment_approved'
        | 'amendment_discarded'
      >;
    },
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code:
          PreflightFailureCode | 'scheduler_full' | 'transition_refused' | 'no_paused_run' | 'resume_failed';
      }
  > {
    const goal = this.db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
      { status: string } | undefined;
    if (!goal) return { ok: false, code: 'goal_not_found' };
    if (this.runningGoals().filter((candidate) => candidate.id !== goalId).length >= this.maxRunning())
      return { ok: false, code: 'scheduler_full' };
    // Identify the interrupted run first, without touching it. With no paused Goal run there is nothing to resume.
    const paused = options.reasonCode === 'run_resumed' ? this.interruptedRun(goalId) : undefined;
    if (options.reasonCode === 'run_resumed' && !paused) return { ok: false, code: 'no_paused_run' };
    const preflight = await runPreflight(this.db, goalId, { executor: this.executor, now: this.now() });
    if (!preflight.ok) return { ok: false, code: preflight.code };
    try {
      transitionGoal(this.db, {
        goalId,
        to: 'running',
        reasonCode: options.reasonCode,
        actor: options.actor,
        preconditions: [{ code: 'preflight', ok: true }],
        now: this.now(),
      });
    } catch {
      return { ok: false, code: 'transition_refused' };
    }
    this.tracker.sync(goalId);
    // Provider work resumes only after the Goal owns `running`, and only that exact run is resumed.
    const run = paused ? this.runById(paused.id) : undefined;
    if (run && PAUSED_RUN.has(run.status)) {
      try {
        await this.deps.resumeRun(run.id);
      } catch (error) {
        this.restoreInterrupted(goalId, run.id, error);
        return { ok: false, code: 'resume_failed' };
      }
    }
    return { ok: true };
  }

  startGoal(goalId: string) {
    return this.resumeGoal(goalId, { actor: 'user', reasonCode: 'user_start' });
  }

  /** The paused run of the active cycle's current phase (proposal before launch, execution/remediation after). */
  private interruptedRun(goalId: string): RunRow | undefined {
    const cycle = activeCycle(this.db, goalId);
    const run = cycle ? this.runForPurpose(cycle.id, this.currentPurpose(cycle)) : undefined;
    return run && PAUSED_RUN.has(run.status) ? run : undefined;
  }

  /** A resume that failed after the Goal transitioned: hand the Goal back to the user with bounded detail. */
  private restoreInterrupted(goalId: string, runId: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    try {
      transitionGoal(this.db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'run_interrupted',
        actor: 'supervisor',
        detail: { runId, resumeError: message },
        now: this.now(),
      });
    } catch {
      // The Goal already left `running` (for example a bound or a user action); there is nothing to restore.
    }
    this.tracker.sync(goalId);
  }

  // --- Tick ------------------------------------------------------------------------------------------------------

  async tickGoal(goalId: string): Promise<TickResult> {
    if (this.shuttingDown) return { action: 'shutting_down', goalId };
    if (this.ticking.has(goalId)) return { action: 'busy', goalId };
    this.ticking.add(goalId);
    try {
      return await this.tick(goalId);
    } finally {
      this.ticking.delete(goalId);
    }
  }

  private async tick(goalId: string): Promise<TickResult> {
    const goal = this.db
      .prepare('SELECT status, status_reason_code, status_detail_json FROM goals WHERE id = ?')
      .get(goalId) as
      { status: string; status_reason_code: string | null; status_detail_json: string | null } | undefined;
    if (!goal) return { action: 'not_found', goalId };
    this.tracker.sync(goalId);
    this.tracker.maybeFlush(goalId);
    if (goal.status === 'needs_user') return this.tickNeedsUser(goalId, goal);
    if (goal.status !== 'running') return { action: 'idle', goalId };
    const cycle = activeCycle(this.db, goalId);
    return cycle ? this.tickCycle(goalId, cycle) : this.tickNoCycle(goalId);
  }

  // --- Human gates ----------------------------------------------------------------------------------------------

  private approvalIdOf(detailJson: string | null): string | null {
    try {
      const detail = detailJson ? (JSON.parse(detailJson) as { approvalId?: unknown }) : {};
      return typeof detail.approvalId === 'string' ? detail.approvalId : null;
    } catch {
      return null;
    }
  }

  /**
   * Requests a gate in one transaction with the `running -> needs_user(gate_pending)` edge. At most one pending approval
   * exists per exact action: an equal pending request is reused, never duplicated.
   */
  private requestGate(
    goalId: string,
    gate: 'each_cycle' | 'milestone_complete',
    action: Record<string, unknown>,
    reason: string,
  ): string {
    return this.db.transaction(() => {
      const existing = pendingGoalApprovals(this.db, goalId).find(
        (approval) =>
          approval.gate === gate &&
          Object.entries(action).every(([key, value]) => approval.detail[key] === value),
      );
      const approval =
        existing ??
        requestGoalApproval(this.db, {
          goalId,
          gate,
          risk: 'low',
          reason,
          requestedBy: 'supervisor',
          detail: action,
          now: this.now(),
        });
      transitionGoal(this.db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'gate_pending',
        actor: 'supervisor',
        detail: { approvalId: approval.id, gate },
        now: this.now(),
      });
      return approval.id;
    })();
  }

  private async tickNeedsUser(
    goalId: string,
    goal: { status_reason_code: string | null; status_detail_json: string | null },
  ): Promise<TickResult> {
    if (goal.status_reason_code !== 'gate_pending') return { action: 'idle', goalId };
    const approvalId = this.approvalIdOf(goal.status_detail_json);
    const approval = approvalId ? getGoalApproval(this.db, approvalId) : undefined;
    if (!approval || approval.status === 'pending') return { action: 'waiting_gate', goalId };
    if (approval.status === 'denied') {
      // A denial never continues silently: the proposed cycle is cancelled and the Goal stays with the user.
      const cycle = activeCycle(this.db, goalId);
      if (cycle) {
        finalizeCycle(this.db, {
          cycleId: cycle.id,
          to: 'cancelled',
          outcomeCode: 'gate_denied',
          detail: { approvalId: approval.id },
          now: this.now(),
        });
        return { action: 'gate_denied', goalId, cycleId: cycle.id };
      }
      return { action: 'idle', goalId, code: 'gate_denied' };
    }
    // Approved: the same preflight as any start decides whether work may continue.
    const result = await this.resumeGoal(goalId, { actor: 'supervisor', reasonCode: 'gate_resolved' });
    return result.ok
      ? { action: 'resumed', goalId }
      : { action: 'preflight_failed', goalId, code: result.code };
  }

  // --- No active cycle ------------------------------------------------------------------------------------------

  private blockForRef(
    goalId: string,
    code: 'goal_ref_changed' | 'goal_ref_missing' | 'git_state_invalid',
  ): TickResult {
    transitionGoal(this.db, {
      goalId,
      to: 'blocked',
      reasonCode: code,
      actor: 'supervisor',
      now: this.now(),
    });
    return { action: 'ref_blocked', goalId, code };
  }

  /** Verifies the Goal ref against the runtime head; a problem blocks the Goal and returns the result, else null. */
  private async verifyRef(goalId: string): Promise<TickResult | null> {
    let verification;
    try {
      verification = await verifyGoalRef(this.db, goalId);
    } catch (error) {
      if (error instanceof GoalGitError) return this.blockForRef(goalId, 'git_state_invalid');
      throw error;
    }
    if (verification.ok) return null;
    return this.blockForRef(
      goalId,
      verification.code === 'goal_ref_missing' || verification.code === 'goal_ref_changed'
        ? verification.code
        : 'git_state_invalid',
    );
  }

  /** Re-derives milestone runtime state from fresh evidence. A derived cache refresh, not a Goal action. */
  private async refreshMilestones(goalId: string): Promise<MilestoneEvaluation[] | null> {
    const goal = this.db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as {
      current_definition_version: number;
    };
    const version = loadDefinitionVersion(this.db, goalId, goal.current_definition_version);
    if (!version) return null;
    const resolved = await resolveGoalRepository(this.db, goalId);
    if (!resolved.ok) return null;
    const criteria = await evaluateCriteria(
      this.db,
      goalId,
      version.definition,
      createRepositoryReader(resolved.state),
    );
    const milestones = evaluateMilestones(this.db, {
      goalId,
      definitionVersion: version.version,
      definitionHash: version.definitionHash,
      definition: version.definition,
      integrationTree: resolved.state.tree,
      criteria,
    });
    syncMilestoneRuntime(this.db, {
      goalId,
      definitionVersion: version.version,
      milestones,
      now: this.now(),
    });
    return milestones;
  }

  private async tickNoCycle(goalId: string): Promise<TickResult> {
    const breach = enforceBounds(this.db, goalId, {
      now: this.now(),
      liveActiveMs: this.tracker.pendingMs(goalId),
    });
    if (breach) {
      this.tracker.sync(goalId);
      return { action: 'bound_blocked', goalId, code: breach.reason };
    }
    const blockedByRef = await this.verifyRef(goalId);
    if (blockedByRef) return blockedByRef;

    const evaluations = await this.refreshMilestones(goalId);
    const goal = this.db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as {
      current_definition_version: number;
    };
    const version = loadDefinitionVersion(this.db, goalId, goal.current_definition_version)!;
    const rows = this.db
      .prepare('SELECT milestone_key, status FROM goal_milestones WHERE goal_id = ?')
      .all(goalId) as Array<{ milestone_key: string; status: string }>;
    const status = new Map(rows.map((row) => [row.milestone_key, row.status]));
    const done = (key: string) => status.get(key) === 'satisfied' || status.get(key) === 'skipped';
    const remaining = version.definition.milestones.filter((spec) => !done(spec.key));

    if (remaining.length === 0) {
      // Completion is decided only by the real evaluation; the supervisor never writes the completed status.
      const outcome = await completeGoal(this.db, goalId, { now: this.now() });
      if (outcome.completed) {
        this.tracker.sync(goalId);
        return { action: 'completed', goalId };
      }
      return { action: 'completion_pending', goalId, code: outcome.evaluation.failures[0]?.code };
    }
    const active = remaining.find((spec) => spec.dependsOn.every(done));
    if (!active) return { action: 'idle', goalId, code: 'no_eligible_milestone' };

    const evaluation = evaluations?.find((entry) => entry.key === active.key);
    if (
      version.definition.limits.humanGates.beforeMilestoneComplete &&
      evaluation &&
      evaluation.blockers.length === 1 &&
      evaluation.blockers[0] === 'human_gate_missing'
    ) {
      const approvalId = this.requestGate(
        goalId,
        'milestone_complete',
        {
          action: 'complete',
          milestoneKey: active.key,
          definitionVersion: version.version,
          definitionHash: version.definitionHash,
        },
        `Confirm that milestone ${active.key} is complete.`,
      );
      return { action: 'gate_requested', goalId, code: approvalId };
    }

    this.markActiveMilestone(goalId, active.key);
    try {
      const created = createCycle(this.db, {
        goalId,
        kind: 'execution',
        triggerCode: 'next_task',
        milestoneKey: active.key,
        now: this.now(),
        liveActiveMs: this.tracker.pendingMs(goalId),
      });
      return { action: created.created ? 'cycle_created' : 'busy', goalId, cycleId: created.cycle.id };
    } catch (error) {
      if (error instanceof CycleError && error.code === 'bound_exceeded' && error.breach) {
        transitionGoal(this.db, {
          goalId,
          to: 'blocked',
          reasonCode: error.breach.reason,
          actor: 'supervisor',
          now: this.now(),
        });
        return { action: 'bound_blocked', goalId, code: error.breach.reason };
      }
      throw error;
    }
  }

  private markActiveMilestone(goalId: string, key: string): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, status FROM goal_milestones WHERE goal_id = ? AND milestone_key = ?')
        .get(goalId, key) as { id: string; status: string } | undefined;
      if (!row) return;
      this.db.prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?').run(row.id, goalId);
      if (row.status === 'pending')
        this.db.prepare("UPDATE goal_milestones SET status = 'active' WHERE id = ?").run(row.id);
    })();
  }

  // --- Active cycle ---------------------------------------------------------------------------------------------

  private runForPurpose(cycleId: string, purpose: GoalRunPurpose): RunRow | undefined {
    return this.db
      .prepare(
        `SELECT id, status, branch, summary FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = ?`,
      )
      .get(cycleId, purpose) as RunRow | undefined;
  }

  private runById(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT id, status, branch, summary FROM runs WHERE id = ?').get(runId) as
      RunRow | undefined;
  }

  /** The purpose of the run that does the cycle's repository work. */
  private workPurpose(cycle: CycleRow): 'execution' | 'remediation' {
    return cycle.kind === 'remediation' ? 'remediation' : 'execution';
  }

  /** The purpose of the run a cycle owns in its current status. */
  private currentPurpose(cycle: CycleRow): GoalRunPurpose {
    return ['planned', 'proposing', 'proposed'].includes(cycle.status) ? 'proposal' : this.workPurpose(cycle);
  }

  /**
   * Starts a persisted queued run and never assumes it started: the structured result and, when the run was not
   * queued, the re-read persisted state decide what happens next.
   */
  private startQueued(
    goalId: string,
    cycle: CycleRow,
    run: RunRow,
  ): { kind: 'in_flight' } | { kind: 'finished' } | { kind: 'result'; result: TickResult } {
    const result = this.deps.startRun(run.id);
    if (result.started || result.reason === 'already-active') return { kind: 'in_flight' };
    const missing = () => ({
      kind: 'result' as const,
      result: this.fail(cycle, 'run_not_found', { runId: run.id }),
    });
    if (result.reason === 'not-found') return missing();
    const current = this.runById(run.id);
    if (!current) return missing();
    if (ACTIVE_RUN.has(current.status)) return { kind: 'in_flight' };
    if (PAUSED_RUN.has(current.status)) return { kind: 'result', result: this.interrupt(goalId, cycle) };
    if (TERMINAL_RUN.has(current.status)) return { kind: 'finished' };
    return {
      kind: 'result',
      result: this.fail(cycle, 'run_state_invalid', { runId: run.id, runStatus: current.status }),
    };
  }

  private milestoneSpec(goalId: string, cycle: CycleRow): GoalMilestoneSpec | undefined {
    const version =
      cycle.definitionVersion === null
        ? undefined
        : loadDefinitionVersion(this.db, goalId, cycle.definitionVersion);
    return version?.definition.milestones.find((spec) => spec.key === cycle.milestoneKey);
  }

  private fail(cycle: CycleRow, code: string, detail?: Record<string, unknown>): TickResult {
    finalizeCycle(this.db, { cycleId: cycle.id, to: 'failed', outcomeCode: code, detail, now: this.now() });
    this.afterCycle(cycle.goalId);
    return { action: 'cycle_failed', goalId: cycle.goalId, cycleId: cycle.id, code };
  }

  private reject(cycle: CycleRow, code: string, detail?: Record<string, unknown>): TickResult {
    finalizeCycle(this.db, { cycleId: cycle.id, to: 'rejected', outcomeCode: code, detail, now: this.now() });
    this.afterCycle(cycle.goalId);
    return { action: 'proposal_rejected', goalId: cycle.goalId, cycleId: cycle.id, code };
  }

  /** After a cycle finishes: rebuild the bounded memory cache from persisted rows. */
  private afterCycle(goalId: string): void {
    rebuildGoalMemory(this.db, goalId, { now: this.now() });
  }

  private interrupt(goalId: string, cycle: CycleRow): TickResult {
    transitionGoal(this.db, {
      goalId,
      to: 'needs_user',
      reasonCode: 'run_interrupted',
      actor: 'supervisor',
      detail: { cycleId: cycle.id },
      now: this.now(),
    });
    return { action: 'run_interrupted', goalId, cycleId: cycle.id };
  }

  /**
   * The proposing sub-lifecycle lives in the persisted proposal run, never in memory: queue it (idempotent), start it
   * once, wait while it is in flight, and only when it has completed read its stored output. No model is called here.
   */
  private async tickProposing(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const milestone = this.milestoneSpec(goalId, cycle);
    if (!milestone || cycle.definitionVersion === null) return this.fail(cycle, 'milestone_unavailable');
    const run = this.runForPurpose(cycle.id, 'proposal');
    if (!run) {
      try {
        await this.executor.queueProposalRun({
          goalId,
          cycleId: cycle.id,
          definitionVersion: cycle.definitionVersion,
          milestone,
          baseCommit: cycle.baseIntegrationCommit!,
          memory: rebuildGoalMemory(this.db, goalId, { now: this.now() }),
        });
      } catch {
        return this.fail(cycle, 'proposal_queue_error');
      }
      return { action: 'proposal_queued', goalId, cycleId: cycle.id };
    }
    if (run.status === 'queued') {
      const outcome = this.startQueued(goalId, cycle, run);
      if (outcome.kind === 'result') return outcome.result;
      return outcome.kind === 'in_flight'
        ? { action: 'proposal_run_started', goalId, cycleId: cycle.id }
        : { action: 'waiting_for_proposal', goalId, cycleId: cycle.id, code: 'run_already_finished' };
    }
    if (PAUSED_RUN.has(run.status)) return this.interrupt(goalId, cycle);
    if (ACTIVE_RUN.has(run.status)) return { action: 'waiting_for_proposal', goalId, cycleId: cycle.id };
    if (FAILED_RUN.has(run.status))
      return this.fail(cycle, 'proposal_run_failed', { runId: run.id, runStatus: run.status });
    if (CANCELLED_RUN.has(run.status)) {
      finalizeCycle(this.db, {
        cycleId: cycle.id,
        to: 'cancelled',
        outcomeCode: 'run_cancelled',
        detail: { runId: run.id, purpose: 'proposal' },
        now: this.now(),
      });
      this.afterCycle(goalId);
      return { action: 'cycle_failed', goalId, cycleId: cycle.id, code: 'run_cancelled' };
    }
    if (run.status !== 'completed')
      return this.fail(cycle, 'run_state_invalid', { runId: run.id, runStatus: run.status });

    let result;
    try {
      result = await this.executor.readProposal(run.id);
    } catch {
      return this.fail(cycle, 'proposal_read_error', { runId: run.id });
    }
    if (!result.ok) return this.reject(cycle, 'proposal_unavailable', { reason: result.code, runId: run.id });
    const definition = loadDefinitionVersion(this.db, goalId, cycle.definitionVersion)!.definition;
    const validation = validateNextTask(result.proposal, {
      definition,
      activeMilestone: milestone,
      cycleKind: this.workPurpose(cycle),
    });
    // A rejected proposal is recorded with its reasons and is never executed.
    if (!validation.ok)
      return this.reject(cycle, 'proposal_invalid', { issues: validation.issues, runId: run.id });
    transitionCycle(this.db, {
      cycleId: cycle.id,
      to: 'proposed',
      validatedTask: validation.task,
      now: this.now(),
    });
    return { action: 'proposal_recorded', goalId, cycleId: cycle.id };
  }

  private async tickCycle(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const next = (
      to: Parameters<typeof transitionCycle>[1]['to'],
      extra: Partial<Parameters<typeof transitionCycle>[1]> = {},
    ) => transitionCycle(this.db, { cycleId: cycle.id, to, now: this.now(), ...extra });
    switch (cycle.status) {
      case 'planned':
        next('proposing');
        return { action: 'proposal_started', goalId, cycleId: cycle.id };

      case 'proposing':
        return this.tickProposing(goalId, cycle);

      case 'proposed': {
        const version = loadDefinitionVersion(this.db, goalId, cycle.definitionVersion!)!;
        if (version.definition.limits.humanGates.eachCycle) {
          const gate = this.db
            .prepare(
              `SELECT id, status FROM goal_approvals WHERE goal_id = ? AND gate = 'each_cycle'
                 AND json_extract(detail_json, '$.cycleId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            )
            .get(goalId, cycle.id) as { id: string; status: string } | undefined;
          if (!gate || gate.status === 'pending') {
            const approvalId = this.requestGate(
              goalId,
              'each_cycle',
              { action: 'launch_cycle', cycleId: cycle.id },
              `Approve cycle ${cycle.sequence}: ${cycle.validatedTask?.title ?? ''}`.slice(0, 300),
            );
            return { action: 'gate_requested', goalId, cycleId: cycle.id, code: approvalId };
          }
          if (gate.status === 'denied') {
            finalizeCycle(this.db, {
              cycleId: cycle.id,
              to: 'cancelled',
              outcomeCode: 'gate_denied',
              detail: { approvalId: gate.id },
              now: this.now(),
            });
            return { action: 'gate_denied', goalId, cycleId: cycle.id };
          }
        }
        next('launching');
        return { action: 'launch_started', goalId, cycleId: cycle.id };
      }

      case 'launching': {
        const purpose = this.workPurpose(cycle);
        const run = this.runForPurpose(cycle.id, purpose);
        if (!run) {
          try {
            await this.executor.queueChildRun({
              goalId,
              cycleId: cycle.id,
              purpose,
              task: cycle.validatedTask!,
              baseCommit: cycle.baseIntegrationCommit!,
            });
          } catch {
            return this.fail(cycle, 'launch_error');
          }
          return { action: 'run_queued', goalId, cycleId: cycle.id };
        }
        if (PAUSED_RUN.has(run.status)) return this.interrupt(goalId, cycle);
        // A queued run is started exactly once: this is the only place a work run is started on the tick path.
        let started = true;
        if (run.status === 'queued') {
          const outcome = this.startQueued(goalId, cycle, run);
          if (outcome.kind === 'result') return outcome.result;
          started = outcome.kind === 'in_flight';
        }
        next('running');
        return started
          ? { action: 'run_started', goalId, cycleId: cycle.id }
          : { action: 'waiting_for_run', goalId, cycleId: cycle.id, code: 'run_already_finished' };
      }

      case 'running': {
        const run = this.runForPurpose(cycle.id, this.workPurpose(cycle));
        if (!run) return this.fail(cycle, 'run_missing');
        if (PAUSED_RUN.has(run.status)) return this.interrupt(goalId, cycle);
        if (run.status === 'queued' || ACTIVE_RUN.has(run.status))
          return { action: 'waiting_for_run', goalId, cycleId: cycle.id };
        next('collecting');
        return { action: 'collection_started', goalId, cycleId: cycle.id };
      }

      case 'collecting': {
        const run = this.runForPurpose(cycle.id, this.workPurpose(cycle));
        if (!run) return this.fail(cycle, 'run_missing');
        if (FAILED_RUN.has(run.status))
          return this.fail(cycle, 'run_failed', { runId: run.id, runStatus: run.status });
        if (CANCELLED_RUN.has(run.status)) {
          finalizeCycle(this.db, {
            cycleId: cycle.id,
            to: 'cancelled',
            outcomeCode: 'run_cancelled',
            detail: { runId: run.id },
            now: this.now(),
          });
          this.afterCycle(goalId);
          return { action: 'cycle_failed', goalId, cycleId: cycle.id, code: 'run_cancelled' };
        }
        if (run.status !== 'completed') return { action: 'waiting_for_run', goalId, cycleId: cycle.id };
        next('integrating', { outcome: { runId: run.id, summary: (run.summary ?? '').slice(0, 800) } });
        return { action: 'integration_started', goalId, cycleId: cycle.id };
      }

      case 'integrating':
        return this.integrate(goalId, cycle);

      default:
        return { action: 'idle', goalId, cycleId: cycle.id };
    }
  }

  /** Repo-root-relative scope prefixes plus the exact glob check on the actual changed paths. */
  private async scopeViolations(
    goalId: string,
    cycle: CycleRow,
    run: RunRow,
    spec: GoalMilestoneSpec,
  ): Promise<string[]> {
    if (!run.branch || !cycle.baseIntegrationCommit) return [];
    const context = loadContext(this.db, goalId);
    const tip = await gitTry(context.repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${run.branch}^{commit}`,
    ]);
    if (!tip.ok) return [];
    const entries = await changedEntries(context.repoRoot, cycle.baseIntegrationCommit, tip.stdout.trim());
    return changedPathSet(entries).filter((path) => {
      const relative =
        context.scope && path.startsWith(`${context.scope}/`) ? path.slice(context.scope.length + 1) : path;
      return !pathInMilestoneScope(relative, spec.allowedScope);
    });
  }

  private async integrate(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const run = this.runForPurpose(cycle.id, this.workPurpose(cycle));
    const spec = this.milestoneSpec(goalId, cycle);
    if (!run || !spec) return this.fail(cycle, 'integration_inputs_missing');
    try {
      const recovered = await recoverIntegrationOps(this.db, goalId);
      if (recovered.some((entry) => entry.outcome === 'goal_ref_changed'))
        return this.blockForIntegration(goalId, cycle, 'goal_ref_changed');
      const head = (
        this.db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as {
          integration_head: string;
        }
      ).integration_head;
      // An applied advance for this cycle (completed now, or by startup recovery) already moved the head to this run's
      // result; a second advance would be rejected as stale, so finalise instead.
      const applied = this.db
        .prepare(
          "SELECT new_commit FROM goal_integration_ops WHERE goal_id = ? AND cycle_id = ? AND op = 'advance' AND status = 'applied'",
        )
        .get(goalId, cycle.id) as { new_commit: string } | undefined;
      if (applied && applied.new_commit === head) {
        finalizeCycle(this.db, {
          cycleId: cycle.id,
          to: 'succeeded',
          outcomeCode: 'integrated',
          resultIntegrationCommit: head,
          detail: { runId: run.id, recovered: true },
          now: this.now(),
        });
        this.afterCycle(goalId);
        return { action: 'cycle_succeeded', goalId, cycleId: cycle.id };
      }
      const violations = await this.scopeViolations(goalId, cycle, run, spec);
      if (violations.length > 0) return this.scopeViolation(goalId, cycle, run, violations);
      const context = loadContext(this.db, goalId);
      const allowedPaths = scopePrefixes(spec.allowedScope).map((prefix) =>
        [context.scope, prefix].filter(Boolean).join('/'),
      );
      const result = await advanceGoalRef(
        this.db,
        { goalId, cycleId: cycle.id, runId: run.id, expectedHead: head },
        { allowedPaths: allowedPaths.length ? allowedPaths : undefined },
      );
      switch (result.outcome) {
        case 'advanced':
          finalizeCycle(this.db, {
            cycleId: cycle.id,
            to: 'succeeded',
            outcomeCode: 'integrated',
            resultIntegrationCommit: result.to,
            detail: {
              runId: run.id,
              summary: (run.summary ?? '').slice(0, 800),
              changedFiles: result.changedPaths.slice(0, 30),
            },
            now: this.now(),
          });
          this.afterCycle(goalId);
          return { action: 'cycle_succeeded', goalId, cycleId: cycle.id };
        case 'no_change':
          return this.fail(cycle, 'no_change', { runId: run.id });
        case 'rejected':
          if (result.code === 'milestone_scope_violation')
            return this.scopeViolation(
              goalId,
              cycle,
              run,
              await this.scopeViolations(goalId, cycle, run, spec),
            );
          return this.fail(cycle, 'integration_rejected', { runId: run.id, rejection: result.code });
        case 'conflict':
          return this.blockForIntegration(goalId, cycle, 'goal_ref_changed');
      }
    } catch (error) {
      if (error instanceof GoalGitError) return this.blockForIntegration(goalId, cycle, 'git_state_invalid');
      throw error;
    }
  }

  /**
   * Real work outside the milestone scope is never integrated and never retried automatically: the cycle fails and,
   * in the same transaction, the Goal goes to the user. (A later scope-change review is Stage 6.)
   */
  private scopeViolation(goalId: string, cycle: CycleRow, run: RunRow, paths: string[]): TickResult {
    const safe = paths.slice(0, 20).map((path) => path.slice(0, 200));
    this.db.transaction(() => {
      finalizeCycle(this.db, {
        cycleId: cycle.id,
        to: 'failed',
        outcomeCode: 'scope_violation',
        detail: { runId: run.id, paths: safe },
        now: this.now(),
      });
      transitionGoal(this.db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'scope_violation',
        actor: 'supervisor',
        detail: { cycleId: cycle.id, paths: safe.slice(0, 10) },
        now: this.now(),
      });
    })();
    this.afterCycle(goalId);
    return { action: 'cycle_failed', goalId, cycleId: cycle.id, code: 'scope_violation' };
  }

  private blockForIntegration(
    goalId: string,
    cycle: CycleRow,
    code: 'goal_ref_changed' | 'git_state_invalid',
  ): TickResult {
    transitionGoal(this.db, {
      goalId,
      to: 'blocked',
      reasonCode: code,
      actor: 'supervisor',
      now: this.now(),
    });
    return { action: 'integration_blocked', goalId, cycleId: cycle.id, code };
  }

  // --- Recovery and shutdown ------------------------------------------------------------------------------------

  /**
   * Startup reconciliation, run after `engine.reconcileInterruptedRuns()`. Per lease-holding Goal, in a fixed order:
   * resolve planned integration operations (an unexpected ref blocks the Goal and is never overwritten), recompute the
   * counter cache from history, align active-time tracking with the persisted status, then take one ordinary tick,
   * which is what starts a launching cycle's queued run exactly once, observes an existing proposal, turns a paused run
   * into needs_user(run_interrupted), or resumes collection for a finished run. Pending approvals are untouched.
   * Repeating it changes nothing further.
   */
  async reconcile(): Promise<TickResult[]> {
    const goals = this.db
      .prepare(
        `SELECT id, status FROM goals WHERE status IN ('running','reviewing','needs_user','blocked','paused')
         ORDER BY created_at, id`,
      )
      .all() as Array<{ id: string; status: string }>;
    const results: TickResult[] = [];
    for (const goal of goals) {
      try {
        const recovered = await recoverIntegrationOps(this.db, goal.id);
        if (recovered.some((entry) => entry.outcome === 'goal_ref_changed') && goal.status === 'running') {
          transitionGoal(this.db, {
            goalId: goal.id,
            to: 'blocked',
            reasonCode: 'goal_ref_changed',
            actor: 'supervisor',
            now: this.now(),
          });
          results.push({ action: 'ref_blocked', goalId: goal.id, code: 'goal_ref_changed' });
          continue;
        }
      } catch (error) {
        if (!(error instanceof GoalGitError)) throw error;
      }
      reconcileCounters(this.db, goal.id, this.now());
      this.tracker.sync(goal.id);
      if (goal.status === 'running') {
        // After planned-op recovery (which may legitimately move the head) and before any tick that could queue or
        // start provider work: a missing or moved Goal ref must stop everything.
        const blocked = await this.verifyRef(goal.id);
        if (blocked) {
          results.push(blocked);
          continue;
        }
        results.push(await this.tickGoal(goal.id));
      }
    }
    return results;
  }

  /**
   * Clean shutdown: stop launching, persist every active-time delta, and leave all state as is. Goal statuses are not
   * changed (a running Goal stays running so the next start continues it without a user action), child runs are not
   * cancelled, and pending approvals stay pending.
   */
  shutdown(): void {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tracker.shutdown();
    this.tracker.dispose();
  }
}

export function createGoalSupervisor(deps: GoalSupervisorDeps): GoalSupervisor {
  return new GoalSupervisor(deps);
}
