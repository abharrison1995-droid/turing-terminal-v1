import type { CriterionEvaluation, GoalMilestoneSpec, MilestoneEvaluation } from '../../shared/goals.js';
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
import type { FirstUseRequest, GoalExecutor, GoalRunPurpose } from './executor.js';
import { evaluateCriteria } from './freshness.js';
import { verifyAmendmentResolution } from './amendmentAuthority.js';
import { collectRunEvidence, listUncollectedRunIds } from './runEvidence.js';
import { pruneRunWorktree, recordRunEvidenceCollected } from './retention.js';
import { applyReviewFindings, GoalFindingError } from './findings.js';
import {
  closeReview,
  completeReview,
  GoalReviewError,
  reviewForCycle,
  reviewMatchesCyclePlan,
} from './reviews.js';
import { deriveReviewIndependence } from './reviewIndependence.js';
import { isReviewCurrent, recordReviewEvidence } from './reviewConsume.js';
import { linkRunFindings, readGoalReviewReport } from './reviewReport.js';
import { readReviewPlan, type ReviewPlan } from './reviewPlan.js';
import { reviewRoleForKind } from './reviewRole.js';
import { materializeVerification, milestoneDeterministicVerifiers } from './verification.js';
import { normalizeVerifierDigests } from './verifierDigest.js';
import { rebuildGoalMemory } from './memory.js';
import { evaluateMilestones, syncMilestoneRuntime } from './milestones.js';
import { validateNextTask } from './nextTask.js';
import { runPreflight, type PreflightFailureCode } from './preflight.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';
import { pathInMilestoneScope, scopePrefixes } from './scope.js';
import { transitionGoal } from './stateMachine.js';
import type { GoalActor, GoalApproval, GoalReasonCode } from '../../shared/goals.js';

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
  'superseded_cycle_in_flight',
  'superseded_cycle_retired',
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
  'evidence_collected',
  'evidence_collection_error',
  'verification_unavailable',
  'review_restored',
  'review_run_queued',
  'review_run_started',
  'review_waiting',
  'review_decision_needed',
  'review_consumed',
] as const;
export type TickAction = (typeof TICK_ACTIONS)[number];

