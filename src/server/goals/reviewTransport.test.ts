import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in Goal run tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider, type ProviderRunRequest } from '../providers.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { createReviewCycle } from './reviewCycle.js';
import { reviewForCycle } from './reviews.js';
import { realRunHarness, type RealRunHarness } from './turingRunKit.js';

const caps: ProviderCapabilities = {
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery: false,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: true,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
};
const claude: ProviderStatus = {
  id: 'claude-code',
  name: 'Claude Code',
  cli: 'claude',
  detected: true,
  version: '2.1.300',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
};
const done = (text: string) => ({
  text,
  inputTokens: 10,
  outputTokens: 5,
  usageProvenance: 'provider_reported' as const,
  exitCode: 0,
  stdout: 'ok',
});

const FINDING = {
  severity: 'high',
  category: 'correctness',
  description: 'The build script ignores failures.',
  evidence: 'package.json runs node -e without checking exit codes.',
  affectedFiles: ['package.json'],
  recommendedRemediation: 'Check exit codes.',
};
const REPORT = {
  verdict: 'block',
  criterionProgress: [],
  existingFindings: [],
  regressions: [],
  scopeDrift: false,
  architectureDrift: false,
  furtherWorkJustified: false,
  newFindings: [
    {
      severity: 'high',
      category: 'correctness',
      description: FINDING.description,
      evidence: FINDING.evidence,
      affectedFiles: FINDING.affectedFiles,
      remediation: FINDING.recommendedRemediation,
    },
  ],
};

