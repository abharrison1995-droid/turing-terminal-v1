import { execFile as callbackExecFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { ModelOption, ProviderCapabilities, ProviderStatus } from '../shared/types.js';
import type { PermissionMode } from '../shared/types.js';
import type { BillingLane, BillingMode, WorkloadType } from '../shared/types.js';
import { evaluateBillingLane, routeMatchesBillingLane } from '../shared/billing.js';
import { validateModelSettings } from '../shared/modelSettings.js';
import { redactSecrets, safeChildEnvironment } from './security.js';

const execFile = promisify(callbackExecFile);
let providerCache: ProviderStatus[] | null = null;
let providerCacheExpires = 0;
let providerDiscovery: Promise<ProviderStatus[]> | null = null;

export interface ProviderRunRequest {
  backendId: string;
  providerId: string;
  modelId: string;
  permissionMode: PermissionMode;
  role: string;
  reasoning?: string;
  variantId?: string;
  nativeSettings?: Record<string, string | number | boolean | null>;
  billingLane?: BillingLane;
  subscriptionOnly?: boolean;
  billingMode?: BillingMode;
  customAllowedLanes?: BillingLane[];
  workload?: WorkloadType;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  onLog: (line: string) => void;
  toolBroker: { url: string; token: string };
  onToolRequest?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason: string }>;
}

export interface ProviderRunResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usageProvenance: 'provider_reported' | 'locally_measured' | 'unavailable';
  exitCode: number;
  stdout: string;
}

interface ProviderAdapter {
  id: string;
  name: string;
  cli: string;
  authMechanism: string;
  capabilities: ProviderCapabilities;
  discover(): Promise<{
    detected: boolean;
    version: string | null;
    models: ModelOption[];
    authentication: ProviderStatus['authentication'];
    subscriptionAuthenticated?: boolean | null;
    note: string;
    capabilities?: Partial<ProviderCapabilities>;
  }>;
  execute(request: ProviderRunRequest): Promise<ProviderRunResult>;
}

