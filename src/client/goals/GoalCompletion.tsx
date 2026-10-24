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
  completionReadRefusal,
  completionRefusal,
  correctionStandingCopy,
  decisionRelation,
  type DecisionRelation,
  initialCompletionState,
  isSettledState,
  isUsablePreflight,
  limitationCopy,
  preflightReasonCopy,
  reduceCompletion,
  standingPresentation,
} from './completionModel';
import {
  beginInflight,
  type InflightWrite,
  isInflightAt,
  settleInflight,
  subscribeInflight,
} from './inflightWrites';
import { formatTime } from './presentation';
import { isUnknownOutcome } from './unknownOutcome';

interface CompletionView {
  status: GoalExternalCompletionStatus;
  preflight: GoalExternalCompletionPreflightReport | null;
  preflightError: CompletionRefusal | null;
  /** How this attestation stands against the Goal's recorded decisions. Only `decided_here` can complete the Goal. */
  relation: DecisionRelation;
}

/**
 * Two reads, both GETs. The status comes first. The preflight is read only while this attestation can still take a
 * decision: when no valid decision exists, or when the only ones are corrected elsewhere, and not once the Goal is
 * settled. In every other relation the preflight would refuse, or the decision already stands, so it is not read.
 */
export async function loadCompletionView(goalId: string, attestationId: string): Promise<CompletionView> {
  const status = await goalsApi.completionStatus(goalId);
  const relation = decisionRelation(status, attestationId);
  const canRecord = relation === 'none' || relation === 'others_set_aside';
  if (!canRecord || isSettledState(status))
    return { status, preflight: null, preflightError: null, relation };
  try {
    const preflight = await goalsApi.completionPreflight(goalId, attestationId);
    if (!isUsablePreflight(preflight)) throw new TypeError('The completion review body was not usable.');
    return { status, preflight, preflightError: null, relation };
  } catch (error) {
    return { status, preflight: null, preflightError: completionReadRefusal(error), relation };
  }
}

/**
 * The action digest of this attestation's eligible recorded decision, or null. Only `decided_here` yields one, so a
 * corrected, competing or blocked decision never offers the Complete control.
 */
function decidedActionDigest(status: GoalExternalCompletionStatus, attestationId: string): string | null {
  if (decisionRelation(status, attestationId) !== 'decided_here') return null;
  const row = status.decisions.find(
    (decision) =>
      decision.valid && decision.eligibility === 'eligible' && decision.attestationId === attestationId,
  );
  return row?.actionDigest ?? null;
}

/** The sentence that explains a relation to another or a corrected decision. Null when there is nothing to explain. */
function relationCopy(relation: DecisionRelation): string | null {
  switch (relation) {
    case 'blocked_by_other':
      return COMPLETION_COPY.blockedByEligibleDecision;
    case 'competing':
      return COMPLETION_COPY.competingDecisions;
    case 'own_set_aside':
      return COMPLETION_COPY.ownDecisionSetAside;
    case 'others_set_aside':
      return COMPLETION_COPY.othersSetAside;
    default:
      return null;
  }
}

/** The write refused by this page, not by the server: it was not sent, and the panel may ask again after a read. */
const INFLIGHT_BUSY_REFUSAL = {
  message: COMPLETION_COPY.inFlightBusy,
  action: 'refresh',
  retryable: true,
} as const;

/**
 * True when the write this review would send next, a decision or a completion, is unresolved in another panel. Only the
 * identity the read has just shown is compared, so a write for a different review never holds this one.
 */
