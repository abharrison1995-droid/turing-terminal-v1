import { AlertTriangle, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GoalStatus } from '../../shared/goals';
import type { Loaded } from './useLoad';
import { STATUS_TONE, humanize, type Tone } from './presentation';

/** The tone defaults to the stored status. A caller may pass a tone that the Goal's completion standing supports. */
export function GoalStatusPill({
  status,
  reason,
  tone,
}: {
  status: GoalStatus;
  reason?: string | null;
  tone?: Tone;
}) {
  return (
    <span
      className={`status-pill goal-tone goal-tone-${tone ?? STATUS_TONE[status]}`}
      data-goal-status={status}
    >
      {humanize(status)}
      {reason ? <span className="goal-pill-reason"> · {humanize(reason)}</span> : null}
    </span>
  );
}

/** Renders the loading / error / ready states of one read the same way everywhere in the Goal UI. */
export function Resource<T>({
  result,
  label,
  onRetry,
  children,
}: {
  result: Loaded<T>;
  label: string;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (result.state === 'loading')
    return (
      <div className="goal-state" role="status">
        <LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading {label}…
      </div>
    );
  if (result.state === 'error')
    return (
      <div className="form-error goal-state" role="alert">
        <AlertTriangle size={15} aria-hidden="true" />
        <span>
          {label} could not be loaded: {result.message}
        </span>
        <button
          type="button"
          className="secondary-button"
          aria-label={`Retry loading ${label}`}
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  return <>{children(result.data)}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="goal-empty">{children}</p>;
}

export function TruncationNote({ shown, total }: { shown: number; total: number }) {
  return shown < total ? (
    <p className="goal-empty">
      Showing {shown} of {total}.
    </p>
  ) : null;
}
