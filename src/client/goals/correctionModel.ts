import {
  GOAL_ATTESTATION_CORRECTION_REASON_CODES,
  type GoalAttestationCorrectionHistory,
  type GoalAttestationCorrectionKind,
  type GoalAttestationCorrectionPendingRequest,
  type GoalAttestationCorrectionReasonCode,
  type GoalAttestationCorrectionRequested,
} from '../../shared/goalApi';
import { ApiError } from '../api';
import { toRefusal } from './refusal';

/**
 * Pure model for the desktop correction controls (D.4D): copy, the refusal maps and a two-step reducer. Nothing here
 * performs a write. The reducer returns effects as data and the component runs them. A request is produced only by
 * `request`, and a decision only by `confirm` or `decline`, and each of those is one user click. A read (`loaded`) never
 * produces a write. A refusal never shows a raw code or a field name.
 */

// --- Copy -------------------------------------------------------------------------------------------------------------

const NOT_CHANGED = "The Goal's completion is not changed.";
const INDEPENDENT = 'Another independent attestation is not affected.';
const HISTORY = 'It stays in the permanent history.';
const COMPLETED_HISTORY = 'If the Goal is already completed, it will remain historically completed.';

export const DISPUTE_CONSEQUENCE = `Disputing records that you question this attestation. ${NOT_CHANGED} This attestation's standing becomes Disputed and it can no longer support a completion. ${HISTORY} ${INDEPENDENT} ${COMPLETED_HISTORY}`;
export const WITHDRAW_CONSEQUENCE = `Withdrawing records that you withdraw the integration claim in this attestation. ${NOT_CHANGED} This attestation's standing becomes Withdrawn and it can no longer support a completion. ${HISTORY} ${INDEPENDENT} ${COMPLETED_HISTORY}`;
export const SUPERSEDE_CONSEQUENCE = `Replacing records that the attestation you choose supersedes this one. ${NOT_CHANGED} This attestation's standing becomes Superseded, and the attestation you choose is named as its replacement. Turing does not create a replacement for you. ${HISTORY} ${INDEPENDENT} ${COMPLETED_HISTORY}`;

export const UNCONFIRMED_CORRECTION =
  'Turing could not confirm the result. Do not assume it failed or succeeded. Refresh to read the saved state.';

export const CORRECTION_COPY = {
  panelTitle: 'Correction',
  intro: 'A correction records your judgement about this attestation. It never changes the saved record.',
  requestOnly:
    'This sends a request for your confirmation. Nothing changes until you confirm on the next step.',
  loading: 'Reading the correction history. This is read-only.',
  historyUnavailable: 'The correction history could not be read.',
  readOnlyMobile: 'Correction standing',
  cancel: 'Cancel',
  requesting: 'Sending the request…',
  deciding: 'Recording your decision…',
  verifying: 'Checking the saved history…',
  confirmLabel: 'Confirm correction',
  declineLabel: 'Decline this request',
  gateHeading: 'A correction is waiting for your decision',
  gateHelp:
    'Nothing has changed yet. Confirm to record the correction, or decline to discard this request. Declining does not change the attestation.',
  gateOutOfDate:
    'This request is out of date and cannot be confirmed. Decline it, then request a new correction if you still need one.',
  explanationAgain:
    'Turing does not keep the explanation you entered. Enter the same explanation exactly to confirm this correction.',
  replacementLabel: 'Attestation that replaces this one',
  replacementNone: 'No other attestation is available for this handoff.',
  reasonLabel: 'Reason',
  explanationLabel: 'Explanation (optional, up to 1,000 characters)',
  explanationCounter: (length: number) => `${length} of 1,000 characters`,
  requestHelp: 'Requesting a correction records nothing yet. You confirm it on the next step.',
  recordedNote: 'The correction is recorded in the history.',
  declinedNote: 'The request was declined. Nothing was changed.',
} as const;

