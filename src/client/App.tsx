import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Command,
  FileCode2,
  Menu,
  Monitor,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Target,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from 'lucide-react';
import { notificationsForSnapshot } from './notificationEvents.js';
import { APP_VERSION } from '../shared/version';
import type { DashboardSnapshot } from '../shared/types';
import { api } from './api';
import { pendingApprovalCounts } from './goals/dashboard';
import { GoalsPage } from './goals/GoalsPage';
import { cleanGoalNavigationUrl, parseGoalNavigationRequest } from './goals/deepLink';
import { desktop, isDesktopShell, masterApiUrl, setMasterApiBase } from './desktop';
import {
  addMachineProfile,
  importMachineProfilesFromLocation,
  machineSwitchUrl,
  readMachineProfiles,
  removeMachineProfile,
  upsertCurrentMachine,
  writeMachineProfiles,
  type MachineProfile,
} from './machineProfiles';
import type { Page } from './pages/shared/types';
import { activeStatuses, shortTask, humanStatus } from './pages/shared/runStatus';
import { DevicePairingPage } from './pages/DevicePairingPage';
import { StatusIcon, Loading } from './pages/shared/parts';
import { CommandCenter } from './pages/CommandCenter';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunsPage } from './pages/RunsPage';
import { UsagePage } from './pages/UsagePage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';

