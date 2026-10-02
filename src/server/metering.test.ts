import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { budgetStatus, reconcileReservation, releaseReservation, reserveMetered, saveBudgetSettings, type ReservationRequest } from './meteredBudget.js';
import { createMeteringHooks, MeteringBlockedError } from './metering.js';
import { SecretStore, secretRef } from './secretStore.js';
import { createUsageEvent, reconcileUsageEvent } from './usageEvents.js';
import { aggregateUsage, exportRows, loadUsageEvents, queryUsageAnalytics, toCsv } from './usageAnalytics.js';
import { safeChildEnvironment } from './security.js';

let root = '';
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turing-metering-'));
  db = openDatabase(join(root, 'state'));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const base: ReservationRequest = {
  runId: 'run-a',
  stageId: null,
  billingLane: 'openrouter-metered',
  connectionProfileId: null,
  workload: 'decision',
  billingMode: 'subscriptions-plus-decision-budget',
  amountUsd: 0.02,
  perRunUsd: 0.05,
  unknownCostPolicy: 'block',
  reason: 'test',
};

describe('transactional metered budget reservation', () => {
  it('lets parallel requests reserve only what fits under the hard cap', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, () => Promise.resolve().then(() => reserveMetered(db, { ...base }))),
    );
    expect(outcomes.filter((item) => item.ok)).toHaveLength(2);
    const refused = outcomes.find((item) => !item.ok);
    expect(refused).toMatchObject({ ok: false, code: 'cap_exceeded' });
    expect(budgetStatus(db, 'run-a', 0.05).run.committedUsd).toBeCloseTo(0.04);
  });

  it('reconciles to provider actual cost, releases unused headroom, and releases failures', () => {
    const first = reserveMetered(db, base);
    const second = reserveMetered(db, base);
    if (!first.ok || !second.ok) throw new Error('reservation expected');
    expect(reserveMetered(db, base).ok).toBe(false);
    reconcileReservation(db, first.reservationId, 0.004, 'provider_measured');
    expect(budgetStatus(db, 'run-a', 0.05).run.committedUsd).toBeCloseTo(0.024);
    expect(reserveMetered(db, base).ok).toBe(true);
    releaseReservation(db, second.reservationId, 'request failed');
    expect(budgetStatus(db, 'run-a', 0.05).run.committedUsd).toBeCloseTo(0.024);
  });

  it('applies daily caps across runs and requires a per-run cap in Decision Budget mode', () => {
    saveBudgetSettings(db, { dailyUsd: 0.03, monthlyUsd: null, warningRatio: 0.8, timezone: 'UTC' });
    expect(reserveMetered(db, { ...base, runId: 'run-1' }).ok).toBe(true);
    expect(reserveMetered(db, { ...base, runId: 'run-2' })).toMatchObject({ ok: false, code: 'cap_exceeded' });
    expect(reserveMetered(db, { ...base, runId: 'run-3', perRunUsd: null })).toMatchObject({ ok: false, code: 'run_cap_required' });
  });

  it('never claims a hard cap for unbounded requests', () => {
    expect(reserveMetered(db, { ...base, amountUsd: null })).toMatchObject({ ok: false, code: 'unknown_cost_blocked' });
    expect(reserveMetered(db, { ...base, amountUsd: null, unknownCostPolicy: 'ask' })).toMatchObject({ ok: false, code: 'unknown_cost_needs_approval' });
    const allowed = reserveMetered(db, { ...base, amountUsd: null, unknownCostPolicy: 'allow-with-warning' });
    expect(allowed.ok && allowed.warnings.join(' ')).toContain('cannot guarantee the hard cap');
  });

  it('meters concurrent hook calls atomically and blocks metered work outside the billing mode', async () => {
    const hooks = () =>
      createMeteringHooks(db, {
        usageRunId: null,
        reservationScopeId: 'scope-1',
        stageId: null,
        billingMode: 'subscriptions-plus-decision-budget',
        perRunUsd: 0.03,
        unknownCostPolicy: 'block',
        workload: 'decision',
        connectionProfileId: null,
        role: 'decision-gate',
        modelId: 'typesafe/jev-1.13',
        modelDisplayName: null,
        reasoning: null,
        contextStrategy: null,
        decisionEngine: 'jev-openrouter',
        decisionType: 'boolean',
      });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => hooks().begin({ estimateUsd: 0.02, estimatedInputTokens: 100, estimatedOutputTokens: 0, label: 'Jev' })),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected' && item.reason instanceof MeteringBlockedError)).toHaveLength(2);
    const generative = createMeteringHooks(db, { ...({} as never), usageRunId: null, reservationScopeId: 'scope-2', stageId: null, billingMode: 'subscriptions-only', perRunUsd: 1, unknownCostPolicy: 'block', workload: 'generative', connectionProfileId: null, role: 'planner', modelId: 'x/y', modelDisplayName: null, reasoning: null, contextStrategy: null, decisionEngine: null, decisionType: null });
    await expect(generative.begin({ estimateUsd: 0.001, estimatedInputTokens: 1, estimatedOutputTokens: 1, label: 'x' })).rejects.toThrow('Subscriptions Only');
  });
});

