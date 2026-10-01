export interface ModelPricing {
  providerId: string;
  modelId: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
  effectiveDate: string;
  source: string;
  currency: 'USD';
}

const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';
const ANTHROPIC_PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

// Rates are public standard API rates per 1M text tokens, checked 2026-10-01.
// Keep exact model IDs only; subscription aliases and unknown models deliberately remain unpriced.
export const MODEL_PRICING: readonly ModelPricing[] = [
  {
    providerId: 'openai-codex',
    modelId: 'gpt-6-luna',
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.01,
    outputUsdPerMillion: 0.5,
    effectiveDate: '2026-10-01',
    source: OPENAI_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-6.1-sol',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
    effectiveDate: '2026-10-01',
    source: OPENAI_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-6-astra',
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 50,
    effectiveDate: '2026-10-01',
    source: OPENAI_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-5.6-sol',
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
    effectiveDate: '2026-10-01',
    source: OPENAI_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'openai-codex',
    modelId: 'gpt-5.3-codex',
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14,
    effectiveDate: '2026-10-01',
    source: OPENAI_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'anthropic-subscription',
    modelId: 'claude-opus-5-5',
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 20,
    effectiveDate: '2026-10-01',
    source: ANTHROPIC_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'anthropic-subscription',
    modelId: 'claude-sonnet-5-5',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
    effectiveDate: '2026-10-01',
    source: ANTHROPIC_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'anthropic-subscription',
    modelId: 'claude-haiku-4-5-20251001',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
    effectiveDate: '2026-10-01',
    source: ANTHROPIC_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'anthropic-subscription',
    modelId: 'claude-opus-5',
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    effectiveDate: '2026-10-01',
    source: ANTHROPIC_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'anthropic-subscription',
    modelId: 'claude-sonnet-5',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
    effectiveDate: '2026-10-01',
    source: ANTHROPIC_PRICING_SOURCE,
    currency: 'USD',
  },
  {
    providerId: 'anthropic-subscription',
    modelId: 'claude-sonnet-4-6',
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    effectiveDate: '2026-10-01',
    source: ANTHROPIC_PRICING_SOURCE,
    currency: 'USD',
  },
];

export function estimateApiEquivalent(args: {
  providerId: string | null;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
}): { amount: number; currency: 'USD'; pricing: ModelPricing; cachedInputAssumedZero: boolean } | null {
  if (
    args.providerId === null ||
    args.modelId === null ||
    args.inputTokens === null ||
    args.outputTokens === null
  )
    return null;
  const pricing = MODEL_PRICING.find(
    (entry) => entry.providerId === args.providerId && entry.modelId === args.modelId,
  );
  if (!pricing) return null;
  const cachedInputTokens = args.cachedInputTokens ?? 0;
  const uncachedInputTokens = Math.max(0, args.inputTokens - cachedInputTokens);
  const cachedInputCost =
    pricing.cachedInputUsdPerMillion === null
      ? 0
      : (cachedInputTokens * pricing.cachedInputUsdPerMillion) / 1_000_000;
  return {
    amount:
      (uncachedInputTokens * pricing.inputUsdPerMillion) / 1_000_000 +
      cachedInputCost +
      (args.outputTokens * pricing.outputUsdPerMillion) / 1_000_000,
    currency: pricing.currency,
    pricing,
    cachedInputAssumedZero: args.cachedInputTokens == null,
  };
}