/** Recovery copy for an ambiguous request or decision. Each line is shown only after a read that supports it. */
export const CORRECTION_RECOVERY_COPY = {
  reconciling: 'Turing could not confirm the result. Checking the saved history…',
  requestSaved: 'Your correction request was saved. It is waiting for your decision.',
  stillPending: 'Not recorded yet. The request is still waiting for your decision.',
  closed: 'This request is closed. No correction was recorded.',
  absent:
    'Nothing was saved when Turing last checked. If the earlier request is still running it may still finish, so check again before trying again.',
  unreadablePending:
    'A saved correction request could not be read, so Turing cannot confirm whether yours was saved. Do not send it again.',
  requestAgain: 'Request again',
  checkAgain: 'Check again',
  historyChanged:
    'The correction history changed. Review the attestation again before requesting a correction.',
  unavailable:
    'Turing still cannot read the saved history, so it cannot confirm the result. Check again before doing anything else.',
} as const;

export const CORRECTION_ACTIONS: Record<
  GoalAttestationCorrectionKind,
  { button: string; title: string; consequence: string; request: string }
> = {
  dispute: {
    button: 'Dispute this attestation',
    title: 'Dispute this attestation?',
    consequence: DISPUTE_CONSEQUENCE,
    request: 'Request dispute',
  },
  withdraw: {
    button: 'Withdraw this attestation',
    title: 'Withdraw this attestation?',
    consequence: WITHDRAW_CONSEQUENCE,
    request: 'Request withdrawal',
  },
  supersede: {
    button: 'Replace with another attestation',
    title: 'Replace this attestation?',
    consequence: SUPERSEDE_CONSEQUENCE,
    request: 'Request replacement',
  },
};

export const CORRECTION_KIND_LABEL: Record<GoalAttestationCorrectionKind, string> = {
  dispute: 'Dispute',
  withdraw: 'Withdrawal',
  supersede: 'Replacement',
};

/** Plain labels for the seven reason codes. The code itself is never shown. */
export const CORRECTION_REASON_LABEL: Record<GoalAttestationCorrectionReasonCode, string> = {
  integration_not_performed: 'The integration was not performed',
  wrong_source: 'The source was wrong',
  wrong_destination: 'The destination was wrong',
  content_not_preserved: 'The content was not preserved',
  observation_error: 'The observation was wrong',
  superseded_by_new_observation: 'A newer observation replaces it',
  other: 'Something else',
};

export const REASON_CODES: readonly GoalAttestationCorrectionReasonCode[] =
  GOAL_ATTESTATION_CORRECTION_REASON_CODES;

const STANDING_COPY: Record<GoalAttestationCorrectionHistory['standing']['standing'], string> = {
  active_uncontested: 'Uncontested',
  disputed: 'Disputed',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
  invalid: 'Unavailable: the saved record failed a check',
};

/** The plain name of an attestation's correction standing. An unknown value is never printed raw. */
export function correctionStandingLabel(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'Not available';
  return Object.prototype.hasOwnProperty.call(STANDING_COPY, value)
    ? STANDING_COPY[value as keyof typeof STANDING_COPY]
    : 'Not recognised';
}

/**
 * The kinds the current standing allows, following the chain rules the server enforces (transitionAllowed). The list is
 * only offered; the server remains the authority and refuses anything else.
 */
export function allowedCorrectionKinds(
  standing: GoalAttestationCorrectionHistory['standing'] | null,
): GoalAttestationCorrectionKind[] {
  if (
    !standing ||
    standing.standing === 'invalid' ||
    standing.standing === 'withdrawn' ||
    standing.standing === 'superseded'
  )
    return [];
  const tip = standing.tip?.kind ?? null;
  if (tip === null) return ['dispute', 'withdraw', 'supersede'];
  if (tip === 'dispute') return ['withdraw', 'supersede'];
  return [];
}

// --- Refusal map ------------------------------------------------------------------------------------------------------

/**
 * What the state becomes after a refusal. `keep` leaves the form or the gate on screen with the message. `reload` reads the
 * history again and drops any open form. `out_of_date` keeps a pending gate on screen with only Decline available.
 */
export interface CorrectionRefusal {
  message: string;
  next: 'keep' | 'reload' | 'out_of_date';
}

const refuse = (message: string, next: CorrectionRefusal['next'] = 'keep'): CorrectionRefusal => ({
  message,
  next,
});

const GENERIC_REFUSAL = 'The request was refused. Nothing was changed.';

