import { useEffect, useState } from 'react';
import { AlertTriangle, Radio, Save, Shield } from 'lucide-react';
import type { DashboardSnapshot } from '../../shared/types';
import { api } from '../api';
import { UsageExplorer } from './usage/UsageExplorer';
import { toDateTimeLocal, quotaProviderOptions, quotaUnitLabel, formatDate } from './shared/format';
import { PageHeading } from './shared/parts';
import { humanize } from './shared/runStatus';

export function UsagePage(_props: { snapshot: DashboardSnapshot }) {
  // Quota envelopes compare against a 30-day window; all other analytics come from UsageExplorer.
  const windowSize = '30d' as const;
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [quotaMessage, setQuotaMessage] = useState('');
  const [savingQuota, setSavingQuota] = useState(false);
  const [quotaDraft, setQuotaDraft] = useState(() => {
    const now = new Date();
    return {
      providerId: '',
      quotaName: '',
      windowLabel: 'Weekly',
      effectiveAt: toDateTimeLocal(now),
      resetAt: toDateTimeLocal(new Date(now.getTime() + 7 * 86_400_000)),
      allowance: '',
      unit: 'total_tokens' as const,
      notes: '',
      subscriptionCostUsd: '',
    };
  });
  useEffect(() => {
    let live = true;
    void api
      .usage(windowSize)
      .then((value) => {
        if (live) {
          setData(value);
          setError('');
        }
      })
      .catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : 'Usage could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [windowSize]);
  useEffect(() => {
    if (!quotaDraft.providerId && quotaProviderOptions.length)
      setQuotaDraft((current) => ({ ...current, providerId: quotaProviderOptions[0]!.id }));
  }, [quotaDraft.providerId]);
  const providers = Array.isArray(data?.providers) ? (data.providers as Array<Record<string, unknown>>) : [];
  const quotas = Array.isArray(data?.quotas) ? (data.quotas as Array<Record<string, unknown>>) : [];
  const usageByProvider = new Map(providers.map((provider) => [String(provider.key), provider]));
  const saveQuota = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingQuota(true);
    setQuotaMessage('');
    try {
      await api.saveQuotaEnvelope({
        providerId: quotaDraft.providerId,
        quotaName: quotaDraft.quotaName.trim(),
        windowLabel: quotaDraft.windowLabel.trim(),
        effectiveAt: new Date(quotaDraft.effectiveAt).toISOString(),
        resetAt: new Date(quotaDraft.resetAt).toISOString(),
        allowance: Number(quotaDraft.allowance),
        unit: quotaDraft.unit,
        notes: quotaDraft.notes,
        subscriptionCostUsd: quotaDraft.subscriptionCostUsd.trim()
          ? Number(quotaDraft.subscriptionCostUsd)
          : null,
      });
      setData(await api.usage(windowSize));
      setQuotaMessage('Quota envelope saved. Its allowance source is user configured.');
    } catch (reason) {
      setQuotaMessage(reason instanceof Error ? reason.message : 'Quota envelope could not be saved.');
    } finally {
      setSavingQuota(false);
    }
  };
  const removeQuota = async (id: string) => {
    try {
      await api.deleteQuotaEnvelope(id);
      setData(await api.usage(windowSize));
      setQuotaMessage('Quota envelope removed.');
    } catch (reason) {
      setQuotaMessage(reason instanceof Error ? reason.message : 'Quota envelope could not be removed.');
    }
  };
  return (
    <main className="page-content">
      <PageHeading
        title="Usage"
        description="Tokens, requests, and spend by provider lane, model, role, and project — one shared query drives every card, chart, table, and export."
      />
      <div className="usage-honesty-banner">
        <div>
          <Radio size={17} />
          <strong>Provenance stays visible · reconciled, never double-counted</strong>
          <span>
            Quota calculations use your manually entered allowance/reset and this master’s observed usage.
            They are estimates, not provider telemetry.
          </span>
        </div>
        <span className="status-pill status-attention">Sources stay visible</span>
      </div>
      {error && (
        <div className="form-error">
          <AlertTriangle size={15} />
          {error}
        </div>
      )}
      <UsageExplorer />
      <section className="surface-panel quota-envelope-panel">
        <div className="panel-title-row">
          <div>
            <h2>User-configured quota envelopes</h2>
            <p>
              Enter values you know from your provider account. Turing never fills allowance or reset values
              for you.
            </p>
          </div>
          <Radio size={16} className="muted-icon" />
        </div>
        {quotaMessage && <div className="inline-callout quota-feedback">{quotaMessage}</div>}
        <form className="quota-envelope-form" onSubmit={(event) => void saveQuota(event)}>
          <label className="form-field">
            <span>Provider</span>
            <select
              required
              value={quotaDraft.providerId}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, providerId: event.target.value })}
            >
              {quotaProviderOptions.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Quota name</span>
            <input
              required
              maxLength={100}
              value={quotaDraft.quotaName}
              placeholder="Claude weekly allowance"
              onChange={(event) => setQuotaDraft({ ...quotaDraft, quotaName: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Window label</span>
            <input
              required
              maxLength={80}
              value={quotaDraft.windowLabel}
              placeholder="Weekly"
              onChange={(event) => setQuotaDraft({ ...quotaDraft, windowLabel: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Allowance</span>
            <input
              required
              type="number"
              min="0.000001"
              step="any"
              value={quotaDraft.allowance}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, allowance: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Unit</span>
            <select
              value={quotaDraft.unit}
              onChange={(event) =>
                setQuotaDraft({ ...quotaDraft, unit: event.target.value as typeof quotaDraft.unit })
              }
            >
              <option value="total_tokens">Total tokens</option>
              <option value="input_tokens">Input tokens</option>
              <option value="output_tokens">Output tokens</option>
              <option value="requests">Requests (local)</option>
              <option value="minutes">Process minutes (local)</option>
            </select>
          </label>
          <label className="form-field">
            <span>Effective from</span>
            <input
              required
              type="datetime-local"
              value={quotaDraft.effectiveAt}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, effectiveAt: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Reset at</span>
            <input
              required
              type="datetime-local"
              value={quotaDraft.resetAt}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, resetAt: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Subscription cost per month (USD, optional)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={quotaDraft.subscriptionCostUsd}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, subscriptionCostUsd: event.target.value })}
            />
          </label>
          <label className="form-field quota-notes-field">
            <span>Notes</span>
            <textarea
              maxLength={1_000}
              rows={2}
              value={quotaDraft.notes}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, notes: event.target.value })}
            />
          </label>
          <button
            className="primary-button quota-save-button"
            type="submit"
            disabled={savingQuota || !quotaDraft.providerId}
          >
            <Save size={14} /> {savingQuota ? 'Saving…' : 'Save envelope'}
          </button>
        </form>
        {quotas.length ? (
          <div className="quota-envelope-list">
            {quotas.map((quota) => {
              const forecast = quota.forecast as Record<string, unknown>;
              const providerUsage = usageByProvider.get(String(quota.providerId));
              const estimatedCost =
                providerUsage?.costProvenance === 'estimated' &&
                typeof providerUsage.estimatedCostUsd === 'number'
                  ? providerUsage.estimatedCostUsd
                  : null;
              const subscriptionCost =
                typeof quota.subscriptionCostUsd === 'number' ? quota.subscriptionCostUsd : null;
              const monthlyRatio =
                windowSize === '30d' && estimatedCost !== null && subscriptionCost
                  ? estimatedCost / subscriptionCost
                  : null;
              return (
                <article className="quota-envelope-card" key={String(quota.id)}>
                  <div className="quota-envelope-heading">
                    <div>
                      <strong>{String(quota.quotaName)}</strong>
                      <small>
                        {String(quota.providerId)} · {String(quota.windowLabel)}
                      </small>
                    </div>
                    <span className="status-pill status-attention">USER CONFIGURED</span>
                  </div>
                  <div className="quota-envelope-values">
                    <span>
                      Allowance{' '}
                      <strong>
                        {Number(quota.allowance).toLocaleString()} {quotaUnitLabel(String(quota.unit))}
                      </strong>
                    </span>
                    <span>
                      Observed{' '}
                      <strong>
                        {forecast.observedUsed === null
                          ? 'Unavailable'
                          : `${Number(forecast.observedUsed).toLocaleString()} ${quotaUnitLabel(String(quota.unit))}`}
                      </strong>
                      <small>{humanize(String(forecast.usageProvenance ?? 'unavailable'))}</small>
                    </span>
                    <span>
                      Estimated remaining{' '}
                      <strong>
                        {forecast.remaining === null
                          ? 'Unavailable'
                          : `${Number(forecast.remaining).toLocaleString()} ${quotaUnitLabel(String(quota.unit))}`}
                      </strong>
                    </span>
                    <span>
                      Average burn{' '}
                      <strong>
                        {forecast.averagePerDay === null
                          ? 'Unavailable'
                          : `${Number(forecast.averagePerDay).toLocaleString(undefined, { maximumFractionDigits: 1 })} / day`}
                      </strong>
                    </span>
                    <span>
                      Projected exhaustion{' '}
                      <strong>
                        {forecast.projectedExhaustionAt
                          ? formatDate(String(forecast.projectedExhaustionAt))
                          : 'Not enough measured burn data'}
                      </strong>
                      <small>
                        {forecast.likelyBeforeReset === null
                          ? 'Cannot compare with reset'
                          : forecast.likelyBeforeReset
                            ? 'Likely before reset'
                            : 'Not projected before reset'}
                      </small>
                    </span>
                    <span>
                      Reset <strong>{formatDate(String(quota.resetAt))}</strong>
                      <small>USER CONFIGURED</small>
                    </span>
                    <span>
                      Forecast confidence{' '}
                      <strong>{humanize(String(forecast.confidence ?? 'unavailable'))}</strong>
                      <small>Based on {String(forecast.sampleCount ?? 0)} local usage events</small>
                    </span>
                    <span>
                      API-equivalent value{' '}
                      <strong>
                        {estimatedCost === null
                          ? 'Unavailable for this model/window'
                          : `$${estimatedCost.toFixed(2)} USD · ESTIMATED`}
                      </strong>
                      <small>
                        {monthlyRatio === null
                          ? 'Requires 30-day view, matching public price, and monthly subscription cost'
                          : `${monthlyRatio.toFixed(2)}× configured monthly cost`}
                      </small>
                    </span>
                  </div>
                  {typeof quota.notes === 'string' && quota.notes && (
                    <p className="quota-notes">{quota.notes}</p>
                  )}
                  <button className="text-button" onClick={() => void removeQuota(String(quota.id))}>
                    Remove envelope
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-inline">No manual quota envelopes configured.</div>
        )}
      </section>
      <div className="usage-footnote">
        <Shield size={14} />
        <span>
          Actual metered spend is PROVIDER MEASURED where the provider reports it. API-equivalent values use
          exact public model prices with measured tokens; they are ESTIMATED and are not billed spend.
          Unavailable metrics are never shown as zero. Quota forecasts use USER CONFIGURED limits plus this
          master’s recorded usage.
        </span>
      </div>
    </main>
  );
}
