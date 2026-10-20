import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in route plan tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { discoverProviders, executeProvider, type ProviderRunRequest } from '../providers.js';
import type { GoalDefinition } from '../../shared/goals.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { passRecords } from './routingKit.js';
import { readStoredResolutions } from './routeResolution.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import { cleanupRepoFixtures, milestone, simpleDefinition, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { GOOD_TASK } from './supervisorKit.js';
import { realRunHarness, type RealRunHarness } from './turingRunKit.js';
import type { GoalRunPlanProvider } from './runPlan.js';

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

const member = (modelId: string) => ({
  configuration: {
    backendId: 'claude-code',
    providerId: 'anthropic-subscription',
    billingLane: 'claude-subscription' as const,
    modelId,
  },
  identityKind: 'pinned' as const,
  freshnessClass: 'stable-subscription' as const,
});
const POOL = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'];

/** The orchestrator is a first-use-gated ordered pool; the implementer is pinned. Validation is fresh-validation only. */
function definition(roundRobin = false): GoalDefinition {
  const def = simpleDefinition({
    milestones: [
      milestone('m1', ['build', 'tests'], { allowedScope: { includeGlobs: ['src/**'], excludeGlobs: [] } }),
    ],
    gates: { poolRouteFirstUse: true },
  });
  def.routing.roles.orchestrator = { kind: 'pool', poolId: 'orchs' };
  def.routing.roles.implementer = {
    kind: 'pinned',
    member: member('claude-sonnet-5-5'),
    availability: 'fresh-validation',
    requireRoleValidation: true,
  };
  def.routing.pools = [
    ...def.routing.pools.filter((pool) => pool.id !== 'orchs'),
    {
      id: 'orchs',
      label: 'Orchestrators',
      members: POOL.map(member),
      admission: 'static',
      availability: 'fresh-validation',
      requireRoleValidation: true,
      selection: roundRobin ? 'round_robin' : 'ordered',
      laneClass: 'subscription',
      autoRevalidate: false,
    },
  ];
  return def;
}

let h: RealRunHarness;
let calls: ProviderRunRequest[];

