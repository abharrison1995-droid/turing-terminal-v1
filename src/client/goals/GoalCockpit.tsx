import { ArrowLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import { goalsApi } from './api';
import { ConfirmPanel } from './DefinitionParts';
import { DefinitionsPanel } from './GoalDefinitions';
import { GoalControls } from './GoalControls';
import { goalAcceptsDecisions } from './controls';
import { FindingsPanel } from './GoalFindings';
import { CyclesPanel, EvidencePanel, ReviewsPanel } from './GoalHistory';
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
export function GoalCockpit({
  goalId,
  onBack,
  onUnsavedChange,
}: {
  goalId: string;
  onBack: () => void;
  /** Reports whether the definition editor holds unsaved text (a boolean only; the text stays here). */
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<TabId>('overview');
  // Bumped by Refresh. Only the mounted tab reads it, so a refresh re-reads that tab and nothing unvisited.
  const [generation, setGeneration] = useState(0);
  const bump = () => setGeneration((value) => value + 1);
  const detail = useLoad(() => goalsApi.detail(goalId), goalId, generation);
  // Unsaved definition text lives in the Definitions tab; leaving it (tab, Goal, version) asks first, in the app.
  const dirty = useRef(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const guard = (proceed: () => void) => (dirty.current ? setLeaving(() => proceed) : proceed());
  return (
    <div className="goal-cockpit">
      <div className="goal-cockpit-top">
        <button type="button" className="secondary-button" onClick={() => guard(onBack)}>
          <ArrowLeft size={14} aria-hidden="true" /> All Goals
        </button>
        <RefreshButton onClick={bump} />
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
            <GoalControls goal={goal} onChanged={bump} />
            {leaving && (
              <ConfirmPanel label="Confirm leave" title="Discard unsaved definition changes?">
                <p>Your edits to the proposed definition have not been saved and will be lost.</p>
                <div className="goal-control-buttons">
                  <button
                    type="button"
                    className="secondary-button goal-danger"
                    onClick={() => {
                      const proceed = leaving;
                      dirty.current = false;
                      setLeaving(null);
                      proceed();
                    }}
                  >
                    Discard and leave
                  </button>
                  <button type="button" className="secondary-button" onClick={() => setLeaving(null)}>
                    Keep editing
                  </button>
                </div>
              </ConfirmPanel>
            )}
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
                  onClick={() => guard(() => setTab(id))}
                >
                  {label}
                </button>
              ))}
            </div>
            <div id="goal-tabpanel" role="tabpanel" aria-labelledby={`goal-tab-${tab}`}>
              {tab === 'overview' && <GoalOverview goal={goal} refresh={generation} onChanged={bump} />}
              {tab === 'cycles' && <CyclesPanel goalId={goal.id} refresh={generation} />}
              {tab === 'reviews' && <ReviewsPanel goalId={goal.id} refresh={generation} />}
              {tab === 'findings' && (
                <FindingsPanel
                  goalId={goal.id}
                  refresh={generation}
                  onDecided={bump}
                  decisionsEnabled={goalAcceptsDecisions(goal)}
                />
              )}
              {tab === 'evidence' && <EvidencePanel goalId={goal.id} refresh={generation} />}
              {tab === 'definitions' && (
                <DefinitionsPanel
                  goal={goal}
                  refresh={generation}
                  onChanged={bump}
                  guard={guard}
                  onDirty={(value) => {
                    dirty.current = value;
                    onUnsavedChange?.(value);
                  }}
                />
              )}
              {tab === 'usage' && <UsagePanel goalId={goal.id} refresh={generation} />}
            </div>
          </>
        )}
      </Resource>
    </div>
  );
}
