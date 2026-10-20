// Workflow stage editor fields: billing safety, model capability controls and Orchestrator branches.

import type {
  BillingMode,
  ExternalDataPolicy,
  ModelOption,
  ProviderStatus,
  UnknownCostPolicy,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';
import { billingLaneLabel, METERED_LANES } from '../../../shared/billing';
import {
  advancedSettingsFor,
  classifyModelIdentity,
  reasoningControlFor,
  reasoningControlLabel,
} from '../../../shared/modelSettings';

/* ───────────────────────── Billing & safety ───────────────────────── */

export function BillingSafetyFields({
  workflow,
  onChange,
}: {
  workflow: WorkflowDefinition;
  onChange: (patch: Partial<WorkflowDefinition>) => void;
}) {
  const mode = workflow.billingMode ?? (workflow.subscriptionOnly ? 'subscriptions-only' : 'custom');
  const budget = workflow.meteredBudget ?? { perRunUsd: null, unknownCostPolicy: 'block' as const };
  return (
    <div className="billing-safety-fields">
      <div className="form-grid-two">
        <label className="form-field">
          <span>Billing mode</span>
          <select
            value={mode}
            onChange={(event) => {
              const billingMode = event.target.value as BillingMode;
              onChange({ billingMode, subscriptionOnly: billingMode !== 'custom' });
            }}
          >
            <option value="subscriptions-only">Subscriptions Only (recommended)</option>
            <option value="subscriptions-plus-decision-budget">Subscriptions + Decision Budget</option>
            <option value="custom">Custom metered lanes</option>
          </select>
          <small>
            {mode === 'subscriptions-only'
              ? 'No metered route may run. OpenRouter, API, and PAYG lanes are blocked.'
              : mode === 'subscriptions-plus-decision-budget'
                ? 'Only explicitly configured Decision Gates may spend, under the per-run cap below. Generative OpenRouter use stays blocked.'
                : 'Explicitly configured metered lanes may run. Turing still never substitutes a lane or model.'}
          </small>
        </label>
        <label className="form-field small-number-field">
          <span>Per-run metered cap (USD)</span>
          <input
            type="number"
            min={0}
            max={1000}
            step={0.01}
            value={budget.perRunUsd ?? ''}
            placeholder={mode === 'subscriptions-plus-decision-budget' ? 'Required' : 'No per-run cap'}
            onChange={(event) =>
              onChange({
                meteredBudget: {
                  ...budget,
                  perRunUsd: event.target.value === '' ? null : Math.max(0, Number(event.target.value)),
                },
              })
            }
          />
          <small>Turing hard cap, reserved atomically before each metered request.</small>
        </label>
        <label className="form-field">
          <span>Unknown-cost requests</span>
          <select
            value={budget.unknownCostPolicy}
            onChange={(event) =>
              onChange({
                meteredBudget: { ...budget, unknownCostPolicy: event.target.value as UnknownCostPolicy },
              })
            }
          >
            <option value="block">Block (default)</option>
            <option value="ask">Ask before sending</option>
            <option value="allow-with-warning">Allow with warning · hard cap not guaranteed</option>
          </select>
        </label>
        <label className="form-field">
          <span>External decision data</span>
          <select
            value={workflow.externalDecisionDataPolicy ?? 'ask-first'}
            onChange={(event) =>
              onChange({ externalDecisionDataPolicy: event.target.value as ExternalDataPolicy })
            }
          >
            <option value="ask-first">Ask before first external send (default)</option>
            <option value="allow">Allow configured external engines</option>
            <option value="block">Block external decision data</option>
          </select>
          <small>Separate from billing: allowing spend does not allow sending project state.</small>
        </label>
      </div>
      {mode === 'custom' && (
        <fieldset className="condition-skip-targets">
          <legend>Allowed metered lanes (none checked = every explicitly configured lane)</legend>
          {METERED_LANES.map((lane) => (
            <label className="rule-flag" key={lane}>
              <input
                type="checkbox"
                checked={workflow.customAllowedLanes?.includes(lane) ?? false}
                onChange={(event) => {
                  const next = new Set(workflow.customAllowedLanes ?? []);
                  if (event.target.checked) next.add(lane);
                  else next.delete(lane);
                  onChange({ customAllowedLanes: next.size ? [...next] : undefined });
                }}
              />
              {billingLaneLabel(lane)}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/* ───────────────────────── Model capability controls ───────────────────────── */

export function ModelStatusLine({
  backendId,
  modelId,
  model,
  snapshot,
  catalogSource,
}: {
  backendId?: string;
  modelId?: string;
  model?: ModelOption;
  snapshot?: WorkflowStage['modelSnapshot'];
  catalogSource?: ProviderStatus['catalogSource'];
}) {
  if (!modelId) return null;
  const identity = model?.identity ?? classifyModelIdentity(backendId, modelId);
  const status = model
    ? (model.status ?? (catalogSource === 'cache' ? 'last-known' : 'current'))
    : catalogSource === 'live'
      ? 'unavailable'
      : (snapshot?.status ?? 'last-known');
  const label = status === 'last-known' ? 'LAST KNOWN' : status.toUpperCase();
  return (
    <small className={`model-catalog-status model-status-${status}`}>
      {label} · {identity === 'floating' ? 'FLOATING / ROUTED alias' : 'PINNED'}
      {model?.discoveredAt ? ` · catalog ${new Date(model.discoveredAt).toLocaleString()}` : ''}
      {(status === 'unavailable' || status === 'deprecated') &&
        ' · Choose replacement: pick a current model below. Turing will not migrate it automatically.'}
      {model?.deprecationDate ? ` · provider deprecation ${model.deprecationDate}` : ''}
    </small>
  );
}

export function ModelSettingsFields({
  backendId,
  model,
  reasoning,
  variantId,
  nativeSettings,
  onChange,
}: {
  backendId?: string;
  model?: ModelOption;
  reasoning?: string;
  variantId?: string;
  nativeSettings?: WorkflowStage['nativeSettings'];
  onChange: (patch: Partial<Pick<WorkflowStage, 'reasoning' | 'variantId' | 'nativeSettings'>>) => void;
}) {
  if (!backendId) return null;
  const control = reasoningControlFor(backendId, model);
  const advanced = advancedSettingsFor(backendId, model);
  return (
    <>
      {control === 'effort' && model?.reasoningLevels?.length ? (
        <label className="form-field reasoning-field">
          <span>Reasoning · provider-native</span>
          <select
            value={reasoning ?? ''}
            onChange={(event) => onChange({ reasoning: event.target.value || undefined })}
          >
            <option value="">Provider default</option>
            {model.reasoningLevels.map((level) => (
              <option value={level} key={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      ) : control === 'variant' && model?.variantIds?.length ? (
        <label className="form-field reasoning-field">
          <span>Model variant · provider-native</span>
          <select
            value={variantId ?? ''}
            onChange={(event) => onChange({ variantId: event.target.value || undefined })}
          >
            <option value="">Provider default</option>
            {model.variantIds.map((variant) => (
              <option value={variant} key={variant}>
                {variant}
              </option>
            ))}
          </select>
        </label>
      ) : control === 'provider-controlled' ? (
        <div className="form-field reasoning-field">
          <span>Reasoning</span>
          <small className="quiet-note">
            Provider controlled — this backend reports no configurable reasoning for the selected model.
          </small>
        </div>
      ) : null}
      {advanced.length > 0 && (
        <details className="settings-disclosure stage-wide">
          <summary>
            Advanced Model Settings
            <small>{reasoningControlLabel(control)} · only settings this model reports are shown</small>
          </summary>
          <div className="form-grid-two">
            {advanced.map((setting) => (
              <label className="form-field small-number-field" key={setting.key}>
                <span>{setting.label}</span>
                <input
                  type="number"
                  min={setting.min}
                  max={setting.max}
                  step={setting.step}
                  value={
                    typeof nativeSettings?.[setting.key] === 'number'
                      ? Number(nativeSettings[setting.key])
                      : ''
                  }
                  placeholder="Provider default"
                  onChange={(event) => {
                    const next = { ...(nativeSettings ?? {}) };
                    if (event.target.value === '') delete next[setting.key];
                    else next[setting.key] = Number(event.target.value);
                    onChange({ nativeSettings: Object.keys(next).length ? next : undefined });
                  }}
                />
                <small>{setting.help}</small>
              </label>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/* ───────────────────────── Orchestrator branches ───────────────────────── */

export function OrchestratorBranchesEditor({
  stage,
  laterStages,
  onChange,
}: {
  stage: WorkflowStage;
  laterStages: WorkflowStage[];
  onChange: (patch: Partial<WorkflowStage>) => void;
}) {
  const orchestration = stage.orchestration;
  const branches = orchestration?.branches ?? [];
  const update = (next: NonNullable<WorkflowStage['orchestration']> | undefined) =>
    onChange({ orchestration: next });
  return (
    <fieldset className="condition-skip-targets stage-wide">
      <legend>Explicit branches the Orchestrator may choose (optional)</legend>
      <small className="quiet-note">
        The Orchestrator can only pick one of these. Turing's state machine applies it; unknown answers use
        the default branch.
      </small>
      {branches.map((branch, index) => (
        <div className="orchestrator-branch" key={branch.id}>
          <label className="form-field">
            <span>Branch {index + 1}</span>
            <input
              value={branch.label}
              maxLength={120}
              onChange={(event) =>
                update({
                  ...orchestration!,
                  branches: branches.map((item) =>
                    item.id === branch.id ? { ...item, label: event.target.value } : item,
                  ),
                })
              }
            />
          </label>
          <label className="rule-flag">
            <input
              type="radio"
              checked={orchestration?.defaultBranchId === branch.id}
              onChange={() => update({ ...orchestration!, defaultBranchId: branch.id })}
            />
            Default
          </label>
          {laterStages.map((later) => (
            <label className="rule-flag" key={later.id}>
              <input
                type="checkbox"
                checked={branch.skipStageIds.includes(later.id)}
                onChange={(event) =>
                  update({
                    ...orchestration!,
                    branches: branches.map((item) =>
                      item.id === branch.id
                        ? {
                            ...item,
                            skipStageIds: event.target.checked
                              ? [...item.skipStageIds, later.id]
                              : item.skipStageIds.filter((id) => id !== later.id),
                          }
                        : item,
                    ),
                  })
                }
              />
              Skip {later.label}
            </label>
          ))}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              const rest = branches.filter((item) => item.id !== branch.id);
              update(
                rest.length
                  ? {
                      branches: rest,
                      defaultBranchId: rest.some((item) => item.id === orchestration?.defaultBranchId)
                        ? orchestration!.defaultBranchId
                        : rest[0]!.id,
                    }
                  : undefined,
              );
            }}
          >
            Remove branch
          </button>
        </div>
      ))}
      <button
        type="button"
        className="quiet-button"
        disabled={branches.length >= 10}
        onClick={() => {
          const id = `branch-${branches.length + 1}-${Math.random().toString(36).slice(2, 5)}`;
          update({
            branches: [
              ...branches,
              { id, label: branches.length ? 'Alternative path' : 'Standard path', skipStageIds: [] },
            ],
            defaultBranchId: orchestration?.defaultBranchId ?? id,
          });
        }}
      >
        Add branch
      </button>
    </fieldset>
  );
}
