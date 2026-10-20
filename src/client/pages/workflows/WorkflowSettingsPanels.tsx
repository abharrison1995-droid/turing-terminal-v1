import { useState, type ReactNode } from 'react';
import { billingLaneLabel, billingModeLabel, resolveBillingMode } from '../../../shared/billing';
import type {
  ConnectionProfile,
  ExecutionProfile,
  PermissionMode,
  ProviderStatus,
  WorkflowDefinition,
} from '../../../shared/types';
import { BillingSafetyFields } from '../../phase36';
import { isAiStage } from '../shared/stageMeta';
import { capitalize } from '../shared/runStatus';
import {
  applyConnectionPatch,
  connectionChangeImpact,
  manualModelPatch,
  modelCompatibility,
  modelSelectionPatch,
  modelsForRoute,
  resolveAssignment,
} from './assignment';
import { ConnectionImpactPanel, SourceChip } from './StageAssignment';

export type SettingsPanelId = 'safety' | 'limits' | 'context' | 'generation' | 'instructions';

function Panel({
  id,
  title,
  summary,
  open,
  onOpen,
  children,
}: {
  id: SettingsPanelId;
  title: string;
  summary: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="workflow-setting"
      id={`workflow-setting-${id}`}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="workflow-setting-name">{title}</span>
        <span className="workflow-setting-summary">{summary}</span>
      </summary>
      <div className="workflow-setting-body">{children}</div>
    </details>
  );
}

/**
 * The workflow-level controls that used to be one long form, grouped under named, collapsed sections. Each summary
 * states the value in force, so the policy is readable without opening anything.
 */
