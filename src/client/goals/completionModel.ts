import type {
  GoalCompletionStandingClaim,
  GoalExternalCompletionPreflightReport,
  GoalExternalCompletionStatus,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import { toRefusal } from './refusal';

/**
 * Pure completion model for the desktop Goal cockpit: copy, the refusal map, the standing presentation and the state
 * reducer. Nothing here performs a request. The reducer returns effects as data, and the component runs them. The only
 * effect that can ever ask for a Goal completion is `complete`, and only `complete_requested` produces it.
 *
 * Copy rules: no raw field names, enum values or error codes are ever returned as text. Nothing says success, done or
 * verified about a completion whose claim is not unqualified success.
 */

// --- Copy -------------------------------------------------------------------------------------------------------------

const CONTENT_NOT_PROVEN = 'Content preservation: not proven.';

export const COMPLETION_COPY = {
  panelTitle: 'Completion review',
  intro:
    'Reviewing completion checks the saved attestation against current Git history. Reviewing does not complete the Goal.',
  limitation: `${CONTENT_NOT_PROVEN} Turing observed Git history at the time shown; it did not check that your changes are in the destination files.`,
  limitationPointInTime: 'Point-in-time history check, not a lasting guarantee.',
  loading: 'Checking the completion review. This is read-only.',
  statusUnavailable: 'The saved completion state could not be read.',
  reviewUnreadable:
    'The completion review could not be read. Nothing was recorded or changed by this check. Check again.',
  noBlockers: 'No blockers in this review.',
  recordLabel: 'Record completion decision',
  recordAcknowledgement:
    'I understand that Turing checked Git history only and has not proven that the content of my changes is in the destination.',
  recordHelp:
    'Recording your decision completes nothing. It saves your decision for this exact review; the Goal changes only when you press Complete Goal.',
  completeLabel: 'Complete Goal',
  completeAcknowledgement:
    'I understand that Turing checked Git history only and has not proven that the content of my changes is in the destination.',
  completeHelp: 'Completing the Goal uses the decision recorded above. Nothing else is changed.',
  reviewChanged: 'The review changed; read it again before recording a decision.',
  refreshReview: 'Refresh review',
  checkAgain: 'Check again',
  recordedNotCompleted: 'A completion decision is recorded. The Goal is not completed yet.',
  recording: 'Recording your decision…',
  completing: 'Completing the Goal…',
  inFlightElsewhere: 'A write for this review is still in progress. Reading the saved state…',
  inFlightBusy:
    'Other completion writes are still in progress in this window. Wait for them to finish, then refresh the review.',
  reviewAvailable: 'The review is ready. Recording a decision completes nothing.',
  blockedByEligibleDecision:
    'A completion decision for a different attestation of this Goal can still complete it, so no decision can be recorded here. Open that attestation to complete the Goal, or correct it (dispute, withdraw or supersede it) to set it aside.',
  ownDecisionSetAside:
    'The decision recorded for this attestation was corrected, so it no longer counts toward completion. It stays in the history as a record and does not complete the Goal.',
  othersSetAside:
    'A decision for a different attestation was corrected, so it no longer counts toward completion. It stays in the history as a record and does not complete the Goal.',
  competingDecisions:
    'More than one current decision could complete this Goal, so Turing will not complete it from any of them. Correct the attestations that are not needed until one decision remains.',
  selectAttestation:
    'Choose an attestation from this history to review its completion. Nothing is loaded until you choose one.',
  otherAttestationsTruncated:
    'Only the first 20 other attestations are listed. Others may exist and were not checked here.',
} as const;

/** Recovery copy for an ambiguous write. Each line is shown only after a read that supports it. */
export const COMPLETION_RECOVERY_COPY = {
  reconciling: 'Turing could not confirm the result. Checking the saved state…',
  recordSaved: 'Your decision was saved.',
  completeSaved: 'The Goal was completed. This is the saved result.',
  settledNeutral: 'The saved completion state is shown below.',
  recordAbsent:
    'Nothing was saved when Turing last checked. If the earlier request is still running it may still finish, so check again before trying again.',
  recordAbsentChanged:
    'Nothing was saved. The review has changed since your earlier request, so review the new summary before recording a decision.',
  completeAbsent:
    'The Goal was not completed when Turing last checked. If the earlier request is still running it may still finish, so check again before trying again.',
  completeStillRecorded:
    'The Goal was not completed when Turing last checked, and the decision is still recorded. If the earlier request is still running it may still finish, so check again before pressing Complete Goal again.',
  unavailable:
    'Turing still cannot read the saved state, so it cannot confirm the result. Check again before doing anything else.',
} as const;

export const UNCONFIRMED_RESULT =
  'Turing could not confirm the result. Do not assume it failed or succeeded. Refresh to read the saved state.';

const UNRECOGNISED_CONTENT_PRESERVATION = 'Content preservation: unrecognised value. Treat it as not proven.';

/** The content-preservation line for a claim or review. Anything other than the two known values is never invented. */
export function contentPreservationCopy(value: unknown): string {
  if (value === 'not_proven') return CONTENT_NOT_PROVEN;
  if (value === 'not_applicable') return 'Content preservation: not applicable.';
  return UNRECOGNISED_CONTENT_PRESERVATION;
}

const QUALIFIER_COPY: Record<GoalCompletionStandingClaim['qualifier'], string | null> = {
  none: null,
  disputed_by_user: 'A dispute was recorded against the attestation this completion relies on.',
  withdrawn_by_user: 'The attestation this completion relies on was withdrawn.',
  superseded_by_user: 'The attestation this completion relies on was replaced by another.',
  replacement_failed: 'The replacement attestation did not restore this completion.',
  proof_unverified: 'The stored completion proof could not be checked.',
  legacy_not_v2_attested: 'This completion was recorded before external attestation existed.',
  not_completed: 'No completion is recorded for this Goal.',
};

const UNKNOWN_QUALIFIER = 'This completion carries a qualification that Turing does not recognise.';

/** The qualification sentence for a standing claim, or null when the claim has no qualifier. */
export function qualifierCopy(qualifier: GoalCompletionStandingClaim['qualifier'] | string): string | null {
  if (!(qualifier in QUALIFIER_COPY)) return UNKNOWN_QUALIFIER;
  return QUALIFIER_COPY[qualifier as GoalCompletionStandingClaim['qualifier']];
}

/** A corrected attestation can no longer authorise completion. Names the ways forward; terminal Goals never reopen. */
const CORRECTED_ATTESTATION_COPY =
  'This attestation was corrected, so it cannot complete the Goal. Confirm the external integration for the current handoff again, after reconciling the repository if needed. You can also start a new Goal, or abandon this Goal (pause it first if it is running; abandon waits for any work in flight to finish). Completed and abandoned Goals do not reopen.';

/** Saved completion records failed verification. Refreshing can clear a transient failure; if it persists, name the ways forward. */
const HISTORY_INVALID_COPY =
  'The saved completion records could not be verified, so nothing was recorded. Refresh to check them again. If they still fail, this Goal cannot be completed from here: start a new Goal, or abandon this Goal (pause it first if it is running; abandon waits for any work in flight to finish).';

/** The `completion_already_recorded` blocker with detail `competing_decision`: another attestation's eligible decision. */
const COMPETING_DECISION_REASON =
  'A completion decision for a different attestation can already complete this Goal, so none can be recorded here. Open that attestation, or correct it, to continue.';

const PREFLIGHT_REASON_COPY: Record<string, string> = {
  attestation_id_invalid: 'The selected attestation is not valid. Choose another one.',
  goal_not_found: 'The Goal does not exist.',
  goal_not_running: 'The Goal is not running, so it cannot be completed now.',
  definition_not_approved: 'The Goal definition is not approved.',
  definition_not_v2: 'This Goal uses the earlier completion rule, so it cannot be completed here.',
  completion_already_recorded: 'A completion has already been recorded for this Goal. Refresh to see it.',
  attestation_not_found: 'The selected attestation no longer exists. Refresh to choose a current one.',
  attestation_invalid: 'The saved attestation failed integrity validation.',
  attestation_definition_mismatch: 'The attestation belongs to a different definition version.',
  handoff_invalid: 'The handoff record is invalid, so the review cannot continue.',
  correction_standing_unavailable: 'The correction history could not be read. Refresh the review.',
  correction_standing_invalid: 'The correction history failed a check. Refresh the review.',
  attestation_disputed: CORRECTED_ATTESTATION_COPY,
  attestation_withdrawn: CORRECTED_ATTESTATION_COPY,
  attestation_superseded: CORRECTED_ATTESTATION_COPY,
  completion_not_ready: 'The completion review is no longer ready. Refresh to review it again.',
  destination_advanced_after_observation:
    'The destination branch moved after the attestation. Refresh the review.',
  destination_not_integrated:
    'The attested commit is no longer in the destination history. Refresh the review.',
  attestation_stale: 'The attested handoff or authority is stale.',
  git_unavailable: 'Git could not be read. Try again.',
  preflight_unavailable: 'Git could not be read. Try again.',
  verification_busy: 'Turing is busy checking Git. Try again in a moment.',
  observation_changed: 'The Git observation changed. Refresh the review.',
  preflight_internal_invalid: 'The completion review failed an internal check. Refresh to review it again.',
  completion_history_invalid: HISTORY_INVALID_COPY,
};

const GENERIC_REASON = 'The completion review is no longer ready. Refresh to review it again.';

/**
 * A plain sentence for one preflight blocker. The detail only selects between known sentences for the same code; it is
 * never printed. Unknown blockers never print their code.
 */
export function preflightReasonCopy(code: string, detail?: string | null): string {
  if (code === 'completion_already_recorded' && detail === 'competing_decision')
    return COMPETING_DECISION_REASON;
  return Object.prototype.hasOwnProperty.call(PREFLIGHT_REASON_COPY, code)
    ? PREFLIGHT_REASON_COPY[code]!
    : GENERIC_REASON;
}

/**
 * How this attestation stands against the Goal's recorded decisions. Only a decision that is `eligible` counts; a row whose
 * eligibility is missing, or not exactly `eligible`, is treated as not eligible (fail closed), and an invalid row never counts.
 * - `decided_here`: exactly one eligible decision, for this attestation.
 * - `competing`: two eligible decisions for this attestation, or this attestation's and another's.
 * - `blocked_by_other`: an eligible decision for another attestation and none for this one.
 * - `own_set_aside`: this attestation's decision is valid but corrected, and no other decision is eligible.
 * - `others_set_aside`: only other attestations' decisions exist, and all of them are corrected.
 * - `none`: no valid decision exists.
 */
export type DecisionRelation =
  'none' | 'decided_here' | 'blocked_by_other' | 'own_set_aside' | 'others_set_aside' | 'competing';

export function decisionRelation(
  status: GoalExternalCompletionStatus,
  attestationId: string,
): DecisionRelation {
  const valid = status.decisions.filter((row) => row.valid);
  const own = (row: { attestationId: string | null }) => row.attestationId === attestationId;
  const ownEligible = valid.filter((row) => own(row) && row.eligibility === 'eligible').length;
  const otherEligible = valid.filter((row) => !own(row) && row.eligibility === 'eligible').length;
  if (ownEligible > 1 || (ownEligible === 1 && otherEligible > 0)) return 'competing';
  if (ownEligible === 1) return 'decided_here';
  if (otherEligible > 0) return 'blocked_by_other';
  if (valid.some(own)) return 'own_set_aside';
  if (valid.length > 0) return 'others_set_aside';
  return 'none';
}

// --- Standing presentation (what the Goal's completion state says) -----------------------------------------------------

export interface StandingPresentation {
  heading: string;
  /** The qualification sentence, or null when there is none to show. */
  qualifier: string | null;
  /** The content-preservation line shown beside a completed or contested state. Null when the state shows none. */
  contentPreservation: string | null;
}

/** Heading and lines for the Goal's completion state. Only a `completed` state carries the word "Completed" in its heading. */
export function standingPresentation(status: GoalExternalCompletionStatus): StandingPresentation {
  const claim = status.completionStanding.claim;
  switch (status.state) {
    case 'completed':
      return {
        heading: 'Completed on a recorded decision. Turing has not proven content preservation.',
        qualifier: qualifierCopy(claim.qualifier),
        contentPreservation: contentPreservationCopy(claim.contentPreservation),
      };
    case 'contested':
      return {
        heading: 'Completed earlier; later contested.',
        qualifier: qualifierCopy(claim.qualifier),
        contentPreservation: contentPreservationCopy(claim.contentPreservation),
      };
    case 'legacy':
      return {
        heading: 'Completed before external attestation existed. Not attested.',
        qualifier: qualifierCopy(claim.qualifier),
        contentPreservation: null,
      };
    case 'invalid':
      return {
        heading: 'Completion records could not be verified.',
        qualifier: null,
        contentPreservation: null,
      };
    case 'decided':
      return { heading: COMPLETION_COPY.recordedNotCompleted, qualifier: null, contentPreservation: null };
    case 'not_completed':
      return {
        heading: 'Not completed. No completion decision is recorded for this Goal.',
        qualifier: null,
        contentPreservation: null,
      };
  }
}

const CORRECTION_COPY: Record<string, string> = {
  active_uncontested: 'Uncontested',
  disputed: 'Disputed',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
  invalid: 'Invalid',
};

/** The plain name of an attestation's correction standing. An unknown value is never printed raw. */
export function correctionStandingCopy(value: string | null): string {
  if (value === null) return 'Not available';
  return Object.prototype.hasOwnProperty.call(CORRECTION_COPY, value)
    ? CORRECTION_COPY[value]!
    : 'Not recognised';
}

/**
 * The limitation line for the panel. Only the exact known value gets the full sentence; anything else is named as
 * unrecognised, never repaired into a success.
 */
export function limitationCopy(value: unknown): string {
  return value === 'not_proven' ? COMPLETION_COPY.limitation : contentPreservationCopy(value);
}

/** True when the Goal's own state is settled, so no completion control belongs in the panel any more. */
export function isSettledState(status: GoalExternalCompletionStatus): boolean {
  return (
    status.state === 'completed' ||
    status.state === 'contested' ||
    status.state === 'legacy' ||
    status.state === 'invalid'
  );
}

// --- Refusal map ------------------------------------------------------------------------------------------------------

/** What a refusal tells the component to offer. `refresh` is a GET only; `none` offers nothing extra. */
export interface CompletionRefusal {
  message: string;
  action: 'refresh' | 'none';
  /** True only for a busy answer the user may retry by pressing the same control again. */
  retryable: boolean;
}

const refuse = (
  message: string,
  action: CompletionRefusal['action'] = 'refresh',
  retryable = false,
): CompletionRefusal => ({
  message,
  action,
  retryable,
});

const CODE_REFUSALS: Record<string, CompletionRefusal> = {
  reviewed_action_precondition_required: refuse(
    'Turing did not send a reviewed digest, so nothing was recorded. Refresh and review again.',
  ),
  reviewed_action_precondition_invalid: refuse(
    'Turing did not send a reviewed digest, so nothing was recorded. Refresh and review again.',
  ),
  acknowledgement_required: refuse('Tick the acknowledgement first.', 'none'),
  reviewed_preflight_changed: refuse(
    'The destination or Goal changed since you reviewed it. Nothing was recorded. Review the refreshed summary.',
  ),
  destination_changed: refuse(
    'The destination branch moved since your review. Nothing was recorded. Review again.',
  ),
  completion_conflict: refuse(
    'A different completion decision already exists for this Goal. Refresh to see it.',
  ),
  decision_conflict: refuse(
    'A different completion decision already exists for this Goal. Refresh to see it.',
  ),
  goal_not_running: refuse('The Goal is not running, so it cannot be completed now.'),
  goal_work_in_flight: refuse('The Goal has work in flight, so it cannot be completed yet.'),
  manual_reconciliation_required: refuse(
    'This Goal needs manual reconciliation first. Nothing was recorded.',
  ),
  completion_already_recorded: refuse(
    'A completion has already been recorded for this Goal. Refresh to see it.',
  ),
  competing_decision: refuse(
    'A completion decision for a different attestation can already complete this Goal, so nothing was recorded. Open that attestation, or correct it, to continue.',
  ),
  decision_not_found: refuse('No recorded decision matches. Record the completion decision again.'),
  authority_changed_during_decision: refuse(
    'Goal authority changed during the request. Refresh to review again.',
  ),
  authority_changed_during_completion: refuse(
    'Goal authority changed during the request. Refresh to review again.',
  ),
  decision_input_invalid: refuse(
    'Turing could not read the request, so nothing was recorded. Refresh and review again.',
  ),
  completion_input_invalid: refuse(
    'Turing could not read the request, so nothing was recorded. Refresh and review again.',
  ),
  decision_corrupt: refuse('Stored completion records failed a check. Nothing was changed.', 'none'),
  completion_corrupt: refuse('Stored completion records failed a check. Nothing was changed.', 'none'),
  proof_invalid: refuse('Stored completion records failed a check. Nothing was changed.', 'none'),
  completion_proof_required: refuse('Stored completion records failed a check. Nothing was changed.', 'none'),
  proof_action_mismatch: refuse('Stored completion records failed a check. Nothing was changed.', 'none'),
  decision_action_mismatch: refuse('Stored completion records failed a check. Nothing was changed.', 'none'),
  completion_busy: refuse('Another completion request is in progress. Try again shortly.', 'none', true),
  goal_not_found: refuse('The Goal does not exist.', 'none'),
  external_completion_unavailable: refuse(UNCONFIRMED_RESULT),
  decision_persistence_failed: refuse(UNCONFIRMED_RESULT),
  completion_persistence_failed: refuse(UNCONFIRMED_RESULT),
  completion_read_failed: refuse(UNCONFIRMED_RESULT),
  completion_internal_state: refuse(UNCONFIRMED_RESULT),
};

const PREFLIGHT_DETAIL_REFUSALS: Record<string, CompletionRefusal> = {
  attestation_disputed: refuse(CORRECTED_ATTESTATION_COPY),
  attestation_withdrawn: refuse(CORRECTED_ATTESTATION_COPY),
  attestation_superseded: refuse(CORRECTED_ATTESTATION_COPY),
  verification_busy: refuse('Turing is busy checking Git. Try again in a moment.'),
  git_unavailable: refuse('Git could not be read. Try again.'),
  preflight_unavailable: refuse('Git could not be read. Try again.'),
  completion_history_invalid: refuse(HISTORY_INVALID_COPY),
};

/**
 * The plain message and next action for any failed completion request. The code, the detail and the server's own text are
 * matched only against known values and are never printed. Unknown answers get a generic sentence.
 */
export function completionRefusal(error: unknown): CompletionRefusal {
  const { code, detail } = toRefusal(error);
  const status = error instanceof ApiError ? error.status : null;
  if (code === 'preflight_refused' && typeof detail === 'string' && detail in PREFLIGHT_DETAIL_REFUSALS)
    return PREFLIGHT_DETAIL_REFUSALS[detail]!;
  if (code === 'preflight_refused')
    return refuse('The completion review is no longer ready. Refresh to review it again.');
  if (code && Object.prototype.hasOwnProperty.call(CODE_REFUSALS, code)) return CODE_REFUSALS[code]!;
  if (status === 429)
    return refuse('Another completion request is in progress. Try again shortly.', 'none', true);
  if (status === null || status >= 500) return refuse(UNCONFIRMED_RESULT);
  return refuse('The request was refused. Nothing was changed.');
}

/**
 * The refusal for a failed read of the completion review. A read never writes, so an unconfirmed read says only that
 * the review could not be read; every other read failure keeps its completionRefusal wording.
 */
export function completionReadRefusal(error: unknown): CompletionRefusal {
  const refusal = completionRefusal(error);
  return refusal.message === UNCONFIRMED_RESULT ? refuse(COMPLETION_COPY.reviewUnreadable, 'none') : refusal;
}

/**
 * True when a preflight read has the shape the review reads: a known outcome, a reasons list, and a digest when ready.
 * Anything else is a failed read, so the caller turns it into the read refusal and never into a silent refusal.
 */
export function isUsablePreflight(value: unknown): value is GoalExternalCompletionPreflightReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  if (!Array.isArray(report.reasons)) return false;
  if (!report.reasons.every((reason) => typeof reason === 'object' && reason !== null)) return false;
  if (report.outcome === 'ready') return typeof report.digest === 'string' && report.digest.length > 0;
  return report.outcome === 'refused';
}