const navItems: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: 'workflows', label: 'Workflows', icon: WorkflowIcon },
  { id: 'projects', label: 'Projects', icon: FileCode2 },
  { id: 'goals', label: 'Grand Projects', icon: Target },
  { id: 'runs', label: 'Runs & history', icon: Activity },
  { id: 'usage', label: 'Usage', icon: Radio },
  { id: 'machines', label: 'Machines', icon: Monitor },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function App() {
  const [goalNavigation] = useState(() => parseGoalNavigationRequest(window.location.href));
  const [initialGoalId, setInitialGoalId] = useState(goalNavigation?.goalId ?? null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [machineProfiles, setMachineProfiles] = useState<MachineProfile[]>(readBrowserMachineProfiles);
  const [page, setPage] = useState<Page>(goalNavigation ? 'goals' : 'command');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requiresPairing, setRequiresPairing] = useState(false);
  const [notice, setNotice] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const priorSnapshot = useRef<DashboardSnapshot | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const data = await api.dashboard();
      setSnapshot(data);
      const profiles = upsertCurrentMachine(
        readBrowserMachineProfiles(),
        window.location.origin,
        data.machine,
      );
      writeBrowserMachineProfiles(profiles);
      setMachineProfiles(profiles);
      setError('');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The desktop master is unavailable.';
      if (message.includes('Pair this device') || message.includes('Tailscale Serve user identity')) {
        setRequiresPairing(true);
        setError('');
      } else setError(message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  const pairedSuccessfully = useCallback(() => {
    setRequiresPairing(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let profiles: MachineProfile[];
    try {
      profiles = importMachineProfilesFromLocation(window.location.href, window.localStorage, (url) =>
        window.history.replaceState({}, '', url),
      );
    } catch {
      profiles = readBrowserMachineProfiles();
    }
    setMachineProfiles(profiles);
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 6_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!goalNavigation) return;
    window.history.replaceState(window.history.state, '', cleanGoalNavigationUrl(window.location.href));
  }, [goalNavigation]);

  useEffect(() => {
    const events = notificationsForSnapshot(priorSnapshot.current, snapshot);
    priorSnapshot.current = snapshot;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const event of events) {
      new Notification(event.title, { body: event.body, tag: event.key, silent: true });
    }
  }, [snapshot]);

  useEffect(() => {
    if (!selectedRunId) return;
    const events = new EventSource(masterApiUrl(`/api/events?runId=${encodeURIComponent(selectedRunId)}`));
    const refreshOnRunEvent = () => void refresh(true);
    const notifyFromStage = (event: Event) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          title?: string;
          message?: string;
        };
        new Notification(payload.title ?? 'Turing workflow notice', {
          body: payload.message ?? 'A workflow notification stage was reached.',
          tag: `workflow-notice:${selectedRunId}`,
          silent: true,
        });
      } catch {
        /* Ignore malformed server-sent notification events. */
      }
    };
    for (const name of [
      'run_updated',
      'stage_started',
      'stage_completed',
      'stage_failed',
      'stage_log',
      'approval_requested',
      'run_completed',
      'run_failed',
      'run_cancelled',
      'user_intervention',
    ]) {
      events.addEventListener(name, refreshOnRunEvent);
    }
    events.addEventListener('notification_requested', notifyFromStage);
    return () => events.close();
  }, [selectedRunId, refresh]);

  const changePage = (next: Page) => {
    setPage(next);
    setMobileMenuOpen(false);
  };
  // Unsaved Goal definition work (a boolean reported by the Goals page; the text never leaves it).
  const [goalsUnsaved, setGoalsUnsaved] = useState(false);
  const [queuedNav, setQueuedNav] = useState<{ next: Page; then?: () => void } | null>(null);
  const navGuardId = useId();
  const navGuard = useRef<HTMLDivElement>(null);
  const navGuardTrigger = useRef<HTMLElement | null>(null);
  const navGuardCancelled = useRef(false);
  const focusNextPageHeading = useRef(false);
  useLayoutEffect(() => {
    if (!queuedNav) return;
    navGuardCancelled.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !navGuard.current?.contains(active)) {
      navGuardTrigger.current = active;
    }
    navGuard.current?.querySelector<HTMLElement>('[data-confirm-safe]')?.focus();
    return () => {
      if (navGuardCancelled.current && navGuardTrigger.current?.isConnected) navGuardTrigger.current.focus();
    };
  }, [queuedNav]);
  useLayoutEffect(() => {
    if (!focusNextPageHeading.current) return;
    const heading = document.querySelector<HTMLElement>('.app-main h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
    focusNextPageHeading.current = false;
  }, [page]);
  /**
   * Every shell navigation that can leave Goals goes through here. Destination side effects (`then`) run only once the
   * navigation is actually accepted, so cancelling leaves the app exactly where it was.
   */
  const navigate = (next: Page, then?: () => void) => {
    if (page === 'goals' && next !== 'goals' && goalsUnsaved) {
      setQueuedNav({ next, ...(then ? { then } : {}) });
      return;
    }
    then?.();
    changePage(next);
  };
  const restartDesktopMaster = async () => {
    try {
      const runtime = await desktop.restartMaster();
      setMasterApiBase(runtime.masterUrl);
      setError('');
      void refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Turing Terminal Master could not be restarted.');
    }
  };
  const pageLabel =
    page === 'command' ? 'New task' : (navItems.find((item) => item.id === page)?.label ?? '');
  const approvalCounts = pendingApprovalCounts(snapshot);
  const activeRuns = snapshot?.runs.filter((run) => activeStatuses.has(run.status)) ?? [];
  const selectedRun = snapshot?.runs.find((run) => run.id === selectedRunId) ?? null;
  const titleQuiet =
    ['workflows', 'projects', 'goals', 'usage', 'machines', 'settings'].includes(page) ||
    (page === 'runs' && !selectedRun);
  const railTasks = (snapshot?.runs ?? [])
    .slice()
    .sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      return rightActive - leftActive || right.createdAt.localeCompare(left.createdAt);
    })
    .slice(0, 14);

  if (requiresPairing) return <DevicePairingPage onPaired={pairedSuccessfully} />;

  return (
    <div className="app-shell">
      {queuedNav && (
        <div className="nav-guard-backdrop">
          <div
            ref={navGuard}
            className="goal-confirm nav-guard"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${navGuardId}-title`}
            aria-describedby={`${navGuardId}-description`}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                navGuardCancelled.current = true;
                setQueuedNav(null);
                return;
              }
              if (event.key !== 'Tab') return;
              const focusable = navGuard.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
              if (!focusable?.length) return;
              const first = focusable[0]!;
              const last = focusable[focusable.length - 1]!;
              const focusIsInside = navGuard.current?.contains(document.activeElement) ?? false;
              if (!focusIsInside) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
              } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <h2 id={`${navGuardId}-title`}>Discard unsaved Grand Project changes?</h2>
            <p id={`${navGuardId}-description`}>
              You have definition text that has not been saved. Leaving Grand Projects will discard those
              local changes.
            </p>
            <div className="goal-control-buttons">
              <button
                type="button"
                className="secondary-button"
                data-confirm-safe
                onClick={() => {
                  navGuardCancelled.current = true;
                  setQueuedNav(null);
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="secondary-button goal-danger"
                onClick={() => {
                  const { next, then } = queuedNav;
                  setQueuedNav(null);
                  setGoalsUnsaved(false);
                  focusNextPageHeading.current = true;
                  then?.();
                  changePage(next);
                }}
              >
                Discard and leave
              </button>
            </div>
          </div>
        </div>
      )}
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`} aria-label="Primary navigation">
        <button
          className="brand-lockup"
          onClick={() => navigate('command', () => setSelectedRunId(null))}
          aria-label="Turing Terminal home"
        >
          <span className="brand-mark">
            <Command size={16} />
          </span>
          <span className="brand-name">Turing Terminal</span>
        </button>
        <button className="new-task-button" onClick={() => navigate('command', () => setSelectedRunId(null))}>
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
                onClick={() => navigate('runs', () => setSelectedRunId(run.id))}
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
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-link ${page === id ? 'nav-link-active' : ''}`}
              onClick={() => navigate(id, id === 'runs' ? () => setSelectedRunId(null) : undefined)}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon size={16} /> <span>{label}</span>
              {id === 'runs' && activeRuns.length > 0 && (
                <span className="nav-count">{activeRuns.length}</span>
              )}
              {id === 'runs' && snapshot && snapshot.approvals.length > 0 && (
                <span
                  className="nav-alert-dot"
                  aria-label={`${snapshot.approvals.length} approvals pending`}
                />
              )}
              {id === 'goals' && approvalCounts.goal > 0 && (
                <span
                  className="nav-alert-dot"
                  aria-label={`${approvalCounts.goal} Goal approvals pending`}
                />
              )}
            </button>
          ))}
        </nav>
        <div className="machine-rail">
          <span className="presence-dot" />
          <span className="machine-rail-copy">
            <strong>{snapshot?.machine.name ?? 'Desktop master'}</strong>
            <small>Online · v{APP_VERSION}</small>
          </span>
        </div>
      </aside>

      {mobileMenuOpen && (
        <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)} />
      )}

      <div className="app-main">
        <header className="topbar">
          <button
            className="mobile-menu-button icon-button"
            onClick={() => setMobileMenuOpen((value) => !value)}
            aria-label="Open navigation"
          >
            <Menu size={19} />
          </button>
          <p className={`topbar-title ${titleQuiet ? 'topbar-title-quiet' : ''}`}>{pageLabel}</p>
          <div className="topbar-right">
            <span className={`connection-state ${error ? 'connection-state-error' : ''}`}>
              <span className="presence-dot" />{' '}
              {error ? 'Desktop Master unavailable' : 'Desktop Master online'}
            </span>
            <button
              className="icon-button notification-button"
              aria-label={
                approvalCounts.total ? `${approvalCounts.total} pending approvals` : 'Notifications'
              }
              onClick={() => navigate('runs')}
            >
              <Bell size={17} />
              {approvalCounts.total > 0 && <i />}
            </button>
          </div>
        </header>

        {error && (
          <div className="global-error" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button onClick={() => void refresh()}>
              <RefreshCw size={14} /> Retry
            </button>
            {isDesktopShell() && (
              <button onClick={() => void restartDesktopMaster()}>
                <RefreshCw size={14} /> Restart Master
              </button>
            )}
          </div>
        )}
        {notice && (
          <div
            className={`toast ${notice.toLowerCase().includes('could not') || notice.toLowerCase().includes('before') || notice.toLowerCase().includes('not available') ? 'toast-error' : ''}`}
            role="status"
          >
            {notice}
            <button onClick={() => setNotice('')} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {loading && !snapshot ? (
          <Loading />
        ) : (
          <>
            {page === 'command' && snapshot && (
              <CommandCenter
                snapshot={snapshot}
                onRefresh={() => refresh(true)}
                onNavigate={changePage}
                onStart={(id) => {
                  setSelectedRunId(id);
                  setPage('runs');
                }}
                onNotice={setNotice}
              />
            )}
            {page === 'workflows' && snapshot && (
              <WorkflowsPage
                workflows={snapshot.workflows}
                providers={snapshot.providers}
                onSaved={() => void refresh(true)}
                onNotice={setNotice}
              />
            )}
            {page === 'projects' && snapshot && (
              <ProjectsPage
                projects={snapshot.projects}
                onChanged={() => void refresh(true)}
                onNotice={setNotice}
              />
            )}
            {page === 'goals' && (
              <GoalsPage
                projects={snapshot?.projects ?? []}
                initialGoalId={initialGoalId}
                onInitialGoalConsumed={() => setInitialGoalId(null)}
                onOpenProjects={() => navigate('projects')}
                onUnsavedChange={setGoalsUnsaved}
                navigationGuardActive={queuedNav !== null}
              />
            )}
            {page === 'runs' && snapshot && (
              <RunsPage
                snapshot={snapshot}
                selectedRun={selectedRun}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                onRefresh={() => refresh(true)}
                onNotice={setNotice}
                onNavigate={changePage}
              />
            )}
            {page === 'usage' && snapshot && <UsagePage snapshot={snapshot} />}
            {page === 'machines' && snapshot && (
              <MachinesPage
                snapshot={snapshot}
                profiles={machineProfiles}
                onAddProfile={(origin, name) => {
                  const updated = addMachineProfile(machineProfiles, { origin, name });
                  if (!updated) {
                    setNotice('Enter a machine name and a valid HTTPS or local loopback address.');
                    return false;
                  }
                  writeBrowserMachineProfiles(updated);
                  setMachineProfiles(updated);
                  setNotice('Machine profile saved on this device. Pair with that master separately.');
                  return true;
                }}
                onRemoveProfile={(origin) => {
                  const updated = removeMachineProfile(machineProfiles, origin);
                  writeBrowserMachineProfiles(updated);
                  setMachineProfiles(updated);
                }}
                onReachability={(origin, reachability) => {
                  setMachineProfiles((current) => {
                    const updated = current.map((profile) =>
                      profile.origin === origin
                        ? {
                            ...profile,
                            reachability,
                            lastSeenAt:
                              reachability === 'online' ? new Date().toISOString() : profile.lastSeenAt,
                          }
                        : profile,
                    );
                    writeBrowserMachineProfiles(updated);
                    return updated;
                  });
                }}
                onSelectProfile={(profile) => {
                  if (profile.origin === window.location.origin) return;
                  window.location.assign(machineSwitchUrl(profile, machineProfiles));
                }}
              />
            )}
            {page === 'settings' && snapshot && (
              <SettingsPage snapshot={snapshot} onNotice={setNotice} onChanged={() => void refresh(true)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function readBrowserMachineProfiles(): MachineProfile[] {
  try {
    return readMachineProfiles(window.localStorage);
  } catch {
    return [];
  }
}

function writeBrowserMachineProfiles(profiles: MachineProfile[]): void {
  try {
    writeMachineProfiles(window.localStorage, profiles);
  } catch {
    // The current selected machine remains usable when browser storage is unavailable.
  }
}

export default App;
