import type {
  BillingMode,
  DashboardSnapshot,
  ConnectionProfile,
  DecisionGateConfig,
  DecisionResult,
  MeteredBudgetSettings,
  ProviderSpendTelemetry,
  ExecutionOperation,
  GitOperation,
  ProjectProfile,
  ProviderStatus,
  RunPreview,
  RunSummary,
  ModelConfiguration,
  ModelPreset,
  TuringRule,
  WorkflowDefinition,
} from '../shared/types';
import { masterApiUrl } from './desktop';

/**
 * A failed API response. `message` is unchanged (`error` from the body, else the status), so existing callers that read
 * only `error.message` behave exactly as before. Goal controls additionally read the structured refusal.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: unknown,
    readonly approvalId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A successful response whose body could not be read as JSON. For a write the server may already have committed it, so
 * the caller must treat the outcome as unknown and read the saved state, never assume failure.
 */
export class UnreadableResponseError extends Error {
  constructor(readonly status: number | null) {
    super('The response could not be read.');
    this.name = 'UnreadableResponseError';
  }
}

interface ErrorBody {
  error?: string;
  code?: string;
  detail?: unknown;
  approvalId?: string;
}

/**
 * `requireBody` is opt-in. Without it a 2xx whose body cannot be parsed yields `{}`, exactly as before. Writes that the
 * client cannot confirm from the response pass `requireBody` and get an `UnreadableResponseError` instead.
 */