describe('canonical usage events', () => {
  const init = {
    runId: null,
    stageId: null,
    role: 'planner',
    workloadType: 'generative' as const,
    backend: 'openrouter',
    connectionProfileId: null,
    billingLane: 'openrouter-metered' as const,
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-v4',
    variantId: null,
  };

  it('reconciles an estimate to provider telemetry in one row without double counting', () => {
    const id = createUsageEvent(db, { ...init, estimatedInputTokens: 10_000, estimatedOutputTokens: 500, estimatedCostUsd: 0.01 });
    reconcileUsageEvent(db, id, { source: 'openrouter-response', provenance: 'provider_measured', inputTokens: 9_714, outputTokens: 412, cachedInputTokens: 2_000, reasoningTokens: 100, actualCostUsd: 0.0061, costProvenance: 'provider_measured', status: 'succeeded' });
    // A later, weaker observation is audited but does not override the provider value.
    reconcileUsageEvent(db, id, { source: 'late-local-estimate', provenance: 'estimated', inputTokens: 12_000 });
    const rows = db.prepare('SELECT * FROM usage_events').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input_tokens: 9_714, output_tokens: 412, cached_input_tokens: 2_000, reasoning_tokens: 100, total_tokens: 10_126, provenance: 'provider_measured', actual_cost_usd: 0.0061, reconciliation_state: 'provider_reconciled', estimated_input_tokens: 10_000 });
    const audit = JSON.parse(String(rows[0]!.observations_json)) as Array<{ source: string }>;
    expect(audit.map((item) => item.source)).toEqual(['turing-preflight-estimate', 'openrouter-response', 'late-local-estimate']);
    const analytics = aggregateUsage(loadUsageEvents(db, { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', timeZone: 'UTC' }), { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', timeZone: 'UTC' });
    expect(analytics.totals.inputTokens.value).toBe(9_714);
    expect(analytics.totals.actualMeteredCostUsd.value).toBeCloseTo(0.0061);
  });
});

