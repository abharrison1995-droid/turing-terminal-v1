import type { GoalDetail, GoalResumeReason } from '../../shared/goalApi';

/**
 * Which user controls the cockpit offers. This is the only place that turns the server's advice (`nextAction`) plus the
 * persisted status into an offered control, and it is an explicit table, never a generic "do the next action". Offering
 * a control is not proof it will succeed: every request is re-proved by the server and may be refused.
 */
export type GoalControl =
  | { id: 'start'; label: string }
  | { id: 'resume'; label: string; reason: GoalResumeReason; hint: string }
  | { id: 'pause'; label: string; hint: string }
  | { id: 'abandon'; label: string };

/** Statuses the accepted backend can abandon from (there is no running/reviewing -> abandoned edge). */
const ABANDONABLE = new Set(['draft', 'ready', 'needs_user', 'blocked', 'paused']);

export function availableControls(
  goal: Pick<GoalDetail, 'status' | 'reasonCode' | 'nextAction'>,
): GoalControl[] {
  const action = goal.nextAction;
  // Fail closed: no progression, repair or abandon control while the state could not be proved.
  if (action.kind === 'manual_reconciliation') return [];
  const controls: GoalControl[] = [];

  if (action.kind === 'start') controls.push({ id: 'start', label: 'Start Goal' });

  switch (action.kind) {
    case 'resume':
      if (goal.status === 'paused')
        controls.push({
          id: 'resume',
          label: 'Resume Goal',
          reason: 'user_resume',
          hint: 'Preflight runs again; the server may refuse.',
        });
      else if (goal.status === 'needs_user' && goal.reasonCode === 'gate_pending')
        controls.push({
          id: 'resume',
          label: 'Resume after gate',
          reason: 'gate_resolved',
          hint: 'The server re-proves that exact gate is resolved.',
        });
      break;
    case 'resume_run':
      controls.push({
        id: 'resume',
        label: 'Resume interrupted run',
        reason: 'run_resumed',
        hint: 'The Goal resumes its own interrupted run; no other run is chosen.',
      });
      break;
    case 'resolve_blocker':
      if (goal.status === 'blocked')
        controls.push({
          id: 'resume',
          label: 'Retry after resolving blocker',
          reason: 'blocker_resolved',
          hint: 'This does not repair anything itself; preflight runs again and may refuse.',
        });
      break;
    default:
      break;
  }

  if (goal.status === 'running')
    controls.push({
      id: 'pause',
      label: 'Pause Goal',
      hint: 'Stops the supervisor from advancing. Work already running is not cancelled.',
    });
  if (ABANDONABLE.has(goal.status)) controls.push({ id: 'abandon', label: 'Abandon Goal' });
  return controls;
}

/**
 * Whether Goal gates and findings may be decided from the Goal's own screens: not for a finished Goal, and never while
 * the server advises manual reconciliation. The server enforces the same rules; this only avoids offering a dead end.
 */
export const goalAcceptsDecisions = (goal: Pick<GoalDetail, 'status' | 'nextAction'>): boolean =>
  goal.status !== 'completed' &&
  goal.status !== 'abandoned' &&
  goal.nextAction.kind !== 'manual_reconciliation';