const openCodeCaps: ProviderCapabilities = {
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
  sessionResume: true,
  toolMediation: true,
};
const codexCaps: ProviderCapabilities = {
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
};
const claudeCaps: ProviderCapabilities = {
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
  sessionResume: true,
  toolMediation: true,
};
const clineCaps: ProviderCapabilities = {
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

const adapters: ProviderAdapter[] = [
  {
    id: 'codex-cli',
    name: 'OpenAI Codex CLI',
    cli: 'codex',
    authMechanism: 'Official Codex CLI ChatGPT sign-in',
    capabilities: codexCaps,
    discover: async () => {
      const version = await commandOutput('codex', ['--version']);
      if (!version) return missingAdapter('OpenAI Codex CLI');
      const authOutput = await commandOutputIncludingStderr('codex', ['login', 'status']);
      const authMethod = parseCodexAuthStatus(authOutput ?? '');
      const models = authMethod === 'chatgpt' ? await discoverCodexModels() : [];
      return {
        detected: true,
        version: version.trim(),
        models,
        authentication: authMethod ? 'connected' : authOutput ? 'disconnected' : 'unknown',
        subscriptionAuthenticated: authMethod === 'chatgpt',
        note:
          authMethod === 'chatgpt'
            ? models.length
              ? 'Signed in with ChatGPT. Available models are discovered through the local Codex app server; each run forces ChatGPT authentication and disables Codex shell, apps, plugins, and other MCP servers so Turing tools remain the only action path.'
              : 'Signed in with ChatGPT, but Codex model discovery returned no models. Turing will not start a run until the catalog is available.'
            : authMethod === 'api_key'
              ? 'Codex is signed in with an API key. Turing requires ChatGPT subscription sign-in and will not use OpenAI API billing.'
              : 'Codex sign-in could not be verified. Turing will not start this backend until ChatGPT sign-in is confirmed.',
        capabilities: {
          modelDiscovery: models.length > 0,
          toolMediation: supportsCodexBroker(version),
        },
      };
    },
    execute: runCodexCli,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    cli: 'opencode',
    authMechanism: 'OpenCode managed auth (OAuth or OpenCode Go)',
    capabilities: openCodeCaps,
    discover: async () => {
      const version = await commandOutput('opencode', ['--version']);
      if (!version) return missingAdapter('OpenCode');
      const modelOutput = await commandOutput('opencode', ['models', '--verbose'], {
        timeoutMs: 20_000,
        maxBuffer: 12_000_000,
      });
      const models = parseOpenCodeModels(modelOutput ?? '');
      const authOutput = await commandOutput('opencode', ['auth', 'list', '--format', 'json']);
      const authentication: ProviderStatus['authentication'] =
        authOutput && authOutput.trim().length > 2 ? 'connected' : 'unknown';
      const note = models.length
        ? 'Models were discovered from the installed OpenCode CLI. Credential type may need confirmation in OpenCode; no API-key fallback is enabled by Turing.'
        : 'OpenCode is installed. Model discovery returned no usable catalog; check `opencode models` and its authentication status.';
      return { detected: true, version: version.trim(), models, authentication, note };
    },
    execute: runOpenCode,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    cli: 'claude',
    authMechanism: 'Official Claude Code CLI sign-in',
    capabilities: claudeCaps,
    discover: async () => {
      const version = await commandOutput('claude', ['--version']);
      if (!version) return missingAdapter('Claude Code');
      const authOutput = await commandOutput('claude', ['auth', 'status']);
      const auth = parseClaudeAuthStatus(authOutput ?? '');
      const authentication: ProviderStatus['authentication'] =
        auth.loggedIn === true ? 'connected' : auth.loggedIn === false ? 'disconnected' : 'unknown';
      const subscriptionAuthenticated =
        auth.loggedIn === true && auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty';
      return {
        detected: true,
        version: version.trim(),
        models: [],
        authentication,
        subscriptionAuthenticated,
        note: subscriptionAuthenticated
          ? 'Authenticated through a Claude.ai subscription. Turing strips Anthropic API-key environment variables and makes no API-key fallback.'
          : auth.loggedIn
            ? 'Claude Code is authenticated through a non-subscription method. Turing will not launch this backend to avoid API billing.'
            : 'Claude Code subscription authentication is unavailable or could not be verified. Turing will not launch this backend until a Claude.ai subscription is confirmed.',
        capabilities: {
          toolMediation: supportsRestrictedClaudeCode(version),
        },
      };
    },
    execute: runClaudeCode,
  },
  {
    id: 'cline',
    name: 'Cline',
    cli: 'cline',
    authMechanism: 'Cline CLI OAuth/provider sign-in',
    capabilities: clineCaps,
    discover: async () => {
      const version = await commandOutput('cline', ['--version']);
      if (!version) return missingAdapter('Cline');
      return {
        detected: true,
        version: version.trim(),
        models: [],
        authentication: 'unknown',
        note: 'Uses the installed Cline CLI account and provider settings. Model discovery and allowance telemetry are not exposed by this adapter.',
      };
    },
    execute: runCline,
  },
];

/**
 * The last discovery result already held in memory, however old, or null. It starts no CLI process and makes no
 * network request; read-only previews use it so they never trigger discovery.
 */
export function peekProviderCache(): ProviderStatus[] | null {
  return providerCache ? structuredClone(providerCache) : null;
}

export function invalidateProviderCache(): void {
  providerCache = null;
  providerCacheExpires = 0;
}

export async function discoverProviders(): Promise<ProviderStatus[]> {
  if (providerCache && Date.now() < providerCacheExpires) return structuredClone(providerCache);
  if (providerDiscovery) return structuredClone(await providerDiscovery);
  providerDiscovery = Promise.all(
    adapters.map(async (adapter) => {
      try {
        const result = await adapter.discover();
        // Each provider gets the time its own discovery result was captured, not the fan-out start time.
        const checkedAt = new Date().toISOString();
        const models = result.models.map((model) => ({
          ...model,
          discoveredAt: checkedAt,
          adapterVersion: result.version,
        }));
        return {
          id: adapter.id,
          name: adapter.name,
          cli: adapter.cli,
          detected: result.detected,
          version: result.version,
          authentication: result.authentication,
          subscriptionAuthenticated: result.subscriptionAuthenticated ?? null,
          authMechanism: adapter.authMechanism,
          note: result.note,
          checkedAt,
          capabilities: { ...adapter.capabilities, ...result.capabilities },
          models,
          catalogOutcome: models.length ? ('success' as const) : ('empty' as const),
        };
      } catch {
        const checkedAt = new Date().toISOString();
        return {
          id: adapter.id,
          name: adapter.name,
          cli: adapter.cli,
          detected: false,
          version: null,
          authentication: 'unknown' as const,
          subscriptionAuthenticated: null,
          authMechanism: adapter.authMechanism,
          note: 'Provider discovery failed. Retry the explicit refresh to check again.',
          checkedAt,
          capabilities: { ...adapter.capabilities },
          models: [],
          catalogOutcome: 'failed' as const,
        };
      }
    }),
  );
  try {
    providerCache = await providerDiscovery;
    providerCacheExpires = Date.now() + 60_000;
    return structuredClone(providerCache);
  } finally {
    providerDiscovery = null;
  }
}

export async function executeProvider(request: ProviderRunRequest): Promise<ProviderRunResult> {
  const adapter = adapters.find((candidate) => candidate.id === request.backendId);
  if (!adapter)
    throw new Error(`Execution backend “${request.backendId}” is not supported by this installation.`);
  const status = await adapter.discover();
  if (!status.detected)
    throw new Error(
      `${adapter.name} CLI was not found. Install it and authenticate using its official CLI flow.`,
    );
  if (status.authentication === 'disconnected')
    throw new Error(`${adapter.name} reports that it is not authenticated.`);
  if (adapter.id === 'claude-code' && status.subscriptionAuthenticated !== true)
    throw new Error(
      'Claude Code is not authenticated through a verified Claude.ai subscription. Turing will not use Anthropic API billing.',
    );
  if (adapter.id === 'claude-code' && request.providerId !== 'anthropic-subscription')
    throw new Error('Select Claude.ai subscription authentication; Anthropic API providers are disabled.');
  if (adapter.id === 'codex-cli' && status.subscriptionAuthenticated !== true)
    throw new Error(
      'Codex CLI is not authenticated through ChatGPT. Turing will not use OpenAI API billing.',
    );
  if (adapter.id === 'codex-cli' && request.providerId !== 'openai-codex')
    throw new Error('Select ChatGPT subscription authentication; OpenAI API providers are disabled.');
  if (!routeMatchesBillingLane(request.backendId, request.providerId, request.billingLane))
    throw new Error(
      `Provider ${request.providerId} cannot execute through billing lane ${request.billingLane ?? 'unknown'}.`,
    );
  if (adapter.id === 'opencode') {
    const selectedModel = status.models.find((model) => model.id === request.modelId);
    if (!selectedModel) throw new Error('The exact OpenCode model is not present in the current catalog.');
    if (!request.modelId.startsWith(`${request.providerId}/`))
      throw new Error('Use the exact provider-native OpenCode model ID, including its provider prefix.');
    if (request.modelId.includes('#'))
      throw new Error(
        'Store the OpenCode base model ID and provider-native variant in their separate fields.',
      );
    if (
      request.billingLane &&
      ['opencode-go-subscription', 'chatgpt-subscription'].includes(request.billingLane) &&
      !selectedModel.subscriptionBacked
    )
      throw new Error('The selected model is not reported as backed by the configured subscription lane.');
    if (
      request.billingLane &&
      !['opencode-go-subscription', 'chatgpt-subscription'].includes(request.billingLane) &&
      selectedModel.subscriptionBacked
    )
      throw new Error('A subscription-backed model cannot be relabeled as a metered or API billing lane.');
    if (request.variantId && !selectedModel.variantIds?.includes(request.variantId))
      throw new Error(`Variant “${request.variantId}” was not reported as supported for this exact model.`);
  }
  if (
    adapter.id === 'cline' &&
    !['openai-codex', 'cline-pass'].includes(request.providerId) &&
    !['cline-usage-billing', 'openai-api', 'anthropic-api'].includes(request.billingLane ?? '')
  )
    throw new Error(
      'Select ClinePass, OpenAI Codex subscription authentication, or explicitly configure the Cline usage-billing lane.',
    );
  if (adapter.id === 'codex-cli') {
    const selectedModel = status.models.find((model) => model.id === request.modelId);
    if (!selectedModel?.subscriptionBacked)
      throw new Error(
        'Select a model discovered from the signed-in ChatGPT account. OpenAI API models are disabled.',
      );
  }
  if (!request.modelId.trim())
    throw new Error(
      `Choose an explicit model for ${adapter.name}; Turing will not select one automatically.`,
    );
  const billingMode: BillingMode =
    request.billingMode ?? (request.subscriptionOnly === false ? 'custom' : 'subscriptions-only');
  const billing = evaluateBillingLane({
    mode: billingMode,
    lane: request.billingLane,
    workload: request.workload ?? 'generative',
    customAllowedLanes: request.customAllowedLanes,
  });
  if (!billing.allowed)
    throw new Error(`Billing lane “${request.billingLane}” is blocked: ${billing.reason}`);
  const selectedModel = status.models.find((model) => model.id === request.modelId);
  const settingErrors = validateModelSettings({
    backendId: adapter.id,
    model: selectedModel,
    catalogAvailable: status.models.length > 0,
    reasoning: request.reasoning,
    variantId: request.variantId,
    nativeSettings: request.nativeSettings,
  });
  if (settingErrors.length) throw new Error(settingErrors.join(' '));
  if (adapter.id === 'claude-code' && !supportsRestrictedClaudeCode(status.version))
    throw new Error(
      'Claude Code 2.1.248 or later is required for Turing-managed tool mediation. Update Claude Code before running this workflow.',
    );
  const runtimeCapabilities = { ...adapter.capabilities, ...status.capabilities };
  if (!runtimeCapabilities.toolMediation)
    throw new Error(`${adapter.name} does not have an execution mediation bridge in this installation.`);
  return adapter.execute(request);
}

function supportsCodexBroker(version: string | null): boolean {
  const match = version?.match(/\b0\.(\d+)\.(\d+)/);
  if (!match) return false;
  const minor = Number(match[1]);
  return Number.isInteger(minor) && minor >= 155;
}

export function parseCodexAuthStatus(output: string): 'chatgpt' | 'api_key' | null {
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, '').toLowerCase();
  if (!/logged\s+in|authenticated|signed\s+in/.test(normalized)) return null;
  if (/chatgpt/.test(normalized)) return 'chatgpt';
  if (/api[ _-]?key|apikey/.test(normalized)) return 'api_key';
  return null;
}

