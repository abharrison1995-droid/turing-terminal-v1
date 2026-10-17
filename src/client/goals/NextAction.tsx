import { AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Hourglass, ShieldCheck } from 'lucide-react';
import type { GoalNextAction } from '../../shared/goalApi';
import type { PhoneStandingView } from './completionStandingCopy';
import { describeNextAction } from './presentation';

const STANDING_ICON = { done: CheckCircle2, warning: AlertTriangle, invalid: AlertOctagon } as const;

/**
 * Display-only. This is advice from the server's `nextAction` projection; there is deliberately no button here, and
 * 7B.1 has no mutation path. The fail-closed state gets its own element and role so it cannot pass for a routine step.
 *
 * `standing` is passed only by the compact view, and only for a completed Goal. It replaces the label, summary, tone and
 * icon of the completed step, so a completed label is never shown beside a contested or unreadable standing. Without it
 * the card is the unchanged server advice.
 */
export function NextActionCard({
  action,
  standing,
}: {
  action: GoalNextAction;
  standing?: PhoneStandingView;
}) {
  const base = describeNextAction(action);
  const shown = action.kind === 'completed' ? (standing ?? null) : null;
  const view = shown
    ? { ...base, label: shown.nextLabel, summary: shown.nextSummary, tone: shown.tone }
    : base;
  const Icon = shown
    ? STANDING_ICON[shown.icon]
    : view.failClosed
      ? AlertOctagon
      : view.kind === 'wait_for_turing'
        ? Hourglass
        : view.kind === 'completed'
          ? CheckCircle2
          : view.kind === 'final_acceptance' || view.kind === 'review_approval'
            ? ShieldCheck
            : ArrowRight;
  return (
    <section
      className={`goal-next goal-tone-${view.tone}${view.failClosed ? ' goal-next-failclosed' : ''}`}
      data-next-action={view.kind}
      aria-label="Next action"
      {...(view.failClosed ? { role: 'alert' } : {})}
    >
      <Icon size={18} aria-hidden="true" />
      <div>
        <span className="goal-eyebrow">{view.failClosed ? 'Failed closed' : 'What happens next'}</span>
        <strong>{view.label}</strong>
        <p>{view.summary}</p>
      </div>
    </section>
  );
}