// --- Reducer ----------------------------------------------------------------------------------------------------------

export type CompletionPhase =
  | 'idle'
  | 'loading'
  | 'preflight_ready'
  | 'preflight_refused'
  | 'recording'
  | 'decided'
  | 'completing'
  | 'completed'
  | 'refused'
  | 'reconciling';

/**
 * What an ambiguous write sent, held in memory for this mount only. It is set only by an unknown outcome and is never
 * used to send a new write: it lets the next read decide what the write did.
 */
export type CompletionUnknownWrite =
  { write: 'record'; digest: string } | { write: 'complete'; digest: string };

export interface CompletionState {
  phase: CompletionPhase;
  /** A read is in flight. Every control is disabled while this is true. */
  reading: boolean;
  /** Set while the saved state is being reconciled after an unknown outcome. Null otherwise. */
  unknown: CompletionUnknownWrite | null;
  /** A plain sentence about the outcome of a recovery read. Null when there is nothing to report. */
  notice: string | null;
  /** The digest of the reviewed preflight that the next decision POST may name. Dropped after any failure. */
  preflightDigest: string | null;
  /** The digest of the recorded decision that the completion POST may name. */
  actionDigest: string | null;
  /** Plain sentences for a refused preflight. */
  reasons: string[];
  acknowledgeRecord: boolean;
  acknowledgeComplete: boolean;
  refusal: CompletionRefusal | null;
  /** True when `refusal` came from a read, so the next successful read replaces it. */
  refusalFromLoad: boolean;
}

