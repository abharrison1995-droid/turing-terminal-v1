import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus, WorkflowStage } from '../shared/types.js';

vi.mock('./providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in acceptance tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { discoverProviders, executeProvider, type ProviderRunRequest } from './providers.js';
import { RunEngine } from './runEngine.js';
import { invalidateOpenRouterCatalog } from './modelCatalog.js';

const caps = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery: true,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: true,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
  ...overrides,
});

const now = () => new Date().toISOString();
const openCode = (): ProviderStatus => ({
  id: 'opencode',
  name: 'OpenCode',
  cli: 'opencode',
  detected: true,
  version: 'test-opencode',
  authentication: 'connected',
  subscriptionAuthenticated: null,
  authMechanism: 'test',
  note: 'test',
  checkedAt: now(),
  capabilities: caps(),
  models: [
    {
      id: 'opencode-go/kimi-k3',
      name: 'Kimi K3',
      providerId: 'opencode-go',
      subscriptionBacked: true,
      variantIds: ['high', 'max'],
    },
    {
      id: 'opencode-go/deepseek-v4',
      name: 'DeepSeek V4',
      providerId: 'opencode-go',
      subscriptionBacked: true,
    },
  ],
});
const cline = (): ProviderStatus => ({
  id: 'cline',
  name: 'Cline',
  cli: 'cline',
  detected: true,
  version: 'test-cline',
  authentication: 'unknown',
  subscriptionAuthenticated: null,
  authMechanism: 'test',
  note: 'test',
  checkedAt: now(),
  capabilities: caps({ modelDiscovery: false }),
  models: [],
});
const codex = (connected: boolean): ProviderStatus => ({
  id: 'codex-cli',
  name: 'Codex',
  cli: 'codex',
  detected: true,
  version: '0.160.0',
  authentication: connected ? 'connected' : 'disconnected',
  subscriptionAuthenticated: connected,
  authMechanism: 'test',
  note: 'test',
  checkedAt: now(),
  capabilities: caps(),
  models: connected
    ? [
        {
          id: 'gpt-6-luna',
          name: 'GPT-6 Luna',
          providerId: 'openai-codex',
          subscriptionBacked: true,
          reasoningLevels: ['high', 'xhigh'],
        },
      ]
    : [],
});
const claude = (connected: boolean): ProviderStatus => ({
  id: 'claude-code',
  name: 'Claude Code',
  cli: 'claude',
  detected: true,
  version: '2.1.300',
  authentication: connected ? 'connected' : 'disconnected',
  subscriptionAuthenticated: connected,
  authMechanism: 'test',
  note: 'test',
  checkedAt: now(),
  capabilities: caps({ modelDiscovery: false }),
  models: [],
});

