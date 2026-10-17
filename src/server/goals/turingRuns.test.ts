import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { randomUUID } from 'node:crypto';
import { queryUsageAnalytics, loadUsageEvents, decisionAnalytics, exportRows } from '../usageAnalytics.js';
import { recordCompletedUsage } from '../usageEvents.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import { simpleDefinition, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { TuringGoalExecutor } from './turingExecutor.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { GOOD_TASK } from './supervisorKit.js';
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

let h: RealRunHarness;
let calls: ProviderRunRequest[];
const seen: Array<{ cwd: string; head: string; dirtyVisible: boolean }> = [];
let planner: () => Promise<ReturnType<typeof done>>;
let implementer: (request: ProviderRunRequest) => Promise<ReturnType<typeof done>>;

beforeEach(() => {
  calls = [];
  seen.length = 0;
  pinned = '';
  vi.mocked(discoverProviders).mockResolvedValue([claude()]);
  planner = async () => done(JSON.stringify(GOOD_TASK));
  implementer = async (request) => {
    const written = await h.broker(request.toolBroker.token, 'write_file', {
      path: 'src/a.ts',
      content: 'export const a = 1;\n',
    });
    expect(written.error).toBeUndefined();
    return done('Implemented.');
  };
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    calls.push(request);
    seen.push({
      cwd: request.cwd,
      head: execFileSync('git', ['-C', request.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirtyVisible: existsSync(join(request.cwd, 'dirty.txt')),
    });
    return request.role === 'implementer' ? implementer(request) : planner();
  });
}, REAL_GIT_TEST_TIMEOUT_MS);

