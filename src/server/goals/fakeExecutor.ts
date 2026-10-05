import type { Db } from '../db.js';
import type {
  ChildRunRequest,
  GoalExecutor,
  GoalRunPurpose,
  ProposalRequest,
  ProposalResult,
  RouteReadiness,
} from './executor.js';

/** What the run factory is asked to persist as a `queued` run. */
export interface FakeRunRequest {
  goalId: string;
  cycleId: string;
  purpose: GoalRunPurpose;
  baseCommit: string;
}

/**
 * TEST-ONLY executor. It is never imported by production code, is excluded from the server build, and no setting or
 * environment variable selects it.
 *
 * It models the Stage 4 contract: every proposal and child run is an ordinary persisted run, queueing is idempotent per
 * (cycle, purpose) and answered from the database (so a brand-new executor instance returns the same run), and a
 * proposal is read back from the run's persisted stage output (`stages.output_json.text`), never from memory. Nothing
 * here calls a model: tests complete runs themselves.
 */
export class FakeGoalExecutor implements GoalExecutor {
  readonly id = 'fake';
  readiness: RouteReadiness = { ready: true };
  readonly proposalQueueCalls: ProposalRequest[] = [];
  readonly queueCalls: ChildRunRequest[] = [];
  readonly readCalls: string[] = [];
  /** Opt-in: tests that need verification cycles assign it; without it none is ever scheduled. */
  queueVerificationRun?: GoalExecutor['queueVerificationRun'];

  constructor(
    private readonly db: Db,
    /** Persists a queued run for the request (tests create it with the Git harness) and returns its id. */
    private readonly makeRun: (request: FakeRunRequest) => string,
  ) {}

  async checkRoutes(): Promise<RouteReadiness> {
    return this.readiness;
  }

  private existing(cycleId: string, purpose: GoalRunPurpose): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = ?')
      .get(cycleId, purpose) as { id: string } | undefined;
    return row?.id;
  }

  async queueProposalRun(request: ProposalRequest): Promise<{ runId: string }> {
    this.proposalQueueCalls.push(request);
    const runId =
      this.existing(request.cycleId, 'proposal') ??
      this.makeRun({
        goalId: request.goalId,
        cycleId: request.cycleId,
        purpose: 'proposal',
        baseCommit: request.baseCommit,
      });
    return { runId };
  }

  async readProposal(runId: string): Promise<ProposalResult> {
    this.readCalls.push(runId);
    const stage = this.db
      .prepare(
        "SELECT output_json FROM stages WHERE run_id = ? AND status = 'passed' ORDER BY sequence DESC LIMIT 1",
      )
      .get(runId) as { output_json: string | null } | undefined;
    if (!stage?.output_json) return { ok: false, code: 'proposal_output_missing' };
    try {
      const output = JSON.parse(stage.output_json) as { text?: unknown };
      if (typeof output.text !== 'string') return { ok: false, code: 'proposal_output_missing' };
      return { ok: true, proposal: JSON.parse(output.text) as unknown };
    } catch {
      return { ok: false, code: 'proposal_output_unparsable' };
    }
  }

  async queueChildRun(request: ChildRunRequest): Promise<{ runId: string }> {
    this.queueCalls.push(request);
    const runId =
      this.existing(request.cycleId, request.purpose) ??
      this.makeRun({
        goalId: request.goalId,
        cycleId: request.cycleId,
        purpose: request.purpose,
        baseCommit: request.baseCommit,
      });
    return { runId };
  }
}