const route = (
  backendId: string,
  providerId: string,
  billingLane: string,
  modelId: string,
  extra: Partial<WorkflowStage> = {},
) => ({ backendId, providerId, billingLane, modelId, ...extra });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Phase 3.6 acceptance', () => {
  let root = '';
  let projectPath = '';
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let engine: RunEngine;
  let projectId = '';
  const fetchCalls: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'turing-p36-'));
    projectPath = join(root, 'project');
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ scripts: {} }));
    db = openDatabase(join(root, 'state'));
    engine = new RunEngine(db, () => undefined);
    app = createApp({ database: db, engine });
    await app.ready();
    projectId = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } })
    ).json().project.id;
    fetchCalls.length = 0;
    invalidateOpenRouterCatalog();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        fetchCalls.push(String(url));
        throw new Error(`Unexpected network request: ${String(url)}`);
      }),
    );
    vi.mocked(executeProvider).mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function saveWorkflow(
    name: string,
    stages: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name,
        description: 'acceptance',
        template: 'custom',
        executionProfile: 'maximum',
        permissionMode: 'normal',
        maxRemediationRounds: 1,
        maxParallelAgents: 3,
        isolatedWorktree: false,
        stages,
        ...extra,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().workflow.id as string;
  }

  async function runToEnd(workflowId: string, task = 'Implement the bounded change.') {
    const preview = await app.inject({
      method: 'POST',
      url: '/api/runs/preview',
      payload: { task, projectId, workflowId },
    });
    expect(preview.statusCode).toBe(200);
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { task, projectId, workflowId },
    });
    expect(started.statusCode, started.body).toBe(202);
    const runId = started.json().run.id as string;
    await vi.waitFor(
      () => {
        const status = (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string })
          .status;
        expect(['completed', 'failed', 'waiting_for_approval', 'cancelled']).toContain(status);
      },
      { timeout: 5_000 },
    );
    return { runId, preview: preview.json().preview };
  }

  function scriptedProvider(calls: ProviderRunRequest[]) {
    let reviews = 0;
    vi.mocked(executeProvider).mockImplementation(async (request) => {
      calls.push(request);
      const text =
        request.role === 'reviewer'
          ? reviews++ === 0
            ? '{"findings":[{"severity":"medium","category":"correctness","description":"Guard the empty case.","evidence":"src/a.ts","affectedFiles":["src/a.ts"],"recommendedRemediation":"Add a guard."}]}'
            : '{"findings":[]}'
          : request.role === 'final-gate'
            ? '{"pass":true,"reason":"Acceptance criteria met."}'
            : request.role === 'orchestrator'
              ? '{"branch":"standard","rationale":"bounded"}'
              : `${request.role} artifact`;
      return {
        text,
        inputTokens: 100,
        outputTokens: 20,
        usageProvenance: 'provider_reported',
        exitCode: 0,
        stdout: 'ok',
      };
    });
  }

  const fullLoop = (r: (role: string) => Record<string, unknown>) => [
    { id: 'plan', label: 'Planner', kind: 'planner', role: 'planner', ...r('planner') },
    {
      id: 'orchestrate',
      label: 'Orchestrator',
      kind: 'orchestrator',
      role: 'orchestrator',
      ...r('orchestrator'),
      orchestration: {
        branches: [
          { id: 'standard', label: 'Standard path', skipStageIds: [] },
          { id: 'fast', label: 'Skip remediation', skipStageIds: ['remediate'] },
        ],
        defaultBranchId: 'standard',
      },
    },
    { id: 'implement', label: 'Implementer', kind: 'implementer', role: 'implementer', ...r('implementer') },
    { id: 'review', label: 'Reviewer', kind: 'reviewer', role: 'reviewer', ...r('reviewer') },
    { id: 'remediate', label: 'Remediation', kind: 'remediation', role: 'remediation', ...r('remediation') },
    { id: 'final', label: 'Final gate', kind: 'finalGate', role: 'final-gate', ...r('final-gate') },
  ];

  it('§88 runs a full loop entirely on OpenCode Go with ChatGPT and Claude disconnected', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode(), codex(false), claude(false)]);
    const workflowId = await saveWorkflow(
      'All OpenCode Go',
      fullLoop((role) =>
        role === 'implementer'
          ? route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/deepseek-v4')
          : route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/kimi-k3', {
              variantId: role === 'reviewer' ? 'max' : 'high',
            }),
      ),
    );
    const calls: ProviderRunRequest[] = [];
    scriptedProvider(calls);
    const { runId, preview } = await runToEnd(workflowId);
    expect(preview.canStart).toBe(true);
    expect(preview.billingMode).toBe('subscriptions-only');
    expect(preview.routingSummary.meteredNone).toBe(true);
    expect(
      preview.routingSummary.subscriptions.find(
        (item: { billingLane: string }) => item.billingLane === 'opencode-go-subscription',
      ).stages,
    ).toHaveLength(6);
    for (const lane of ['chatgpt-subscription', 'claude-subscription', 'clinepass-subscription'])
      expect(
        preview.routingSummary.subscriptions.find(
          (item: { billingLane: string }) => item.billingLane === lane,
        ).stages,
      ).toEqual([]);
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'completed',
    );
    expect(
      new Set(
        calls.map((call) => `${call.backendId}|${call.providerId}|${call.billingLane}|${call.billingMode}`),
      ),
    ).toEqual(new Set(['opencode|opencode-go|opencode-go-subscription|subscriptions-only']));
    expect(calls.map((call) => [call.role, call.modelId, call.variantId ?? null])).toEqual(
      expect.arrayContaining([
        ['planner', 'opencode-go/kimi-k3', 'high'],
        ['implementer', 'opencode-go/deepseek-v4', null],
        ['reviewer', 'opencode-go/kimi-k3', 'max'],
        ['remediation', 'opencode-go/kimi-k3', 'high'],
      ]),
    );
    const lanes = db
      .prepare('SELECT DISTINCT billing_lane, provider_id FROM usage_events WHERE run_id = ?')
      .all(runId);
    expect(lanes).toEqual([{ billing_lane: 'opencode-go-subscription', provider_id: 'opencode-go' }]);
    expect(fetchCalls).toEqual([]);
    const orchestrator = db
      .prepare("SELECT output_json FROM stages WHERE run_id = ? AND stage_key = 'orchestrate'")
      .get(runId) as { output_json: string };
    expect(JSON.parse(orchestrator.output_json).orchestration).toMatchObject({
      selectedBranchId: 'standard',
      usedDefault: false,
      skippedStageIds: [],
    });
  });

  it('§89 runs a full loop entirely on ClinePass with no Cline usage-billing, ChatGPT, or Claude', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([cline(), codex(false), claude(false)]);
    const workflowId = await saveWorkflow(
      'All ClinePass',
      fullLoop((role) =>
        route(
          'cline',
          'cline-pass',
          'clinepass-subscription',
          role === 'reviewer' ? 'cline-pass/glm-5' : 'cline-pass/kimi-k3',
        ),
      ),
    );
    const calls: ProviderRunRequest[] = [];
    scriptedProvider(calls);
    const { runId, preview } = await runToEnd(workflowId);
    expect(preview.canStart).toBe(true);
    expect(
      preview.billingSummary.find(
        (item: { billingLane: string }) => item.billingLane === 'cline-usage-billing',
      ).stages,
    ).toEqual([]);
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'completed',
    );
    expect(new Set(calls.map((call) => `${call.providerId}|${call.billingLane}`))).toEqual(
      new Set(['cline-pass|clinepass-subscription']),
    );
    expect(calls.find((call) => call.role === 'reviewer')?.modelId).toBe('cline-pass/glm-5');
    expect(db.prepare('SELECT DISTINCT billing_lane FROM usage_events WHERE run_id = ?').all(runId)).toEqual([
      { billing_lane: 'clinepass-subscription' },
    ]);
  });

  it('§90/§91 hands structured artifacts across four providers with exact variants and no provider preference', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode(), cline(), codex(true), claude(true)]);
    const workflowId = await saveWorkflow('Mixed providers', [
      {
        id: 'plan',
        label: 'Planner',
        kind: 'planner',
        role: 'planner',
        ...route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/kimi-k3', {
          variantId: 'high',
        }),
      },
      {
        id: 'implement',
        label: 'Implementer',
        kind: 'implementer',
        role: 'implementer',
        ...route('cline', 'cline-pass', 'clinepass-subscription', 'cline-pass/deepseek-v4'),
      },
      {
        id: 'review',
        label: 'Reviewer',
        kind: 'reviewer',
        role: 'reviewer',
        ...route('codex-cli', 'openai-codex', 'chatgpt-subscription', 'gpt-6-luna', { reasoning: 'xhigh' }),
      },
      {
        id: 'review2',
        label: 'Second reviewer',
        kind: 'reviewer',
        role: 'reviewer',
        ...route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/kimi-k3', {
          variantId: 'max',
        }),
      },
      {
        id: 'final',
        label: 'Final gate',
        kind: 'finalGate',
        role: 'final-gate',
        ...route('claude-code', 'anthropic-subscription', 'claude-subscription', 'claude-sonnet-5-5'),
      },
    ]);
    const calls: ProviderRunRequest[] = [];
    vi.mocked(executeProvider).mockImplementation(async (request) => {
      calls.push(request);
      const text =
        request.role === 'reviewer'
          ? '{"findings":[]}'
          : request.role === 'final-gate'
            ? '{"pass":true,"reason":"ok"}'
            : `${request.role} done`;
      return {
        text,
        inputTokens: 50,
        outputTokens: 5,
        usageProvenance: 'provider_reported',
        exitCode: 0,
        stdout: '',
      };
    });
    const { runId, preview } = await runToEnd(workflowId);
    expect(
      preview.providerAssignments.map((item: { variantId: string | null; reasoning: string | null }) => [
        item.variantId,
        item.reasoning,
      ]),
    ).toEqual([
      ['high', null],
      [null, null],
      [null, 'xhigh'],
      ['max', null],
      [null, null],
    ]);
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'completed',
    );
    const byRole = (role: string, index = 0) => calls.filter((call) => call.role === role)[index]!;
    expect(byRole('implementer').prompt).toContain('"kind":"PlanArtifact"');
    expect(byRole('reviewer').prompt).toContain('"kind":"ImplementationResult"');
    expect(byRole('final-gate').prompt).toContain('"kind":"ReviewFinding[]"');
    expect(calls.map((call) => call.billingLane)).toEqual([
      'opencode-go-subscription',
      'clinepass-subscription',
      'chatgpt-subscription',
      'opencode-go-subscription',
      'claude-subscription',
    ]);
    const snapshots = (
      db
        .prepare(
          'SELECT stage_key, variant_id, model_snapshot_json FROM stages WHERE run_id = ? ORDER BY sequence',
        )
        .all(runId) as Array<{ stage_key: string; variant_id: string | null; model_snapshot_json: string }>
    ).map((row) => [row.stage_key, row.variant_id, JSON.parse(row.model_snapshot_json).identity]);
    expect(snapshots).toEqual([
      ['plan', 'high', 'pinned'],
      ['implement', null, 'pinned'],
      ['review', null, 'pinned'],
      ['review2', 'max', 'pinned'],
      ['final', null, 'pinned'],
    ]);
    const usage = db
      .prepare(
        'SELECT s.stage_key, u.variant_id, u.reasoning FROM usage_events u JOIN stages s ON s.id = u.stage_id WHERE u.run_id = ? ORDER BY s.sequence',
      )
      .all(runId);
    expect(usage).toEqual([
      { stage_key: 'plan', variant_id: 'high', reasoning: null },
      { stage_key: 'implement', variant_id: null, reasoning: null },
      { stage_key: 'review', variant_id: null, reasoning: 'xhigh' },
      { stage_key: 'review2', variant_id: 'max', reasoning: null },
      { stage_key: 'final', variant_id: null, reasoning: null },
    ]);
  });

  it('§25 blocks only the disconnected provider a workflow actually uses', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode(), claude(false)]);
    const workflowId = await saveWorkflow('Needs Claude', [
      {
        id: 'plan',
        label: 'Planner',
        kind: 'planner',
        ...route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/kimi-k3'),
      },
      {
        id: 'review',
        label: 'Reviewer',
        kind: 'reviewer',
        ...route('claude-code', 'anthropic-subscription', 'claude-subscription', 'claude-sonnet-5-5'),
      },
    ]);
    const preview = (
      await app.inject({
        method: 'POST',
        url: '/api/runs/preview',
        payload: { task: 'x', projectId, workflowId },
      })
    ).json().preview;
    expect(preview.canStart).toBe(false);
    expect(preview.providerAssignments.map((item: { ready: boolean }) => item.ready)).toEqual([true, false]);
  });

  async function addOpenRouter(name = 'OpenRouter — Alex') {
    const profile = await app.inject({
      method: 'POST',
      url: '/api/connection-profiles',
      payload: {
        name,
        backendId: 'openrouter',
        providerId: 'openrouter',
        billingLane: 'openrouter-metered',
        metadata: {},
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const id = profile.json().profile.id as string;
    const key = await app.inject({
      method: 'PUT',
      url: `/api/connection-profiles/${id}/credentials/inference`,
      payload: { secret: 'sk-or-v1-acceptance-inference-key' },
    });
    expect(key.statusCode).toBe(200);
    expect(key.body).not.toContain('acceptance-inference-key');
    return id;
  }

  function openRouterNetwork(options: { noul?: number; chatCost?: number; chatDelayMs?: number } = {}) {
    const chatBodies: Array<Record<string, unknown>> = [];
    const decisionBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        fetchCalls.push(target);
        expect(
          new Headers(init?.headers).get('authorization') ?? 'Bearer sk-or-v1-acceptance-inference-key',
        ).toBe('Bearer sk-or-v1-acceptance-inference-key');
        if (target.endsWith('/api/v1/models'))
          return jsonResponse({
            data: [
              {
                id: 'typesafe/jev-1.13',
                name: 'Jev 1.13',
                pricing: { prompt: '0.00000004', completion: '0' },
                context_length: 32_000,
                supported_parameters: [],
              },
              {
                id: 'deepseek/deepseek-v4',
                name: 'DeepSeek V4',
                pricing: { prompt: '0', completion: '0.000005' },
                top_provider: { max_completion_tokens: 8_192 },
                supported_parameters: ['max_tokens'],
              },
            ],
          });
        if (target.endsWith('/api/alpha/decisions')) {
          decisionBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            id: 'gen-dec-1',
            model: 'typesafe/jev-1.13-20260917',
            provider: 'TypeSafe',
            answers: { gate: { type: 'noul', noul: options.noul ?? 0.97 } },
            usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
          });
        }
        if (target.endsWith('/api/v1/chat/completions')) {
          chatBodies.push(JSON.parse(String(init?.body)));
          await new Promise((resolve) => setTimeout(resolve, options.chatDelayMs ?? 0));
          return jsonResponse({
            id: `gen-${chatBodies.length}`,
            model: 'deepseek/deepseek-v4',
            provider: 'DeepInfra',
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"findings":[]}' } }],
            usage: { prompt_tokens: 800, completion_tokens: 40, cost: options.chatCost ?? 0.019 },
          });
        }
        throw new Error(`Unexpected network request: ${target}`);
      }),
    );
    return { chatBodies, decisionBodies };
  }

  const jevGate = (profileId: string, extra: Record<string, unknown> = {}) => ({
    id: 'gate',
    label: 'Decision gate',
    kind: 'decisionGate',
    decision: {
      engine: 'jev-openrouter',
      modelId: 'typesafe/jev-1.13',
      connectionProfileId: profileId,
      questionType: 'boolean',
      question: 'Are all required acceptance criteria satisfied?',
      criteria: { true: 'All satisfied', false: 'Something is missing' },
      inputs: ['task', 'implementation', 'tests'],
      routing: {
        field: 'probability',
        passAtOrAbove: 0.95,
        failAtOrBelow: 0.15,
        onPass: { action: 'continue' },
        onFail: { action: 'fail-run' },
        onUncertain: { action: 'human-approval' },
      },
      ...extra,
    },
  });

  it('§92 Subscriptions + Decision Budget: only the Jev gate spends, under an atomic reservation, and analytics separate it', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode(), codex(false), claude(false)]);
    const profileId = await addOpenRouter();
    const network = openRouterNetwork({ noul: 0.97 });
    const go = (model = 'opencode-go/kimi-k3') =>
      route('opencode', 'opencode-go', 'opencode-go-subscription', model);
    const workflowId = await saveWorkflow(
      'Subscriptions plus Jev',
      [
        { id: 'plan', label: 'Planner', kind: 'planner', role: 'planner', ...go() },
        {
          id: 'implement',
          label: 'Implementer',
          kind: 'implementer',
          role: 'implementer',
          ...go('opencode-go/deepseek-v4'),
        },
        jevGate(profileId),
        { id: 'review', label: 'Reviewer', kind: 'reviewer', role: 'reviewer', ...go() },
        { id: 'final', label: 'Final gate', kind: 'finalGate', role: 'final-gate', ...go() },
      ],
      {
        billingMode: 'subscriptions-plus-decision-budget',
        meteredBudget: { perRunUsd: 0.02, unknownCostPolicy: 'block' },
        externalDecisionDataPolicy: 'allow',
      },
    );
    const calls: ProviderRunRequest[] = [];
    vi.mocked(executeProvider).mockImplementation(async (request) => {
      calls.push(request);
      return {
        text:
          request.role === 'reviewer'
            ? '{"findings":[]}'
            : request.role === 'final-gate'
              ? '{"pass":true,"reason":"ok"}'
              : 'done',
        inputTokens: 10,
        outputTokens: 2,
        usageProvenance: 'provider_reported',
        exitCode: 0,
        stdout: '',
      };
    });
    const { runId, preview } = await runToEnd(workflowId);
    expect(preview.canStart).toBe(true);
    expect(preview.routingSummary).toMatchObject({
      meteredNone: false,
      runMeteredCapUsd: 0.02,
      paygFallback: 'none',
      metered: [
        { billingLane: 'openrouter-metered', generativeStages: [], decisionStages: ['Decision gate'] },
      ],
    });
    expect(
      preview.providerAssignments.find((item: { stage: string }) => item.stage === 'Decision gate'),
    ).toMatchObject({
      workload: 'decision',
      billingLane: 'openrouter-metered',
      decision: { engine: 'jev-openrouter', routingField: 'probability', external: true },
    });
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'completed',
    );
    expect(network.chatBodies).toHaveLength(0);
    expect(network.decisionBodies).toHaveLength(1);
    expect(network.decisionBodies[0]).toMatchObject({
      model: 'typesafe/jev-1.13',
      questions: { gate: { type: 'noul' } },
    });
    expect(Object.keys(network.decisionBodies[0]!.state as object).sort()).toEqual([
      'implementation',
      'taskSpecification',
      'tests',
    ]);
    expect(calls.every((call) => call.billingLane === 'opencode-go-subscription')).toBe(true);
    expect(db.prepare('SELECT status, actual_usd, cost_bound FROM metered_reservations').all()).toEqual([
      { status: 'reconciled', actual_usd: 0.00002, cost_bound: 'bounded' },
    ]);
    const decision = db
      .prepare(
        'SELECT engine, probability, confidence, outcome, config_hash, resolved_model_id FROM decision_results WHERE run_id = ?',
      )
      .get(runId) as Record<string, unknown>;
    expect(decision).toMatchObject({
      engine: 'jev-openrouter',
      probability: 0.97,
      confidence: null,
      outcome: 'pass',
      resolved_model_id: 'typesafe/jev-1.13-20260917',
    });
    expect(String(decision.config_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      db
        .prepare(
          "SELECT workload_type, billing_lane, actual_cost_usd, input_tokens, upstream_provider FROM usage_events WHERE run_id = ? AND billing_lane = 'openrouter-metered'",
        )
        .all(runId),
    ).toEqual([
      {
        workload_type: 'decision',
        billing_lane: 'openrouter-metered',
        actual_cost_usd: 0.00002,
        input_tokens: 476,
        upstream_provider: 'TypeSafe',
      },
    ]);
    const analytics = (
      await app.inject({
        method: 'GET',
        url: '/api/usage/analytics?range=today&tz=UTC&workloadType=decision',
      })
    ).json();
    expect(analytics.totals.requests).toBe(1);
    expect(analytics.decisions).toMatchObject({
      decisions: 1,
      byType: { boolean: 1 },
      autoRouted: 1,
      escalated: 0,
    });
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(detail.json().decisions[0]).toMatchObject({ probability: 0.97, outcome: 'pass' });
    for (const body of [
      detail.body,
      (await app.inject({ method: 'GET', url: '/api/connection-profiles' })).body,
      (await app.inject({ method: 'GET', url: '/api/usage/export?range=today&tz=UTC' })).body,
    ])
      expect(body).not.toContain('acceptance-inference-key');

    // The same gate is blocked outright in Subscriptions Only.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/runs/preview',
      payload: { task: 'x', projectId, workflowId, billingMode: 'subscriptions-only' },
    });
    expect(blocked.json().preview.canStart).toBe(false);
    expect(blocked.json().preview.warnings.join(' ')).toContain('Subscriptions Only');
  });

  it('§93 routes an uncertain probability to human approval and a low probability to FAIL', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode()]);
    const profileId = await addOpenRouter();
    openRouterNetwork({ noul: 0.5 });
    vi.mocked(executeProvider).mockResolvedValue({
      text: 'done',
      inputTokens: 1,
      outputTokens: 1,
      usageProvenance: 'provider_reported',
      exitCode: 0,
      stdout: '',
    });
    const workflowId = await saveWorkflow(
      'Uncertain gate',
      [
        {
          id: 'plan',
          label: 'Planner',
          kind: 'planner',
          role: 'planner',
          ...route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/kimi-k3'),
        },
        jevGate(profileId),
      ],
      {
        billingMode: 'subscriptions-plus-decision-budget',
        meteredBudget: { perRunUsd: 0.02, unknownCostPolicy: 'block' },
        externalDecisionDataPolicy: 'allow',
      },
    );
    const { runId } = await runToEnd(workflowId);
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'waiting_for_approval',
    );
    expect(db.prepare('SELECT outcome FROM decision_results WHERE run_id = ?').get(runId)).toEqual({
      outcome: 'uncertain',
    });
    const approval = db
      .prepare("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'")
      .get(runId) as { id: string };
    await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/decision`,
      payload: { approved: true },
    });
    await vi.waitFor(() =>
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toEqual({ status: 'completed' }),
    );

    invalidateOpenRouterCatalog();
    openRouterNetwork({ noul: 0.05 });
    const failed = await runToEnd(workflowId);
    expect(db.prepare('SELECT status, summary FROM runs WHERE id = ?').get(failed.runId)).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('Decision Gate routed to FAIL'),
    });
  });

  it('§57 asks before first sending project state to an external decision engine, and Block refuses', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode()]);
    const profileId = await addOpenRouter();
    const network = openRouterNetwork({ noul: 0.99 });
    const workflowId = await saveWorkflow('Consent gate', [jevGate(profileId)], {
      billingMode: 'subscriptions-plus-decision-budget',
      meteredBudget: { perRunUsd: 0.02, unknownCostPolicy: 'block' },
    });
    const { runId } = await runToEnd(workflowId);
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'waiting_for_approval',
    );
    expect(network.decisionBodies).toHaveLength(0);
    const approval = db
      .prepare("SELECT id, operation FROM approvals WHERE run_id = ? AND status = 'pending'")
      .get(runId) as { id: string; operation: string };
    expect(approval.operation).toContain('First external decision send');
    await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/decision`,
      payload: { approved: true },
    });
    await vi.waitFor(() =>
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toEqual({ status: 'completed' }),
    );
    expect(network.decisionBodies).toHaveLength(1);

    const blockedId = await saveWorkflow('Blocked gate', [jevGate(profileId)], {
      billingMode: 'subscriptions-plus-decision-budget',
      meteredBudget: { perRunUsd: 0.02, unknownCostPolicy: 'block' },
      externalDecisionDataPolicy: 'block',
    });
    const preview = (
      await app.inject({
        method: 'POST',
        url: '/api/runs/preview',
        payload: { task: 'x', projectId, workflowId: blockedId },
      })
    ).json().preview;
    expect(preview.canStart).toBe(false);
    expect(preview.warnings.join(' ')).toContain('external decision data is blocked');
  });

  it('§95 parallel metered reviewers cannot race past the per-run hard cap', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([]);
    const profileId = await addOpenRouter();
    const network = openRouterNetwork({ chatCost: 0.019, chatDelayMs: 20 });
    const workflowId = await saveWorkflow(
      'Parallel metered review',
      [
        {
          id: 'review',
          label: 'Parallel review',
          kind: 'parallelReview',
          role: 'reviewer',
          parallelism: 3,
          backendId: 'openrouter',
          providerId: 'openrouter',
          billingLane: 'openrouter-metered',
          connectionProfileId: profileId,
          modelId: 'deepseek/deepseek-v4',
          nativeSettings: { maxOutputTokens: 4_000 },
        },
      ],
      {
        billingMode: 'custom',
        customAllowedLanes: ['openrouter-metered'],
        meteredBudget: { perRunUsd: 0.05, unknownCostPolicy: 'block' },
      },
    );
    const { runId, preview } = await runToEnd(workflowId);
    expect(preview.canStart).toBe(true);
    expect(preview.routingSummary.metered[0]).toMatchObject({
      billingLane: 'openrouter-metered',
      generativeStages: ['Parallel review'],
    });
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'failed',
    );
    expect(network.chatBodies).toHaveLength(2);
    const reservations = db
      .prepare('SELECT status, reserved_usd, actual_usd FROM metered_reservations WHERE run_id = ?')
      .all(runId) as Array<{ status: string; reserved_usd: number; actual_usd: number }>;
    expect(reservations).toHaveLength(2);
    expect(
      reservations.every((item) => item.status === 'reconciled' && Math.abs(item.reserved_usd - 0.02) < 1e-9),
    ).toBe(true);
    expect(reservations.reduce((total, item) => total + item.actual_usd, 0)).toBeLessThanOrEqual(0.05);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'metered_request_blocked'",
        )
        .get(runId),
    ).toEqual({ count: 1 });
    expect(network.chatBodies[0]).toMatchObject({
      model: 'deepseek/deepseek-v4',
      max_tokens: 4_000,
      provider: { max_price: { prompt: 0, completion: 5 } },
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count, SUM(actual_cost_usd) AS cost FROM usage_events WHERE run_id = ? AND billing_lane = 'openrouter-metered'",
        )
        .get(runId),
    ).toEqual({ count: 2, cost: 0.038 });
  });

  it('§94 compacts optional context to fit, keeps mandatory instructions, and stops when mandatory content alone exceeds the limit', async () => {
    vi.mocked(discoverProviders).mockResolvedValue([openCode()]);
    await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        scope: 'global',
        name: 'Security',
        content: 'MANDATORY-RULE-TEXT: never print credentials.',
        mandatory: true,
      },
    });
    const go = route('opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go/kimi-k3');
    const workflowId = await saveWorkflow('Context budget', [
      { id: 'implement', label: 'Implementer', kind: 'implementer', role: 'implementer', ...go },
      {
        id: 'review',
        label: 'Reviewer',
        kind: 'reviewer',
        role: 'reviewer',
        ...go,
        contextPolicy: {
          strategy: 'full-project',
          maxEstimatedTokens: 6_000,
          includePreviousTranscript: true,
          onLimitExceeded: 'compact',
        },
      },
    ]);
    const prompts: string[] = [];
    vi.mocked(executeProvider).mockImplementation(async (request) => {
      prompts.push(request.prompt);
      return {
        text: request.role === 'implementer' ? 'x'.repeat(60_000) : '{"findings":[]}',
        inputTokens: 1,
        outputTokens: 1,
        usageProvenance: 'provider_reported',
        exitCode: 0,
        stdout: '',
      };
    });
    const { runId } = await runToEnd(workflowId, 'TASK-MARKER: keep this task.');
    expect((db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'completed',
    );
    const reviewPrompt = prompts[1]!;
    expect(reviewPrompt).toContain('TASK-MARKER: keep this task.');
    expect(reviewPrompt).toContain('MANDATORY-RULE-TEXT');
    expect(reviewPrompt).toContain('[Optional context compacted to fit the configured budget.]');
    expect(Math.ceil(reviewPrompt.length / 4)).toBeLessThanOrEqual(6_000);

    const tightId = await saveWorkflow('Mandatory too large', [
      {
        id: 'plan',
        label: 'Planner',
        kind: 'planner',
        role: 'planner',
        ...go,
        contextPolicy: { maxEstimatedTokens: 1_000, onLimitExceeded: 'compact' },
      },
    ]);
    prompts.length = 0;
    const tight = await runToEnd(tightId, `TASK ${'detail '.repeat(1_200)}`);
    expect(prompts).toHaveLength(0);
    expect(db.prepare('SELECT status, summary FROM runs WHERE id = ?').get(tight.runId)).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('Mandatory task and rule information was retained'),
    });
  });

  it('§87 ships safe defaults, and adding OpenRouter changes no workflow', async () => {
    const before = db.prepare('SELECT id, config_json FROM workflows ORDER BY id').all() as Array<{
      id: string;
      config_json: string;
    }>;
    const workflows = (await app.inject({ method: 'GET', url: '/api/workflows' })).json().workflows as Array<
      Record<string, unknown> & { stages: Array<{ kind: string }> }
    >;
    for (const workflow of workflows) {
      expect(workflow).toMatchObject({
        billingMode: 'subscriptions-only',
        subscriptionOnly: true,
        lockProviders: true,
        externalDecisionDataPolicy: 'ask-first',
        meteredBudget: { perRunUsd: null, unknownCostPolicy: 'block' },
        contextPolicy: { strategy: 'focused' },
      });
      expect(workflow.stages.some((stage) => stage.kind === 'decisionGate')).toBe(false);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [] })),
    );
    await addOpenRouter();
    expect(db.prepare('SELECT id, config_json FROM workflows ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM metered_reservations').get()).toEqual({ count: 0 });
  });

  it('§98 keeps credentials and budget administration desktop-only, even for a paired phone', async () => {
    const profileId = await addOpenRouter();
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const token = 'phone-session-token-for-tests';
    db.prepare(
      'INSERT INTO device_sessions (id, machine_id, name, token_hash, created_at, expires_at, tailscale_login) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'phone',
      machineId,
      'Phone',
      createHash('sha256').update(token).digest('hex'),
      now(),
      new Date(Date.now() + 86_400_000).toISOString(),
      'alex@example.com',
    );
    const phone = {
      'tailscale-user-login': 'alex@example.com',
      cookie: `__Host-turing-device=${token}`,
      host: 'turing.tail.ts.net',
    };
    expect(
      (await app.inject({ method: 'GET', url: '/api/connection-profiles', headers: phone })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/connection-profiles/${profileId}/credentials/inference`,
          headers: phone,
          payload: { secret: 'sk-or-v1-from-phone-xxxx' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/connection-profiles/${profileId}/credentials/inference`,
          headers: phone,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/budgets',
          headers: phone,
          payload: { dailyUsd: 100, monthlyUsd: null },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/budgets',
          payload: { dailyUsd: 1, monthlyUsd: 10, warningRatio: 0.8, timezone: 'Europe/London' },
        })
      ).statusCode,
    ).toBe(200);
    const profiles = (
      await app.inject({ method: 'GET', url: '/api/connection-profiles', headers: phone })
    ).json().profiles;
    expect(profiles[0]).toMatchObject({ credentials: { inference: true, management: false } });
    expect(JSON.stringify(profiles)).not.toContain('sk-or-v1');
    const cli = await app.inject({
      method: 'POST',
      url: '/api/connection-profiles',
      payload: {
        name: 'Codex',
        backendId: 'codex-cli',
        providerId: 'openai-codex',
        billingLane: 'chatgpt-subscription',
        metadata: {},
      },
    });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/connection-profiles/${cli.json().profile.id}/credentials/inference`,
          payload: { secret: 'sk-should-not-store' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/connection-profiles',
          payload: {
            name: 'Mislabelled',
            backendId: 'cline',
            providerId: 'cline-pass',
            billingLane: 'cline-usage-billing',
            metadata: {},
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('§55 evaluates a Decision Gate policy against deterministic fixtures', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/decision-gates/test',
      payload: {
        decision: {
          engine: 'deterministic-rules',
          questionType: 'boolean',
          question: 'Are there no failing tests?',
          inputs: [],
          rule: { path: 'tests.failed', operator: 'equals', value: 0 },
          routing: {
            field: 'probability',
            passAtOrAbove: 0.95,
            failAtOrBelow: 0.15,
            onPass: { action: 'continue' },
            onFail: { action: 'fail-run' },
            onUncertain: { action: 'human-approval' },
          },
        },
        fixtures: [
          { name: 'green', conditionValues: { 'tests.failed': 0 }, expected: true },
          { name: 'red', conditionValues: { 'tests.failed': 2 }, expected: false },
          { name: 'mislabelled', conditionValues: { 'tests.failed': 0 }, expected: false },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      accuracy: 2 / 3,
      escalationRate: 0,
      errors: 0,
      actualCostUsd: 0,
      costProvenance: 'locally_measured',
      probability: { count: 3, min: 0, max: 1 },
    });
    expect(fetchCalls).toEqual([]);
  });
});