export function parseCodexModels(value: unknown): ModelOption[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): ModelOption[] => {
    if (!row || typeof row !== 'object') return [];
    const model = row as Record<string, unknown>;
    const id = typeof model.id === 'string' ? model.id : typeof model.model === 'string' ? model.model : '';
    if (!id || model.hidden === true) return [];
    const supportedEfforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const effort = (item as Record<string, unknown>).reasoningEffort;
          return typeof effort === 'string' ? [effort] : [];
        })
      : [];
    return [
      {
        id,
        name: typeof model.displayName === 'string' ? model.displayName : id,
        providerId: 'openai-codex',
        subscriptionBacked: true,
        ...(supportedEfforts.length ? { reasoningLevels: supportedEfforts } : {}),
      },
    ];
  });
}

function discoverCodexModels(): Promise<ModelOption[]> {
  return new Promise((resolveModels) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      env: safeCodexSubscriptionEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    const models: ModelOption[] = [];
    let initialized = false;
    let requestId = 1;
    let pageCount = 0;
    let settled = false;
    const timer = setTimeout(() => finish(models), 8_000);
    const finish = (result: ModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolveModels(result);
    };
    child.once('error', () => finish([]));
    child.once('close', () => finish(models));
    lines.on('line', (line) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.id === 0 && message.result && !initialized) {
        initialized = true;
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        requestPage(null);
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) return finish(models);
      const result =
        message.result && typeof message.result === 'object'
          ? (message.result as { data?: unknown; nextCursor?: unknown })
          : {};
      models.push(...parseCodexModels(result));
      pageCount += 1;
      if (typeof result.nextCursor === 'string' && pageCount < 5) requestPage(result.nextCursor);
      else finish(models);
    });
    child.stdin.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: { name: 'turing-terminal', title: 'Turing Terminal', version: '1.0.0' },
        },
      })}\n`,
    );

    function requestPage(cursor: string | null): void {
      requestId += 1;
      child.stdin.write(
        `${JSON.stringify({
          method: 'model/list',
          id: requestId,
          params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
        })}\n`,
      );
    }
  });
}

export function safeCodexSubscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = safeChildEnvironment(source);
  for (const key of Object.keys(env)) {
    if (/^OPENAI_/i.test(key) || /^CODEX_(?:API|MODEL_PROVIDER|BASE_URL)/i.test(key)) delete env[key];
  }
  return env;
}

async function runCodexCli(request: ProviderRunRequest): Promise<ProviderRunResult> {
  const broker = createMcpConfig(request.toolBroker);
  const serverConfig = {
    turing: {
      command: broker.command[0],
      args: broker.command.slice(1),
      cwd: request.cwd,
      env: {
        TT_TOOL_BROKER_URL: request.toolBroker.url,
        TT_TOOL_BROKER_TOKEN: request.toolBroker.token,
      },
      enabled: true,
      required: true,
      // Codex approves only the MCP transport call; Turing remains the authority
      // for each operation's selected permission mode and approval decision.
      default_tools_approval_mode: 'approve',
      enabled_tools: ['list_files', 'read_file', 'write_file', 'delete_file', 'run_command'],
    },
  };
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--cd',
    request.cwd,
    '--model',
    request.modelId,
    '--sandbox',
    'read-only',
    '--config',
    'forced_login_method="chatgpt"',
    '--config',
    'features.shell_tool=false',
    '--config',
    'features.apps=false',
    '--config',
    'features.plugins=false',
    '--config',
    'features.multi_agent=false',
    '--config',
    'web_search="disabled"',
    '--config',
    'model_provider="openai"',
    '--config',
    `mcp_servers=${tomlInline(serverConfig)}`,
  ];
  const codexEffort =
    request.reasoning ??
    (typeof request.nativeSettings?.reasoningEffort === 'string'
      ? request.nativeSettings.reasoningEffort
      : undefined);
  if (codexEffort) args.push('--config', `model_reasoning_effort=${JSON.stringify(codexEffort)}`);
  args.push(request.prompt);
  try {
    const result = await runChild('codex', args, {
      ...request,
      childEnvironment: safeCodexSubscriptionEnvironment(),
    });
    return parseCodexOutput(result.stdout, result.exitCode);
  } finally {
    rmSync(broker.directory, { recursive: true, force: true });
  }
}

function tomlInline(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, child]) => `${key} = ${tomlInline(child)}`)
      .join(', ')} }`;
  throw new Error('Codex provider configuration contains an unsupported value.');
}

