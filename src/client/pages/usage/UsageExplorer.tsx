// The Usage page explorer: token chart, breakdown tables, provenance and budget meters.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AlertTriangle, Download, Scale } from 'lucide-react';
import { billingLaneLabel } from '../../../shared/billing';
import { systemTimeZone } from '../../../shared/timezone';
import { api, type BudgetStatus, type MetricTotal, type UsageAnalytics, type UsageGroupRow } from '../../api';

/* ───────────────────────── Usage explorer ───────────────────────── */

const SERIES = [
  { key: 'uncached', label: 'Input (uncached)', color: 'var(--chart-1)' },
  { key: 'cached', label: 'Cached input', color: 'var(--chart-2)' },
  { key: 'output', label: 'Output', color: 'var(--chart-3)' },
] as const;

export function formatMetric(metric: MetricTotal | undefined, kind: 'tokens' | 'usd' = 'tokens'): string {
  if (!metric || metric.value === null) return 'Unavailable';
  return kind === 'usd'
    ? `$${metric.value.toFixed(metric.value < 1 ? 4 : 2)}`
    : Math.round(metric.value).toLocaleString();
}

function coverage(metric: MetricTotal | undefined): string {
  if (!metric || metric.value === null) return 'No reporting calls';
  return metric.missing
    ? `${metric.missing} call${metric.missing === 1 ? '' : 's'} without telemetry`
    : 'All calls reported';
}

