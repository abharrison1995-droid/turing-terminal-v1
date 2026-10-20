import type { ConnectionProfileWithCredentials } from '../../src/client/api';
import type {
  ModelPreset,
  ProviderCapabilities,
  ProviderStatus,
  StageKind,
  WorkflowDefinition,
  WorkflowStage,
} from '../../src/shared/types';
import { FIXED_NOW } from './dashboard';
import { POPULATED_SNAPSHOT, populatedRoutes } from './populated';

/**
 * FIXTURE DATA for the provider setup, workflow editor and JEV Decision Gate evidence. Nothing here came from a real
 * provider, account, CLI or machine: the CLI versions, authentication states, model lists and plan labels are invented
 * so screenshots show every honest state (installed, signed in, Unknown, catalogue available or absent). Fixture model
 * names are deliberately generic; no real plan or account is implied.
 */
const NOW_MS = Date.parse(FIXED_NOW);
const at = (minutesBeforeNow: number): string => new Date(NOW_MS - minutesBeforeNow * 60_000).toISOString();

const caps = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery: false,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: false,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
  ...overrides,
});

/** Provider states are a function of the "scenario" so a capture can show unsigned, unknown and ready states. */
export type ProviderScenario = 'mixed' | 'ready' | 'none';

export function providersFor(scenario: ProviderScenario): ProviderStatus[] {
  const checkedAt = at(3);
  const ready = scenario === 'ready';
  const none = scenario === 'none';
  return [
    {
      id: 'opencode',
      name: 'OpenCode',
      cli: 'opencode',
      detected: !none,
      version: none ? null : '1.14.0-fixture',
      authentication: none ? 'unknown' : 'connected',
      subscriptionAuthenticated: null,
      authMechanism: 'OpenCode managed auth (OAuth or OpenCode Go)',
      note: 'Fixture note.',
      checkedAt,
      capabilities: caps({ modelDiscovery: !none }),
      catalogSource: none ? 'none' : 'live',
      catalogRefreshedAt: none ? null : checkedAt,
      models: none
        ? []
        : [
            {
              id: 'opencode-go/fixture-coder',
              name: 'Fixture Coder (Go)',
              providerId: 'opencode-go',
              variantIds: ['high', 'max'],
              supportsTools: true,
              reasoningControl: 'variant',
              status: 'current',
            },
            {
              id: 'opencode-go/fixture-writer',
              name: 'Fixture Writer (Go)',
              providerId: 'opencode-go',
              supportsTools: true,
              status: 'current',
            },
            {
              id: 'openai/fixture-metered',
              name: 'Fixture metered model',
              providerId: 'openai',
              supportsTools: true,
              status: 'current',
            },
          ],
    },
    {
      id: 'codex-cli',
      name: 'OpenAI Codex CLI',
      cli: 'codex',
      detected: !none,
      version: none ? null : '0.155.0-fixture',
      authentication: none ? 'unknown' : 'connected',
      subscriptionAuthenticated: none ? null : true,
      authMechanism: 'Official Codex CLI ChatGPT sign-in',
      note: 'Fixture note.',
      checkedAt,
      capabilities: caps({ modelDiscovery: !none }),
      catalogSource: none ? 'none' : 'live',
      catalogRefreshedAt: none ? null : checkedAt,
      models: none
        ? []
        : [
            {
              id: 'fixture-codex-large',
              name: 'Fixture Codex Large',
              providerId: 'openai-codex',
              reasoningLevels: ['low', 'medium', 'high'],
              reasoningControl: 'effort',
              supportsTools: true,
              status: 'current',
            },
            {
              id: 'fixture-codex-small',
              name: 'Fixture Codex Small',
              providerId: 'openai-codex',
              reasoningLevels: ['low', 'medium'],
              reasoningControl: 'effort',
              supportsTools: true,
              status: 'current',
            },
          ],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      cli: 'claude',
      detected: !none,
      version: none ? null : '2.1.300-fixture',
      authentication: none ? 'unknown' : ready ? 'connected' : 'disconnected',
      subscriptionAuthenticated: none ? null : ready,
      authMechanism: 'Official Claude Code CLI sign-in',
      note: 'Fixture note.',
      checkedAt,
      capabilities: caps(),
      catalogSource: 'none',
      catalogRefreshedAt: null,
      models: [],
    },
    {
      id: 'cline',
      name: 'Cline',
      cli: 'cline',
      detected: !none,
      version: none ? null : '3.4.0-fixture',
      authentication: 'unknown',
      subscriptionAuthenticated: null,
      authMechanism: 'Cline CLI OAuth/provider sign-in',
      note: 'Fixture note.',
      checkedAt,
      capabilities: caps({ subscriptionAuth: false }),
      catalogSource: 'none',
      catalogRefreshedAt: null,
      models: [],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      cli: 'openrouter',
      detected: true,
      version: null,
      authentication: 'connected',
      subscriptionAuthenticated: null,
      authMechanism: 'Inference key stored on the Desktop Master',
      note: 'Fixture note.',
      checkedAt,
      capabilities: caps({ modelDiscovery: true, subscriptionAuth: false }),
      catalogSource: 'live',
      catalogRefreshedAt: checkedAt,
      models: [
        {
          id: 'typesafe/jev-1.13',
          name: 'Jev 1.13',
          providerId: 'openrouter',
          family: 'decision',
          status: 'current',
          identity: 'pinned',
        },
        {
          id: 'typesafe/jev-1.12',
          name: 'Jev 1.12',
          providerId: 'openrouter',
          family: 'decision',
          status: 'current',
          identity: 'pinned',
        },
        {
          id: 'fixture/generative-large',
          name: 'Fixture generative model',
          providerId: 'openrouter',
          status: 'current',
        },
      ],
    },
  ];
}