export function parseCodexOutput(stdout: string, exitCode = 0): ProviderRunResult {
  let text = '';
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sawUsage = false;
  let finalMessage: string | null = null;
  const safeStdout = redactSecrets(stdout);
  for (const line of safeStdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const usage = (event.usage ?? (event.turn as Record<string, unknown> | undefined)?.usage) as
        Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = numeric(usage.input_tokens ?? usage.inputTokens);
        outputTokens = numeric(usage.output_tokens ?? usage.outputTokens);
        sawUsage = inputTokens !== null || outputTokens !== null;
      }
      if (event.type === 'turn.failed') throw new Error('Codex CLI reported a failed turn.');
      if (event.type === 'turn.completed') {
        const turn = event.turn as Record<string, unknown> | undefined;
        if (turn?.status && turn.status !== 'completed')
          throw new Error(`Codex CLI turn ended with status ${String(turn.status)}.`);
        if (typeof event.last_agent_message === 'string') finalMessage = event.last_agent_message;
      }
      if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
        const item = event.item as Record<string, unknown>;
        if (item.type === 'agent_message' || item.type === 'agentMessage') {
          if (typeof item.text === 'string') text += `${item.text}\n`;
          else if (Array.isArray(item.content))
            text += `${item.content
              .flatMap((part) =>
                part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
                  ? [(part as Record<string, unknown>).text as string]
                  : [],
              )
              .join('')}\n`;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Codex CLI')) throw error;
      text += `${line}\n`;
    }
  }
  return {
    text: redactSecrets((finalMessage ?? text).trim() || safeStdout.trim()),
    inputTokens,
    outputTokens,
    usageProvenance: sawUsage ? 'provider_reported' : 'unavailable',
    exitCode,
    stdout: safeStdout,
  };
}