afterEach(async () => {
  await h?.close();
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

const start = async () => {
  const result = await h.supervisor.startGoal(h.fx.goalId);
  if (!result.ok) throw new Error(`start failed: ${result.code}`);
};

describe('Goal proposal run on the real RunEngine', () => {
  it(
    'queues an ordinary run, runs it in an isolated worktree at the Goal base, and reads the persisted proposal',
    async () => {
      h = await realRunHarness();
      const base = h.baseCommit;
      // A dirty source checkout must be untouched and must not block a Goal-origin run.
      writeFileSync(join(h.fx.repo, 'dirty.txt'), 'uncommitted\n');
      await start();
      await h.until('proposal_run_started');
      const run = h.fx.db.prepare("SELECT * FROM runs WHERE goal_run_purpose = 'proposal'").get() as Record<
        string,
        unknown
      >;
      expect(run).toMatchObject({
        goal_cycle_id: h.cycleId(),
        goal_run_purpose: 'proposal',
        goal_base_commit: base,
        workflow_id: 'goal-planning-v1',
      });
      const runId = run.id as string;
      await vi.waitFor(() => expect(h.runRow(runId).status).toBe('completed'), { timeout: 15_000 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.role).toBe('planner');
      expect(calls[0]!.prompt).toContain('Goal');
      // The worktree started at the exact Goal base: the run recorded it, and it never read the dirty checkout.
      const row = h.runRow(runId);
      expect(seen[0]).toMatchObject({ head: base, dirtyVisible: false });
      expect(seen[0]!.cwd).not.toBe(h.fx.repo);
      expect(row.goal_base_commit).toBe(base);
      expect(readFileSync(join(h.fx.repo, 'dirty.txt'), 'utf8')).toBe('uncommitted\n');
      expect(h.fx.git('status', '--porcelain')).toContain('dirty.txt');
      const stage = h.fx.db
        .prepare("SELECT output_json FROM stages WHERE run_id = ? AND stage_key = 'goal-propose'")
        .get(runId) as { output_json: string };
      expect(JSON.parse(stage.output_json).text).toBe(JSON.stringify(GOOD_TASK));

      // A new executor instance (as after restart) reconstructs the proposal from persisted data only.
      const fresh = new TuringGoalExecutor(h.fx.db, h.plans);
      expect(await fresh.readProposal(runId)).toEqual({ ok: true, proposal: GOOD_TASK });

      // A duplicate queue request returns the same run and asks neither the plan provider nor the model again.
      const plansBefore = h.plans.requests.length;
      const again = await fresh.queueProposalRun({
        goalId: h.fx.goalId,
        cycleId: h.cycleId(),
        baseCommit: base,
        definitionVersion: 1,
        milestone: { key: 'm1' },
        memory: { text: '', ...({} as object) },
      } as never);
      expect(again.runId).toBe(runId);
      expect(h.plans.requests).toHaveLength(plansBefore);
      expect(calls).toHaveLength(1);
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE goal_run_purpose = 'proposal'").get(),
      ).toEqual({ n: 1 });

      // The supervisor records the proposal and retires the proposal worktree; no second provider request happens.
      await h.until('proposal_recorded');
      expect(calls.filter((call) => call.role === 'planner')).toHaveLength(1);
      expect(h.worktrees()).not.toContain(runId);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

const execRun = () =>
  h.fx.db
    .prepare("SELECT * FROM runs WHERE goal_run_purpose = 'execution' AND goal_cycle_id = ?")
    .get(h.cycleId()) as Record<string, unknown> | undefined;

describe('Goal execution run on the real RunEngine', () => {
  it(
    'commits in an isolated worktree at the base, then integrates and advances the Goal ref',
    async () => {
      h = await realRunHarness();
      const base = h.baseCommit;
      await start();
      await h.until('run_started');
      const run = execRun()!;
      expect(run).toMatchObject({
        goal_run_purpose: 'execution',
        goal_base_commit: base,
        workflow_id: 'goal-execution-v1',
        permission_mode: 'yolo',
      });
      const runId = run.id as string;
      await vi.waitFor(() => expect(h.runRow(runId).status).toBe('completed'), { timeout: 20_000 });
      const implementerSeen = seen.find((entry, index) => calls[index]!.role === 'implementer')!;
      expect(implementerSeen.head).toBe(base);
      expect(implementerSeen.cwd).not.toBe(h.fx.repo);
      const done = h.runRow(runId);
      const worktree = done.worktree_path as string;
      const branch = done.branch as string;
      // Deterministic stages ran and the commit is a descendant of the base.
      const stages = h.fx.db
        .prepare('SELECT stage_key, status FROM stages WHERE run_id = ? ORDER BY sequence')
        .all(runId);
      expect(stages).toEqual([
        { stage_key: 'goal-implement', status: 'passed' },
        { stage_key: 'goal-build', status: 'passed' },
        { stage_key: 'goal-test', status: 'passed' },
        { stage_key: 'goal-commit', status: 'passed' },
      ]);
      const tip = h.fx.git('rev-parse', branch);
      expect(h.fx.git('merge-base', '--is-ancestor', base, tip)).toBe('');
      expect(tip).not.toBe(base);
      expect(h.fx.git('show', `${tip}:src/a.ts`)).toBe('export const a = 1;');
      // Execution worktrees stay retained and clean; the commit is the branch tip.
      expect(existsSync(worktree)).toBe(true);
      expect(execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
        tip,
      );

      await h.until('cycle_succeeded');
      expect(h.fx.head()).not.toBe(base);
      expect(h.fx.git('rev-parse', `refs/heads/turing/goal/${h.fx.goalId}`)).toBe(h.fx.head());
      expect(h.fx.git('show', `${h.fx.head()}:src/a.ts`)).toBe('export const a = 1;');
      // Stage 4A records no evidence.
      expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get()).toEqual({ n: 0 });
      expect(
        h.fx.db.prepare("SELECT COUNT(*) AS n FROM goal_events WHERE type = 'run_evidence_collected'").get(),
      ).toEqual({ n: 0 });
      expect(existsSync(worktree)).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

let pinned = '';
const runsOf = (purpose: string) =>
  h.fx.db
    .prepare('SELECT id, status FROM runs WHERE goal_cycle_id = ? AND goal_run_purpose = ?')
    .all(pinned || h.cycleId(), purpose) as Array<{ id: string; status: string }>;
const outcome = () =>
  JSON.parse(
    (
      h.fx.db.prepare('SELECT outcome_json FROM goal_cycles WHERE id = ?').get(pinned || h.cycleId()) as {
        outcome_json: string;
      }
    ).outcome_json,
  ) as Record<string, unknown>;
const runToExecution = async () => {
  await start();
  await h.until('run_started');
  pinned = h.cycleId();
  const [run] = runsOf('execution');
  return run!.id;
};
const waitDone = (runId: string, status: string) =>
  vi.waitFor(() => expect(h.runRow(runId).status).toBe(status), { timeout: 20_000 });

describe('Goal execution without changes', () => {
  it(
    'completes without an empty commit and the existing no_change outcome applies',
    async () => {
      implementer = async () => done('Nothing to change.');
      h = await realRunHarness();
      const base = h.baseCommit;
      const runId = await runToExecution();
      await waitDone(runId, 'completed');
      expect(h.fx.git('rev-parse', h.runRow(runId).branch as string)).toBe(base);
      await h.until('cycle_failed');
      expect(outcome()).toMatchObject({ code: 'no_change' });
      expect(h.fx.head()).toBe(base);
      expect(runsOf('execution')).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('Goal run failures on the real RunEngine', () => {
  it(
    'a provider failure fails the one execution run and the cycle without a second run',
    async () => {
      implementer = async () => {
        throw new Error('provider rejected the request');
      };
      h = await realRunHarness();
      const runId = await runToExecution();
      await waitDone(runId, 'failed');
      await h.until('cycle_failed');
      expect(runsOf('execution')).toHaveLength(1);
      expect(h.fx.head()).toBe(h.baseCommit);
      const fresh = h.restart();
      await fresh.supervisor.tickGoal(h.fx.goalId);
      expect(runsOf('execution')).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a deterministic build failure fails the run before any commit',
    async () => {
      implementer = async (request) => {
        await h.broker(request.toolBroker.token, 'write_file', {
          path: 'package.json',
          content: JSON.stringify({ scripts: { build: 'node -e "process.exit(3)"', test: 'node -e "0"' } }),
        });
        await h.broker(request.toolBroker.token, 'write_file', {
          path: 'src/a.ts',
          content: 'export const a = 1;\n',
        });
        return done('Implemented.');
      };
      h = await realRunHarness();
      const runId = await runToExecution();
      await waitDone(runId, 'failed');
      const statuses = h.fx.db
        .prepare('SELECT stage_key, status FROM stages WHERE run_id = ? ORDER BY sequence')
        .all(runId) as Array<{ stage_key: string; status: string }>;
      expect(statuses.find((stage) => stage.stage_key === 'goal-build')!.status).toBe('failed');
      expect(statuses.find((stage) => stage.stage_key === 'goal-commit')!.status).not.toBe('passed');
      expect(h.fx.git('rev-parse', h.runRow(runId).branch as string)).toBe(h.baseCommit);
      await h.until('cycle_failed');
      expect(h.fx.head()).toBe(h.baseCommit);
      expect(runsOf('execution')).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a cancelled run fails the cycle and never starts a second run',
    async () => {
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      implementer = async (request) => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
          request.signal.addEventListener('abort', () => resolve());
        });
        throw new Error('aborted');
      };
      h = await realRunHarness();
      const runId = await runToExecution();
      await inside;
      expect(h.engine.cancel(runId)).toBe(true);
      release();
      await waitDone(runId, 'cancelled');
      await h.until('cycle_failed');
      expect(runsOf('execution')).toHaveLength(1);
      expect(h.fx.head()).toBe(h.baseCommit);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a run paused for intervention is resumed by the supervisor with the same run',
    async () => {
      let attempts = 0;
      let entered: () => void = () => undefined;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      implementer = async (request) => {
        attempts += 1;
        if (attempts === 1) {
          entered();
          await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()));
          throw new Error('interrupted');
        }
        await h.broker(request.toolBroker.token, 'write_file', {
          path: 'src/a.ts',
          content: 'export const a = 1;\n',
        });
        return done('Implemented.');
      };
      h = await realRunHarness();
      const runId = await runToExecution();
      await inside;
      expect(h.engine.intervene(runId, 'pause')).toBe(true);
      await waitDone(runId, 'paused');
      await h.until('run_interrupted');
      // The Goal waits for the user; nothing resumes the run automatically.
      expect(h.runRow(runId).status).toBe('paused');
      const resumed = await h.supervisor.resumeGoal(h.fx.goalId, {
        actor: 'user',
        reasonCode: 'run_resumed',
      });
      expect(resumed.ok).toBe(true);
      await h.until('cycle_succeeded', 60);
      expect(runsOf('execution')).toEqual([{ id: runId, status: 'completed' }]);
      expect(h.fx.head()).not.toBe(h.baseCommit);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'malformed proposal JSON is rejected without a second proposal run or provider request',
    async () => {
      planner = async () => done('this is not json');
      h = await realRunHarness();
      await start();
      await h.until('proposal_rejected');
      expect(runsOf('proposal')).toHaveLength(1);
      expect(calls.filter((call) => call.role === 'planner')).toHaveLength(1);
      expect(runsOf('execution')).toHaveLength(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a duplicate queue after restart returns the persisted run without a plan request or provider call',
    async () => {
      h = await realRunHarness();
      await start();
      await h.until('proposal_queued');
      const [first] = runsOf('proposal');
      const plansBefore = h.plans.requests.length;
      const fresh = h.restart();
      await fresh.supervisor.tickGoal(h.fx.goalId);
      expect(runsOf('proposal').map((run) => run.id)).toEqual([first!.id]);
      expect(h.plans.requests.length).toBe(plansBefore);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('Goal-filtered usage analytics', () => {
  const range = { from: '2020-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z', timeZone: 'UTC' };
  const usageFor = (runId: string, tokens: number, cost: number | null = null) =>
    recordCompletedUsage(
      h.fx.db,
      {
        runId,
        stageId: null,
        role: 'implementer',
        workloadType: 'generative',
        backend: 'claude-code',
        connectionProfileId: null,
        billingLane: 'claude-subscription',
        providerId: 'anthropic-subscription',
        modelId: 'claude-sonnet-5-5',
        variantId: null,
      },
      {
        source: 'test',
        provenance: 'provider_measured',
        inputTokens: tokens,
        outputTokens: 1,
        ...(cost === null ? {} : { actualCostUsd: cost, costProvenance: 'provider_measured' as const }),
      },
    );
  const insertRun = (id: string, cycleId: string | null, purpose: string | null) =>
    h.fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, goal_cycle_id, goal_run_purpose)
         VALUES (?, (SELECT machine_id FROM goals WHERE id = ?), ?, 'goal-execution-v1', '{}', 'p', 'economy', 'normal', 'completed', '2026-01-01T00:00:00.000Z', ?, ?)`,
      )
      .run(id, h.fx.goalId, h.fx.projectId, cycleId, purpose);

  it(
    'filters headline, breakdowns, series, exports and decisions to the Goal child runs',
    async () => {
      h = await realRunHarness();
      const otherId = createGoalDraft(h.fx.db, {
        projectId: h.fx.projectId,
        title: 'Other',
        definition: simpleDefinition(),
      }).goalId;
      approveDefinition(h.fx.db, { goalId: otherId, version: 1, actor: 'user' });
      const cycleOf = (goalId: string, sequence: number, status = 'cancelled') => {
        const id = randomUUID();
        h.fx.db
          .prepare(
            `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at)
           VALUES (?, ?, 1, ?, 'execution', 't', ?, '2026-01-01T00:00:00.000Z')`,
          )
          .run(id, goalId, sequence, status);
        return id;
      };
      // Two child runs of the Goal under the real cycle numbering, one run of another Goal, one ordinary run.
      const mine1 = randomUUID();
      const mine2 = randomUUID();
      insertRun(mine1, cycleOf(h.fx.goalId, 50), 'proposal');
      insertRun(mine2, cycleOf(h.fx.goalId, 51), 'execution');
      const theirs = randomUUID();
      insertRun(theirs, cycleOf(otherId, 1), 'execution');
      const ordinary = randomUUID();
      insertRun(ordinary, null, null);
      usageFor(mine1, 100);
      usageFor(mine2, 200, 0.5);
      usageFor(theirs, 400);
      usageFor(ordinary, 800);

      const all = queryUsageAnalytics(h.fx.db, range);
      const goal = queryUsageAnalytics(h.fx.db, { ...range, goalId: h.fx.goalId });
      const other = queryUsageAnalytics(h.fx.db, { ...range, goalId: otherId });
      expect(all.eventCount).toBe(4);
      expect(goal.eventCount).toBe(2);
      expect(other.eventCount).toBe(1);
      const sum = (filter: object) =>
        loadUsageEvents(h.fx.db, { ...range, ...filter }).reduce(
          (total, event) => total + (event.inputTokens ?? 0),
          0,
        );
      expect(sum({ goalId: h.fx.goalId })).toBe(300);
      expect(sum({ runId: mine1 }) + sum({ runId: mine2 })).toBe(sum({ goalId: h.fx.goalId }));
      expect(sum({ goalId: otherId })).toBe(400);
      expect(goal.totals.inputTokens.value).toBe(300);
      // Breakdowns and series are built from the same filtered events; provenance and cost logic are unchanged.
      expect(goal.byRole.reduce((n, row) => n + row.events, 0)).toBe(2);
      expect(goal.series.reduce((n, bucket) => n + (bucket.inputTokens.value ?? 0), 0)).toBe(300);
      expect(goal.totals.actualMeteredCostUsd.value).toBeCloseTo(0.5);
      expect(other.totals.actualMeteredCostUsd.value).toBeNull();
      // The Goal aggregate is exactly the sum of its child-run aggregates, provenance included.
      const perRun = [mine1, mine2].map((runId) => queryUsageAnalytics(h.fx.db, { ...range, runId }).totals);
      expect(goal.totals.events).toBe(perRun[0]!.events + perRun[1]!.events);
      expect(goal.totals.outputTokens.value).toBe(2);
      expect(Object.keys(goal.totals.tokenProvenance)).toEqual(Object.keys(perRun[0]!.tokenProvenance));
      expect(goal.totals.equivalentValueUsd.value).toBe(
        (perRun[0]!.equivalentValueUsd.value ?? 0) + (perRun[1]!.equivalentValueUsd.value ?? 0) || null,
      );
      expect(
        loadUsageEvents(h.fx.db, { ...range, goalId: h.fx.goalId }).every(
          (event) => event.runId !== ordinary,
        ),
      ).toBe(true);
      expect(exportRows(loadUsageEvents(h.fx.db, { ...range, goalId: h.fx.goalId }), 'UTC')).toHaveLength(2);
      expect(decisionAnalytics(h.fx.db, { ...range, goalId: h.fx.goalId })).toBeDefined();
      // An unknown Goal matches nothing rather than everything.
      expect(queryUsageAnalytics(h.fx.db, { ...range, goalId: 'no-such-goal' }).eventCount).toBe(0);

      const viaHttp = await h.app.inject({
        method: 'GET',
        url: `/api/usage/analytics?range=30d&goalId=${h.fx.goalId}`,
      });
      expect(viaHttp.statusCode).toBe(200);
      const exported = await h.app.inject({
        method: 'GET',
        url: `/api/usage/export?format=json&goalId=${otherId}`,
      });
      expect(exported.statusCode).toBe(200);
      const tooLong = await h.app.inject({
        method: 'GET',
        url: `/api/usage/analytics?goalId=${'x'.repeat(201)}`,
      });
      expect(tooLong.statusCode).toBe(400);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
