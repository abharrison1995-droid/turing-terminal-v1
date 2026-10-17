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
  CORRECTION_RECOVERY_COPY,
  type CorrectionDraft,
  type CorrectionEffect,
  type CorrectionEvent,
  type CorrectionGate,
  type CorrectionRequestBody,
  type CorrectionState,
  correctionRefusal,
  correctionStandingLabel,
  initialCorrectionState,
  isUsableCorrectionHistory,
  REASON_CODES,
  reduceCorrection,
} from './correctionModel';
import { ConfirmPanel } from './DefinitionParts';
import {
  beginInflight,
  type InflightWrite,
  isInflightAt,
  settleInflight,
  subscribeInflight,
} from './inflightWrites';
import { formatTime } from './presentation';
import { isUnknownOutcome } from './unknownOutcome';

export interface CorrectionReplacementOption {
  attestationId: string;
  label: string;
  title: string;
}

const NONE_AVAILABLE = 'No correction is available for this attestation from its current standing.';

/**
 * The holds on this panel's write controls. `request` disables sending a request, `decision` disables the gate. `elsewhere`
 * is set when a read found the matching write unresolved in another panel, so the status line can say so.
 */
interface WriteHold {
  request: boolean;
  decision: boolean;
  elsewhere: boolean;
}

const NO_HOLD: WriteHold = { request: false, decision: false, elsewhere: false };

/**
 * The holds a read sets. A request is named by its chain position, which the read shows and which the server checks, so
 * any request at this position still unresolved elsewhere holds the request control. The gate's decision is named by its
 * approval, so only a decision on the pending approval holds the gate.
 */
