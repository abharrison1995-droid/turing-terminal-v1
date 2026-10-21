import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidTimeZone, resolveRange, systemTimeZone, type RangePreset } from '../../shared/timezone.js';
import type { Db } from '../db.js';
import { estimateApiEquivalent } from '../pricing.js';
import { calculateQuotaForecast, type QuotaUnit, type QuotaUsageSample } from '../quotaForecast.js';
import { redactSecrets } from '../security.js';
import {
  exportRows,
  loadUsageEvents,
  queryUsageAnalytics,
  toCsv,
  type UsageFilter,
} from '../usageAnalytics.js';
import type { RouteContext } from './routeUtils.js';

const quotaEnvelopeSchema = z
  .object({
    providerId: z.string().trim().min(1).max(80),
    quotaName: z.string().trim().min(1).max(100),
    windowLabel: z.string().trim().min(1).max(80),
    resetAt: z.string().datetime({ offset: true }),
    effectiveAt: z.string().datetime({ offset: true }),
    allowance: z.number().finite().positive().max(1_000_000_000_000_000),
    unit: z.enum(['input_tokens', 'output_tokens', 'total_tokens', 'requests', 'minutes']),
    notes: z.string().max(1_000).default(''),
    subscriptionCostUsd: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  })
  .refine((value) => Date.parse(value.resetAt) > Date.parse(value.effectiveAt), {
    message: 'The reset date must be later than the effective date.',
  });

