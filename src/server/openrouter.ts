import type { ModelOption, ProviderSpendTelemetry } from '../shared/types.js';
import { DEFAULT_JEV_MODEL } from '../shared/decisions.js';
import { classifyModelIdentity, OPENROUTER_REASONING_EFFORTS } from '../shared/modelSettings.js';
import { redactSecrets } from './security.js';
import type { UsageObservation } from './usageEvents.js';

/**
 * OpenRouter HTTP adapter (verified against openrouter.ai documentation on 2026-10-02).
 *
 * - Generative inference: POST /api/v1/chat/completions. Usage (tokens, cached/cache-write/reasoning
 *   tokens, and `cost` in USD) is always returned. `provider.max_price` bounds per-token price.
 * - Decisions (Jev): POST /api/alpha/decisions with `state` + typed `questions`.
 * - Key telemetry: GET /api/v1/key (inference key; no generation is sent).
 * - Account credits: GET /api/v1/credits (management key only; management keys cannot run inference).
 *
 * Keys are passed in per call and never logged, persisted here, or echoed in errors.
 */

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const CATALOG_SOURCE = `${OPENROUTER_ORIGIN}/api/v1/models`;
type FetchLike = typeof fetch;

function headers(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'x-title': 'Turing Terminal',
  };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly chargedUsd: number | null = null,
  ) {
    super(message);
  }
}

function scrub(text: string, key?: string): string {
  const withoutKey = key ? text.split(key).join('[REDACTED_API_KEY]') : text;
  return redactSecrets(withoutKey).slice(0, 800);
}

async function request<T>(
  fetchImpl: FetchLike,
  path: string,
  key: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 120_000), ...(init.signal ? [init.signal] : [])];
  let response: Response;
  try {
    response = await fetchImpl(`${OPENROUTER_ORIGIN}${path}`, {
      ...init,
      headers: headers(key),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw new OpenRouterError(
      `OpenRouter request failed: ${scrub(error instanceof Error ? error.message : String(error), key)}`,
      null,
    );
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new OpenRouterError(
      `OpenRouter returned HTTP ${response.status}${typeof message === 'string' ? `: ${scrub(message, key)}` : ''}.`,
      response.status,
    );
  }
  return body as T;
}

const price = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export function parseOpenRouterModels(
  payload: unknown,
  observedAt = new Date().toISOString(),
): ModelOption[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): ModelOption[] => {
    if (!row || typeof row !== 'object') return [];
    const model = row as Record<string, unknown>;
    const id = typeof model.id === 'string' ? model.id : '';
    if (!id) return [];
    const parameters = Array.isArray(model.supported_parameters)
      ? model.supported_parameters.filter((item): item is string => typeof item === 'string')
      : [];
    const pricing = (model.pricing ?? {}) as Record<string, unknown>;
    const overrides = Array.isArray(pricing.overrides)
      ? (pricing.overrides as Array<Record<string, unknown>>)
      : [];
    const maxOf = (field: string) => {
      const values = [price(pricing[field]), ...overrides.map((item) => price(item[field]))].filter(
        (value): value is number => value !== null,
      );
      return values.length ? Math.max(...values) : null;
    };
    const topProvider = (model.top_provider ?? {}) as Record<string, unknown>;
    const contextLength = typeof model.context_length === 'number' ? model.context_length : null;
    const maxCompletion =
      typeof topProvider.max_completion_tokens === 'number'
        ? topProvider.max_completion_tokens
        : contextLength;
    const architecture = (model.architecture ?? {}) as Record<string, unknown>;
    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
    const decision = /^~?typesafe\/jev/i.test(id);
    const supportsReasoning = parameters.includes('reasoning');
    const expiration =
      typeof model.expiration_date === 'string' && model.expiration_date ? model.expiration_date : null;
    return [
      {
        id,
        name: typeof model.name === 'string' ? model.name : id,
        providerId: 'openrouter',
        subscriptionBacked: false,
        family: decision ? 'decision' : 'generative',
        supportsTools: parameters.includes('tools'),
        supportsStructuredOutput:
          parameters.includes('structured_outputs') || parameters.includes('response_format'),
        supportsImages: inputs.includes('image'),
        contextLength,
        ...(supportsReasoning
          ? {
              reasoningControl: 'effort' as const,
              reasoningLevels: [...OPENROUTER_REASONING_EFFORTS],
              ...(maxCompletion ? { reasoningBudgetRange: { min: 1, max: maxCompletion } } : {}),
            }
          : { reasoningControl: 'none' as const }),
        supportsTemperature: parameters.includes('temperature'),
        ...(parameters.includes('temperature') ? { temperatureRange: { min: 0, max: 2 } } : {}),
        supportsMaxOutput: parameters.includes('max_tokens') && Boolean(maxCompletion),
        ...(parameters.includes('max_tokens') && maxCompletion
          ? { maxOutputRange: { min: 1, max: maxCompletion } }
          : {}),
        identity: classifyModelIdentity('openrouter', id),
        status: expiration ? 'deprecated' : 'current',
        deprecationDate: expiration,
        capabilities: { supportedParameters: parameters, inputModalities: inputs },
        pricing: {
          promptUsdPerToken: price(pricing.prompt),
          completionUsdPerToken: price(pricing.completion),
          requestUsd: price(pricing.request),
          cacheReadUsdPerToken: price(pricing.input_cache_read),
          maxPromptUsdPerToken: maxOf('prompt'),
          maxCompletionUsdPerToken: maxOf('completion'),
          source: CATALOG_SOURCE,
          observedAt,
        },
        discoveredAt: observedAt,
      },
    ];
  });
}

