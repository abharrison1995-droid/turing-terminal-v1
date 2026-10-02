import { describe, expect, it } from 'vitest';
import {
  evaluateBillingLane,
  METERED_LANES,
  providerSideFallbackStatus,
  resolveBillingMode,
  routeMatchesBillingLane,
  SUBSCRIPTION_LANES,
} from './billing.js';
import { classifyModelIdentity, pruneModelSettings, reasoningControlFor, validateModelSettings, advancedSettingsFor } from './modelSettings.js';
import { routeDecision, validateDecisionGate } from './decisions.js';
import { localDayKey, resolveRange, zonedMidnightUtc } from './timezone.js';
import type { DecisionGateConfig, DecisionRoutingPolicy, ModelOption } from './types.js';

describe('billing modes', () => {
  it('Subscriptions Only blocks every metered lane for generative and decision work', () => {
    for (const lane of METERED_LANES)
      for (const workload of ['generative', 'decision'] as const)
        expect(evaluateBillingLane({ mode: 'subscriptions-only', lane, workload }).allowed).toBe(false);
    for (const lane of SUBSCRIPTION_LANES) expect(evaluateBillingLane({ mode: 'subscriptions-only', lane, workload: 'generative' }).allowed).toBe(true);
  });

  it('Subscriptions + Decision Budget permits only OpenRouter decision work', () => {
    expect(evaluateBillingLane({ mode: 'subscriptions-plus-decision-budget', lane: 'openrouter-metered', workload: 'decision' }).allowed).toBe(true);
    expect(evaluateBillingLane({ mode: 'subscriptions-plus-decision-budget', lane: 'openrouter-metered', workload: 'generative' }).allowed).toBe(false);
    for (const lane of ['openai-api', 'anthropic-api', 'cline-usage-billing', 'opencode-metered'] as const)
      expect(evaluateBillingLane({ mode: 'subscriptions-plus-decision-budget', lane, workload: 'decision' }).allowed).toBe(false);
  });

  it('Custom allows only explicitly allowed lanes when a list is configured, and never an unknown lane', () => {
    expect(evaluateBillingLane({ mode: 'custom', lane: 'openrouter-metered', workload: 'generative', customAllowedLanes: ['openrouter-metered'] }).allowed).toBe(true);
    expect(evaluateBillingLane({ mode: 'custom', lane: 'openai-api', workload: 'generative', customAllowedLanes: ['openrouter-metered'] }).allowed).toBe(false);
    expect(evaluateBillingLane({ mode: 'custom', lane: 'unknown', workload: 'generative' }).allowed).toBe(false);
  });

  it('keeps legacy subscriptionOnly compatible without letting it widen a stricter saved mode', () => {
    expect(resolveBillingMode({ subscriptionOnly: false })).toBe('custom');
    expect(resolveBillingMode({})).toBe('subscriptions-only');
    expect(resolveBillingMode({ billingMode: 'subscriptions-plus-decision-budget' }, { subscriptionOnly: true })).toBe('subscriptions-plus-decision-budget');
    expect(resolveBillingMode({ billingMode: 'custom' }, { subscriptionOnly: true })).toBe('subscriptions-only');
  });

  it('keeps ClinePass, Cline usage-billing, OpenCode Go, and OpenCode metered as distinct lanes', () => {
    expect(routeMatchesBillingLane('cline', 'cline-pass', 'clinepass-subscription')).toBe(true);
    expect(routeMatchesBillingLane('cline', 'cline-pass', 'cline-usage-billing')).toBe(false);
    expect(routeMatchesBillingLane('cline', 'cline', 'clinepass-subscription')).toBe(false);
    expect(routeMatchesBillingLane('opencode', 'opencode-go', 'opencode-metered')).toBe(false);
    expect(routeMatchesBillingLane('opencode', 'deepseek', 'opencode-go-subscription')).toBe(false);
    expect(routeMatchesBillingLane('codex-cli', 'openai-codex', 'openai-api')).toBe(false);
    expect(routeMatchesBillingLane('claude-code', 'anthropic-subscription', 'anthropic-api')).toBe(false);
    expect(routeMatchesBillingLane('openrouter', 'openrouter', 'openrouter-metered')).toBe(true);
  });

  it('never claims provider-side PAYG is disabled', () => {
    for (const lane of SUBSCRIPTION_LANES) {
      const status = providerSideFallbackStatus(lane);
      expect(status?.status).toBe('unknown');
      expect(status?.message).toContain('cannot be verified by Turing Terminal');
    }
  });
});

