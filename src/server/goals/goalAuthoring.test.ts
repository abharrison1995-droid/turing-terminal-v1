import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in Goal authoring tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider, type ProviderRunRequest } from '../providers.js';
import { startQueuedRun } from '../runLauncher.js';
import { queryUsageAnalytics } from '../usageAnalytics.js';
import {
  AUTHORING_LIMITS,
  AuthoringReconciler,
  authoringWorkflow,
  GoalAuthoringError,
  retryGoalAuthoring,
  startGoalAuthoring,
} from './authoring.js';
import { simpleDefinition, cleanupRepoFixtures } from './repoKit.js';
import { inspectRunRetention } from './retention.js';
import { transitionGoal } from './stateMachine.js';
import { METERED_TEST_ROUTE, SUBSCRIPTION_TEST_ROUTE } from './testPlanProvider.js';
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
const claude = (): ProviderStatus => ({
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
});
const done = (text: string) => ({
  text,
  inputTokens: 10,
  outputTokens: 5,
  usageProvenance: 'provider_reported' as const,
  exitCode: 0,
  stdout: 'ok',
});

const GOOD = () => JSON.stringify(simpleDefinition());
const ROUTE = { ...SUBSCRIPTION_TEST_ROUTE };

let h: RealRunHarness;
let calls: ProviderRunRequest[];
let answer: (request: ProviderRunRequest) => Promise<ReturnType<typeof done>>;

beforeEach(() => {
  calls = [];
  vi.mocked(discoverProviders).mockResolvedValue([claude()]);
  answer = async () => done(GOOD());
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    calls.push(request);
    return answer(request);
  });
});

