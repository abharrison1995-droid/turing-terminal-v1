// Settings cards for OpenRouter connection profiles and metered budgets.

import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, RefreshCw, Shield } from 'lucide-react';
import type { MeteredBudgetSettings, ProviderSpendTelemetry } from '../../../shared/types';
import { SettingsCard } from '../shared/SettingsCard';
import { systemTimeZone } from '../../../shared/timezone';
import { api, type BudgetStatus, type ConnectionProfileWithCredentials } from '../../api';

/* ───────────────────────── Settings: OpenRouter + budgets ───────────────────────── */

export function OpenRouterSettings({
  onNotice,
  openSignal,
}: {
  onNotice: (message: string) => void;
  openSignal?: number;
}) {
  const [profiles, setProfiles] = useState<ConnectionProfileWithCredentials[]>([]);
  const [name, setName] = useState('OpenRouter');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [telemetry, setTelemetry] = useState<ProviderSpendTelemetry[]>([]);
  const [telemetryErrors, setTelemetryErrors] = useState<string[]>([]);
  const load = () =>
    api
      .connectionProfiles()
      .then((result) => setProfiles(result.profiles.filter((profile) => profile.backendId === 'openrouter')))
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  const create = async () => {
    try {
      await api.saveConnectionProfile({
        name: name.trim(),
        backendId: 'openrouter',
        providerId: 'openrouter',
        billingLane: 'openrouter-metered',
        credentialStoreRef: null,
        metadata: {},
      });
      onNotice(
        'OpenRouter connection added. It is unused until you explicitly select it on a stage or Decision Gate.',
      );
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Connection could not be saved.');
    }
  };
  const store = async (profileId: string, kind: 'inference' | 'management') => {
    const value = secrets[`${profileId}:${kind}`]?.trim();
    if (!value) return;
    try {
      await api.setCredential(profileId, kind, value);
      setSecrets((current) => ({ ...current, [`${profileId}:${kind}`]: '' }));
      onNotice(
        `${kind === 'inference' ? 'Inference' : 'Management'} key stored on this desktop. It is never shown again or sent to mobile.`,
      );
      await load();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Credential could not be stored.');
    }
  };
  const refreshTelemetry = async () => {
    try {
      const result = await api.openRouterTelemetry();
      setTelemetry(result.telemetry);
      setTelemetryErrors(result.errors);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Telemetry could not be loaded.');
    }
  };
  const money = (value: number | null) => (value === null ? 'Unavailable' : `$${value.toFixed(4)}`);
  const openRouterSummary =
    profiles.length === 0
      ? 'No connection added'
      : `${profiles.length} ${profiles.length === 1 ? 'connection' : 'connections'}${telemetryErrors.length ? ' · telemetry error' : ''}`;
  return (
    <section className="surface-panel settings-section" aria-label="OpenRouter">
      <SettingsCard
        id="openrouter"
        openSignal={openSignal}
        summary={openRouterSummary}
        defaultOpen={true}
        attention={telemetryErrors.length > 0}
        head={
          <div className="panel-title-row">
            <div>
              <h2>OpenRouter (optional, metered)</h2>
              <p>
                Adding a connection changes no workflow, adds no Decision Gate, and enables no spending. Keys
                stay in desktop storage and never reach agents, prompts, exports, logs, or phones.
              </p>
            </div>
            <KeyRound size={16} className="muted-icon" />
          </div>
        }
      >
        <div className="field-row">
          <label className="form-field">
            <span>Connection name</span>
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </label>
          <button className="secondary-button" disabled={!name.trim()} onClick={() => void create()}>
            Add OpenRouter connection
          </button>
        </div>
        {profiles.map((profile) => (
          <article className="quota-envelope-card" key={profile.id}>
            <div className="quota-envelope-heading">
              <div>
                <strong>{profile.name}</strong>
                <small>
                  Inference key {profile.credentials?.inference ? 'stored' : 'not stored'} · management key{' '}
                  {profile.credentials?.management
                    ? 'stored (account telemetry only)'
                    : 'not stored (optional)'}
                </small>
              </div>
            </div>
            <div className="form-grid-two">
              {(['inference', 'management'] as const).map((kind) => (
                <label className="form-field" key={kind}>
                  <span>
                    {kind === 'inference'
                      ? 'Inference key'
                      : 'Management key (optional, never used for inference)'}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={secrets[`${profile.id}:${kind}`] ?? ''}
                    onChange={(event) =>
                      setSecrets((current) => ({ ...current, [`${profile.id}:${kind}`]: event.target.value }))
                    }
                    placeholder={
                      profile.credentials?.[kind] ? 'Stored · enter a new value to replace' : 'sk-or-…'
                    }
                  />
                  <span className="stage-actions-row">
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => void store(profile.id, kind)}
                    >
                      Store
                    </button>
                    {profile.credentials?.[kind] && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void api.deleteCredential(profile.id, kind).then(load)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </article>
        ))}
        {profiles.length > 0 && (
          <>
            <button className="quiet-button" onClick={() => void refreshTelemetry()}>
              <RefreshCw size={13} />
              Read key usage (no generation)
            </button>
            {telemetryErrors.map((error) => (
              <p className="form-error" key={error}>
                <AlertTriangle size={14} />
                {error}
              </p>
            ))}
            {telemetry.map((item) => (
              <div className="quota-envelope-values" key={`${item.scope}-${item.connectionProfileId}`}>
                <span>
                  {item.scope === 'key' ? 'KEY-LEVEL' : 'ACCOUNT-LEVEL'} <strong>PROVIDER MEASURED</strong>
                  <small>{new Date(item.observedAt).toLocaleString()}</small>
                </span>
                {item.scope === 'key' ? (
                  <>
                    <span>
                      Today (UTC) <strong>{money(item.usageDailyUsd)}</strong>
                    </span>
                    <span>
                      This week <strong>{money(item.usageWeeklyUsd)}</strong>
                    </span>
                    <span>
                      This month <strong>{money(item.usageMonthlyUsd)}</strong>
                    </span>
                    <span>
                      OpenRouter key cap{' '}
                      <strong>{item.limitUsd === null ? 'No key limit' : money(item.limitUsd)}</strong>
                      <small>Reset {item.limitReset ?? 'never'}</small>
                    </span>
                    <span>
                      OpenRouter remaining{' '}
                      <strong>
                        {item.limitUsd === null ? 'Unlimited key' : money(item.limitRemainingUsd)}
                      </strong>
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      Account credits remaining <strong>{money(item.accountCreditsUsd)}</strong>
                    </span>
                    <span>
                      Account usage <strong>{money(item.accountUsageUsd)}</strong>
                    </span>
                  </>
                )}
              </div>
            ))}
            <p className="quiet-note">
              Turing never changes OpenRouter key limits. Provider-enforced limits are set in your OpenRouter
              account and are separate from Turing budgets.
            </p>
          </>
        )}
      </SettingsCard>
    </section>
  );
}

export function MeteredBudgetSettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<MeteredBudgetSettings | null>(null);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [zone, setZone] = useState(systemTimeZone());
  useEffect(() => {
    void api
      .budgets()
      .then((result) => {
        setSettings(result.settings);
        setStatus(result.status);
        setZone(result.systemTimeZone);
      })
      .catch(() => undefined);
  }, []);
  if (!settings) return null;
  const save = async () => {
    try {
      const result = await api.saveBudgets({
        dailyUsd: settings.dailyUsd,
        monthlyUsd: settings.monthlyUsd,
        warningRatio: settings.warningRatio,
        timezone: settings.timezone,
      });
      setSettings(result.settings);
      onNotice('Turing metered budgets saved.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Budgets could not be saved.');
    }
  };
  const money = (value: number) => `$${value.toFixed(4)}`;
  const budgetSummary = `${settings.dailyUsd === null ? 'No daily cap' : `$${settings.dailyUsd.toFixed(2)} daily cap`} · ${settings.monthlyUsd === null ? 'no monthly cap' : `$${settings.monthlyUsd.toFixed(2)} monthly cap`}`;
  return (
    <section className="surface-panel settings-section" aria-label="Metered budgets">
      <SettingsCard
        id="metered-budgets"
        summary={budgetSummary}
        defaultOpen={false}
        head={
          <div className="panel-title-row">
            <div>
              <h2>Turing metered budgets</h2>
              <p>
                Hard caps across all runs, enforced by atomic reservation before each metered request.
                Separate from provider key limits.
              </p>
            </div>
            <Shield size={16} className="muted-icon" />
          </div>
        }
      >
        <div className="form-grid-two">
          <label className="form-field small-number-field">
            <span>Daily cap (USD)</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={settings.dailyUsd ?? ''}
              placeholder="No daily cap"
              onChange={(event) =>
                setSettings({
                  ...settings,
                  dailyUsd: event.target.value === '' ? null : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Monthly cap (USD)</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={settings.monthlyUsd ?? ''}
              placeholder="No monthly cap"
              onChange={(event) =>
                setSettings({
                  ...settings,
                  monthlyUsd: event.target.value === '' ? null : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Warn at (% of cap)</span>
            <input
              type="number"
              min={10}
              max={100}
              value={Math.round(settings.warningRatio * 100)}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  warningRatio: Math.min(1, Math.max(0.1, Number(event.target.value) / 100)),
                })
              }
            />
          </label>
          <label className="form-field">
            <span>Budget day boundary timezone</span>
            <input
              value={settings.timezone ?? ''}
              placeholder={`System: ${zone}`}
              onChange={(event) => setSettings({ ...settings, timezone: event.target.value || null })}
            />
          </label>
        </div>
        {status && (
          <p className="quiet-note">
            Committed today {money(status.daily.committedUsd)}
            {status.daily.capUsd !== null ? ` of $${status.daily.capUsd.toFixed(2)}` : ''} · this month{' '}
            {money(status.monthly.committedUsd)}
            {status.monthly.capUsd !== null ? ` of $${status.monthly.capUsd.toFixed(2)}` : ''} (
            {status.timeZone}). Committed = active reservations + reconciled actual spend.
          </p>
        )}
        <button className="primary-button" onClick={() => void save()}>
          Save budgets
        </button>
      </SettingsCard>
    </section>
  );
}