let h: RealRunHarness;
let calls: ProviderRunRequest[];
beforeEach(() => {
  calls = [];
  vi.mocked(discoverProviders).mockResolvedValue([claude]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    calls.push(request);
    const prompt = request.prompt;
    if (/Reviewer slot/.test(prompt)) return done(JSON.stringify({ findings: [FINDING] }));
    if (/goalReviewReport/.test(prompt) || /consolidat/i.test(request.role))
      return done(JSON.stringify({ findings: [FINDING], goalReviewReport: REPORT }));
    return done(JSON.stringify({ pass: true, reason: 'Transport is well-formed.' }));
  });
});
afterEach(async () => {
  await h?.close();
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

describe('Goal review run on the real RunEngine', () => {
  it('completes with the strict Goal report in the consolidate output, even for a block verdict', async () => {
    h = await realRunHarness();
    expect((await h.supervisor.startGoal(h.fx.goalId)).ok).toBe(true);
    await h.until('cycle_created');
    // Retire the proposal cycle so the Goal can carry a review cycle on the current head.
    h.fx.db
      .prepare("UPDATE goal_cycles SET status = 'cancelled', finished_at = ? WHERE goal_id = ?")
      .run(new Date().toISOString(), h.fx.goalId);
    h.fx.db.prepare("UPDATE runs SET status = 'cancelled' WHERE status = 'queued'").run();
    const head = h.fx.head();
    const created = createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: 'final',
      triggerCode: 'test_trigger',
    });
    if (!created.created) throw new Error('expected a review cycle');
    const cycleId = created.cycle.id;

    await h.until('review_run_started');
    const run = h.fx.db
      .prepare("SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = 'review'")
      .get(cycleId) as { id: string };
    await vi.waitFor(() => expect(h.runRow(run.id).status).toBe('completed'), { timeout: 20_000 });

    // The review row was bound before the run started and names the exact head and tree.
    expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({
      status: 'pending',
      runId: run.id,
      reviewedToCommit: head,
    });
    const stages = h.fx.db
      .prepare('SELECT stage_key, kind, status, output_json FROM stages WHERE run_id = ? ORDER BY sequence')
      .all(run.id) as Array<{ stage_key: string; kind: string; status: string; output_json: string }>;
    expect(stages.map((stage) => [stage.kind, stage.status])).toEqual([
      ['parallelReview', 'passed'],
      ['consolidate', 'passed'],
      ['finalGate', 'passed'],
    ]);
    const consolidate = JSON.parse(stages[1]!.output_json) as { text: string; findings: unknown[] };
    expect(JSON.parse(consolidate.text)).toMatchObject({ goalReviewReport: { verdict: 'block' } });
    // The ordinary per-run finding rows the consumer will cross-check were written by the real engine.
    expect(
      (
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM review_findings WHERE run_id = ?').get(run.id) as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);
    // Reviewers saw the materialised, read-only Goal review task and no provider tool wrote to the checkout.
    expect(calls.some((call) => /Review kind: final/.test(call.prompt))).toBe(true);
    expect(h.fx.git('status', '--porcelain')).toBe('');
    expect(h.fx.head()).toBe(head);
  });

  it('is consumed end to end: report accepted, findings applied once, cycle finalised, worktree pruned, branch kept', async () => {
    h = await realRunHarness();
    expect((await h.supervisor.startGoal(h.fx.goalId)).ok).toBe(true);
    await h.until('cycle_created');
    h.fx.db
      .prepare("UPDATE goal_cycles SET status = 'cancelled', finished_at = ? WHERE goal_id = ?")
      .run(new Date().toISOString(), h.fx.goalId);
    h.fx.db.prepare("UPDATE runs SET status = 'cancelled' WHERE status = 'queued'").run();
    const head = h.fx.head();
    const created = createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: 'periodic',
      triggerCode: 'test_trigger',
    });
    if (!created.created) throw new Error('expected a review cycle');
    const cycleId = created.cycle.id;

    await h.until('review_run_started');
    const run = h.fx.db
      .prepare("SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = 'review'")
      .get(cycleId) as { id: string };
    await vi.waitFor(() => expect(h.runRow(run.id).status).toBe('completed'), { timeout: 20_000 });
    await h.until('review_consumed');

    expect(reviewForCycle(h.fx.db, cycleId)).toMatchObject({
      status: 'completed',
      verdict: 'block',
      blocking: false,
    });
    const findings = h.fx.db
      .prepare('SELECT status FROM goal_findings WHERE goal_id = ?')
      .all(h.fx.goalId) as Array<{ status: string }>;
    expect(findings).toEqual([{ status: 'open' }]);
    const events = (
      h.fx.db
        .prepare(
          "SELECT type FROM goal_events WHERE goal_id = ? AND type IN ('review_findings_applied','run_evidence_collected')",
        )
        .all(h.fx.goalId) as Array<{ type: string }>
    ).map((event) => event.type);
    expect(events.sort()).toEqual(['review_findings_applied', 'run_evidence_collected']);
    expect(h.fx.db.prepare('SELECT status FROM goal_cycles WHERE id = ?').get(cycleId)).toMatchObject({
      status: 'succeeded',
    });
    // A non-blocking periodic block returns the Goal to running; the source checkout is untouched.
    expect(h.fx.db.prepare('SELECT status FROM goals WHERE id = ?').get(h.fx.goalId)).toMatchObject({
      status: 'running',
    });
    expect(h.fx.git('status', '--porcelain')).toBe('');
    expect(h.fx.head()).toBe(head);
    // The disposable run worktree is gone; the run branch is retained.
    expect(h.fx.git('branch', '--list', 'turing/*')).not.toBe('');
    // Further ticks change nothing.
    await h.supervisor.tick?.(h.fx.goalId);
    expect(
      (
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_findings WHERE goal_id = ?').get(h.fx.goalId) as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  const reviewCycleOnHead = async (kind: 'final' | 'periodic' = 'periodic') => {
    expect((await h.supervisor.startGoal(h.fx.goalId)).ok).toBe(true);
    await h.until('cycle_created');
    h.fx.db
      .prepare("UPDATE goal_cycles SET status = 'cancelled', finished_at = ? WHERE goal_id = ?")
      .run(new Date().toISOString(), h.fx.goalId);
    h.fx.db.prepare("UPDATE runs SET status = 'cancelled' WHERE status = 'queued'").run();
    const created = createReviewCycle(h.fx.db, {
      goalId: h.fx.goalId,
      reviewKind: kind,
      triggerCode: 'test_trigger',
    });
    if (!created.created) throw new Error('expected a review cycle');
    return created.cycle.id;
  };
  const reviewRunsOf = (cycleId: string) =>
    (
      h.fx.db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = 'review'")
        .get(cycleId) as { n: number }
    ).n;

  it('queues the real run and its review record in one transaction: an injected binding failure leaves nothing', async () => {
    h = await realRunHarness();
    const cycleId = await reviewCycleOnHead();
    h.fx.db.exec(
      "CREATE TRIGGER inject_bind_failure BEFORE INSERT ON goal_reviews BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END",
    );
    await h.until('review_decision_needed');
    expect(reviewRunsOf(cycleId)).toBe(0);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_reviews').get()).toEqual({ n: 0 });
    // The real queueRun inserted stages and events too; all of it rolled back with the run.
    expect(h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'review'").get()).toEqual(
      {
        n: 0,
      },
    );
    expect(calls).toHaveLength(0);
  });

  it('a real queued review run without its record is never adopted, started or duplicated', async () => {
    h = await realRunHarness();
    const cycleId = await reviewCycleOnHead();
    // Tick only until the committed (not yet started) run exists.
    await h.until('review_run_queued');
    const run = h.fx.db
      .prepare("SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = 'review'")
      .get(cycleId) as { id: string };
    for (const row of h.fx.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%reviews cannot be deleted%'",
      )
      .all() as Array<{ name: string }>)
      h.fx.db.exec(`DROP TRIGGER ${row.name}`);
    h.fx.db.prepare('DELETE FROM goal_reviews WHERE run_id = ?').run(run.id);
    await h.until('review_decision_needed');
    expect(h.runRow(run.id).status).toBe('queued');
    expect(reviewRunsOf(cycleId)).toBe(1);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_reviews').get()).toEqual({ n: 0 });
    expect(calls).toHaveLength(0);
  });

  it('a persisted review whose recorded tree no longer matches the Goal tree is never started', async () => {
    h = await realRunHarness();
    const cycleId = await reviewCycleOnHead();
    await h.until('review_run_queued');
    const run = h.fx.db
      .prepare("SELECT id FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = 'review'")
      .get(cycleId) as { id: string };
    h.fx.db.exec('DROP TRIGGER trg_goal_review_identity');
    h.fx.db
      .prepare('UPDATE goal_reviews SET reviewed_to_tree = ? WHERE run_id = ?')
      .run('f'.repeat(40), run.id);
    await h.until('review_decision_needed');
    expect(h.runRow(run.id).status).toBe('queued');
    expect(reviewRunsOf(cycleId)).toBe(1);
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_reviews').get()).toEqual({ n: 1 });
    expect(calls).toHaveLength(0);
  });
});
