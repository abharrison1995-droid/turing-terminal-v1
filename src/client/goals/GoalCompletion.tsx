import type { ReactNode } from 'react';
import type {
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi';
import { goalsApi } from './api';
import {
  COMPLETION_COPY,
  type CompletionRefusal,
  completionRefusal,
  correctionStandingCopy,
  isSettledState,
  limitationCopy,
  preflightReasonCopy,
  standingPresentation,
} from './completionModel';
import { formatTime } from './presentation';
import { useLoad } from './useLoad';

interface CompletionView {
  status: GoalExternalCompletionStatus;
  preflight: GoalExternalCompletionPreflightReport | null;
  preflightError: CompletionRefusal | null;
}

/**
 * Two reads, both GETs. The status comes first. The preflight is read only while this attestation can still take a
 * decision: not when a decision for it is already recorded, and not once the Goal is settled.
 */
export async function loadCompletionView(goalId: string, attestationId: string): Promise<CompletionView> {
  const status = await goalsApi.completionStatus(goalId);
  const decidedHere = status.decisions.some((row) => row.valid && row.attestationId === attestationId);
  if (decidedHere || isSettledState(status)) return { status, preflight: null, preflightError: null };
  try {
    return {
      status,
      preflight: await goalsApi.completionPreflight(goalId, attestationId),
      preflightError: null,
    };
  } catch (error) {
    return { status, preflight: null, preflightError: completionRefusal(error) };
  }
}

/**
 * The read-only completion review for one current attestation. It is mounted in the Handoff tab only, desktop only, and
 * never offers a write: the decision and completion controls are added separately.
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
  const view = useLoad(
    () => loadCompletionView(goalId, attestationId),
    `${goalId}:${attestationId}:completion`,
    refresh,
  );
  return (
    <section
      className="goal-completion"
      aria-label={COMPLETION_COPY.panelTitle}
      aria-busy={view.result.state === 'loading'}
    >
      <h4>{COMPLETION_COPY.panelTitle}</h4>
      <p>{COMPLETION_COPY.intro}</p>
      {view.result.state === 'loading' && <p role="status">{COMPLETION_COPY.loading}</p>}
      {view.result.state === 'error' && (
        <p className="form-error" role="alert">
          {COMPLETION_COPY.statusUnavailable}
        </p>
      )}
      {view.result.state === 'ready' && (
        <CompletionDetails attestationId={attestationId} view={view.result.data} />
      )}
    </section>
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
  const { status, preflight, preflightError } = view;
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
      {preflightError && (
        <p className="form-error" role="alert">
          {preflightError.message}
        </p>
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
