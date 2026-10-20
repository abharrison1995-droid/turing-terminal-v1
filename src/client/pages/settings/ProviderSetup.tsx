import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, LockKeyhole, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { billingLaneLabel, billingLanesForBackend, routeMatchesBillingLane } from '../../../shared/billing';
import {
  PROVIDER_INSTRUCTIONS_VERIFIED_ON,
  PROVIDER_SERVICES,
  connectionProfileForService,
  planLabelOf,
  providerServiceById,
  providerServiceForRoute,
  routeReadiness,
  type ProviderService,
  type ProviderServiceId,
} from '../../../shared/providerServices';
import type { BillingLane, ProviderStatus, WorkflowDefinition } from '../../../shared/types';
import { api, type ConnectionProfileWithCredentials } from '../../api';
import { CommandBlock } from '../shared/CommandBlock';
import { ReadinessLines } from '../shared/ReadinessLines';
import { SettingsCard } from '../shared/SettingsCard';
import { humanize } from '../shared/runStatus';

export const PROVIDERS_CARD_ID = 'providers-connections';

/** Stages and defaults in saved workflows that reference a connection, so removing one is never a surprise. */
export function connectionUsage(
  connectionId: string,
  workflows: readonly WorkflowDefinition[],
): { stages: number; workflows: number } {
  let stages = 0;
  const touched = new Set<string>();
  for (const workflow of workflows) {
    const uses = (value: { connectionProfileId?: string } | undefined) =>
      value?.connectionProfileId === connectionId;
    let count = 0;
    if (uses(workflow.defaultModelConfiguration)) count += 1;
    for (const configuration of Object.values(workflow.stageDefaults ?? {}))
      if (uses(configuration)) count += 1;
    for (const stage of workflow.stages) {
      if (uses(stage)) count += 1;
      if (stage.decision?.connectionProfileId === connectionId) count += 1;
      if (stage.decision?.escalation?.connectionProfileId === connectionId) count += 1;
    }
    if (count) {
      stages += count;
      touched.add(workflow.id);
    }
  }
  return { stages, workflows: touched.size };
}