beforeEach(() => {
  calls = [];
  vi.mocked(discoverProviders).mockResolvedValue([claude()]);
  vi.mocked(executeProvider).mockImplementation(async (request) => {
    calls.push(request);
    return done(JSON.stringify(GOOD_TASK));
  });
});
afterEach(async () => {
  await h?.close();
  h = undefined as never;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

/** Seeds the canonical validation records the routing authority requires, for the identities observed right now. */
async function seedValidations(models: readonly string[], orchestratorHours = 100) {
  const snapshot = await observeRouteSnapshot(h.fx.db);
  const insert = h.fx.db.prepare(
    `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
     VALUES (?, ?, ?, ?, 'pass', '{}', 'turing_probe_run', ?, ?, ?, ?)`,
  );
  const stamp = (offsetHours: number) => new Date(Date.now() + offsetHours * 3_600_000).toISOString();
  const roles: Array<[string, 'orchestrator' | 'implementer']> = [
    ...models.map((id) => [id, 'orchestrator'] as [string, 'orchestrator']),
    ['claude-sonnet-5-5', 'implementer'],
  ];
  for (const [modelId, role] of roles)
    for (const record of passRecords(member(modelId), role, snapshot))
      insert.run(
        record.id + modelId,
        record.identityHash,
        JSON.stringify(record.identity),
        record.profile,
        record.adapterVersion,
        record.capabilityFingerprint,
        stamp(-1),
        stamp(role === 'orchestrator' ? orchestratorHours : 100),
      );
}

const real = (db: ConstructorParameters<typeof ResolvedGoalRunPlanProvider>[0]) =>
  new ResolvedGoalRunPlanProvider(db);
const goal = () =>
  h.fx.db
    .prepare(
      'SELECT status, status_reason_code AS code, status_detail_json AS detail FROM goals WHERE id = ?',
    )
    .get(h.fx.goalId) as {
    status: string;
    code: string | null;
    detail: string | null;
  };
/** Waits for the provider to have been called once and for the proposal run to finish. */
const providerCalled = async () => {
  await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 15_000 });
  await vi.waitFor(
    () =>
      expect(
        (
          h.fx.db.prepare("SELECT status FROM runs WHERE goal_run_purpose = 'proposal'").get() as {
            status: string;
          }
        ).status,
      ).toBe('completed'),
    { timeout: 15_000 },
  );
};
const count = (table: string) =>
  (h.fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const firstUse = () =>
  h.fx.db
    .prepare("SELECT * FROM goal_approvals WHERE gate = 'pool_route_first_use' ORDER BY created_at, rowid")
    .all() as Array<{ id: string; status: string; detail_json: string; decided_by: string | null }>;
const user = (approvalId: string, decision: 'approved' | 'denied') =>
  decideGoalApproval(h.fx.db, { goalId: h.fx.goalId, approvalId, decision, decidedBy: 'user' });
const detail = (row: { detail_json: string }) => JSON.parse(row.detail_json) as Record<string, unknown>;
const cycleResolutions = () =>
  readStoredResolutions(
    (
      h.fx.db
        .prepare('SELECT route_resolution_json AS j FROM goal_cycles ORDER BY sequence DESC LIMIT 1')
        .get() as { j: string | null } | undefined
    )?.j ?? null,
  );

describe('first-use gate for a ready Goal', () => {
  it(
    'Start creates or reuses one pending approval, stays ready, and queues nothing',
    async () => {
      h = await realRunHarness({ definition: definition(), planProvider: real, requireResolvedRoutes: true });
      await seedValidations(POOL);
      expect(goal().status).toBe('ready');
      const first = await h.supervisor.startGoal(h.fx.goalId);
      expect(first).toMatchObject({ ok: false, code: 'gate_pending' });
      const approvalId = (first as { approvalId?: string }).approvalId!;
      expect(approvalId).toBeTruthy();
      expect(goal().status).toBe('ready');
      expect(count('goal_cycles')).toBe(0);
      expect(count('runs')).toBe(0);
      expect(calls).toHaveLength(0);
      const rows = firstUse();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: approvalId, status: 'pending' });
      expect(detail(rows[0]!)).toMatchObject({ poolId: 'orchs', role: 'orchestrator', memberIndex: 0 });
      expect(detail(rows[0]!).memberIdentityHash).toMatch(/^[0-9a-f]{64}$/);
      // Asking again reuses the pending approval.
      const again = await h.supervisor.startGoal(h.fx.goalId);
      expect(again).toMatchObject({ ok: false, code: 'gate_pending', approvalId });
      expect(firstUse()).toHaveLength(1);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'after the user approves, Start proceeds and the proposal run carries exactly the resolved route',
    async () => {
      h = await realRunHarness({ definition: definition(), planProvider: real, requireResolvedRoutes: true });
      await seedValidations(POOL);
      const gated = await h.supervisor.startGoal(h.fx.goalId);
      user((gated as { approvalId: string }).approvalId, 'approved');
      expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: true });
      await h.until('proposal_run_started');
      const stored = cycleResolutions().orchestrator!;
      expect(stored.selected.configuration.modelId).toBe('claude-sonnet-5-5');
      expect(stored.approval.state).toBe('approved');
      await providerCalled();
      expect(calls[0]).toMatchObject({
        backendId: 'claude-code',
        providerId: 'anthropic-subscription',
        modelId: 'claude-sonnet-5-5',
        billingLane: 'claude-subscription',
      });
      const stages = h.fx.db
        .prepare(
          "SELECT backend_id, provider_id, model_id, billing_lane FROM stages WHERE run_id = (SELECT id FROM runs WHERE goal_run_purpose = 'proposal') AND kind = 'planner'",
        )
        .all() as Array<Record<string, unknown>>;
      for (const stage of stages)
        expect(stage).toEqual({
          backend_id: stored.selected.configuration.backendId,
          provider_id: stored.selected.configuration.providerId,
          model_id: stored.selected.configuration.modelId,
          billing_lane: stored.selected.configuration.billingLane,
        });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a denial makes the pool consider the next member, which needs its own approval',
    async () => {
      h = await realRunHarness({ definition: definition(), planProvider: real, requireResolvedRoutes: true });
      await seedValidations(POOL);
      const gated = await h.supervisor.startGoal(h.fx.goalId);
      user((gated as { approvalId: string }).approvalId, 'denied');
      const second = await h.supervisor.startGoal(h.fx.goalId);
      expect(second).toMatchObject({ ok: false, code: 'gate_pending' });
      const rows = firstUse();
      expect(rows).toHaveLength(2);
      expect(detail(rows[1]!)).toMatchObject({ poolId: 'orchs', memberIndex: 1 });
      user((second as { approvalId: string }).approvalId, 'approved');
      expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: true });
      await h.until('proposal_run_started');
      expect(cycleResolutions().orchestrator!.selected.configuration.modelId).toBe('claude-opus-5-5');
      await providerCalled();
      expect(calls[0]?.modelId).toBe('claude-opus-5-5');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an approval for another pool or a user-less row establishes nothing',
    async () => {
      h = await realRunHarness({ definition: definition(), planProvider: real, requireResolvedRoutes: true });
      await seedValidations(POOL);
      const wrong = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'pool_route_first_use',
        risk: 'low',
        reason: 'x',
        requestedBy: 'supervisor',
        detail: { poolId: 'some-other-pool', memberIdentityHash: 'f'.repeat(64) },
      });
      user(wrong.id, 'approved');
      const started = await h.supervisor.startGoal(h.fx.goalId);
      expect(started).toMatchObject({ ok: false, code: 'gate_pending' });
      expect((started as { approvalId: string }).approvalId).not.toBe(wrong.id);
      expect(goal().status).toBe('ready');
      expect(() =>
        decideGoalApproval(h.fx.db, {
          goalId: h.fx.goalId,
          approvalId: (started as { approvalId: string }).approvalId,
          decision: 'approved',
          decidedBy: 'system',
        }),
      ).toThrow();
      expect(await h.supervisor.startGoal(h.fx.goalId)).toMatchObject({ ok: false, code: 'gate_pending' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses without a gate when no member is usable (no validation), with no fallback',
    async () => {
      h = await realRunHarness({ definition: definition(), planProvider: real, requireResolvedRoutes: true });
      const started = await h.supervisor.startGoal(h.fx.goalId);
      expect(started).toMatchObject({ ok: false, code: 'route_unavailable' });
      expect(firstUse()).toHaveLength(0);
      expect(count('runs')).toBe(0);
      expect(calls).toHaveLength(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('first-use gate for a running Goal', () => {
  /** Readiness is stubbed true (the state changed after the Start preflight); planning stays real. */
  const racing = (db: ConstructorParameters<typeof ResolvedGoalRunPlanProvider>[0]): GoalRunPlanProvider => {
    const inner = real(db);
    return { checkRoutes: async () => ({ ready: true }), planRun: (request) => inner.planRun(request) };
  };

  it(
    'moves to needs_user(gate_pending) with one pending approval and no run, then resumes after approval',
    async () => {
      h = await realRunHarness({
        definition: definition(),
        planProvider: racing,
        requireResolvedRoutes: true,
      });
      await seedValidations(POOL);
      expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: true });
      const seen = await h.until('gate_requested');
      expect(seen.at(-1)).toBe('gate_requested');
      const state = goal();
      expect(state).toMatchObject({ status: 'needs_user', code: 'gate_pending' });
      const rows = firstUse();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(state.detail!)).toMatchObject({
        approvalId: rows[0]!.id,
        gate: 'pool_route_first_use',
      });
      expect(detail(rows[0]!)).toMatchObject({ poolId: 'orchs', role: 'orchestrator', memberIndex: 0 });
      expect(count('runs')).toBe(0);
      expect(calls).toHaveLength(0);
      // Waiting: no further approvals, no run.
      expect(await h.tick()).toBe('waiting_gate');
      expect(firstUse()).toHaveLength(1);
      user(rows[0]!.id, 'approved');
      expect(await h.tick()).toBe('resumed');
      expect(goal().status).toBe('running');
      await h.until('proposal_run_started');
      expect(cycleResolutions().orchestrator!.selected.configuration.modelId).toBe('claude-sonnet-5-5');
      await providerCalled();
      expect(calls[0]?.modelId).toBe('claude-sonnet-5-5');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a denial keeps the cycle and gates the next member instead of cancelling',
    async () => {
      h = await realRunHarness({
        definition: definition(),
        planProvider: racing,
        requireResolvedRoutes: true,
      });
      await seedValidations(POOL);
      await h.supervisor.startGoal(h.fx.goalId);
      await h.until('gate_requested');
      user(firstUse()[0]!.id, 'denied');
      expect(await h.tick()).toBe('resumed');
      await h.until('gate_requested');
      const rows = firstUse();
      expect(rows).toHaveLength(2);
      expect(detail(rows[1]!)).toMatchObject({ memberIndex: 1 });
      expect(
        h.fx.db.prepare('SELECT status FROM goal_cycles ORDER BY sequence DESC LIMIT 1').get(),
      ).not.toMatchObject({ status: 'cancelled' });
      expect(count('runs')).toBe(0);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('resume preflight keeps a persisted current-cycle route', () => {
  it(
    'does not recompute or rotate the persisted orchestrator when its evidence later expires, and resumes the exact paused run',
    async () => {
      let clock = () => new Date().toISOString();
      h = await realRunHarness({
        definition: definition(),
        planProvider: (db) => new ResolvedGoalRunPlanProvider(db, { now: () => clock() }),
        requireResolvedRoutes: true,
      });
      // The orchestrator's validation lasts 10 hours; the implementer's far longer.
      await seedValidations(POOL, 10);
      const gated = await h.supervisor.startGoal(h.fx.goalId);
      user((gated as { approvalId: string }).approvalId, 'approved');
      // The first provider call hangs until the run is paused; the resumed call completes.
      vi.mocked(executeProvider).mockReset();
      vi.mocked(executeProvider).mockImplementation(async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()));
          throw new Error('interrupted');
        }
        return done(JSON.stringify(GOOD_TASK));
      });
      expect(await h.supervisor.startGoal(h.fx.goalId)).toEqual({ ok: true });
      await h.until('proposal_run_started');
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 15_000 });
      const runId = (
        h.fx.db.prepare("SELECT id FROM runs WHERE goal_run_purpose = 'proposal'").get() as { id: string }
      ).id;
      expect(h.engine.intervene(runId, 'pause')).toBe(true);
      await vi.waitFor(() => expect((h.runRow(runId) as { status: string }).status).toBe('paused'), {
        timeout: 15_000,
      });
      await h.until('run_interrupted');

      const stored = JSON.stringify(cycleResolutions());
      expect(cycleResolutions().orchestrator!.selected.configuration.modelId).toBe('claude-sonnet-5-5');
      const approvalsBefore = firstUse().length;
      // Time passes: the orchestrator's evidence is now stale (a fresh selection would refuse every member).
      clock = () => new Date(Date.now() + 30 * 3_600_000).toISOString();
      const fresh = new ResolvedGoalRunPlanProvider(h.fx.db, { now: () => clock() });
      expect(await fresh.checkRoutes(h.fx.goalId)).toEqual({ ready: true });

      const resumed = await h.supervisor.resumeGoal(h.fx.goalId, {
        actor: 'user',
        reasonCode: 'run_resumed',
      });
      expect(resumed).toEqual({ ok: true });
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), { timeout: 15_000 });
      await vi.waitFor(() => expect((h.runRow(runId) as { status: string }).status).toBe('completed'), {
        timeout: 20_000,
      });
      // The same run was resumed; the route was neither rewritten nor re-asked.
      expect(count('runs')).toBe(1);
      expect(JSON.stringify(cycleResolutions())).toBe(stored);
      expect(firstUse()).toHaveLength(approvalsBefore);
      expect(calls[1]).toMatchObject({ modelId: 'claude-sonnet-5-5', backendId: 'claude-code' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('production wiring', () => {
  it('still wires the DisabledGoalExecutor in src/server/index.ts', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/executor:\s*new DisabledGoalExecutor\(\)/);
    expect(source).not.toMatch(/ResolvedGoalRunPlanProvider|TuringGoalExecutor/);
    expect(source).not.toMatch(/createRouteProbe/);
  });
});