afterEach(async () => {
  await h?.close();
  h = undefined as never;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

const db = () => h.fx.db;
const startRun = (runId: string) => startQueuedRun(db(), h.engine, runId);
const reconciler = () => new AuthoringReconciler(db(), startRun);
const input = (extra: Record<string, unknown> = {}) => ({
  projectId: h.fx.projectId,
  title: 'Parser rewrite',
  prompt: 'Rewrite the parser so it handles nested blocks.',
  route: { ...ROUTE },
  ...extra,
});
const n = (sql: string, ...args: unknown[]) =>
  (
    db()
      .prepare(sql)
      .get(...args) as { n: number }
  ).n;
const counts = () => ({
  goals: n('SELECT COUNT(*) AS n FROM goals'),
  cycles: n('SELECT COUNT(*) AS n FROM goal_cycles'),
  runs: n('SELECT COUNT(*) AS n FROM runs'),
  versions: n('SELECT COUNT(*) AS n FROM goal_definition_versions'),
  events: n('SELECT COUNT(*) AS n FROM goal_events'),
});
const goalRow = (goalId: string) =>
  db().prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown>;
const eventTypes = (goalId: string) =>
  (
    db().prepare('SELECT type FROM goal_events WHERE goal_id = ? ORDER BY rowid').all(goalId) as Array<{
      type: string;
    }>
  ).map((row) => row.type);
const waitRun = (runId: string, status: string) =>
  vi.waitFor(() => expect(h.runRow(runId).status).toBe(status), { timeout: 15_000, interval: 25 });

const begin = async (extra: Record<string, unknown> = {}) => {
  const started = await startGoalAuthoring(db(), input(extra) as never, startRun);
  return started;
};

describe('Goal authoring: creation', () => {
  it('returns 202 immediately with a draft Goal that has no definition, an authoring cycle and one queued run', async () => {
    h = await realRunHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answer = async () => {
      await gate;
      return done(GOOD());
    };
    const before = counts();
    const response = await h.app.inject({ method: 'POST', url: '/api/goals/authoring', payload: input() });
    expect(response.statusCode).toBe(202);
    const { goalId, cycleId, runId } = response.json() as Record<string, string>;
    // The model has not answered yet: the response never waits for it.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(h.runRow(runId).status).not.toBe('completed');

    expect(counts()).toMatchObject({
      goals: before.goals + 1,
      cycles: before.cycles + 1,
      runs: before.runs + 1,
    });
    expect(goalRow(goalId)).toMatchObject({ status: 'draft', current_definition_version: null });
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', goalId)).toBe(0);
    expect(db().prepare('SELECT * FROM goal_cycles WHERE id = ?').get(cycleId)).toMatchObject({
      goal_id: goalId,
      kind: 'authoring',
      sequence: 0,
      definition_version: null,
      milestone_id: null,
      base_integration_commit: null,
      status: 'proposing',
    });
    const run = h.runRow(runId);
    expect(run).toMatchObject({
      goal_cycle_id: cycleId,
      goal_run_purpose: 'authoring',
      goal_base_commit: null,
      workflow_id: 'goal-authoring-v1',
    });
    const stage = db()
      .prepare("SELECT * FROM stages WHERE run_id = ? AND stage_key = 'goal-author'")
      .get(runId);
    expect(stage).toMatchObject({
      backend_id: ROUTE.backendId,
      provider_id: ROUTE.providerId,
      model_id: ROUTE.modelId,
      billing_lane: ROUTE.billingLane,
    });
    expect(eventTypes(goalId)).toEqual(['goal_created', 'cycle_created']);

    // The authoring role stays read-only: the broker refuses a write and the worktree stays clean.
    const refused = await h.broker(calls[0]!.toolBroker.token, 'write_file', {
      path: 'src/x.ts',
      content: 'x',
    });
    expect(refused.error).toBeTruthy();
    release();
    await waitRun(runId, 'completed');
    // Exactly one provider call.
    expect(calls).toHaveLength(1);
  });

  it('refuses every unusable request before writing anything', async () => {
    h = await realRunHarness();
    const before = counts();
    const post = async (payload: unknown) =>
      (await h.app.inject({ method: 'POST', url: '/api/goals/authoring', payload })).statusCode;
    expect(await post(input({ projectId: 'ghost' }))).toBe(404);
    expect(await post(input({ route: { backendId: 'claude-code' } }))).toBe(400);
    expect(await post(input({ route: { ...ROUTE, modelSnapshot: { id: 'forged' } } }))).toBe(400);
    expect(await post(input({ route: { ...ROUTE, permissionMode: 'enigma' } }))).toBe(400);
    expect(await post(input({ goalCycleId: 'c', goalRunPurpose: 'authoring' }))).toBe(400);
    expect(await post(input({ goalId: 'existing' }))).toBe(400);
    expect(await post(input({ prompt: 'x'.repeat(AUTHORING_LIMITS.promptChars + 1) }))).toBe(400);
    expect(await post(input({ title: 'x'.repeat(201) }))).toBe(400);
    // A metered route is refused under the subscriptions-only workflow; nothing else is tried instead.
    expect(await post(input({ route: { ...METERED_TEST_ROUTE } }))).toBe(409);
    // A disconnected provider is refused too.
    vi.mocked(discoverProviders).mockResolvedValue([]);
    expect(await post(input())).toBe(409);
    expect(counts()).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  it('rolls everything back if any part of the atomic step fails', async () => {
    h = await realRunHarness();
    db().exec(`CREATE TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const before = counts();
    await expect(begin()).rejects.toThrow(/boom/);
    expect(counts()).toEqual(before);
    db().exec('DROP TRIGGER fail_run');
    expect(calls).toHaveLength(0);
  });

  it('builds the workflow from the registered built-in with the route on the author stage only', async () => {
    h = await realRunHarness();
    const workflow = authoringWorkflow(db(), ROUTE);
    expect(workflow.id).toBe('goal-authoring-v1');
    expect(workflow.stages).toHaveLength(1);
    expect(workflow.stages[0]).toMatchObject({ id: 'goal-author', kind: 'planner', modelId: ROUTE.modelId });
    expect(workflow.permissionMode).toBe('normal');
    // Forged or behavioural fields are refused outright, never merged.
    for (const forged of [
      { modelSnapshot: {} },
      { permissionMode: 'enigma' },
      { timeoutMinutes: 1 },
      { enabled: false },
    ])
      expect(() => authoringWorkflow(db(), { ...ROUTE, ...forged } as never)).toThrow(GoalAuthoringError);
    expect(() => authoringWorkflow(db(), { backendId: 'claude-code' })).toThrow(GoalAuthoringError);
    // A tampered reserved built-in is refused like in the executor.
    db()
      .prepare("UPDATE workflows SET config_json = '{}', name = 'tampered' WHERE id = 'goal-authoring-v1'")
      .run();
    expect(() => authoringWorkflow(db(), ROUTE)).toThrow(/Reserved Goal workflow|differs/);
  });
});

describe('Goal authoring: consuming the persisted output', () => {
  it('turns a valid definition into proposed v1 after the request has ended, without approving it', async () => {
    h = await realRunHarness();
    const { goalId, cycleId, runId } = await begin();
    await waitRun(runId, 'completed');
    // Nothing consumed it yet: the output lives in the persisted run only.
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', goalId)).toBe(0);
    const summary = await reconciler().reconcile();
    expect(summary.observed).toEqual([expect.objectContaining({ cycleId, state: 'proposed' })]);

    const version = db()
      .prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ?')
      .get(goalId) as Record<string, unknown>;
    expect(version).toMatchObject({
      version: 1,
      status: 'proposed',
      created_by: 'authoring_run',
      parent_version: null,
    });
    expect(version.approved_by).toBeNull();
    expect(version.approval_id).toBeNull();
    expect(goalRow(goalId)).toMatchObject({
      status: 'draft',
      current_definition_version: null,
      status_reason_code: null,
    });
    expect(db().prepare('SELECT status FROM goal_cycles WHERE id = ?').get(cycleId)).toEqual({
      status: 'succeeded',
    });
    expect(eventTypes(goalId)).toEqual([
      'goal_created',
      'cycle_created',
      'definition_proposed',
      'cycle_finished',
      'goal_authoring_completed',
    ]);
    const completed = db()
      .prepare("SELECT payload_json FROM goal_events WHERE type = 'goal_authoring_completed'")
      .get() as { payload_json: string };
    expect(JSON.parse(completed.payload_json)).toEqual({
      cycleId,
      runId,
      version: 1,
      definitionHash: version.definition_hash,
    });
    // No approval of any kind by a model or the system.
    expect(n('SELECT COUNT(*) AS n FROM goal_approvals WHERE goal_id = ?', goalId)).toBe(0);
    expect(eventTypes(goalId)).not.toContain('definition_approved');
    expect(eventTypes(goalId)).not.toContain('state_changed');
    // Repeating the pass changes nothing and calls nothing.
    const after = counts();
    await reconciler().reconcile();
    await reconciler().reconcile();
    expect(counts()).toEqual(after);
    expect(calls).toHaveLength(1);
  });

  it('keeps a structurally valid definition even when semantic validation finds issues', async () => {
    h = await realRunHarness();
    const flawed = simpleDefinition();
    flawed.contract.outcome = '   ';
    answer = async () => done(JSON.stringify(flawed));
    const { goalId, runId } = await begin();
    await waitRun(runId, 'completed');
    await reconciler().reconcile();
    expect(
      n(
        "SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ? AND status = 'proposed'",
        goalId,
      ),
    ).toBe(1);
    // Approval-time validation stays authoritative: approval of this definition is refused.
    const { approveDefinition } = await import('./definitions.js');
    expect(() => approveDefinition(db(), { goalId, version: 1, actor: 'user' })).toThrow();
  });

  it.each([
    ['prose around the JSON', () => `Here you go: ${GOOD()}`, 'output_malformed'],
    ['a code fence', () => '```json\n' + GOOD() + '\n```', 'output_malformed'],
    ['an empty answer', () => '   ', 'output_missing'],
    ['a different JSON shape', () => '{"hello":"world"}', 'output_invalid'],
    ['an array', () => '[]', 'output_invalid'],
    ['an oversize answer', () => 'x'.repeat(AUTHORING_LIMITS.textChars + 1), 'output_oversize'],
  ])('fails closed on %s and keeps the Goal a draft', async (_name, text, code) => {
    h = await realRunHarness();
    answer = async () => done(text());
    const { goalId, cycleId, runId } = await begin();
    await waitRun(runId, 'completed');
    const summary = await reconciler().reconcile();
    expect(summary.observed[0]).toMatchObject({ state: 'failed', code });
    expect(
      db().prepare('SELECT status, outcome_json FROM goal_cycles WHERE id = ?').get(cycleId),
    ).toMatchObject({
      status: 'failed',
    });
    expect(goalRow(goalId)).toMatchObject({
      status: 'draft',
      current_definition_version: null,
      status_reason_code: 'authoring_failed',
    });
    expect(JSON.parse(goalRow(goalId).status_detail_json as string)).toEqual({ code, cycleId, runId });
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', goalId)).toBe(0);
    const failed = db()
      .prepare("SELECT payload_json FROM goal_events WHERE goal_id = ? AND type = 'goal_authoring_failed'")
      .get(goalId) as { payload_json: string };
    expect(JSON.parse(failed.payload_json)).toEqual({ cycleId, runId, code });
    // No raw model output reaches any Goal event or draft detail.
    const everything = JSON.stringify(db().prepare('SELECT payload_json FROM goal_events').all());
    expect(everything).not.toContain('Here you go');
    expect(everything).not.toContain('hello');
    // Idempotent.
    const after = counts();
    await reconciler().reconcile();
    expect(counts()).toEqual(after);
    expect(eventTypes(goalId).filter((type) => type === 'goal_authoring_failed')).toHaveLength(1);
  });

  it('records a provider failure as authoring_failed', async () => {
    h = await realRunHarness();
    answer = async () => {
      throw new Error('provider exploded with secret-token-123');
    };
    const { goalId, runId } = await begin();
    await waitRun(runId, 'failed');
    const summary = await reconciler().reconcile();
    expect(summary.observed[0]).toMatchObject({ state: 'failed', code: 'run_failed' });
    expect(goalRow(goalId)).toMatchObject({ status: 'draft', status_reason_code: 'authoring_failed' });
    expect(JSON.stringify(db().prepare('SELECT payload_json FROM goal_events').all())).not.toContain(
      'secret-token',
    );
  });

  it('records a cancelled run as a cancelled cycle', async () => {
    h = await realRunHarness();
    let release!: () => void;
    answer = () => new Promise((resolve) => (release = () => resolve(done(GOOD()))));
    const { goalId, cycleId, runId } = await begin();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    h.engine.cancel(runId);
    release();
    await waitRun(runId, 'cancelled');
    await reconciler().reconcile();
    expect(db().prepare('SELECT status FROM goal_cycles WHERE id = ?').get(cycleId)).toEqual({
      status: 'cancelled',
    });
    expect(goalRow(goalId)).toMatchObject({ status: 'draft', status_reason_code: 'authoring_failed' });
  });

  it('reads only the persisted planner stage: tampered transcripts and logs are ignored', async () => {
    h = await realRunHarness();
    const { goalId, runId } = await begin();
    await waitRun(runId, 'completed');
    db().prepare('UPDATE stages SET output_json = NULL, logs = ? WHERE run_id = ?').run(GOOD(), runId);
    await reconciler().reconcile();
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', goalId)).toBe(0);
    expect(goalRow(goalId)).toMatchObject({ status_reason_code: 'authoring_failed' });
  });
});

describe('Goal authoring: retry', () => {
  it('allows a retry after a failed attempt with the next sequence, and none once v1 exists', async () => {
    h = await realRunHarness();
    answer = async () => done('not json');
    const first = await begin();
    await waitRun(first.runId, 'completed');
    await reconciler().reconcile();

    answer = async () => done(GOOD());
    const second = await retryGoalAuthoring(
      db(),
      { goalId: first.goalId, prompt: 'Try again.', route: { ...ROUTE } },
      startRun,
    );
    expect(second.goalId).toBe(first.goalId);
    expect(second.cycleId).not.toBe(first.cycleId);
    expect(
      db().prepare('SELECT sequence, trigger_code, status FROM goal_cycles WHERE id = ?').get(second.cycleId),
    ).toEqual({
      sequence: 1,
      trigger_code: 'goal_authoring_retry',
      status: 'proposing',
    });
    // One non-terminal cycle per Goal.
    await expect(
      retryGoalAuthoring(db(), { goalId: first.goalId, prompt: 'again', route: { ...ROUTE } }, startRun),
    ).rejects.toMatchObject({ code: 'authoring_in_progress' });
    await waitRun(second.runId, 'completed');
    await reconciler().reconcile();
    expect(goalRow(first.goalId)).toMatchObject({
      status_reason_code: null,
      current_definition_version: null,
    });
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', first.goalId)).toBe(1);

    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/goals/${first.goalId}/authoring/retry`,
      payload: { prompt: 'again', route: { ...ROUTE } },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'definition_exists' });
    expect(calls).toHaveLength(2);
  });

  it('refuses a retry for an unknown Goal, an empty Goal with no failure, and a Goal that is not a draft', async () => {
    h = await realRunHarness();
    await expect(
      retryGoalAuthoring(db(), { goalId: 'ghost', prompt: 'x', route: { ...ROUTE } }, startRun),
    ).rejects.toMatchObject({ code: 'goal_not_found' });
    // The harness Goal is approved with a definition: never authored again.
    await expect(
      retryGoalAuthoring(db(), { goalId: h.fx.goalId, prompt: 'x', route: { ...ROUTE } }, startRun),
    ).rejects.toMatchObject({ code: 'definition_exists' });
  });
});

describe('Goal authoring: retry is re-proven in the final transaction', () => {
  /** Fails a first attempt, then holds a retry inside its preview until `release()` while `mutate` changes the Goal. */
  async function raced(mutate: (goalId: string) => void) {
    answer = async () => done('not json');
    const first = await begin();
    await waitRun(first.runId, 'completed');
    await reconciler().reconcile();
    const before = { ...counts(), calls: calls.length };

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(discoverProviders).mockImplementationOnce(async () => {
      reached();
      await gate;
      return [claude()];
    });
    const retry = retryGoalAuthoring(
      db(),
      { goalId: first.goalId, prompt: 'again', route: { ...ROUTE } },
      startRun,
    );
    const settled = retry.then(
      () => 'started',
      (error: GoalAuthoringError) => error.code,
    );
    await blocked;
    mutate(first.goalId);
    release();
    return { outcome: await settled, before, first };
  }

  it('refuses a retry whose Goal was abandoned while the preview was being built', async () => {
    h = await realRunHarness();
    const { outcome, before } = await raced((goalId) =>
      transitionGoal(db(), { goalId, to: 'abandoned', reasonCode: 'user_abandoned', actor: 'user' }),
    );
    expect(outcome).toBe('not_retryable');
    expect({ ...counts(), calls: calls.length }).toEqual({ ...before, events: before.events + 1 });
  });

  it('refuses a stale preview when the title or project changed meanwhile, creating nothing', async () => {
    h = await realRunHarness();
    const title = await raced((goalId) =>
      db().prepare("UPDATE goals SET title = 'Renamed' WHERE id = ?").run(goalId),
    );
    expect(title.outcome).toBe('authoring_state_changed');
    expect({ ...counts(), calls: calls.length }).toEqual(title.before);
  });

  it('refuses when a definition appeared while previewing', async () => {
    h = await realRunHarness();
    const { outcome, before } = await raced((goalId) =>
      db()
        .prepare(
          `INSERT INTO goal_definition_versions (goal_id, version, parent_version, status, contract_json, milestones_json, routing_json,
             review_json, limits_json, definition_hash, change_summary, created_by, created_at)
           VALUES (?, 1, NULL, 'proposed', '{}', '[]', '{}', '{}', '{}', 'h', 's', 'user', '2026-01-01T00:00:00.000Z')`,
        )
        .run(goalId),
    );
    expect(outcome).toBe('definition_exists');
    expect(counts().runs).toBe(before.runs);
    expect(counts().cycles).toBe(before.cycles);
    expect(calls).toHaveLength(before.calls);
  });

  it('refuses when a competing authoring cycle became active', async () => {
    h = await realRunHarness();
    const { outcome, before } = await raced((goalId) =>
      db()
        .prepare(
          `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status, base_integration_commit, created_at)
           VALUES ('rival', ?, NULL, NULL, 5, 'authoring', 'goal_authoring_retry', 'proposing', NULL, '2026-01-01T00:00:00.000Z')`,
        )
        .run(goalId),
    );
    expect(outcome).toBe('authoring_in_progress');
    expect(counts().runs).toBe(before.runs);
    expect(calls).toHaveLength(before.calls);
  });

  it('still starts an unchanged retry', async () => {
    h = await realRunHarness();
    const { outcome } = await raced(() => undefined);
    expect(outcome).toBe('started');
  });
});

describe('Goal authoring: reconciliation', () => {
  it('starts a queued run exactly once after a restart, from persisted state alone', async () => {
    h = await realRunHarness();
    const lost = vi.fn();
    // The process "died" before the post-commit start.
    const started = await startGoalAuthoring(db(), input() as never, lost);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(h.runRow(started.runId).status).toBe('queued');
    expect(calls).toHaveLength(0);

    h.restart();
    const spy = vi.fn(startRun);
    const fresh = new AuthoringReconciler(db(), spy);
    const first = await fresh.reconcile();
    expect(first.observed[0]).toMatchObject({ state: 'started' });
    await waitRun(started.runId, 'completed');
    await fresh.reconcile();
    await fresh.reconcile();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', started.goalId)).toBe(1);
  });

  it('consumes a run that completed before the restart exactly once', async () => {
    h = await realRunHarness();
    const { goalId, runId } = await begin();
    await waitRun(runId, 'completed');
    h.restart();
    await Promise.all([reconciler().reconcile(), reconciler().reconcile()]);
    await reconciler().reconcile();
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions WHERE goal_id = ?', goalId)).toBe(1);
    expect(eventTypes(goalId).filter((type) => type === 'goal_authoring_completed')).toHaveLength(1);
    expect(eventTypes(goalId).filter((type) => type === 'definition_proposed')).toHaveLength(1);
  });

  it('observes an active run and never auto-resumes a paused one', async () => {
    h = await realRunHarness();
    let release!: () => void;
    answer = () => new Promise((resolve) => (release = () => resolve(done(GOOD()))));
    const { runId } = await begin();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spy = vi.fn(startRun);
    const watcher = new AuthoringReconciler(db(), spy);
    expect((await watcher.reconcile()).observed[0]).toMatchObject({ state: 'active' });
    release();
    await waitRun(runId, 'completed');

    // A paused (interrupted) run is exposed, not started, resumed or consumed.
    db().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runId);
    const paused = await watcher.reconcile();
    expect(paused.observed[0]).toMatchObject({ state: 'paused', code: 'run_paused', runStatus: 'paused' });
    expect(spy).not.toHaveBeenCalled();
    expect(n('SELECT COUNT(*) AS n FROM goal_definition_versions')).toBe(1);
    const status = await h.app.inject({
      method: 'GET',
      url: `/api/goals/${(paused.observed[0] as { goalId: string }).goalId}/authoring`,
    });
    expect(status.json()).toMatchObject({ authoring: { state: 'paused', runStatus: 'paused' } });
  });
});

describe('Goal authoring: usage and retention', () => {
  const range = { from: '2020-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z', timeZone: 'UTC' };

  it('attributes the authoring run usage to its Goal through the goalId filter, and no other Goal', async () => {
    h = await realRunHarness();
    const { goalId, runId } = await begin();
    await waitRun(runId, 'completed');
    await reconciler().reconcile();
    const usage = queryUsageAnalytics(db(), { ...range, goalId });
    expect(JSON.stringify(usage)).toContain('15');
    const other = queryUsageAnalytics(db(), { ...range, goalId: h.fx.goalId });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(usage));
    const rows = db().prepare('SELECT COUNT(*) AS n FROM usage_events WHERE run_id = ?').get(runId) as {
      n: number;
    };
    expect(rows.n).toBeGreaterThan(0);
    // The Goal id is not duplicated onto usage events: attribution is run -> cycle -> Goal only.
    const columns = (db().prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).not.toContain('goal_id');
  });

  it('prunes the worktree only after the output is consumed, and retains the run branch', async () => {
    h = await realRunHarness();
    const { runId } = await begin();
    await waitRun(runId, 'completed');
    expect(h.runRow(runId).worktree_path).toBeTruthy();
    // Completed but not yet consumed: refused.
    const before = await inspectRunRetention(db(), runId);
    expect(before).toMatchObject({ state: 'refused' });
    expect((before as { reasons: string[] }).reasons).toContain('cycle_not_terminal');

    const summary = await reconciler().reconcile();
    expect(summary.pruned).toEqual([runId]);
    expect(h.runRow(runId).worktree_path).toBeNull();
    const branch = h.runRow(runId).branch as string;
    expect(h.fx.git('rev-parse', '--verify', `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(h.worktrees()).toEqual([]);
    expect(await inspectRunRetention(db(), runId)).toEqual({ state: 'already_pruned', reasons: [] });
  });

  it('requires the consumption record, not just a terminal cycle', async () => {
    h = await realRunHarness();
    const { goalId, cycleId, runId } = await begin();
    await waitRun(runId, 'completed');
    // Force the cycle terminal without any consumption record: retention must still refuse.
    db()
      .prepare(
        "UPDATE goal_cycles SET status = 'failed', finished_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(cycleId);
    const forced = await inspectRunRetention(db(), runId);
    expect(forced).toMatchObject({ state: 'refused' });
    expect((forced as { reasons: string[] }).reasons).toEqual(['authoring_not_consumed']);
    expect(goalId).toBeTruthy();
  });

  it('prunes a failed authoring run once the failure is recorded, and keeps the branch', async () => {
    h = await realRunHarness();
    answer = async () => done('nope');
    const { runId } = await begin();
    await waitRun(runId, 'completed');
    const summary = await reconciler().reconcile();
    expect(summary.pruned).toEqual([runId]);
    const branch = h.runRow(runId).branch as string;
    expect(h.fx.git('rev-parse', '--verify', `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('Goal authoring: production wiring', () => {
  it('keeps autonomous Goals on the DisabledGoalExecutor and uses the exact-route authoring service only', () => {
    const index = readFileSync(join(process.cwd(), 'src/server/index.ts'), 'utf8');
    expect(index).toContain('executor: new DisabledGoalExecutor()');
    expect(index).not.toContain('TuringGoalExecutor');
    expect(index).not.toContain('FixedGoalRunPlanProvider');
  });
});