/** Request route codes (goalRoutes.ts ATTESTATION_CORRECTION_STATUS, the body schema and the precondition checks). */
const REQUEST_REFUSALS: Record<string, CorrectionRefusal> = {
  invalid_request: refuse('Check the correction details and try again.'),
  reviewed_action_precondition_required: refuse(
    'Refresh the review before requesting a correction.',
    'reload',
  ),
  reviewed_action_precondition_invalid: refuse(
    'Refresh the review before requesting a correction.',
    'reload',
  ),
  goal_not_found: refuse('This attestation is no longer available.', 'reload'),
  attestation_not_found: refuse('This attestation is no longer available.', 'reload'),
  attestation_invalid: refuse('The saved record failed a check. Corrections are unavailable.'),
  correction_chain_invalid: refuse('The saved record failed a check. Corrections are unavailable.'),
  replacement_invalid: refuse('That attestation cannot replace this one.'),
  explanation_invalid: refuse('The explanation is too long or has unsupported characters.'),
  correction_chain_changed: refuse('The history changed since you reviewed it. It was reloaded.', 'reload'),
  correction_transition_not_allowed: refuse(
    'That correction is not available from the current standing.',
    'reload',
  ),
  goal_terminal: refuse('The Goal has finished, so no correction can be requested.'),
  correction_request_pending: refuse('A correction is already waiting for your decision.', 'reload'),
  correction_request_already_decided: refuse('This exact correction was already decided.', 'reload'),
  attestation_correction_unavailable: refuse('The request could not be recorded safely.', 'reload'),
  persistence_failed: refuse('The request could not be recorded safely.', 'reload'),
};

/** Decision route codes (the D.4C route in goalRoutes.ts ATTESTATION_CORRECTION_STATUS and the approval service). */
const DECISION_REFUSALS: Record<string, CorrectionRefusal> = {
  goal_not_found: refuse('This attestation is no longer available.', 'reload'),
  attestation_not_found: refuse('This attestation is no longer available.', 'reload'),
  attestation_invalid: refuse('The saved record failed a check. Corrections are unavailable.', 'reload'),
  correction_chain_invalid: refuse('The saved record failed a check. Corrections are unavailable.', 'reload'),
  correction_chain_changed: refuse(
    'The history changed after you requested this correction, so it can no longer be confirmed.',
    'out_of_date',
  ),
  correction_action_mismatch: refuse(
    'This correction no longer matches what you requested, so it cannot be confirmed.',
    'out_of_date',
  ),
  approval_mismatch: refuse('This request no longer matches the saved record.', 'out_of_date'),
  approval_required: refuse('This request no longer matches the saved record.', 'out_of_date'),
  explanation_invalid: refuse('The explanation does not match the one you requested with. Enter it exactly.'),
  approval_not_found: refuse('This request no longer exists. Refresh to see the current state.', 'reload'),
  already_decided: refuse('This request was already decided. Refresh to see the result.', 'reload'),
  idempotency_conflict: refuse(
    'A different correction already uses this decision. Refresh to see it.',
    'reload',
  ),
  goal_terminal: refuse('The Goal has finished, so this request can no longer be decided.', 'reload'),
  attestation_correction_unavailable: refuse(UNCONFIRMED_CORRECTION, 'reload'),
  persistence_failed: refuse(UNCONFIRMED_CORRECTION, 'reload'),
};

/**
 * The plain message and next step for a failed correction request or decision. The server's code and text are matched only
 * against the known values above and are never printed. No status, or a 5xx, means the outcome is unknown.
 */
export function correctionRefusal(error: unknown, operation: 'request' | 'decide'): CorrectionRefusal {
  const { code } = toRefusal(error);
  const status = error instanceof ApiError ? error.status : null;
  const table = operation === 'request' ? REQUEST_REFUSALS : DECISION_REFUSALS;
  if (code && Object.prototype.hasOwnProperty.call(table, code)) {
    const hit = table[code];
    if (hit) return hit;
  }
  if (status === null || status >= 500) return refuse(UNCONFIRMED_CORRECTION, 'reload');
  return refuse(GENERIC_REFUSAL);
}

