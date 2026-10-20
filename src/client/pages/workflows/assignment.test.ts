import { describe, expect, it } from 'vitest';
import type {
  ConnectionProfile,
  ModelOption,
  ProviderCapabilities,
  ProviderStatus,
  WorkflowStage,
} from '../../../shared/types';
import {
  applyConnectionPatch,
  connectionChangeImpact,
  hasStageOverride,
  inheritPatch,
  manualModelPatch,
  modelCompatibility,
  modelSelectionPatch,
  modelsForRoute,
  resolveAssignment,
} from './assignment';

const caps = (modelDiscovery: boolean): ProviderCapabilities => ({
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: false,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
});

const provider = (id: string, models: ModelOption[], modelDiscovery = true): ProviderStatus => ({
  id,
  name: id,
  cli: id,
  detected: true,
  version: '1.0.0',
  authentication: 'unknown',
  authMechanism: 'cli',
  note: '',
  checkedAt: '2026-10-20T10:00:00.000Z',
  capabilities: caps(modelDiscovery),
  models,
  catalogSource: models.length ? 'live' : 'none',
});

const profile = (overrides: Partial<ConnectionProfile>): ConnectionProfile => ({
  id: 'c1',
  name: 'Connection',
  backendId: 'opencode',
  providerId: 'opencode-go',
  billingLane: 'opencode-go-subscription',
  credentialStoreRef: null,
  metadata: {},
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const providers = [
  provider('opencode', [
    { id: 'opencode-go/coder', name: 'Coder', providerId: 'opencode-go', variantIds: ['high'] },
    { id: 'openai/metered', name: 'Metered', providerId: 'openai' },
  ]),
  provider('codex-cli', [
    { id: 'codex-large', name: 'Codex large', providerId: 'openai-codex', reasoningLevels: ['low', 'high'] },
  ]),
  provider('claude-code', [], false),
  provider('cline', [], false),
];

const stage = (overrides: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 's',
  label: 'Stage',
  kind: 'implementer',
  enabled: true,
  ...overrides,
});

describe('inherited and overridden assignments', () => {
  const workflow = {
    defaultModelConfiguration: {
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: 'opencode-go-subscription' as const,
      connectionProfileId: 'c-default',
      modelId: 'opencode-go/coder',
      reasoning: 'medium',
    },
    stageDefaults: { reviewer: { modelId: 'opencode-go/reviewer', variantId: 'high' } },
  };

  it('inherits everything from the workflow default and says so', () => {
    const { configuration, sources } = resolveAssignment(workflow, stage());
    expect(configuration).toMatchObject({ connectionProfileId: 'c-default', modelId: 'opencode-go/coder' });
    expect(sources).toEqual({
      connection: 'workflow-default',
      model: 'workflow-default',
      reasoning: 'workflow-default',
      variant: 'unset',
    });
  });

  it('shows a stage-type default ahead of the workflow default, and a stage override ahead of both', () => {
    const reviewer = resolveAssignment(workflow, stage({ kind: 'reviewer' }));
    expect(reviewer.sources.model).toBe('stage-default');
    expect(reviewer.sources.variant).toBe('stage-default');
    expect(reviewer.configuration.modelId).toBe('opencode-go/reviewer');
    const overridden = resolveAssignment(workflow, stage({ kind: 'reviewer', modelId: 'opencode-go/other' }));
    expect(overridden.sources.model).toBe('stage');
    expect(overridden.configuration.modelId).toBe('opencode-go/other');
  });

  it('does not inherit the default connection once the stage chooses a different route (matches the run launcher)', () => {
    const { configuration, sources } = resolveAssignment(
      workflow,
      stage({ backendId: 'codex-cli', providerId: 'openai-codex', billingLane: 'chatgpt-subscription' }),
    );
    expect(configuration.connectionProfileId).toBeUndefined();
    expect(sources.connection).toBe('unset');
  });

  it('clears only the stage’s own route and model when returning to inherited values', () => {
    const overridden = stage({ connectionProfileId: 'c9', modelId: 'x', customInstructions: 'keep me' });
    expect(hasStageOverride(overridden)).toBe(true);
    expect(hasStageOverride(stage())).toBe(false);
    const cleared = { ...overridden, ...inheritPatch() };
    expect(resolveAssignment(workflow, cleared).sources.connection).toBe('workflow-default');
    expect(cleared.customInstructions).toBe('keep me');
  });
});

describe('route-filtered models', () => {
  it('lists only the connected OpenCode provider’s models for OpenCode Go', () => {
    expect(modelsForRoute(providers, 'opencode', 'opencode-go').models.map((model) => model.id)).toEqual([
      'opencode-go/coder',
    ]);
    expect(modelsForRoute(providers, 'opencode', 'openai').models.map((model) => model.id)).toEqual([
      'openai/metered',
    ]);
  });

  it('reports no discovery for backends without a catalogue so manual entry is the honest path', () => {
    expect(modelsForRoute(providers, 'claude-code', 'anthropic-subscription').discovery).toBe(false);
    expect(modelCompatibility(providers, 'cline', 'cline-pass', 'anything')).toBe('unverifiable');
  });

  it('distinguishes listed from not listed and keeps unknown backends unverifiable', () => {
    expect(modelCompatibility(providers, 'opencode', 'opencode-go', 'opencode-go/coder')).toBe('listed');
    expect(modelCompatibility(providers, 'opencode', 'opencode-go', 'openai/metered')).toBe('not-listed');
    expect(modelCompatibility(providers, 'missing', 'x', 'y')).toBe('unverifiable');
  });
});

describe('model selection patches', () => {
  it('stores the exact ID, a catalogue snapshot, and drops settings the model does not support', () => {
    const model = providers[1]!.models[0]!;
    const patch = modelSelectionPatch(
      model,
      { backendId: 'codex-cli', reasoning: 'ultra', variantId: 'nope' },
      providers[1],
      () => '2026-10-20T11:00:00.000Z',
    );
    expect(patch).toMatchObject({
      modelId: 'codex-large',
      providerId: 'openai-codex',
      modelSnapshot: { modelId: 'codex-large', status: 'current' },
    });
    expect(patch.reasoning).toBeUndefined();
    expect(patch.variantId).toBeUndefined();
  });

  it('keeps a manual ID verbatim and invents no snapshot', () => {
    const patch = manualModelPatch('  sonnet[1m] ');
    expect(patch.modelId).toBe('sonnet[1m]');
    expect(patch.modelSnapshot).toBeUndefined();
    expect(manualModelPatch('   ').modelId).toBeUndefined();
  });
});

describe('changing a connection never silently replaces a provider or model', () => {
  const codex = profile({
    id: 'c-codex',
    name: 'Codex',
    backendId: 'codex-cli',
    providerId: 'openai-codex',
    billingLane: 'chatgpt-subscription',
  });
  const claude = profile({
    id: 'c-claude',
    name: 'Claude',
    backendId: 'claude-code',
    providerId: 'anthropic-subscription',
    billingLane: 'claude-subscription',
  });

  it('needs no decision when the stage has no model yet', () => {
    const impact = connectionChangeImpact({}, codex, providers);
    expect(impact.needsDecision).toBe(false);
    expect(applyConnectionPatch(codex, impact)).toEqual({
      connectionProfileId: 'c-codex',
      backendId: 'codex-cli',
      providerId: 'openai-codex',
      billingLane: 'chatgpt-subscription',
    });
  });

  it('blocks keeping a model the new route lists as unavailable and never fills in another', () => {
    const impact = connectionChangeImpact(
      { backendId: 'opencode', providerId: 'opencode-go', modelId: 'opencode-go/coder', reasoning: 'high' },
      codex,
      providers,
    );
    expect(impact).toMatchObject({ needsDecision: true, canKeepModel: false });
    expect(impact.lines.join(' ')).toMatch(/not in the codex-cli catalogue/);
    const patch = applyConnectionPatch(codex, impact, 'clear-model');
    expect(patch.modelId).toBeUndefined();
    expect(Object.keys(patch)).toContain('modelId');
    expect(patch.backendId).toBe('codex-cli');
  });

  it('lets the person keep an ID on a route that cannot verify it, clearing only dependent settings', () => {
    const impact = connectionChangeImpact(
      { backendId: 'codex-cli', providerId: 'openai-codex', modelId: 'codex-large', reasoning: 'high' },
      claude,
      providers,
    );
    expect(impact).toMatchObject({ needsDecision: true, canKeepModel: true });
    const kept = applyConnectionPatch(claude, impact, 'keep');
    expect(Object.keys(kept)).not.toContain('modelId');
    expect(kept).toMatchObject({ reasoning: undefined, modelSnapshot: undefined });
  });

  it('keeps a model that the new route lists, with a plain note', () => {
    const impact = connectionChangeImpact(
      { backendId: 'opencode', providerId: 'openai', modelId: 'opencode-go/coder' },
      profile({ id: 'go' }),
      providers,
    );
    expect(impact.needsDecision).toBe(false);
    expect(impact.lines.join(' ')).toMatch(/is listed for the new route and is kept/);
  });
});
