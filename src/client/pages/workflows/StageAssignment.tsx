import { useState } from 'react';
import { AlertTriangle, ExternalLink, RefreshCw, Save } from 'lucide-react';
import { billingLaneLabel, billingLanesForBackend, inferBillingLane } from '../../../shared/billing';
import { providerServiceForRoute } from '../../../shared/providerServices';
import type {
  BillingLane,
  ConnectionProfile,
  ModelConfiguration,
  ModelPreset,
  ProviderStatus,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';
import { ModelSettingsFields, ModelStatusLine } from '../../phase36';
import {
  applyConnectionPatch,
  connectionChangeImpact,
  hasStageOverride,
  inheritPatch,
  manualModelPatch,
  modelCompatibility,
  modelSelectionPatch,
  modelsForRoute,
  resolveAssignment,
  sourceLabel,
  type ConnectionChangeImpact,
  type ValueSource,
} from './assignment';
import type { StageIssue } from './stageIssues';

const SOURCE_CLASS: Record<ValueSource, string> = {
  stage: 'source-chip-override',
  'stage-default': 'source-chip-inherited',
  'workflow-default': 'source-chip-inherited',
  unset: 'source-chip-unset',
};

export function SourceChip({ source }: { source: ValueSource }) {
  return <span className={`source-chip ${SOURCE_CLASS[source]}`}>{sourceLabel(source)}</span>;
}

/** Shown before a connection change that would leave the current model without a verified home. The person decides. */
export function ConnectionImpactPanel({
  connectionName,
  impact,
  modelId,
  affected,
  onKeep,
  onClear,
  onCancel,
}: {
  connectionName: string;
  impact: ConnectionChangeImpact;
  modelId?: string;
  /** Other assignments that follow the setting being changed, so the effect is visible before it happens. */
  affected?: string[];
  onKeep: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="assignment-impact" role="group" aria-label="Changing connection affects this assignment">
      <strong>Changing to “{connectionName}” affects this assignment</strong>
      <ul>
        {impact.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {affected && affected.length > 0 && <li>Also used by: {affected.join(', ')}.</li>}
      </ul>
      <div className="stage-actions-row">
        {impact.canKeepModel && (
          <button type="button" className="secondary-button" onClick={onKeep}>
            Keep {modelId ?? 'current settings'}
          </button>
        )}
        <button type="button" className="secondary-button" onClick={onClear}>
          Choose another model
        </button>
        <button type="button" className="quiet-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface PendingChange {
  connection: ConnectionProfile;
  impact: ConnectionChangeImpact;
  custom: boolean;
}

/**
 * The normal path for an AI stage: choose a saved connection, choose a model that connection can offer, then adjust the
 * reasoning or variant the model supports. Every value says whether it is inherited or overridden. Nothing is replaced
 * silently: a connection change that would orphan the model is shown first and the person decides.
 */
export function StageAssignment({
  stage,
  workflow,
  providers,
  connections,
  presets,
  issues,
  refreshing,
  onChange,
  onRefreshModels,
  onSavePreset,
  onPromoteToDefault,
  onOpenProviders,
}: {
  stage: WorkflowStage;
  workflow: WorkflowDefinition;
  providers: ProviderStatus[];
  connections: ConnectionProfile[];
  presets: ModelPreset[];
  issues: StageIssue[];
  refreshing: boolean;
  onChange: (patch: Partial<WorkflowStage>) => void;
  onRefreshModels: () => void;
  onSavePreset: (name: string, configuration: ModelConfiguration) => void;
  onPromoteToDefault: (kind: WorkflowStage['kind'], configuration: ModelConfiguration) => void;
  onOpenProviders: () => void;
}) {
  const { configuration, sources } = resolveAssignment(workflow, stage);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [manual, setManual] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [customRoute, setCustomRoute] = useState({
    backendId: configuration.backendId ?? 'opencode',
    providerId: configuration.providerId ?? '',
    billingLane: (configuration.billingLane ?? 'unknown') as BillingLane,
  });
  const connection = connections.find((item) => item.id === configuration.connectionProfileId);
  const { backend, models, discovery } = modelsForRoute(
    providers,
    configuration.backendId,
    configuration.providerId,
  );
  const selectedModel = models.find((model) => model.id === configuration.modelId);
  const routeChosen = Boolean(configuration.backendId && configuration.providerId);
  const compatibility = modelCompatibility(
    providers,
    configuration.backendId,
    configuration.providerId,
    configuration.modelId,
  );
  const service = providerServiceForRoute(
    configuration.backendId,
    configuration.providerId,
    configuration.billingLane,
  );
  const issuesFor = (fix: StageIssue['fix']) => issues.filter((issue) => issue.fix === fix);
  const showManual = manual || !discovery || compatibility === 'not-listed';
  const complete = Boolean(routeChosen && configuration.modelId);
  const fieldId = `assign-${stage.id}`;

  const chooseConnection = (id: string) => {
    if (!id) return;
    const next = connections.find((item) => item.id === id);
    if (!next) return;
    const impact = connectionChangeImpact(configuration, next, providers, connection);
    if (impact.needsDecision) setPending({ connection: next, impact, custom: false });
    else onChange(applyConnectionPatch(next, impact));
  };
  const applyCustomRoute = () => {
    const synthetic: ConnectionProfile = {
      id: '',
      name: 'Custom route',
      backendId: customRoute.backendId,
      providerId: customRoute.providerId.trim(),
      billingLane: customRoute.billingLane,
      credentialStoreRef: null,
      metadata: {},
      createdAt: '',
      updatedAt: '',
    };
    const impact = connectionChangeImpact(configuration, synthetic, providers, connection);
    if (impact.needsDecision) setPending({ connection: synthetic, impact, custom: true });
    else onChange({ ...applyConnectionPatch(synthetic, impact), connectionProfileId: undefined });
  };
  const resolvePending = (mode: 'keep' | 'clear-model') => {
    if (!pending) return;
    const patch = applyConnectionPatch(pending.connection, pending.impact, mode);
    onChange(pending.custom ? { ...patch, connectionProfileId: undefined } : patch);
    setPending(null);
  };
  const routeOption = !connection && routeChosen;

  return (
    <fieldset className="assignment" aria-labelledby={`${fieldId}-title`}>
      <legend id={`${fieldId}-title`}>Connection and model</legend>

      <div className="assignment-field form-field">
        <div className="assignment-label">
          <label htmlFor={`${fieldId}-connection`}>Connection</label>
          <SourceChip source={sources.connection} />
        </div>
        <select
          id={`${fieldId}-connection`}
          value={connection?.id ?? ''}
          onChange={(event) => chooseConnection(event.target.value)}
          aria-describedby={`${fieldId}-connection-help`}
        >
          <option value="" disabled>
            {routeOption ? 'No saved connection · route set by hand' : 'Choose a saved connection'}
          </option>
          {connections.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name} · {billingLaneLabel(item.billingLane)}
            </option>
          ))}
        </select>
        <small id={`${fieldId}-connection-help`}>
          {connection
            ? `${service?.label ?? 'Custom route'} · ${connection.backendId} / ${connection.providerId}. A connection is a saved route, not a sign-in.`
            : routeOption
              ? `Route ${configuration.backendId} / ${configuration.providerId} · ${billingLaneLabel(configuration.billingLane ?? inferBillingLane(configuration.backendId, configuration.providerId))} is not tied to a saved connection.`
              : 'Pick the connection this stage should use.'}{' '}
          <button type="button" className="link-button" onClick={onOpenProviders}>
            Set up providers <ExternalLink size={12} aria-hidden="true" />
          </button>
        </small>
        {connections.length === 0 && (
          <p className="inline-callout" role="note">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>No saved connections yet. Connect a subscription in Settings; your draft is kept.</span>
          </p>
        )}
        {issuesFor('connection').map((issue) => (
          <p
            className={`assignment-issue assignment-issue-${issue.severity}`}
            role="alert"
            key={issue.message}
          >
            <AlertTriangle size={13} aria-hidden="true" /> {issue.message}
          </p>
        ))}
      </div>

      {pending && (
        <ConnectionImpactPanel
          connectionName={pending.connection.name}
          impact={pending.impact}
          modelId={configuration.modelId}
          onKeep={() => resolvePending('keep')}
          onClear={() => resolvePending('clear-model')}
          onCancel={() => setPending(null)}
        />
      )}

      <div className="assignment-field form-field">
        <div className="assignment-label">
          <label htmlFor={`${fieldId}-model`}>Model</label>
          <SourceChip source={sources.model} />
        </div>
        {!showManual && (
          <select
            id={`${fieldId}-model`}
            value={configuration.modelId ?? ''}
            disabled={!routeChosen}
            onChange={(event) => {
              const model = models.find((item) => item.id === event.target.value);
              if (model) onChange(modelSelectionPatch(model, configuration, backend));
            }}
            aria-describedby={`${fieldId}-model-help`}
          >
            <option value="" disabled>
              {routeChosen ? 'Choose a model' : 'Choose a connection first'}
            </option>
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
              </option>
            ))}
          </select>
        )}
        {showManual && (
          <input
            id={`${fieldId}-model`}
            value={configuration.modelId ?? ''}
            disabled={!routeChosen}
            maxLength={180}
            spellCheck={false}
            placeholder={routeChosen ? 'Exact model ID' : 'Choose a connection first'}
            onChange={(event) => onChange(manualModelPatch(event.target.value))}
            aria-describedby={`${fieldId}-model-help`}
          />
        )}
        <small id={`${fieldId}-model-help`}>
          {!routeChosen
            ? 'Models depend on the connection.'
            : showManual
              ? compatibility === 'not-listed'
                ? `Typed by hand and not listed for this connection. ${backend?.name ?? 'The backend'} may reject it at run time.`
                : discovery
                  ? 'Typed by hand. It is sent exactly as written; Turing does not check it against the catalogue.'
                  : `${backend?.name ?? 'This backend'} reports no model catalogue, so the ID is typed by hand, sent exactly as written and not verified.`
              : `${models.length} ${models.length === 1 ? 'model' : 'models'} listed for this connection${backend?.catalogSource === 'cache' ? ' (last known)' : ''}.`}
        </small>
        <ModelStatusLine
          backendId={configuration.backendId}
          modelId={configuration.modelId}
          model={selectedModel}
          snapshot={stage.modelSnapshot}
          catalogSource={backend?.capabilities.modelDiscovery ? backend.catalogSource : undefined}
        />
        <div className="stage-actions-row">
          {discovery && (
            <button type="button" className="quiet-button" onClick={() => setManual((value) => !value)}>
              {showManual && compatibility !== 'not-listed' ? 'Choose from the list' : 'Enter an ID by hand'}
            </button>
          )}
          <button type="button" className="quiet-button" onClick={onRefreshModels} disabled={refreshing}>
            <RefreshCw size={13} aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh models'}
          </button>
        </div>
        {issuesFor('model').map((issue) => (
          <p
            className={`assignment-issue assignment-issue-${issue.severity}`}
            role="alert"
            key={issue.message}
          >
            <AlertTriangle size={13} aria-hidden="true" /> {issue.message}
          </p>
        ))}
      </div>

      {complete && (
        <div className="assignment-settings">
          <ModelSettingsFields
            backendId={configuration.backendId}
            model={selectedModel}
            reasoning={configuration.reasoning}
            variantId={configuration.variantId}
            nativeSettings={configuration.nativeSettings}
            onChange={onChange}
          />
          {(configuration.reasoning || configuration.variantId) && (
            <p className="assignment-sources">
              {configuration.reasoning && (
                <span>
                  Reasoning <SourceChip source={sources.reasoning} />
                </span>
              )}
              {configuration.variantId && (
                <span>
                  Variant <SourceChip source={sources.variant} />
                </span>
              )}
            </p>
          )}
        </div>
      )}

      <details className="settings-disclosure">
        <summary>
          Exact route and model ID
          <small>
            {complete
              ? `${configuration.backendId} · ${configuration.providerId} · ${configuration.modelId}`
              : 'Not set'}
          </small>
        </summary>
        <dl className="exact-route">
          <div>
            <dt>Backend</dt>
            <dd>{configuration.backendId ?? 'Not set'}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{configuration.providerId ?? 'Not set'}</dd>
          </div>
          <div>
            <dt>Billing lane</dt>
            <dd>{configuration.billingLane ? billingLaneLabel(configuration.billingLane) : 'Not set'}</dd>
          </div>
          <div>
            <dt>Model ID</dt>
            <dd>
              <code>{configuration.modelId ?? 'Not set'}</code>
            </dd>
          </div>
          <div>
            <dt>Catalogue snapshot</dt>
            <dd>
              {stage.modelSnapshot
                ? `${stage.modelSnapshot.status}${stage.modelSnapshot.discoveredAt ? ` · discovered ${new Date(stage.modelSnapshot.discoveredAt).toLocaleString()}` : ''}`
                : 'None saved'}
            </dd>
          </div>
        </dl>
      </details>

      <details className="settings-disclosure">
        <summary>
          Presets and defaults
          <small>
            {hasStageOverride(stage) ? 'This stage overrides the defaults' : 'Following the defaults'}
          </small>
        </summary>
        <div className="assignment-preset-grid">
          <label className="form-field">
            <span>Apply a saved preset</span>
            <select
              value=""
              onChange={(event) => {
                const preset = presets.find((item) => item.id === event.target.value);
                if (preset) onChange(preset.configuration);
              }}
            >
              <option value="">Choose preset to apply</option>
              {presets.map((preset) => (
                <option value={preset.id} key={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Save this assignment as a preset</span>
            <input
              value={presetName}
              maxLength={80}
              placeholder="Preset name"
              onChange={(event) => setPresetName(event.target.value)}
            />
          </label>
        </div>
        <div className="stage-actions-row">
          <button
            type="button"
            className="quiet-button"
            disabled={!complete || !presetName.trim()}
            onClick={() => {
              onSavePreset(presetName.trim(), configuration);
              setPresetName('');
            }}
          >
            <Save size={13} aria-hidden="true" /> Save preset
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={!complete}
            onClick={() => onPromoteToDefault(stage.kind, configuration)}
          >
            Use for all {stage.kind} stages
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={!hasStageOverride(stage)}
            onClick={() => onChange(inheritPatch())}
          >
            Follow workflow defaults
          </button>
        </div>
      </details>

      <details className="settings-disclosure">
        <summary>
          Advanced · custom route
          <small>Choose backend, provider and billing lane without a saved connection</small>
        </summary>
        <div className="form-grid-two">
          <label className="form-field">
            <span>Execution backend</span>
            <select
              value={customRoute.backendId}
              onChange={(event) =>
                setCustomRoute({
                  backendId: event.target.value,
                  providerId: '',
                  billingLane: billingLanesForBackend(event.target.value)[0] ?? 'unknown',
                })
              }
            >
              {providers.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.name}
                  {provider.detected ? '' : ' · not detected'}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Provider ID</span>
            <input
              value={customRoute.providerId}
              maxLength={80}
              onChange={(event) =>
                setCustomRoute((current) => ({ ...current, providerId: event.target.value }))
              }
            />
          </label>
          <label className="form-field">
            <span>Billing lane</span>
            <select
              value={customRoute.billingLane}
              onChange={(event) =>
                setCustomRoute((current) => ({ ...current, billingLane: event.target.value as BillingLane }))
              }
            >
              {billingLanesForBackend(customRoute.backendId).map((lane) => (
                <option value={lane} key={lane}>
                  {billingLaneLabel(lane)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={!customRoute.providerId.trim()}
          onClick={applyCustomRoute}
        >
          Use this route for the stage
        </button>
      </details>
    </fieldset>
  );
}
