import { useEffect, useId, useRef, useState } from 'react';
import type {
  GoalAttestationCorrectionHistory,
  GoalAttestationCorrectionKind,
  GoalAttestationCorrectionReasonCode,
} from '../../shared/goalApi';
import { goalsApi } from './api';
import {
  CORRECTION_ACTIONS,
  CORRECTION_COPY,
  CORRECTION_KIND_LABEL,
  CORRECTION_REASON_LABEL,
  type CorrectionDraft,
  type CorrectionEffect,
  type CorrectionEvent,
  type CorrectionGate,
  type CorrectionState,
  correctionRefusal,
  correctionStandingLabel,
  initialCorrectionState,
  REASON_CODES,
  reduceCorrection,
} from './correctionModel';
import { ConfirmPanel } from './DefinitionParts';
import { formatTime } from './presentation';

export interface CorrectionReplacementOption {
  attestationId: string;
  label: string;
  title: string;
}

const NONE_AVAILABLE = 'No correction is available for this attestation from its current standing.';
const UNREADABLE_PENDING = 'A correction request could not be read. It is not shown and it is not acted on.';

/**
 * The correction controls for one selected attestation, desktop only, in the Handoff tab. Three actions, each with its own
 * confirmation. A request is one click on a confirm panel; a decision is one click on the gate. Every transition is
 * produced by the pure reducer in correctionModel.ts; this component only runs the effects it returns. A read on mount,
 * refresh or remount performs no write.
 */
