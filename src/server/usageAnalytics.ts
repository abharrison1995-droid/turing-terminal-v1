import type { BillingLane, UsageEvent, UsageProvenance, WorkloadType } from '../shared/types.js';
import { billingLaneLabel } from '../shared/billing.js';
import { dayKeysBetween, localDayKey, localHourKey } from '../shared/timezone.js';
import type { Db } from './db.js';
import { estimateApiEquivalent } from './pricing.js';
import { normalizeProvenance } from './usageEvents.js';

/**
 * The single usage analytics layer. Headline cards, daily/hourly charts, provider/model/role/project
 * breakdowns, drilldowns, and CSV/JSON exports are all computed from one filtered event list by the
 * functions below, so their totals reconcile by construction (and tests assert it).
 *
 * A metric with no reporting events is `null` (Unavailable), never 0.
 */

export interface UsageFilter {
  from: string;
  to: string;
  timeZone: string;
  billingLane?: string;
  providerId?: string;
  connectionProfileId?: string;
  modelId?: string;
  projectId?: string;
  workflowId?: string;
  role?: string;
  machineId?: string;
  workloadType?: string;
  reasoning?: string;
  runId?: string;
}

export interface MetricTotal {
  value: number | null;
  reported: number;
  missing: number;
}

const TOKEN_METRICS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
] as const;
type TokenMetric = (typeof TOKEN_METRICS)[number];

export interface UsageAggregate {
  events: number;
  requests: number;
  durationMs: number;
  inputTokens: MetricTotal;
  outputTokens: MetricTotal;
  cachedInputTokens: MetricTotal;
  cacheWriteTokens: MetricTotal;
  reasoningTokens: MetricTotal;
  totalTokens: MetricTotal;
  actualMeteredCostUsd: MetricTotal;
  equivalentValueUsd: MetricTotal;
  tokenProvenance: Partial<Record<UsageProvenance, number>>;
}

export interface UsageGroupRow extends UsageAggregate {
  key: string;
  label: string;
  billingLane: string | null;
  providerId: string | null;
  modelId: string | null;
  roles: Record<string, number>;
  projects: Record<string, number>;
  reasoning: Record<string, number>;
  upstreamProviders: Record<string, number>;
}

function emptyMetric(): MetricTotal {
  return { value: null, reported: 0, missing: 0 };
}

function emptyAggregate(): UsageAggregate {
  return {
    events: 0,
    requests: 0,
    durationMs: 0,
    inputTokens: emptyMetric(),
    outputTokens: emptyMetric(),
    cachedInputTokens: emptyMetric(),
    cacheWriteTokens: emptyMetric(),
    reasoningTokens: emptyMetric(),
    totalTokens: emptyMetric(),
    actualMeteredCostUsd: emptyMetric(),
    equivalentValueUsd: emptyMetric(),
    tokenProvenance: {},
  };
}

function addMetric(metric: MetricTotal, value: number | null): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    metric.value = (metric.value ?? 0) + value;
    metric.reported += 1;
  } else metric.missing += 1;
}

export function equivalentValue(event: UsageEvent): number | null {
  // Only provider/local-measured tokens are priced; an estimate of an estimate is not defensible.
  if (event.tokenProvenance !== 'provider_measured' && event.tokenProvenance !== 'locally_measured')
    return null;
  const estimate = estimateApiEquivalent({
    providerId: event.providerId,
    modelId: event.resolvedModelId ?? event.modelId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: event.cachedInputTokens,
  });
  return estimate ? estimate.amount : null;
}

function accumulate(target: UsageAggregate, event: UsageEvent): void {
  target.events += 1;
  target.requests += event.requestCount;
  target.durationMs += event.durationMs;
  for (const metric of TOKEN_METRICS) addMetric(target[metric], event[metric as TokenMetric]);
  // Actual spend is a metered-lane concept; subscription calls are not counted as missing spend.
  if (event.actualCostUsd !== null || isMeteredEvent(event))
    addMetric(target.actualMeteredCostUsd, event.actualCostUsd);
  addMetric(target.equivalentValueUsd, equivalentValue(event));
  target.tokenProvenance[event.tokenProvenance] = (target.tokenProvenance[event.tokenProvenance] ?? 0) + 1;
}