function supportsRestrictedClaudeCode(version: string | null): boolean {
  const match = version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    (major ?? 0) > 2 ||
    ((major ?? 0) === 2 && ((minor ?? 0) > 1 || ((minor ?? 0) === 1 && (patch ?? 0) >= 248)))
  );
}

export function parseClaudeAuthStatus(output: string): {
  loggedIn: boolean | null;
  authMethod: string | null;
  apiProvider: string | null;
} {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    return {
      loggedIn: typeof value.loggedIn === 'boolean' ? value.loggedIn : null,
      authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
      apiProvider: typeof value.apiProvider === 'string' ? value.apiProvider : null,
    };
  } catch {
    return { loggedIn: null, authMethod: null, apiProvider: null };
  }
}

function missingAdapter(name: string) {
  return {
    detected: false,
    version: null,
    models: [],
    authentication: 'unknown' as const,
    subscriptionAuthenticated: null,
    note: `${name} CLI was not found on this machine.`,
  };
}

async function commandOutput(
  command: string,
  args: string[],
  limits: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string | null> {
  try {
    const result = await execFile(command, args, {
      timeout: limits.timeoutMs ?? 8_000,
      windowsHide: true,
      maxBuffer: limits.maxBuffer ?? 2_000_000,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

async function commandOutputIncludingStderr(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFile(command, args, { timeout: 8_000, windowsHide: true, maxBuffer: 2_000_000 });
    return result.stdout.trim() ? result.stdout : result.stderr;
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    return output.stdout?.trim() ? output.stdout : (output.stderr ?? null);
  }
}

export function parseOpenCodeModels(output: string): ModelOption[] {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const models = new Map<string, ModelOption>();
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index]?.trim().match(/^([\w.-]+\/[\w./:+-]+)$/)?.[1];
    if (!id) continue;
    let metadata: Record<string, unknown> = {};
    let endIndex = index;
    for (let next = index + 1; next < lines.length && !lines[next]?.trim(); next += 1) endIndex = next;
    const jsonStart = lines[endIndex + 1]?.trim() === '{' ? endIndex + 1 : -1;
    if (jsonStart >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let json = '';
      let finished = false;
      for (let next = jsonStart; next < lines.length && !finished; next += 1) {
        const line = lines[next] ?? '';
        json += `${line}\n`;
        for (const character of line) {
          if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
          } else if (character === '"') inString = true;
          else if (character === '{') depth += 1;
          else if (character === '}' && --depth === 0) finished = true;
        }
        endIndex = next;
      }
      try {
        if (finished) metadata = JSON.parse(json) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      index = endIndex;
    }
    const variants = metadata.variants;
    const variantIds = Array.isArray(variants)
      ? variants.flatMap((variant) =>
          variant &&
          typeof variant === 'object' &&
          typeof (variant as Record<string, unknown>).id === 'string'
            ? [(variant as Record<string, unknown>).id as string]
            : [],
        )
      : variants && typeof variants === 'object'
        ? Object.keys(variants as Record<string, unknown>)
        : [];
    const reportedCapabilities = metadata.capabilities;
    const capabilities =
      reportedCapabilities && typeof reportedCapabilities === 'object'
        ? Object.fromEntries(
            Object.entries(reportedCapabilities as Record<string, unknown>).filter(([key]) =>
              ['tools', 'input', 'output'].includes(key),
            ),
          )
        : {};
    models.set(id, {
      id,
      name: typeof metadata.name === 'string' ? metadata.name : id,
      providerId: id.split('/')[0] ?? '',
      subscriptionBacked: id.startsWith('openai-codex/') || id.startsWith('opencode-go/'),
      ...(variantIds.length ? { variantIds } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      ...(typeof capabilities.tools === 'boolean' ? { supportsTools: capabilities.tools } : {}),
    });
  }
  return [...models.values()];
}

async function runOpenCode(request: ProviderRunRequest): Promise<ProviderRunResult> {
  const broker = createMcpConfig(request.toolBroker);
  const args = [
    'run',
    '--format',
    'json',
    '--dir',
    request.cwd,
    '--model',
    openCodeModelSelector(request.modelId, request.variantId),
  ];
  if (request.permissionMode === 'yolo') args.push('--auto');
  args.push(request.prompt);
  try {
    const result = await runChild('opencode', args, {
      ...request,
      childEnvironment: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeBrokerConfig(broker.command, request.toolBroker)),
      },
    });
    return parseProviderResult(result, 'opencode');
  } finally {
    rmSync(broker.directory, { recursive: true, force: true });
  }
}

export function openCodeModelSelector(modelId: string, variantId?: string): string {
  return variantId ? `${modelId}#${variantId}` : modelId;
}

async function runClaudeCode(request: ProviderRunRequest): Promise<ProviderRunResult> {
  const broker = createMcpConfig(request.toolBroker);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    request.modelId,
    '--restricted',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    broker.configPath,
    '--permission-mode',
    'default',
    '--max-turns',
    '30',
  ];
  const effort =
    typeof request.nativeSettings?.effort === 'string' ? request.nativeSettings.effort : undefined;
  if (effort) args.push('--effort', effort);
  args.push(request.prompt);
  try {
    const result = await runChild('claude', args, {
      ...request,
      childEnvironment: safeClaudeSubscriptionEnvironment(),
    });
    return parseProviderResult(result, 'claude-code');
  } finally {
    rmSync(broker.directory, { recursive: true, force: true });
  }
}

