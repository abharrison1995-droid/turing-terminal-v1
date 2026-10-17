import { useState } from 'react';
import type { GoalDetail } from '../../shared/goalApi';
import { goalsApi } from './api';
import { availableControls, type GoalControl } from './controls';
import { ConfirmPanel } from './DefinitionParts';
import { refusalText, toRefusal, type Refusal } from './refusal';

/**
 * The Goal lifecycle controls. Each button performs exactly one POST and nothing else: there is no optimistic status
 * change, no chained follow-up, and the result (success or refusal) only triggers a read refresh via `onChanged`.
 */
export function GoalControls({
  goal,
  onChanged,
  compact = false,
}: {
  goal: GoalDetail;
  onChanged: () => void;
  /** The phone cockpit reuses the same proven controls but offers only pause and explicit resume reasons. */
  compact?: boolean;
}) {
  const offered = availableControls(goal);
  const controls = compact
    ? offered.filter((control) => control.id === 'pause' || control.id === 'resume')
    : offered;
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
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
    setBusyLabel(label);
    setRefusal(null);
    setDone(null);
    try {
      await request();
      setDone(`${label}: done. Showing the refreshed state.`);
    } catch (error) {
      setRefusal(toRefusal(error));
    } finally {
      setBusy(false);
      setBusyLabel(null);
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
    <section className="goal-controls" aria-label="Goal controls" aria-busy={busy}>
      {controls.length > 0 && (
        <div className="goal-control-buttons">
          {controls.map((control) => (
            <button
              key={`${control.id}-${control.id === 'resume' ? control.reason : ''}`}
              type="button"
              className={control.id === 'abandon' ? 'secondary-button goal-danger' : 'primary-button'}
              disabled={busy}
              aria-busy={busyLabel === control.label}
              data-control={control.id}
              {...(control.id === 'resume' ? { 'data-resume-reason': control.reason } : {})}
              onClick={() => void perform(control)}
            >
              {busyLabel === control.label ? `${control.label}…` : control.label}
            </button>
          ))}
        </div>
      )}
      {controls.map((control) =>
        'hint' in control ? (
          <p
            key={`hint-${control.id}${control.id === 'resume' ? `-${control.reason}` : ''}`}
            className="goal-note"
          >
            {control.label}: {control.hint}
          </p>
        ) : null,
      )}
      {confirmingAbandon && !compact && (
        <ConfirmPanel
          label="Confirm abandon"
          title="Abandon this Goal?"
          description="The Goal stops and cannot be resumed. Its history stays recorded. Nothing is applied to your branch."
          onCancel={() => setConfirmingAbandon(false)}
          busy={busy}
        >
          <div className="goal-control-buttons">
            <button
              type="button"
              className="secondary-button"
              data-confirm-safe
              disabled={busy}
              onClick={() => setConfirmingAbandon(false)}
            >
              Keep Goal
            </button>
            <button
              type="button"
              className="secondary-button goal-danger"
              disabled={busy}
              aria-busy={busyLabel === 'Abandon'}
              onClick={() => void run('Abandon', () => goalsApi.abandon(goal.id))}
            >
              {busyLabel === 'Abandon' ? 'Abandoning…' : 'Abandon Goal'}
            </button>
          </div>
        </ConfirmPanel>
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
