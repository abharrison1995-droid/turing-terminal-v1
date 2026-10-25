import { z } from 'zod';
import type {
  ModelPricingEvidence,
  ModelPricingSnapshot,
  PriceEvidence,
  PricingOverrideFieldEvidence,
} from './types.js';

export const PRICING_OVERRIDE_EVIDENCE_CAP = 16;
export const PRICING_EVIDENCE_MAX_BYTES = 1_536;

const priceEvidenceSchema = z.strictObject({
  present: z.boolean(),
  valid: z.boolean(),
  value: z.number().finite().nonnegative().nullable(),
});

const overrideFieldSchema = z.strictObject({
  present: z.boolean(),
  validCount: z.number().int().min(0).max(PRICING_OVERRIDE_EVIDENCE_CAP),
  invalidCount: z.number().int().min(0).max(PRICING_OVERRIDE_EVIDENCE_CAP),
  maxValidValue: z.number().finite().nonnegative().nullable(),
  allValidEqualBase: z.boolean().nullable(),
  complete: z.boolean(),
});

export const modelPricingEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  base: z.strictObject({
    prompt: priceEvidenceSchema,
    completion: priceEvidenceSchema,
    request: priceEvidenceSchema,
    cacheRead: priceEvidenceSchema,
  }),
  overrides: z.strictObject({
    count: z.number().int().min(0).max(PRICING_OVERRIDE_EVIDENCE_CAP),
    complete: z.boolean(),
    overflow: z.boolean(),
    prompt: overrideFieldSchema,
    completion: overrideFieldSchema,
    request: overrideFieldSchema,
    cacheRead: overrideFieldSchema,
  }),
});

