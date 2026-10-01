import { describe, expect, it } from 'vitest';
import { calculateQuotaForecast } from './quotaForecast.js';

const now = Date.parse('2026-10-08T12:00:00.000Z');

describe('manual quota envelopes', () => {
  it('calculates remaining allowance, daily burn, exhaustion date, reset likelihood, and provenance', () => {
    const samples = Array.from({ length: 10 }, (_, index) => ({
      occurredAt: `2026-10-0${(index % 7) + 1}T12:00:00.000Z`,
      inputTokens: 1_000,
      outputTokens: 1_000,
      durationMs: 60_000,
      requestCount: 1,
      provenance: 'provider_reported',
    }));
    const forecast = calculateQuotaForecast({
      allowance: 26_000,
      unit: 'total_tokens',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      resetAt: '2026-10-12T00:00:00.000Z',
      samples,
      now,
    });
    expect(forecast.provenance).toBe('user_configured');
    expect(forecast.usageProvenance).toBe('provider_measured');
    expect(forecast.observedUsed).toBe(20_000);
    expect(forecast.remaining).toBe(6_000);
    expect(forecast.projectedExhaustionAt).toBe('2026-10-10T18:00:00.000Z');
    expect(forecast.likelyBeforeReset).toBe(true);
    expect(forecast.confidence).toBe('high');
  });

  it('excludes observations outside the configured reset window and reports incomplete token data', () => {
    const forecast = calculateQuotaForecast({
      allowance: 100,
      unit: 'input_tokens',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      resetAt: '2026-10-12T00:00:00.000Z',
      samples: [
        {
          occurredAt: '2026-09-30T12:00:00.000Z',
          inputTokens: 80,
          outputTokens: 20,
          durationMs: 0,
          requestCount: 1,
          provenance: 'provider_reported',
        },
        {
          occurredAt: '2026-10-05T12:00:00.000Z',
          inputTokens: null,
          outputTokens: null,
          durationMs: 0,
          requestCount: 1,
          provenance: 'unavailable',
        },
      ],
      now,
    });
    expect(forecast.sampleCount).toBe(1);
    expect(forecast.missingSampleCount).toBe(1);
    expect(forecast.observedUsed).toBeNull();
    expect(forecast.confidence).toBe('unavailable');
  });

  it('marks a past reset as expired and keeps local request counts distinguishable', () => {
    const forecast = calculateQuotaForecast({
      allowance: 20,
      unit: 'requests',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      resetAt: '2026-10-07T00:00:00.000Z',
      samples: [],
      now,
    });
    expect(forecast.expired).toBe(true);
    expect(forecast.observedUsed).toBeNull();
    expect(forecast.usageProvenance).toBe('unavailable');
  });
});