export function WorkflowSettingsPanels({
  draft,
  providers,
  connections,
  openPanel,
  onOpenPanel,
  onChange,
}: {
  draft: WorkflowDefinition;
  providers: ProviderStatus[];
  connections: ConnectionProfile[];
  openPanel: SettingsPanelId | null;
  onOpenPanel: (id: SettingsPanelId | null) => void;
  onChange: (patch: Partial<WorkflowDefinition>) => void;
}) {
  const bind = (id: SettingsPanelId) => ({
    id,
    open: openPanel === id,
    onOpen: (open: boolean) => onOpenPanel(open ? id : openPanel === id ? null : openPanel),
  });
  const mode = resolveBillingMode(draft);
  const setPolicy = (patch: Partial<WorkflowDefinition['contextPolicy']>) =>
    onChange({ contextPolicy: { ...draft.contextPolicy, ...patch } });
  return (
    <section className="workflow-settings" aria-label="Workflow settings">
      <h2 className="workflow-settings-title">Workflow settings</h2>

      <Panel
        {...bind('safety')}
        title="Safety and billing"
        summary={`${billingModeLabel(mode)} · ${capitalize(draft.permissionMode)} permissions · ${draft.isolatedWorktree ? 'worktree isolation on' : 'worktree isolation off'}`}
      >
        <label className="form-field">
          <span>Permission mode</span>
          <select
            value={draft.permissionMode}
            onChange={(event) => onChange({ permissionMode: event.target.value as PermissionMode })}
          >
            <option value="supervised">Supervised</option>
            <option value="normal">Normal</option>
            <option value="yolo">YOLO</option>
            <option value="enigma">ENIGMA · requires run confirmation</option>
          </select>
        </label>
        <div className="toggle-stack">
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.isolatedWorktree}
              onChange={(event) => onChange({ isolatedWorktree: event.target.checked })}
            />
            <span>
              <strong>Isolate Git runs in a worktree</strong>
              <small>Run setup pauses if the repository has uncommitted changes.</small>
            </span>
          </label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.lockProviders}
              onChange={(event) => onChange({ lockProviders: event.target.checked })}
            />
            <span>
              <strong>Lock providers</strong>
              <small>
                On by default. A failed stage pauses; Turing does not substitute providers, models, or native
                reasoning values.
              </small>
            </span>
          </label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.promptRefinementDefault}
              disabled={
                !draft.stages.some((stage) => stage.kind === 'promptRefinement' && stage.enabled !== false)
              }
              onChange={(event) => onChange({ promptRefinementDefault: event.target.checked })}
            />
            <span>
              <strong>Prompt refinement by default</strong>
              <small>
                Add an enabled Prompt refinement stage and assign its provider to use this option.
              </small>
            </span>
          </label>
        </div>
        <BillingSafetyFields workflow={draft} onChange={onChange} />
      </Panel>

      <Panel
        {...bind('limits')}
        title="Retry and limits"
        summary={`${capitalize(draft.executionProfile)} profile · ${draft.retryPolicy.maxRetries} ${draft.retryPolicy.maxRetries === 1 ? 'retry' : 'retries'} · ${draft.maxDurationMinutes} min`}
      >
        <label className="form-field">
          <span>Execution profile</span>
          <select
            value={draft.executionProfile}
            onChange={(event) => onChange({ executionProfile: event.target.value as ExecutionProfile })}
          >
            <option value="economy">Economy · one reviewer per parallel review</option>
            <option value="balanced">Balanced · up to two reviewers</option>
            <option value="maximum">Maximum · configured reviewer count</option>
          </select>
          <small>Model identity is never changed by Economy, Balanced, or Maximum.</small>
        </label>
        <div className="field-row">
          <label className="form-field small-number-field">
            <span>Max remediation rounds</span>
            <input
              type="number"
              min={0}
              max={5}
              value={draft.maxRemediationRounds}
              onChange={(event) =>
                onChange({ maxRemediationRounds: Math.min(5, Math.max(0, Number(event.target.value))) })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Max parallel agents</span>
            <input
              type="number"
              min={1}
              max={8}
              value={draft.maxParallelAgents}
              onChange={(event) =>
                onChange({ maxParallelAgents: Math.min(8, Math.max(1, Number(event.target.value))) })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Maximum workflow minutes</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={draft.maxDurationMinutes}
              onChange={(event) =>
                onChange({ maxDurationMinutes: Math.min(1440, Math.max(1, Number(event.target.value))) })
              }
            />
          </label>
        </div>
        <div className="field-row">
          <label className="form-field small-number-field">
            <span>Transient provider retries</span>
            <input
              type="number"
              min={0}
              max={5}
              value={draft.retryPolicy.maxRetries}
              onChange={(event) =>
                onChange({
                  retryPolicy: {
                    ...draft.retryPolicy,
                    maxRetries: Math.min(5, Math.max(0, Number(event.target.value))),
                  },
                })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Initial retry delay (ms)</span>
            <input
              type="number"
              min={100}
              max={30000}
              step={100}
              value={draft.retryPolicy.initialDelayMs}
              onChange={(event) =>
                onChange({
                  retryPolicy: {
                    ...draft.retryPolicy,
                    initialDelayMs: Math.min(30000, Math.max(100, Number(event.target.value))),
                    maxDelayMs: Math.max(draft.retryPolicy.maxDelayMs, Number(event.target.value)),
                  },
                })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Maximum retry delay (ms)</span>
            <input
              type="number"
              min={100}
              max={120000}
              step={500}
              value={draft.retryPolicy.maxDelayMs}
              onChange={(event) =>
                onChange({
                  retryPolicy: {
                    ...draft.retryPolicy,
                    maxDelayMs: Math.min(
                      120000,
                      Math.max(draft.retryPolicy.initialDelayMs, Number(event.target.value)),
                    ),
                  },
                })
              }
            />
          </label>
        </div>
      </Panel>

      <Panel
        {...bind('context')}
        title="Context"
        summary={`${draft.contextPolicy.strategy} · ${draft.contextPolicy.maxEstimatedTokens.toLocaleString()} token limit`}
      >
        <div className="form-grid-two">
          <label className="form-field">
            <span>Default context strategy</span>
            <select
              value={draft.contextPolicy.strategy}
              onChange={(event) =>
                setPolicy({ strategy: event.target.value as WorkflowDefinition['contextPolicy']['strategy'] })
              }
            >
              <option value="focused">AUTO / Focused</option>
              <option value="changed-files">Changed Files</option>
              <option value="artifacts-only">Artifacts Only</option>
              <option value="full-project">Full Project / Broad</option>
            </select>
          </label>
          <label className="form-field small-number-field">
            <span>Default estimated token limit</span>
            <input
              type="number"
              min={1000}
              max={500000}
              value={draft.contextPolicy.maxEstimatedTokens}
              onChange={(event) =>
                setPolicy({
                  maxEstimatedTokens: Math.min(500000, Math.max(1000, Number(event.target.value))),
                })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Default max files</span>
            <input
              type="number"
              min={1}
              max={500}
              value={draft.contextPolicy.maxFiles}
              onChange={(event) =>
                setPolicy({ maxFiles: Math.min(500, Math.max(1, Number(event.target.value))) })
              }
            />
          </label>
          <label className="form-field small-number-field">
            <span>Default max file size (bytes)</span>
            <input
              type="number"
              min={1024}
              max={2000000}
              value={draft.contextPolicy.maxFileBytes}
              onChange={(event) =>
                setPolicy({ maxFileBytes: Math.min(2000000, Math.max(1024, Number(event.target.value))) })
              }
            />
          </label>
        </div>
      </Panel>

      <Panel
        {...bind('generation')}
        title="Generation defaults"
        summary={
          draft.defaultModelConfiguration?.modelId
            ? `${draft.defaultModelConfiguration.modelId}`
            : 'No workflow default model'
        }
      >
        <GenerationDefaults
          draft={draft}
          providers={providers}
          connections={connections}
          onChange={onChange}
        />
      </Panel>

      <Panel
        {...bind('instructions')}
        title="Instructions"
        summary={
          draft.globalInstructions?.trim() ? `${draft.globalInstructions.trim().length} characters` : 'None'
        }
      >
        <label className="form-field">
          <span>Workflow instructions</span>
          <textarea
            rows={4}
            maxLength={8000}
            value={draft.globalInstructions ?? ''}
            onChange={(event) => onChange({ globalInstructions: event.target.value })}
            placeholder="Workflow-specific instructions. These stay below Turing security rules and mandatory Global/Project Rules."
          />
        </label>
      </Panel>
    </section>
  );
}

function GenerationDefaults({
  draft,
  providers,
  connections,
  onChange,
}: {
  draft: WorkflowDefinition;
  providers: ProviderStatus[];
  connections: ConnectionProfile[];
  onChange: (patch: Partial<WorkflowDefinition>) => void;
}) {
  const config = draft.defaultModelConfiguration ?? {};
  const connection = connections.find((item) => item.id === config.connectionProfileId);
  const { backend, models, discovery } = modelsForRoute(providers, config.backendId, config.providerId);
  const compatibility = modelCompatibility(providers, config.backendId, config.providerId, config.modelId);
  const [pending, setPending] = useState<ConnectionProfile | null>(null);
  // Stages that would change if this default changes: the AI stages that do not set their own value.
  const following = (field: 'connection' | 'model') =>
    draft.stages
      .filter((stage) => isAiStage(stage.kind))
      .filter((stage) => resolveAssignment(draft, stage).sources[field] === 'workflow-default')
      .map((stage) => stage.label);
  const followers = Array.from(new Set([...following('connection'), ...following('model')]));
  const impact = pending ? connectionChangeImpact(config, pending, providers, connection) : null;
  const set = (patch: Partial<NonNullable<WorkflowDefinition['defaultModelConfiguration']>>) =>
    onChange({ defaultModelConfiguration: { ...config, ...patch } });
  const apply = (target: ConnectionProfile, mode: 'keep' | 'clear-model') => {
    const impactNow = connectionChangeImpact(config, target, providers, connection);
    const patch = applyConnectionPatch(target, impactNow, mode);
    onChange({
      defaultModelConfiguration: { ...config, ...(patch as Record<string, unknown>) },
    });
    setPending(null);
  };
  const showManual = !discovery || compatibility === 'not-listed';
  return (
    <>
      <p className="quiet-note">
        Used by every AI stage that does not set its own connection or model.{' '}
        {followers.length
          ? `Currently followed by: ${followers.join(', ')}.`
          : 'No stage follows these defaults right now.'}
      </p>
      <div className="form-grid-two">
        <label className="form-field">
          <span>
            Default connection{' '}
            <SourceChip source={config.connectionProfileId ? 'workflow-default' : 'unset'} />
          </span>
          <select
            value={connection?.id ?? ''}
            onChange={(event) => {
              const next = connections.find((item) => item.id === event.target.value);
              if (!next) {
                set({
                  connectionProfileId: undefined,
                  backendId: undefined,
                  providerId: undefined,
                  billingLane: undefined,
                });
                return;
              }
              const result = connectionChangeImpact(config, next, providers, connection);
              if (result.needsDecision || followers.length) setPending(next);
              else apply(next, 'keep');
            }}
          >
            <option value="">No workflow-level connection</option>
            {connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {billingLaneLabel(item.billingLane)}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Default model</span>
          {showManual ? (
            <input
              value={config.modelId ?? ''}
              maxLength={180}
              spellCheck={false}
              placeholder="provider-native/model-id"
              disabled={!config.backendId}
              onChange={(event) => set({ ...(manualModelPatch(event.target.value) as object) })}
            />
          ) : (
            <select
              value={config.modelId ?? ''}
              onChange={(event) => {
                const model = models.find((item) => item.id === event.target.value);
                if (model) set(modelSelectionPatch(model, config, backend) as object);
              }}
            >
              <option value="" disabled>
                Choose a model
              </option>
              {models.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
                </option>
              ))}
            </select>
          )}
          <small>
            {!config.backendId
              ? 'Choose a connection first.'
              : showManual
                ? 'Typed by hand and not verified against a catalogue. Sent exactly as written.'
                : 'Listed by the connection. The exact ID is saved.'}
          </small>
        </label>
      </div>
      {pending && impact && (
        <ConnectionImpactPanel
          connectionName={pending.name}
          impact={impact}
          modelId={config.modelId}
          affected={followers}
          onKeep={() => apply(pending, 'keep')}
          onClear={() => apply(pending, 'clear-model')}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
