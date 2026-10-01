import { describe, expect, it } from 'vitest';
import { estimateApiEquivalent } from './pricing.js';

describe('maintained API pricing metadata', () => {
  it('estimates only an exact priced model and returns the source metadata', () => {
    const estimate = estimateApiEquivalent({
      providerId: 'openai-codex',
      modelId: 'gpt-6-luna',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(estimate?.amount).toBeCloseTo(0.15);
    expect(estimate?.currency).toBe('USD');
    expect(estimate?.cachedInputAssumedZero).toBe(true);
    expect(estimate?.pricing.effectiveDate).toBe('2026-10-01');
    expect(estimate?.pricing.source).toMatch(/^https:\/\//);
  });

  it('accounts for known cached input and leaves aliases or token gaps unavailable', () => {
    const cached = estimateApiEquivalent({
      providerId: 'anthropic-subscription',
      modelId: 'claude-sonnet-5-5',
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 100_000,
    });
    expect(cached?.amount).toBeCloseTo(2.1);
    expect(cached?.cachedInputAssumedZero).toBe(false);
    expect(
      estimateApiEquivalent({
        providerId: 'anthropic-subscription',
        modelId: 'sonnet',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toBeNull();
    expect(
      estimateApiEquivalent({
        providerId: 'openai-codex',
        modelId: 'gpt-6-luna',
        inputTokens: null,
        outputTokens: 1,
      }),
    ).toBeNull();
  });

  it('prices the exact Claude Haiku snapshot used by the live provider validation', () => {
    const estimate = estimateApiEquivalent({
      providerId: 'anthropic-subscription',
      modelId: 'claude-haiku-4-5-20251001',
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 200_000,
    });
    expect(estimate?.amount).toBeCloseTo(2.1);
    expect(estimate?.pricing.source).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
  });
});
