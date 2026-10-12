import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import type {
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi';
import { goalsApi } from './api';
import {
  COMPLETION_COPY,
  type CompletionEffect,
  type CompletionEvent,
  type CompletionRefusal,
  type CompletionState,
  completionRefusal,
  correctionStandingCopy,
  initialCompletionState,
  isSettledState,
  limitationCopy,
  preflightReasonCopy,
  reduceCompletion,
  standingPresentation,
} from './completionModel';
import { formatTime } from './presentation';
import { isUnknownOutcome } from './unknownOutcome';

interface CompletionView {
  status: GoalExternalCompletionStatus;
  preflight: GoalExternalCompletionPreflightReport | null;
  preflightError: CompletionRefusal | null;
  /** True when a valid decision exists for a different attestation, so this one cannot be recorded. */
  decidedElsewhere: boolean;
}

/**
 * Two reads, both GETs. The status comes first. The preflight is read only while this attestation can still take a
 * decision: not when a decision for it is already recorded, not when a decision for another attestation is, and not
 * once the Goal is settled. The preflight would refuse that case as "already recorded", which says nothing useful here.
 */
export async function loadCompletionView(goalId: string, attestationId: string): Promise<CompletionView> {
  const status = await goalsApi.completionStatus(goalId);
  const decidedHere = status.decisions.some((row) => row.valid && row.attestationId === attestationId);
  const decidedElsewhere = !decidedHere && status.decisions.some((row) => row.valid);
  if (decidedHere || decidedElsewhere || isSettledState(status))
    return { status, preflight: null, preflightError: null, decidedElsewhere };
  try {
    return {
      status,
      preflight: await goalsApi.completionPreflight(goalId, attestationId),
      preflightError: null,
      decidedElsewhere: false,
    };
  } catch (error) {
    return { status, preflight: null, preflightError: completionRefusal(error), decidedElsewhere: false };
  }
}

/** The action digest of this attestation's valid recorded decision, or null when there is none. */
function decidedActionDigest(status: GoalExternalCompletionStatus, attestationId: string): string | null {
  const row = status.decisions.find((decision) => decision.valid && decision.attestationId === attestationId);
  return row?.actionDigest ?? null;
}

/**
 * The completion review for one current attestation, desktop only, in the Handoff tab. Two writes exist and each is one
 * click: "Record completion decision" (completes nothing) and "Complete Goal" (only after a recorded decision). Every
 * transition is produced by the pure reducer in completionModel.ts; this component only runs the effects it returns.
 */
export function GoalCompletion({
  goalId,
  attestationId,
  refresh,
}: {
  goalId: string;
  attestationId: string;
  refresh: number | string;
}) {
  const [view, setView] = useState<CompletionView | null>(null);
  const [state, setState] = useState<CompletionState>(() => initialCompletionState(true));
  const [reloadTick, setReloadTick] = useState(0);
  const stateRef = useRef(state);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const completeRef = useRef<HTMLInputElement>(null);
  const previousPhase = useRef(state.phase);

  // Applies one event to the latest state and runs the effects it returns. Effects are data, so only a click can reach
  // the two POST calls below.
  const dispatch = (event: CompletionEvent) => run(apply(event));

  const apply = (event: CompletionEvent): CompletionEffect[] => {
    const transition = reduceCompletion(stateRef.current, event);
    stateRef.current = transition.state;
    setState(transition.state);
    return transition.effects;
  };

  const run = (effects: CompletionEffect[]) => {
    for (const effect of effects) {
      if (effect.type === 'reload') {
        setReloadTick((tick) => tick + 1);
      } else if (effect.type === 'record') {
        goalsApi
          .recordCompletionDecision(goalId, {
            attestationId,
            preflightDigest: effect.preflightDigest,
            acknowledgeContentNotProven: true,
          })
          .then(
            (recorded) => run(apply({ type: 'record_succeeded', actionDigest: recorded.actionDigest })),
            (error: unknown) =>
              run(
                apply({
                  type: 'record_failed',
                  refusal: completionRefusal(error),
                  unknown: isUnknownOutcome(error),
                }),
              ),
          );
      } else {
        goalsApi.completeGoal(goalId, effect.actionDigest, true).then(
          () => run(apply({ type: 'complete_succeeded' })),
          (error: unknown) =>
            run(
              apply({
                type: 'complete_failed',
                refusal: completionRefusal(error),
                unknown: isUnknownOutcome(error),
              }),
            ),
        );
      }
    }
  };

  // Reads. Keyed by the attestation (the parent remounts this component when the selection changes), by the parent's
  // refresh generation and by the reducer's reload. A superseded read is dropped by the `live` flag.
  useEffect(() => {
    let live = true;
    dispatch({ type: 'refresh' });
    loadCompletionView(goalId, attestationId).then(
      (next) => {
        if (!live) return;
        setView(next);
        dispatch({
          type: 'loaded',
          settled: isSettledState(next.status),
          decidedActionDigest: decidedActionDigest(next.status, attestationId),
          preflight: next.preflight,
          preflightError: next.preflightError,
          completed: next.status.state === 'completed' || next.status.state === 'contested',
        });
      },
      () => {
        if (!live) return;
        dispatch({
          type: 'load_failed',
          refusal: { message: COMPLETION_COPY.statusUnavailable, action: 'refresh', retryable: false },
        });
      },
    );
    return () => {
      live = false;
    };
  }, [goalId, attestationId, refresh, reloadTick]);

  // A refusal from a click moves focus to the alert. A refusal from a read does not steal focus.
  useEffect(() => {
    if (state.refusal !== null && !state.refusalFromLoad) alertRef.current?.focus();
  }, [state.refusal, state.refusalFromLoad]);

  // A recorded decision moves focus to its complete control, so keyboard users land on the next step.
  useEffect(() => {
    if (previousPhase.current === 'recording' && state.phase === 'decided') completeRef.current?.focus();
    previousPhase.current = state.phase;
  }, [state.phase]);

  const reload = () => setReloadTick((tick) => tick + 1);
  const { phase, reading } = state;
  const busy = phase === 'recording' || phase === 'completing';

  return (
    <section className="goal-completion" aria-label={COMPLETION_COPY.panelTitle} aria-busy={reading || busy}>
      <h4>{COMPLETION_COPY.panelTitle}</h4>
      <p>{COMPLETION_COPY.intro}</p>
      {view === null && phase === 'loading' && <p role="status">{COMPLETION_COPY.loading}</p>}
      {view !== null && <CompletionDetails attestationId={attestationId} view={view} />}
      {state.refusal !== null && (
        <div className="goal-completion-refusal">
          <p className="form-error" role="alert" tabIndex={-1} ref={alertRef}>
            {state.refusal.message}
          </p>
          {phase === 'reconciling' && (
            <button
              type="button"
              className="secondary-button"
              disabled={reading}
              onClick={() => dispatch({ type: 'check_again' })}
            >
              {COMPLETION_COPY.checkAgain}
            </button>
          )}
          {phase !== 'reconciling' && state.refusal.action === 'refresh' && (
            <button type="button" className="secondary-button" disabled={reading} onClick={reload}>
              {COMPLETION_COPY.refreshReview}
            </button>
          )}
        </div>
      )}
      {state.notice !== null && <p role="status">{state.notice}</p>}
      {phase === 'preflight_refused' && (
        <button type="button" className="secondary-button" disabled={reading} onClick={reload}>
          {COMPLETION_COPY.checkAgain}
        </button>
      )}
      {(phase === 'preflight_ready' || phase === 'recording') && (
        <RecordControl
          acknowledged={state.acknowledgeRecord}
          disabled={reading || busy}
          pending={phase === 'recording'}
          onAcknowledge={(checked) => dispatch({ type: 'acknowledge_record', checked })}
          onRecord={() => dispatch({ type: 'record_requested' })}
        />
      )}
      {phase === 'recording' && <p role="status">{COMPLETION_COPY.recording}</p>}
      {(phase === 'decided' || phase === 'completing') && (
        <CompleteControl
          inputRef={completeRef}
          acknowledged={state.acknowledgeComplete}
          disabled={reading || busy}
          pending={phase === 'completing'}
          onAcknowledge={(checked) => dispatch({ type: 'acknowledge_complete', checked })}
          onComplete={() => dispatch({ type: 'complete_requested' })}
        />
      )}
      {phase === 'completing' && <p role="status">{COMPLETION_COPY.completing}</p>}
    </section>
  );
}

function RecordControl({
  acknowledged,
  disabled,
  pending,
  onAcknowledge,
  onRecord,
}: {
  acknowledged: boolean;
  disabled: boolean;
  pending: boolean;
  onAcknowledge: (checked: boolean) => void;
  onRecord: () => void;
}) {
  const id = useId();
  return (
    <div className="goal-completion-action">
      <p className="goal-row-meta">{COMPLETION_COPY.recordHelp}</p>
      <label className="goal-completion-ack" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        <span>{COMPLETION_COPY.recordAcknowledgement}</span>
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || !acknowledged}
        aria-busy={pending}
        onClick={onRecord}
      >
        {COMPLETION_COPY.recordLabel}
      </button>
    </div>
  );
}

