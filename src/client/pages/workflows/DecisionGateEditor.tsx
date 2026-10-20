import { useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, Scale, XCircle } from 'lucide-react';
import { billingModeLabel, resolveBillingMode } from '../../../shared/billing';
import {
  decisionPrerequisites,
  unmetPrerequisites,
  type Prerequisite,
  type PrerequisiteFix,
  type PrerequisiteStatus,
} from '../../../shared/decisionPrerequisites';
import { routingSummary } from '../../../shared/decisionSummary';
import {
  DECISION_ENGINES,
  DEFAULT_JEV_MODEL,
  decisionEngineInfo,
  decisionInputLabel,
  validateDecisionGate,
} from '../../../shared/decisions';
import type {
  DecisionEngineId,
  DecisionGateConfig,
  DecisionInputCategory,
  DecisionRouteAction,
  ProviderStatus,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';
import { api, type ConnectionProfileWithCredentials } from '../../api';
import { defaultDecisionConfig } from './stageFactory';

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

const QUESTION_TYPES: Array<{ id: DecisionGateConfig['questionType']; label: string; hint: string }> = [
  { id: 'boolean', label: 'Yes / no', hint: 'Is a statement true? Routes on probability or confidence.' },
  { id: 'choice', label: 'Choose an option', hint: 'Pick one of your named options.' },
  { id: 'score', label: 'Score', hint: 'Rate against ordered levels you define.' },
];

const STATUS_ICON = { met: CheckCircle2, missing: XCircle, attention: AlertTriangle, unknown: CircleHelp };
const STATUS_WORD: Record<PrerequisiteStatus, string> = {
  met: 'Met',
  missing: 'Missing',
  attention: 'Needs attention',
  unknown: 'Unknown',
};

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

type Route = {
  engine: DecisionEngineId;
  modelId?: string;
  connectionProfileId?: string;
  judge?: DecisionGateConfig['judge'];
};

/** Engine, connection and exact model for the primary or escalation route. Nothing is chosen on the person's behalf. */
function EngineRouteFields({
  idPrefix,
  label,
  route,
  providers,
  profiles,
  onChange,
}: {
  idPrefix: string;
  label: string;
  route: Route;
  providers: ProviderStatus[];
  profiles: ConnectionProfileWithCredentials[];
  onChange: (patch: Partial<DecisionGateConfig>) => void;
}) {
  const openRouter = providers.find((provider) => provider.id === 'openrouter');
  const openRouterProfiles = profiles.filter((profile) => profile.backendId === 'openrouter');
  const models = (openRouter?.models ?? []).filter((model) =>
    route.engine === 'jev-openrouter' ? model.family === 'decision' : model.family !== 'decision',
  );
  const cataloguePresent = Boolean(openRouter?.detected) && models.length > 0;
  const listId = `${idPrefix}-models`;
  return (
    <>
      <label className="form-field">
        <span>{label}</span>
        <select
          id={`${idPrefix}-engine`}
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
              id={`${idPrefix}-connection`}
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
              id={`${idPrefix}-model`}
              list={cataloguePresent ? listId : undefined}
              value={route.modelId ?? ''}
              spellCheck={false}
              onChange={(event) => onChange({ modelId: event.target.value || undefined })}
              placeholder={route.engine === 'jev-openrouter' ? DEFAULT_JEV_MODEL : 'provider/model'}
            />
            <small>
              {cataloguePresent
                ? `Choose from ${models.length} listed ${route.engine === 'jev-openrouter' ? 'decision' : 'generative'} models or type an exact ID. A saved version is never changed to a newer one.`
                : 'No OpenRouter catalogue is available, so the ID is not verified. It is sent exactly as written.'}
            </small>
            <datalist id={listId}>
              {models.map((model) => (
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

/** What a gate needs before it can run, with an explicit button for each fix. Every button is a deliberate click. */
function PrerequisitesPanel({
  items,
  workflow,
  onWorkflowChange,
  onOpenOpenRouterSettings,
  idPrefix,
}: {
  items: Prerequisite[];
  workflow: WorkflowDefinition;
  onWorkflowChange: (patch: Partial<WorkflowDefinition>) => void;
  onOpenOpenRouterSettings: () => void;
  idPrefix: string;
}) {
  const [capText, setCapText] = useState('');
  const budget = workflow.meteredBudget ?? { perRunUsd: null, unknownCostPolicy: 'block' as const };
  const focus = (suffix: string) => document.getElementById(`${idPrefix}-${suffix}`)?.focus();
  const fixControl = (fix: PrerequisiteFix | undefined) => {
    if (!fix) return null;
    switch (fix.kind) {
      case 'open-openrouter-settings':
        return (
          <button type="button" className="secondary-button" onClick={onOpenOpenRouterSettings}>
            Set up OpenRouter in Settings <ExternalLink size={12} aria-hidden="true" />
          </button>
        );
      case 'choose-connection':
        return (
          <button type="button" className="secondary-button" onClick={() => focus('connection')}>
            Choose a connection
          </button>
        );
      case 'choose-model':
        return (
          <button type="button" className="secondary-button" onClick={() => focus('model')}>
            Choose a model
          </button>
        );
      case 'set-cap':
        return (
          <span className="prerequisite-cap">
            <label>
              <span className="sr-only">Per-run cap in US dollars</span>
              <input
                type="number"
                min={0.01}
                max={1000}
                step={0.01}
                inputMode="decimal"
                value={capText}
                placeholder="Per-run cap, USD"
                onChange={(event) => setCapText(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!(Number(capText) > 0)}
              onClick={() => onWorkflowChange({ meteredBudget: { ...budget, perRunUsd: Number(capText) } })}
            >
              Set cap
            </button>
          </span>
        );
      case 'use-decision-budget':
        return (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              onWorkflowChange({ billingMode: 'subscriptions-plus-decision-budget', subscriptionOnly: true })
            }
          >
            Use Subscriptions + Decision Budget
          </button>
        );
      case 'edit-allowed-lanes':
        return (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              onWorkflowChange({
                customAllowedLanes: [...(workflow.customAllowedLanes ?? []), 'openrouter-metered'],
              })
            }
          >
            Allow the OpenRouter metered lane
          </button>
        );
      case 'set-external-policy':
        return (
          <span className="stage-actions-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => onWorkflowChange({ externalDecisionDataPolicy: 'ask-first' })}
            >
              Ask before first send
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onWorkflowChange({ externalDecisionDataPolicy: 'allow' })}
            >
              Allow configured engines
            </button>
          </span>
        );
    }
  };
  return (
    <section className="decision-prerequisites" aria-labelledby={`${idPrefix}-prereq-title`}>
      <h4 id={`${idPrefix}-prereq-title`}>Before this gate can run</h4>
      <ul>
        {items.map((item) => {
          const Icon = STATUS_ICON[item.status];
          return (
            <li className={`prerequisite prerequisite-${item.status}`} key={item.id}>
              <div className="prerequisite-head">
                <Icon size={15} aria-hidden="true" />
                <strong>{item.label}</strong>
                <span className="readiness-word">{STATUS_WORD[item.status]}</span>
              </div>
              <p>{item.summary}</p>
              {item.detail && <small>{item.detail}</small>}
              {item.status !== 'met' && fixControl(item.fix)}
            </li>
          );
        })}
      </ul>
      <p className="quiet-note">
        None of these buttons runs a request. Billing is {billingModeLabel(resolveBillingMode(workflow))}.
      </p>
    </section>
  );
}

function ExternalTest({
  config,
  workflow,
  items,
}: {
  config: DecisionGateConfig;
  workflow: WorkflowDefinition;
  items: Prerequisite[];
}) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState('');
  const [cap, setCap] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const unmet = unmetPrerequisites(items);
  const capValue = Number(cap);
  const ready = unmet.length === 0 && sample.trim().length > 0 && capValue > 0 && capValue <= 10 && confirmed;
  const first = (result?.results as Array<Record<string, unknown>> | undefined)?.[0];
  const num = (value: unknown) =>
    typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : 'not reported';
  const run = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await api.testDecisionGate({
          decision: config,
          fixtures: [{ name: 'Sample evidence', state: { sampleEvidence: sample.trim() } }],
          billingMode: resolveBillingMode(workflow),
          maxCostUsd: capValue,
          confirmExternal: true,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The external test failed.');
    } finally {
      setRunning(false);
    }
  };
  return (
    <details
      className="settings-disclosure external-test"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        External test · may spend money
        <small>Sends sample text to OpenRouter. Never runs unless you confirm below.</small>
      </summary>
      {unmet.length > 0 && (
        <p className="setup-blocker" role="status">
          Not available yet: {unmet.map((item) => item.label.toLowerCase()).join(', ')}.
        </p>
      )}
      <label className="form-field">
        <span>Sample evidence (sent to OpenRouter)</span>
        <textarea
          rows={3}
          maxLength={4_000}
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          placeholder="Paste a short, non-sensitive example of the evidence this gate would receive."
        />
      </label>
      <label className="form-field small-number-field">
        <span>Spending cap for this test (USD, at most 10)</span>
        <input
          type="number"
          min={0.01}
          max={10}
          step={0.01}
          inputMode="decimal"
          value={cap}
          onChange={(event) => setCap(event.target.value)}
        />
        <small>
          The Desktop Master reserves this before sending and stops at the cap. It does not read your
          OpenRouter balance.
        </small>
      </label>
      <label className="toggle-line">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>
          <strong>I confirm this test sends the sample above to OpenRouter</strong>
          <small>It may spend money up to the cap, and the request is recorded in the usage ledger.</small>
        </span>
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={!ready || running}
        onClick={() => void run()}
      >
        {running ? 'Running test…' : 'Run external test'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {first && (
        <dl className="decision-test-result" aria-label="External test result">
          <div>
            <dt>Outcome</dt>
            <dd>
              {first.error ? `Error · ${String(first.error)}` : String(first.outcome ?? '').toUpperCase()}
            </dd>
          </div>
          <div>
            <dt>Probability</dt>
            <dd>{num(first.probability)}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{num(first.confidence)}</dd>
          </div>
          <div>
            <dt>Score</dt>
            <dd>{num(first.score)}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>
              {typeof result?.actualCostUsd === 'number'
                ? `$${(result.actualCostUsd as number).toFixed(4)} (${String(result?.costProvenance)})`
                : 'not reported'}
            </dd>
          </div>
        </dl>
      )}
    </details>
  );
}

/**
 * An optional Decision Gate laid out as Question, Evidence and Outcome, with every prerequisite listed together.
 * Probability, confidence and score are separate fields and UNCERTAIN is always spelled out. Opening, validating or
 * editing the gate never enables spending, authorises external data or sends a request.
 */
export function DecisionGateEditor({
  stage,
  laterStages,
  workflow,
  providers,
  connections,
  onChange,
  onWorkflowChange,
  onOpenOpenRouterSettings,
}: {
  stage: WorkflowStage;
  laterStages: WorkflowStage[];
  workflow: WorkflowDefinition;
  providers: ProviderStatus[];
  connections: ConnectionProfileWithCredentials[];
  onChange: (patch: Partial<WorkflowStage>) => void;
  onWorkflowChange: (patch: Partial<WorkflowDefinition>) => void;
  onOpenOpenRouterSettings: () => void;
}) {
  const uid = useId().replace(/:/g, '');
  const idPrefix = `gate-${uid}`;
  const config = stage.decision ?? defaultDecisionConfig();
  const update = (patch: Partial<DecisionGateConfig>) => onChange({ decision: { ...config, ...patch } });
  const routing = config.routing;
  const setRouting = (patch: Partial<DecisionGateConfig['routing']>) =>
    update({ routing: { ...routing, ...patch } });
  const choiceOptions = config.criteria && !Array.isArray(config.criteria) ? config.criteria : {};
  const scoreLevels = Array.isArray(config.criteria) ? config.criteria : [];
  const info = decisionEngineInfo(config.engine);
  const stageLabel = (id: string) => laterStages.find((item) => item.id === id)?.label ?? id;
  const summaryRows = routingSummary(config, stageLabel);
  const [checked, setChecked] = useState<string[] | null>(null);
  const [testResult, setTestResult] = useState('');

  const prerequisiteFor = (target: Route | undefined) =>
    target
      ? decisionPrerequisites({
          engine: target.engine,
          modelId: target.modelId,
          connectionProfileId: target.connectionProfileId,
          profiles: connections,
          openRouter: providers.find((provider) => provider.id === 'openrouter'),
          billingMode: resolveBillingMode(workflow),
          perRunUsd: workflow.meteredBudget?.perRunUsd ?? null,
          customAllowedLanes: workflow.customAllowedLanes,
          externalDataPolicy: workflow.externalDecisionDataPolicy ?? 'ask-first',
        })
      : [];
  const primaryItems = prerequisiteFor(config);
  const escalationItems = routing.onUncertain.action === 'escalate' ? prerequisiteFor(config.escalation) : [];
  const meteredEngine = config.engine === 'jev-openrouter' || config.engine === 'openrouter-judge';

  const checkConfiguration = () => {
    const laterIds = laterStages.map((item) => item.id);
    const problems = validateDecisionGate(config, stage.label, laterIds).map((message) =>
      message.replace(/^Decision Gate “[^”]*”:? ?/, ''),
    );
    const unmet = [...primaryItems, ...escalationItems].filter((item) => item.status === 'missing');
    setChecked([...problems, ...unmet.map((item) => `${item.label}: ${item.summary}`)]);
  };

  return (
    <div className="decision-gate-editor stage-wide">
      <div className="inline-callout">
        <Scale size={14} aria-hidden="true" />
        <span>
          <strong>Optional decision gate</strong>
          <small>
            The engine judges; Turing policy decides. A gate cannot bypass permissions, budgets, approvals or
            loop bounds.
          </small>
        </span>
      </div>

      <div className="form-grid-two decision-engine-row">
        <EngineRouteFields
          idPrefix={idPrefix}
          label="Decision engine"
          route={config}
          providers={providers}
          profiles={connections}
          onChange={update}
        />
      </div>

      {info.external && (
        <PrerequisitesPanel
          items={primaryItems}
          workflow={workflow}
          onWorkflowChange={onWorkflowChange}
          onOpenOpenRouterSettings={onOpenOpenRouterSettings}
          idPrefix={idPrefix}
        />
      )}

      <section className="decision-group" aria-labelledby={`${idPrefix}-question`}>
        <h4 id={`${idPrefix}-question`}>1 · Question</h4>
        <fieldset className="question-types">
          <legend className="sr-only">Question type</legend>
          {QUESTION_TYPES.map((type) => (
            <label
              className={`question-type ${config.questionType === type.id ? 'question-type-selected' : ''}`}
              key={type.id}
            >
              <input
                type="radio"
                name={`${idPrefix}-type`}
                checked={config.questionType === type.id}
                onChange={() =>
                  update({
                    questionType: type.id,
                    criteria:
                      type.id === 'choice'
                        ? {
                            COMPLETE: 'Ready to finish',
                            REMEDIATE: 'Needs remediation',
                            HUMAN: 'Needs a person',
                          }
                        : type.id === 'score'
                          ? ['Not done', 'Partly done', 'Mostly done', 'Complete']
                          : undefined,
                    routing:
                      type.id === 'boolean'
                        ? {
                            ...routing,
                            field: 'probability',
                            passAtOrAbove: 0.95,
                            failAtOrBelow: 0.15,
                            minConfidence: undefined,
                            choiceRoutes: undefined,
                          }
                        : type.id === 'choice'
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
                  })
                }
              />
              <span>
                <strong>{type.label}</strong>
                <small>{type.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
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
      </section>

      <section className="decision-group" aria-labelledby={`${idPrefix}-evidence`}>
        <h4 id={`${idPrefix}-evidence`}>2 · Evidence</h4>
        <p className="quiet-note">
          {info.external
            ? `Only the categories ticked below are sent to ${config.engine === 'subscription-llm-judge' ? 'the judge model' : 'OpenRouter'}.`
            : 'This engine runs on the Desktop Master. Nothing is sent anywhere.'}{' '}
          Bounded summaries and structured artifacts only (default 24,000 characters); never full transcripts
          or raw logs.
        </p>
        <fieldset className="condition-skip-targets">
          <legend>Categories sent to the engine</legend>
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
        </fieldset>
        {info.external && (
          <p className="evidence-summary" role="status">
            {config.inputs.length
              ? `Sent externally: ${config.inputs.map(decisionInputLabel).join(', ')}.`
              : 'No categories chosen yet, so the gate has nothing to judge.'}
          </p>
        )}
      </section>

      <section className="decision-group" aria-labelledby={`${idPrefix}-outcome`}>
        <h4 id={`${idPrefix}-outcome`}>3 · Outcome</h4>
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
            <small>
              Probability, confidence and score are different fields; none substitutes for another.
            </small>
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

        <div className="routing-summary" aria-label="Routing summary">
          <strong>How this gate routes</strong>
          <ul>
            {summaryRows.map((row) => (
              <li
                className={`routing-row routing-${row.outcome.toLowerCase()}`}
                key={`${row.outcome}-${row.when}`}
              >
                <span className="routing-outcome">{row.outcome}</span>
                <span>
                  When {row.when}: {row.then.charAt(0).toLowerCase()}
                  {row.then.slice(1)}.
                </span>
              </li>
            ))}
          </ul>
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
                onChange={(value) =>
                  setRouting({ choiceRoutes: { ...routing.choiceRoutes, [option]: value } })
                }
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
          <>
            <div className="form-grid-two">
              <EngineRouteFields
                idPrefix={`${idPrefix}-escalation`}
                label="Escalation engine"
                route={config.escalation ?? { engine: 'subscription-llm-judge' }}
                providers={providers}
                profiles={connections}
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
            {escalationItems.length > 0 && (
              <PrerequisitesPanel
                items={escalationItems}
                workflow={workflow}
                onWorkflowChange={onWorkflowChange}
                onOpenOpenRouterSettings={onOpenOpenRouterSettings}
                idPrefix={`${idPrefix}-escalation`}
              />
            )}
          </>
        )}
      </section>

      <section className="decision-group" aria-labelledby={`${idPrefix}-checks`}>
        <h4 id={`${idPrefix}-checks`}>Checks</h4>
        <div className="stage-actions-row">
          <button type="button" className="secondary-button" onClick={checkConfiguration}>
            Check configuration
          </button>
          <small>Runs on this device. Sends nothing and spends nothing.</small>
        </div>
        {checked && (
          <p className={checked.length ? 'setup-blocker' : 'quiet-note'} role="status">
            {checked.length
              ? `${checked.length} ${checked.length === 1 ? 'problem' : 'problems'}: ${checked.join(' ')}`
              : 'Configuration is valid and every prerequisite is met. This does not prove the model will answer or that the account has credit.'}
          </p>
        )}
        {config.engine === 'deterministic-rules' && config.rule && (
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
        {meteredEngine && <ExternalTest config={config} workflow={workflow} items={primaryItems} />}
      </section>
    </div>
  );
}