export function safeClaudeSubscriptionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = safeChildEnvironment(source);
  for (const key of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_CODE_USE_)/i.test(key)) delete env[key];
  }
  return env;
}

async function runCline(request: ProviderRunRequest): Promise<ProviderRunResult> {
  const args = [
    '--json',
    '--provider',
    request.providerId,
    '--model',
    request.modelId,
    '--cwd',
    request.cwd,
    '--auto-approve',
    'false',
  ];
  const thinking =
    typeof request.nativeSettings?.thinking === 'string' ? request.nativeSettings.thinking : undefined;
  if (thinking) args.push('--thinking', thinking);
  if (['planner', 'reviewer', 'consolidator', 'final-gate'].includes(request.role)) args.push('--plan');
  args.push(request.prompt);
  // The current Cline CLI exposes a documented desktop file-based tool
  // approval interface. File IPC is bridged into Turing's permission policy.
  const approvalDir = mkdtempSync(join(tmpdir(), 'turing-cline-approval-'));
  try {
    const result = await runChild('cline', args, {
      ...request,
      childEnvironment: {
        CLINE_TOOL_APPROVAL_MODE: 'desktop',
        CLINE_TOOL_APPROVAL_DIR: approvalDir,
        CLINE_COMMAND_PERMISSIONS: JSON.stringify({
          allow: ['npm *', 'pnpm *', 'yarn *', 'bun *', 'git *'],
          deny: ['sudo *', 'rm -rf *', 'git reset --hard *', 'git clean -f*', 'git push --force*'],
          allowRedirects: false,
        }),
      },
      onChildStarted: (child) => {
        void monitorClineApprovals(approvalDir, request, () => child.exitCode !== null || child.killed);
      },
    });
    return parseProviderResult(result, 'cline');
  } finally {
    rmSync(approvalDir, { recursive: true, force: true });
  }
}