function isMeteredEvent(event: UsageEvent): boolean {
  return [
    'openrouter-metered',
    'opencode-metered',
    'cline-usage-billing',
    'openai-api',
    'anthropic-api',
  ].includes(event.billingLane ?? '');
}

/** Empty buckets are real zero usage; buckets whose events lack a metric stay null. */
function finalizeBucket(aggregate: UsageAggregate): UsageAggregate {
  if (aggregate.events > 0) return aggregate;
  const zero = (): MetricTotal => ({ value: 0, reported: 0, missing: 0 });
  return {
    ...aggregate,
    inputTokens: zero(),
    outputTokens: zero(),
    cachedInputTokens: zero(),
    cacheWriteTokens: zero(),
    reasoningTokens: zero(),
    totalTokens: zero(),
    actualMeteredCostUsd: zero(),
    equivalentValueUsd: zero(),
  };
}

export function loadUsageEvents(db: Db, filter: UsageFilter): UsageEvent[] {
  const conditions = ['u.occurred_at >= ?', 'u.occurred_at < ?'];
  const values: unknown[] = [filter.from, filter.to];
  const exact: Array<[string, string | undefined]> = [
    ['u.billing_lane', filter.billingLane],
    ['u.provider_id', filter.providerId],
    ['u.connection_profile_id', filter.connectionProfileId],
    ['u.model_id', filter.modelId],
    ['u.project_id', filter.projectId],
    ['u.workflow_id', filter.workflowId],
    ['u.role', filter.role],
    ['u.machine_id', filter.machineId],
    ['u.workload_type', filter.workloadType],
    ['u.run_id', filter.runId],
  ];
  for (const [column, value] of exact)
    if (value) {
      conditions.push(`${column} = ?`);
      values.push(value);
    }
  if (filter.reasoning) {
    conditions.push('COALESCE(u.reasoning, u.variant_id) = ?');
    values.push(filter.reasoning);
  }
  const rows = db
    .prepare(
      `SELECT u.*, p.name AS project_name, s.title AS stage_title FROM usage_events u
       LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN stages s ON s.id = u.stage_id
       WHERE ${conditions.join(' AND ')} ORDER BY u.occurred_at DESC`,
    )
    .all(...values) as Array<Record<string, unknown>>;
  return rows.map(toUsageEvent);
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function toUsageEvent(row: Record<string, unknown>): UsageEvent {
  return {
    id: String(row.id),
    requestId: str(row.request_id),
    providerRequestId: str(row.provider_request_id),
    occurredAt: String(row.occurred_at),
    machineId: str(row.machine_id),
    projectId: str(row.project_id),
    projectName: str(row.project_name),
    workflowId: str(row.workflow_id),
    runId: str(row.run_id),
    stageId: str(row.stage_id),
    stageTitle: str(row.stage_title),
    role: str(row.role),
    workloadType: (str(row.workload_type) ?? 'generative') as WorkloadType,
    backend: str(row.backend),
    connectionProfileId: str(row.connection_profile_id),
    billingLane: str(row.billing_lane) as BillingLane | null,
    providerId: str(row.provider_id),
    upstreamProvider: str(row.upstream_provider),
    modelId: str(row.model_id),
    resolvedModelId: str(row.resolved_model_id),
    modelDisplayName: str(row.model_display_name),
    variantId: str(row.variant_id),
    reasoning: str(row.reasoning),
    contextStrategy: str(row.context_strategy),
    decisionEngine: str(row.decision_engine),
    decisionType: str(row.decision_type),
    decisionOutcome: str(row.decision_outcome),
    batchId: str(row.batch_id),
    inputTokens: num(row.input_tokens),
    cachedInputTokens: num(row.cached_input_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    reasoningTokens: num(row.reasoning_tokens),
    outputTokens: num(row.output_tokens),
    totalTokens:
      num(row.total_tokens) ??
      (num(row.input_tokens) !== null && num(row.output_tokens) !== null
        ? num(row.input_tokens)! + num(row.output_tokens)!
        : null),
    requestCount: Number(row.request_count ?? 1),
    durationMs: Number(row.duration_ms ?? 0),
    latencyMs: num(row.latency_ms),
    status: str(row.status) ?? 'succeeded',
    finishReason: str(row.finish_reason),
    tokenProvenance: normalizeProvenance(str(row.provenance)),
    actualCostUsd: num(row.actual_cost_usd),
    actualCostProvenance: normalizeProvenance(str(row.actual_cost_provenance)),
    equivalentCostUsd: num(row.equivalent_cost_usd),
    reconciliationState: (str(row.reconciliation_state) ?? 'final') as UsageEvent['reconciliationState'],
    estimatedInputTokens: num(row.estimated_input_tokens),
    estimatedOutputTokens: num(row.estimated_output_tokens),
    estimatedCostUsd: num(row.estimated_cost_usd),
  };
}

function groupBy(
  events: UsageEvent[],
  keyOf: (event: UsageEvent) => {
    key: string;
    label: string;
    billingLane?: string | null;
    providerId?: string | null;
    modelId?: string | null;
  },
): UsageGroupRow[] {
  const groups = new Map<string, UsageGroupRow>();
  for (const event of events) {
    const identity = keyOf(event);
    let row = groups.get(identity.key);
    if (!row) {
      row = {
        ...emptyAggregate(),
        key: identity.key,
        label: identity.label,
        billingLane: identity.billingLane ?? null,
        providerId: identity.providerId ?? null,
        modelId: identity.modelId ?? null,
        roles: {},
        projects: {},
        reasoning: {},
        upstreamProviders: {},
      };
      groups.set(identity.key, row);
    }
    accumulate(row, event);
    const bump = (bag: Record<string, number>, value: string | null) => {
      if (value) bag[value] = (bag[value] ?? 0) + event.requestCount;
    };
    bump(row.roles, event.role);
    bump(row.projects, event.projectName ?? event.projectId);
    bump(row.reasoning, event.reasoning ?? event.variantId ?? 'provider default');
    bump(row.upstreamProviders, event.upstreamProvider);
  }
  return [...groups.values()].sort(
    (a, b) => (b.totalTokens.value ?? -1) - (a.totalTokens.value ?? -1) || b.requests - a.requests,
  );
}

export interface DecisionAnalytics {
  decisions: number;
  byType: Record<string, number>;
  byOutcome: Record<string, number>;
  autoRouted: number;
  escalated: number;
  costUsd: MetricTotal;
  inputTokens: MetricTotal;
  outputTokens: MetricTotal;
  /** Averages are reported only within one semantic field and question type. */
  averageBooleanProbability: number | null;
  averageChoiceConfidence: number | null;
  averageScoreConfidence: number | null;
  byEngineModel: Array<{
    key: string;
    engine: string;
    modelId: string | null;
    decisions: number;
    costUsd: number | null;
  }>;
}

export function decisionAnalytics(db: Db, filter: UsageFilter): DecisionAnalytics {
  const conditions = ['d.created_at >= ?', 'd.created_at < ?'];
  const values: unknown[] = [filter.from, filter.to];
  if (filter.runId) {
    conditions.push('d.run_id = ?');
    values.push(filter.runId);
  }
  if (filter.modelId) {
    conditions.push('d.configured_model_id = ?');
    values.push(filter.modelId);
  }
  if (filter.projectId) {
    conditions.push('r.project_id = ?');
    values.push(filter.projectId);
  }
  if (filter.workflowId) {
    conditions.push('r.workflow_id = ?');
    values.push(filter.workflowId);
  }
  if (filter.billingLane) {
    conditions.push('d.billing_lane = ?');
    values.push(filter.billingLane);
  }
  const rows = db
    .prepare(
      `SELECT d.* FROM decision_results d LEFT JOIN runs r ON r.id = d.run_id WHERE ${conditions.join(' AND ')}`,
    )
    .all(...values) as Array<Record<string, unknown>>;
  const result: DecisionAnalytics = {
    decisions: rows.length,
    byType: {},
    byOutcome: {},
    autoRouted: 0,
    escalated: 0,
    costUsd: emptyMetric(),
    inputTokens: emptyMetric(),
    outputTokens: emptyMetric(),
    averageBooleanProbability: null,
    averageChoiceConfidence: null,
    averageScoreConfidence: null,
    byEngineModel: [],
  };
  const mean = (items: number[]) => (items.length ? items.reduce((a, b) => a + b, 0) / items.length : null);
  const booleanProbability: number[] = [];
  const choiceConfidence: number[] = [];
  const scoreConfidence: number[] = [];
  const engines = new Map<
    string,
    { key: string; engine: string; modelId: string | null; decisions: number; costUsd: number | null }
  >();
  for (const row of rows) {
    const type = String(row.question_type);
    const outcome = String(row.outcome);
    result.byType[type] = (result.byType[type] ?? 0) + 1;
    result.byOutcome[outcome] = (result.byOutcome[outcome] ?? 0) + 1;
    const route = (() => {
      try {
        return JSON.parse(String(row.route_json)) as { action?: string };
      } catch {
        return {};
      }
    })();
    if (outcome === 'uncertain' || route.action === 'escalate' || route.action === 'human-approval')
      result.escalated += 1;
    else result.autoRouted += 1;
    addMetric(result.costUsd, num(row.cost_usd));
    addMetric(result.inputTokens, num(row.input_tokens));
    addMetric(result.outputTokens, num(row.output_tokens));
    const engineKind = str(row.confidence_kind);
    if (type === 'boolean' && num(row.probability) !== null) booleanProbability.push(num(row.probability)!);
    if (type === 'choice' && engineKind === 'engine-distribution' && num(row.confidence) !== null)
      choiceConfidence.push(num(row.confidence)!);
    if (type === 'score' && engineKind === 'engine-distribution' && num(row.confidence) !== null)
      scoreConfidence.push(num(row.confidence)!);
    const key = `${String(row.engine)}::${str(row.configured_model_id) ?? ''}`;
    const engine = engines.get(key) ?? {
      key,
      engine: String(row.engine),
      modelId: str(row.configured_model_id),
      decisions: 0,
      costUsd: null,
    };
    engine.decisions += 1;
    if (num(row.cost_usd) !== null) engine.costUsd = (engine.costUsd ?? 0) + num(row.cost_usd)!;
    engines.set(key, engine);
  }
  result.averageBooleanProbability = mean(booleanProbability);
  result.averageChoiceConfidence = mean(choiceConfidence);
  result.averageScoreConfidence = mean(scoreConfidence);
  result.byEngineModel = [...engines.values()];
  return result;
}

export function aggregateUsage(events: UsageEvent[], filter: UsageFilter) {
  const totals = emptyAggregate();
  for (const event of events) accumulate(totals, event);
  const fromDay = localDayKey(filter.from, filter.timeZone);
  const toDay = localDayKey(new Date(Date.parse(filter.to) - 1).toISOString(), filter.timeZone);
  const days = dayKeysBetween(fromDay, toDay);
  const granularity: 'hour' | 'day' = days.length <= 1 ? 'hour' : 'day';
  const bucketKeys =
    granularity === 'day'
      ? days
      : Array.from({ length: 24 }, (_, hour) => `${fromDay}T${String(hour).padStart(2, '0')}`);
  const buckets = new Map(bucketKeys.map((key) => [key, emptyAggregate()]));
  for (const event of events) {
    const key =
      granularity === 'day'
        ? localDayKey(event.occurredAt, filter.timeZone)
        : localHourKey(event.occurredAt, filter.timeZone);
    let bucket = buckets.get(key);
    if (!bucket) {
      // A DST day can have an extra local hour; keep it rather than dropping usage.
      bucket = emptyAggregate();
      buckets.set(key, bucket);
    }
    accumulate(bucket, event);
  }
  const series = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, aggregate]) => ({ bucket, ...finalizeBucket(aggregate) }));
  const byBillingLane = groupBy(events, (event) => ({
    key: event.billingLane ?? 'unknown',
    label: billingLaneLabel(
      event.billingLane ?? (event.workloadType === 'deterministic' ? 'local process' : 'unknown'),
    ),
    billingLane: event.billingLane,
  }));
  const byModel = groupBy(
    events.filter((event) => event.modelId),
    (event) => ({
      key: `${event.billingLane ?? 'unknown'}::${event.modelId}`,
      label: event.modelDisplayName ?? event.modelId!,
      billingLane: event.billingLane,
      providerId: event.providerId,
      modelId: event.modelId,
    }),
  );
  const simple = (field: (event: UsageEvent) => string | null, fallback: string) =>
    groupBy(events, (event) => ({ key: field(event) ?? fallback, label: field(event) ?? fallback }));
  return {
    granularity,
    totals,
    activeModels: new Set(
      events.filter((event) => event.modelId).map((event) => `${event.billingLane}::${event.modelId}`),
    ).size,
    activeBillingLanes: new Set(events.filter((event) => event.billingLane).map((event) => event.billingLane))
      .size,
    series,
    byBillingLane,
    byModel,
    byProvider: simple((event) => event.providerId, 'local process'),
    byRole: simple((event) => event.role, 'unattributed'),
    byProject: groupBy(events, (event) => ({
      key: event.projectId ?? 'none',
      label: event.projectName ?? 'Unassigned project',
    })),
    byWorkflow: simple((event) => event.workflowId, 'none'),
    byMachine: simple((event) => event.machineId, 'unknown'),
    byWorkload: simple((event) => event.workloadType, 'generative'),
    byReasoning: simple((event) => event.reasoning ?? event.variantId, 'provider default'),
  };
}

