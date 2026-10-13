import type { GoalDetail } from '../../shared/goalApi';

/**
 * Copy for the compact Goal view's completion standing. A pure leaf: type-only imports, no React, no request, no timer.
 * It reads the saved standing and returns text. It grants nothing and decides nothing about what the Goal may do.
 *
 * Trust rule: only a version-2 standing of `uncontested` whose claim has all five signals is shown as trusted. The stored
 * Goal status alone is never enough. Every other combination fails closed to a named state that makes no success claim.
 *
 * The qualifier and content-preservation sentences are copied from completionModel.ts on purpose. This module must not
 * import it, because that would join this leaf to the completionModel > refusal > presentation chain. The parity test
 * in completionStandingCopy.test.ts fails if the two copies drift.
 */

export const STANDING_SECTION_TITLE = 'Completion standing';

/** Shown on every state. It says what this view contains; it does not describe what the server allows. */
export const STANDING_READ_ONLY_NOTE =
  'This view only shows the saved standing. It has no control to complete a Goal or to correct a completion.';

export type PhoneStandingState =
  'trusted' | 'contested' | 'legacy' | 'invalid' | 'unreadable' | 'not_recorded' | 'unrecognised';

export type PhoneStandingTone = 'done' | 'attention' | 'danger' | 'neutral';

export type PhoneStandingIcon = 'done' | 'warning' | 'invalid';

export interface PhoneStandingView {
  state: PhoneStandingState;
  heading: string;
  /** A detail sentence for the states that have no qualifier or preservation line. Otherwise null. */
  detail: string | null;
  qualifier: string | null;
  contentPreservation: string | null;
  /** The tone of the next-action card and of the status pill. */
  tone: PhoneStandingTone;
  icon: PhoneStandingIcon;
  nextLabel: string;
  nextSummary: string;
}

const CONTENT_NOT_PROVEN = 'Content preservation: not proven.';
const CONTENT_NOT_APPLICABLE = 'Content preservation: not applicable.';
const CONTENT_UNRECOGNISED = 'Content preservation: unrecognised value. Treat it as not proven.';

const QUALIFIER_COPY: Record<string, string | null> = {
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

const CONTESTED_STANDINGS: readonly string[] = [
  'disputed',
  'withdrawn',
  'superseded',
  'reconciliation_required',
];

const TRUSTED_HEADING = 'Completed on a recorded decision. Turing has not proven content preservation.';
const CONTESTED_HEADING = 'Completed earlier; later contested.';
const LEGACY_HEADING = 'Completed before external attestation existed. Not attested.';
const INVALID_HEADING = 'Completion records could not be verified.';
const UNREADABLE_HEADING = 'Standing could not be read';
const NOT_RECORDED_HEADING = 'No completion record was found.';
const UNRECOGNISED_HEADING = 'Standing not recognised.';

const UNREADABLE_DETAIL =
  'The Goal status says completed, but its saved completion standing was not available. Turing cannot say whether this completion is contested. Refresh to read it again.';
const NOT_RECORDED_DETAIL =
  'The Goal status says completed, but no saved completion backs it. Treat it as not confirmed.';
const UNRECOGNISED_DETAIL =
  'This view does not recognise the saved completion standing, so it makes no completion claim.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function qualifierLine(value: unknown): string | null {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(QUALIFIER_COPY, value)) {
    return UNKNOWN_QUALIFIER;
  }
  return QUALIFIER_COPY[value] ?? null;
}

function preservationLine(value: unknown): string {
  if (value === 'not_proven') return CONTENT_NOT_PROVEN;
  if (value === 'not_applicable') return CONTENT_NOT_APPLICABLE;
  return CONTENT_UNRECOGNISED;
}

const UNREADABLE: PhoneStandingView = {
  state: 'unreadable',
  heading: UNREADABLE_HEADING,
  detail: UNREADABLE_DETAIL,
  qualifier: null,
  contentPreservation: null,
  tone: 'attention',
  icon: 'warning',
  nextLabel: 'Standing could not be read',
  nextSummary: 'The Goal status says completed. Its completion standing was not available.',
};

