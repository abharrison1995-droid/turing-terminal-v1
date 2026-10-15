import {
  Check,
  CircleHelp,
  Clock3,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react';

export function Loading() {
  return (
    <main className="loading-state">
      <LoaderCircle size={22} className="spin" />
      <span>Connecting to the local master…</span>
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