export function GoalCorrection({
  goalId,
  handoffId,
  attestationId,
  refresh,
  replacementOptions,
}: {
  goalId: string;
  handoffId: string;
  attestationId: string;
  refresh: number | string;
  replacementOptions: CorrectionReplacementOption[];
}) {
  const [state, setState] = useState<CorrectionState>(() => initialCorrectionState(attestationId));
  const [history, setHistory] = useState<GoalAttestationCorrectionHistory | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const stateRef = useRef(state);
  const alertRef = useRef<HTMLParagraphElement>(null);

  // Applies one event to the latest state and returns the effects. Effects are data, so only a click reaches a write.
  const apply = (event: CorrectionEvent): CorrectionEffect[] => {
    const transition = reduceCorrection(stateRef.current, event);
    stateRef.current = transition.state;
    setState(transition.state);
    return transition.effects;
  };

  const dispatch = (event: CorrectionEvent) => run(apply(event));

  const run = (effects: CorrectionEffect[]) => {
    for (const effect of effects) {
      if (effect.type === 'reload') {
        setReloadTick((tick) => tick + 1);
      } else if (effect.type === 'request') {
        goalsApi.requestCorrection(goalId, handoffId, attestationId, effect.chainPosition, effect.body).then(
          (response) => run(apply({ type: 'requested', response })),
          (error: unknown) =>
            run(apply({ type: 'request_failed', refusal: correctionRefusal(error, 'request') })),
        );
      } else {
        const body =
          effect.decision === 'approved'
            ? {
                decision: 'approved' as const,
                attestationId: effect.attestationId,
                correctionKind: effect.correctionKind,
                explanation: effect.explanation,
              }
            : { decision: 'denied' as const };
        goalsApi.decideCorrection(goalId, effect.approvalId, effect.actionDigest, body).then(
          () => run(apply({ type: 'decided' })),
          (error: unknown) =>
            run(apply({ type: 'decide_failed', refusal: correctionRefusal(error, 'decide') })),
        );
      }
    }
  };

  // Reads only. Keyed by the attestation (the parent remounts this component when the selection changes), by the parent's
  // refresh generation and by the reducer's reload. A superseded read is dropped by the `live` flag.
  useEffect(() => {
    let live = true;
    goalsApi.correctionHistory(goalId, handoffId, attestationId).then(
      (next) => {
        if (!live) return;
        setHistory(next);
        dispatch({ type: 'loaded', history: next });
      },
      () => {
        if (!live) return;
        dispatch({ type: 'load_failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [goalId, handoffId, attestationId, refresh, reloadTick]);

  // A refusal moves focus to its alert. A new refusal is a new object, so a read that changes nothing does not refocus.
  useEffect(() => {
    if (state.refusal !== null) alertRef.current?.focus();
  }, [state.refusal]);

  const { phase } = state;
  const working = phase === 'requesting' || phase === 'deciding' || phase === 'verifying';

  return (
    <section
      className="goal-completion goal-correction"
      aria-label={CORRECTION_COPY.panelTitle}
      aria-busy={working}
    >
      <h4>{CORRECTION_COPY.panelTitle}</h4>
      <p>{CORRECTION_COPY.intro}</p>
      {history === null && state.refusal === null && <p role="status">{CORRECTION_COPY.loading}</p>}
      {history !== null && <CorrectionHistory history={history} />}
      {state.notice !== null && <p role="status">{state.notice}</p>}
      {state.refusal !== null && (
        <p className="form-error" role="alert" tabIndex={-1} ref={alertRef}>
          {state.refusal.message}
        </p>
      )}
      {phase === 'requesting' && <p role="status">{CORRECTION_COPY.requesting}</p>}
      {phase === 'deciding' && <p role="status">{CORRECTION_COPY.deciding}</p>}
      {phase === 'verifying' && <p role="status">{CORRECTION_COPY.verifying}</p>}

      {phase === 'idle' && history !== null && (
        <div className="goal-completion-action" role="group" aria-label="Correction actions">
          {state.allowed.length === 0 && <p className="goal-row-meta">{NONE_AVAILABLE}</p>}
          {state.allowed.map((kind) => (
            <button
              key={kind}
              type="button"
              className="secondary-button"
              onClick={() => dispatch({ type: 'review', kind })}
            >
              {CORRECTION_ACTIONS[kind].button}
            </button>
          ))}
        </div>
      )}

      {(phase === 'reviewing' || phase === 'requesting') && state.kind !== null && (
        <ReviewPanel
          key={state.kind}
          kind={state.kind}
          replacementOptions={replacementOptions}
          working={phase === 'requesting'}
          onCancel={() => dispatch({ type: 'cancel' })}
          onRequest={(draft) => dispatch({ type: 'request', draft })}
        />
      )}

      {(phase === 'gate_pending' || phase === 'deciding') && state.gate !== null && (
        <GatePanel
          gate={state.gate}
          working={working}
          onExplanation={(value) => dispatch({ type: 'explanation', value })}
          onConfirm={() => dispatch({ type: 'confirm' })}
          onDecline={() => dispatch({ type: 'decline' })}
        />
      )}
    </section>
  );
}

/** The verified standing and the stored corrections. The explanation text is never shown here. */
function CorrectionHistory({ history }: { history: GoalAttestationCorrectionHistory }) {
  return (
    <>
      <dl className="goal-handoff-identities" aria-label="Correction standing">
        <div className="goal-handoff-identity">
          <dt>Correction standing</dt>
          <dd>{correctionStandingLabel(history.standing.standing)}</dd>
        </div>
      </dl>
      {history.corrections.length > 0 && (
        <ul className="goal-plain-list" aria-label="Correction history">
          {history.corrections.map((row) => (
            <li key={row.correctionId}>
              {CORRECTION_KIND_LABEL[row.correctionKind]} · {CORRECTION_REASON_LABEL[row.reasonCode]} ·{' '}
              <time dateTime={row.decidedAt}>{formatTime(row.decidedAt)}</time>
            </li>
          ))}
        </ul>
      )}
      {history.pendingUnreadableCount > 0 && <p className="goal-row-meta">{UNREADABLE_PENDING}</p>}
    </>
  );
}

/** The confirmation for one kind. Its own dialog, its own consequence copy, and a request only on the explicit button. */
function ReviewPanel({
  kind,
  replacementOptions,
  working,
  onCancel,
  onRequest,
}: {
  kind: GoalAttestationCorrectionKind;
  replacementOptions: CorrectionReplacementOption[];
  working: boolean;
  onCancel: () => void;
  onRequest: (draft: CorrectionDraft) => void;
}) {
  const action = CORRECTION_ACTIONS[kind];
  const reasonId = useId();
  const explanationId = useId();
  const replacementId = useId();
  const [reason, setReason] = useState<GoalAttestationCorrectionReasonCode | ''>('');
  const [explanation, setExplanation] = useState('');
  const [replacement, setReplacement] = useState('');
  const needsReplacement = kind === 'supersede';
  const ready = reason !== '' && (!needsReplacement || replacement !== '');

  const submit = () => {
    if (reason === '' || (needsReplacement && replacement === '')) return;
    onRequest({
      kind,
      reasonCode: reason,
      explanation,
      replacementAttestationId: needsReplacement ? replacement : null,
    });
  };

  return (
    <ConfirmPanel
      label={action.button}
      title={action.title}
      description={action.consequence}
      busy={working}
      onCancel={onCancel}
    >
      <p className="goal-row-meta">{CORRECTION_COPY.requestOnly}</p>
      <div className="goal-completion-action">
        <label htmlFor={reasonId}>{CORRECTION_COPY.reasonLabel}</label>
        <select
          id={reasonId}
          value={reason}
          disabled={working}
          onChange={(event) => setReason(event.target.value as GoalAttestationCorrectionReasonCode | '')}
        >
          <option value="">Choose a reason</option>
          {REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {CORRECTION_REASON_LABEL[code]}
            </option>
          ))}
        </select>
      </div>
      {needsReplacement && (
        <div className="goal-completion-action">
          <label htmlFor={replacementId}>{CORRECTION_COPY.replacementLabel}</label>
          {replacementOptions.length === 0 ? (
            <p className="goal-row-meta">{CORRECTION_COPY.replacementNone}</p>
          ) : (
            <select
              id={replacementId}
              value={replacement}
              disabled={working}
              onChange={(event) => setReplacement(event.target.value)}
            >
              <option value="">Choose an attestation</option>
              {replacementOptions.map((option) => (
                <option key={option.attestationId} value={option.attestationId} title={option.title}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="goal-completion-action">
        <label htmlFor={explanationId}>{CORRECTION_COPY.explanationLabel}</label>
        <textarea
          id={explanationId}
          rows={3}
          maxLength={1000}
          value={explanation}
          disabled={working}
          onChange={(event) => setExplanation(event.target.value)}
        />
        <p className="goal-row-meta">{CORRECTION_COPY.explanationCounter(explanation.length)}</p>
        <p className="goal-row-meta">{CORRECTION_COPY.requestHelp}</p>
      </div>
      <div className="goal-completion-action">
        <button
          type="button"
          className="secondary-button"
          data-confirm-safe
          disabled={working}
          onClick={onCancel}
        >
          {CORRECTION_COPY.cancel}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={working || !ready}
          aria-busy={working}
          onClick={submit}
        >
          {action.request}
        </button>
      </div>
    </ConfirmPanel>
  );
}

/** The pending request this session holds. Confirm records it; Decline discards it. Nothing changes until one of them. */
function GatePanel({
  gate,
  working,
  onExplanation,
  onConfirm,
  onDecline,
}: {
  gate: CorrectionGate;
  working: boolean;
  onExplanation: (value: string) => void;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const explanationId = useId();
  const confirmBlocked =
    working ||
    gate.outOfDate ||
    (gate.explanationRequired && (gate.explanation === null || gate.explanation === ''));
  return (
    <div className="goal-completion-action" role="group" aria-label={CORRECTION_COPY.gateHeading}>
      <h5>{CORRECTION_COPY.gateHeading}</h5>
      <p>{CORRECTION_COPY.gateHelp}</p>
      <p className="goal-row-meta">
        {CORRECTION_KIND_LABEL[gate.correctionKind]} · {CORRECTION_REASON_LABEL[gate.reasonCode]}
      </p>
      {gate.explanationRequired && (
        <>
          <label htmlFor={explanationId}>{CORRECTION_COPY.explanationLabel}</label>
          <textarea
            id={explanationId}
            rows={3}
            maxLength={1000}
            value={gate.explanation ?? ''}
            disabled={working}
            onChange={(event) => onExplanation(event.target.value)}
          />
          {(gate.explanation === null || gate.explanation === '') && (
            <p className="goal-row-meta">{CORRECTION_COPY.explanationAgain}</p>
          )}
        </>
      )}
      {gate.outOfDate && <p className="form-error">{CORRECTION_COPY.gateOutOfDate}</p>}
      <div className="goal-completion-action">
        <button
          type="button"
          className="primary-button"
          disabled={confirmBlocked}
          aria-busy={working}
          onClick={onConfirm}
        >
          {CORRECTION_COPY.confirmLabel}
        </button>
        <button type="button" className="secondary-button" disabled={working} onClick={onDecline}>
          {CORRECTION_COPY.declineLabel}
        </button>
      </div>
    </div>
  );
}
