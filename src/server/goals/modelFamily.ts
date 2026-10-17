/**
 * Version-controlled model-family normalisation (design Q7). Pure and offline: nothing here calls a model or an API.
 * Everything unrecognised stays unknown, and unknown identity can only make independence harder to claim.
 */

/** Vendor/route namespaces that prefix a model id without being part of the model's identity. */
const PROVIDER_PREFIXES: readonly string[] = [
  // Aggregator and CLI backends Turing supports.
  'openrouter',
  'opencode',
  'opencode-go',
  'cline',
  'cline-pass',
  // Provider namespaces Turing's adapters expose.
  'openai',
  'openai-codex',
  'anthropic',
  'anthropic-subscription',
  'google',
  'deepseek',
  'moonshotai',
  'qwen',
  'z-ai',
  'x-ai',
  'meta-llama',
  'mistralai',
  'minimax',
];

/** Routing suffixes OpenRouter documents as selecting a provider route, not a different model. */
const ROUTE_SUFFIXES: readonly string[] = [':free', ':nitro', ':floor'];

/**
 * Family patterns, first match wins. Each is justified by the vendor's own model naming, not by similarity:
 * the family is the vendor lineage a reviewer would be "the same author" as.
 */
const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Claude Code documents these bare names as Claude model aliases.
  [/^(opus|sonnet|haiku|opusplan|best|default)(\[.*\])?$/, 'anthropic-claude'],
  [/^claude(-|$)/, 'anthropic-claude'],
  // gpt-oss is an open-weights release, a different lineage from the hosted GPT line.
  [/^gpt-oss/, 'openai-gpt-oss'],
  // OpenAI's o-series reasoning models and the Codex models belong to the GPT line.
  [/^(gpt|chatgpt|codex)(-|$)|^o[1-9](-|$)/, 'openai-gpt'],
  [/^gemini(-|$)/, 'google-gemini'],
  [/^gemma(-|$)/, 'google-gemma'],
  [/^glm(-|$)/, 'zhipu-glm'],
  [/^kimi(-|$)/, 'moonshot-kimi'],
  [/^qwen/, 'alibaba-qwen'],
  [/^deepseek/, 'deepseek'],
  [/^grok/, 'xai-grok'],
  [/^llama/, 'meta-llama'],
  [/^(mistral|codestral|devstral|magistral)/, 'mistral'],
  [/^minimax/, 'minimax'],
];

/**
 * The model key: lower-cased, with at most two known provider namespaces and any routing suffix removed.
 * The configured variant is a separate field and never part of the key. Unknown ids are otherwise untouched.
 */
export function normalizeModelKey(modelId: string | null | undefined): string | null {
  let key = (modelId ?? '').trim().toLowerCase();
  if (!key) return null;
  for (const suffix of ROUTE_SUFFIXES) if (key.endsWith(suffix)) key = key.slice(0, -suffix.length);
  for (let pass = 0; pass < 2; pass += 1) {
    const slash = key.indexOf('/');
    if (slash <= 0) break;
    if (!PROVIDER_PREFIXES.includes(key.slice(0, slash))) break;
    key = key.slice(slash + 1);
  }
  // Anthropic publishes `claude-sonnet-4-5`; OpenRouter spells the same model `claude-sonnet-4.5`.
  if (key.startsWith('claude-')) key = key.replace(/(\d)\.(\d)/g, '$1-$2');
  return key || null;
}

/** The family of a normalised model key, or null when no explicit pattern recognises it. */
export function familyKeyOf(modelKey: string | null): string | null {
  if (!modelKey) return null;
  for (const [pattern, family] of FAMILY_PATTERNS) if (pattern.test(modelKey)) return family;
  return null;
}

export interface ModelLineage {
  configuredKey: string | null;
  /** From canonical usage telemetry (`resolved_model_id`), when the route actually ran. */
  resolvedKey: string | null;
  familyKey: string | null;
}

export function lineageOf(
  configuredModelId: string | null | undefined,
  resolvedModelId?: string | null,
): ModelLineage {
  const configuredKey = normalizeModelKey(configuredModelId);
  const resolvedKey = normalizeModelKey(resolvedModelId);
  return { configuredKey, resolvedKey, familyKey: familyKeyOf(resolvedKey ?? configuredKey) };
}