const connection = (
  id: string,
  name: string,
  backendId: string,
  providerId: string,
  billingLane: ConnectionProfileWithCredentials['billingLane'],
  metadata: ConnectionProfileWithCredentials['metadata'] = {},
  credentials: { inference: boolean; management: boolean } | undefined = undefined,
): ConnectionProfileWithCredentials => ({
  id,
  name,
  backendId,
  providerId,
  billingLane,
  credentialStoreRef: null,
  metadata,
  createdAt: at(60 * 24 * 3),
  updatedAt: at(60 * 24 * 3),
  ...(credentials ? { credentials } : {}),
});

export const GO_CONNECTION = connection(
  'fixture-conn-go',
  'OpenCode Go',
  'opencode',
  'opencode-go',
  'opencode-go-subscription',
  { planLabel: 'Go' },
);
export const CODEX_CONNECTION = connection(
  'fixture-conn-codex',
  'Codex — ChatGPT',
  'codex-cli',
  'openai-codex',
  'chatgpt-subscription',
  { planLabel: 'Pro' },
);
export const OPENROUTER_CONNECTION = connection(
  'fixture-conn-openrouter',
  'OpenRouter',
  'openrouter',
  'openrouter',
  'openrouter-metered',
  {},
  { inference: true, management: false },
);

const stage = (
  id: string,
  label: string,
  kind: StageKind,
  extra: Partial<WorkflowStage> = {},
): WorkflowStage => ({
  id,
  label,
  kind,
  enabled: true,
  ...extra,
});

const contextPolicy: WorkflowDefinition['contextPolicy'] = {
  strategy: 'focused',
  maxFiles: 40,
  maxEstimatedTokens: 60000,
  maxFileBytes: 200000,
  includeGlobs: [],
  excludeGlobs: [],
  includeCurrentDiff: true,
  includeTestOutput: true,
  includeBuildOutput: false,
  includePreviousArtifact: true,
  includePreviousTranscript: false,
  onLimitExceeded: 'compact',
};

const baseWorkflow = {
  template: 'standard',
  executionProfile: 'balanced',
  permissionMode: 'normal',
  promptRefinementDefault: false,
  maxRemediationRounds: 2,
  maxParallelAgents: 2,
  maxDurationMinutes: 90,
  retryPolicy: { maxRetries: 1, initialDelayMs: 2000, maxDelayMs: 10000 },
  isolatedWorktree: true,
  subscriptionOnly: true,
  billingMode: 'subscriptions-only',
  meteredBudget: { perRunUsd: null, unknownCostPolicy: 'block' },
  externalDecisionDataPolicy: 'ask-first',
  lockProviders: true,
  contextPolicy,
  isDefault: false,
  createdAt: at(60 * 24 * 20),
  updatedAt: at(60 * 24 * 2),
} as const;

const GO_ROUTE = {
  connectionProfileId: GO_CONNECTION.id,
  backendId: 'opencode',
  providerId: 'opencode-go',
  billingLane: 'opencode-go-subscription' as const,
};

