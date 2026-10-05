import type {
  ChildRunRequest,
  GoalExecutor,
  ProposalRequest,
  ProposalResult,
  RouteReadiness,
} from './executor.js';

/**
 * TEST-ONLY executor. It is never imported by production code, is excluded from the server build, and no setting or
 * environment variable selects it. Scripted proposals and a caller-supplied run factory stand in for model work.
 */
export class FakeGoalExecutor implements GoalExecutor {
  readonly id = 'fake';
  readiness: RouteReadiness = { ready: true };
  readonly proposals: Array<ProposalResult | ((request: ProposalRequest) => ProposalResult)> = [];
  readonly proposeCalls: ProposalRequest[] = [];
  readonly queueCalls: ChildRunRequest[] = [];
  private readonly queued = new Map<string, string>();

  constructor(
    /** Persists a queued run for the request (tests create it with the Git harness) and returns its id. */
    private readonly makeRun: (request: ChildRunRequest) => string,
  ) {}

  async checkRoutes(): Promise<RouteReadiness> {
    return this.readiness;
  }

  async propose(request: ProposalRequest): Promise<ProposalResult> {
    this.proposeCalls.push(request);
    const next = this.proposals.shift();
    if (next === undefined) return { ok: false, code: 'no_scripted_proposal' };
    return typeof next === 'function' ? next(request) : next;
  }

  async queueChildRun(request: ChildRunRequest): Promise<{ runId: string }> {
    this.queueCalls.push(request);
    const key = `${request.cycleId}:${request.purpose}`;
    const existing = this.queued.get(key);
    if (existing) return { runId: existing };
    const runId = this.makeRun(request);
    this.queued.set(key, runId);
    return { runId };
  }
}