interface ChildResult {
  stdout: string;
  exitCode: number;
}

function runChild(
  command: string,
  args: string[],
  request: ProviderRunRequest & {
    childEnvironment?: NodeJS.ProcessEnv;
    onChildStarted?: (child: ChildProcessByStdio<null, Readable, Readable>) => void;
  },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) return reject(new Error('Stage was cancelled before the provider started.'));
    const env = { ...safeChildEnvironment(), ...request.childEnvironment };
    const child = spawn(command, args, {
      cwd: request.cwd,
      env,
      shell: false,
      detached: platform() !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    request.onChildStarted?.(child);
    const childResult = collectOutput(child, request);
    const timer = setTimeout(() => terminateChild(child), request.timeoutMs);
    const onAbort = () => terminateChild(child);
    request.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      reject(new Error(`${command} could not start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      void childResult.then((stdout) => {
        if (request.signal.aborted)
          return reject(new Error('Stage cancelled by the user. Provider process was stopped.'));
        if (code !== 0)
          return reject(
            new Error(
              `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}. ${tail(stdout, 1200)}`,
            ),
          );
        resolve({ stdout, exitCode: code ?? 0 });
      }, reject);
    });
  });
}

function createMcpConfig(toolBroker: { url: string; token: string }): {
  directory: string;
  configPath: string;
  command: string[];
} {
  const directory = mkdtempSync(join(tmpdir(), 'turing-provider-mcp-'));
  const command = providerMcpCommand();
  const configPath = join(directory, 'mcp.json');
  const config = {
    mcpServers: {
      turing: {
        command: command[0],
        args: command.slice(1),
        env: {
          TT_TOOL_BROKER_URL: toolBroker.url,
          TT_TOOL_BROKER_TOKEN: toolBroker.token,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  try {
    chmodSync(directory, 0o700);
    chmodSync(configPath, 0o600);
  } catch {
    /* Windows ACLs provide the platform equivalent. */
  }
  return { directory, configPath, command };
}

function providerMcpCommand(): string[] {
  const isTypeScriptSource = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(
    new URL(isTypeScriptSource ? './providerMcp.ts' : './providerMcp.js', import.meta.url),
  );
  const command = [process.execPath];
  if (isTypeScriptSource) command.push('--import', fileURLToPath(import.meta.resolve('tsx')));
  command.push(script);
  return command;
}

function openCodeBrokerConfig(command: string[], toolBroker: { url: string; token: string }) {
  return {
    permission: { '*': 'deny', 'turing_*': 'allow' },
    mcp: {
      turing: {
        type: 'local',
        command,
        enabled: true,
        environment: {
          TT_TOOL_BROKER_URL: toolBroker.url,
          TT_TOOL_BROKER_TOKEN: toolBroker.token,
        },
      },
    },
  };
}

async function monitorClineApprovals(
  approvalDir: string,
  request: ProviderRunRequest,
  isChildFinished: () => boolean,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const seen = new Set<string>();
  while (!request.signal.aborted && !isChildFinished()) {
    let files: string[] = [];
    try {
      files = await fs.readdir(approvalDir);
    } catch {
      break;
    }
    for (const file of files) {
      const match = /^(.+)\.request\.([a-zA-Z0-9._-]+)\.json$/.exec(file);
      if (!match || seen.has(file)) continue;
      seen.add(file);
      const requestPath = join(approvalDir, file);
      const decisionPath = join(approvalDir, `${match[1]}.decision.${match[2]}.json`);
      let toolRequest: { toolName?: unknown; input?: unknown };
      try {
        toolRequest = JSON.parse(await fs.readFile(requestPath, 'utf8')) as {
          toolName?: unknown;
          input?: unknown;
        };
      } catch {
        continue;
      }
      const name = typeof toolRequest.toolName === 'string' ? toolRequest.toolName : 'unknown_tool';
      const toolInput =
        toolRequest.input && typeof toolRequest.input === 'object' && !Array.isArray(toolRequest.input)
          ? (toolRequest.input as Record<string, unknown>)
          : {};
      const result =
        request.onToolRequest && !request.signal.aborted
          ? await request.onToolRequest(name, toolInput).catch((error: unknown) => ({
              approved: false,
              reason:
                error instanceof Error
                  ? error.message
                  : 'Turing Terminal could not authorize this tool call.',
            }))
          : { approved: false, reason: 'Turing Terminal did not provide a tool authorization handler.' };
      try {
        await fs.writeFile(
          decisionPath,
          JSON.stringify({ approved: result.approved, reason: result.reason }),
          { mode: 0o600 },
        );
      } catch {
        /* The child may have exited while Turing was waiting for user approval. */
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function collectOutput(
  child: ChildProcessByStdio<null, Readable, Readable>,
  request: ProviderRunRequest,
): Promise<string> {
  let output = '';
  let pending = '';
  const cap = 1_000_000;
  const append = (chunk: Buffer, isError: boolean) => {
    const value = redactSecrets(chunk.toString('utf8'));
    output = (output + value).slice(-cap);
    if (isError) pending += value;
    else pending += value;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) request.onLog(tail(line, 2_000));
  };
  child.stdout.on('data', (chunk: Buffer) => append(chunk, false));
  child.stderr.on('data', (chunk: Buffer) => append(chunk, true));
  return new Promise((resolve) =>
    child.once('close', () => {
      if (pending.trim()) request.onLog(tail(pending, 2_000));
      resolve(output);
    }),
  );
}

function terminateChild(child: ChildProcessByStdio<null, Readable, Readable>): void {
  if (child.killed || child.exitCode !== null) return;
  if (platform() === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.unref();
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  } else child.kill('SIGTERM');
}

function parseProviderResult(result: ChildResult, source: string): ProviderRunResult {
  return parseProviderOutput(result.stdout, source, result.exitCode);
}

export function parseProviderOutput(stdout: string, source: string, exitCode = 0): ProviderRunResult {
  let text = '';
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sawUsage = false;
  const safeStdout = redactSecrets(stdout);
  const lines = safeStdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const part = (event.part ?? event.message ?? event.content) as
        Record<string, unknown> | string | undefined;
      if (typeof part === 'string') text += `${part}\n`;
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') text += `${part.text}\n`;
        if (typeof part.content === 'string') text += `${part.content}\n`;
      }
      const usage = (event.usage ?? (event.message as Record<string, unknown> | undefined)?.usage) as
        Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = numeric(usage.input_tokens ?? usage.inputTokens ?? usage.input);
        outputTokens = numeric(usage.output_tokens ?? usage.outputTokens ?? usage.output);
        sawUsage = inputTokens !== null || outputTokens !== null;
      }
      if (typeof event.result === 'string') text += `${event.result}\n`;
      if (!part && typeof event.text === 'string') text += `${event.text}\n`;
      if (source === 'claude-code') {
        const usage = event.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = numeric(usage.input_tokens);
          outputTokens = numeric(usage.output_tokens);
          sawUsage = inputTokens !== null || outputTokens !== null;
        }
      }
    } catch {
      text += `${line}\n`;
    }
  }
  const cleanedText = redactSecrets(text.trim() || safeStdout.trim());
  return {
    text: cleanedText,
    inputTokens,
    outputTokens,
    usageProvenance: sawUsage ? 'provider_reported' : 'unavailable',
    exitCode,
    stdout: safeStdout,
  };
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(-maxLength);
}