/** Copy for a pending request from a read: the kind and the reason in plain words. */
export function pendingRequestSummary(pending: GoalAttestationCorrectionPendingRequest): string {
  return `${CORRECTION_KIND_LABEL[pending.correctionKind]} requested. Reason: ${CORRECTION_REASON_LABEL[pending.reasonCode]}.`;
}

// --- Reducer ----------------------------------------------------------------------------------------------------------

export type CorrectionPhase =
  'idle' | 'reviewing' | 'requesting' | 'gate_pending' | 'deciding' | 'verifying' | 'reconciling';

/**
 * What an ambiguous write sent, held in memory for this mount only. It never sends a write by itself: a request may be
 * resent only with the same body and chain position, and a decision only with the same approval and digest.
 */
export type CorrectionUnknownWrite =
  | { write: 'request'; chainPosition: string; body: CorrectionRequestBody }
  | {
      write: 'decide';
      approvalId: string;
      actionDigest: string;
      decision: 'approved' | 'denied';
      attestationId: string;
      correctionKind: GoalAttestationCorrectionKind;
      explanation: string | null;
    };

/** What the user has typed for one correction. An empty explanation means none. */
export interface CorrectionDraft {
  kind: GoalAttestationCorrectionKind;
  reasonCode: GoalAttestationCorrectionReasonCode;
  explanation: string;
  replacementAttestationId: string | null;
}

/** The request body, exactly the allowed keys. */
export interface CorrectionRequestBody {
  correctionKind: GoalAttestationCorrectionKind;
  reasonCode: GoalAttestationCorrectionReasonCode;
  explanation: string | null;
  replacementAttestationId: string | null;
}

/** A pending request held on screen. The explanation text is in memory only; it is never read back from the server. */
export interface CorrectionGate {
  approvalId: string;
  actionDigest: string;
  correctionKind: GoalAttestationCorrectionKind;
  reasonCode: GoalAttestationCorrectionReasonCode;
  /** True when the reviewed action carries an explanation, so the decision must send exactly that text. */
  explanationRequired: boolean;
  /** The explanation text, or null when none is held. */
  explanation: string | null;
  /** Set when a decision was refused as out of date: only Decline is offered. */
  outOfDate: boolean;
}

export interface CorrectionState {
  attestationId: string;
  phase: CorrectionPhase;
  /** The kinds the current standing allows, from the last successful read. Empty until a read succeeds. */
  allowed: GoalAttestationCorrectionKind[];
  /** The kind under review. Set only in `reviewing`. */
  kind: GoalAttestationCorrectionKind | null;
  /** The chain position from the last read. A request is possible only when this is known. */
  position: string | null;
  /** The explanation of the request in flight, moved into the gate when the request succeeds. */
  heldExplanation: string | null;
  gate: CorrectionGate | null;
  /** The decision in flight. Set only in `deciding`. */
  decision: 'approved' | 'denied' | null;
  /** The decision to verify against the next read. Set only in `verifying`. */
  verify: { approvalId: string; decision: 'approved' | 'denied' } | null;
  /** The request in flight, kept so an unknown outcome can be reconciled. Set only in `requesting`. */
  sent: { chainPosition: string; body: CorrectionRequestBody } | null;
  /** Set only by an unknown outcome, until a read settles it or the user cancels. */
  unknown: CorrectionUnknownWrite | null;
  notice: string | null;
  refusal: CorrectionRefusal | null;
}

export type CorrectionEvent =
  | { type: 'loaded'; history: GoalAttestationCorrectionHistory }
  | { type: 'load_failed' }
  | { type: 'check_again' }
  | { type: 'review'; kind: GoalAttestationCorrectionKind }
  | { type: 'cancel' }
  | { type: 'request'; draft: CorrectionDraft }
  | { type: 'requested'; response: GoalAttestationCorrectionRequested }
  /** `unknown` is true when the request may have been saved (no response, 5xx, or an unusable success body). */
  | { type: 'request_failed'; refusal: CorrectionRefusal; unknown?: boolean }
  | { type: 'explanation'; value: string }
  | { type: 'confirm' }
  | { type: 'decline' }
  | { type: 'decided' }
  | { type: 'decide_failed'; refusal: CorrectionRefusal; unknown?: boolean };

