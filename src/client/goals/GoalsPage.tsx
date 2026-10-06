import { useState } from 'react';
import { goalsApi } from './api';
import { GoalCockpit } from './GoalCockpit';
import { GoalList, RefreshButton } from './GoalList';
import { useLoad } from './useLoad';

/** The single integration point for the Goals area: `App.tsx` renders this and nothing else from the Goal UI. */
export function GoalsPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useLoad(() => goalsApi.list(), 'goals');
  return (
    <main className="page-content goals-page">
      <div className="page-heading">
        <div>
          <h1>Grand Projects</h1>
          <p>
            Long-running Goals that Turing advances in bounded cycles. This view is read-only; every decision
            is still proved by the server.
          </p>
        </div>
        {selected === null && (
          <div className="page-actions">
            <RefreshButton onClick={list.reload} />
          </div>
        )}
      </div>
      {selected === null ? (
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