describe('shared usage analytics', () => {
  function seed() {
    const insert = (row: Record<string, unknown>) => {
      const id = createUsageEvent(db, {
        runId: null,
        stageId: null,
        role: String(row.role),
        workloadType: (row.workload as 'generative') ?? 'generative',
        backend: String(row.backend),
        connectionProfileId: null,
        billingLane: row.lane as 'opencode-go-subscription',
        providerId: String(row.provider),
        modelId: String(row.model),
        variantId: (row.variant as string) ?? null,
        reasoning: (row.reasoning as string) ?? null,
        projectId: null,
        occurredAt: String(row.at),
        decisionEngine: (row.engine as string) ?? null,
      });
      reconcileUsageEvent(db, id, {
        source: 'fixture',
        provenance: row.input === null ? 'unavailable' : 'provider_measured',
        inputTokens: row.input as number | null,
        outputTokens: row.output as number | null,
        cachedInputTokens: (row.cached as number) ?? null,
        reasoningTokens: (row.reasoningTokens as number) ?? null,
        actualCostUsd: (row.cost as number) ?? null,
        costProvenance: row.cost !== undefined ? 'provider_measured' : 'unavailable',
        status: 'succeeded',
      });
    };
    insert({ at: '2026-09-29T10:00:00Z', role: 'planner', backend: 'opencode', lane: 'opencode-go-subscription', provider: 'opencode-go', model: 'opencode-go/kimi-k3', variant: 'high', input: 12_000, output: 800, cached: 4_000 });
    insert({ at: '2026-09-30T23:30:00Z', role: 'reviewer', backend: 'cline', lane: 'clinepass-subscription', provider: 'cline-pass', model: 'cline-pass/deepseek-v4', input: 5_000, output: 600 });
    insert({ at: '2026-10-01T08:00:00Z', role: 'reviewer', backend: 'openrouter', lane: 'openrouter-metered', provider: 'openrouter', model: 'deepseek/deepseek-v4', input: 3_000, output: 400, reasoningTokens: 120, cost: 0.0042 });
    insert({ at: '2026-10-01T09:00:00Z', role: 'decision-gate', backend: 'openrouter', lane: 'openrouter-metered', provider: 'openrouter', model: 'typesafe/jev-1.13', workload: 'decision', engine: 'jev-openrouter', input: 476, output: 70, cost: 0.00002 });
    insert({ at: '2026-10-02T07:00:00Z', role: 'implementer', backend: 'claude-code', lane: 'claude-subscription', provider: 'anthropic-subscription', model: 'claude-sonnet-5-5', input: null, output: null });
    insert({ at: '2026-10-02T07:30:00Z', role: 'implementer', backend: 'codex-cli', lane: 'chatgpt-subscription', provider: 'openai-codex', model: 'gpt-6-luna', reasoning: 'xhigh', input: 20_000, output: 1_500 });
  }

  it('reconciles headline, chart, provider, model, and export totals for the same filter', () => {
    seed();
    const filter = { from: '2026-09-28T00:00:00Z', to: '2026-10-03T00:00:00Z', timeZone: 'UTC' };
    const result = queryUsageAnalytics(db, filter);
    const sum = (rows: Array<{ inputTokens: { value: number | null } }>) => rows.reduce((total, row) => total + (row.inputTokens.value ?? 0), 0);
    expect(result.totals.inputTokens.value).toBe(40_476);
    expect(sum(result.series)).toBe(40_476);
    expect(sum(result.byBillingLane)).toBe(40_476);
    expect(sum(result.byModel)).toBe(40_476);
    const exported = exportRows(loadUsageEvents(db, filter), 'UTC');
    expect(exported.reduce((total, row) => total + Number(row.inputTokens ?? 0), 0)).toBe(40_476);
    expect(result.totals.inputTokens).toMatchObject({ reported: 5, missing: 1 });
    expect(result.totals.cachedInputTokens.value).toBe(4_000);
    expect(result.totals.reasoningTokens.value).toBe(120);
    expect(result.totals.actualMeteredCostUsd.value).toBeCloseTo(0.00422);
    expect(result.activeModels).toBe(6);
    // Same model through different lanes stays distinct.
    expect(result.byModel.map((row) => row.key)).toEqual(expect.arrayContaining(['clinepass-subscription::cline-pass/deepseek-v4', 'openrouter-metered::deepseek/deepseek-v4']));
  });

  it('does not show unavailable metrics as zero and buckets days in the display timezone', () => {
    seed();
    const claudeOnly = queryUsageAnalytics(db, { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z', timeZone: 'UTC', billingLane: 'claude-subscription' });
    expect(claudeOnly.totals.inputTokens.value).toBeNull();
    expect(claudeOnly.totals.requests).toBe(1);
    const utc = queryUsageAnalytics(db, { from: '2026-09-28T00:00:00Z', to: '2026-10-03T00:00:00Z', timeZone: 'UTC', billingLane: 'clinepass-subscription' });
    expect(utc.series.find((item) => item.events > 0)?.bucket).toBe('2026-09-30');
    const auckland = queryUsageAnalytics(db, { from: '2026-09-28T00:00:00Z', to: '2026-10-03T00:00:00Z', timeZone: 'Pacific/Auckland', billingLane: 'clinepass-subscription' });
    expect(auckland.series.find((item) => item.events > 0)?.bucket).toBe('2026-10-01');
  });

  it('keeps decision analytics separate and exports no prompts or credentials', () => {
    seed();
    const decisions = queryUsageAnalytics(db, { from: '2026-09-28T00:00:00Z', to: '2026-10-03T00:00:00Z', timeZone: 'UTC', workloadType: 'decision' });
    expect(decisions.totals.requests).toBe(1);
    expect(decisions.byModel[0]).toMatchObject({ modelId: 'typesafe/jev-1.13', billingLane: 'openrouter-metered' });
    const csv = toCsv(exportRows(loadUsageEvents(db, { from: '2026-09-28T00:00:00Z', to: '2026-10-03T00:00:00Z', timeZone: 'UTC' }), 'UTC'));
    expect(csv.split('\r\n')).toHaveLength(7);
    expect(csv).not.toMatch(/prompt|apiKey|secret|sk-or-/i);
    expect(csv.split('\r\n')[0]).toContain('actualCostUsd');
  });
});

describe('desktop credential storage', () => {
  it('keeps OpenRouter keys out of SQLite, with owner-only permissions, and out of agent environments', () => {
    const store = SecretStore.forDatabase(db);
    store.write(secretRef('profile-1', 'inference'), 'sk-or-v1-test-inference-key');
    store.write(secretRef('profile-1', 'management'), 'sk-or-v1-test-management-key');
    expect(store.read(secretRef('profile-1', 'inference'))).toBe('sk-or-v1-test-inference-key');
    const dump = JSON.stringify(db.prepare("SELECT * FROM settings UNION ALL SELECT key, value, updated_at FROM settings").all());
    expect(dump).not.toContain('sk-or-v1');
    if (process.platform !== 'win32') expect(statSync(join(root, 'state', 'secrets', 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(() => store.write('secret:../../etc:inference', 'sk-or-v1-abcdefgh')).toThrow();
    store.deleteProfile('profile-1');
    expect(store.has(secretRef('profile-1', 'management'))).toBe(false);
    expect(safeChildEnvironment({ OPENROUTER_API_KEY: 'x', OPENROUTER_MANAGEMENT_KEY: 'y', PATH: '/bin' } as NodeJS.ProcessEnv)).toEqual({ PATH: '/bin' });
  });
});