/** Effects are data. Only `request` and `decide` can write, and each is produced only by its own click event. */
export type CorrectionEffect =
  | { type: 'reload' }
  | { type: 'request'; chainPosition: string; body: CorrectionRequestBody }
  | {
      type: 'decide';
      approvalId: string;
      actionDigest: string;
      decision: 'approved' | 'denied';
      attestationId: string;
      correctionKind: GoalAttestationCorrectionKind;
      explanation: string | null;
    };

export interface CorrectionTransition {
  state: CorrectionState;
  effects: CorrectionEffect[];
}

export function initialCorrectionState(attestationId: string): CorrectionState {
  return {
    attestationId,
    phase: 'idle',
    allowed: [],
    kind: null,
    position: null,
    heldExplanation: null,
    gate: null,
    decision: null,
    verify: null,
    sent: null,
    unknown: null,
    notice: null,
    refusal: null,
  };
}

const MAX_EXPLANATION = 1_000;

const stay = (state: CorrectionState): CorrectionTransition => ({ state, effects: [] });

/** The body for a draft, or null when the draft is not sendable (too long, or a replacement is missing). */
export function requestBodyFor(draft: CorrectionDraft): CorrectionRequestBody | null {
  if (draft.explanation.length > MAX_EXPLANATION) return null;
  if (draft.kind === 'supersede' && draft.replacementAttestationId === null) return null;
  return {
    correctionKind: draft.kind,
    reasonCode: draft.reasonCode,
    explanation: draft.explanation.length > 0 ? draft.explanation : null,
    replacementAttestationId: draft.kind === 'supersede' ? draft.replacementAttestationId : null,
  };
}

/**
 * True when a history read has every field the panel and the reducer dereference. Anything else is a failed read, so the
 * caller reports the history as unavailable and never stores or renders it.
 */
export function isUsableCorrectionHistory(value: unknown): value is GoalAttestationCorrectionHistory {
  if (typeof value !== 'object' || value === null) return false;
  const history = value as Record<string, unknown>;
  const standing = history.standing as Record<string, unknown> | null | undefined;
  if (typeof standing !== 'object' || standing === null || typeof standing.standing !== 'string')
    return false;
  const tip = standing.tip;
  if (
    tip !== null &&
    (typeof tip !== 'object' || typeof (tip as Record<string, unknown>).sequence !== 'number')
  )
    return false;
  return (
    Array.isArray(history.corrections) &&
    history.corrections.every((row) => typeof row === 'object' && row !== null) &&
    Array.isArray(history.pending) &&
    history.pending.every((row) => typeof row === 'object' && row !== null) &&
    typeof history.chainPosition === 'string' &&
    typeof history.pendingUnreadableCount === 'number'
  );
}

/**
 * A pending request can be confirmed only if it extends the chain as the read shows it now: its sequence follows the tip
 * and its previous digest is the tip's digest. A request that does not fit was made against a chain that has moved.
 */
export function pendingFitsChain(
  pending: GoalAttestationCorrectionPendingRequest,
  history: GoalAttestationCorrectionHistory,
): boolean {
  const tip = history.standing.tip;
  return (
    pending.sequence === (tip?.sequence ?? 0) + 1 &&
    pending.previousCorrectionDigest === (tip?.correctionDigest ?? null)
  );
}

function gateFromPending(
  pending: GoalAttestationCorrectionPendingRequest,
  history: GoalAttestationCorrectionHistory,
): CorrectionGate {
  return {
    approvalId: pending.approvalId,
    actionDigest: pending.actionDigest,
    correctionKind: pending.correctionKind,
    reasonCode: pending.reasonCode,
    explanationRequired: pending.explanationRequired,
    explanation: null,
    outOfDate: !pendingFitsChain(pending, history),
  };
}

const sameRequestBody = (a: CorrectionRequestBody, b: CorrectionRequestBody) =>
  a.correctionKind === b.correctionKind &&
  a.reasonCode === b.reasonCode &&
  a.explanation === b.explanation &&
  a.replacementAttestationId === b.replacementAttestationId;

/**
 * The read that settles an ambiguous correction write. Each branch names only what the read shows: an approval that was
 * recorded or is still pending, a pending request matching the held body, an unreadable pending row (no absence can be
 * claimed), a moved chain, or absence with the chain where the request was sent from. The held explanation returns only
 * with a gate the read shows, and the server still checks its digest on confirm.
 */
