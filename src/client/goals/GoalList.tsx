import { RefreshCw } from 'lucide-react';
import type { GoalListItem, GoalListResponse } from '../../shared/goalApi';
import { describeNextAction, formatTime, humanize } from './presentation';
import { Empty, GoalStatusPill, Resource, TruncationNote } from './parts';
import type { Loaded } from './useLoad';

const openFindings = (goal: GoalListItem): number =>
  Object.values(goal.openFindingCounts).reduce((sum, count) => sum + count, 0);

export function GoalList({
  result,
  onRetry,
  onSelect,
  compact = false,
}: {
  result: Loaded<GoalListResponse>;
  onRetry: () => void;
  onSelect: (goalId: string) => void;
  compact?: boolean;
}) {
  return (
    <Resource result={result} label="Grand Projects" onRetry={onRetry}>
      {(data) =>
        data.goals.length === 0 ? (
          <Empty>
            {compact
              ? 'No Grand Projects yet. Create a definition from the desktop interface.'
              : 'No Grand Projects yet. A Goal is a bounded, supervised project that Turing works on across many finite runs. Use New Grand Project to create one.'}
          </Empty>
        ) : (
          <>
            <ul className="goal-list" aria-label="Grand Projects">
              {data.goals.map((goal) => {
                const next = describeNextAction(goal.nextAction);
                const findings = openFindings(goal);
                return (
                  <li key={goal.id}>
                    <button
                      type="button"
                      className={`goal-row${goal.needsUser ? ' goal-row-attention' : ''}${compact ? ' goal-row-mobile' : ''}`}
                      data-needs-user={goal.needsUser ? 'true' : 'false'}
                      data-goal-list-focus
                      onClick={() => onSelect(goal.id)}
                    >
                      <span className="goal-row-main">
                        <strong>{goal.title}</strong>
                        <span className="goal-row-meta">
                          {goal.projectName}
                          {compact ? '' : goal.activeMilestone ? ` · ${goal.activeMilestone.title}` : ''}
                        </span>
                        {compact && goal.activeMilestone && (
                          <span className="goal-row-meta">
                            Active milestone · {goal.activeMilestone.title}
                          </span>
                        )}
                      </span>
                      <span className="goal-row-state">
                        <GoalStatusPill status={goal.status} reason={goal.reasonCode} />
                        {goal.needsUser && <span className="goal-needs-you">Needs you</span>}
                      </span>
                      <span className="goal-row-next" data-next-action={next.kind}>
                        <span className="goal-eyebrow">Next</span>
                        {next.label}
                      </span>
                      <span className="goal-row-meta goal-row-side">
                        <span>
                          {goal.lastCycle
                            ? `Cycle ${goal.lastCycle.sequence} · ${humanize(goal.lastCycle.status)}`
                            : 'No cycles yet'}
                          {findings > 0 ? ` · ${findings} open finding${findings === 1 ? '' : 's'}` : ''}
                        </span>
                        <span>Updated {formatTime(goal.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <TruncationNote shown={data.goals.length} total={data.total} />
          </>
        )
      }
    </Resource>
  );
}

export function RefreshButton({ onClick, label = 'Refresh' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="secondary-button" onClick={onClick}>
      <RefreshCw size={14} aria-hidden="true" /> {label}
    </button>
  );
}