export interface TickResult {
  action: TickAction;
  goalId: string;
  cycleId?: string;
  /** Machine-readable code for refusals and failures (a reason or outcome code). */
  code?: string;
  /** Present on `evidence_collected`: the run whose evidence was extracted, its cycle and the stored row count. */
  runId?: string;
  evidenceCount?: number;
  /** Bounded result of opportunistic worktree retention; a cleanup problem never changes the Goal outcome. */
  cleanup?: { runId: string; status: string; reasons: string[] };
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
    results.push(...(await this.maintainEvidence()));
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
        /** Present with `gate_pending` when the Goal waits on a first-use approval of a pool member. */
        approvalId?: string;
        code:
          | PreflightFailureCode
          | 'scheduler_full'
          | 'transition_refused'
          | 'no_paused_run'
          | 'resume_failed'
          | 'amendment_not_resolved'
          | 'superseded_cycle_in_flight'
          | 'superseded_cycle_retired';
      }
  > {
    const goal = this.db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
      { status: string } | undefined;
    if (!goal) return { ok: false, code: 'goal_not_found' };
    // The amendment reasons are facts: they need the matching persisted amendment action in this quiescent episode.
    if (
      (options.reasonCode === 'amendment_approved' || options.reasonCode === 'amendment_discarded') &&
      !verifyAmendmentResolution(this.db, goalId, options.reasonCode).ok
    )
      return { ok: false, code: 'amendment_not_resolved' };
    // A cycle created under a superseded definition can never return to autonomous execution.
    const stale = activeCycle(this.db, goalId);
    if (stale && this.isSuperseded(goalId, stale)) {
      const outcome = await this.retireSuperseded(goalId, stale);
      if (outcome === 'in_flight') return { ok: false, code: 'superseded_cycle_in_flight' };
      if (outcome === 'retired') return { ok: false, code: 'superseded_cycle_retired' };
      return { ok: false, code: outcome };
    }
    if (this.runningGoals().filter((candidate) => candidate.id !== goalId).length >= this.maxRunning())
      return { ok: false, code: 'scheduler_full' };
    // Identify the interrupted run first, without touching it. With no paused Goal run there is nothing to resume.
    const paused = options.reasonCode === 'run_resumed' ? this.interruptedRun(goalId) : undefined;
    if (options.reasonCode === 'run_resumed' && !paused) return { ok: false, code: 'no_paused_run' };
    const preflight = await runPreflight(this.db, goalId, { executor: this.executor, now: this.now() });
    if (!preflight.ok) {
      // A pool member that has never been used needs the user's approval. The request is created or reused, the Goal
      // keeps its status, and nothing is queued or started: Start is simply retried after the decision.
      if (
        (preflight.code === 'approval_required' || preflight.code === 'approval_pending') &&
        preflight.approval
      )
        return {
          ok: false,
          code: 'gate_pending',
          approvalId: this.ensureFirstUseApproval(goalId, preflight.approval).id,
        };
      return { ok: false, code: preflight.code };
    }
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

  private isSuperseded(goalId: string, cycle: CycleRow): boolean {
    if (cycle.definitionVersion === null) return false;
    const goal = this.db
      .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
      .get(goalId) as { v: number | null } | undefined;
    return goal?.v != null && goal.v !== cycle.definitionVersion;
  }

  /**
   * A superseded cycle with genuinely active child work is left alone (a provider run is never cancelled just to
   * simplify state). With no active child work it is retired as one explicit persisted action: cancelled with
   * `definition_superseded`, no integration, no Goal-ref movement.
   */
  private async retireSuperseded(
    goalId: string,
    cycle: CycleRow,
  ): Promise<'in_flight' | 'retired' | 'goal_ref_changed' | 'git_state_invalid'> {
    const runs = this.db
      .prepare('SELECT id, status FROM runs WHERE goal_cycle_id = ?')
      .all(cycle.id) as Array<{
      id: string;
      status: string;
    }>;
    if (runs.some((run) => !TERMINAL_RUN.has(run.status))) return 'in_flight';
    try {
      // A planned integration operation must be resolved before the cycle's history is closed.
      const recovered = await recoverIntegrationOps(this.db, goalId);
      if (recovered.some((entry) => entry.outcome === 'goal_ref_changed')) return 'goal_ref_changed';
    } catch (error) {
      if (error instanceof GoalGitError) return 'git_state_invalid';
      throw error;
    }
    const current = (
      this.db.prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?').get(goalId) as {
        v: number;
      }
    ).v;
    this.db.transaction(() => {
      // A review that never completed cannot change current findings and is closed with its cycle.
      const pending = cycle.kind === 'review' ? reviewForCycle(this.db, cycle.id) : undefined;
      if (pending?.status === 'pending')
        closeReview(this.db, { reviewId: pending.id, status: 'cancelled', now: this.now() });
      finalizeCycle(this.db, {
        cycleId: cycle.id,
        to: 'cancelled',
        outcomeCode: 'definition_superseded',
        detail: {
          fromVersion: cycle.definitionVersion,
          toVersion: current,
          runIds: runs.map((run) => run.id),
        },
        now: this.now(),
      });
    })();
    this.afterCycle(goalId);
    return 'retired';
  }

  private async tickSuperseded(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const outcome = await this.retireSuperseded(goalId, cycle);
    if (outcome === 'in_flight') return { action: 'superseded_cycle_in_flight', goalId, cycleId: cycle.id };
    if (outcome === 'retired') return { action: 'superseded_cycle_retired', goalId, cycleId: cycle.id };
    return this.blockForRef(goalId, outcome);
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
    // Evidence maintenance never resumes a Goal or changes its status: a needs_user, blocked or paused Goal still has
    // its finished runs extracted (one run per action) so retention and freshness do not wait for the user.
    if (goal.status === 'needs_user' || goal.status === 'blocked' || goal.status === 'paused') {
      const collected = await this.collectOne(goalId);
      if (collected) return collected;
    }
    if (goal.status === 'needs_user') return this.tickNeedsUser(goalId, goal);
    if (goal.status === 'reviewing') return this.tickReviewing(goalId);
    if (goal.status !== 'running') return { action: 'idle', goalId };
    const cycle = activeCycle(this.db, goalId);
    // A review cycle left active by a resumed `needs_user(review_needs_decision)` returns the Goal to `reviewing`.
    if (cycle?.kind === 'review') return this.restoreReviewing(goalId, cycle);
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
   * The pending first-use approval for exactly this pool member, created at most once: an equal pending request (same
   * pool and member identity) is reused. Asking never advances round robin and never starts anything.
   */
  private ensureFirstUseApproval(goalId: string, request: FirstUseRequest): GoalApproval {
    return this.db.transaction(() => {
      const existing = pendingGoalApprovals(this.db, goalId).find(
        (approval) =>
          approval.gate === 'pool_route_first_use' &&
          approval.detail.poolId === request.poolId &&
          approval.detail.memberIdentityHash === request.memberIdentityHash,
      );
      return (
        existing ??
        requestGoalApproval(this.db, {
          goalId,
          gate: 'pool_route_first_use',
          risk: 'low',
          reason:
            `Approve first use of pool member ${request.memberIndex + 1} of pool "${request.poolId}" for the ${request.role} role.`.slice(
              0,
              300,
            ),
          requestedBy: 'supervisor',
          detail: {
            poolId: request.poolId,
            memberIdentityHash: request.memberIdentityHash,
            role: request.role,
            memberIndex: request.memberIndex,
          },
          now: this.now(),
        })
      );
    })();
  }

  /** `running -> needs_user(gate_pending)` for a first-use approval, in one transaction with the approval request. */
  private requestFirstUseGate(goalId: string, request: FirstUseRequest): string {
    return this.db.transaction(() => {
      const approval = this.ensureFirstUseApproval(goalId, request);
      transitionGoal(this.db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'gate_pending',
        actor: 'supervisor',
        detail: { approvalId: approval.id, gate: 'pool_route_first_use' },
        now: this.now(),
      });
      return approval.id;
    })();
  }

  /** The first-use request carried by a queue failure, when that is what the failure is. */
  private firstUseFailure(error: unknown): FirstUseRequest | null {
    const candidate = error as { code?: unknown; approval?: FirstUseRequest } | null;
    return (candidate?.code === 'approval_required' || candidate?.code === 'approval_pending') &&
      candidate.approval
      ? candidate.approval
      : null;
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
    if (approval.gate === 'pool_route_first_use') {
      // A first-use decision never cancels the cycle. Approval lets the same preflight re-resolve; a denial makes the
      // pool consider its next member (the denied one is no longer eligible), or refuse when none is left.
      const resumed = await this.resumeGoal(goalId, { actor: 'supervisor', reasonCode: 'gate_resolved' });
      if (resumed.ok) return { action: 'resumed', goalId };
      return resumed.code === 'gate_pending'
        ? { action: 'waiting_gate', goalId, ...(resumed.approvalId ? { code: resumed.approvalId } : {}) }
        : { action: 'preflight_failed', goalId, code: resumed.code };
    }
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
  private async refreshMilestones(
    goalId: string,
  ): Promise<{ milestones: MilestoneEvaluation[]; criteria: CriterionEvaluation[] } | null> {
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
    return { milestones, criteria };
  }

  // --- Evidence maintenance --------------------------------------------------------------------------------------

  /**
   * One bounded maintenance action: extract the evidence of the OLDEST terminal repository run (owning cycle terminal)
   * that lacks the `run_evidence_collected` marker, then opportunistically prune its worktree. Fail closed: if that run
   * cannot be collected (a thrown error or an ineligible result) the action is `evidence_collection_error` and callers
   * that would make progress stop there. The missing marker, which is persisted state, is the only authority; nothing
   * in memory (no retry counter) can ever make an unmarked run count as collected or absent.
   */
  private async collectOne(goalId: string): Promise<TickResult | null> {
    const [runId] = listUncollectedRunIds(this.db, goalId, 1);
    if (!runId) return null;
    let result;
    try {
      result = await collectRunEvidence(this.db, runId, { now: this.now() });
    } catch {
      return { action: 'evidence_collection_error', goalId, runId, code: 'collection_failed' };
    }
    if (result.status !== 'collected')
      return { action: 'evidence_collection_error', goalId, runId, code: `ineligible:${result.code}` };
    const cleanup = await this.tryPrune(runId);
    return {
      action: 'evidence_collected',
      goalId,
      cycleId: result.cycleId,
      runId,
      evidenceCount: result.evidenceCount,
      ...(cleanup ? { cleanup } : {}),
    };
  }

  /** Non-running Goals get one maintenance action each per pass; a running Goal does it as part of its own tick. */
  async maintainEvidence(): Promise<TickResult[]> {
    const goals = this.db
      .prepare(
        "SELECT id FROM goals WHERE status IN ('needs_user','blocked','paused') ORDER BY created_at, id",
      )
      .all() as Array<{ id: string }>;
    const results: TickResult[] = [];
    for (const { id } of goals) {
      if (this.shuttingDown || this.ticking.has(id)) continue;
      this.ticking.add(id);
      try {
        const result = await this.collectOne(id);
        if (result) results.push(result);
      } finally {
        this.ticking.delete(id);
      }
    }
    return results;
  }

  /**
   * The deterministic verifiers (build, test, lint) of the active milestone that need fresh evidence at the current
   * head: missing, stale or inconclusive. A fresh `contradicted` verifier is never re-verified (that would loop), and
   * `missing` only counts once the Goal has integrated something (the untouched initial head is not worth a cycle).
   * A verifier already attempted at this head (same definition, milestone and digest) is not verified again.
   */
  private verifiersNeedingEvidence(
    goalId: string,
    version: NonNullable<ReturnType<typeof loadDefinitionVersion>>,
    milestoneKey: string,
    criteria: CriterionEvaluation[],
  ) {
    const runtime = this.db
      .prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?')
      .get(goalId) as { integration_head: string | null } | undefined;
    if (!runtime?.integration_head) return [];
    // A verifier counts as already attempted only under the same definition version, milestone, integration head and full
    // digest. A terminal verification row without a trustworthy digest list establishes no attempt for any verifier.
    const attempted = new Set<string>();
    const milestoneId = (
      this.db
        .prepare('SELECT id FROM goal_milestones WHERE goal_id = ? AND milestone_key = ?')
        .get(goalId, milestoneKey) as { id: string } | undefined
    )?.id;
    if (milestoneId) {
      const priors = this.db
        .prepare(
          `SELECT outcome_json FROM goal_cycles WHERE goal_id = ? AND kind = 'verification' AND definition_version = ?
             AND milestone_id = ? AND base_integration_commit = ?
             AND status IN ('succeeded','failed','cancelled','rejected')`,
        )
        .all(goalId, version.version, milestoneId, runtime.integration_head) as Array<{
        outcome_json: string | null;
      }>;
      for (const prior of priors) {
        let digests: string[] | null = null;
        try {
          digests = normalizeVerifierDigests(
            (JSON.parse(prior.outcome_json ?? 'null') as { verifierDigests?: unknown } | null)
              ?.verifierDigests,
          );
        } catch {
          digests = null;
        }
        for (const digest of digests ?? []) attempted.add(digest);
      }
    }
    const integrated = this.db
      .prepare(
        "SELECT 1 FROM goal_cycles WHERE goal_id = ? AND kind IN ('execution','remediation') AND status = 'succeeded' LIMIT 1",
      )
      .get(goalId);
    const state = new Map<string, string>();
    for (const criterion of criteria)
      for (const verifier of criterion.verifiers)
        state.set(`${criterion.key}:${verifier.verifierDigest}`, verifier.state);
    return milestoneDeterministicVerifiers(version.definition, milestoneKey).filter((verifier) => {
      if (attempted.has(verifier.digest)) return false;
      const current = state.get(`${verifier.criterionKey}:${verifier.digest}`) ?? 'missing';
      if (current === 'stale' || current === 'inconclusive') return true;
      return current === 'missing' && !!integrated;
    });
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

    // Ordering: cycle N terminal -> evidence N collected -> milestone state refreshed -> decision about N+1.
    const collected = await this.collectOne(goalId);
    if (collected) return collected;

    const refreshed = await this.refreshMilestones(goalId);
    const evaluations = refreshed?.milestones;
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
    if (refreshed && this.executor.queueVerificationRun) {
      const needed = this.verifiersNeedingEvidence(goalId, version, active.key, refreshed.criteria);
      if (needed.length > 0) return this.startVerification(goalId, version, active.key, needed);
    }
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

  /**
   * Creates the verification cycle for the stale/missing verifiers, or - when a verifier cannot be materialised
   * (missing, unsafe or unsupported command) - launches nothing and hands the Goal to the user with bounded detail
   * naming the verifier. The cycle carries the exact verifiers to run; the run itself is queued on the next ticks.
   */
  private startVerification(
    goalId: string,
    version: NonNullable<ReturnType<typeof loadDefinitionVersion>>,
    milestoneKey: string,
    needed: ReturnType<typeof milestoneDeterministicVerifiers>,
  ): TickResult {
    const projectId = (
      this.db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id: string }
    ).project_id;
    const materialized = materializeVerification(this.db, projectId, needed);
    if (!materialized.ok) {
      transitionGoal(this.db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'verification_failed',
        actor: 'supervisor',
        detail: {
          code: materialized.code,
          kind: materialized.verifier.kind,
          criterionKey: materialized.verifier.criterionKey,
          verifierDigest: materialized.verifier.digest,
          definitionVersion: version.version,
        },
        now: this.now(),
      });
      return { action: 'verification_unavailable', goalId, code: materialized.code };
    }
    const digests = normalizeVerifierDigests(needed.map((verifier) => verifier.digest));
    if (!digests) return { action: 'idle', goalId, code: 'verification_inputs_invalid' };
    try {
      // One transaction: a verification cycle never exists without the verifier set it was created for.
      const created = this.db.transaction(() => {
        const result = createCycle(this.db, {
          goalId,
          kind: 'verification',
          triggerCode: 'evidence_refresh',
          milestoneKey,
          now: this.now(),
          liveActiveMs: this.tracker.pendingMs(goalId),
        });
        if (result.created)
          transitionCycle(this.db, {
            cycleId: result.cycle.id,
            to: 'launching',
            outcome: { verifierDigests: digests },
            now: this.now(),
          });
        return result;
      })();
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
  private workPurpose(cycle: CycleRow): 'execution' | 'remediation' | 'verification' {
    return cycle.kind === 'verification'
      ? 'verification'
      : cycle.kind === 'remediation'
        ? 'remediation'
        : 'execution';
  }

  /** The purpose of the run a cycle owns in its current status. */
  private currentPurpose(cycle: CycleRow): GoalRunPurpose {
    if (cycle.kind === 'review') return 'review';
    return cycle.kind !== 'verification' && ['planned', 'proposing', 'proposed'].includes(cycle.status)
      ? 'proposal'
      : this.workPurpose(cycle);
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
    const result = await this.tickProposingStep(goalId, cycle);
    // Once the proposal result is durably consumed into cycle history the read-only proposal worktree is disposable.
    if (!['proposal_recorded', 'proposal_rejected', 'cycle_failed'].includes(result.action)) return result;
    const run = this.runForPurpose(cycle.id, 'proposal');
    if (!run) return result;
    const cleanup = await this.tryPrune(run.id);
    return cleanup ? { ...result, cleanup } : result;
  }

  /** Retention is best effort: a failure here is reported in bounded form and never changes the Goal outcome. */
  private async tryPrune(runId: string): Promise<TickResult['cleanup'] | undefined> {
    try {
      const result = await pruneRunWorktree(this.db, runId);
      if (result.status === 'already_pruned') return undefined;
      return { runId, status: result.status, reasons: [...result.reasons].slice(0, 5) };
    } catch {
      return { runId, status: 'error', reasons: ['prune_error'] };
    }
  }

  private async tickProposingStep(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const milestone = this.milestoneSpec(goalId, cycle);
    if (!milestone || cycle.definitionVersion === null) return this.fail(cycle, 'milestone_unavailable');
    const run = this.runForPurpose(cycle.id, 'proposal');
    if (!run) {
      const blocked = await this.verifyRef(goalId);
      if (blocked) return blocked;
      try {
        await this.executor.queueProposalRun({
          goalId,
          cycleId: cycle.id,
          definitionVersion: cycle.definitionVersion,
          milestone,
          baseCommit: cycle.baseIntegrationCommit!,
          memory: rebuildGoalMemory(this.db, goalId, { now: this.now() }),
        });
      } catch (error) {
        const first = this.firstUseFailure(error);
        if (first) {
          const approvalId = this.requestFirstUseGate(goalId, first);
          return { action: 'gate_requested', goalId, cycleId: cycle.id, code: approvalId };
        }
        return this.fail(cycle, 'proposal_queue_error');
      }
      return { action: 'proposal_queued', goalId, cycleId: cycle.id };
    }
    if (run.status === 'queued') {
      const blocked = await this.verifyRef(goalId);
      if (blocked) return blocked;
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
      cycleKind: cycle.kind === 'remediation' ? 'remediation' : 'execution',
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
    if (this.isSuperseded(goalId, cycle)) return this.tickSuperseded(goalId, cycle);
    const next = (
      to: Parameters<typeof transitionCycle>[1]['to'],
      extra: Partial<Parameters<typeof transitionCycle>[1]> = {},
    ) => transitionCycle(this.db, { cycleId: cycle.id, to, now: this.now(), ...extra });
    switch (cycle.status) {
      case 'planned':
        // Cycle kind decides the path: verification has no proposal and goes straight to launching.
        if (cycle.kind === 'verification') {
          next('launching');
          return { action: 'launch_started', goalId, cycleId: cycle.id };
        }
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
          const blocked = await this.verifyRef(goalId);
          if (blocked) return blocked;
          try {
            if (purpose === 'verification') {
              const digests = normalizeVerifierDigests(cycle.outcome?.verifierDigests);
              if (!this.executor.queueVerificationRun || !digests)
                return this.fail(cycle, 'verification_inputs_missing');
              await this.executor.queueVerificationRun({
                goalId,
                cycleId: cycle.id,
                baseCommit: cycle.baseIntegrationCommit!,
                verifierDigests: digests,
              });
              return { action: 'run_queued', goalId, cycleId: cycle.id };
            }
            if (purpose !== 'execution' && purpose !== 'remediation') return this.fail(cycle, 'launch_error');
            await this.executor.queueChildRun({
              goalId,
              cycleId: cycle.id,
              purpose,
              task: cycle.validatedTask!,
              baseCommit: cycle.baseIntegrationCommit!,
            });
          } catch (error) {
            const first = this.firstUseFailure(error);
            if (first) {
              const approvalId = this.requestFirstUseGate(goalId, first);
              return { action: 'gate_requested', goalId, cycleId: cycle.id, code: approvalId };
            }
            return this.fail(cycle, 'launch_error');
          }
          return { action: 'run_queued', goalId, cycleId: cycle.id };
        }
        if (PAUSED_RUN.has(run.status)) return this.interrupt(goalId, cycle);
        // A queued run is started exactly once: this is the only place a work run is started on the tick path.
        let started = true;
        if (run.status === 'queued') {
          const blocked = await this.verifyRef(goalId);
          if (blocked) return blocked;
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
        if (cycle.kind === 'verification') {
          // A verification run integrates nothing: the cycle ends and evidence maintenance records the results.
          finalizeCycle(this.db, {
            cycleId: cycle.id,
            to: 'succeeded',
            outcomeCode: 'verified',
            detail: { runId: run.id },
            now: this.now(),
          });
          this.afterCycle(goalId);
          return { action: 'cycle_succeeded', goalId, cycleId: cycle.id };
        }
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

  // --- Review cycles (Stage 6A) ----------------------------------------------------------------------------------

  /**
   * A `needs_user(review_needs_decision)` Goal that the user resumed is `running` again with its review cycle still
   * active: it goes back to `reviewing` (the same edge that created the cycle) and the review continues where it was.
   */
  private async restoreReviewing(goalId: string, cycle: CycleRow): Promise<TickResult> {
    if (this.isSuperseded(goalId, cycle)) return this.tickSuperseded(goalId, cycle);
    transitionGoal(this.db, {
      goalId,
      to: 'reviewing',
      reasonCode: 'review_triggered',
      actor: 'supervisor',
      detail: { cycleId: cycle.id, resumed: true },
      now: this.now(),
    });
    this.tracker.sync(goalId);
    return { action: 'review_restored', goalId, cycleId: cycle.id };
  }

  /** The Goal cannot continue the review on its own: hand it to the user (`reviewing -> needs_user`). */
  private reviewDecision(
    goalId: string,
    cycleId: string | undefined,
    code: string,
    detail: Record<string, unknown> = {},
  ): TickResult {
    transitionGoal(this.db, {
      goalId,
      to: 'needs_user',
      reasonCode: 'review_needs_decision',
      actor: 'supervisor',
      detail: { code, ...(cycleId ? { cycleId } : {}), ...detail },
      now: this.now(),
    });
    this.tracker.sync(goalId);
    return { action: 'review_decision_needed', goalId, ...(cycleId ? { cycleId } : {}), code };
  }

  /**
   * An infrastructure failure of a review (provider failure, unreadable output, route failure, a cancelled run, a
   * repository-binding failure). No report is ever fabricated: the pending review is closed `failed` (or `cancelled`),
   * the cycle ends the same way, and the Goal goes to the user, all in one transaction. A terminal run is marked
   * evidence-collected (zero rows: a review failure records no evidence) so its worktree becomes retention-eligible.
   * Nothing retries automatically.
   */
  private async reviewInfraFailure(
    goalId: string,
    cycle: CycleRow,
    code: string,
    options: { cancelled?: boolean; detail?: Record<string, unknown> } = {},
  ): Promise<TickResult> {
    const run = this.runForPurpose(cycle.id, 'review');
    const to = options.cancelled ? 'cancelled' : 'failed';
    const detail = {
      ...(run ? { runId: run.id } : {}),
      ...options.detail,
    };
    this.db.transaction(() => {
      const review = reviewForCycle(this.db, cycle.id);
      if (review?.status === 'pending')
        closeReview(this.db, { reviewId: review.id, status: to, now: this.now() });
      finalizeCycle(this.db, { cycleId: cycle.id, to, outcomeCode: code, detail, now: this.now() });
      transitionGoal(this.db, {
        goalId,
        to: 'needs_user',
        reasonCode: 'review_needs_decision',
        actor: 'supervisor',
        detail: { code, cycleId: cycle.id, ...detail },
        now: this.now(),
      });
      if (run && TERMINAL_RUN.has(run.status)) {
        const stored = (
          this.db
            .prepare('SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? AND run_id = ?')
            .get(goalId, run.id) as { n: number }
        ).n;
        recordRunEvidenceCollected(this.db, {
          goalId,
          runId: run.id,
          evidenceCount: stored,
          now: this.now(),
        });
      }
    })();
    this.tracker.sync(goalId);
    this.afterCycle(goalId);
    const cleanup = run ? await this.tryPrune(run.id) : undefined;
    return {
      action: 'review_decision_needed',
      goalId,
      cycleId: cycle.id,
      code,
      ...(cleanup ? { cleanup } : {}),
    };
  }

  /** The Goal ref check for a reviewing Goal: a problem is a review failure, never a `blocked` transition. */
  private async reviewRefProblem(
    goalId: string,
    cycle: CycleRow,
    expectedTree?: string,
  ): Promise<'goal_ref_changed' | 'goal_ref_missing' | 'git_state_invalid' | 'review_base_moved' | null> {
    let verification;
    try {
      verification = await verifyGoalRef(this.db, goalId);
    } catch (error) {
      if (error instanceof GoalGitError) return 'git_state_invalid';
      throw error;
    }
    if (!verification.ok)
      return verification.code === 'goal_ref_missing' || verification.code === 'goal_ref_changed'
        ? verification.code
        : 'git_state_invalid';
    // The cycle reviews exactly the head it captured: a later head is never silently reviewed instead.
    const head = (
      this.db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as
        { integration_head: string | null } | undefined
    )?.integration_head;
    if (!head || head !== cycle.baseIntegrationCommit) return 'review_base_moved';
    if (expectedTree !== undefined) {
      // A persisted review is started only against the exact tree it recorded; nothing is recomputed or rewritten.
      const resolved = await resolveGoalRepository(this.db, goalId);
      if (!resolved.ok) return 'git_state_invalid';
      if (resolved.state.head !== head || resolved.state.tree !== expectedTree) return 'review_base_moved';
    }
    return null;
  }

  private async tickReviewing(goalId: string): Promise<TickResult> {
    const cycle = activeCycle(this.db, goalId);
    if (!cycle || cycle.kind !== 'review')
      return this.reviewDecision(goalId, undefined, 'review_cycle_missing');
    if (this.isSuperseded(goalId, cycle)) {
      const result = await this.tickSuperseded(goalId, cycle);
      if (result.action === 'superseded_cycle_retired')
        return this.reviewDecision(goalId, cycle.id, 'definition_superseded');
      return result;
    }
    const plan = readReviewPlan(cycle.outcome);
    if (!plan) return this.reviewInfraFailure(goalId, cycle, 'review_plan_invalid');
    switch (cycle.status) {
      case 'planned':
        transitionCycle(this.db, { cycleId: cycle.id, to: 'launching', now: this.now() });
        return { action: 'launch_started', goalId, cycleId: cycle.id };
      case 'launching':
        return this.reviewLaunching(goalId, cycle, plan);
      case 'running':
        return this.reviewRunning(goalId, cycle);
      case 'collecting':
        return this.reviewCollecting(goalId, cycle);
      default:
        return this.reviewInfraFailure(goalId, cycle, 'review_state_invalid');
    }
  }

  /**
   * The restart-safe launch order: cycle exists -> review run queued -> immutable Goal review bound to the cycle, the
   * queued run and the exact repository state -> ONLY THEN is the run started. Each tick does one step and re-derives
   * its position from persisted rows (run absent / run without a review row / bound review with a queued run), so a
   * crash between any two steps resumes without a duplicate run or review row.
   */
  private async reviewLaunching(goalId: string, cycle: CycleRow, plan: ReviewPlan): Promise<TickResult> {
    const run = this.runForPurpose(cycle.id, 'review');
    const review = reviewForCycle(this.db, cycle.id);
    if (!run) {
      if (review) return this.reviewInfraFailure(goalId, cycle, 'review_binding_invalid');
      const problem = await this.reviewRefProblem(goalId, cycle);
      if (problem) return this.reviewInfraFailure(goalId, cycle, problem);
      try {
        await this.executor.queueReviewRun({
          goalId,
          cycleId: cycle.id,
          baseCommit: cycle.baseIntegrationCommit!,
          reviewKind: plan.reviewKind,
          reviewRole: reviewRoleForKind(plan.reviewKind),
          reviewerCount: plan.reviewerCount,
        });
      } catch (error) {
        const first = this.firstUseFailure(error);
        if (first) {
          // A reviewing Goal cannot enter `gate_pending`: the exact pool member is surfaced as a typed approval request
          // and the Goal goes to the user with the cycle still active. Nothing is substituted and nothing is queued.
          const approval = this.ensureFirstUseApproval(goalId, first);
          return this.reviewDecision(goalId, cycle.id, 'approval_required', {
            approvalId: approval.id,
            gate: 'pool_route_first_use',
            role: first.role,
          });
        }
        const queueCode = (error as { code?: unknown } | null)?.code;
        return this.reviewInfraFailure(goalId, cycle, 'review_queue_error', {
          detail: { queueCode: typeof queueCode === 'string' ? queueCode.slice(0, 80) : 'unknown' },
        });
      }
      return { action: 'review_run_queued', goalId, cycleId: cycle.id };
    }
    // A run without its immutable review record cannot arise from the atomic queue+bind; if a historical or corrupt
    // state holds one, it fails closed: nothing is adopted, started or re-queued.
    if (!review) return this.reviewInfraFailure(goalId, cycle, 'review_binding_missing');
    if (
      review.runId !== run.id ||
      review.cycleId !== cycle.id ||
      review.status !== 'pending' ||
      review.reviewKind !== plan.reviewKind ||
      review.definitionVersion !== cycle.definitionVersion ||
      review.reviewedToCommit !== cycle.baseIntegrationCommit ||
      !reviewMatchesCyclePlan(review, cycle)
    )
      return this.reviewInfraFailure(goalId, cycle, 'review_binding_invalid');
    if (PAUSED_RUN.has(run.status)) return this.reviewPause(goalId, cycle, run);
    if (run.status === 'queued') {
      const problem = await this.reviewRefProblem(goalId, cycle, review.reviewedToTree);
      if (problem) return this.reviewInfraFailure(goalId, cycle, problem);
      const started = this.deps.startRun(run.id);
      if (!started.started && started.reason === 'not-found')
        return this.reviewInfraFailure(goalId, cycle, 'run_not_found');
      if (!started.started && started.reason === 'not-queued') {
        const current = this.runById(run.id);
        if (!current) return this.reviewInfraFailure(goalId, cycle, 'run_not_found');
        if (PAUSED_RUN.has(current.status)) return this.reviewPause(goalId, cycle, current);
        if (!ACTIVE_RUN.has(current.status) && !TERMINAL_RUN.has(current.status))
          return this.reviewInfraFailure(goalId, cycle, 'run_state_invalid', {
            detail: { runStatus: current.status },
          });
      }
    }
    transitionCycle(this.db, { cycleId: cycle.id, to: 'running', now: this.now() });
    return { action: 'review_run_started', goalId, cycleId: cycle.id };
  }

  /** A paused review run is the user's decision; the cycle stays active and a resume restores `reviewing`. */
  private reviewPause(goalId: string, cycle: CycleRow, run: RunRow): TickResult {
    return this.reviewDecision(goalId, cycle.id, 'run_paused', { runId: run.id });
  }

  private async reviewRunning(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const run = this.runForPurpose(cycle.id, 'review');
    if (!run) return this.reviewInfraFailure(goalId, cycle, 'run_missing');
    if (PAUSED_RUN.has(run.status)) return this.reviewPause(goalId, cycle, run);
    if (run.status === 'queued' || ACTIVE_RUN.has(run.status))
      return { action: 'review_waiting', goalId, cycleId: cycle.id };
    transitionCycle(this.db, { cycleId: cycle.id, to: 'collecting', now: this.now() });
    return { action: 'collection_started', goalId, cycleId: cycle.id };
  }

  private async reviewCollecting(goalId: string, cycle: CycleRow): Promise<TickResult> {
    const run = this.runForPurpose(cycle.id, 'review');
    if (!run) return this.reviewInfraFailure(goalId, cycle, 'run_missing');
    if (FAILED_RUN.has(run.status))
      return this.reviewInfraFailure(goalId, cycle, 'run_failed', { detail: { runStatus: run.status } });
    if (CANCELLED_RUN.has(run.status))
      return this.reviewInfraFailure(goalId, cycle, 'run_cancelled', { cancelled: true });
    if (run.status !== 'completed') return { action: 'review_waiting', goalId, cycleId: cycle.id };
    return this.consumeReview(goalId, cycle, run);
  }

  /**
   * Consumes a completed review run, restart-safely: every step re-derives its position from persisted rows, so a crash
   * between any two resumes without repeating or skipping work.
   *   report read strictly -> server-derived independence -> completeReview -> applyReviewFindings (once per review)
   *   -> review_verdict evidence (reused, never duplicated) -> run_evidence_collected marker + cycle `succeeded` +
   *   the Goal's `review_passed` / `review_blocked`, in ONE transaction -> best-effort worktree prune.
   * A semantic `block` is a successful review cycle; only infrastructure problems fail it (no report is fabricated).
   */
  private async consumeReview(goalId: string, cycle: CycleRow, run: RunRow): Promise<TickResult> {
    let review = reviewForCycle(this.db, cycle.id);
    if (!review || review.runId !== run.id)
      return this.reviewInfraFailure(goalId, cycle, 'review_binding_invalid');
    if (review.status === 'failed' || review.status === 'cancelled')
      return this.reviewInfraFailure(goalId, cycle, 'review_state_invalid');

    if (review.status === 'pending') {
      const read = readGoalReviewReport(this.db, run.id);
      if (!read.ok)
        return this.reviewInfraFailure(goalId, cycle, 'review_report_invalid', {
          detail: { reason: read.code, ...(read.issues ? { issues: read.issues } : {}) },
        });
      const derived = deriveReviewIndependence(this.db, review);
      if (!derived.ok)
        return this.reviewInfraFailure(goalId, cycle, 'review_independence_unproven', {
          detail: { reason: derived.code },
        });
      try {
        review = completeReview(this.db, {
          reviewId: review.id,
          report: read.report,
          ...(derived.independence ? { independence: derived.independence } : {}),
          now: this.now(),
        });
      } catch (error) {
        if (!(error instanceof GoalReviewError)) throw error;
        // `review_not_pending` means a concurrent consumer completed it: re-read and carry on.
        const current = reviewForCycle(this.db, cycle.id);
        if (error.code !== 'review_not_pending' || current?.status !== 'completed')
          return this.reviewInfraFailure(goalId, cycle, 'review_report_invalid', {
            detail: { reason: error.code },
          });
        review = current;
      }
    }
    const report = review.report;
    if (!report) return this.reviewInfraFailure(goalId, cycle, 'review_state_invalid');

    // The links are a pure function of this run's persisted rows, so a restart derives exactly the ones used before.
    const links = linkRunFindings(this.db, run.id, report);
    if (!links.ok)
      return this.reviewInfraFailure(goalId, cycle, 'review_report_invalid', {
        detail: { reason: links.code },
      });
    let stale = !isReviewCurrent(this.db, review);
    const applied = this.db
      .prepare(
        "SELECT 1 FROM goal_events WHERE goal_id = ? AND type = 'review_findings_applied' AND json_extract(payload_json, '$.reviewId') = ?",
      )
      .get(goalId, review.id);
    if (!stale && !applied) {
      try {
        await applyReviewFindings(this.db, {
          reviewId: review.id,
          runFindingIds: { new: links.ids },
          now: this.now(),
        });
      } catch (error) {
        if (!(error instanceof GoalFindingError)) throw error;
        if (error.code === 'review_not_current') stale = true;
        else if (error.code !== 'review_findings_already_applied')
          return this.reviewInfraFailure(goalId, cycle, 'review_apply_failed', {
            detail: { reason: error.code },
          });
      }
    }

    if (!stale) {
      await recordReviewEvidence(this.db, { review, cycle, runId: run.id, now: this.now() });
    }
    const blocking = !stale && review.blocking === true;
    this.db.transaction(() => {
      const stored = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? AND run_id = ?')
          .get(goalId, run.id) as { n: number }
      ).n;
      recordRunEvidenceCollected(this.db, { goalId, runId: run.id, evidenceCount: stored, now: this.now() });
      finalizeCycle(this.db, {
        cycleId: cycle.id,
        to: 'succeeded',
        outcomeCode: stale ? 'review_stale' : 'review_consumed',
        detail: { reviewId: review.id, verdict: review.verdict, blocking, stale },
        now: this.now(),
      });
      transitionGoal(this.db, {
        goalId,
        to: blocking ? 'blocked' : 'running',
        reasonCode: blocking ? 'review_blocked' : stale ? 'review_stale' : 'review_passed',
        actor: 'supervisor',
        detail: { cycleId: cycle.id, reviewId: review.id, verdict: review.verdict, stale },
        now: this.now(),
      });
    })();
    this.tracker.sync(goalId);
    this.afterCycle(goalId);
    const cleanup = await this.tryPrune(run.id);
    return {
      action: 'review_consumed',
      goalId,
      cycleId: cycle.id,
      code: stale ? 'review_stale' : blocking ? 'review_blocked' : 'review_passed',
      runId: run.id,
      ...(cleanup ? { cleanup } : {}),
    };
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
      if (goal.status === 'reviewing') {
        // The review tick verifies the ref itself (a ref problem fails the review cycle, it cannot block a reviewing Goal).
        results.push(await this.tickGoal(goal.id));
        continue;
      }
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
    results.push(...(await this.maintainEvidence()));
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