function settleCorrection(
  state: CorrectionState,
  history: GoalAttestationCorrectionHistory,
): CorrectionState {
  const marker = state.unknown;
  if (marker === null) return state;
  const allowed = allowedCorrectionKinds(history.standing);
  const base: CorrectionState = {
    ...state,
    allowed,
    position: history.chainPosition,
    kind: null,
    gate: null,
    sent: null,
    unknown: null,
    notice: null,
    refusal: null,
  };

  if (marker.write === 'decide') {
    if (history.corrections.some((row) => row.approvalId === marker.approvalId))
      return { ...base, phase: 'idle', notice: CORRECTION_COPY.recordedNote };
    const pending = history.pending.find((row) => row.approvalId === marker.approvalId);
    if (pending)
      return {
        ...base,
        phase: 'gate_pending',
        gate: {
          ...gateFromPending(pending, history),
          explanation: pending.explanationRequired ? marker.explanation : null,
        },
        notice: CORRECTION_RECOVERY_COPY.stillPending,
      };
    return { ...base, phase: 'idle', notice: CORRECTION_RECOVERY_COPY.closed };
  }

  const held = marker.body;
  const match = history.pending.find(
    (row) =>
      row.correctionKind === held.correctionKind &&
      row.reasonCode === held.reasonCode &&
      row.replacementAttestationId === held.replacementAttestationId,
  );
  if (match)
    return {
      ...base,
      phase: 'gate_pending',
      gate: {
        ...gateFromPending(match, history),
        explanation: match.explanationRequired ? held.explanation : null,
      },
      // A request that no longer fits the chain is shown only as out of date, never as saved.
      notice: pendingFitsChain(match, history) ? CORRECTION_RECOVERY_COPY.requestSaved : null,
    };
  const other = history.pending[0];
  if (other) return { ...base, phase: 'gate_pending', gate: gateFromPending(other, history) };
  if (history.pendingUnreadableCount > 0)
    return {
      ...base,
      phase: 'reconciling',
      unknown: marker,
      refusal: refuse(CORRECTION_RECOVERY_COPY.unreadablePending),
    };
  if (history.chainPosition !== marker.chainPosition || !allowed.includes(held.correctionKind))
    return { ...base, phase: 'idle', notice: CORRECTION_RECOVERY_COPY.historyChanged };
  // Absence: nothing is pending and the chain is where the request was sent from. Request again resends the held body.
  return {
    ...base,
    phase: 'reviewing',
    kind: held.correctionKind,
    unknown: marker,
    notice: CORRECTION_RECOVERY_COPY.absent,
  };
}

/**
 * The state machine. `idle` never reaches `deciding`: a decision needs a gate, and a gate is reached only by a request
 * response or by a read that shows a pending request. `verifying` shows success only after a read shows the recorded
 * correction. No event other than `request`, `confirm` and `decline` produces a write, and a read never does.
 */
