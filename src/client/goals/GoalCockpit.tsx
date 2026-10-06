import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { goalsApi } from './api';
import { DefinitionsPanel } from './GoalDefinitions';
import { CyclesPanel, EvidencePanel, FindingsPanel, ReviewsPanel } from './GoalHistory';
import { RefreshButton } from './GoalList';
import { GoalOverview } from './GoalOverview';
import { UsagePanel } from './GoalUsage';
import { GoalStatusPill, Resource } from './parts';
import { useLoad } from './useLoad';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'findings', label: 'Findings' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'definitions', label: 'Definitions' },
  { id: 'usage', label: 'Usage' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * The read-only desktop cockpit for one Goal. Only the selected tab is mounted, so each tab's read happens when the
 * user opens it and switching tabs never triggers anything but GETs.
 */
export function GoalCockpit({ goalId, onBack }: { goalId: string; onBack: () => void }) {
  const [tab, setTab] = useState<TabId>('overview');
  const detail = useLoad(() => goalsApi.detail(goalId), goalId);
  return (
    <div className="goal-cockpit">
      <div className="goal-cockpit-top">
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> All Goals
        </button>
        <RefreshButton onClick={detail.reload} />
      </div>
      <Resource result={detail.result} label="Goal" onRetry={detail.reload}>
        {(goal) => (
          <>
            <header className="goal-cockpit-head">
              <div>
                <h2>{goal.title}</h2>
                <p className="goal-row-meta">{goal.projectName}</p>
              </div>
              <GoalStatusPill status={goal.status} reason={goal.reasonCode} />
            </header>
            <div className="goal-tabs" role="tablist" aria-label="Goal sections">
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`goal-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="goal-tabpanel"
                  className={`goal-tab${tab === id ? ' goal-tab-active' : ''}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div id="goal-tabpanel" role="tabpanel" aria-labelledby={`goal-tab-${tab}`}>
              {tab === 'overview' && <GoalOverview goal={goal} />}
              {tab === 'cycles' && <CyclesPanel goalId={goal.id} />}
              {tab === 'reviews' && <ReviewsPanel goalId={goal.id} />}
              {tab === 'findings' && <FindingsPanel goalId={goal.id} />}
              {tab === 'evidence' && <EvidencePanel goalId={goal.id} />}
              {tab === 'definitions' && (
                <DefinitionsPanel goalId={goal.id} currentVersion={goal.currentDefinitionVersion} />
              )}
              {tab === 'usage' && <UsagePanel goalId={goal.id} />}
            </div>
          </>
        )}
      </Resource>
    </div>
  );
}
