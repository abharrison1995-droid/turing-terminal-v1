import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { GoalDetail, GoalNextAction } from '../../shared/goalApi';
import { GoalControls } from './GoalControls';
import { UnifiedApprovals } from './UnifiedApprovals';
import { GoalStatusPill } from './parts';
import { formatTime, humanize, shortHash } from './presentation';
import { NextActionCard } from './NextAction';
import { goalAcceptsDecisions } from './controls';

const expectedApprovalId = (action: GoalNextAction): string | null =>
  action.kind === 'review_approval' || action.kind === 'final_acceptance' ? action.approvalId : null;

function desktopOnlyMessage(action: GoalNextAction): string | null {
  switch (action.kind) {
    case 'author_definition':
    case 'approve_definition':
    case 'revise_goal':
      return 'Definition changes require the desktop interface.';
    case 'start':
      return 'This Grand Project is ready. Start it from the desktop interface.';
    case 'final_apply':
      return 'This Goal is ready for manual-integration review. Open Turing Terminal on desktop to prepare and inspect the handoff. Your Git branch will not be changed automatically.';
    case 'manual_reconciliation':
      return 'This Goal needs manual reconciliation on the desktop.';
    default:
      return null;
  }
}

export function GoalMobileCockpit({
  goal,
  refresh,
  onChanged,
  onBack,
  onRefresh,
}: {
  goal: GoalDetail;
  refresh: number;
  onChanged: () => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const cycle = goal.activeCycle ?? goal.lastCycle;
  const findings = Object.values(goal.openFindingCounts).reduce((sum, count) => sum + count, 0);
  const desktopMessage = desktopOnlyMessage(goal.nextAction);
  return (
    <div className="goal-mobile-cockpit">
      <div className="goal-cockpit-top goal-mobile-top">
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Grand Projects
        </button>
        <button type="button" className="secondary-button" onClick={onRefresh}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>

      <header className="goal-mobile-heading">
        <div className="goal-mobile-title">
          <h1 data-compact-focus-target tabIndex={-1}>
            {goal.title}
          </h1>
          <p>{goal.projectName}</p>
        </div>
        <GoalStatusPill status={goal.status} reason={goal.reasonCode} />
      </header>

      {goal.needsUser && (
        <section className="goal-mobile-needs" aria-label="Needs you">
          <strong>Needs you</strong>
          <span>
            {goal.reasonCode
              ? `Reason: ${humanize(goal.reasonCode)}.`
              : goal.pendingApprovalCount > 0
                ? 'A Goal approval is waiting for your decision.'
                : 'Review the current Goal state.'}
          </span>
        </section>
      )}

      <NextActionCard action={goal.nextAction} />
      {desktopMessage && <p className="goal-mobile-desktop-note">{desktopMessage}</p>}

      <GoalControls goal={goal} onChanged={onChanged} compact />

      <UnifiedApprovals
        goalId={goal.id}
        heading="Approvals for this Goal"
        expectedGoalApprovalId={expectedApprovalId(goal.nextAction)}
        refresh={refresh}
        onDecided={onChanged}
        decisionsEnabled={goalAcceptsDecisions(goal)}
        readOnlyAll={
          goal.nextAction.kind === 'manual_reconciliation' ||
          goal.status === 'completed' ||
          goal.status === 'abandoned'
        }
      />

      <section className="surface-panel goal-mobile-progress" aria-label="Current progress">
        <h2>Current progress</h2>
        <dl>
          <div>
            <dt>Active milestone</dt>
            <dd>{goal.activeMilestone?.title ?? 'None'}</dd>
          </div>
          <div>
            <dt>{goal.activeCycle ? 'Current cycle' : 'Most recent cycle'}</dt>
            <dd>
              {cycle
                ? `#${cycle.sequence} · ${humanize(cycle.kind)} · ${humanize(cycle.status)}`
                : 'No cycles yet'}
            </dd>
          </div>
          <div>
            <dt>Child run</dt>
            <dd>
              {goal.childRun
                ? `${humanize(goal.childRun.purpose)} · ${humanize(goal.childRun.status)}`
                : 'None'}
            </dd>
          </div>
          <div>
            <dt>Integration</dt>
            <dd className="goal-mobile-integration">
              <code>{goal.integrationBranch ?? 'No Goal branch'}</code>
              {goal.integrationHead && <span>Head {shortHash(goal.integrationHead)}</span>}
            </dd>
          </div>
          <div>
            <dt>Open findings</dt>
            <dd>{findings}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatTime(goal.updatedAt)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