export type CompletionEvent =
  | { type: 'refresh' }
  | {
      type: 'loaded';
      settled: boolean;
      decidedActionDigest: string | null;
      preflight: GoalExternalCompletionPreflightReport | null;
      preflightError: CompletionRefusal | null;
      /** True only when the read shows the Goal completed (or completed earlier). Used to word a recovered completion. */
      completed?: boolean;
    }
  | { type: 'load_failed'; refusal: CompletionRefusal }
  | { type: 'check_again' }
  | { type: 'acknowledge_record'; checked: boolean }
  | { type: 'acknowledge_complete'; checked: boolean }
  | { type: 'record_requested' }
  | { type: 'record_succeeded'; actionDigest: string }
  /** `unknown` is true when the write may have happened (no response, 5xx, or an unusable success body). */
  | { type: 'record_failed'; refusal: CompletionRefusal; unknown?: boolean }
  | { type: 'complete_requested' }
  | { type: 'complete_succeeded' }
  | { type: 'complete_failed'; refusal: CompletionRefusal; unknown?: boolean };

/** Effects are data. Only `complete` may request a Goal completion, and only `complete_requested` can emit it. */
export type CompletionEffect =
  | { type: 'reload' }
  | { type: 'record'; preflightDigest: string }
  | { type: 'complete'; actionDigest: string };

