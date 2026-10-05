import type { BlockedReason, GoalMilestoneSpec, NextTask } from '../../shared/goals.js';
import type { GoalMemory } from './memory.js';

/**
 * The only seam between the supervisor and model-backed work. The supervisor owns every decision and every state
 * transition; an executor can only report route readiness, persist queued proposal and child runs, and read back the
 * untrusted structured output of a finished proposal run. It is never handed a way to change a Goal or cycle status,
 * and it never starts a run: the supervisor starts each persisted run exactly once.
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
  /** The Goal integration head the proposal is made against. */
  baseCommit: string;
  memory: GoalMemory;
}

/**
 * What `readProposal` extracts from a finished proposal run. `proposal` is untrusted: the supervisor validates it with
 * `validateNextTask` before anything acts on it. `ok: false` means the run finished without usable structured output.
 */
export type ProposalResult = { ok: true; proposal: unknown } | { ok: false; code: string };

export interface ChildRunRequest {
  goalId: string;
  cycleId: string;
  purpose: 'execution' | 'remediation';
  task: NextTask;
  baseCommit: string;
}

/** The runs a cycle can own. One run per (cycle, purpose) is enforced by a unique index. */
export type GoalRunPurpose = 'proposal' | 'execution' | 'remediation' | 'verification';

/**
 * A deterministic verification run: only the listed build/test/lint verifiers (by digest) of the cycle's milestone,
 * run against the exact Goal head the cycle captured. No model, no route.
 */
export interface VerificationRunRequest {
  goalId: string;
  cycleId: string;
  baseCommit: string;
  verifierDigests: string[];
}

export interface GoalExecutor {
  /** Identifies the implementation in logs and tests. */
  readonly id: string;
  /** Whether the routes the approved definition needs are usable. Production must never claim readiness it lacks. */
  checkRoutes(goalId: string): Promise<RouteReadiness>;
  /**
   * Persists a `queued` proposal run for (cycle, 'proposal') and returns its id, idempotently: asking again returns the
   * existing run. It must not start the run and must never wait for provider completion. There is deliberately no
   * method that calls a model "now": a proposal exists only as a persisted run whose output survives a restart.
   */
  queueProposalRun(request: ProposalRequest): Promise<{ runId: string }>;
  /**
   * Reads the already-persisted structured output of a completed proposal run. It performs no provider call, starts no
   * run and mutates no Goal or cycle state.
   */
  readProposal(runId: string): Promise<ProposalResult>;
  /**
   * Persists a `queued` child run for (cycle, purpose) and returns its id, idempotently: asking again for the same
   * (cycle, purpose) returns the same run. It must not start the run; the supervisor starts it exactly once.
   */
  queueChildRun(request: ChildRunRequest): Promise<{ runId: string }>;
  /**
   * Optional: persists a `queued` deterministic verification run for (cycle, 'verification'), idempotently, without
   * starting it. An executor that omits it simply never gets verification cycles scheduled (the disabled production
   * executor omits it).
   */
  queueVerificationRun?(request: VerificationRunRequest): Promise<{ runId: string }>;
}

/** Production executor for Stage 3/3.1: never ready, never queues a proposal or child run. No provider work can start. */
export class DisabledGoalExecutor implements GoalExecutor {
  readonly id = 'disabled';

  async checkRoutes(): Promise<RouteReadiness> {
    return {
      ready: false,
      code: 'route_unavailable',
      message: 'Goal execution is not enabled in this build.',
    };
  }

  async queueProposalRun(): Promise<{ runId: string }> {
    throw new Error('Goal execution is not enabled in this build.');
  }

  async readProposal(): Promise<ProposalResult> {
    return { ok: false, code: 'executor_disabled' };
  }

  async queueChildRun(): Promise<{ runId: string }> {
    throw new Error('Goal execution is not enabled in this build.');
  }
}
