import type { GoalStatus } from '../../shared/goals';
import type { GoalNextAction } from '../../shared/goalApi';

/**
 * Pure presentation helpers for the Goal UI. Nothing here decides what is allowed: `nextAction` is the server's advice
 * and is only labelled, never reinterpreted.
 */

export type Tone = 'neutral' | 'active' | 'wait' | 'attention' | 'danger' | 'done';

export const humanize = (code: string | null | undefined): string =>
  code ? code.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase()) : '';

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export const shortHash = (value: string | null | undefined): string => (value ? value.slice(0, 10) : '—');

export const STATUS_TONE: Record<GoalStatus, Tone> = {
  draft: 'neutral',
  ready: 'neutral',
  running: 'active',
  reviewing: 'active',
  needs_user: 'attention',
  blocked: 'danger',
  paused: 'wait',
  completed: 'done',
  abandoned: 'neutral',
};

export interface NextActionPresentation {
  /** Stable machine key, also exposed as `data-next-action` for tests. */
  kind: GoalNextAction['kind'];
  label: string;
  summary: string;
  tone: Tone;
  /** True only for the fail-closed state, which must never look like a routine action. */
  failClosed: boolean;
}

/** Exhaustive over `GoalNextAction`: a new server kind is a compile error here, never a silent fallthrough. */
export function describeNextAction(action: GoalNextAction): NextActionPresentation {
  const make = (label: string, summary: string, tone: Tone, failClosed = false): NextActionPresentation => ({
    kind: action.kind,
    label,
    summary,
    tone,
    failClosed,
  });
  switch (action.kind) {
    case 'author_definition':
      return make('Author a definition', 'The Goal has no definition yet.', 'attention');
    case 'approve_definition':
      return make(
        `Approve definition v${action.version}`,
        'A proposed definition is waiting for your approval.',
        'attention',
      );
    case 'start':
      return make('Ready to start', 'The definition is approved and the Goal can be started.', 'attention');
    case 'resume':
      return make(
        'Ready to resume',
        'The blocking condition has been resolved; the Goal can resume.',
        'attention',
      );
    case 'wait_for_turing':
      return make(
        'Turing is working',
        'Turing is working or settling a cycle. Nothing is needed from you right now.',
        'active',
      );
    case 'review_approval':
      return make('Review an approval', 'A gate is waiting for your decision.', 'attention');
    case 'resume_run':
      return make('Resume the paused run', 'A child run was paused and can be resumed.', 'attention');
    case 'resolve_blocker':
      return make(
        'Resolve a blocker',
        `The Goal is blocked (${humanize(action.reasonCode).toLowerCase()}).`,
        'danger',
      );
    case 'revise_goal':
      return make('Revise the Goal', 'A gate was denied. The definition needs a revision.', 'attention');
    case 'resume_after_amendment':
      return make('Resume after amendment', 'The amendment is settled; the Goal can resume.', 'attention');
    case 'final_acceptance':
      return make(
        'Final acceptance',
        'A distinct final-acceptance gate needs your decision. It does not change your branch.',
        'attention',
      );
    case 'final_apply':
      return make(
        'Ready for final apply',
        'Everything is accepted. Applying to your branch is a separate step that this screen does not perform.',
        'done',
      );
    case 'manual_reconciliation':
      return make(
        'Manual reconciliation required',
        'Turing failed closed: the recorded state could not be proved. It will not guess what you intended, so this needs a manual check.',
        'danger',
        true,
      );
    case 'completed':
      return make('Completed', 'This Goal is complete.', 'done');
    case 'abandoned':
      return make('Abandoned', 'This Goal was abandoned. History is retained.', 'neutral');
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