export async function call<T>(
  path: string,
  init?: RequestInit,
  options: { requireBody?: boolean } = {},
): Promise<T> {
  const response = await fetch(masterApiUrl(path), {
    ...init,
    // A JSON content type with no body is rejected by the server (FST_ERR_CTP_EMPTY_JSON_BODY), so bodyless
    // requests such as creating, approving or denying a pairing request must not declare one.
    headers: {
      ...(init?.body === undefined || init.body === null ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });
  const parsed = await response.json().then(
    (value: unknown) => ({ value }),
    () => null,
  );
  if (response.ok && parsed === null && options.requireBody)
    throw new UnreadableResponseError(response.status);
  const body = (parsed?.value ?? {}) as ErrorBody;
  if (!response.ok)
    throw new ApiError(
      body.error ?? `Request failed (${response.status}).`,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      body.detail,
      typeof body.approvalId === 'string' ? body.approvalId : undefined,
    );
  return (parsed === null ? {} : parsed.value) as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

function sanitizeWorkflowExport<T>(value: T): T {
  if (typeof value === 'string')
    return value
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
        '[REDACTED_PRIVATE_KEY]',
      )
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
      .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[REDACTED_TOKEN]')
      .replace(
        /((?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*|(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))\s*[:=]\s*["']?)[^\s"',;}]+/gi,
        '$1[REDACTED]',
      ) as T;
  if (Array.isArray(value)) return value.map(sanitizeWorkflowExport) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) =>
            !/secret|token|api.?key|password|cookie|credential|connectionProfileId|modelSnapshot/i.test(key),
        )
        .map(([key, item]) => [key, sanitizeWorkflowExport(item)]),
    ) as T;
  return value;
}

export const api = {
  dashboard: () => call<DashboardSnapshot>('/api/dashboard'),
  providers: () => call<{ providers: ProviderStatus[] }>('/api/providers'),
  refreshProviders: () => call<{ providers: ProviderStatus[] }>('/api/providers/refresh', json('POST')),
  openRouterTelemetry: () =>
    call<{ telemetry: ProviderSpendTelemetry[]; errors: string[]; provenance: string }>(
      '/api/providers/openrouter/telemetry',
    ),
  setCredential: (profileId: string, kind: 'inference' | 'management', secret: string) =>
    call<{ profile: ConnectionProfileWithCredentials }>(
      `/api/connection-profiles/${profileId}/credentials/${kind}`,
      json('PUT', { secret }),
    ),
  deleteCredential: (profileId: string, kind: 'inference' | 'management') =>
    call<{ deleted: boolean }>(`/api/connection-profiles/${profileId}/credentials/${kind}`, json('DELETE')),
  budgets: () =>
    call<{ settings: MeteredBudgetSettings; status: BudgetStatus; systemTimeZone: string }>('/api/budgets'),
  saveBudgets: (settings: Omit<MeteredBudgetSettings, 'updatedAt'>) =>
    call<{ settings: MeteredBudgetSettings }>('/api/budgets', json('PUT', settings)),
  usageAnalytics: (query: Record<string, string>) =>
    call<UsageAnalytics>(`/api/usage/analytics?${new URLSearchParams(query).toString()}`),
  usageExportUrl: (query: Record<string, string>, format: 'csv' | 'json') =>
    masterApiUrl(`/api/usage/export?${new URLSearchParams({ ...query, format }).toString()}`),
  testDecisionGate: (body: {
    decision: DecisionGateConfig;
    fixtures: Array<Record<string, unknown>>;
    billingMode: BillingMode;
    maxCostUsd: number | null;
    confirmExternal: boolean;
  }) => call<Record<string, unknown>>('/api/decision-gates/test', json('POST', body)),
  addProject: (path: string) => call<{ project: ProjectProfile }>('/api/projects', json('POST', { path })),
  refreshProject: (id: string) =>
    call<{ project: ProjectProfile }>(`/api/projects/${id}/refresh`, json('POST')),
  patchProject: (
    id: string,
    changes: Partial<Pick<ProjectProfile, 'name' | 'buildCommand' | 'testCommand' | 'lintCommand'>>,
  ) => call<{ project: ProjectProfile }>(`/api/projects/${id}`, json('PATCH', changes)),
  saveWorkflow: (workflow: WorkflowDefinition, create = false) => {
    const body = {
      name: workflow.name,
      description: workflow.description,
      template: workflow.template,
      executionProfile: workflow.executionProfile,
      permissionMode: workflow.permissionMode,
      promptRefinementDefault: workflow.promptRefinementDefault,
      maxRemediationRounds: workflow.maxRemediationRounds,
      maxParallelAgents: workflow.maxParallelAgents,
      maxDurationMinutes: workflow.maxDurationMinutes,
      retryPolicy: workflow.retryPolicy,
      isolatedWorktree: workflow.isolatedWorktree,
      subscriptionOnly: workflow.billingMode ? workflow.billingMode !== 'custom' : workflow.subscriptionOnly,
      billingMode: workflow.billingMode,
      customAllowedLanes: workflow.customAllowedLanes,
      meteredBudget: workflow.meteredBudget,
      externalDecisionDataPolicy: workflow.externalDecisionDataPolicy,
      lockProviders: workflow.lockProviders,
      defaultModelConfiguration: workflow.defaultModelConfiguration,
      stageDefaults: workflow.stageDefaults,
      globalInstructions: workflow.globalInstructions,
      contextPolicy: workflow.contextPolicy,
      stages: workflow.stages,
    };
    return call<{ workflow: WorkflowDefinition }>(
      create ? '/api/workflows' : `/api/workflows/${workflow.id}`,
      json(create ? 'POST' : 'PUT', body),
    );
  },
  duplicateWorkflow: (id: string) =>
    call<{ workflow: WorkflowDefinition }>(`/api/workflows/${id}/duplicate`, json('POST')),
  connectionProfiles: () =>
    call<{ profiles: ConnectionProfileWithCredentials[] }>('/api/connection-profiles'),
  saveConnectionProfile: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>, id?: string) =>
    call<{ profile: ConnectionProfile }>(
      id ? `/api/connection-profiles/${id}` : '/api/connection-profiles',
      json(id ? 'PUT' : 'POST', profile),
    ),
  deleteConnectionProfile: (id: string) => call(`/api/connection-profiles/${id}`, json('DELETE')),
  modelPresets: () => call<{ presets: ModelPreset[] }>('/api/model-presets'),
  createModelPreset: (name: string, configuration: ModelConfiguration) =>
    call<{ preset: ModelPreset }>('/api/model-presets', json('POST', { name, configuration })),
  deleteModelPreset: (id: string) => call(`/api/model-presets/${id}`, json('DELETE')),
  rules: (projectId?: string) =>
    call<{ rules: TuringRule[] }>(
      `/api/rules${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  saveRule: (rule: Omit<TuringRule, 'id' | 'createdAt' | 'updatedAt'>, id?: string) =>
    call<{ rule: TuringRule }>(id ? `/api/rules/${id}` : '/api/rules', json(id ? 'PUT' : 'POST', rule)),
  deleteRule: (id: string) => call<{ deleted: boolean }>(`/api/rules/${id}`, json('DELETE')),
  previewRun: (input: {
    task: string;
    projectId: string;
    workflowId: string;
    profile?: WorkflowDefinition['executionProfile'];
    permissionMode?: WorkflowDefinition['permissionMode'];
    enigmaConfirmed?: boolean;
    refinePrompt?: boolean;
    subscriptionOnly?: boolean;
    billingMode?: BillingMode;
    lockProviders?: boolean;
  }) => call<{ preview: RunPreview }>('/api/runs/preview', json('POST', input)),
  startRun: (input: {
    task: string;
    projectId: string;
    workflowId: string;
    profile?: WorkflowDefinition['executionProfile'];
    permissionMode?: WorkflowDefinition['permissionMode'];
    enigmaConfirmed?: boolean;
    refinePrompt?: boolean;
    subscriptionOnly?: boolean;
    billingMode?: BillingMode;
    lockProviders?: boolean;
  }) => call<{ run: RunSummary }>('/api/runs', json('POST', input)),
  run: (id: string) =>
    call<{
      run: RunSummary;
      effectiveRules: TuringRule[];
      findings: Array<Record<string, unknown>>;
      decisions?: DecisionResult[];
      gitOperations: GitOperation[];
      events: Array<{ type: string; payload: Record<string, unknown>; createdAt: string }>;
    }>(`/api/runs/${id}`),
  replayRun: (id: string, enigmaConfirmed = false) =>
    call<{ run: RunSummary }>(`/api/runs/${id}/replay`, json('POST', { enigmaConfirmed })),
  duplicateRunWorkflow: (id: string) =>
    call<{ workflow: WorkflowDefinition; providerAssignments: RunPreview['providerAssignments'] }>(
      `/api/runs/${id}/duplicate-workflow`,
      json('POST'),
    ),
  executionOperations: (id: string) =>
    call<{ operations: ExecutionOperation[] }>(`/api/runs/${id}/execution-operations`),
  diff: (id: string) =>
    call<{ diff: string; truncated: boolean; cwd: string; message?: string }>(`/api/runs/${id}/diff`),
  cancelRun: (id: string) =>
    call<{ accepted: boolean; status?: 'cancelled' }>(`/api/runs/${id}/cancel`, json('POST')),
  resumeRun: (id: string) => call<{ accepted: boolean }>(`/api/runs/${id}/resume`, json('POST')),
  confirmPromptRefinement: (id: string, specification: string, clarification: string) =>
    call<{ accepted: boolean }>(
      `/api/runs/${id}/refinement/confirm`,
      json('POST', { specification, clarification }),
    ),
  intervene: (id: string, message: string) =>
    call<{ recorded: boolean; requiresResume: boolean; affectedStageId: string | null }>(
      `/api/runs/${id}/interventions`,
      json('POST', { message }),
    ),
  decideApproval: (id: string, approved: boolean) =>
    call<{ decided: boolean; approved: boolean }>(
      `/api/approvals/${id}/decision`,
      json('POST', { approved }),
    ),
  usage: (window: 'today' | '7d' | '30d') => call<Record<string, unknown>>(`/api/usage?window=${window}`),
  saveQuotaEnvelope: (quota: {
    providerId: string;
    quotaName: string;
    windowLabel: string;
    resetAt: string;
    effectiveAt: string;
    allowance: number;
    unit: 'input_tokens' | 'output_tokens' | 'total_tokens' | 'requests' | 'minutes';
    notes: string;
    subscriptionCostUsd: number | null;
  }) => call<{ quota: Record<string, unknown> }>('/api/usage/quotas', json('POST', quota)),
  deleteQuotaEnvelope: (id: string) => call<{ deleted: boolean }>(`/api/usage/quotas/${id}`, json('DELETE')),
  tailscaleReadiness: () =>
    call<{
      tailscale: {
        installed: boolean;
        running: boolean;
        hostname: string | null;
        ips: string[];
        serveConfigured: boolean | null;
        identityHeaderPresent: boolean;
        identityObservation: string;
        masterLoopbackOnly: boolean;
        connectionHealth: string;
        message: string;
      };
    }>('/api/system/readiness'),
  webPushConfig: () =>
    call<{ enabled: boolean; publicKey: string | null; reason: string | null }>('/api/notifications/config'),
  savePushSubscription: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    call<{ id: string; subscribed: boolean }>('/api/notifications/subscriptions', json('POST', subscription)),
  deletePushSubscription: (id: string) =>
    call<{ deleted: boolean }>(`/api/notifications/subscriptions/${encodeURIComponent(id)}`, json('DELETE')),
  renameMachine: (name: string) => call('/api/settings/machine', json('PATCH', { name })),
  pairingRequests: () =>
    call<{
      requests: Array<{
        id: string;
        deviceName: string;
        tailscaleLogin: string | null;
        createdAt: string;
        expiresAt: string;
        claimedAt: string | null;
        status: string;
      }>;
    }>('/api/pairing/requests'),
  pairedDevices: () =>
    call<{
      devices: Array<{
        id: string;
        name: string;
        tailscaleLogin: string | null;
        createdAt: string;
        lastSeenAt: string | null;
        expiresAt: string;
        status: 'active' | 'expired';
      }>;
    }>('/api/pairing/devices'),
  createPairingRequest: () =>
    call<{
      request: { id: string; code: string; status: string; createdAt: string; expiresAt: string };
    }>('/api/pairing/requests', json('POST')),
  approvePairingRequest: (id: string) =>
    call<{ approved: boolean }>(`/api/pairing/requests/${id}/approve`, json('POST')),
  denyPairingRequest: (id: string) =>
    call<{ denied: boolean }>(`/api/pairing/requests/${id}/deny`, json('POST')),
  revokePairedDevice: (id: string) =>
    call<{ revoked: boolean }>(`/api/pairing/devices/${id}`, json('DELETE')),
  claimPairing: (code: string, deviceName: string) =>
    call<{ requestId: string; status: string; expiresAt: string }>(
      '/api/pairing/claim',
      json('POST', { code, deviceName }),
    ),
  claimPairingRequest: (requestId: string, deviceName: string) =>
    call<{ requestId: string; status: string; expiresAt: string }>(
      '/api/pairing/claim-request',
      json('POST', { requestId, deviceName }),
    ),
  completePairing: (requestId: string, code?: string) =>
    call<
      { status: 'waiting_for_desktop_approval' } | { deviceId: string; machineId: string; expiresAt: string }
    >('/api/pairing/complete', json('POST', { requestId, ...(code ? { code } : {}) })),
  exportWorkflows: (workflows: WorkflowDefinition[]) => {
    const exportModelConfiguration = (configuration: ModelConfiguration | undefined) => {
      if (!configuration) return configuration;
      const { connectionProfileId, ...safeConfiguration } = configuration;
      return {
        ...safeConfiguration,
        ...(connectionProfileId
          ? {
              connectionReference: `${configuration.backendId ?? ''}:${configuration.providerId ?? ''}:${configuration.billingLane ?? 'unknown'}`,
            }
          : {}),
      };
    };
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      workflows: sanitizeWorkflowExport(
        workflows.map((workflow) => ({
          ...workflow,
          defaultModelConfiguration: exportModelConfiguration(workflow.defaultModelConfiguration),
          stageDefaults: workflow.stageDefaults
            ? Object.fromEntries(
                Object.entries(workflow.stageDefaults).map(([kind, configuration]) => [
                  kind,
                  exportModelConfiguration(configuration),
                ]),
              )
            : undefined,
          stages: workflow.stages.map((stage) => ({
            ...stage,
            ...(stage.connectionProfileId
              ? {
                  connectionReference: `${stage.backendId ?? ''}:${stage.providerId ?? ''}:${stage.billingLane ?? 'unknown'}`,
                }
              : {}),
            ...(stage.decision
              ? {
                  decision: {
                    ...stage.decision,
                    ...(stage.decision.connectionProfileId
                      ? { connectionReference: 'openrouter:openrouter:openrouter-metered' }
                      : {}),
                    judge: exportModelConfiguration(stage.decision.judge),
                    escalation: stage.decision.escalation
                      ? {
                          ...stage.decision.escalation,
                          ...(stage.decision.escalation.connectionProfileId
                            ? { connectionReference: 'openrouter:openrouter:openrouter-metered' }
                            : {}),
                          judge: exportModelConfiguration(stage.decision.escalation.judge),
                        }
                      : undefined,
                  },
                }
              : {}),
          })),
        })),
      ),
    };
  },
};

export type ConnectionProfileWithCredentials = ConnectionProfile & {
  credentials?: { inference: boolean; management: boolean };
};

export interface BudgetWindow {
  committedUsd: number;
  capUsd: number | null;
}
export interface BudgetStatus {
  timeZone: string;
  run: BudgetWindow;
  daily: BudgetWindow;
  monthly: BudgetWindow;
  warningRatio: number;
}

export interface MetricTotal {
  value: number | null;
  reported: number;
  missing: number;
}
export interface UsageAggregate {
  events: number;
  requests: number;
  durationMs: number;
  inputTokens: MetricTotal;
  outputTokens: MetricTotal;
  cachedInputTokens: MetricTotal;
  cacheWriteTokens: MetricTotal;
  reasoningTokens: MetricTotal;
  totalTokens: MetricTotal;
  actualMeteredCostUsd: MetricTotal;
  equivalentValueUsd: MetricTotal;
  tokenProvenance: Record<string, number>;
}
export interface UsageGroupRow extends UsageAggregate {
  key: string;
  label: string;
  billingLane: string | null;
  providerId: string | null;
  modelId: string | null;
  roles: Record<string, number>;
  projects: Record<string, number>;
  reasoning: Record<string, number>;
  upstreamProviders: Record<string, number>;
}
export interface UsageAnalytics {
  filter: { from: string; to: string; timeZone: string } & Record<string, string | undefined>;
  granularity: 'hour' | 'day';
  totals: UsageAggregate;
  activeModels: number;
  activeBillingLanes: number;
  series: Array<UsageAggregate & { bucket: string }>;
  byBillingLane: UsageGroupRow[];
  byModel: UsageGroupRow[];
  byProvider: UsageGroupRow[];
  byRole: UsageGroupRow[];
  byProject: UsageGroupRow[];
  byWorkflow: UsageGroupRow[];
  byMachine: UsageGroupRow[];
  byWorkload: UsageGroupRow[];
  byReasoning: UsageGroupRow[];
  decisions: {
    decisions: number;
    byType: Record<string, number>;
    byOutcome: Record<string, number>;
    autoRouted: number;
    escalated: number;
    costUsd: MetricTotal;
    inputTokens: MetricTotal;
    outputTokens: MetricTotal;
    averageBooleanProbability: number | null;
    averageChoiceConfidence: number | null;
    averageScoreConfidence: number | null;
    byEngineModel: Array<{
      key: string;
      engine: string;
      modelId: string | null;
      decisions: number;
      costUsd: number | null;
    }>;
  };
  events: Array<Record<string, unknown>>;
  eventCount: number;
}