/** Usage analytics and export, the activity summary and user-configured quota envelopes. */
export function registerUsageRoutes(app: FastifyInstance, { db }: RouteContext): void {
  app.get('/api/usage/analytics', async (request, reply) => {
    const filter = usageFilterFromQuery(db, request.query as Record<string, string | undefined>);
    if ('error' in filter) return reply.code(400).send({ error: filter.error });
    return queryUsageAnalytics(db, filter);
  });
  app.get('/api/usage/export', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const filter = usageFilterFromQuery(db, query);
    if ('error' in filter) return reply.code(400).send({ error: filter.error });
    const rows = exportRows(loadUsageEvents(db, filter), filter.timeZone);
    const stamp = new Date().toISOString().slice(0, 10);
    if (query.format === 'json') {
      reply.header('content-disposition', `attachment; filename="turing-usage-${stamp}.json"`);
      return {
        exportedAt: new Date().toISOString(),
        filter,
        columns: rows.length ? Object.keys(rows[0]!) : [],
        rows,
      };
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="turing-usage-${stamp}.csv"`);
    return toCsv(rows);
  });

  app.get('/api/usage', async (request) => {
    const { window = '7d' } = request.query as { window?: string };
    const days = window === 'today' ? 1 : window === '30d' ? 30 : 7;
    const start = new Date();
    if (window === 'today') start.setHours(0, 0, 0, 0);
    else start.setTime(Date.now() - days * 86_400_000);
    const since = start.toISOString();
    const events = db
      .prepare(
        `SELECT u.*, s.title AS stage_title FROM usage_events u
        LEFT JOIN stages s ON s.id = u.stage_id
        WHERE u.occurred_at >= ? ORDER BY u.occurred_at DESC LIMIT 5000`,
      )
      .all(since) as Array<Record<string, unknown>>;
    const providers = groupUsage(events, 'provider_id');
    const models = groupUsage(events, 'model_id');
    const projects = db
      .prepare(
        `SELECT p.name, COUNT(u.id) AS events, COALESCE(SUM(u.duration_ms),0) AS duration_ms
      FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id WHERE u.occurred_at >= ? GROUP BY u.project_id ORDER BY events DESC`,
      )
      .all(since);
    const daily = db
      .prepare(
        `SELECT date(occurred_at) AS day, COUNT(*) AS events, COALESCE(SUM(duration_ms),0) AS duration_ms,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM usage_events WHERE occurred_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(since);
    return {
      window,
      days,
      since,
      provenance:
        'Locally measured activity; subscription allowance and reset telemetry unavailable unless directly reported.',
      quotas: listQuotaEnvelopes(db),
      providers,
      models,
      projects,
      daily,
      eventCount: events.length,
      raw: events,
    };
  });

  app.get('/api/usage/quotas', async () => ({ quotas: listQuotaEnvelopes(db) }));
  app.post('/api/usage/quotas', async (request, reply) => {
    const parsed = quotaEnvelopeSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid quota envelope.' });
    const value = parsed.data;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO quota_envelopes (id, provider_id, quota_name, window_label, reset_at, allowance, unit, notes,
       effective_at, subscription_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET quota_name = excluded.quota_name,
       window_label = excluded.window_label, reset_at = excluded.reset_at, allowance = excluded.allowance,
       unit = excluded.unit, notes = excluded.notes, effective_at = excluded.effective_at,
       subscription_cost_usd = excluded.subscription_cost_usd, updated_at = excluded.updated_at`,
    ).run(
      randomUUID(),
      value.providerId,
      value.quotaName,
      value.windowLabel,
      new Date(value.resetAt).toISOString(),
      value.allowance,
      value.unit,
      redactSecrets(value.notes).slice(0, 1_000),
      new Date(value.effectiveAt).toISOString(),
      value.subscriptionCostUsd,
      now,
      now,
    );
    const saved = db
      .prepare('SELECT id FROM quota_envelopes WHERE provider_id = ?')
      .get(value.providerId) as {
      id: string;
    };
    return reply.code(201).send({ quota: listQuotaEnvelopes(db).find((item) => item.id === saved.id) });
  });
  app.delete('/api/usage/quotas/:id', async (request, reply) => {
    const result = db
      .prepare('DELETE FROM quota_envelopes WHERE id = ?')
      .run((request.params as { id: string }).id);
    if (!result.changes) return reply.code(404).send({ error: 'Quota envelope was not found.' });
    return { deleted: true };
  });
}

export function usageFilterFromQuery(
  db: Db,
  query: Record<string, string | undefined>,
): UsageFilter | { error: string } {
  const timeZone = query.tz && isValidTimeZone(query.tz) ? query.tz : systemTimeZone();
  const preset = (['today', 'yesterday', '7d', '30d', 'month', 'custom', 'period'] as const).includes(
    query.range as 'today',
  )
    ? (query.range as RangePreset | 'period')
    : '7d';
  let range: { from: string; to: string };
  if (preset === 'period') {
    // Current billing/reset period from a user-configured quota envelope.
    const quota = query.quotaId
      ? (db.prepare('SELECT effective_at, reset_at FROM quota_envelopes WHERE id = ?').get(query.quotaId) as
          { effective_at: string; reset_at: string } | undefined)
      : undefined;
    if (!quota) return { error: 'Choose a configured quota envelope for the billing-period view.' };
    range = { from: quota.effective_at, to: quota.reset_at };
  } else range = resolveRange({ preset, timeZone, fromDay: query.from, toDay: query.to });
  const pick = (key: string) => (query[key] && query[key]!.length <= 200 ? query[key] : undefined);
  // A Goal filter that cannot be honoured must never widen to all usage.
  if (query.goalId !== undefined && (!query.goalId || query.goalId.length > 200))
    return { error: 'The Goal filter must be a Goal id of at most 200 characters.' };
  return {
    ...range,
    timeZone,
    billingLane: pick('billingLane'),
    providerId: pick('providerId'),
    connectionProfileId: pick('connectionProfileId'),
    modelId: pick('modelId'),
    projectId: pick('projectId'),
    workflowId: pick('workflowId'),
    role: pick('role'),
    machineId: pick('machineId'),
    workloadType: pick('workloadType'),
    reasoning: pick('reasoning'),
    runId: pick('runId'),
    goalId: pick('goalId'),
  };
}

function groupUsage(events: Array<Record<string, unknown>>, field: string) {
  const grouped = new Map<
    string,
    {
      key: string;
      events: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      tokenEvents: number;
      usageSamples: number;
      estimatedCostUsd: number;
      pricedEvents: number;
      priceSources: Set<string>;
      effectiveDates: Set<string>;
      cachedInputAssumedZero: boolean;
    }
  >();
  for (const event of events) {
    const key = typeof event[field] === 'string' ? String(event[field]) : 'unavailable';
    const current = grouped.get(key) ?? {
      key,
      events: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokenEvents: 0,
      usageSamples: 0,
      estimatedCostUsd: 0,
      pricedEvents: 0,
      priceSources: new Set(),
      effectiveDates: new Set(),
      cachedInputAssumedZero: false,
    };
    current.events += Number(event.request_count ?? 1);
    current.usageSamples += 1;
    current.durationMs += Number(event.duration_ms ?? 0);
    if (typeof event.input_tokens === 'number') {
      current.inputTokens += event.input_tokens;
      current.tokenEvents += 1;
    }
    if (typeof event.output_tokens === 'number') current.outputTokens += event.output_tokens;
    if (typeof event.input_tokens === 'number' && typeof event.output_tokens === 'number') {
      const estimate = estimateApiEquivalent({
        providerId: typeof event.provider_id === 'string' ? event.provider_id : null,
        modelId: typeof event.model_id === 'string' ? event.model_id : null,
        inputTokens: event.input_tokens,
        outputTokens: event.output_tokens,
        cachedInputTokens: typeof event.cached_input_tokens === 'number' ? event.cached_input_tokens : null,
      });
      if (estimate) {
        current.estimatedCostUsd += estimate.amount;
        current.pricedEvents += 1;
        current.priceSources.add(estimate.pricing.source);
        current.effectiveDates.add(estimate.pricing.effectiveDate);
        current.cachedInputAssumedZero ||= estimate.cachedInputAssumedZero;
      }
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].map(
    ({
      key,
      events: count,
      durationMs,
      inputTokens,
      outputTokens,
      tokenEvents,
      usageSamples,
      estimatedCostUsd,
      pricedEvents,
      priceSources,
      effectiveDates,
      cachedInputAssumedZero,
    }) => ({
      key,
      events: count,
      durationMs,
      inputTokens: tokenEvents ? inputTokens : null,
      outputTokens: tokenEvents ? outputTokens : null,
      estimatedCostUsd: pricedEvents === usageSamples && usageSamples > 0 ? estimatedCostUsd : null,
      costProvenance: pricedEvents === usageSamples && usageSamples > 0 ? 'estimated' : 'unavailable',
      pricingSource: priceSources.size === 1 ? [...priceSources][0] : null,
      pricingEffectiveDate: effectiveDates.size === 1 ? [...effectiveDates][0] : null,
      cachedInputAssumedZero: pricedEvents > 0 && cachedInputAssumedZero,
      quota: null,
    }),
  );
}

function listQuotaEnvelopes(db: Db) {
  const rows = db.prepare('SELECT * FROM quota_envelopes ORDER BY provider_id').all() as Array<
    Record<string, unknown>
  >;
  const now = Date.now();
  return rows.map((row) => {
    const samples = db
      .prepare(
        'SELECT occurred_at, input_tokens, output_tokens, duration_ms, request_count, provenance FROM usage_events WHERE provider_id = ? AND occurred_at >= ? AND occurred_at < ? AND occurred_at <= ? ORDER BY occurred_at LIMIT 50000',
      )
      .all(row.provider_id, row.effective_at, row.reset_at, new Date(now).toISOString()) as Array<
      Record<string, unknown>
    >;
    const forecast = calculateQuotaForecast({
      allowance: Number(row.allowance),
      unit: String(row.unit) as QuotaUnit,
      effectiveAt: String(row.effective_at),
      resetAt: String(row.reset_at),
      now,
      samples: samples.map((sample): QuotaUsageSample => ({
        occurredAt: String(sample.occurred_at),
        inputTokens: typeof sample.input_tokens === 'number' ? sample.input_tokens : null,
        outputTokens: typeof sample.output_tokens === 'number' ? sample.output_tokens : null,
        durationMs: Number(sample.duration_ms ?? 0),
        requestCount: Number(sample.request_count ?? 1),
        provenance: String(sample.provenance ?? 'unavailable'),
      })),
    });
    return {
      id: String(row.id),
      providerId: String(row.provider_id),
      quotaName: String(row.quota_name),
      windowLabel: String(row.window_label),
      resetAt: String(row.reset_at),
      allowance: Number(row.allowance),
      unit: String(row.unit),
      notes: String(row.notes ?? ''),
      effectiveAt: String(row.effective_at),
      subscriptionCostUsd: typeof row.subscription_cost_usd === 'number' ? row.subscription_cost_usd : null,
      provenance: 'user_configured' as const,
      forecast,
    };
  });
}