function holdFor(
  goalId: string,
  handoffId: string,
  attestationId: string,
  owner: string,
  history: GoalAttestationCorrectionHistory,
): WriteHold {
  const request = isInflightAt(
    { goalId, handoffId, attestationId, kind: 'correction-request', identity: history.chainPosition },
    owner,
  );
  const approvalId = history.pending[0]?.approvalId ?? null;
  const decision =
    approvalId !== null &&
    isInflightAt(
      { goalId, handoffId: null, attestationId, kind: 'correction-decision', identity: approvalId },
      owner,
    );
  return { request, decision, elsewhere: request || decision };
}

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
  const rootRef = useRef<HTMLElement>(null);
  // Armed by a click's failed write only, and consumed by the next refusal. A read that fails never arms it.
  const focusRefusal = useRef(false);
  // The action whose review the user closed with Cancel or Escape. Focus returns to it.
  const reopenKind = useRef<GoalAttestationCorrectionKind | null>(null);
  // This panel's identity in the in-flight registry, stable for its life.
  const owner = useId();
  const [hold, setHold] = useState<WriteHold>(NO_HOLD);

  // Applies one event to the latest state and returns the effects. Effects are data, so only a click reaches a write.
  const apply = (event: CorrectionEvent): CorrectionEffect[] => {
    const transition = reduceCorrection(stateRef.current, event);
    stateRef.current = transition.state;
    setState(transition.state);
    return transition.effects;
  };

  const dispatch = (event: CorrectionEvent) => run(apply(event));

  // A failed write moves focus to its refusal only when that refusal is new. An unknown outcome sets no refusal, and an
  // ignored event keeps the old one, so the flag is never left armed for a later read to consume.
  const failed = (event: CorrectionEvent) => {
    const before = stateRef.current.refusal;
    const effects = apply(event);
    focusRefusal.current = stateRef.current.refusal !== null && stateRef.current.refusal !== before;
    run(effects);
  };

  const run = (effects: CorrectionEffect[]) => {
    for (const effect of effects) {
      if (effect.type === 'reload') {
        setReloadTick((tick) => tick + 1);
      } else if (effect.type === 'request') {
        const write: InflightWrite = {
          goalId,
          handoffId,
          attestationId,
          kind: 'correction-request',
          identity: effect.chainPosition,
          detail: JSON.stringify(effect.body),
        };
        const handle = beginInflight(write, owner);
        if (handle === 'busy') {
          // Not sent. The reducer keeps the draft at this position, and the request control stays disabled.
          setHold((prior) => ({ ...prior, request: true }));
          failed({
            type: 'request_failed',
            refusal: { message: CORRECTION_COPY.inFlightBusy, next: 'keep' },
            unknown: false,
          });
          continue;
        }
        try {
          goalsApi
            .requestCorrection(goalId, handoffId, attestationId, effect.chainPosition, effect.body)
            .then(
              (response) => {
                settleInflight(handle);
                run(apply({ type: 'requested', response }));
              },
              (error: unknown) => {
                settleInflight(handle);
                failed({
                  type: 'request_failed',
                  refusal: correctionRefusal(error, 'request'),
                  unknown: isUnknownOutcome(error),
                });
              },
            );
        } catch (error: unknown) {
          // The call threw before it returned a promise, so neither handler above was attached. This is the only settle.
          settleInflight(handle);
          failed({
            type: 'request_failed',
            refusal: correctionRefusal(error, 'request'),
            unknown: isUnknownOutcome(error),
          });
        }
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
        const write: InflightWrite = {
          goalId,
          handoffId: null,
          attestationId: effect.attestationId,
          kind: 'correction-decision',
          identity: effect.approvalId,
          detail: JSON.stringify({ actionDigest: effect.actionDigest, body }),
        };
        const handle = beginInflight(write, owner);
        if (handle === 'busy') {
          setHold((prior) => ({ ...prior, decision: true }));
          failed({
            type: 'decide_failed',
            refusal: { message: CORRECTION_COPY.inFlightBusy, next: 'keep' },
            unknown: false,
          });
          continue;
        }
        try {
          goalsApi.decideCorrection(goalId, effect.approvalId, effect.actionDigest, body).then(
            () => {
              settleInflight(handle);
              run(apply({ type: 'decided' }));
            },
            (error: unknown) => {
              settleInflight(handle);
              failed({
                type: 'decide_failed',
                refusal: correctionRefusal(error, 'decide'),
                unknown: isUnknownOutcome(error),
              });
            },
          );
        } catch (error: unknown) {
          // The call threw before it returned a promise, so neither handler above was attached. This is the only settle.
          settleInflight(handle);
          failed({
            type: 'decide_failed',
            refusal: correctionRefusal(error, 'decide'),
            unknown: isUnknownOutcome(error),
          });
        }
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
        if (!isUsableCorrectionHistory(next)) {
          dispatch({ type: 'load_failed' });
          return;
        }
        setHistory(next);
        setHold(holdFor(goalId, handoffId, attestationId, owner, next));
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
  }, [goalId, handoffId, attestationId, refresh, reloadTick, owner]);

  // A write for this attestation that another panel began settles: read the saved history again. This panel's own writes
  // are not notified, because its reducer already holds their result.
  useEffect(
    () => subscribeInflight(goalId, attestationId, owner, () => setReloadTick((tick) => tick + 1)),
    [goalId, attestationId, owner],
  );

  // A refusal from the user's own click moves focus to its alert. A refusal from a read does not, so a background read
  // cannot take focus away from the user.
  useEffect(() => {
    if (state.refusal !== null && focusRefusal.current) {
      focusRefusal.current = false;
      alertRef.current?.focus();
    }
  }, [state.refusal]);

  // Cancel and Escape end a review. The action that opened it is mounted again once the review closes, so focus returns
  // to it there, and not to the dialog's removed control.
  useEffect(() => {
    if (state.phase !== 'idle' || reopenKind.current === null) return;
    const kind = reopenKind.current;
    reopenKind.current = null;
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-correction-kind="${kind}"]`)?.focus();
  }, [state.phase]);

  const { phase } = state;
  const working =
    phase === 'requesting' ||
    phase === 'deciding' ||
    phase === 'verifying' ||
    (phase === 'reconciling' && state.refusal === null);

  return (
    <section
      ref={rootRef}
      className="goal-completion goal-correction"
      aria-label={CORRECTION_COPY.panelTitle}
      aria-busy={working}
    >
      <h4>{CORRECTION_COPY.panelTitle}</h4>
      <p>{CORRECTION_COPY.intro}</p>
      {history !== null && <CorrectionHistory history={history} />}
      {/* One status region from the first render: it is never unmounted, so each change is announced in place. */}
      <div className="goal-correction-status" role="status" aria-live="polite" aria-atomic="true">
        {history === null && state.refusal === null && <p>{CORRECTION_COPY.loading}</p>}
        {state.notice !== null && <p>{state.notice}</p>}
        {phase === 'requesting' && <p>{CORRECTION_COPY.requesting}</p>}
        {phase === 'deciding' && <p>{CORRECTION_COPY.deciding}</p>}
        {phase === 'verifying' && <p>{CORRECTION_COPY.verifying}</p>}
        {hold.elsewhere && <p>{CORRECTION_COPY.inFlightElsewhere}</p>}
      </div>
      {state.refusal !== null && (
        <p className="form-error" role="alert" tabIndex={-1} ref={alertRef}>
          {state.refusal.message}
        </p>
      )}
      {phase === 'reconciling' && state.refusal !== null && (
        <button type="button" className="secondary-button" onClick={() => dispatch({ type: 'check_again' })}>
          {CORRECTION_RECOVERY_COPY.checkAgain}
        </button>
      )}

      {phase === 'idle' && history !== null && (
        <div className="goal-completion-action" role="group" aria-label="Correction actions">
          {state.allowed.length === 0 && <p className="goal-row-meta">{NONE_AVAILABLE}</p>}
          {state.allowed.map((kind) => (
            <button
              key={kind}
              type="button"
              className="secondary-button"
              data-correction-kind={kind}
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
          held={state.unknown?.write === 'request' ? state.unknown.body : null}
          blocked={history !== null && history.pendingUnreadableCount > 0}
          inFlight={hold.request}
          replacementOptions={replacementOptions}
          working={phase === 'requesting'}
          onCancel={() => {
            dispatch({ type: 'cancel' });
            // Focus returns to the opener only when this click closed the review. A cancel the reducer ignores leaves the
            // review open, so a later read that closes it must not move focus.
            reopenKind.current = stateRef.current.phase === 'idle' ? state.kind : null;
          }}
          onRequest={(draft) => dispatch({ type: 'request', draft })}
        />
      )}

      {(phase === 'gate_pending' || phase === 'deciding') && state.gate !== null && (
        <GatePanel
          gate={state.gate}
          working={working}
          inFlight={hold.decision}
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
      {history.pendingUnreadableCount > 0 && (
        <p className="goal-row-meta">{CORRECTION_RECOVERY_COPY.unreadablePending}</p>
      )}
    </>
  );
}

/** The confirmation for one kind. Its own dialog, its own consequence copy, and a request only on the explicit button. */
function ReviewPanel({
  kind,
  held,
  blocked,
  inFlight,
  replacementOptions,
  working,
  onCancel,
  onRequest,
}: {
  kind: GoalAttestationCorrectionKind;
  /** The request an unknown outcome left unsettled. Its fields are shown as sent and locked: only the same body can be sent. */
  held: CorrectionRequestBody | null;
  /** True while a pending request cannot be read. No request can be sent then. */
  blocked: boolean;
  /** True while a request at this chain position is unresolved in this page or elsewhere. No request can be sent then. */
  inFlight: boolean;
  replacementOptions: CorrectionReplacementOption[];
  working: boolean;
  onCancel: () => void;
  onRequest: (draft: CorrectionDraft) => void;
}) {
  const action = CORRECTION_ACTIONS[kind];
  const reasonId = useId();
  const explanationId = useId();
  const replacementId = useId();
  const [reason, setReason] = useState<GoalAttestationCorrectionReasonCode | ''>(held?.reasonCode ?? '');
  const [explanation, setExplanation] = useState(held?.explanation ?? '');
  const [replacement, setReplacement] = useState(held?.replacementAttestationId ?? '');
  const needsReplacement = kind === 'supersede';
  const ready = reason !== '' && (!needsReplacement || replacement !== '');
  const locked = held !== null;

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
      headingLevel={5}
      onCancel={onCancel}
    >
      <p className="goal-row-meta">{CORRECTION_COPY.requestOnly}</p>
      <div className="goal-completion-action">
        <label htmlFor={reasonId}>{CORRECTION_COPY.reasonLabel}</label>
        <select
          id={reasonId}
          value={reason}
          disabled={working || locked}
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
              disabled={working || locked}
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
          disabled={working || locked}
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
          disabled={working || inFlight || !ready || (locked && blocked)}
          aria-busy={working}
          onClick={submit}
        >
          {locked ? CORRECTION_RECOVERY_COPY.requestAgain : action.request}
        </button>
      </div>
    </ConfirmPanel>
  );
}

/** The pending request this session holds. Confirm records it; Decline discards it. Nothing changes until one of them. */
function GatePanel({
  gate,
  working,
  inFlight,
  onExplanation,
  onConfirm,
  onDecline,
}: {
  gate: CorrectionGate;
  working: boolean;
  /** True while this pending request's decision is unresolved in this page or elsewhere. Neither decision can be sent then. */
  inFlight: boolean;
  onExplanation: (value: string) => void;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const explanationId = useId();
  const confirmBlocked =
    working ||
    inFlight ||
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
        <button type="button" className="secondary-button" disabled={working || inFlight} onClick={onDecline}>
          {CORRECTION_COPY.declineLabel}
        </button>
      </div>
    </div>
  );
}