export function ProviderSetup({
  providers: discoveredProviders,
  workflows,
  onNotice,
  onChanged,
  intentServiceId,
  openSignal,
}: {
  providers: ProviderStatus[];
  workflows: WorkflowDefinition[];
  onNotice: (message: string) => void;
  onChanged: () => void;
  intentServiceId?: ProviderServiceId;
  openSignal?: number;
}) {
  const [checkedProviders, setCheckedProviders] = useState<ProviderStatus[] | null>(null);
  const providers = checkedProviders ?? discoveredProviders;
  const [connections, setConnections] = useState<ConnectionProfileWithCredentials[]>([]);
  const [loadError, setLoadError] = useState('');
  const [serviceId, setServiceId] = useState<ProviderServiceId | ''>(intentServiceId ?? '');
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');
  const [name, setName] = useState('');
  const [planLabel, setPlanLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPlan, setEditPlan] = useState('');
  const flowRef = useRef<HTMLDivElement>(null);

  const loadConnections = () =>
    api
      .connectionProfiles()
      .then((response) => {
        setConnections(response.profiles);
        setLoadError('');
      })
      .catch((error) =>
        setLoadError(error instanceof Error ? error.message : 'Connections could not be loaded.'),
      );
  useEffect(() => {
    void loadConnections();
  }, []);

  const service = serviceId ? providerServiceById(serviceId) : undefined;
  useEffect(() => {
    if (intentServiceId) {
      setServiceId(intentServiceId);
      window.requestAnimationFrame(() => flowRef.current?.scrollIntoView?.({ block: 'start' }));
    }
  }, [intentServiceId, openSignal]);
  useEffect(() => {
    if (service) {
      setName(service.defaultConnectionName);
      setPlanLabel('');
    }
  }, [serviceId]);

  const provider = service ? providers.find((item) => item.id === service.backendId) : undefined;
  const readiness = useMemo(
    () => (service ? routeReadiness(service.backendId, service.providerId, provider) : null),
    [service, provider],
  );

  const checkAgain = async () => {
    setChecking(true);
    setCheckNote('');
    try {
      const response = await api.refreshProviders();
      setCheckedProviders(response.providers);
      setCheckNote('Checked just now. No prompt was sent to any model.');
      onChanged();
    } catch (error) {
      setCheckNote(
        error instanceof Error
          ? `${error.message} The previous status is still shown.`
          : 'The check failed. The previous status is still shown.',
      );
    } finally {
      setChecking(false);
    }
  };

  const duplicateName = connections.some(
    (connection) => connection.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  const saveConnection = async () => {
    if (!service) return;
    setSaving(true);
    try {
      const response = await api.saveConnectionProfile(
        connectionProfileForService(service, { name, planLabel }),
      );
      setConnections((current) => [...current, response.profile]);
      onNotice(
        `Connection “${response.profile.name}” saved. It records the route only: it does not sign you in or change which account ${service.label} uses.`,
      );
      setServiceId('');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Connection could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const removeConnection = async (id: string) => {
    try {
      await api.deleteConnectionProfile(id);
      setConnections((current) => current.filter((connection) => connection.id !== id));
      setConfirmRemove(null);
      onNotice(
        'Connection removed. Stages that used it show “connection no longer exists” until you choose another.',
      );
      onChanged();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Connection could not be removed.');
    }
  };

  const saveEdit = async (connection: ConnectionProfileWithCredentials) => {
    try {
      const { id, createdAt, updatedAt, credentials, ...body } = connection;
      void id;
      void createdAt;
      void updatedAt;
      void credentials;
      const label = editPlan.trim();
      const metadata = { ...body.metadata };
      if (label) metadata.planLabel = label;
      else delete metadata.planLabel;
      const response = await api.saveConnectionProfile(
        { ...body, name: editName.trim() || connection.name, metadata },
        connection.id,
      );
      setConnections((current) =>
        current.map((item) => (item.id === connection.id ? { ...item, ...response.profile } : item)),
      );
      setEditing(null);
      onNotice('Connection updated.');
      onChanged();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Connection could not be updated.');
    }
  };

  const detected = providers.filter((item) => item.detected).length;
  const summary = `${connections.length} saved ${connections.length === 1 ? 'connection' : 'connections'} · ${detected} of ${providers.length} CLIs detected`;

  return (
    <SettingsCard
      id={PROVIDERS_CARD_ID}
      summary={summary}
      defaultOpen={true}
      openSignal={openSignal}
      head={
        <div className="panel-title-row">
          <div>
            <h2>Providers &amp; connections</h2>
            <p>Connect a subscription, then reuse it in any workflow stage.</p>
          </div>
          <LockKeyhole size={17} className="muted-icon" />
        </div>
      }
    >
      <p className="setup-boundary">
        <LockKeyhole size={14} aria-hidden="true" /> Sign-in and credentials stay on the Desktop Master,
        inside each provider’s own command line. A saved connection is only a reusable reference to a route.
        It does not sign you in, store a secret, or switch the account a command line is using.
      </p>

      <section aria-labelledby="saved-connections-title" className="setup-block">
        <h3 id="saved-connections-title">Saved connections</h3>
        {loadError && (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        )}
        {connections.length === 0 && !loadError && (
          <p className="quiet-note">None yet. Connect one of the services below to reuse it in workflows.</p>
        )}
        <ul className="connection-list">
          {connections.map((connection) => {
            const known = providerServiceForRoute(
              connection.backendId,
              connection.providerId,
              connection.billingLane,
            );
            const route = routeReadiness(
              connection.backendId,
              connection.providerId,
              providers.find((item) => item.id === connection.backendId),
            );
            const usage = connectionUsage(connection.id, workflows);
            const label = planLabelOf(connection);
            return (
              <li className="connection-row" key={connection.id}>
                <div className="connection-row-main">
                  <strong>{connection.name}</strong>
                  <small>
                    {known?.label ?? 'Custom route'} · {connection.backendId} / {connection.providerId} ·{' '}
                    {billingLaneLabel(connection.billingLane)}
                  </small>
                  {label && <small>Plan label you entered: {label} (not verified)</small>}
                  {connection.credentials && (
                    <small>
                      Inference key{' '}
                      {connection.credentials.inference ? 'stored on the Desktop Master' : 'not stored'}
                    </small>
                  )}
                  <small>
                    CLI {route.installation.label.toLowerCase()} · sign-in{' '}
                    {route.authentication.label.toLowerCase()}
                    {' · '}used by {usage.stages} {usage.stages === 1 ? 'setting' : 'settings'} in{' '}
                    {usage.workflows} {usage.workflows === 1 ? 'workflow' : 'workflows'}
                  </small>
                </div>
                {editing === connection.id ? (
                  <div className="connection-row-edit">
                    <label className="form-field">
                      <span>Name</span>
                      <input
                        value={editName}
                        maxLength={100}
                        onChange={(event) => setEditName(event.target.value)}
                      />
                    </label>
                    <label className="form-field">
                      <span>Plan label (optional, not verified)</span>
                      <input
                        value={editPlan}
                        maxLength={60}
                        onChange={(event) => setEditPlan(event.target.value)}
                      />
                    </label>
                    <div className="stage-actions-row">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void saveEdit(connection)}
                      >
                        <Save size={14} aria-hidden="true" /> Save changes
                      </button>
                      <button type="button" className="quiet-button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : confirmRemove === connection.id ? (
                  <div className="connection-row-edit" role="group" aria-label={`Remove ${connection.name}`}>
                    <p>
                      Remove “{connection.name}”?{' '}
                      {usage.stages
                        ? `${usage.stages} workflow ${usage.stages === 1 ? 'setting uses' : 'settings use'} it and will need another connection.`
                        : 'No workflow uses it.'}{' '}
                      This does not sign out of the provider.
                    </p>
                    <div className="stage-actions-row">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void removeConnection(connection.id)}
                      >
                        <Trash2 size={14} aria-hidden="true" /> Remove connection
                      </button>
                      <button type="button" className="quiet-button" onClick={() => setConfirmRemove(null)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="connection-row-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => {
                        setEditing(connection.id);
                        setEditName(connection.name);
                        setEditPlan(label ?? '');
                      }}
                      aria-label={`Edit ${connection.name}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => setConfirmRemove(connection.id)}
                      aria-label={`Remove ${connection.name}`}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="connect-service-title" className="setup-block" ref={flowRef}>
        <h3 id="connect-service-title">Connect a service</h3>
        <fieldset className="service-choices">
          <legend>Step 1 · Choose a service</legend>
          {PROVIDER_SERVICES.map((item) => (
            <label
              className={`service-choice ${serviceId === item.id ? 'service-choice-selected' : ''}`}
              key={item.id}
            >
              <input
                type="radio"
                name="provider-service"
                value={item.id}
                checked={serviceId === item.id}
                onChange={() => setServiceId(item.id)}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.summary}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {service && readiness && (
          <ol className="setup-steps" aria-label={`${service.label} setup steps`}>
            <li>
              <h4>Step 2 · Check the installation</h4>
              <p className="quiet-note">{service.install.note}</p>
              {service.install.commands.map((item) => (
                <CommandBlock key={item.command} label={item.label} command={item.command} />
              ))}
              <p className="setup-docs">
                <a href={service.install.docsUrl} target="_blank" rel="noreferrer noopener">
                  Official instructions <ExternalLink size={12} aria-hidden="true" />
                </a>
              </p>
              <ReadinessLines readiness={readiness} only={['installation']} />
            </li>
            <li>
              <h4>Step 3 · Sign in on the Desktop Master</h4>
              <ol className="setup-instruction-list">
                {service.signIn.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {service.signIn.commands.map((item) => (
                <CommandBlock key={item.command} label={item.label} command={item.command} />
              ))}
              <p className="quiet-note">{service.signIn.note}</p>
              <p className="setup-docs">
                <a href={service.signIn.docsUrl} target="_blank" rel="noreferrer noopener">
                  Official sign-in instructions <ExternalLink size={12} aria-hidden="true" />
                </a>
              </p>
              <p className="quiet-note">
                Turing never runs these commands and never asks for your password, key or token. Instructions
                checked against the official documentation on {PROVIDER_INSTRUCTIONS_VERIFIED_ON}.
              </p>
            </li>
            <li>
              <h4>Step 4 · Check the connection</h4>
              <ReadinessLines readiness={readiness} />
              <p className="quiet-note">{service.checks.authentication}</p>
              <p className="quiet-note">{service.checks.catalogue}</p>
              {service.limits.map((limit) => (
                <p className="quiet-note" key={limit}>
                  {limit}
                </p>
              ))}
              <div className="stage-actions-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void checkAgain()}
                  disabled={checking}
                  aria-busy={checking}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  {checking ? 'Checking…' : 'Check again'}
                </button>
              </div>
              <p className="quiet-note" role="status">
                {checkNote}
              </p>
            </li>
            <li>
              <h4>Step 5 · Save a reusable connection</h4>
              <div className="form-grid-two">
                <label className="form-field">
                  <span>Connection name</span>
                  <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
                  {duplicateName && <small>A connection with this name already exists.</small>}
                </label>
                <label className="form-field">
                  <span>Plan label (optional)</span>
                  <input
                    value={planLabel}
                    maxLength={60}
                    placeholder={service.planLabelExample}
                    onChange={(event) => setPlanLabel(event.target.value)}
                  />
                  <small>Your own note. Turing cannot verify your plan and shows this as unverified.</small>
                </label>
              </div>
              <p className="quiet-note">
                Saves the route {service.backendId} · {service.providerId} ·{' '}
                {billingLaneLabel(service.billingLane)}. No credential is saved.
              </p>
              {!readiness.canSave && readiness.saveBlocker && (
                <p className="setup-blocker" role="status">
                  {readiness.saveBlocker}
                </p>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={!readiness.canSave || !name.trim() || saving}
                onClick={() => void saveConnection()}
              >
                <Plus size={14} aria-hidden="true" />
                {saving ? 'Saving…' : 'Save connection'}
              </button>
            </li>
          </ol>
        )}
      </section>

      <CustomRoute
        providers={providers}
        connections={connections}
        onSaved={(profile) => setConnections((current) => [...current, profile])}
        onNotice={onNotice}
      />

      <details className="settings-disclosure">
        <summary>
          Detected command line tools
          <small>
            {detected} of {providers.length} detected
          </small>
        </summary>
        {providers.map((item) => (
          <div className="settings-provider-row" key={item.id}>
            <span className={`provider-mark provider-mark-${item.id}`}>{item.name.slice(0, 1)}</span>
            <div>
              <strong>{item.name}</strong>
              <small>
                {item.detected
                  ? `${item.version ?? item.cli} · auth ${item.authentication}`
                  : 'CLI not detected'}
              </small>
              <p>{item.note}</p>
              <p className="capability-line">
                Supports:{' '}
                {Object.entries(item.capabilities)
                  .filter(([, enabled]) => enabled)
                  .map(([key]) => humanize(key).toLowerCase())
                  .join(', ') || 'nothing reported'}
              </p>
            </div>
          </div>
        ))}
      </details>
    </SettingsCard>
  );
}

function CustomRoute({
  providers,
  connections,
  onSaved,
  onNotice,
}: {
  providers: ProviderStatus[];
  connections: ConnectionProfileWithCredentials[];
  onSaved: (profile: ConnectionProfileWithCredentials) => void;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [backendId, setBackendId] = useState('opencode');
  const [providerId, setProviderId] = useState('opencode-go');
  const [lane, setLane] = useState<BillingLane>('opencode-go-subscription');
  const lanes = billingLanesForBackend(backendId);
  const valid = routeMatchesBillingLane(backendId, providerId.trim(), lane);
  const known = providerServiceForRoute(backendId, providerId.trim(), lane);
  const save = async () => {
    try {
      const response = await api.saveConnectionProfile({
        name: name.trim(),
        backendId,
        providerId: providerId.trim(),
        billingLane: lane,
        credentialStoreRef: null,
        metadata: {},
      });
      onSaved(response.profile);
      setName('');
      onNotice('Custom connection saved. It records the route only; sign-in stays in the provider CLI.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Connection could not be saved.');
    }
  };
  return (
    <details className="settings-disclosure custom-route">
      <summary>
        Advanced · custom route
        <small>Choose the backend, provider and billing lane yourself</small>
      </summary>
      <div className="form-grid-two">
        <label className="form-field">
          <span>Connection name</span>
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="form-field">
          <span>Execution backend</span>
          <select
            value={backendId}
            onChange={(event) => {
              setBackendId(event.target.value);
              setLane(billingLanesForBackend(event.target.value)[0] ?? 'unknown');
            }}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Provider ID</span>
          <input value={providerId} maxLength={80} onChange={(event) => setProviderId(event.target.value)} />
        </label>
        <label className="form-field">
          <span>Billing lane</span>
          <select value={lane} onChange={(event) => setLane(event.target.value as BillingLane)}>
            {lanes.map((item) => (
              <option key={item} value={item}>
                {billingLaneLabel(item)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!valid && providerId.trim() && (
        <p className="setup-blocker" role="status">
          {backendId} cannot bill provider “{providerId.trim()}” through {billingLaneLabel(lane)}. The Desktop
          Master will refuse this route.
        </p>
      )}
      {known && (
        <p className="quiet-note">
          This is the {known.label} route. Using the guided flow above shows its checks.
        </p>
      )}
      {connections.some((connection) => connection.name === name.trim()) && (
        <p className="quiet-note">A connection with this name already exists.</p>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={!name.trim() || !providerId.trim() || !valid}
        onClick={() => void save()}
      >
        <Plus size={14} aria-hidden="true" /> Save custom connection
      </button>
    </details>
  );
}

export type { ProviderService };
