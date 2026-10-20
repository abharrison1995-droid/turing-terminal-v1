// Decision Gate editing, the run-preview routing summary and the run-detail decision results.

import { useState } from 'react';
import { LockKeyhole, Scale } from 'lucide-react';
import type {
  DecisionEngineId,
  DecisionGateConfig,
  DecisionInputCategory,
  DecisionResult,
  DecisionRouteAction,
  ProviderStatus,
  RunPreview,
  WorkflowStage,
} from '../../../shared/types';
import { billingLaneLabel, billingModeLabel } from '../../../shared/billing';
import { DECISION_ENGINES, decisionInputLabel, DEFAULT_JEV_MODEL } from '../../../shared/decisions';
import { api, type ConnectionProfileWithCredentials } from '../../api';

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
