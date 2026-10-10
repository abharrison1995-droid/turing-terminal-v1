import { AlertOctagon, ArrowRight, CheckCircle2, Hourglass, ShieldCheck } from 'lucide-react';
import type { GoalNextAction } from '../../shared/goalApi';
import { describeNextAction } from './presentation';

/**
 * Display-only. This is advice from the server's `nextAction` projection; there is deliberately no button here, and
 * 7B.1 has no mutation path. The fail-closed state gets its own element and role so it cannot pass for a routine step.
 */
export function NextActionCard({ action }: { action: GoalNextAction }) {
  const view = describeNextAction(action);
  const Icon = view.failClosed
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
