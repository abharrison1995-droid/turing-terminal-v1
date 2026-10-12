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
  recordedNotCompleted: 'Your completion decision is recorded. The Goal is not completed yet.',
  recording: 'Recording your decision…',
  completing: 'Completing the Goal…',
  reviewAvailable: 'The review is ready. Recording a decision completes nothing.',
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
  disputed_by_user: 'You disputed the attestation this completion relies on.',
  withdrawn_by_user: 'You withdrew the attestation this completion relies on.',
  superseded_by_user: 'You replaced the attestation this completion relies on with another.',
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
  attestation_disputed: 'The attestation was corrected, so it cannot be used.',
  attestation_withdrawn: 'The attestation was corrected, so it cannot be used.',
  attestation_superseded: 'The attestation was corrected, so it cannot be used.',
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
};

const GENERIC_REASON = 'The completion review is no longer ready. Refresh to review it again.';

/** A plain sentence for one preflight blocker. Unknown blockers never print their code. */
export function preflightReasonCopy(code: string): string {
  return Object.prototype.hasOwnProperty.call(PREFLIGHT_REASON_COPY, code)
    ? PREFLIGHT_REASON_COPY[code]!
    : GENERIC_REASON;
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
        heading: 'Completed on your decision',
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
  disputed: 'Disputed by you',
  withdrawn: 'Withdrawn by you',
  superseded: 'Superseded by you',
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
  attestation_disputed: refuse('The attestation was corrected, so it cannot be used.'),
  attestation_withdrawn: refuse('The attestation was corrected, so it cannot be used.'),
  attestation_superseded: refuse('The attestation was corrected, so it cannot be used.'),
  verification_busy: refuse('Turing is busy checking Git. Try again in a moment.'),
  git_unavailable: refuse('Git could not be read. Try again.'),
  preflight_unavailable: refuse('Git could not be read. Try again.'),
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
  | 'refused';

export interface CompletionState {
  phase: CompletionPhase;
  /** A read is in flight. Every control is disabled while this is true. */
  reading: boolean;
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
    }
  | { type: 'load_failed'; refusal: CompletionRefusal }
  | { type: 'acknowledge_record'; checked: boolean }
  | { type: 'acknowledge_complete'; checked: boolean }
  | { type: 'record_requested' }
  | { type: 'record_succeeded'; actionDigest: string }
  | { type: 'record_failed'; refusal: CompletionRefusal }
  | { type: 'complete_requested' }
  | { type: 'complete_succeeded' }
  | { type: 'complete_failed'; refusal: CompletionRefusal };

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
  const base = { ...state, reading: false, refusal, refusalFromLoad };
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
    reasons: event.preflight ? event.preflight.reasons.map((reason) => preflightReasonCopy(reason.code)) : [],
    acknowledgeRecord: false,
    acknowledgeComplete: false,
  };
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
      return { state: applyLoaded(state, event), effects: [] };

    case 'load_failed':
      if (isInFlight(state.phase)) return { state: { ...state, reading: false }, effects: [] };
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