const NOT_RECORDED: PhoneStandingView = {
  state: 'not_recorded',
  heading: NOT_RECORDED_HEADING,
  detail: NOT_RECORDED_DETAIL,
  qualifier: null,
  contentPreservation: null,
  tone: 'attention',
  icon: 'warning',
  nextLabel: 'No completion record found',
  nextSummary: NOT_RECORDED_DETAIL,
};

const UNRECOGNISED: PhoneStandingView = {
  state: 'unrecognised',
  heading: UNRECOGNISED_HEADING,
  detail: UNRECOGNISED_DETAIL,
  qualifier: null,
  contentPreservation: null,
  tone: 'attention',
  icon: 'warning',
  nextLabel: 'Standing not recognised',
  nextSummary: UNRECOGNISED_DETAIL,
};

const TRUSTED: PhoneStandingView = {
  state: 'trusted',
  heading: TRUSTED_HEADING,
  detail: null,
  qualifier: null,
  contentPreservation: CONTENT_NOT_PROVEN,
  tone: 'done',
  icon: 'done',
  nextLabel: 'Completed',
  nextSummary: 'The completion is uncontested. Turing has not proven content preservation.',
};

const INVALID: PhoneStandingView = {
  state: 'invalid',
  heading: INVALID_HEADING,
  detail: null,
  qualifier: null,
  contentPreservation: null,
  tone: 'danger',
  icon: 'invalid',
  nextLabel: 'Completion could not be verified',
  nextSummary:
    'The saved completion records could not be checked. Treat this Goal as not confirmed complete.',
};

/** Classifies a saved standing. The input is untrusted, so every field is checked before it is read. */
function classify(raw: unknown): PhoneStandingView {
  if (!isRecord(raw)) return UNRECOGNISED;
  const { kind, standing, claim } = raw;
  if (kind === 'not_completed') return NOT_RECORDED;
  if (!isRecord(claim)) return UNRECOGNISED;
  if (kind === 'v2' && typeof standing === 'string' && CONTESTED_STANDINGS.includes(standing)) {
    return {
      state: 'contested',
      heading: CONTESTED_HEADING,
      detail: null,
      qualifier: qualifierLine(claim.qualifier),
      contentPreservation: preservationLine(claim.contentPreservation),
      tone: 'attention',
      icon: 'warning',
      nextLabel: 'Completion contested',
      nextSummary: 'This completion was later contested. See the completion standing for what was recorded.',
    };
  }
  if (kind === 'legacy' && standing === 'historical_legacy') {
    return {
      state: 'legacy',
      heading: LEGACY_HEADING,
      detail: null,
      qualifier: qualifierLine(claim.qualifier),
      contentPreservation: null,
      tone: 'neutral',
      icon: 'warning',
      nextLabel: 'Completed before attestation existed',
      nextSummary: 'This completion is not attested. See the completion standing for what was recorded.',
    };
  }
  if (kind === 'invalid' && standing === 'invalid_unverified') return INVALID;
  if (kind === 'v2' && standing === 'uncontested') {
    // The one trusted case. Every signal must agree; any disagreement fails closed.
    const trusted =
      claim.unqualifiedSuccessAllowed === true &&
      claim.trustedForDownstream === true &&
      claim.qualifier === 'none' &&
      claim.contentPreservation === 'not_proven';
    return trusted ? TRUSTED : UNRECOGNISED;
  }
  return UNRECOGNISED;
}

/**
 * The compact view's standing for one Goal, or null. Null means the section is not shown: the view exists only for a
 * Goal whose stored status is `completed`. A completed Goal with no standing gets the unreadable state, never trust.
 */
export function phoneStandingView(
  goal: Pick<GoalDetail, 'status' | 'completionStanding'>,
): PhoneStandingView | null {
  if (goal.status !== 'completed') return null;
  const raw: unknown = goal.completionStanding;
  if (raw === undefined || raw === null) return UNREADABLE;
  return classify(raw);
}