/** Public catalog; no credential and no generation. */
export async function fetchOpenRouterCatalog(fetchImpl: FetchLike = fetch): Promise<ModelOption[]> {
  let response: Response;
  try {
    response = await fetchImpl(CATALOG_SOURCE, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  return parseOpenRouterModels(await response.json().catch(() => null));
}

/** Adapter metadata used only when the live catalog does not list the Jev decision model. */
export function jevAdapterMetadata(): ModelOption {
  return {
    id: DEFAULT_JEV_MODEL,
    name: 'Jev 1.13 (TypeSafe)',
    providerId: 'openrouter',
    subscriptionBacked: false,
    family: 'decision',
    identity: 'pinned',
    status: 'last-known',
    reasoningControl: 'none',
    contextLength: 32_000,
    capabilities: { decisionTypes: ['noul', 'choice', 'score'], source: 'adapter metadata' },
  };
}

export async function fetchKeyTelemetry(
  key: string,
  connectionProfileId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderSpendTelemetry> {
  const body = await request<{ data?: Record<string, unknown> }>(fetchImpl, '/api/v1/key', key, {
    method: 'GET',
    timeoutMs: 15_000,
  });
  const data = body?.data ?? {};
  const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    scope: 'key',
    connectionProfileId,
    label: typeof data.label === 'string' ? redactSecrets(data.label).slice(0, 80) : null,
    usageUsd: n(data.usage),
    usageDailyUsd: n(data.usage_daily),
    usageWeeklyUsd: n(data.usage_weekly),
    usageMonthlyUsd: n(data.usage_monthly),
    limitUsd: n(data.limit),
    limitRemainingUsd: n(data.limit_remaining),
    limitReset: typeof data.limit_reset === 'string' ? data.limit_reset : null,
    expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
    accountCreditsUsd: null,
    accountUsageUsd: null,
    provenance: 'provider_measured',
    observedAt: new Date().toISOString(),
  };
}

/** Account-wide balance. Requires a management key; never used for inference. */
export async function fetchAccountCredits(
  managementKey: string,
  connectionProfileId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderSpendTelemetry> {
  const body = await request<{ data?: Record<string, unknown> }>(
    fetchImpl,
    '/api/v1/credits',
    managementKey,
    { method: 'GET', timeoutMs: 15_000 },
  );
  const data = body?.data ?? {};
  const credits = typeof data.total_credits === 'number' ? data.total_credits : null;
  const usage = typeof data.total_usage === 'number' ? data.total_usage : null;
  return {
    scope: 'account',
    connectionProfileId,
    label: null,
    usageUsd: null,
    usageDailyUsd: null,
    usageWeeklyUsd: null,
    usageMonthlyUsd: null,
    limitUsd: null,
    limitRemainingUsd: null,
    limitReset: null,
    expiresAt: null,
    accountCreditsUsd: credits !== null && usage !== null ? credits - usage : credits,
    accountUsageUsd: usage,
    provenance: 'provider_measured',
    observedAt: new Date().toISOString(),
  };
}

export function estimateTokensConservatively(text: string): number {
  // ~3 characters per token is deliberately pessimistic for English/code (typically ~4).
  return Math.ceil(text.length / 3) + 16;
}

/**
 * Conservative reservation in USD. Returns null when the request cannot be bounded
 * (missing price or no bounded output), so the unknown-cost policy applies.
 */
export function estimateReservationUsd(
  model: ModelOption | undefined,
  inputTokens: number,
  maxOutputTokens: number | null,
): number | null {
  const pricing = model?.pricing;
  if (!pricing) return null;
  const prompt = pricing.maxPromptUsdPerToken ?? pricing.promptUsdPerToken;
  const completion = pricing.maxCompletionUsdPerToken ?? pricing.completionUsdPerToken;
  if (prompt === null || completion === null) return null;
  if (completion > 0 && (maxOutputTokens === null || !Number.isFinite(maxOutputTokens))) return null;
  const output = completion > 0 ? (maxOutputTokens ?? 0) : 0;
  return Math.ceil(inputTokens * 1.1) * prompt + output * completion + (pricing.requestUsd ?? 0);
}

/** `provider.max_price` in USD per million tokens, matching the prices the reservation used. */
export function maxPriceFor(model: ModelOption | undefined): Record<string, number> | null {
  const pricing = model?.pricing;
  const prompt = pricing?.maxPromptUsdPerToken ?? pricing?.promptUsdPerToken;
  const completion = pricing?.maxCompletionUsdPerToken ?? pricing?.completionUsdPerToken;
  if (prompt == null || completion == null) return null;
  return { prompt: prompt * 1_000_000, completion: completion * 1_000_000 };
}

export function usageObservationFrom(body: Record<string, unknown> | null): UsageObservation {
  const usage = (body?.usage ?? null) as Record<string, unknown> | null;
  const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const promptDetails = (usage?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (usage?.completion_tokens_details ?? {}) as Record<string, unknown>;
  const input = n(usage?.prompt_tokens) ?? n(usage?.input_tokens);
  const output = n(usage?.completion_tokens) ?? n(usage?.output_tokens);
  const cost = n(usage?.cost);
  return {
    source: 'openrouter-response',
    provenance: usage ? 'provider_measured' : 'unavailable',
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: n(promptDetails.cached_tokens),
    cacheWriteTokens: n(promptDetails.cache_write_tokens),
    reasoningTokens: n(completionDetails.reasoning_tokens),
    totalTokens: n(usage?.total_tokens) ?? (input !== null && output !== null ? input + output : null),
    actualCostUsd: cost,
    costProvenance: cost !== null ? 'provider_measured' : 'unavailable',
    providerRequestId: typeof body?.id === 'string' ? body.id : null,
    upstreamProvider: typeof body?.provider === 'string' ? body.provider : null,
    resolvedModelId: typeof body?.model === 'string' ? body.model : null,
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export async function openRouterChat(args: {
  key: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<{ body: Record<string, unknown>; observation: UsageObservation; latencyMs: number }> {
  const started = Date.now();
  const body = await request<Record<string, unknown>>(
    args.fetchImpl ?? fetch,
    '/api/v1/chat/completions',
    args.key,
    {
      method: 'POST',
      body: JSON.stringify(args.body),
      signal: args.signal,
      timeoutMs: 10 * 60_000,
    },
  );
  return { body, observation: usageObservationFrom(body), latencyMs: Date.now() - started };
}

export interface JevQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export async function openRouterDecision(args: {
  key: string;
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  signal: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<{ body: Record<string, unknown>; observation: UsageObservation; latencyMs: number }> {
  const started = Date.now();
  const body = await request<Record<string, unknown>>(
    args.fetchImpl ?? fetch,
    '/api/alpha/decisions',
    args.key,
    {
      method: 'POST',
      body: JSON.stringify({ model: args.model, state: args.state, questions: args.questions }),
      signal: args.signal,
      timeoutMs: 120_000,
    },
  );
  return {
    body,
    observation: { ...usageObservationFrom(body), source: 'openrouter-decisions-response' },
    latencyMs: Date.now() - started,
  };
}

export interface MeterHandle {
  usageEventId: string;
  reservationId: string | null;
}

/**
 * Per-request metering supplied by the run engine. `begin` reserves budget atomically and creates
 * the canonical usage event (throwing if billing policy or a hard cap blocks the request);
 * `complete`/`fail` reconcile or release it.
 */
export interface MeteringHooks {
  begin(args: {
    estimateUsd: number | null;
    estimatedInputTokens: number;
    estimatedOutputTokens: number | null;
    label: string;
  }): Promise<MeterHandle>;
  complete(handle: MeterHandle, observation: UsageObservation): void;
  fail(handle: MeterHandle, message: string, observation?: UsageObservation): void;
}

export const OPENROUTER_DEFAULT_MAX_OUTPUT = 8_192;
const MAX_AGENT_TURNS = 16;

export function boundedMaxOutput(
  model: ModelOption | undefined,
  nativeSettings?: Record<string, string | number | boolean | null>,
): number | null {
  const configured =
    typeof nativeSettings?.maxOutputTokens === 'number' ? nativeSettings.maxOutputTokens : null;
  if (!model?.supportsMaxOutput || !model.maxOutputRange) return null;
  return Math.min(configured ?? OPENROUTER_DEFAULT_MAX_OUTPUT, model.maxOutputRange.max);
}

export async function runOpenRouterAgent(args: {
  key: string;
  model: ModelOption | undefined;
  modelId: string;
  prompt: string;
  readOnly: boolean;
  reasoning?: string;
  nativeSettings?: Record<string, string | number | boolean | null>;
  signal: AbortSignal;
  onLog: (line: string) => void;
  metering: MeteringHooks;
  brokerTool?: (name: string, input: Record<string, unknown>) => Promise<{ result?: string; error?: string }>;
  fetchImpl?: FetchLike;
}): Promise<{
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usageProvenance: 'provider_reported' | 'unavailable';
  exitCode: number;
  stdout: string;
  usageRecorded: true;
}> {
  const { BROKER_TOOL_DEFINITIONS, READ_ONLY_BROKER_TOOLS } = await import('./brokerTools.js');
  const tools =
    args.model?.supportsTools && args.brokerTool
      ? BROKER_TOOL_DEFINITIONS.filter((tool) => !args.readOnly || READ_ONLY_BROKER_TOOLS.has(tool.name)).map(
          (tool) => ({
            type: 'function' as const,
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          }),
        )
      : [];
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a stage inside Turing Terminal. Project access is available only through the provided Turing tools, which enforce project scope and approvals. Never request credentials.',
    },
    { role: 'user', content: args.prompt },
  ];
  const maxOutput = boundedMaxOutput(args.model, args.nativeSettings);
  const maxPrice = maxPriceFor(args.model);
  let inputTokens = 0;
  let outputTokens = 0;
  let allReported = true;
  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn += 1) {
    if (args.signal.aborted) throw new Error('Stage was cancelled before the provider started.');
    const body: Record<string, unknown> = {
      model: args.modelId,
      messages,
      ...(maxOutput ? { max_tokens: maxOutput } : {}),
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(args.reasoning || typeof args.nativeSettings?.reasoningMaxTokens === 'number'
        ? {
            reasoning: {
              ...(args.reasoning ? { effort: args.reasoning } : {}),
              ...(typeof args.nativeSettings?.reasoningMaxTokens === 'number'
                ? { max_tokens: args.nativeSettings.reasoningMaxTokens }
                : {}),
            },
          }
        : {}),
      ...(typeof args.nativeSettings?.temperature === 'number'
        ? { temperature: args.nativeSettings.temperature }
        : {}),
      // Hard per-token price ceiling: OpenRouter will not route to an upstream priced above the reservation basis.
      ...(maxPrice ? { provider: { max_price: maxPrice } } : {}),
    };
    const estimatedInputTokens = estimateTokensConservatively(JSON.stringify({ messages, tools }));
    const handle = await args.metering.begin({
      estimateUsd: estimateReservationUsd(args.model, estimatedInputTokens, maxOutput),
      estimatedInputTokens,
      estimatedOutputTokens: maxOutput,
      label: `OpenRouter turn ${turn}`,
    });
    let response: Awaited<ReturnType<typeof openRouterChat>>;
    try {
      response = await openRouterChat({
        key: args.key,
        body,
        signal: args.signal,
        fetchImpl: args.fetchImpl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.metering.fail(handle, message);
      throw error instanceof Error ? error : new Error(message);
    }
    const choice = (Array.isArray(response.body.choices) ? response.body.choices[0] : null) as {
      message?: ChatMessage;
      finish_reason?: string;
    } | null;
    args.metering.complete(handle, {
      ...response.observation,
      status: 'succeeded',
      finishReason: choice?.finish_reason ?? null,
      latencyMs: response.latencyMs,
      durationMs: response.latencyMs,
    });
    if (response.observation.inputTokens === null || response.observation.outputTokens === null)
      allReported = false;
    inputTokens += response.observation.inputTokens ?? 0;
    outputTokens += response.observation.outputTokens ?? 0;
    const message = choice?.message;
    if (!message) throw new Error('OpenRouter returned no completion choice.');
    const calls = message.tool_calls ?? [];
    if (!calls.length || !args.brokerTool) {
      const text = redactSecrets(typeof message.content === 'string' ? message.content : '');
      return {
        text,
        inputTokens: allReported ? inputTokens : null,
        outputTokens: allReported ? outputTokens : null,
        usageProvenance: allReported ? 'provider_reported' : 'unavailable',
        exitCode: 0,
        stdout: '',
        usageRecorded: true,
      };
    }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          input = parsed as Record<string, unknown>;
      } catch {
        input = {};
      }
      const allowed = tools.some((tool) => tool.function.name === call.function.name);
      const outcome = allowed
        ? await args.brokerTool(call.function.name, input)
        : { error: 'The requested tool is not exposed to this stage by the Turing broker.' };
      args.onLog(`tool ${call.function.name}: ${outcome.error ? 'denied/failed' : 'completed'}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.error ? `Error: ${outcome.error}` : (outcome.result ?? ''),
      });
    }
  }
  throw new Error(`OpenRouter stage exceeded the ${MAX_AGENT_TURNS}-turn tool limit.`);
}