function heldElsewhere(goalId: string, attestationId: string, owner: string, next: CompletionView): boolean {
  const recordDigest = next.preflight?.outcome === 'ready' ? next.preflight.digest : null;
  const actionDigest = decidedActionDigest(next.status, attestationId);
  const probe = (kind: InflightWrite['kind'], identity: string) => ({
    goalId,
    handoffId: null,
    attestationId,
    kind,
    identity,
  });
  return (
    (recordDigest !== null && isInflightAt(probe('record', recordDigest), owner)) ||
    (actionDigest !== null && isInflightAt(probe('complete', actionDigest), owner))
  );
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPhase = useRef(state.phase);
  const focusAfterWrite = useRef<'complete' | 'heading' | null>(null);
  // This panel's identity in the in-flight registry, stable for its life.
  const owner = useId();
  // Set while the write this review would send is unresolved in another panel ('elsewhere'), or after this page refused a
  // write for lack of room in the registry ('busy'). Either disables the write control until the next read clears it.
  const [held, setHeld] = useState<'elsewhere' | 'busy' | null>(null);

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
        const handle = beginInflight(
          {
            goalId,
            handoffId: null,
            attestationId,
            kind: 'record',
            identity: effect.preflightDigest,
            detail: null,
          },
          owner,
        );
        if (handle === 'busy') {
          // Not sent. The reducer keeps the reviewed digest and the acknowledgement, and the control stays disabled.
          setHeld('busy');
          run(apply({ type: 'record_failed', refusal: { ...INFLIGHT_BUSY_REFUSAL }, unknown: false }));
          continue;
        }
        try {
          goalsApi
            .recordCompletionDecision(goalId, {
              attestationId,
              preflightDigest: effect.preflightDigest,
              acknowledgeContentNotProven: true,
            })
            .then(
              (recorded) => {
                settleInflight(handle);
                run(apply({ type: 'record_succeeded', actionDigest: recorded.actionDigest }));
              },
              (error: unknown) => {
                settleInflight(handle);
                run(
                  apply({
                    type: 'record_failed',
                    refusal: completionRefusal(error),
                    unknown: isUnknownOutcome(error),
                  }),
                );
              },
            );
        } catch (error: unknown) {
          // The call threw before it returned a promise, so neither handler above was attached. This is the only settle.
          settleInflight(handle);
          run(
            apply({
              type: 'record_failed',
              refusal: completionRefusal(error),
              unknown: isUnknownOutcome(error),
            }),
          );
        }
      } else {
        const handle = beginInflight(
          {
            goalId,
            handoffId: null,
            attestationId,
            kind: 'complete',
            identity: effect.actionDigest,
            detail: null,
          },
          owner,
        );
        if (handle === 'busy') {
          setHeld('busy');
          run(apply({ type: 'complete_failed', refusal: { ...INFLIGHT_BUSY_REFUSAL }, unknown: false }));
          continue;
        }
        try {
          goalsApi.completeGoal(goalId, effect.actionDigest, true).then(
            () => {
              settleInflight(handle);
              run(apply({ type: 'complete_succeeded' }));
            },
            (error: unknown) => {
              settleInflight(handle);
              run(
                apply({
                  type: 'complete_failed',
                  refusal: completionRefusal(error),
                  unknown: isUnknownOutcome(error),
                }),
              );
            },
          );
        } catch (error: unknown) {
          // The call threw before it returned a promise, so neither handler above was attached. This is the only settle.
          settleInflight(handle);
          run(
            apply({
              type: 'complete_failed',
              refusal: completionRefusal(error),
              unknown: isUnknownOutcome(error),
            }),
          );
        }
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
        setHeld(heldElsewhere(goalId, attestationId, owner, next) ? 'elsewhere' : null);
        dispatch({
          type: 'loaded',
          settled: isSettledState(next.status),
          decidedActionDigest: decidedActionDigest(next.status, attestationId),
          preflight: next.preflight,
          preflightError: next.preflightError,
          completed:
            next.status.state === 'completed' ||
            next.status.state === 'content_mismatch' ||
            next.status.state === 'contested',
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
  }, [goalId, attestationId, refresh, reloadTick, owner]);

  // A write for this review that another panel began settles: read the saved state again. This panel's own writes are
  // not in this list, because its reducer already holds their result.
  useEffect(
    () => subscribeInflight(goalId, attestationId, owner, () => setReloadTick((tick) => tick + 1)),
    [goalId, attestationId, owner],
  );

  // A refusal from a click moves focus to the alert. A refusal from a read does not steal focus.
  useEffect(() => {
    if (state.refusal !== null && !state.refusalFromLoad) alertRef.current?.focus();
  }, [state.refusal, state.refusalFromLoad]);

  // Focus follows only the user's own finished write. A recorded decision arms the Complete checkbox, which is disabled
  // until the saved state is read back, and a finished Complete arms the panel heading. Reads arm nothing.
  useEffect(() => {
    const from = previousPhase.current;
    previousPhase.current = state.phase;
    focusAfterWrite.current =
      from === 'recording' && state.phase === 'decided'
        ? 'complete'
        : from === 'completing' && state.phase === 'completed'
          ? 'heading'
          : null;
  }, [state.phase]);

  // Runs once the armed control can take focus: the checkbox after its reading ends, the heading at once.
  useEffect(() => {
    const target = focusAfterWrite.current;
    if (target === 'complete' && state.phase === 'decided' && !state.reading) {
      focusAfterWrite.current = null;
      completeRef.current?.focus();
    } else if (target === 'heading' && state.phase === 'completed') {
      focusAfterWrite.current = null;
      headingRef.current?.focus();
    }
  }, [state.phase, state.reading]);

  const reload = () => setReloadTick((tick) => tick + 1);
  const { phase, reading } = state;
  const busy = phase === 'recording' || phase === 'completing';

  return (
    <section className="goal-completion" aria-label={COMPLETION_COPY.panelTitle} aria-busy={reading || busy}>
      <h4 ref={headingRef} tabIndex={-1}>
        {COMPLETION_COPY.panelTitle}
      </h4>
      <p>{COMPLETION_COPY.intro}</p>
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
      {/* One status region from the first render: it is never unmounted, so each change is announced in place. */}
      <div className="goal-completion-status" role="status" aria-live="polite" aria-atomic="true">
        {view === null && phase === 'loading' && <p>{COMPLETION_COPY.loading}</p>}
        {state.notice !== null && <p>{state.notice}</p>}
        {phase === 'recording' && <p>{COMPLETION_COPY.recording}</p>}
        {phase === 'completing' && <p>{COMPLETION_COPY.completing}</p>}
        {held === 'elsewhere' && <p>{COMPLETION_COPY.inFlightElsewhere}</p>}
      </div>
      {phase === 'preflight_refused' && (
        <button type="button" className="secondary-button" disabled={reading} onClick={reload}>
          {COMPLETION_COPY.checkAgain}
        </button>
      )}
      {(phase === 'preflight_ready' || phase === 'recording') && (
        <RecordControl
          acknowledged={state.acknowledgeRecord}
          disabled={reading || busy || held !== null}
          pending={phase === 'recording'}
          onAcknowledge={(checked) => dispatch({ type: 'acknowledge_record', checked })}
          onRecord={() => dispatch({ type: 'record_requested' })}
        />
      )}
      {(phase === 'decided' || phase === 'completing') && (
        <CompleteControl
          inputRef={completeRef}
          acknowledged={state.acknowledgeComplete}
          disabled={reading || busy || held !== null}
          pending={phase === 'completing'}
          onAcknowledge={(checked) => dispatch({ type: 'acknowledge_complete', checked })}
          onComplete={() => dispatch({ type: 'complete_requested' })}
        />
      )}
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
    <div className="goal-completion-action" role="group" aria-label="Decision recording">
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
    <div className="goal-completion-action" role="group" aria-label="Goal completion">
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
    preflight?.contentVerification?.status ??
    decision?.contentVerificationStatus ??
    preflight?.proofLimitations.contentPreservation ??
    status.completionStanding.claim.contentPreservation;
  const relationNote = isSettledState(status) ? null : relationCopy(view.relation);
  const stateId = useId();
  const qualifierId = useId();
  const preservationId = useId();
  // The heading names the standing, and the qualifier and the not-proven line describe it, so a screen reader gets the
  // whole standing from one group.
  const describedBy =
    [presentation.qualifier ? qualifierId : null, presentation.contentPreservation ? preservationId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <>
      <div
        className="goal-completion-standing"
        role="group"
        aria-labelledby={stateId}
        aria-describedby={describedBy}
      >
        <p id={stateId} className={`goal-completion-state goal-completion-${status.state}`}>
          {presentation.heading}
        </p>
        {presentation.qualifier && (
          <p id={qualifierId} className="goal-completion-qualifier">
            {presentation.qualifier}
          </p>
        )}
        {presentation.contentPreservation && (
          <p id={preservationId} className="goal-completion-preservation">
            {presentation.contentPreservation}
          </p>
        )}
      </div>
      <p className="goal-completion-limitation">{limitationCopy(limitationSource)}</p>
      <p className="goal-row-meta">{COMPLETION_COPY.limitationPointInTime}</p>
      {status.completionStanding.kind === 'v2' && status.completionStanding.otherAttestationsTruncated && (
        <p className="goal-row-meta">{COMPLETION_COPY.otherAttestationsTruncated}</p>
      )}
      {relationNote !== null && <p>{relationNote}</p>}
      {status.completion && (
        <dl className="goal-handoff-identities" aria-label="Recorded completion">
          <Identity label="Completion proof">{hash(status.completion.proofId)}</Identity>
          <Identity label="Proof digest">{hash(status.completion.proofDigest)}</Identity>
          <Identity label="Approval">{hash(status.completion.approvalId)}</Identity>
          <Identity label="Action digest">{hash(status.completion.actionDigest)}</Identity>
          {status.completion.contentVerificationDigest && (
            <Identity label="Content verification digest">
              {hash(status.completion.contentVerificationDigest)}
            </Identity>
          )}
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
          <li key={`${reason.code}:${index}`}>{preflightReasonCopy(reason.code, reason.detail)}</li>
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
        <Identity label="Content check">
          {preflight.contentVerification
            ? `${preflight.contentVerification.verifier} v${preflight.contentVerification.verifierVersion}`
            : 'Not available'}
        </Identity>
        <Identity label="Changed paths">
          {preflight.contentVerification?.changedPathCount ?? 'Not available'}
        </Identity>
        <Identity label="Comparison commit">{hash(preflight.contentVerification?.comparisonCommit)}</Identity>
        <Identity label="Content verification digest">
          {hash(preflight.contentVerification?.verificationDigest)}
        </Identity>
        <Identity label="Review digest">{hash(preflight.digest)}</Identity>
      </dl>
    </>
  );
}
