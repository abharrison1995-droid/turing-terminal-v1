import type {
  BlockedReason,
  GoalMilestoneSpec,
  GoalReviewKind,
  GoalRole,
  NextTask,
} from '../../shared/goals.js';
import type { GoalMemory } from './memory.js';
import type { GoalReviewRole } from './reviewRole.js';

/**
 * The only seam between the supervisor and model-backed work. The supervisor owns every decision and every state
 * transition; an executor can only report route readiness, persist queued proposal and child runs, and read back the
 * untrusted structured output of a finished proposal run. It is never handed a way to change a Goal or cycle status,
 * and it never starts a run: the supervisor starts each persisted run exactly once.
 *
 * Production uses `DisabledGoalExecutor`. `TuringGoalExecutor` (child-run workflows over resolved routes) implements
 * this interface but is used only by tests; nothing here launches a provider call.
 */
export type RouteReadiness =
  | { ready: true }
  | {
      ready: false;
      code: Extract<BlockedReason, 'route_unavailable' | 'provider_unavailable' | 'provider_exhausted'>;
      message: string;
    }
  | {
      /** A pool member that has never been used by this Goal needs the user's first-use approval (supervisor gate). */
      ready: false;
      code: 'approval_required' | 'approval_pending';
      message: string;
      approval: FirstUseRequest;
    };

/** The exact pool member that needs first-use approval. Bounded, finite fields only. */
export interface FirstUseRequest {
  poolId: string;
  memberIdentityHash: string;
  role: GoalRole;
  memberIndex: number;
  /** The existing pending approval, when there already is one. */
  approvalId?: string;
}

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
export type GoalRunPurpose = 'proposal' | 'execution' | 'review' | 'remediation' | 'verification';

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

/**
 * A read-only Goal review run of a review cycle. The reviewer role is derived from the review kind by the one shared
 * server mapping (`reviewRoleForKind`); the executor refuses a request whose role disagrees, and recomputes the reviewer
 * count from the approved definition and the registered workflow. Nothing about the route, billing or workflow comes
 * from the request.
 */
export interface ReviewRunRequest {
  goalId: string;
  cycleId: string;
  baseCommit: string;
  reviewKind: GoalReviewKind;
  reviewRole: GoalReviewRole;
  reviewerCount: number;
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
  /**
   * Persists a `queued` review run for (cycle, 'review'), idempotently, without starting it. The supervisor binds an
   * immutable Goal review row to the queued run BEFORE it starts the run.
   */
  queueReviewRun(request: ReviewRunRequest): Promise<{ runId: string }>;
}

/** The production executor: never ready, never queues a proposal or child run. No provider work can start. */
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

  async queueReviewRun(): Promise<{ runId: string }> {
    throw new Error('Goal execution is not enabled in this build.');
  }
}
