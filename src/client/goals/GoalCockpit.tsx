import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GOAL_EVENT_TYPES } from '../../shared/goals';
import { masterApiUrl } from '../desktop';
import { goalsApi } from './api';
import { ConfirmPanel } from './DefinitionParts';
import { DefinitionsPanel } from './GoalDefinitions';
import { GoalControls } from './GoalControls';
import { goalAcceptsDecisions } from './controls';
import { FindingsPanel } from './GoalFindings';
import { CyclesPanel, EvidencePanel, ReviewsPanel } from './GoalHistory';
import { RefreshButton } from './GoalList';
import { GoalOverview } from './GoalOverview';
import { type GoalAttestationChoice, GoalHandoff } from './GoalHandoff';
import { UsagePanel } from './GoalUsage';
import { GoalStatusPill, Resource } from './parts';
import { humanize } from './presentation';
import { useLoad } from './useLoad';
import { GoalMobileCockpit } from './GoalMobileCockpit';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'findings', label: 'Findings' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'definitions', label: 'Definitions' },
  { id: 'usage', label: 'Usage' },
  { id: 'handoff', label: 'Handoff' },
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
  compact = false,
}: {
  goalId: string;
  onBack: () => void;
  /** Reports whether the definition editor holds unsaved text (a boolean only; the text stays here). */
  onUnsavedChange?: (dirty: boolean) => void;
  compact?: boolean;
}) {
  const [tab, setTab] = useState<TabId>('overview');
  const tabSetId = useId();
  const tabButtons = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const focusAfterTabChange = useRef<TabId | null>(null);
  // Bumped by Refresh. Only the mounted tab reads it, so a refresh re-reads that tab and nothing unvisited.
  const [generation, setGeneration] = useState(0);
  const bump = useCallback(() => setGeneration((value) => value + 1), []);
  const detail = useLoad(() => goalsApi.detail(goalId), goalId, generation);
  // The attestation chosen on the Handoff tab. It is held here, not in the tab, so a tab switch keeps it, and it is cleared
  // whenever the Goal changes, so no selection is ever carried from one Goal to another.
  const [attestationChoice, setAttestationChoice] = useState<GoalAttestationChoice | null>(null);
  useEffect(() => {
    setAttestationChoice(null);
  }, [goalId]);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const stream = new EventSource(masterApiUrl(`/api/events?goalId=${encodeURIComponent(goalId)}`));
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        bump();
      }, 50);
    };
    stream.addEventListener('open', scheduleRefresh);
    for (const eventName of GOAL_EVENT_TYPES) stream.addEventListener(eventName, scheduleRefresh);
    return () => {
      stream.close();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [goalId, bump]);
  // Unsaved definition text lives in the Definitions tab; leaving it (tab, Goal, version) asks first, in the app.
  const dirty = useRef(false);
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const guard = (proceed: () => void) => (dirty.current ? setLeaving(() => proceed) : proceed());
  useLayoutEffect(() => {
    if (focusAfterTabChange.current !== tab) return;
    tabButtons.current[tab]?.focus();
    focusAfterTabChange.current = null;
  }, [tab]);
  const selectTab = (next: TabId, moveFocus = false) => {
    if (next === tab) {
      if (moveFocus) tabButtons.current[next]?.focus();
      return;
    }
    if (moveFocus) focusAfterTabChange.current = next;
    guard(() => setTab(next));
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = TABS.findIndex(({ id }) => id === tab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[next]!.id, true);
  };
  return (
    <div
      className="goal-cockpit"
      data-goal-cockpit-focus
      role="region"
      aria-label="Selected Goal"
      tabIndex={-1}
    >
      {!compact && (
        <div className="goal-cockpit-top">
          <button type="button" className="secondary-button" onClick={() => guard(onBack)}>
            <ArrowLeft size={14} aria-hidden="true" /> All Goals
          </button>
          <RefreshButton onClick={bump} />
        </div>
      )}
      <Resource result={detail.result} label="Goal" onRetry={detail.reload}>
        {(goal) => (
          <>
            {compact ? (
              <GoalMobileCockpit
                goal={goal}
                refresh={generation}
                onChanged={bump}
                onBack={() => guard(onBack)}
                onRefresh={bump}
              />
            ) : (
              <>
                <header className="goal-cockpit-head">
                  <div>
                    <h2>{goal.title}</h2>
                    <p className="goal-row-meta">{goal.projectName}</p>
                  </div>
                  <GoalStatusPill status={goal.status} reason={goal.reasonCode} />
                </header>
                {goal.needsUser && (
                  <section className="goal-cockpit-attention" aria-label="Needs you">
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
                <GoalControls goal={goal} onChanged={bump} />
                {leaving && (
                  <ConfirmPanel
                    label="Confirm leave"
                    title="Discard unsaved definition changes?"
                    description="Your edits to the proposed definition have not been saved and will be lost."
                    onCancel={() => {
                      focusAfterTabChange.current = null;
                      setLeaving(null);
                    }}
                  >
                    <div className="goal-control-buttons">
                      <button
                        type="button"
                        className="secondary-button"
                        data-confirm-safe
                        onClick={() => setLeaving(null)}
                      >
                        Keep editing
                      </button>
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
                    </div>
                  </ConfirmPanel>
                )}
                <div
                  className="goal-tabs"
                  role="tablist"
                  aria-label="Goal sections"
                  aria-orientation="horizontal"
                >
                  {TABS.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      ref={(element) => {
                        tabButtons.current[id] = element;
                      }}
                      id={`${tabSetId}-tab-${id}`}
                      aria-selected={tab === id}
                      aria-controls={`${tabSetId}-panel-${id}`}
                      tabIndex={tab === id ? 0 : -1}
                      className={`goal-tab${tab === id ? ' goal-tab-active' : ''}`}
                      onClick={() => selectTab(id)}
                      onKeyDown={onTabKeyDown}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {TABS.map(({ id, label }) => (
                  <div
                    key={id}
                    id={`${tabSetId}-panel-${id}`}
                    role="tabpanel"
                    aria-labelledby={`${tabSetId}-tab-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    hidden={tab !== id}
                  >
                    {tab === id && (
                      <>
                        <h2 className="sr-only">{label}</h2>
                        {tab === 'overview' && (
                          <GoalOverview goal={goal} refresh={generation} onChanged={bump} />
                        )}
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
                        {tab === 'handoff' && (
                          <GoalHandoff
                            key={goal.id}
                            goal={goal}
                            refresh={generation}
                            attestationChoice={attestationChoice}
                            onAttestationChoice={setAttestationChoice}
                          />
                        )}
                      </>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </Resource>
    </div>
  );
}
