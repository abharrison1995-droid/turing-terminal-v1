import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectProfile } from '../../shared/types';
import { goalsApi } from './api';
import { GoalCockpit } from './GoalCockpit';
import { GoalList, RefreshButton } from './GoalList';
import { ConfirmPanel } from './DefinitionParts';
import { NewGoal } from './NewGoal';
import { useLoad } from './useLoad';
import { useCompactViewport } from './useCompactViewport';

/** The single integration point for the Goals area: `App.tsx` renders this and nothing else from the Goal UI. */
export function GoalsPage({
  projects = [],
  onOpenProjects,
  onUnsavedChange,
  navigationGuardActive = false,
  initialGoalId,
  onInitialGoalConsumed,
}: {
  /** The registered projects the app already holds; Goal creation never discovers or registers one. */
  projects?: ProjectProfile[];
  onOpenProjects?: () => void;
  /** Whether the mounted Goals workflow holds unsaved authoring work. Booleans only, never the text. */
  onUnsavedChange?: (dirty: boolean) => void;
  /** Prevents stacking the responsive confirmation over App's top-level leave confirmation. */
  navigationGuardActive?: boolean;
  /** A one-time, navigation-only Goal selection parsed by App from a bounded same-origin query. */
  initialGoalId?: string | null;
  onInitialGoalConsumed?: () => void;
} = {}) {
  const [selected, setSelected] = useState<string | null>(initialGoalId ?? null);
  const [creating, setCreating] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [keepDesktopForCompact, setKeepDesktopForCompact] = useState(false);
  const [discardingForCompact, setDiscardingForCompact] = useState(false);
  const report = useRef(onUnsavedChange);
  report.current = onUnsavedChange;
  const dirty = formDirty || editorDirty;
  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => report.current?.(false), []);
  useEffect(() => {
    if (initialGoalId) onInitialGoalConsumed?.();
  }, [initialGoalId, onInitialGoalConsumed]);
  const list = useLoad(() => goalsApi.list(), 'goals');
  const viewportCompact = useCompactViewport();
  const effectiveCompact = viewportCompact && (!dirty || discardingForCompact);
  const compactTransitionBlocked = viewportCompact && dirty && !discardingForCompact;
  const showCompactConfirmation =
    compactTransitionBlocked && !keepDesktopForCompact && !navigationGuardActive;
  useEffect(() => {
    if (!viewportCompact || !dirty) {
      setKeepDesktopForCompact(false);
      setDiscardingForCompact(false);
    }
  }, [viewportCompact, dirty]);
  useEffect(() => {
    if (effectiveCompact && creating) setCreating(false);
  }, [effectiveCompact, creating]);
  return (
    <main className={`page-content goals-page${effectiveCompact ? ' goals-page-compact' : ''}`}>
      {showCompactConfirmation && (
        <ConfirmPanel label="Confirm switch to phone view" title="Switch to phone view?">
          <p>
            {editorDirty
              ? 'The phone Goal cockpit does not include definition editing. Your unsaved definition changes would be discarded.'
              : 'Grand Project creation is desktop-only. Your unsaved draft form would be discarded.'}
          </p>
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button goal-danger"
              onClick={() => {
                setKeepDesktopForCompact(false);
                setDiscardingForCompact(true);
                setCreating(false);
              }}
            >
              Discard and switch to phone view
            </button>
            <button type="button" className="secondary-button" onClick={() => setKeepDesktopForCompact(true)}>
              Keep editing
            </button>
          </div>
        </ConfirmPanel>
      )}
      {(!effectiveCompact || selected === null) && (
        <div className="page-heading">
          <div>
            <h1>Grand Projects</h1>
            <p>
              {effectiveCompact
                ? 'Track Goal progress, review approvals and use the bounded pause or resume controls.'
                : 'Long-running Goals that Turing advances in bounded cycles. You create, approve and revise definitions, and start, pause, resume and decide here; the server still checks every action and may refuse it.'}
            </p>
          </div>
          {selected === null && !creating && (
            <div className="page-actions">
              {!effectiveCompact && (
                <button type="button" className="primary-button" onClick={() => setCreating(true)}>
                  <Plus size={14} aria-hidden="true" /> New Grand Project
                </button>
              )}
              <RefreshButton onClick={list.reload} />
            </div>
          )}
        </div>
      )}
      {creating && !effectiveCompact ? (
        <NewGoal
          projects={projects}
          onCancel={() => setCreating(false)}
          onOpenProjects={onOpenProjects}
          onUnsavedChange={setFormDirty}
          onCreated={(goalId) => {
            setCreating(false);
            setSelected(goalId);
            list.reload();
          }}
        />
      ) : selected === null ? (
        <>
          {effectiveCompact && (
            <p className="goal-note goal-mobile-desktop-note">
              Create and edit Grand Project definitions from the desktop interface.
            </p>
          )}
          <GoalList
            result={list.result}
            onRetry={list.reload}
            onSelect={setSelected}
            compact={effectiveCompact}
          />
        </>
      ) : (
        <GoalCockpit
          goalId={selected}
          compact={effectiveCompact}
          onUnsavedChange={setEditorDirty}
          onBack={() => {
            setSelected(null);
            list.reload();
          }}
        />
      )}
    </main>
  );
}