export function reduceCorrection(state: CorrectionState, event: CorrectionEvent): CorrectionTransition {
  switch (event.type) {
    case 'loaded': {
      if (state.phase === 'requesting' || state.phase === 'deciding') return stay(state);
      const { history } = event;
      if (state.unknown !== null) return stay(settleCorrection(state, history));
      const allowed = allowedCorrectionKinds(history.standing);
      const base: CorrectionState = { ...state, allowed, position: history.chainPosition };

      if (state.phase === 'verifying' && state.verify) {
        const { approvalId, decision } = state.verify;
        const recorded = history.corrections.some((row) => row.approvalId === approvalId);
        const stillPending = history.pending.some((row) => row.approvalId === approvalId);
        if (decision === 'approved')
          return stay({
            ...base,
            phase: 'idle',
            verify: null,
            notice: recorded ? CORRECTION_COPY.recordedNote : null,
            refusal: recorded ? null : refuse(UNCONFIRMED_CORRECTION, 'reload'),
          });
        return stay({
          ...base,
          phase: 'idle',
          verify: null,
          notice: !stillPending ? CORRECTION_COPY.declinedNote : null,
          refusal: stillPending ? refuse(UNCONFIRMED_CORRECTION, 'reload') : null,
        });
      }

      if (state.phase === 'gate_pending' && state.gate) {
        const gateApprovalId = state.gate.approvalId;
        const onScreen = history.pending.find((row) => row.approvalId === gateApprovalId);
        if (onScreen)
          return stay({
            ...base,
            gate: { ...state.gate, outOfDate: state.gate.outOfDate || !pendingFitsChain(onScreen, history) },
          });
        // The gate was decided or withdrawn elsewhere, so it is no longer on screen.
        return stay({ ...base, phase: 'idle', gate: null, refusal: null, notice: null });
      }

      const pending = history.pending[0] ?? null;
      if (pending && (state.phase === 'idle' || state.phase === 'reviewing'))
        return stay({
          ...base,
          phase: 'gate_pending',
          kind: null,
          gate: gateFromPending(pending, history),
          refusal: null,
        });

      if (state.phase === 'reviewing' && state.kind !== null && !allowed.includes(state.kind))
        return stay({
          ...base,
          phase: 'idle',
          kind: null,
          refusal: refuse('That correction is not available from the current standing.', 'reload'),
        });
      // A review opened on a chain position that has since moved is closed, so its draft cannot be sent against the new chain.
      if (state.phase === 'reviewing' && state.position !== history.chainPosition)
        return stay({
          ...base,
          phase: 'idle',
          kind: null,
          refusal: null,
          notice: CORRECTION_RECOVERY_COPY.historyChanged,
        });
      return stay(base);
    }

    case 'load_failed':
      if (state.phase === 'reconciling')
        return stay({ ...state, refusal: refuse(CORRECTION_RECOVERY_COPY.unavailable) });
      if (state.phase === 'verifying')
        return stay({
          ...state,
          phase: 'idle',
          verify: null,
          refusal: refuse(UNCONFIRMED_CORRECTION, 'reload'),
        });
      return stay({ ...state, refusal: refuse(CORRECTION_COPY.historyUnavailable) });

    case 'check_again':
      // While reconciling, the only action is another read, and only after a read has failed or could not settle.
      if (state.phase !== 'reconciling' || state.refusal === null) return stay(state);
      return { state: { ...state, refusal: null }, effects: [{ type: 'reload' }] };

    case 'review':
      if (state.phase !== 'idle' || state.position === null || !state.allowed.includes(event.kind))
        return stay(state);
      return {
        state: { ...state, phase: 'reviewing', kind: event.kind, refusal: null, notice: null },
        effects: [],
      };

    case 'cancel':
      if (state.phase !== 'reviewing') return stay(state);
      return {
        state: { ...state, phase: 'idle', kind: null, refusal: null, unknown: null, sent: null },
        effects: [],
      };

    case 'request': {
      if (state.phase !== 'reviewing' || state.position === null || state.kind !== event.draft.kind)
        return stay(state);
      const body = requestBodyFor(event.draft);
      if (!body) return stay(state);
      // After an unknown request the only request allowed is the held one, at the position it was sent from.
      if (state.unknown?.write === 'request' && !sameRequestBody(state.unknown.body, body))
        return stay(state);
      if (state.unknown?.write === 'request' && state.unknown.chainPosition !== state.position)
        return stay(state);
      return {
        state: {
          ...state,
          phase: 'requesting',
          heldExplanation: body.explanation,
          sent: { chainPosition: state.position, body },
          unknown: null,
          refusal: null,
          notice: null,
        },
        effects: [{ type: 'request', chainPosition: state.position, body }],
      };
    }

    case 'requested': {
      if (state.phase !== 'requesting') return stay(state);
      const { response } = event;
      return {
        state: {
          ...state,
          phase: 'gate_pending',
          kind: null,
          heldExplanation: null,
          sent: null,
          unknown: null,
          refusal: null,
          gate: {
            approvalId: response.approvalId,
            actionDigest: response.actionDigest,
            correctionKind: response.detail.correctionKind,
            reasonCode: response.detail.reasonCode,
            explanationRequired: response.detail.explanationDigest !== null,
            explanation: state.heldExplanation,
            outOfDate: false,
          },
        },
        effects: [],
      };
    }

    case 'request_failed':
      if (state.phase !== 'requesting') return stay(state);
      if (event.unknown === true && state.sent !== null)
        return {
          state: {
            ...state,
            phase: 'reconciling',
            kind: null,
            heldExplanation: null,
            gate: null,
            sent: null,
            unknown: { write: 'request', chainPosition: state.sent.chainPosition, body: state.sent.body },
            refusal: null,
            notice: CORRECTION_RECOVERY_COPY.reconciling,
          },
          effects: [{ type: 'reload' }],
        };
      if (event.refusal.next === 'reload')
        return {
          state: {
            ...state,
            phase: 'idle',
            kind: null,
            heldExplanation: null,
            gate: null,
            sent: null,
            refusal: event.refusal,
          },
          effects: [{ type: 'reload' }],
        };
      return {
        state: { ...state, phase: 'reviewing', heldExplanation: null, sent: null, refusal: event.refusal },
        effects: [],
      };

    case 'explanation': {
      if (state.phase !== 'gate_pending' || !state.gate) return stay(state);
      if (event.value.length > MAX_EXPLANATION) return stay(state);
      const explanation = event.value.length > 0 ? event.value : null;
      return { state: { ...state, gate: { ...state.gate, explanation } }, effects: [] };
    }

    case 'confirm': {
      if (state.phase !== 'gate_pending' || !state.gate || state.gate.outOfDate) return stay(state);
      const gate = state.gate;
      if (gate.explanationRequired && (gate.explanation === null || gate.explanation.length === 0))
        return stay(state);
      return {
        state: { ...state, phase: 'deciding', decision: 'approved', refusal: null, notice: null },
        effects: [
          {
            type: 'decide',
            approvalId: gate.approvalId,
            actionDigest: gate.actionDigest,
            decision: 'approved',
            attestationId: state.attestationId,
            correctionKind: gate.correctionKind,
            explanation: gate.explanationRequired ? gate.explanation : null,
          },
        ],
      };
    }

    case 'decline': {
      if (state.phase !== 'gate_pending' || !state.gate) return stay(state);
      const gate = state.gate;
      return {
        state: { ...state, phase: 'deciding', decision: 'denied', refusal: null, notice: null },
        effects: [
          {
            type: 'decide',
            approvalId: gate.approvalId,
            actionDigest: gate.actionDigest,
            decision: 'denied',
            attestationId: state.attestationId,
            correctionKind: gate.correctionKind,
            explanation: null,
          },
        ],
      };
    }

    case 'decided':
      if (state.phase !== 'deciding' || !state.gate || !state.decision) return stay(state);
      return {
        state: {
          ...state,
          phase: 'verifying',
          verify: { approvalId: state.gate.approvalId, decision: state.decision },
          gate: null,
          decision: null,
        },
        effects: [{ type: 'reload' }],
      };

    case 'decide_failed': {
      if (state.phase !== 'deciding' || !state.gate) return stay(state);
      const { refusal } = event;
      if (event.unknown === true && state.decision !== null) {
        const gate = state.gate;
        return {
          state: {
            ...state,
            phase: 'reconciling',
            kind: null,
            gate: null,
            decision: null,
            unknown: {
              write: 'decide',
              approvalId: gate.approvalId,
              actionDigest: gate.actionDigest,
              decision: state.decision,
              attestationId: state.attestationId,
              correctionKind: gate.correctionKind,
              explanation:
                state.decision === 'approved' && gate.explanationRequired ? gate.explanation : null,
            },
            refusal: null,
            notice: CORRECTION_RECOVERY_COPY.reconciling,
          },
          effects: [{ type: 'reload' }],
        };
      }
      if (refusal.next === 'reload')
        return {
          state: { ...state, phase: 'idle', kind: null, gate: null, decision: null, refusal },
          effects: [{ type: 'reload' }],
        };
      const outOfDate = refusal.next === 'out_of_date';
      return {
        state: {
          ...state,
          phase: 'gate_pending',
          decision: null,
          refusal,
          gate: { ...state.gate, outOfDate: state.gate.outOfDate || outOfDate },
        },
        effects: outOfDate ? [{ type: 'reload' }] : [],
      };
    }
  }
}
