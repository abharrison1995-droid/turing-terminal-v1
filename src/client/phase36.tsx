import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, KeyRound, LockKeyhole, RefreshCw, Scale, Shield } from 'lucide-react';
import type {
  BillingMode,
  DecisionEngineId,
  DecisionGateConfig,
  DecisionInputCategory,
  DecisionResult,
  DecisionRouteAction,
  ExternalDataPolicy,
  MeteredBudgetSettings,
  ModelOption,
  ProviderSpendTelemetry,
  ProviderStatus,
  RunPreview,
  UnknownCostPolicy,
  WorkflowDefinition,
  WorkflowStage,
} from '../shared/types';
import { billingLaneLabel, billingModeLabel, METERED_LANES } from '../shared/billing';
import { DECISION_ENGINES, decisionInputLabel, DEFAULT_JEV_MODEL } from '../shared/decisions';
import {
  advancedSettingsFor,
  classifyModelIdentity,
  reasoningControlFor,
  reasoningControlLabel,
} from '../shared/modelSettings';
import { systemTimeZone } from '../shared/timezone';
import {
  api,
  type BudgetStatus,
  type ConnectionProfileWithCredentials,
  type MetricTotal,
  type UsageAnalytics,
  type UsageGroupRow,
} from './api';

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

/* ───────────────────────── Decision Gate ───────────────────────── */

export function defaultDecisionConfig(): DecisionGateConfig {
  return {
    engine: 'deterministic-rules',
    questionType: 'boolean',
    question: 'Are there no failing test stages?',
    inputs: ['tests'],
    rule: { path: 'tests.failed', operator: 'equals', value: 0 },
    routing: {
      field: 'probability',
      passAtOrAbove: 0.95,
      failAtOrBelow: 0.15,
      onPass: { action: 'continue' },
      onFail: { action: 'fail-run' },
      onUncertain: { action: 'human-approval' },
    },
  };
}

const INPUT_CATEGORIES: DecisionInputCategory[] = [
  'task',
  'plan',
  'implementation',
  'diff',
  'tests',
  'build',
  'findings',
  'finalGate',
];

function RouteActionField({
  label,
  value,
  laterStages,
  allowEscalate,
  onChange,
}: {
  label: string;
  value: DecisionRouteAction;
  laterStages: WorkflowStage[];
  allowEscalate: boolean;
  onChange: (value: DecisionRouteAction) => void;
}) {
  return (
    <div className="decision-route-field">
      <label className="form-field">
        <span>{label}</span>
        <select
          value={value.action}
          onChange={(event) =>
            onChange({
              action: event.target.value as DecisionRouteAction['action'],
              ...(event.target.value === 'skip-stages' ? { skipStageIds: value.skipStageIds ?? [] } : {}),
            })
          }
        >
          <option value="continue">Continue</option>
          <option value="skip-stages">Skip later stages</option>
          <option value="fail-run">Stop the run (FAIL)</option>
          <option value="human-approval">Ask a person</option>
          {allowEscalate && <option value="escalate">Escalate to second engine</option>}
        </select>
      </label>
      {value.action === 'skip-stages' &&
        laterStages.map((later) => (
          <label className="rule-flag" key={later.id}>
            <input
              type="checkbox"
              checked={value.skipStageIds?.includes(later.id) ?? false}
              onChange={(event) =>
                onChange({
                  ...value,
                  skipStageIds: event.target.checked
                    ? [...(value.skipStageIds ?? []), later.id]
                    : (value.skipStageIds ?? []).filter((id) => id !== later.id),
                })
              }
            />
            {later.label}
          </label>
        ))}
    </div>
  );
}

