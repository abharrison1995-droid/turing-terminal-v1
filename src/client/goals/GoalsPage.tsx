import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { ProjectProfile } from '../../shared/types';
import { goalsApi } from './api';
import { GoalCockpit } from './GoalCockpit';
import { GoalList, RefreshButton } from './GoalList';
import { NewGoal } from './NewGoal';
import { useLoad } from './useLoad';

/** The single integration point for the Goals area: `App.tsx` renders this and nothing else from the Goal UI. */
export function GoalsPage({
  projects = [],
  onOpenProjects,
}: {
  /** The registered projects the app already holds; Goal creation never discovers or registers one. */
  projects?: ProjectProfile[];
  onOpenProjects?: () => void;
} = {}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => goalsApi.list(), 'goals');
  return (
    <main className="page-content goals-page">
      <div className="page-heading">
        <div>
          <h1>Grand Projects</h1>
          <p>
            Long-running Goals that Turing advances in bounded cycles. You create, approve and revise
            definitions, and start, pause, resume and decide here; the server still checks every action and
            may refuse it.
          </p>
        </div>
        {selected === null && !creating && (
          <div className="page-actions">
            <button type="button" className="primary-button" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden="true" /> New Grand Project
            </button>
            <RefreshButton onClick={list.reload} />
          </div>
        )}
      </div>
      {creating ? (
        <NewGoal
          projects={projects}
          onCancel={() => setCreating(false)}
          onOpenProjects={onOpenProjects}
          onCreated={(goalId) => {
            setCreating(false);
            setSelected(goalId);
            list.reload();
          }}
        />
      ) : selected === null ? (
        <GoalList result={list.result} onRetry={list.reload} onSelect={setSelected} />
      ) : (
        <GoalCockpit
          goalId={selected}
          onBack={() => {
            setSelected(null);
            list.reload();
          }}
        />
      )}
    </main>
  );
}