export interface CompletionTransition {
  state: CompletionState;
  effects: CompletionEffect[];
}

/** A Goal's review starts loading when it has a current attestation, and is idle otherwise. */
export function initialCompletionState(current: boolean): CompletionState {
  return {
    phase: current ? 'loading' : 'idle',
    reading: current,
    unknown: null,
    notice: null,
    preflightDigest: null,
    actionDigest: null,
    reasons: [],
    acknowledgeRecord: false,
    acknowledgeComplete: false,
    refusal: null,
    refusalFromLoad: false,
  };
}

const unchanged = (state: CompletionState): CompletionTransition => ({ state, effects: [] });
const isInFlight = (phase: CompletionPhase) => phase === 'recording' || phase === 'completing';

function applyLoaded(
  state: CompletionState,
  event: Extract<CompletionEvent, { type: 'loaded' }>,
): CompletionState {
  const refusal = event.preflightError ?? (state.refusalFromLoad ? null : state.refusal);
  const refusalFromLoad = event.preflightError !== null || (state.refusalFromLoad && refusal !== null);
  const base = { ...state, reading: false, refusal, refusalFromLoad, notice: null };
  if (event.settled)
    return {
      ...base,
      phase: 'completed',
      preflightDigest: null,
      actionDigest: null,
      reasons: [],
      acknowledgeRecord: false,
      acknowledgeComplete: false,
    };
  if (event.decidedActionDigest !== null)
    return {
      ...base,
      phase: 'decided',
      preflightDigest: null,
      actionDigest: event.decidedActionDigest,
      reasons: [],
      acknowledgeRecord: false,
      acknowledgeComplete:
        state.actionDigest === event.decidedActionDigest ? state.acknowledgeComplete : false,
    };
  if (event.preflight?.outcome === 'ready')
    return {
      ...base,
      phase: 'preflight_ready',
      preflightDigest: event.preflight.digest,
      actionDigest: null,
      reasons: [],
      acknowledgeRecord: state.preflightDigest === event.preflight.digest ? state.acknowledgeRecord : false,
      acknowledgeComplete: false,
    };
  return {
    ...base,
    phase: 'preflight_refused',
    preflightDigest: null,
    actionDigest: null,
    reasons: event.preflight
      ? event.preflight.reasons.map((reason) => preflightReasonCopy(reason.code, reason.detail))
      : [],
    acknowledgeRecord: false,
    acknowledgeComplete: false,
  };
}

