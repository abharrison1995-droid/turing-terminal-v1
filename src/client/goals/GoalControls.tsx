import { useState } from 'react';
import type { GoalDetail } from '../../shared/goalApi';
import { goalsApi } from './api';
import { availableControls, type GoalControl } from './controls';
import { refusalText, toRefusal, type Refusal } from './refusal';

/**
 * The Goal lifecycle controls. Each button performs exactly one POST and nothing else: there is no optimistic status
 * change, no chained follow-up, and the result (success or refusal) only triggers a read refresh via `onChanged`.
 */
export function GoalControls({ goal, onChanged }: { goal: GoalDetail; onChanged: () => void }) {
  const controls = availableControls(goal);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  // A message describes the state it was produced in; once the server reports a different state it would mislead.
  const stateKey = `${goal.status}|${goal.reasonCode ?? ''}|${goal.nextAction.kind}`;
  const [shownFor, setShownFor] = useState(stateKey);
  if (shownFor !== stateKey) {
    setShownFor(stateKey);
    setRefusal(null);
    setDone(null);
    setConfirmingAbandon(false);
  }

  async function run(label: string, request: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    setDone(null);
    try {
      await request();
      setDone(`${label}: done. Showing the refreshed state.`);
    } catch (error) {
      setRefusal(toRefusal(error));
    } finally {
      setBusy(false);
      setConfirmingAbandon(false);
      // A read refresh only, after success or refusal alike, so what is shown is what the server now holds.
      onChanged();
    }
  }

  const perform = (control: GoalControl) => {
    switch (control.id) {
      case 'start':
        return run(control.label, () => goalsApi.start(goal.id));
      case 'resume':
        return run(control.label, () => goalsApi.resume(goal.id, control.reason));
      case 'pause':
        return run(control.label, () => goalsApi.pause(goal.id));
      case 'abandon':
        setConfirmingAbandon(true);
        return undefined;
    }
  };

  if (controls.length === 0 && !refusal && !done) return null;
  return (
    <section className="goal-controls" aria-label="Goal controls">
      {controls.length > 0 && (
        <div className="goal-control-buttons">
          {controls.map((control) => (
            <button
              key={`${control.id}-${control.id === 'resume' ? control.reason : ''}`}
              type="button"
              className={control.id === 'abandon' ? 'secondary-button goal-danger' : 'primary-button'}
              disabled={busy}
              data-control={control.id}
              {...(control.id === 'resume' ? { 'data-resume-reason': control.reason } : {})}
              onClick={() => void perform(control)}
            >
              {control.label}
            </button>
          ))}
        </div>
      )}
      {controls.map((control) =>
        'hint' in control ? (
          <p key={`hint-${control.id}`} className="goal-note">
            {control.label}: {control.hint}
          </p>
        ) : null,
      )}
      {confirmingAbandon && (
        <div className="goal-confirm" role="alertdialog" aria-label="Confirm abandon">
          <strong>Abandon this Goal?</strong>
          <p>
            The Goal stops and cannot be resumed. Its history stays recorded. Nothing is applied to your
            branch.
          </p>
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button goal-danger"
              disabled={busy}
              onClick={() => void run('Abandon', () => goalsApi.abandon(goal.id))}
            >
              Abandon Goal
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setConfirmingAbandon(false)}
            >
              Keep Goal
            </button>
          </div>
        </div>
      )}
      {busy && (
        <p className="goal-note" role="status">
          Working…
        </p>
      )}
      {refusal && (
        <p className="form-error" role="alert" data-refusal-code={refusal.code ?? ''}>
          Not done: {refusalText(refusal)}
          {refusal.approvalId
            ? ` — approval ${refusal.approvalId.slice(0, 8)} is waiting for your decision.`
            : ''}
        </p>
      )}
      {done && !refusal && (
        <p className="goal-note" role="status">
          {done}
        </p>
      )}
    </section>
  );
}