export const FIXTURE_WORKFLOWS: WorkflowDefinition[] = [
  {
    ...baseWorkflow,
    id: 'fixture-wf-delivery',
    name: 'Fixture delivery',
    description: 'Plan, implement, test and review a change with explicit subscription routes.',
    isDefault: true,
    version: 4,
    defaultModelConfiguration: { ...GO_ROUTE, modelId: 'opencode-go/fixture-writer' },
    stageDefaults: {
      reviewer: {
        connectionProfileId: CODEX_CONNECTION.id,
        backendId: 'codex-cli',
        providerId: 'openai-codex',
        billingLane: 'chatgpt-subscription',
        modelId: 'fixture-codex-large',
      },
    },
    stages: [
      stage('s-plan', 'Plan', 'planner'),
      stage('s-impl', 'Implement', 'implementer', {
        ...GO_ROUTE,
        modelId: 'opencode-go/fixture-coder',
        variantId: 'high',
      }),
      stage('s-test', 'Test', 'test'),
      stage('s-review', 'Review', 'reviewer', { reasoning: 'high' }),
      stage('s-claude', 'Second opinion', 'reviewer', {
        backendId: 'claude-code',
        providerId: 'anthropic-subscription',
        billingLane: 'claude-subscription',
      }),
      stage('s-commit', 'Commit', 'gitCommit'),
    ],
  },
  {
    ...baseWorkflow,
    id: 'fixture-wf-quick',
    name: 'Fixture quick fix',
    description: 'Implement and test only.',
    version: 1,
    executionProfile: 'economy',
    stages: [
      stage('q-impl', 'Implement', 'implementer', {
        ...GO_ROUTE,
        modelId: 'opencode-go/fixture-writer',
      }),
      stage('q-test', 'Test', 'test'),
    ],
  },
  {
    ...baseWorkflow,
    id: 'fixture-wf-jev',
    name: 'Fixture delivery with decision',
    description: 'Delivery with one optional JEV decision gate before commit.',
    version: 2,
    defaultModelConfiguration: { ...GO_ROUTE, modelId: 'opencode-go/fixture-writer' },
    stages: [
      stage('j-impl', 'Implement', 'implementer'),
      stage('j-test', 'Test', 'test'),
      stage('j-gate', 'Ready to commit?', 'decisionGate', {
        decision: {
          engine: 'jev-openrouter',
          questionType: 'boolean',
          question: 'Is this change ready to commit?',
          inputs: ['task', 'tests', 'findings'],
          modelId: 'typesafe/jev-1.13',
          routing: {
            field: 'probability',
            passAtOrAbove: 0.9,
            failAtOrBelow: 0.2,
            onPass: { action: 'continue' },
            onFail: { action: 'fail-run' },
            onUncertain: { action: 'human-approval' },
          },
        },
      }),
      stage('j-commit', 'Commit', 'gitCommit'),
    ],
  },
];

export const FIXTURE_PRESETS: ModelPreset[] = [];

export interface ProviderUxState {
  scenario: ProviderScenario;
  profiles: ConnectionProfileWithCredentials[];
}

/** Route table for a scenario. `/api/providers/refresh` returns the same providers (a "Check again"). */
export function providerUxRoutes(state: ProviderUxState): Record<string, unknown> {
  const providers = providersFor(state.scenario);
  return {
    ...populatedRoutes,
    '/api/dashboard': { ...POPULATED_SNAPSHOT, workflows: FIXTURE_WORKFLOWS, providers },
    '/api/providers': { providers },
    '/api/providers/refresh': { providers },
    '/api/connection-profiles': (_url: URL, method: string) => {
      if (method === 'POST') return { profile: state.profiles.at(-1) };
      return { profiles: state.profiles };
    },
    '/api/model-presets': { presets: FIXTURE_PRESETS },
    '/api/workflows': (_url: URL, method: string) =>
      method === 'POST' ? { workflow: FIXTURE_WORKFLOWS[0] } : { workflows: FIXTURE_WORKFLOWS },
    '/api/workflows/:id': (_url: URL, _method: string, params: Record<string, string>) => ({
      workflow: FIXTURE_WORKFLOWS.find((workflow) => workflow.id === params.id) ?? FIXTURE_WORKFLOWS[0],
    }),
    '/api/budgets': {
      settings: { dailyUsd: 5, monthlyUsd: 50, warningRatio: 0.8, timezone: 'UTC', updatedAt: at(100) },
      status:
        populatedRoutes['/api/budgets'] && (populatedRoutes['/api/budgets'] as { status: unknown }).status,
      systemTimeZone: 'UTC',
    },
    '/api/providers/openrouter/telemetry': { telemetry: [], errors: [], provenance: 'fixture' },
  };
}