function CompleteControl({
  inputRef,
  acknowledged,
  disabled,
  pending,
  onAcknowledge,
  onComplete,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  acknowledged: boolean;
  disabled: boolean;
  pending: boolean;
  onAcknowledge: (checked: boolean) => void;
  onComplete: () => void;
}) {
  const id = useId();
  return (
    <div className="goal-completion-action">
      <p className="goal-row-meta">{COMPLETION_COPY.completeHelp}</p>
      <label className="goal-completion-ack" htmlFor={id}>
        <input
          id={id}
          ref={inputRef}
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        <span>{COMPLETION_COPY.completeAcknowledgement}</span>
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={disabled || !acknowledged}
        aria-busy={pending}
        onClick={onComplete}
      >
        {COMPLETION_COPY.completeLabel}
      </button>
    </div>
  );
}

function Identity({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="goal-handoff-identity">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const hash = (value: string | null | undefined) =>
  value ? <code>{value}</code> : <span className="goal-row-meta">Not available</span>;

function CompletionDetails({ attestationId, view }: { attestationId: string; view: CompletionView }) {
  const { status, preflight } = view;
  const presentation = standingPresentation(status);
  const decision = status.decisions.find((row) => row.valid && row.attestationId === attestationId) ?? null;
  const limitationSource =
    preflight?.proofLimitations.contentPreservation ?? status.completionStanding.claim.contentPreservation;
  return (
    <>
      <p className={`goal-completion-state goal-completion-${status.state}`}>{presentation.heading}</p>
      {presentation.qualifier && <p className="goal-completion-qualifier">{presentation.qualifier}</p>}
      {presentation.contentPreservation && (
        <p className="goal-completion-preservation">{presentation.contentPreservation}</p>
      )}
      <p className="goal-completion-limitation">{limitationCopy(limitationSource)}</p>
      <p className="goal-row-meta">{COMPLETION_COPY.limitationPointInTime}</p>
      {status.completionStanding.kind === 'v2' && status.completionStanding.otherAttestationsTruncated && (
        <p className="goal-row-meta">{COMPLETION_COPY.otherAttestationsTruncated}</p>
      )}
      {view.decidedElsewhere && !isSettledState(status) && <p>{COMPLETION_COPY.decidedElsewhere}</p>}
      {status.completion && (
        <dl className="goal-handoff-identities" aria-label="Recorded completion">
          <Identity label="Completion proof">{hash(status.completion.proofId)}</Identity>
          <Identity label="Proof digest">{hash(status.completion.proofDigest)}</Identity>
          <Identity label="Approval">{hash(status.completion.approvalId)}</Identity>
          <Identity label="Action digest">{hash(status.completion.actionDigest)}</Identity>
          <Identity label="Observed at">
            <time dateTime={status.completion.observedAt}>{formatTime(status.completion.observedAt)}</time>
          </Identity>
          <Identity label="Completed at">
            <time dateTime={status.completion.completedAt}>{formatTime(status.completion.completedAt)}</time>
          </Identity>
        </dl>
      )}
      {!preflight && decision && (
        <dl className="goal-handoff-identities" aria-label="Recorded decision">
          <Identity label="Decision action digest">{hash(decision.actionDigest)}</Identity>
        </dl>
      )}
      {preflight && <PreflightSummary preflight={preflight} />}
    </>
  );
}

function PreflightSummary({ preflight }: { preflight: GoalExternalCompletionPreflightReport }) {
  if (preflight.outcome === 'refused')
    return (
      <ul className="goal-plain-list" aria-label="Blockers">
        {preflight.reasons.map((reason, index) => (
          <li key={`${reason.code}:${index}`}>{preflightReasonCopy(reason.code)}</li>
        ))}
      </ul>
    );
  const facts = preflight.facts;
  return (
    <>
      <p>{COMPLETION_COPY.reviewAvailable}</p>
      <p className="goal-row-meta">{COMPLETION_COPY.noBlockers}</p>
      <dl className="goal-handoff-identities" aria-label="Completion review identities">
        <Identity label="Definition version">{facts.definitionVersion ?? 'Not available'}</Identity>
        <Identity label="Definition hash">{hash(facts.definitionHash)}</Identity>
        <Identity label="Handoff">{hash(facts.handoffId)}</Identity>
        <Identity label="Handoff digest">{hash(facts.handoffDigest)}</Identity>
        <Identity label="Attestation">{hash(preflight.attestationId)}</Identity>
        <Identity label="Attestation action digest">{hash(facts.attestationActionDigest)}</Identity>
        <Identity label="Attestation record digest">{hash(facts.attestationRecordDigest)}</Identity>
        <Identity label="Correction standing">{correctionStandingCopy(facts.correctionStanding)}</Identity>
        <Identity label="Destination branch">{hash(facts.destinationRef)}</Identity>
        <Identity label="Attested commit">{hash(facts.attestedCommit)}</Identity>
        <Identity label="Attested tree">{hash(facts.attestedTree)}</Identity>
        <Identity label="Current destination commit">{hash(facts.freshCommit)}</Identity>
        <Identity label="Current destination tree">{hash(facts.freshTree)}</Identity>
        <Identity label="Review digest">{hash(preflight.digest)}</Identity>
      </dl>
    </>
  );
}
