import { describe, expect, it, vi } from 'vitest';
import type { DecisionGateConfig, ModelOption } from '../shared/types.js';
import {
  decisionConfigHash,
  evaluateDecisionGate,
  parseJevAnswer,
  parseJudgeAnswer,
  toJevQuestion,
  type DecisionContext,
} from './decisionEngines.js';
import {
  estimateReservationUsd,
  maxPriceFor,
  parseOpenRouterModels,
  runOpenRouterAgent,
  usageObservationFrom,
  fetchKeyTelemetry,
  type MeteringHooks,
} from './openrouter.js';

const jevModel: ModelOption = {
  id: 'typesafe/jev-1.13',
  name: 'Jev',
  providerId: 'openrouter',
  family: 'decision',
  pricing: {
    promptUsdPerToken: 0.00000004,
    completionUsdPerToken: 0,
    requestUsd: null,
    cacheReadUsdPerToken: null,
    maxPromptUsdPerToken: 0.00000004,
    maxCompletionUsdPerToken: 0,
    source: 'test',
    observedAt: '2026-10-02T00:00:00Z',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingMeter() {
  const calls: string[] = [];
  const hooks: MeteringHooks = {
    begin: vi.fn(async (estimate) => {
      calls.push(`begin:${estimate.label}:${estimate.estimateUsd === null ? 'unbounded' : 'bounded'}`);
      return { usageEventId: `usage-${calls.length}`, reservationId: `reservation-${calls.length}` };
    }),
    complete: vi.fn((_handle, observation) => calls.push(`complete:${observation.actualCostUsd}`)),
    fail: vi.fn((_handle, message) => calls.push(`fail:${message}`)),
  };
  return { hooks, calls };
}

describe('OpenRouter catalog and usage contract', () => {
  it('maps catalog capabilities, conservative pricing overrides, and deprecation', () => {
    const [model] = parseOpenRouterModels({
      data: [
        {
          id: 'deepseek/deepseek-v4',
          name: 'DeepSeek V4',
          context_length: 128_000,
          architecture: { input_modalities: ['text', 'image'] },
          pricing: {
            prompt: '0.0000003',
            completion: '0.0000012',
            overrides: [{ prompt: '0.0000006', completion: '0.0000024' }],
          },
          top_provider: { max_completion_tokens: 32_000 },
          supported_parameters: ['tools', 'reasoning', 'max_tokens', 'temperature', 'structured_outputs'],
          expiration_date: '2026-12-01',
        },
      ],
    });
    expect(model).toMatchObject({
      providerId: 'openrouter',
      family: 'generative',
      supportsTools: true,
      supportsImages: true,
      reasoningControl: 'effort',
      maxOutputRange: { min: 1, max: 32_000 },
      status: 'deprecated',
      identity: 'pinned',
      pricing: { maxPromptUsdPerToken: 0.0000006, maxCompletionUsdPerToken: 0.0000024 },
    });
    expect(estimateReservationUsd(model, 1_000, 1_000)).toBeCloseTo(1_100 * 0.0000006 + 1_000 * 0.0000024);
    expect(estimateReservationUsd(model, 1_000, null)).toBeNull();
    expect(maxPriceFor(model)).toEqual({ prompt: 0.6, completion: 2.4 });
  });

  it('preserves every reported token dimension, actual cost, and upstream routing', () => {
    expect(
      usageObservationFrom({
        id: 'gen-123',
        model: 'deepseek/deepseek-v4-0901',
        provider: 'DeepInfra',
        usage: {
          prompt_tokens: 900,
          completion_tokens: 120,
          total_tokens: 1_020,
          cost: 0.00042,
          prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    ).toMatchObject({
      provenance: 'provider_measured',
      inputTokens: 900,
      cachedInputTokens: 300,
      cacheWriteTokens: 20,
      reasoningTokens: 40,
      outputTokens: 120,
      totalTokens: 1_020,
      actualCostUsd: 0.00042,
      costProvenance: 'provider_measured',
      providerRequestId: 'gen-123',
      resolvedModelId: 'deepseek/deepseek-v4-0901',
      upstreamProvider: 'DeepInfra',
    });
  });

  it('reads key-level telemetry from the metadata endpoint and never echoes the key in errors', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/key');
      return jsonResponse({
        data: {
          label: 'Turing',
          usage: 1.5,
          usage_daily: 0.02,
          usage_weekly: 0.3,
          usage_monthly: 1.5,
          limit: 5,
          limit_remaining: 3.5,
          limit_reset: 'monthly',
        },
      });
    }) as unknown as typeof fetch;
    expect(await fetchKeyTelemetry('sk-or-v1-secretsecretsecret', 'profile', fetchImpl)).toMatchObject({
      scope: 'key',
      usageDailyUsd: 0.02,
      limitRemainingUsd: 3.5,
      limitReset: 'monthly',
      provenance: 'provider_measured',
    });
    const failing = vi.fn(async () =>
      jsonResponse({ error: { message: 'bad key sk-or-v1-secretsecretsecret' } }, 401),
    ) as unknown as typeof fetch;
    await expect(fetchKeyTelemetry('sk-or-v1-secretsecretsecret', 'profile', failing)).rejects.toThrow(
      /HTTP 401/,
    );
    await expect(fetchKeyTelemetry('sk-or-v1-secretsecretsecret', 'profile', failing)).rejects.not.toThrow(
      /secretsecret/,
    );
  });

  it('meters every agent turn and mediates tool calls through the Turing broker', async () => {
    const model = parseOpenRouterModels({
      data: [
        {
          id: 'deepseek/deepseek-v4',
          pricing: { prompt: '0.000001', completion: '0.000002' },
          top_provider: { max_completion_tokens: 4_000 },
          supported_parameters: ['tools', 'max_tokens'],
        },
      ],
    })[0];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? jsonResponse({
            id: 'gen-1',
            model: 'deepseek/deepseek-v4',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{"path":"a.ts","content":"x"}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 },
          })
        : jsonResponse({
            id: 'gen-2',
            model: 'deepseek/deepseek-v4',
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Reviewed.' } }],
            usage: { prompt_tokens: 150, completion_tokens: 20, cost: 0.0002 },
          });
    }) as unknown as typeof fetch;
    const brokerTool = vi.fn(async () => ({
      error: 'This workflow role is read-only and cannot execute project changes or commands.',
    }));
    const { hooks, calls } = recordingMeter();
    const result = await runOpenRouterAgent({
      key: 'sk-or-v1-test',
      model,
      modelId: 'deepseek/deepseek-v4',
      prompt: 'Review.',
      readOnly: true,
      signal: new AbortController().signal,
      onLog: () => undefined,
      metering: hooks,
      brokerTool,
      fetchImpl,
    });
    expect(result).toMatchObject({
      text: 'Reviewed.',
      inputTokens: 250,
      outputTokens: 30,
      usageRecorded: true,
    });
    expect(calls).toEqual([
      'begin:OpenRouter turn 1:bounded',
      'complete:0.0001',
      'begin:OpenRouter turn 2:bounded',
      'complete:0.0002',
    ]);
    // Read-only roles are only offered read tools; a write request is refused without reaching the broker.
    expect(
      (bodies[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
    ).toEqual(['list_files', 'read_file']);
    expect(brokerTool).not.toHaveBeenCalled();
    expect(bodies[0]).toMatchObject({
      max_tokens: 4_000,
      provider: { max_price: { prompt: 1, completion: 2 } },
    });
    expect(bodies[0]).not.toHaveProperty('models');
  });
});

describe('Jev decision adapter contract', () => {
  const choiceQuestion = {
    questionId: 'team',
    questionType: 'choice' as const,
    question: 'Which team owns this?',
    criteria: { payments: 'Payments', frontend: 'UI', account: 'Login' },
  };

  it('maps Decision Gate questions onto Jev noul/choice/score requests', () => {
    expect(
      toJevQuestion({
        questionId: 'ok',
        questionType: 'boolean',
        question: 'Done?',
        criteria: { true: 'yes', false: 'no' },
      }),
    ).toEqual({ type: 'noul', instructions: 'Done?', criteria: { true: 'yes', false: 'no' } });
    expect(
      toJevQuestion({
        questionId: 's',
        questionType: 'score',
        question: 'Complete?',
        criteria: ['no', 'partly', 'yes'],
      }).type,
    ).toBe('score');
  });

  it('keeps answer, probability, distribution, confidence, and score as separate fields', () => {
    expect(
      parseJevAnswer(
        { type: 'noul', noul: 0.96 },
        { questionId: 'b', questionType: 'boolean', question: 'Bug?' },
      ),
    ).toEqual({
      answer: null,
      probability: 0.96,
      distribution: null,
      confidence: null,
      confidenceKind: null,
      score: null,
      legend: null,
    });
    expect(
      parseJevAnswer(
        {
          type: 'choice',
          choice: 'payments',
          confidence: 0.67,
          probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
        },
        choiceQuestion,
      ),
    ).toMatchObject({
      answer: 'payments',
      confidence: 0.67,
      confidenceKind: 'engine-distribution',
      probability: null,
      distribution: { payments: 0.78 },
    });
    expect(
      parseJevAnswer(
        {
          type: 'score',
          score: 1.99,
          confidence: 0.99,
          probabilities: { 0: 0, 1: 0, 2: 1 },
          legend: { 0: 'a', 1: 'b', 2: 'c' },
        },
        { questionId: 's', questionType: 'score', question: 'Urgency', criteria: ['a', 'b', 'c'] },
      ),
    ).toMatchObject({ score: 1.99, confidence: 0.99, legend: { 2: 'c' } });
  });

  it('halts on malformed answers instead of defaulting', () => {
    expect(() =>
      parseJevAnswer({ type: 'choice', choice: 'payments', probabilities: { payments: 1 } }, choiceQuestion),
    ).toThrow('confidence');
    expect(() =>
      parseJevAnswer(
        { type: 'choice', choice: 'legal', confidence: 1, probabilities: { legal: 1 } },
        choiceQuestion,
      ),
    ).toThrow();
    expect(() =>
      parseJevAnswer({ type: 'noul' }, { questionId: 'b', questionType: 'boolean', question: 'x' }),
    ).toThrow('probability');
  });

  it('parses self-reported judge confidence without inventing a probability', () => {
    expect(
      parseJudgeAnswer('Result: {"answer": true, "confidence": 0.8}', {
        questionId: 'b',
        questionType: 'boolean',
        question: 'x',
      }),
    ).toMatchObject({ answer: true, confidence: 0.8, confidenceKind: 'self-reported', probability: null });
    expect(() =>
      parseJudgeAnswer('{"answer": 7, "confidence": 1}', {
        questionId: 's',
        questionType: 'score',
        question: 'x',
        criteria: ['a', 'b'],
      }),
    ).toThrow();
  });

  const gate: DecisionGateConfig = {
    engine: 'jev-openrouter',
    modelId: 'typesafe/jev-1.13',
    connectionProfileId: 'profile',
    questionType: 'boolean',
    question: 'Are all required acceptance criteria satisfied?',
    inputs: ['task', 'tests'],
    routing: {
      field: 'probability',
      passAtOrAbove: 0.95,
      failAtOrBelow: 0.15,
      onPass: { action: 'continue' },
      onFail: { action: 'fail-run' },
      onUncertain: { action: 'escalate' },
    },
    escalation: { engine: 'deterministic-rules' },
    rule: { path: 'tests.failed', operator: 'equals', value: 0 },
  };

  it('calls the Decisions API, meters it, and escalates an uncertain result to the configured second engine', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse({
        id: 'gen-dec-1',
        model: 'typesafe/jev-1.13-20260917',
        provider: 'TypeSafe',
        answers: { gate: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
      });
    }) as unknown as typeof fetch;
    const { hooks, calls } = recordingMeter();
    const context: DecisionContext = {
      signal: new AbortController().signal,
      fetchImpl,
      resolveOpenRouter: () => ({ key: 'sk-or-v1-test', model: jevModel }),
      metering: () => hooks,
      conditionValue: () => 0,
    };
    const evaluation = await evaluateDecisionGate({
      config: gate,
      questionId: 'gate',
      state: { taskSpecification: 'x' },
      batchId: 'batch',
      context,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://openrouter.ai/api/alpha/decisions',
      body: {
        model: 'typesafe/jev-1.13',
        state: { taskSpecification: 'x' },
        questions: { gate: { type: 'noul' } },
      },
    });
    expect(calls).toEqual(['begin:Jev decision:bounded', 'complete:0.000019992']);
    expect(evaluation.results.map((item) => [item.route.engine, item.routed.outcome])).toEqual([
      ['jev-openrouter', 'uncertain'],
      ['deterministic-rules', 'pass'],
    ]);
    expect(evaluation.results[0]!.decision).toMatchObject({
      probability: 0.5,
      confidence: null,
      resolvedModelId: 'typesafe/jev-1.13-20260917',
      upstreamProvider: 'TypeSafe',
      costUsd: 0.000019992,
    });
    expect(evaluation.final.outcome).toBe('pass');
  });

  it('versions decision configuration by hash', () => {
    const a = decisionConfigHash(gate);
    expect(decisionConfigHash({ ...gate })).toBe(a);
    expect(decisionConfigHash({ ...gate, routing: { ...gate.routing, passAtOrAbove: 0.9 } })).not.toBe(a);
    expect(decisionConfigHash({ ...gate, question: 'Different?' })).not.toBe(a);
    expect(decisionConfigHash({ ...gate, connectionProfileId: 'another-local-profile' })).toBe(a);
  });
});