type Range = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';
const FILTER_KEYS = [
  'billingLane',
  'modelId',
  'projectId',
  'workflowId',
  'role',
  'workloadType',
  'reasoning',
  'machineId',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const FILTER_LABELS: Record<FilterKey, string> = {
  billingLane: 'Provider / billing lane',
  modelId: 'Model',
  projectId: 'Project',
  workflowId: 'Workflow',
  role: 'Role',
  workloadType: 'Workload',
  reasoning: 'Reasoning / variant',
  machineId: 'Machine',
};

function TokenChart({ analytics }: { analytics: UsageAnalytics }) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const bars = analytics.series.map((bucket) => {
    const input = bucket.inputTokens.value;
    const cached = bucket.cachedInputTokens.value ?? 0;
    const output = bucket.outputTokens.value;
    return {
      bucket: bucket.bucket,
      available: input !== null || output !== null,
      uncached: Math.max(0, (input ?? 0) - cached),
      cached: input !== null ? cached : 0,
      output: output ?? 0,
      missing: bucket.inputTokens.missing,
    };
  });
  const max = Math.max(1, ...bars.map((bar) => bar.uncached + bar.cached + bar.output));
  const width = 640;
  const height = 180;
  const slot = width / Math.max(1, bars.length);
  const barWidth = Math.max(4, Math.min(28, slot - 6));
  const label = (key: string) => (analytics.granularity === 'hour' ? `${key.slice(11)}:00` : key.slice(5));
  return (
    <div className="token-chart">
      <div className="chart-legend" aria-hidden="true">
        {SERIES.map((series) => (
          <span key={series.key}>
            <i style={{ background: series.color }} />
            {series.label}
          </span>
        ))}
        <button className="text-button" onClick={() => setShowTable((value) => !value)}>
          {showTable ? 'Hide table' : 'Show table'}
        </button>
      </div>
      <div className="chart-frame">
        <svg
          viewBox={`0 0 ${width} ${height + 20}`}
          role="img"
          aria-label={`${analytics.granularity === 'hour' ? 'Hourly' : 'Daily'} token usage: input, cached input, and output`}
          preserveAspectRatio="none"
        >
          <line x1={0} x2={width} y1={height} y2={height} className="chart-axis" />
          {bars.map((bar, index) => {
            const x = index * slot + (slot - barWidth) / 2;
            let y = height;
            return (
              <g
                key={bar.bucket}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(index)}
                tabIndex={0}
              >
                <rect x={index * slot} y={0} width={slot} height={height} fill="transparent" />
                {SERIES.map((series) => {
                  const value = bar[series.key];
                  if (!value) return null;
                  const segment = Math.max(1, (value / max) * (height - 8));
                  y -= segment;
                  return (
                    <rect
                      key={series.key}
                      x={x}
                      y={y + 1}
                      width={barWidth}
                      height={Math.max(0.5, segment - 2)}
                      rx={2}
                      style={{ fill: series.color }}
                    />
                  );
                })}
                {(bars.length <= 14 || index % Math.ceil(bars.length / 10) === 0) && (
                  <text
                    x={index * slot + slot / 2}
                    y={height + 14}
                    textAnchor="middle"
                    className="chart-tick"
                  >
                    {label(bar.bucket)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && bars[hover] && (
          <div
            className="chart-tooltip"
            style={{ '--tip-x': `${((hover + 0.5) / bars.length) * 100}%` } as CSSProperties}
          >
            <strong>
              {bars[hover]!.bucket.replace('T', ' ')}
              {analytics.granularity === 'hour' ? ':00' : ''}
            </strong>
            {bars[hover]!.available ? (
              SERIES.map((series) => (
                <span key={series.key}>
                  {series.label}: {bars[hover]![series.key].toLocaleString()}
                </span>
              ))
            ) : (
              <span>{bars[hover]!.missing ? 'Token telemetry unavailable' : 'No usage'}</span>
            )}
          </div>
        )}
      </div>
      {showTable && (
        <div className="usage-table">
          <div className="usage-table-head">
            <span>{analytics.granularity === 'hour' ? 'Hour' : 'Day'}</span>
            <span>Input</span>
            <span>Cached</span>
            <span>Output</span>
          </div>
          {analytics.series.map((bucket) => (
            <div className="usage-table-row" key={bucket.bucket}>
              <span>{bucket.bucket}</span>
              <span>{formatMetric(bucket.inputTokens)}</span>
              <span>{formatMetric(bucket.cachedInputTokens)}</span>
              <span>{formatMetric(bucket.outputTokens)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BreakdownTable({
  rows,
  title,
  onSelect,
  showLane = false,
}: {
  rows: UsageGroupRow[];
  title: string;
  onSelect?: (row: UsageGroupRow) => void;
  showLane?: boolean;
}) {
  const max = Math.max(1, ...rows.map((row) => row.totalTokens.value ?? 0));
  return (
    <div className="usage-table breakdown-table">
      <div className="usage-table-head">
        <span>{title}</span>
        <span>Input · output</span>
        <span>Requests</span>
        <span>Actual spend</span>
      </div>
      {rows.map((row) => (
        <div
          className={`usage-table-row ${onSelect ? 'usage-row-clickable' : ''}`}
          key={row.key}
          onClick={onSelect ? () => onSelect(row) : undefined}
          role={onSelect ? 'button' : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onKeyDown={onSelect ? (event) => event.key === 'Enter' && onSelect(row) : undefined}
        >
          <span className="usage-key">
            <strong>{row.label}</strong>
            <small>
              {showLane && row.billingLane ? `${billingLaneLabel(row.billingLane)} · ` : ''}
              {row.modelId && row.label !== row.modelId ? row.modelId : ''}
            </small>
            <span className="bar-track" aria-hidden="true">
              <i
                style={{
                  width: `${row.totalTokens.value === null ? 0 : Math.max(2, (row.totalTokens.value / max) * 100)}%`,
                }}
              />
            </span>
          </span>
          <span>
            {formatMetric(row.inputTokens)} · {formatMetric(row.outputTokens)}
            <small>cached {formatMetric(row.cachedInputTokens)}</small>
          </span>
          <span>{row.requests}</span>
          <span>
            {formatMetric(row.actualMeteredCostUsd, 'usd')}
            <small>est. value {formatMetric(row.equivalentValueUsd, 'usd')}</small>
          </span>
        </div>
      ))}
      {!rows.length && <div className="empty-inline">No usage for this filter.</div>}
    </div>
  );
}

function bag(values: Record<string, number>): string {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([key, count]) => `${key} ${count}`).join(' · ') : '—';
}

/** UI.4 provenance words. humanize() keeps underscores, so the words are spelled out here. */
const PROVENANCE_WORDS: Record<string, string> = {
  provider_measured: 'Provider measured',
  locally_measured: 'Locally measured',
  user_configured: 'User configured',
  estimated: 'Estimated',
  unavailable: 'Unavailable',
};

/** One provenance word with its count, or the bare word when there is no count. A null figure is never shown as 0. */
function ProvenanceBadge({ provenance, count }: { provenance: string; count?: number }) {
  return (
    <span className="provenance-badge">
      {PROVENANCE_WORDS[provenance] ?? provenance.replace(/_/g, ' ')}
      {count === undefined ? '' : ` ${count}`}
    </span>
  );
}

/** A budget meter beside its text value. Rendered only when a cap is set; the cap-less row keeps its "No cap" text. */
function BudgetMeter({
  label,
  committedUsd,
  capUsd,
}: {
  label: string;
  committedUsd: number;
  capUsd: number;
}) {
  const value = `$${committedUsd.toFixed(2)} of $${capUsd.toFixed(2)} committed`;
  const ratio = capUsd > 0 ? Math.min(1, Math.max(0, committedUsd / capUsd)) : 0;
  return (
    <span className="budget-meter-row">
      <span className="bar-track" role="img" aria-label={`${label}: ${value}`}>
        <i style={{ width: `${ratio * 100}%` }} />
      </span>
      <small>{value}</small>
    </span>
  );
}

export function UsageExplorer() {
  const narrow = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 680px)').matches);
  const [range, setRange] = useState<Range>(narrow ? 'today' : '7d');
  const [timeZone, setTimeZone] = useState(systemTimeZone());
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [filters, setFilters] = useState<Partial<Record<FilterKey, string>>>({});
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null);
  const [error, setError] = useState('');
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const query = useMemo(() => {
    const value: Record<string, string> = { range, tz: timeZone };
    if (range === 'custom') {
      if (customFrom) value.from = customFrom;
      if (customTo) value.to = customTo;
    }
    for (const key of FILTER_KEYS) if (filters[key]) value[key] = filters[key]!;
    return value;
  }, [range, timeZone, customFrom, customTo, filters]);
  useEffect(() => {
    let live = true;
    void api
      .usageAnalytics(query)
      .then((result) => {
        if (live) {
          setAnalytics(result);
          setError('');
        }
      })
      .catch(
        (reason: unknown) =>
          live && setError(reason instanceof Error ? reason.message : 'Usage analytics could not be loaded.'),
      );
    return () => {
      live = false;
    };
  }, [query]);
  useEffect(() => {
    void api
      .budgets()
      .then((result) => setBudget(result.status))
      .catch(() => undefined);
  }, []);
  const zones = useMemo(() => {
    const supported =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? [];
    return [...new Set([systemTimeZone(), 'UTC', ...supported])];
  }, []);
  const options = (key: FilterKey): Array<[string, string]> => {
    if (!analytics) return [];
    const rows =
      key === 'billingLane'
        ? analytics.byBillingLane
        : key === 'modelId'
          ? analytics.byModel
          : key === 'projectId'
            ? analytics.byProject
            : key === 'workflowId'
              ? analytics.byWorkflow
              : key === 'role'
                ? analytics.byRole
                : key === 'workloadType'
                  ? analytics.byWorkload
                  : key === 'reasoning'
                    ? analytics.byReasoning
                    : analytics.byMachine;
    const values = rows.map((row): [string, string] =>
      key === 'modelId' ? [row.modelId ?? row.key, row.label] : [row.key, row.label],
    );
    const unique = new Map(values);
    if (filters[key] && !unique.has(filters[key]!)) unique.set(filters[key]!, filters[key]!);
    return [...unique.entries()].filter(
      ([value]) =>
        !['none', 'unknown', 'unattributed', 'provider default', 'local process'].includes(value) ||
        key === 'reasoning',
    );
  };
  const totals = analytics?.totals;
  const modelDetail = filters.modelId && analytics ? analytics.byModel[0] : undefined;
  const openRouterSpend = analytics?.byBillingLane.find((row) => row.billingLane === 'openrouter-metered');
  return (
    <div className="usage-explorer">
      <div className="usage-controls" role="group" aria-label="Usage filters">
        <div className="window-switcher" role="group" aria-label="Date range">
          {(['today', 'yesterday', '7d', '30d', 'month', 'custom'] as const).map((value) => (
            <button
              key={value}
              className={range === value ? 'window-selected' : ''}
              onClick={() => setRange(value)}
            >
              {value === 'today'
                ? 'Today'
                : value === 'yesterday'
                  ? 'Yesterday'
                  : value === 'month'
                    ? 'This month'
                    : value === 'custom'
                      ? 'Custom'
                      : value}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <>
            <label className="form-field">
              <span>From</span>
              <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
            </label>
            <label className="form-field">
              <span>To</span>
              <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
            </label>
          </>
        )}
        <label className="form-field">
          <span>Timezone</span>
          <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        {FILTER_KEYS.map((key) => (
          <label className="form-field" key={key}>
            <span>{FILTER_LABELS[key]}</span>
            <select
              value={filters[key] ?? ''}
              onChange={(event) =>
                setFilters((current) => ({ ...current, [key]: event.target.value || undefined }))
              }
            >
              <option value="">All</option>
              {options(key).map(([value, label]) => (
                <option key={value} value={value}>
                  {key === 'billingLane' ? billingLaneLabel(value) : label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <div className="usage-export-actions">
          <a className="secondary-button" href={api.usageExportUrl(query, 'csv')} download>
            <Download size={13} />
            CSV
          </a>
          <a className="secondary-button" href={api.usageExportUrl(query, 'json')} download>
            <Download size={13} />
            JSON
          </a>
          {Object.values(filters).some(Boolean) && (
            <button className="text-button" onClick={() => setFilters({})}>
              Clear filters
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="form-error">
          <AlertTriangle size={15} />
          {error}
        </div>
      )}
      {analytics && totals && (
        <>
          <div className="usage-provenance-row">
            {Object.entries(totals.tokenProvenance)
              .filter(([, count]) => count > 0)
              .map(([provenance, count]) => (
                <ProvenanceBadge key={provenance} provenance={provenance} count={count} />
              ))}
            {Object.values(totals.tokenProvenance).every((count) => count <= 0) && (
              <ProvenanceBadge provenance="unavailable" />
            )}
          </div>
          <dl className="usage-summary-grid">
            {(
              [
                ['Input tokens', formatMetric(totals.inputTokens), coverage(totals.inputTokens)],
                ['Output tokens', formatMetric(totals.outputTokens), coverage(totals.outputTokens)],
                ['Cached input', formatMetric(totals.cachedInputTokens), coverage(totals.cachedInputTokens)],
                ['Reasoning tokens', formatMetric(totals.reasoningTokens), coverage(totals.reasoningTokens)],
                ['Requests', totals.requests.toLocaleString(), `${analytics.eventCount} canonical events`],
                [
                  'Actual metered spend',
                  formatMetric(totals.actualMeteredCostUsd, 'usd'),
                  'PROVIDER MEASURED where reported',
                ],
                [
                  'API-equivalent value',
                  formatMetric(totals.equivalentValueUsd, 'usd'),
                  'ESTIMATED · not spend',
                ],
                [
                  'Active models / lanes',
                  `${analytics.activeModels} / ${analytics.activeBillingLanes}`,
                  'Same model via different lanes counts separately',
                ],
              ] as const
            ).map(([label, value, help]) => (
              <div className="usage-metric" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
                <small>{help}</small>
              </div>
            ))}
          </dl>
          <section className="surface-panel usage-chart-panel">
            <div className="panel-title-row">
              <div>
                <h2>{analytics.granularity === 'hour' ? 'Hourly' : 'Daily'} tokens</h2>
                <p>
                  Bucketed in {analytics.filter.timeZone}. Calls without token telemetry are shown as
                  unavailable, not zero.
                </p>
              </div>
            </div>
            <TokenChart analytics={analytics} />
          </section>
          {modelDetail && (
            <section className="surface-panel usage-table-panel" aria-label="Model detail">
              <div className="panel-title-row">
                <div>
                  <h2>{modelDetail.label}</h2>
                  <p>
                    {billingLaneLabel(modelDetail.billingLane ?? 'unknown')} · {modelDetail.modelId}
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() =>
                    setFilters((current) => ({ ...current, modelId: undefined, billingLane: undefined }))
                  }
                >
                  Back to all models
                </button>
              </div>
              <div className="quota-envelope-values">
                <span>
                  Input <strong>{formatMetric(modelDetail.inputTokens)}</strong>
                </span>
                <span>
                  Output <strong>{formatMetric(modelDetail.outputTokens)}</strong>
                </span>
                <span>
                  Cached <strong>{formatMetric(modelDetail.cachedInputTokens)}</strong>
                </span>
                <span>
                  Requests <strong>{modelDetail.requests}</strong>
                </span>
                <span>
                  Roles <strong>{bag(modelDetail.roles)}</strong>
                </span>
                <span>
                  Reasoning / variant <strong>{bag(modelDetail.reasoning)}</strong>
                </span>
                <span>
                  Projects <strong>{bag(modelDetail.projects)}</strong>
                </span>
                <span>
                  Upstream providers <strong>{bag(modelDetail.upstreamProviders)}</strong>
                </span>
              </div>
            </section>
          )}
          <div className="usage-two-column">
            <section className="surface-panel usage-table-panel">
              <div className="panel-title-row">
                <div>
                  <h2>By provider / billing lane</h2>
                  <p>Subscriptions and metered lanes stay separate</p>
                </div>
              </div>
              <BreakdownTable
                rows={analytics.byBillingLane}
                title="Lane"
                onSelect={(row) => setFilters((current) => ({ ...current, billingLane: row.key }))}
              />
            </section>
            <section className="surface-panel usage-table-panel">
              <div className="panel-title-row">
                <div>
                  <h2>By model</h2>
                  <p>Select a model for its detail view</p>
                </div>
              </div>
              <BreakdownTable
                rows={analytics.byModel}
                title="Model"
                showLane
                onSelect={(row) =>
                  setFilters((current) => ({
                    ...current,
                    modelId: row.modelId ?? undefined,
                    billingLane: row.billingLane ?? undefined,
                  }))
                }
              />
            </section>
          </div>
          <div className="usage-two-column">
            <section className="surface-panel usage-table-panel">
              <div className="panel-title-row">
                <div>
                  <h2>Metered spend and budgets</h2>
                  <p>Actual spend is provider measured; caps are Turing-enforced</p>
                </div>
              </div>
              <div className="quota-envelope-values">
                <span>
                  OpenRouter actual spend (window){' '}
                  <strong>{formatMetric(openRouterSpend?.actualMeteredCostUsd, 'usd')}</strong>
                </span>
                {budget && (
                  <>
                    <span>
                      Turing daily budget{' '}
                      <strong>
                        {budget.daily.capUsd === null
                          ? 'No cap'
                          : `$${(budget.daily.capUsd - budget.daily.committedUsd).toFixed(4)} left of $${budget.daily.capUsd.toFixed(2)}`}
                      </strong>
                      {budget.daily.capUsd !== null && (
                        <BudgetMeter
                          label="Daily budget"
                          committedUsd={budget.daily.committedUsd}
                          capUsd={budget.daily.capUsd}
                        />
                      )}
                    </span>
                    <span>
                      Turing monthly budget{' '}
                      <strong>
                        {budget.monthly.capUsd === null
                          ? 'No cap'
                          : `$${(budget.monthly.capUsd - budget.monthly.committedUsd).toFixed(4)} left of $${budget.monthly.capUsd.toFixed(2)}`}
                      </strong>
                      {budget.monthly.capUsd !== null && (
                        <BudgetMeter
                          label="Monthly budget"
                          committedUsd={budget.monthly.committedUsd}
                          capUsd={budget.monthly.capUsd}
                        />
                      )}
                    </span>
                  </>
                )}
              </div>
            </section>
            {analytics.decisions.decisions > 0 && (
              <section className="surface-panel usage-table-panel" aria-label="Decision analytics">
                <div className="panel-title-row">
                  <div>
                    <h2>Decisions</h2>
                    <p>Decision workload is analysed separately from generative use</p>
                  </div>
                  <Scale size={16} className="muted-icon" />
                </div>
                <div className="quota-envelope-values">
                  <span>
                    Decisions <strong>{analytics.decisions.decisions}</strong>
                    <small>{bag(analytics.decisions.byType)}</small>
                  </span>
                  <span>
                    Auto-routed / escalated{' '}
                    <strong>
                      {analytics.decisions.autoRouted} / {analytics.decisions.escalated}
                    </strong>
                  </span>
                  <span>
                    Actual cost <strong>{formatMetric(analytics.decisions.costUsd, 'usd')}</strong>
                  </span>
                  <span>
                    Input tokens <strong>{formatMetric(analytics.decisions.inputTokens)}</strong>
                  </span>
                  <span>
                    Mean boolean probability{' '}
                    <strong>{analytics.decisions.averageBooleanProbability?.toFixed(3) ?? '—'}</strong>
                  </span>
                  <span>
                    Mean choice confidence{' '}
                    <strong>{analytics.decisions.averageChoiceConfidence?.toFixed(3) ?? '—'}</strong>
                    <small>Engine-reported only</small>
                  </span>
                  <span>
                    Mean score confidence{' '}
                    <strong>{analytics.decisions.averageScoreConfidence?.toFixed(3) ?? '—'}</strong>
                  </span>
                  <span>
                    Engines{' '}
                    <strong>
                      {analytics.decisions.byEngineModel
                        .map((item) => `${item.modelId ?? item.engine} ×${item.decisions}`)
                        .join(' · ')}
                    </strong>
                  </span>
                </div>
              </section>
            )}
          </div>
          <div className="usage-two-column">
            <section className="surface-panel usage-table-panel">
              <div className="panel-title-row">
                <div>
                  <h2>By role</h2>
                  <p>Which stages consumed tokens</p>
                </div>
              </div>
              <BreakdownTable
                rows={analytics.byRole}
                title="Role"
                onSelect={(row) => setFilters((current) => ({ ...current, role: row.key }))}
              />
            </section>
            <section className="surface-panel usage-table-panel">
              <div className="panel-title-row">
                <div>
                  <h2>By project</h2>
                  <p>Observed attribution, not quota ownership</p>
                </div>
              </div>
              <BreakdownTable
                rows={analytics.byProject}
                title="Project"
                onSelect={(row) =>
                  row.key !== 'none' && setFilters((current) => ({ ...current, projectId: row.key }))
                }
              />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
