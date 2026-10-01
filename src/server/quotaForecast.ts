export type QuotaUnit = 'input_tokens' | 'output_tokens' | 'total_tokens' | 'requests' | 'minutes';

export interface QuotaUsageSample {
  occurredAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  requestCount: number;
  provenance: string;
}

export interface QuotaForecast {
  provenance: 'user_configured';
  usageProvenance: 'provider_measured' | 'locally_measured' | 'unavailable';
  observedUsed: number | null;
  remaining: number | null;
  averagePerDay: number | null;
  projectedExhaustionAt: string | null;
  likelyBeforeReset: boolean | null;
  confidence: 'high' | 'medium' | 'low' | 'unavailable';
  sampleCount: number;
  missingSampleCount: number;
  expired: boolean;
}

export function calculateQuotaForecast(args: {
  allowance: number;
  unit: QuotaUnit;
  effectiveAt: string;
  resetAt: string;
  samples: QuotaUsageSample[];
  now?: number;
}): QuotaForecast {
  const now = args.now ?? Date.now();
  const effectiveAt = Date.parse(args.effectiveAt);
  const resetAt = Date.parse(args.resetAt);
  const expired = !Number.isFinite(resetAt) || resetAt <= now;
  const eligible = args.samples.filter((sample) => {
    const time = Date.parse(sample.occurredAt);
    return Number.isFinite(time) && time >= effectiveAt && time <= now && time < resetAt;
  });
  let missingSampleCount = 0;
  let consumed = 0;
  let hasProviderMeasured = false;
  let hasLocalMeasured = false;
  for (const sample of eligible) {
    if (sample.provenance === 'provider_reported' || sample.provenance === 'provider_measured')
      hasProviderMeasured = true;
    else hasLocalMeasured = true;
    const value = sampleValue(sample, args.unit);
    if (value === null || !Number.isFinite(value)) missingSampleCount += 1;
    else consumed += value;
  }
  const needsCompleteUsage =
    args.unit === 'input_tokens' || args.unit === 'output_tokens' || args.unit === 'total_tokens';
  const unavailable =
    expired || !Number.isFinite(effectiveAt) || (needsCompleteUsage && missingSampleCount > 0);
  const observedUsed = unavailable ? null : consumed;
  const remaining = observedUsed === null ? null : Math.max(0, args.allowance - observedUsed);
  const elapsedDays = Math.max(0, (now - effectiveAt) / 86_400_000);
  const averagePerDay = observedUsed === null || elapsedDays <= 0 ? null : observedUsed / elapsedDays;
  const projectedMs =
    remaining === null || averagePerDay === null || averagePerDay <= 0
      ? null
      : now + (remaining / averagePerDay) * 86_400_000;
  const projectedExhaustionAt = projectedMs === null ? null : new Date(projectedMs).toISOString();
  const likelyBeforeReset = projectedMs === null || !Number.isFinite(resetAt) ? null : projectedMs < resetAt;
  const confidence = unavailable
    ? 'unavailable'
    : eligible.length >= 10 && elapsedDays >= 3 && missingSampleCount === 0
      ? 'high'
      : eligible.length >= 3 && elapsedDays >= 1 && missingSampleCount === 0
        ? 'medium'
        : 'low';
  return {
    provenance: 'user_configured',
    usageProvenance: unavailable
      ? 'unavailable'
      : hasProviderMeasured && !hasLocalMeasured
        ? 'provider_measured'
        : 'locally_measured',
    observedUsed,
    remaining,
    averagePerDay,
    projectedExhaustionAt,
    likelyBeforeReset,
    confidence,
    sampleCount: eligible.length,
    missingSampleCount,
    expired,
  };
}

function sampleValue(sample: QuotaUsageSample, unit: QuotaUnit): number | null {
  if (unit === 'input_tokens') return sample.inputTokens;
  if (unit === 'output_tokens') return sample.outputTokens;
  if (unit === 'total_tokens')
    return sample.inputTokens === null || sample.outputTokens === null
      ? null
      : sample.inputTokens + sample.outputTokens;
  if (unit === 'requests') return sample.requestCount;
  return sample.durationMs / 60_000;
}