type PriceField = keyof ModelPricingEvidence['base'];
type RawPriceFields = Partial<Record<PriceField, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parsePrice(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function basePriceEvidence(base: RawPriceFields, field: PriceField): PriceEvidence {
  const present = Object.prototype.hasOwnProperty.call(base, field);
  if (!present) return { present: false, valid: false, value: null };
  const value = parsePrice(base[field]);
  return value === null
    ? { present: true, valid: false, value: null }
    : { present: true, valid: true, value };
}

/**
 * Creates a constant-size summary of raw catalog price inputs. Raw override rows are never returned or retained.
 * More than the cap, or a malformed override list/row, makes the aggregate incomplete and therefore unusable for a
 * free-price claim or bounded reservation.
 */
export function buildModelPricingEvidence(
  baseInput: RawPriceFields,
  rawOverrides?: unknown,
): ModelPricingEvidence {
  const fields: readonly PriceField[] = ['prompt', 'completion', 'request', 'cacheRead'];
  const base = Object.fromEntries(
    fields.map((field) => [field, basePriceEvidence(baseInput, field)]),
  ) as ModelPricingEvidence['base'];
  const hasOverrides = rawOverrides !== undefined;
  const validArray = !hasOverrides || Array.isArray(rawOverrides);
  const rows = Array.isArray(rawOverrides) ? rawOverrides : [];
  const count = Math.min(rows.length, PRICING_OVERRIDE_EVIDENCE_CAP);
  const overflow = rows.length > PRICING_OVERRIDE_EVIDENCE_CAP;
  const scanned = rows.slice(0, PRICING_OVERRIDE_EVIDENCE_CAP);
  const rowsWellFormed = scanned.every(isRecord);
  const aggregateComplete = validArray && rowsWellFormed && !overflow;

  const overrides = Object.fromEntries(
    fields.map((field) => {
      let present = false;
      let validCount = 0;
      let invalidCount = 0;
      let maxValidValue: number | null = null;
      let anyDiffersFromBase = false;
      const baseValue = base[field].valid ? base[field].value : null;

      for (const row of scanned) {
        if (!isRecord(row) || !Object.prototype.hasOwnProperty.call(row, field)) continue;
        present = true;
        const value = parsePrice(row[field]);
        if (value === null) {
          invalidCount = Math.min(PRICING_OVERRIDE_EVIDENCE_CAP, invalidCount + 1);
          continue;
        }
        validCount = Math.min(PRICING_OVERRIDE_EVIDENCE_CAP, validCount + 1);
        maxValidValue = maxValidValue === null ? value : Math.max(maxValidValue, value);
        if (baseValue === null || value !== baseValue) anyDiffersFromBase = true;
      }

      const equality =
        !aggregateComplete || !present || validCount === 0 || baseValue === null
          ? null
          : anyDiffersFromBase
            ? false
            : invalidCount > 0
              ? null
              : true;
      return [
        field,
        {
          present,
          validCount,
          invalidCount,
          maxValidValue: aggregateComplete ? maxValidValue : null,
          allValidEqualBase: equality,
          complete: aggregateComplete,
        } satisfies PricingOverrideFieldEvidence,
      ];
    }),
  ) as Record<PriceField, PricingOverrideFieldEvidence>;

  const overridesEvidence: ModelPricingEvidence['overrides'] = {
    count,
    complete: aggregateComplete,
    overflow,
    ...overrides,
  };
  const evidence: ModelPricingEvidence = {
    schemaVersion: 1,
    base,
    overrides: overridesEvidence,
  };
  return evidenceWithinBound(evidence) ? evidence : incompleteEvidence(evidence);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function evidenceWithinBound(evidence: ModelPricingEvidence): boolean {
  return new TextEncoder().encode(canonicalJson(evidence)).byteLength <= PRICING_EVIDENCE_MAX_BYTES;
}

function incompleteEvidence(evidence: ModelPricingEvidence): ModelPricingEvidence {
  const fields: readonly PriceField[] = ['prompt', 'completion', 'request', 'cacheRead'];
  return {
    ...evidence,
    overrides: {
      ...evidence.overrides,
      complete: false,
      [fields[0]]: {
        ...evidence.overrides.prompt,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: false,
      },
      [fields[1]]: {
        ...evidence.overrides.completion,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: false,
      },
      [fields[2]]: {
        ...evidence.overrides.request,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: false,
      },
      [fields[3]]: {
        ...evidence.overrides.cacheRead,
        maxValidValue: null,
        allValidEqualBase: null,
        complete: false,
      },
    },
  };
}

type OpportunityCostClass = 'free' | 'metered' | 'unknown';
type EffectivePrices = Record<PriceField, number | null>;

function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function effectivePrices(evidence: ModelPricingEvidence): EffectivePrices {
  const parsed = modelPricingEvidenceSchema.safeParse(evidence);
  if (!parsed.success || !parsed.data.overrides.complete) {
    return { prompt: null, completion: null, request: null, cacheRead: null };
  }
  const prices = {} as EffectivePrices;
  for (const field of ['prompt', 'completion', 'request', 'cacheRead'] as const) {
    const base = parsed.data.base[field];
    const overrides = parsed.data.overrides[field];
    const baseValue = base.valid ? base.value : null;
    const overrideValue = overrides.complete ? overrides.maxValidValue : null;
    if (!baseValue && baseValue !== 0 && !overrides.present) {
      prices[field] = null;
      continue;
    }
    // An invalid override may hide a higher effective rate. Keep known positives useful for
    // classification, but never use an incomplete field to claim a bounded reservation.
    if (overrides.present && (!overrides.complete || overrides.invalidCount > 0)) {
      prices[field] = null;
      continue;
    }
    if (baseValue === null && overrideValue === null) {
      prices[field] = null;
      continue;
    }
    prices[field] = Math.max(baseValue ?? 0, overrideValue ?? 0);
  }
  return prices;
}

/** Price classification is catalog evidence only; it does not select or authorize a billing lane. */
export function classifyOpportunityCost(pricing: ModelPricingSnapshot | undefined): OpportunityCostClass {
  if (!pricing) return 'unknown';
  const legacyKnown = [
    pricing.promptUsdPerToken,
    pricing.completionUsdPerToken,
    pricing.requestUsd,
    pricing.cacheReadUsdPerToken,
    pricing.maxPromptUsdPerToken,
    pricing.maxCompletionUsdPerToken,
  ].map(finiteNonnegative);
  if (legacyKnown.some((value) => value !== null && value > 0)) return 'metered';

  const parsed = modelPricingEvidenceSchema.safeParse(pricing.pricingEvidence);
  if (!parsed.success) return 'unknown';
  const evidence = parsed.data;
  const knownPositive = [
    evidence.base.prompt,
    evidence.base.completion,
    evidence.base.request,
    evidence.base.cacheRead,
  ].some((price) => price.valid && price.value !== null && price.value > 0);
  const knownPositiveOverride = [
    evidence.overrides.prompt,
    evidence.overrides.completion,
    evidence.overrides.request,
    evidence.overrides.cacheRead,
  ].some((field) => field.maxValidValue !== null && field.maxValidValue > 0);
  if (knownPositive || knownPositiveOverride) return 'metered';
  const effective = effectivePrices(parsed.data);
  if (Object.values(effective).some((value) => value !== null && value > 0)) return 'metered';
  return Object.values(effective).every((value) => value === 0) ? 'free' : 'unknown';
}

/** Conservative MOP-only reservation. The Decision Layer's legacy estimator intentionally remains unchanged. */
export function estimateOpportunityReservationUsd(
  pricing: ModelPricingSnapshot | undefined,
  inputTokens: number,
  maxOutputTokens: number | null,
): number | null {
  if (!pricing || !Number.isFinite(inputTokens) || inputTokens < 0) return null;
  const parsed = modelPricingEvidenceSchema.safeParse(pricing.pricingEvidence);
  if (!parsed.success) return null;
  const effective = effectivePrices(parsed.data);
  const prompt = effective.prompt;
  const completion = effective.completion;
  const request = effective.request;
  const cacheRead = effective.cacheRead;
  if (prompt === null || completion === null || request === null || cacheRead === null) return null;
  if (
    completion > 0 &&
    (maxOutputTokens === null || !Number.isFinite(maxOutputTokens) || maxOutputTokens < 0)
  )
    return null;
  const output = completion > 0 ? (maxOutputTokens ?? 0) : 0;
  const inputRate = Math.max(prompt, cacheRead);
  const estimate = Math.ceil(inputTokens * 1.1) * inputRate + output * completion + request;
  if (!Number.isFinite(estimate) || estimate < 0) return null;
  if (estimate === 0 && classifyOpportunityCost(pricing) !== 'free') return null;
  return estimate;
}