/**
 * The read that settles an ambiguous write. It is the same read as any other (applyLoaded decides the phase from the saved
 * facts); only the notice differs, and it names only what this read shows. A record needs a new acknowledgement after a
 * recovery read, so the decision POST always uses the digest of the review this read returned, never the held one.
 */
function settleUnknown(
  state: CompletionState,
  event: Extract<CompletionEvent, { type: 'loaded' }>,
): CompletionState {
  const marker = state.unknown;
  if (marker === null) return applyLoaded(state, event);
  const settled = applyLoaded({ ...state, unknown: null, refusal: null, refusalFromLoad: false }, event);
  const freshDigest = event.preflight?.outcome === 'ready' ? event.preflight.digest : null;
  let notice: string | null;
  if (settled.phase === 'decided')
    notice =
      marker.write === 'record'
        ? COMPLETION_RECOVERY_COPY.recordSaved
        : COMPLETION_RECOVERY_COPY.completeStillRecorded;
  else if (settled.phase === 'completed')
    notice =
      marker.write === 'complete'
        ? event.completed === true
          ? COMPLETION_RECOVERY_COPY.completeSaved
          : COMPLETION_RECOVERY_COPY.settledNeutral
        : null;
  else if (marker.write === 'complete') notice = COMPLETION_RECOVERY_COPY.completeAbsent;
  else
    notice =
      freshDigest !== null && freshDigest !== marker.digest
        ? COMPLETION_RECOVERY_COPY.recordAbsentChanged
        : COMPLETION_RECOVERY_COPY.recordAbsent;
  return { ...settled, notice };
}

