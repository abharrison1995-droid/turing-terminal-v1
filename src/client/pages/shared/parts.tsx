import {
  AlertTriangle,
  Check,
  CircleHelp,
  Clock3,
  LoaderCircle,
  LockKeyhole,
  Pause,
  RefreshCw,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react';

/** Shown in the main landmark while the first dashboard request is pending. The status region sits inside it. */
export function Loading() {
  return (
    <main className="page-content">
      <div className="loading-state" role="status" aria-live="polite">
        <LoaderCircle size={22} className="spin" aria-hidden="true" />
        <span>Connecting to the local master…</span>
      </div>
    </main>
  );
}

export interface ErrorStateProps {
  message: string;
  onRetry: () => void;
  /** Passed only in the desktop shell, where restarting the bundled master is a real recovery action. */
  onRestart?: () => void;
}

/**
 * First-load failure in the main landmark: there is no snapshot to show, so the page is replaced by this alert. The
 * title is the page's h1, so the shell's heading focus can reach it.
 */
export function ErrorState({ message, onRetry, onRestart }: ErrorStateProps) {
  return (
    <main className="page-content">
      <div className="error-state" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <h1>Could not load the workspace</h1>
        <p>{message}</p>
        <div className="error-state-actions">
          <button type="button" className="secondary-button" onClick={() => onRetry()}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </button>
          {onRestart && (
            <button type="button" className="secondary-button" onClick={() => onRestart()}>
              <RefreshCw size={14} aria-hidden="true" /> Restart Master
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Meta({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <div className="metadata-item">
      <dt>
        <Icon size={14} aria-hidden="true" />
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state">
      <span>
        <Icon size={20} />
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action && (
        <button type="button" className="secondary-button empty-state-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function StatusIcon({ status }: { status: string }) {
  if (status === 'completed' || status === 'passed' || status === 'approved') return <Check size={14} />;
  if (status === 'failed' || status === 'denied') return <X size={14} />;
  if (status === 'cancelled') return <Square size={12} />;
  if (status === 'running') return <LoaderCircle size={14} className="spin" />;
  if (status === 'waiting_for_approval') return <LockKeyhole size={13} />;
  if (status === 'waiting_for_user') return <CircleHelp size={13} />;
  if (status === 'paused') return <Pause size={13} />;
  if (status === 'paused_limit_reached') return <Clock3 size={13} />;
  return <Clock3 size={13} />;
}