describe('model capability rules', () => {
  const codexModel: ModelOption = { id: 'gpt-6-luna', name: 'Luna', providerId: 'openai-codex', reasoningLevels: ['low', 'high', 'xhigh'] };
  const openCodeModel: ModelOption = { id: 'opencode-go/kimi-k3', name: 'Kimi', providerId: 'opencode-go', variantIds: ['high', 'max'] };
  const openRouterModel: ModelOption = {
    id: 'deepseek/deepseek-v4',
    name: 'DeepSeek',
    providerId: 'openrouter',
    reasoningControl: 'none',
    supportsMaxOutput: true,
    maxOutputRange: { min: 1, max: 16_000 },
    supportsTemperature: true,
    temperatureRange: { min: 0, max: 2 },
  };

  it('derives reasoning controls from the selected model rather than a universal list', () => {
    expect(reasoningControlFor('codex-cli', codexModel)).toBe('effort');
    expect(reasoningControlFor('opencode', openCodeModel)).toBe('variant');
    expect(reasoningControlFor('claude-code', undefined)).toBe('provider-controlled');
    expect(reasoningControlFor('openrouter', openRouterModel)).toBe('none');
  });

  it('refuses unsupported generic reasoning and hidden stale settings', () => {
    expect(validateModelSettings({ backendId: 'opencode', model: openCodeModel, catalogAvailable: true, reasoning: 'high' })[0]).toContain('provider-native variant');
    expect(validateModelSettings({ backendId: 'codex-cli', model: codexModel, catalogAvailable: true, reasoning: 'max' })[0]).toContain('not reported as supported');
    expect(validateModelSettings({ backendId: 'claude-code', model: undefined, catalogAvailable: false, nativeSettings: { effort: 'high' } })[0]).toContain('not a supported capability');
    expect(validateModelSettings({ backendId: 'openrouter', model: openRouterModel, catalogAvailable: true, nativeSettings: { maxOutputTokens: 40_000 } })[0]).toContain('between 1 and 16000');
    expect(advancedSettingsFor('openrouter', openRouterModel).map((item) => item.key)).toEqual(['maxOutputTokens', 'temperature']);
  });

  it('prunes settings that the newly selected model does not support', () => {
    expect(pruneModelSettings({ backendId: 'opencode', model: openCodeModel, reasoning: 'xhigh', variantId: 'ultra', nativeSettings: { temperature: 1 } })).toEqual({
      reasoning: undefined,
      variantId: undefined,
      nativeSettings: undefined,
    });
    expect(pruneModelSettings({ backendId: 'codex-cli', model: codexModel, reasoning: 'xhigh' }).reasoning).toBe('xhigh');
  });

  it('distinguishes pinned and floating/routed model identities', () => {
    expect(classifyModelIdentity('openrouter', '~typesafe/jev-latest')).toBe('floating');
    expect(classifyModelIdentity('openrouter', 'openrouter/auto')).toBe('floating');
    expect(classifyModelIdentity('claude-code', 'opus')).toBe('floating');
    expect(classifyModelIdentity('opencode', 'opencode-go/kimi-k3')).toBe('pinned');
    expect(classifyModelIdentity('openrouter', 'typesafe/jev-1.13')).toBe('pinned');
  });
});

