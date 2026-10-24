import { describe, expect, it } from 'vitest';
import {
  buildModelPricingEvidence,
  classifyOpportunityCost,
  estimateOpportunityReservationUsd,
  PRICING_EVIDENCE_MAX_BYTES,
  PRICING_OVERRIDE_EVIDENCE_CAP,
} from './opportunityCost.js';
import type { ModelPricingSnapshot } from './types.js';

const base = { prompt: 0, completion: 0, request: 0, cacheRead: 0 };

function snapshot(pricingEvidence: ModelPricingSnapshot['pricingEvidence']): ModelPricingSnapshot {
  return {
    promptUsdPerToken: pricingEvidence?.base.prompt.value ?? null,
    completionUsdPerToken: pricingEvidence?.base.completion.value ?? null,
    requestUsd: pricingEvidence?.base.request.value ?? null,
    cacheReadUsdPerToken: pricingEvidence?.base.cacheRead.value ?? null,
    maxPromptUsdPerToken: pricingEvidence?.base.prompt.value ?? null,
    maxCompletionUsdPerToken: pricingEvidence?.base.completion.value ?? null,
    pricingEvidence,
    source: 'test',
    observedAt: '2026-10-24T00:00:00.000Z',
  };
}

describe('model opportunity price evidence', () => {
  it('records absent override fields as absent and complete', () => {
    const evidence = buildModelPricingEvidence(base, []);
    expect(evidence.overrides).toEqual({
      count: 0,
      complete: true,
      overflow: false,
      prompt: {
        present: false,
        validCount: 0,
        invalidCount: 0,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: true,
      },
      completion: {
        present: false,
        validCount: 0,
        invalidCount: 0,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: true,
      },
      request: {
        present: false,
        validCount: 0,
        invalidCount: 0,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: true,
      },
      cacheRead: {
        present: false,
        validCount: 0,
        invalidCount: 0,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: true,
      },
    });
  });

  it('keeps base-positive pricing when an override is zero and summarizes equal and higher overrides', () => {
    const evidence = buildModelPricingEvidence({ ...base, prompt: 0.001, completion: 0.002 }, [
      { prompt: 0, completion: 0.002 },
      { prompt: 0.001, completion: 0.003 },
    ]);
    expect(evidence.overrides.prompt).toMatchObject({
      present: true,
      validCount: 2,
      invalidCount: 0,
      maxValidValue: 0.001,
      allValidEqualBase: false,
      complete: true,
    });
    expect(evidence.overrides.completion).toMatchObject({
      present: true,
      validCount: 2,
      maxValidValue: 0.003,
      allValidEqualBase: false,
    });
    const equal = buildModelPricingEvidence({ ...base, prompt: 0.001 }, [{ prompt: 0.001 }]);
    expect(equal.overrides.prompt.allValidEqualBase).toBe(true);
  });

  it('records invalid override values without hiding valid base evidence', () => {
    const evidence = buildModelPricingEvidence({ ...base, prompt: 0.001 }, [
      { prompt: -1 },
      { prompt: 'not-a-price' },
      { prompt: 0.002 },
    ]);
    expect(evidence.base.prompt).toEqual({ present: true, valid: true, value: 0.001 });
    expect(evidence.overrides.prompt).toMatchObject({
      present: true,
      validCount: 1,
      invalidCount: 2,
      maxValidValue: 0.002,
      allValidEqualBase: false,
    });
    expect(evidence.overrides.prompt.invalidCount).toBe(2);
  });

  it('caps overflow evidence and keeps the constant-size summary within its byte bound', () => {
    const rows = Array.from({ length: PRICING_OVERRIDE_EVIDENCE_CAP + 4 }, (_, index) => ({
      prompt: index / 10_000,
    }));
    const evidence = buildModelPricingEvidence({ ...base, prompt: 0 }, rows);
    expect(evidence.overrides).toMatchObject({
      count: PRICING_OVERRIDE_EVIDENCE_CAP,
      complete: false,
      overflow: true,
      prompt: {
        present: true,
        validCount: PRICING_OVERRIDE_EVIDENCE_CAP,
        invalidCount: 0,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: false,
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThanOrEqual(
      PRICING_EVIDENCE_MAX_BYTES,
    );
    expect(JSON.stringify(evidence)).not.toContain('overrides":[');
  });

  it('classifies known positives as metered and never calls incomplete or missing evidence free', () => {
    const basePositiveWithZeroOverride = buildModelPricingEvidence({ ...base, prompt: 0.001 }, [
      { prompt: 0 },
    ]);
    expect(classifyOpportunityCost(snapshot(basePositiveWithZeroOverride))).toBe('metered');

    const missingRequest = buildModelPricingEvidence({ prompt: 0, completion: 0, cacheRead: 0 }, []);
    expect(classifyOpportunityCost(snapshot(missingRequest))).toBe('unknown');
    expect(classifyOpportunityCost(undefined)).toBe('unknown');
    expect(classifyOpportunityCost({ ...snapshot(undefined), promptUsdPerToken: 0.0001 })).toBe('metered');

    const allKnownZero = buildModelPricingEvidence(base, []);
    expect(classifyOpportunityCost(snapshot(allKnownZero))).toBe('free');
  });

  it('uses the larger prompt/cache-read rate and requires every applicable price to be known', () => {
    const evidence = buildModelPricingEvidence(
      { prompt: 0.000001, completion: 0.000002, request: 0.0001, cacheRead: 0.000003 },
      [],
    );
    expect(estimateOpportunityReservationUsd(snapshot(evidence), 1_000, 500)).toBeCloseTo(
      1_100 * 0.000003 + 500 * 0.000002 + 0.0001,
    );
    expect(estimateOpportunityReservationUsd(snapshot(evidence), 1_000, null)).toBeNull();
    const missingCacheRead = buildModelPricingEvidence({ prompt: 0, completion: 0, request: 0 }, []);
    expect(estimateOpportunityReservationUsd(snapshot(missingCacheRead), 1_000, 500)).toBeNull();
    const zero = buildModelPricingEvidence(base, []);
    expect(estimateOpportunityReservationUsd(snapshot(zero), 1_000, null)).toBe(0);
  });

  it('does not estimate a reservation when an invalid override could hide a higher rate', () => {
    const evidence = buildModelPricingEvidence({ ...base, prompt: 0.000001 }, [{ prompt: 'not-a-price' }]);
    const pricing = snapshot(evidence);
    expect(classifyOpportunityCost(pricing)).toBe('metered');
    expect(estimateOpportunityReservationUsd(pricing, 1_000, 500)).toBeNull();
  });
});
