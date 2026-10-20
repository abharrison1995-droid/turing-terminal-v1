import { Plus } from 'lucide-react';
import type { RunSummary } from '../../../shared/types';
import { APP_VERSION } from '../../../shared/version';
import type { Page } from '../../pages/shared/types';
import { StatusIcon } from '../../pages/shared/parts';
import { humanStatus, shortTask } from '../../pages/shared/runStatus';
import { NAV_ITEMS, NAV_PANEL_ID } from './navModel';
import { BrandSkull } from './BrandSkull';

/** What the machine rail reports: the real refresh state, never a fixed "Online". */
export type MasterConnection = 'online' | 'unavailable' | 'connecting';

const CONNECTION_LABEL: Record<MasterConnection, string> = {
  online: 'Online',
  unavailable: 'Unavailable',
  connecting: 'Connecting',
};

export interface SidebarProps {
  open: boolean;
  page: Page;
  selectedRunId: string | null;
  railTasks: RunSummary[];
  activeRunCount: number;
  pendingApprovalCount: number;
  goalApprovalCount: number;
  machineName: string | undefined;
  connection: MasterConnection;
  /** Every navigation goes through App's guarded navigate, so the Grand Projects guard applies to all paths. */
  onNavigate: (next: Page, then?: () => void) => void;
  onSelectRun: (runId: string | null) => void;
}

export function Sidebar({
  open,
  page,
  selectedRunId,
  railTasks,
  activeRunCount,
  pendingApprovalCount,
  goalApprovalCount,
  machineName,
  connection,
  onNavigate,
  onSelectRun,
}: SidebarProps) {
  return (
    <aside
      id={NAV_PANEL_ID}
      className={`sidebar ${open ? 'sidebar-open' : ''}`}
      aria-label="Primary navigation"
    >
      <button
        className="brand-lockup"
        onClick={() => onNavigate('command', () => onSelectRun(null))}
        aria-label="Turing Terminal home"
      >
        <span className="brand-mark">
          <BrandSkull />
        </span>
        <span className="brand-name">Turing Terminal</span>
      </button>
      <button className="new-task-button" onClick={() => onNavigate('command', () => onSelectRun(null))}>
        <Plus size={16} /> New task
      </button>
      <p className="nav-label">Recent</p>
      <nav className="task-nav" aria-label="Tasks">
        {railTasks.length === 0 ? (
          <p className="task-nav-empty">Tasks you start appear here, newest first.</p>
        ) : (
          railTasks.map((run) => (
            <button
              key={run.id}
              className={`task-link ${page === 'runs' && selectedRunId === run.id ? 'task-link-active' : ''}`}
              onClick={() => onNavigate('runs', () => onSelectRun(run.id))}
              aria-current={page === 'runs' && selectedRunId === run.id ? 'page' : undefined}
            >
              <span className={`run-status-glyph run-glyph-${run.status}`}>
                <StatusIcon status={run.status} />
              </span>
              <span className="task-link-copy">
                <strong>{shortTask(run.prompt)}</strong>
                <small>
                  {humanStatus(run.status)} · {run.projectName}
                </small>
              </span>
            </button>
          ))
        )}
      </nav>
      <nav className="primary-nav" aria-label="Workspace">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-link ${page === id ? 'nav-link-active' : ''}`}
            onClick={() => onNavigate(id, id === 'runs' ? () => onSelectRun(null) : undefined)}
            aria-current={page === id ? 'page' : undefined}
          >
            <Icon size={16} /> <span>{label}</span>
            {id === 'runs' && activeRunCount > 0 && <span className="nav-count">{activeRunCount}</span>}
            {id === 'runs' && pendingApprovalCount > 0 && (
              <span className="nav-alert-dot" aria-label={`${pendingApprovalCount} approvals pending`} />
            )}
            {id === 'goals' && goalApprovalCount > 0 && (
              <span className="nav-alert-dot" aria-label={`${goalApprovalCount} Goal approvals pending`} />
            )}
          </button>
        ))}
      </nav>
      <div className={`machine-rail ${connection === 'unavailable' ? 'machine-rail-unavailable' : ''}`}>
        <span className="presence-dot" />
        <span className="machine-rail-copy">
          <strong>{machineName ?? 'Desktop master'}</strong>
          <small>
            {CONNECTION_LABEL[connection]} · v{APP_VERSION}
          </small>
        </span>
      </div>
    </aside>
  );
}