export function queryUsageAnalytics(db: Db, filter: UsageFilter) {
  const events = loadUsageEvents(db, filter);
  return {
    filter,
    ...aggregateUsage(events, filter),
    decisions: decisionAnalytics(db, filter),
    events: events.slice(0, 200),
    eventCount: events.length,
  };
}

export const EXPORT_COLUMNS = [
  'occurredAtUtc',
  'occurredAtLocal',
  'timeZone',
  'machineId',
  'projectId',
  'projectName',
  'workflowId',
  'runId',
  'stageId',
  'stageTitle',
  'role',
  'workloadType',
  'billingLane',
  'connectionProfileId',
  'backend',
  'providerId',
  'upstreamProvider',
  'modelId',
  'resolvedModelId',
  'variantId',
  'reasoning',
  'contextStrategy',
  'decisionEngine',
  'decisionType',
  'decisionOutcome',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'outputTokens',
  'totalTokens',
  'requestCount',
  'status',
  'tokenProvenance',
  'reconciliationState',
  'actualCostUsd',
  'actualCostProvenance',
  'estimatedEquivalentValueUsd',
  'estimatedInputTokens',
  'estimatedOutputTokens',
] as const;

/** Export rows contain identifiers, configuration, and numbers only — never prompts, outputs, or credentials. */
export function exportRows(
  events: UsageEvent[],
  timeZone: string,
): Array<Record<(typeof EXPORT_COLUMNS)[number], string | number | null>> {
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' });
  return events.map((event) => ({
    occurredAtUtc: event.occurredAt,
    occurredAtLocal: local.format(new Date(event.occurredAt)),
    timeZone,
    machineId: event.machineId,
    projectId: event.projectId,
    projectName: event.projectName ?? null,
    workflowId: event.workflowId,
    runId: event.runId,
    stageId: event.stageId,
    stageTitle: event.stageTitle ?? null,
    role: event.role,
    workloadType: event.workloadType,
    billingLane: event.billingLane,
    connectionProfileId: event.connectionProfileId,
    backend: event.backend,
    providerId: event.providerId,
    upstreamProvider: event.upstreamProvider,
    modelId: event.modelId,
    resolvedModelId: event.resolvedModelId,
    variantId: event.variantId,
    reasoning: event.reasoning,
    contextStrategy: event.contextStrategy,
    decisionEngine: event.decisionEngine,
    decisionType: event.decisionType,
    decisionOutcome: event.decisionOutcome,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    reasoningTokens: event.reasoningTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    requestCount: event.requestCount,
    status: event.status,
    tokenProvenance: event.tokenProvenance,
    reconciliationState: event.reconciliationState,
    actualCostUsd: event.actualCostUsd,
    actualCostProvenance: event.actualCostProvenance,
    estimatedEquivalentValueUsd: equivalentValue(event),
    estimatedInputTokens: event.estimatedInputTokens,
    estimatedOutputTokens: event.estimatedOutputTokens,
  }));
}

export function toCsv(rows: Array<Record<string, string | number | null>>): string {
  const escape = (value: string | number | null) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    // Neutralise spreadsheet formula injection as well as quoting separators.
    const safe = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return [
    EXPORT_COLUMNS.join(','),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => escape(row[column] ?? null)).join(',')),
  ].join('\r\n');
}