function EngineRouteFields({
  label,
  route,
  providers,
  profiles,
  onChange,
}: {
  label: string;
  route: {
    engine: DecisionEngineId;
    modelId?: string;
    connectionProfileId?: string;
    judge?: DecisionGateConfig['judge'];
  };
  providers: ProviderStatus[];
  profiles: ConnectionProfileWithCredentials[];
  onChange: (patch: Partial<DecisionGateConfig>) => void;
}) {
  const openRouter = providers.find((provider) => provider.id === 'openrouter');
  const openRouterProfiles = profiles.filter((profile) => profile.backendId === 'openrouter');
  const decisionModels = (openRouter?.models ?? []).filter((model) =>
    route.engine === 'jev-openrouter' ? model.family === 'decision' : model.family !== 'decision',
  );
  const listId = `decision-models-${label.replace(/\W+/g, '-')}`;
  return (
    <>
      <label className="form-field">
        <span>{label}</span>
        <select
          value={route.engine}
          onChange={(event) => {
            const engine = event.target.value as DecisionEngineId;
            onChange({
              engine,
              modelId: engine === 'jev-openrouter' ? DEFAULT_JEV_MODEL : undefined,
              judge: undefined,
              connectionProfileId: undefined,
            });
          }}
        >
          {DECISION_ENGINES.map((engine) => (
            <option value={engine.id} key={engine.id}>
              {engine.label}
              {engine.metered ? ' · metered' : ''}
            </option>
          ))}
        </select>
      </label>
      {(route.engine === 'jev-openrouter' || route.engine === 'openrouter-judge') && (
        <>
          <label className="form-field">
            <span>OpenRouter connection</span>
            <select
              value={route.connectionProfileId ?? ''}
              onChange={(event) => onChange({ connectionProfileId: event.target.value || undefined })}
            >
              <option value="">Choose explicitly</option>
              {openRouterProfiles.map((profile) => (
                <option value={profile.id} key={profile.id}>
                  {profile.name}
                  {profile.credentials?.inference ? '' : ' · no key stored'}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Exact model</span>
            <input
              list={listId}
              value={route.modelId ?? ''}
              onChange={(event) => onChange({ modelId: event.target.value || undefined })}
              placeholder={route.engine === 'jev-openrouter' ? DEFAULT_JEV_MODEL : 'provider/model'}
            />
            <datalist id={listId}>
              {decisionModels.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name}
                </option>
              ))}
            </datalist>
          </label>
        </>
      )}
      {route.engine === 'subscription-llm-judge' && (
        <>
          <label className="form-field">
            <span>Judge backend</span>
            <select
              value={route.judge?.backendId ?? ''}
              onChange={(event) =>
                onChange({
                  judge: {
                    ...route.judge,
                    backendId: event.target.value || undefined,
                    providerId:
                      event.target.value === 'claude-code'
                        ? 'anthropic-subscription'
                        : event.target.value === 'codex-cli'
                          ? 'openai-codex'
                          : route.judge?.providerId,
                    modelId: undefined,
                  },
                })
              }
            >
              <option value="">Choose local CLI</option>
              {providers
                .filter((provider) => provider.id !== 'openrouter')
                .map((provider) => (
                  <option value={provider.id} key={provider.id}>
                    {provider.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="form-field">
            <span>Judge provider</span>
            <input
              value={route.judge?.providerId ?? ''}
              onChange={(event) =>
                onChange({ judge: { ...route.judge, providerId: event.target.value || undefined } })
              }
              placeholder="opencode-go, cline-pass, openai-codex…"
            />
          </label>
          <label className="form-field">
            <span>Judge exact model</span>
            <input
              value={route.judge?.modelId ?? ''}
              onChange={(event) =>
                onChange({ judge: { ...route.judge, modelId: event.target.value || undefined } })
              }
            />
          </label>
        </>
      )}
    </>
  );
}

export function DecisionGateEditor({
  stage,
  laterStages,
  providers,
  profiles,
  onChange,
}: {
  stage: WorkflowStage;
  laterStages: WorkflowStage[];
  providers: ProviderStatus[];
  profiles: ConnectionProfileWithCredentials[];
  onChange: (patch: Partial<WorkflowStage>) => void;
}) {
  const config = stage.decision ?? defaultDecisionConfig();
  const update = (patch: Partial<DecisionGateConfig>) => onChange({ decision: { ...config, ...patch } });
  const routing = config.routing;
  const setRouting = (patch: Partial<DecisionGateConfig['routing']>) =>
    update({ routing: { ...routing, ...patch } });
  const choiceOptions = config.criteria && !Array.isArray(config.criteria) ? config.criteria : {};
  const scoreLevels = Array.isArray(config.criteria) ? config.criteria : [];
  const [testResult, setTestResult] = useState<string>('');
  const external = DECISION_ENGINES.find((engine) => engine.id === config.engine)?.external;
  return (
    <div className="decision-gate-editor stage-wide">
      <div className="inline-callout">
        <Scale size={14} />
        <span>
          <strong>Optional Decision Gate</strong>
          <small>
            The engine judges; Turing policy decides. Gates cannot bypass permissions, budgets, approvals, or
            loop bounds.
            {external ? ' This engine receives the structured state categories selected below.' : ''}
          </small>
        </span>
      </div>
      <div className="form-grid-two">
        <EngineRouteFields
          label="Decision Engine"
          route={config}
          providers={providers}
          profiles={profiles}
          onChange={update}
        />
        <label className="form-field">
          <span>Question type</span>
          <select
            value={config.questionType}
            onChange={(event) => {
              const questionType = event.target.value as DecisionGateConfig['questionType'];
              update({
                questionType,
                criteria:
                  questionType === 'choice'
                    ? { COMPLETE: 'Ready to finish', REMEDIATE: 'Needs remediation', HUMAN: 'Needs a person' }
                    : questionType === 'score'
                      ? ['Not done', 'Partly done', 'Mostly done', 'Complete']
                      : undefined,
                routing:
                  questionType === 'boolean'
                    ? {
                        ...routing,
                        field: 'probability',
                        passAtOrAbove: 0.95,
                        failAtOrBelow: 0.15,
                        minConfidence: undefined,
                        choiceRoutes: undefined,
                      }
                    : questionType === 'choice'
                      ? {
                          ...routing,
                          field: 'confidence',
                          minConfidence: 0.6,
                          passAtOrAbove: undefined,
                          failAtOrBelow: undefined,
                          choiceRoutes: {
                            COMPLETE: { action: 'continue' },
                            REMEDIATE: { action: 'continue' },
                            HUMAN: { action: 'human-approval' },
                          },
                        }
                      : {
                          ...routing,
                          field: 'score',
                          passAtOrAbove: 2.5,
                          failAtOrBelow: 1,
                          minConfidence: undefined,
                          choiceRoutes: undefined,
                        },
              });
            }}
          >
            <option value="boolean">Boolean / proposition</option>
            <option value="choice">Choice</option>
            <option value="score">Score</option>
          </select>
        </label>
      </div>
      <label className="form-field">
        <span>Question</span>
        <textarea
          rows={2}
          maxLength={2_000}
          value={config.question}
          onChange={(event) => update({ question: event.target.value })}
        />
      </label>
      {config.questionType === 'choice' && (
        <label className="form-field">
          <span>Options (one per line: ID: description)</span>
          <textarea
            rows={3}
            value={Object.entries(choiceOptions)
              .map(([id, text]) => `${id}: ${text}`)
              .join('\n')}
            onChange={(event) =>
              update({
                criteria: Object.fromEntries(
                  event.target.value
                    .split(/\r?\n/)
                    .map((line) => line.split(':'))
                    .filter(([id]) => id?.trim())
                    .map(([id, ...rest]) => [id!.trim(), rest.join(':').trim()]),
                ),
              })
            }
          />
        </label>
      )}
      {config.questionType === 'score' && (
        <label className="form-field">
          <span>Ordered levels, lowest first (2–10, one per line)</span>
          <textarea
            rows={3}
            value={scoreLevels.join('\n')}
            onChange={(event) =>
              update({
                criteria: event.target.value
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      )}
      {config.engine === 'deterministic-rules' && config.rule && (
        <div className="form-grid-two">
          <label className="form-field">
            <span>Rule field</span>
            <select
              value={config.rule.path}
              onChange={(event) =>
                update({
                  rule: {
                    ...config.rule!,
                    path: event.target.value as NonNullable<DecisionGateConfig['rule']>['path'],
                    value:
                      event.target.value === 'build.success'
                        ? true
                        : event.target.value === 'finalGate.status'
                          ? 'PASS'
                          : 0,
                  },
                })
              }
            >
              <option value="tests.failed">Failed test stages</option>
              <option value="build.success">Build succeeded</option>
              <option value="review.openCritical">Open critical findings</option>
              <option value="review.openHigh">Open high findings</option>
              <option value="finalGate.status">Final gate status</option>
            </select>
          </label>
          <label className="form-field">
            <span>Equals</span>
            <input
              value={String(config.rule.value)}
              onChange={(event) =>
                update({
                  rule: {
                    ...config.rule!,
                    operator: 'equals',
                    value:
                      config.rule!.path === 'build.success'
                        ? event.target.value === 'true'
                        : config.rule!.path === 'finalGate.status'
                          ? event.target.value
                          : Number(event.target.value),
                  },
                })
              }
            />
          </label>
        </div>
      )}
      <fieldset className="condition-skip-targets">
        <legend>Decision input preview — what the engine receives</legend>
        {INPUT_CATEGORIES.map((category) => (
          <label className="rule-flag" key={category}>
            <input
              type="checkbox"
              checked={config.inputs.includes(category)}
              onChange={(event) =>
                update({
                  inputs: event.target.checked
                    ? [...config.inputs, category]
                    : config.inputs.filter((item) => item !== category),
                })
              }
            />
            {decisionInputLabel(category)}
          </label>
        ))}
        <small className="quiet-note">
          Bounded summaries and structured artifacts only (default 24,000 characters); never full transcripts
          or raw logs.
        </small>
      </fieldset>
      <div className="form-grid-two">
        <label className="form-field">
          <span>Routing reads</span>
          <select
            value={routing.field}
            onChange={(event) =>
              setRouting({ field: event.target.value as DecisionGateConfig['routing']['field'] })
            }
          >
            {config.questionType !== 'score' && (
              <option value="probability">probability (engine-reported)</option>
            )}
            {config.questionType !== 'score' && (
              <option value="confidence">confidence (engine-reported)</option>
            )}
            {config.questionType === 'score' && <option value="score">score</option>}
          </select>
          <small>Probability and confidence are different fields; neither substitutes for the other.</small>
        </label>
        {config.questionType !== 'choice' && routing.field !== 'confidence' && (
          <>
            <label className="form-field small-number-field">
              <span>PASS at or above</span>
              <input
                type="number"
                step={0.01}
                value={routing.passAtOrAbove ?? ''}
                onChange={(event) =>
                  setRouting({
                    passAtOrAbove: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="form-field small-number-field">
              <span>FAIL at or below</span>
              <input
                type="number"
                step={0.01}
                value={routing.failAtOrBelow ?? ''}
                onChange={(event) =>
                  setRouting({
                    failAtOrBelow: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
            </label>
          </>
        )}
        {(config.questionType === 'choice' ||
          routing.field === 'confidence' ||
          config.questionType === 'score') && (
          <label className="form-field small-number-field">
            <span>Minimum confidence (else UNCERTAIN)</span>
            <input
              type="number"
              step={0.01}
              min={0}
              max={1}
              value={routing.minConfidence ?? ''}
              onChange={(event) =>
                setRouting({
                  minConfidence: event.target.value === '' ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
        )}
      </div>
      <div className="form-grid-two">
        {config.questionType === 'choice' ? (
          Object.keys(choiceOptions).map((option) => (
            <RouteActionField
              key={option}
              label={`When “${option}”`}
              value={routing.choiceRoutes?.[option] ?? { action: 'human-approval' }}
              laterStages={laterStages}
              allowEscalate={false}
              onChange={(value) => setRouting({ choiceRoutes: { ...routing.choiceRoutes, [option]: value } })}
            />
          ))
        ) : (
          <>
            <RouteActionField
              label="On PASS"
              value={routing.onPass}
              laterStages={laterStages}
              allowEscalate={false}
              onChange={(value) => setRouting({ onPass: value })}
            />
            <RouteActionField
              label="On FAIL"
              value={routing.onFail}
              laterStages={laterStages}
              allowEscalate={false}
              onChange={(value) => setRouting({ onFail: value })}
            />
          </>
        )}
        <RouteActionField
          label="On UNCERTAIN"
          value={routing.onUncertain}
          laterStages={laterStages}
          allowEscalate
          onChange={(value) => setRouting({ onUncertain: value })}
        />
      </div>
      {routing.onUncertain.action === 'escalate' && (
        <div className="form-grid-two">
          <EngineRouteFields
            label="Escalation engine"
            route={config.escalation ?? { engine: 'subscription-llm-judge' }}
            providers={providers}
            profiles={profiles}
            onChange={(patch) =>
              update({
                escalation: {
                  ...(config.escalation ?? { engine: 'subscription-llm-judge' }),
                  ...(patch as object),
                } as DecisionGateConfig['escalation'],
              })
            }
          />
        </div>
      )}
      {config.engine === 'deterministic-rules' && (
        <div className="stage-actions-row">
          <button
            type="button"
            className="quiet-button"
            onClick={() =>
              void api
                .testDecisionGate({
                  decision: config,
                  fixtures: [
                    {
                      name: 'Rule satisfied',
                      conditionValues: { [config.rule!.path]: config.rule!.value },
                      expected: true,
                    },
                    {
                      name: 'Rule not satisfied',
                      conditionValues: {
                        [config.rule!.path]:
                          typeof config.rule!.value === 'number'
                            ? Number(config.rule!.value) + 1
                            : !config.rule!.value,
                      },
                      expected: false,
                    },
                  ],
                  billingMode: 'subscriptions-only',
                  maxCostUsd: null,
                  confirmExternal: false,
                })
                .then((result) =>
                  setTestResult(
                    `Accuracy ${result.accuracy === null ? 'n/a' : `${Math.round(Number(result.accuracy) * 100)}%`} · escalation rate ${Math.round(Number(result.escalationRate ?? 0) * 100)}%`,
                  ),
                )
                .catch((error: unknown) =>
                  setTestResult(error instanceof Error ? error.message : 'Test failed.'),
                )
            }
          >
            Test policy with fixtures
          </button>
          {testResult && <small>{testResult}</small>}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Run preview: routing summary ───────────────────────── */

export function RoutingSummaryPanel({ preview }: { preview: RunPreview }) {
  const routing = preview.routingSummary;
  if (!routing) return null;
  const money = (value: number | null) => (value === null ? 'none set' : `$${value.toFixed(2)}`);
  return (
    <section className="surface-panel billing-preview-panel" aria-label="Billing routing summary">
      <div className="section-title-row">
        <div>
          <h3>Billing routing · {billingModeLabel(preview.billingMode)}</h3>
          <p>Every stage's exact lane. Nothing outside these lanes can run.</p>
        </div>
        <LockKeyhole size={16} className="muted-icon" />
      </div>
      <div className="billing-lane-list">
        <div>
          <strong>SUBSCRIPTIONS USED</strong>
          <span />
        </div>
        {routing.subscriptions.map((lane) => (
          <div key={lane.billingLane}>
            <strong>{lane.label}</strong>
            <span>
              {lane.stages.length
                ? `${lane.stages.length} stage${lane.stages.length === 1 ? '' : 's'} · ${lane.stages.join(', ')}`
                : '0'}
            </span>
          </div>
        ))}
        <div>
          <strong>METERED</strong>
          <span>{routing.meteredNone ? 'None' : ''}</span>
        </div>
        {routing.metered.map((lane) => (
          <div key={lane.billingLane}>
            <strong>{lane.label}</strong>
            <span>
              {lane.decisionStages.length
                ? `${lane.decisionStages.length} Decision stage${lane.decisionStages.length === 1 ? '' : 's'} (${lane.decisionStages.join(', ')})`
                : ''}
              {lane.decisionStages.length && lane.generativeStages.length ? ' · ' : ''}
              {lane.generativeStages.length
                ? `${lane.generativeStages.length} generative (${lane.generativeStages.join(', ')})`
                : ''}
            </span>
          </div>
        ))}
        <div>
          <strong>Run metered cap</strong>
          <span>
            {money(routing.runMeteredCapUsd)}
            {routing.dailyBudgetUsd !== null ? ` · daily ${money(routing.dailyBudgetUsd)}` : ''}
            {routing.monthlyBudgetUsd !== null ? ` · monthly ${money(routing.monthlyBudgetUsd)}` : ''}
          </span>
        </div>
        <div>
          <strong>Unknown-cost requests</strong>
          <span>
            {routing.unknownCostPolicy === 'block'
              ? 'Blocked'
              : routing.unknownCostPolicy === 'ask'
                ? 'Ask first'
                : 'Allowed with warning (cap not guaranteed)'}
          </span>
        </div>
        <div>
          <strong>PAYG / API fallback</strong>
          <span>{routing.paygFallback === 'none' ? 'NONE' : 'Configured'}</span>
        </div>
        <div>
          <strong>External decision data</strong>
          <span>
            {routing.externalDecisionDataPolicy === 'allow'
              ? 'Allowed'
              : routing.externalDecisionDataPolicy === 'block'
                ? 'Blocked'
                : 'Ask before first send'}
          </span>
        </div>
      </div>
      {preview.providerFallbackStatus.map((fallback) => (
        <p className="quiet-note" key={`${fallback.billingLane}-${fallback.backendId}`}>
          Provider-side fallback · {billingLaneLabel(fallback.billingLane ?? 'unknown')}:{' '}
          {fallback.status === 'unknown' ? 'UNKNOWN' : fallback.status} — {fallback.message}
        </p>
      ))}
    </section>
  );
}

export function decisionAssignmentLine(assignment: RunPreview['providerAssignments'][number]): string | null {
  if (!assignment.decision) return null;
  const engine =
    DECISION_ENGINES.find((item) => item.id === assignment.decision!.engine)?.label ??
    assignment.decision.engine;
  return `${engine} · ${assignment.decision.questionType} · routes on ${assignment.decision.routingField} · inputs ${assignment.decision.inputs.map(decisionInputLabel).join(', ') || 'rule only'}${assignment.decision.escalation ? ` · escalates to ${assignment.decision.escalation}` : ''} · config ${assignment.decision.configHash.slice(0, 10)}`;
}

/* ───────────────────────── Run detail: decisions ───────────────────────── */

export function DecisionResultsPanel({ decisions }: { decisions: DecisionResult[] }) {
  if (!decisions.length) return null;
  const pct = (value: number | null) => (value === null ? '—' : value.toFixed(3));
  return (
    <section className="surface-panel usage-table-panel" aria-label="Decision results">
      <div className="panel-title-row">
        <div>
          <h2>Decision Gate results</h2>
          <p>
            Answer, probability, confidence, and score are separate engine fields. Config hashes make each
            decision auditable.
          </p>
        </div>
        <Scale size={16} className="muted-icon" />
      </div>
      <div className="usage-table">
        <div className="usage-table-head">
          <span>Engine / model</span>
          <span>Outcome</span>
          <span>Fields</span>
          <span>Cost</span>
        </div>
        {decisions.map((decision) => (
          <div className="usage-table-row" key={decision.id}>
            <span className="usage-key">
              <strong>
                {decision.engine}
                {decision.escalatedFromId ? ' · escalation' : ''}
              </strong>
              <small>
                {decision.configuredModelId ?? 'local rules'}
                {decision.resolvedModelId && decision.resolvedModelId !== decision.configuredModelId
                  ? ` → ${decision.resolvedModelId}`
                  : ''}{' '}
                · {decision.configHash.slice(0, 10)}
              </small>
            </span>
            <span>
              {decision.outcome.toUpperCase()} → {decision.route.action}
              <small>{decision.route.reason}</small>
            </span>
            <span>
              answer {decision.answer === null ? '—' : String(decision.answer)} · probability{' '}
              {pct(decision.probability)} · confidence {pct(decision.confidence)}
              {decision.confidenceKind ? ` (${decision.confidenceKind})` : ''}
              {decision.score !== null ? ` · score ${decision.score.toFixed(2)}` : ''}
            </span>
            <span>
              {decision.costUsd === null ? 'Unavailable' : `$${decision.costUsd.toFixed(6)}`}
              <small>{decision.inputTokens ?? '—'} in</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────── Settings: OpenRouter + budgets ───────────────────────── */

export function OpenRouterSettings({ onNotice }: { onNotice: (message: string) => void }) {
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
  return (
    <section className="surface-panel settings-section" aria-label="OpenRouter">
      <div className="panel-title-row">
        <div>
          <h2>OpenRouter (optional, metered)</h2>
          <p>
            Adding a connection changes no workflow, adds no Decision Gate, and enables no spending. Keys stay
            in desktop storage and never reach agents, prompts, exports, logs, or phones.
          </p>
        </div>
        <KeyRound size={16} className="muted-icon" />
      </div>
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
                  <button type="button" className="quiet-button" onClick={() => void store(profile.id, kind)}>
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
  return (
    <section className="surface-panel settings-section" aria-label="Metered budgets">
      <div className="panel-title-row">
        <div>
          <h2>Turing metered budgets</h2>
          <p>
            Hard caps across all runs, enforced by atomic reservation before each metered request. Separate
            from provider key limits.
          </p>
        </div>
        <Shield size={16} className="muted-icon" />
      </div>
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
    </section>
  );
}

/* ───────────────────────── Usage explorer ───────────────────────── */

const SERIES = [
  { key: 'uncached', label: 'Input (uncached)', color: '#2a78d6' },
  { key: 'cached', label: 'Cached input', color: '#1baf7a' },
  { key: 'output', label: 'Output', color: '#eb6834' },
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
                      fill={series.color}
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
          <div className="chart-tooltip" style={{ left: `${((hover + 0.5) / bars.length) * 100}%` }}>
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
                    </span>
                    <span>
                      Turing monthly budget{' '}
                      <strong>
                        {budget.monthly.capUsd === null
                          ? 'No cap'
                          : `$${(budget.monthly.capUsd - budget.monthly.committedUsd).toFixed(4)} left of $${budget.monthly.capUsd.toFixed(2)}`}
                      </strong>
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
