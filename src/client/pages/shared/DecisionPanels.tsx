// The run-preview routing summary and the run-detail decision results. Decision Gate editing lives in pages/workflows/DecisionGateEditor.

import { LockKeyhole, Scale } from 'lucide-react';
import type { DecisionResult, RunPreview } from '../../../shared/types';
import { billingLaneLabel, billingModeLabel } from '../../../shared/billing';
import { DECISION_ENGINES, decisionInputLabel } from '../../../shared/decisions';

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
