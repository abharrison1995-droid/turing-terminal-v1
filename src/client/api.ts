import type {
  DashboardSnapshot,
  ExecutionOperation,
  GitOperation,
  ProjectProfile,
  ProviderStatus,
  RunPreview,
  RunSummary,
  TuringRule,
  WorkflowDefinition,
} from '../shared/types';
import { masterApiUrl } from './desktop';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(masterApiUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

export const api = {
  dashboard: () => call<DashboardSnapshot>('/api/dashboard'),
  providers: () => call<{ providers: ProviderStatus[] }>('/api/providers'),
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
      stages: workflow.stages,
    };
    return call<{ workflow: WorkflowDefinition }>(
      create ? '/api/workflows' : `/api/workflows/${workflow.id}`,
      json(create ? 'POST' : 'PUT', body),
    );
  },
  duplicateWorkflow: (id: string) =>
    call<{ workflow: WorkflowDefinition }>(`/api/workflows/${id}/duplicate`, json('POST')),
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
  }) => call<{ preview: RunPreview }>('/api/runs/preview', json('POST', input)),
  startRun: (input: {
    task: string;
    projectId: string;
    workflowId: string;
    profile?: WorkflowDefinition['executionProfile'];
    permissionMode?: WorkflowDefinition['permissionMode'];
    enigmaConfirmed?: boolean;
    refinePrompt?: boolean;
  }) => call<{ run: RunSummary }>('/api/runs', json('POST', input)),
  run: (id: string) =>
    call<{
      run: RunSummary;
      effectiveRules: TuringRule[];
      findings: Array<Record<string, unknown>>;
      gitOperations: GitOperation[];
      events: Array<{ type: string; payload: Record<string, unknown>; createdAt: string }>;
    }>(`/api/runs/${id}`),
  executionOperations: (id: string) =>
    call<{ operations: ExecutionOperation[] }>(`/api/runs/${id}/execution-operations`),
  diff: (id: string) =>
    call<{ diff: string; truncated: boolean; cwd: string; message?: string }>(`/api/runs/${id}/diff`),
  cancelRun: (id: string) => call<{ accepted: boolean }>(`/api/runs/${id}/cancel`, json('POST')),
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
  exportWorkflows: (workflows: WorkflowDefinition[]) => ({
    version: 1,
    exportedAt: new Date().toISOString(),
    workflows,
  }),
};