describe('decision routing', () => {
  const booleanPolicy: DecisionRoutingPolicy = {
    field: 'probability',
    passAtOrAbove: 0.95,
    failAtOrBelow: 0.15,
    onPass: { action: 'continue' },
    onFail: { action: 'fail-run' },
    onUncertain: { action: 'human-approval' },
  };
  const boolean = (probability: number | null, confidence: number | null = null) => ({
    questionType: 'boolean' as const,
    answer: null,
    probability,
    confidence,
    score: null,
    distribution: null,
  });

  it('routes high, low, and intermediate probabilities to PASS, FAIL, and UNCERTAIN', () => {
    expect(routeDecision(boolean(0.97), booleanPolicy)).toMatchObject({ outcome: 'pass', route: { action: 'continue' } });
    expect(routeDecision(boolean(0.05), booleanPolicy)).toMatchObject({ outcome: 'fail', route: { action: 'fail-run' } });
    expect(routeDecision(boolean(0.6), booleanPolicy)).toMatchObject({ outcome: 'uncertain', route: { action: 'human-approval' } });
  });

  it('never substitutes confidence for probability or vice versa', () => {
    expect(routeDecision(boolean(null, 0.99), booleanPolicy).outcome).toBe('uncertain');
    const confidencePolicy: DecisionRoutingPolicy = { ...booleanPolicy, field: 'confidence', minConfidence: 0.9 };
    expect(routeDecision(boolean(0.99, null), confidencePolicy).outcome).toBe('uncertain');
    expect(routeDecision({ ...boolean(null, 0.95), answer: false }, confidencePolicy).outcome).toBe('fail');
  });

  it('routes choice answers only through configured option routes and confidence gates', () => {
    const policy: DecisionRoutingPolicy = {
      field: 'confidence',
      minConfidence: 0.6,
      onPass: { action: 'continue' },
      onFail: { action: 'fail-run' },
      onUncertain: { action: 'human-approval' },
      choiceRoutes: { COMPLETE: { action: 'skip-stages', skipStageIds: ['remediate'] }, REMEDIATE: { action: 'continue' } },
    };
    const choice = (answer: string, confidence: number) => ({ questionType: 'choice' as const, answer, confidence, probability: null, score: null, distribution: { COMPLETE: 0.8, REMEDIATE: 0.2 } });
    expect(routeDecision(choice('COMPLETE', 0.7), policy)).toMatchObject({ outcome: 'choice', route: { action: 'skip-stages', skipStageIds: ['remediate'] } });
    expect(routeDecision(choice('COMPLETE', 0.4), policy).outcome).toBe('uncertain');
    expect(routeDecision(choice('HUMAN', 0.9), policy).outcome).toBe('uncertain');
  });

  it('routes scores with explicit thresholds', () => {
    const policy: DecisionRoutingPolicy = { field: 'score', passAtOrAbove: 3, failAtOrBelow: 1, minConfidence: 0.5, onPass: { action: 'continue' }, onFail: { action: 'fail-run' }, onUncertain: { action: 'escalate' } };
    const score = (value: number, confidence = 0.9) => ({ questionType: 'score' as const, answer: value, score: value, confidence, probability: null, distribution: null });
    expect(routeDecision(score(3.4), policy).outcome).toBe('pass');
    expect(routeDecision(score(0.8), policy).outcome).toBe('fail');
    expect(routeDecision(score(2), policy).outcome).toBe('uncertain');
    expect(routeDecision(score(3.9, 0.2), policy).outcome).toBe('uncertain');
  });

  it('validates gate configuration, thresholds, forward-only skips, and explicit OpenRouter connections', () => {
    const config: DecisionGateConfig = {
      engine: 'jev-openrouter',
      modelId: 'typesafe/jev-1.13',
      questionType: 'boolean',
      question: 'Are all acceptance criteria satisfied?',
      inputs: ['task', 'tests'],
      routing: { ...booleanPolicy, failAtOrBelow: 0.99, onPass: { action: 'skip-stages', skipStageIds: ['plan'] } },
    };
    const errors = validateDecisionGate(config, 'Gate', ['review']);
    expect(errors.join(' ')).toContain('select an OpenRouter connection');
    expect(errors.join(' ')).toContain('FAIL threshold must be below the PASS threshold');
    expect(errors.join(' ')).toContain('can only skip later stages');
  });
});

describe('timezone-aware analytics windows', () => {
  it('places an event on the local day of the display timezone', () => {
    const at = '2026-10-02T23:30:00.000Z';
    expect(localDayKey(at, 'UTC')).toBe('2026-10-02');
    expect(localDayKey(at, 'Pacific/Auckland')).toBe('2026-10-03');
    expect(localDayKey(at, 'America/Los_Angeles')).toBe('2026-10-02');
    expect(localDayKey('2026-10-02T06:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-01');
  });

  it('aligns Today to local midnight, including across DST changes', () => {
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    expect(resolveRange({ preset: 'today', timeZone: 'Europe/London', now })).toMatchObject({
      from: '2026-10-01T23:00:00.000Z',
      to: '2026-10-02T23:00:00.000Z',
    });
    // London leaves BST on 2026-10-25: that local day has 25 hours.
    const start = zonedMidnightUtc('2026-10-25', 'Europe/London').getTime();
    const end = zonedMidnightUtc('2026-10-26', 'Europe/London').getTime();
    expect((end - start) / 3_600_000).toBe(25);
  });
});