/**
 * The completion state machine. Every transition is a user click or a read that the component started; no event emits a
 * completion effect except `complete_requested`. A refresh never emits a request effect of its own.
 */
export function reduceCompletion(state: CompletionState, event: CompletionEvent): CompletionTransition {
  switch (event.type) {
    case 'refresh':
      return { state: { ...state, reading: true }, effects: [] };

    case 'loaded':
      // A read that lands while a write is in flight is ignored; the write's own result re-reads the saved state.
      if (isInFlight(state.phase)) return { state: { ...state, reading: false }, effects: [] };
      return { state: settleUnknown(state, event), effects: [] };

    case 'load_failed':
      if (isInFlight(state.phase)) return { state: { ...state, reading: false }, effects: [] };
      // A failed recovery read keeps the held marker: the only next step is another read.
      if (state.phase === 'reconciling')
        return {
          state: {
            ...state,
            reading: false,
            refusal: refuse(COMPLETION_RECOVERY_COPY.unavailable),
            refusalFromLoad: true,
          },
          effects: [],
        };
      return {
        state: {
          ...state,
          phase: 'refused',
          reading: false,
          preflightDigest: null,
          actionDigest: null,
          reasons: [],
          acknowledgeRecord: false,
          acknowledgeComplete: false,
          refusal: event.refusal,
          refusalFromLoad: true,
        },
        effects: [],
      };

    case 'check_again':
      // The only action while reconciling is another read, and only after a read has failed.
      if (state.phase !== 'reconciling' || state.refusal === null || state.reading) return unchanged(state);
      return { state: { ...state, reading: true, refusal: null }, effects: [{ type: 'reload' }] };

    case 'acknowledge_record':
      if (state.phase !== 'preflight_ready') return unchanged(state);
      return { state: { ...state, acknowledgeRecord: event.checked }, effects: [] };

    case 'acknowledge_complete':
      if (state.phase !== 'decided') return unchanged(state);
      return { state: { ...state, acknowledgeComplete: event.checked }, effects: [] };

    case 'record_requested':
      if (
        state.phase !== 'preflight_ready' ||
        !state.acknowledgeRecord ||
        state.preflightDigest === null ||
        state.reading
      )
        return unchanged(state);
      return {
        state: { ...state, phase: 'recording', refusal: null, refusalFromLoad: false },
        effects: [{ type: 'record', preflightDigest: state.preflightDigest }],
      };

    case 'record_succeeded':
      if (state.phase !== 'recording') return unchanged(state);
      return {
        state: {
          ...state,
          phase: 'decided',
          reading: true,
          preflightDigest: null,
          actionDigest: event.actionDigest,
          reasons: [],
          acknowledgeRecord: false,
          acknowledgeComplete: false,
        },
        effects: [{ type: 'reload' }],
      };

    case 'record_failed':
      if (state.phase !== 'recording') return unchanged(state);
      if (event.unknown === true)
        return {
          state: {
            ...state,
            phase: 'reconciling',
            reading: true,
            unknown:
              state.preflightDigest === null ? null : { write: 'record', digest: state.preflightDigest },
            preflightDigest: null,
            actionDigest: null,
            reasons: [],
            acknowledgeRecord: false,
            acknowledgeComplete: false,
            refusal: null,
            refusalFromLoad: false,
            notice: COMPLETION_RECOVERY_COPY.reconciling,
          },
          effects: [{ type: 'reload' }],
        };
      // A busy answer is definite and wrote nothing, so the reviewed digest and the acknowledgement stay, as for Complete.
      if (event.refusal.retryable)
        return {
          state: { ...state, phase: 'preflight_ready', refusal: event.refusal, refusalFromLoad: false },
          effects: [],
        };
      return {
        state: {
          ...state,
          phase: 'refused',
          reading: true,
          preflightDigest: null,
          actionDigest: null,
          reasons: [],
          acknowledgeRecord: false,
          acknowledgeComplete: false,
          refusal: event.refusal,
          refusalFromLoad: false,
        },
        effects: [{ type: 'reload' }],
      };

    case 'complete_requested':
      if (
        state.phase !== 'decided' ||
        !state.acknowledgeComplete ||
        state.actionDigest === null ||
        state.reading
      )
        return unchanged(state);
      return {
        state: { ...state, phase: 'completing', refusal: null, refusalFromLoad: false },
        effects: [{ type: 'complete', actionDigest: state.actionDigest }],
      };

    case 'complete_succeeded':
      if (state.phase !== 'completing') return unchanged(state);
      return {
        state: {
          ...state,
          phase: 'completed',
          reading: true,
          actionDigest: null,
          acknowledgeComplete: false,
        },
        effects: [{ type: 'reload' }],
      };

    case 'complete_failed':
      if (state.phase !== 'completing') return unchanged(state);
      if (event.unknown === true)
        return {
          state: {
            ...state,
            phase: 'reconciling',
            reading: true,
            unknown: state.actionDigest === null ? null : { write: 'complete', digest: state.actionDigest },
            refusal: null,
            refusalFromLoad: false,
            notice: COMPLETION_RECOVERY_COPY.reconciling,
          },
          effects: [{ type: 'reload' }],
        };
      if (event.refusal.retryable)
        return {
          state: { ...state, phase: 'decided', refusal: event.refusal, refusalFromLoad: false },
          effects: [],
        };
      return {
        state: {
          ...state,
          phase: 'refused',
          reading: true,
          actionDigest: null,
          acknowledgeComplete: false,
          refusal: event.refusal,
          refusalFromLoad: false,
        },
        effects: [{ type: 'reload' }],
      };
  }
}
