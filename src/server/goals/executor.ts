import type { BlockedReason, GoalMilestoneSpec, NextTask } from '../../shared/goals.js';
import type { GoalMemory } from './memory.js';

/**
 * The only seam between the supervisor and model-backed work. The supervisor owns every decision and every state
 * transition; an executor can only report route readiness, offer an untrusted proposal, and persist a queued child run.
 * It receives no database handle, no Git access and no way to change a Goal or cycle status.
 *
 * Stage 3 ships a deliberately disabled production executor. Real child-run workflows (Stage 4) and route resolution
 * (Stage 5) implement this interface later; nothing here launches a provider call.
 */
export type RouteReadiness =
  | { ready: true }
  | {
      ready: false;
      code: Extract<BlockedReason, 'route_unavailable' | 'provider_unavailable' | 'provider_exhausted'>;
      message: string;
    };

export interface ProposalRequest {
  goalId: string;
  cycleId: string;
  definitionVersion: number;
  milestone: GoalMilestoneSpec;
  memory: GoalMemory;
}

/** `proposal` is untrusted: the supervisor validates it with `validateNextTask` before anything acts on it. */
export type ProposalResult = { ok: true; proposal: unknown } | { ok: false; code: string };

export interface ChildRunRequest {
  goalId: string;
  cycleId: string;
  purpose: 'execution' | 'remediation';
  task: NextTask;
  baseCommit: string;
}

export interface GoalExecutor {
  /** Identifies the implementation in logs and tests. */
  readonly id: string;
  /** Whether the routes the approved definition needs are usable. Production must never claim readiness it lacks. */
  checkRoutes(goalId: string): Promise<RouteReadiness>;
  propose(request: ProposalRequest): Promise<ProposalResult>;
  /**
   * Persists a `queued` child run for (cycle, purpose) and returns its id, idempotently: asking again for the same
   * (cycle, purpose) returns the same run. It must not start the run; the supervisor starts it exactly once.
   */
  queueChildRun(request: ChildRunRequest): Promise<{ runId: string }>;
}

/** Production executor for Stage 3: never ready, never proposes, never queues. No provider work can start. */
export class DisabledGoalExecutor implements GoalExecutor {
  readonly id = 'disabled';

  async checkRoutes(): Promise<RouteReadiness> {
    return {
      ready: false,
      code: 'route_unavailable',
      message: 'Goal execution is not enabled in this build.',
    };
  }

  async propose(): Promise<ProposalResult> {
    return { ok: false, code: 'executor_disabled' };
  }

  async queueChildRun(): Promise<{ runId: string }> {
    throw new Error('Goal execution is not enabled in this build.');
  }
}
