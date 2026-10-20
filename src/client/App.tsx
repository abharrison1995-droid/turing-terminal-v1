import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { notificationsForSnapshot } from './notificationEvents.js';
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
import { activeStatuses } from './pages/shared/runStatus';
import { DevicePairingPage } from './pages/DevicePairingPage';
import { ErrorState, Loading } from './pages/shared/parts';
import { CommandCenter } from './pages/CommandCenter';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunsPage } from './pages/RunsPage';
import { UsagePage } from './pages/UsagePage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';
import type { SettingsIntent } from './pages/shared/settingsIntent';
import { hasUnsavedWorkflowDrafts } from './pages/workflows/draftStore';
import { CommandPalette } from './ui/shell/CommandPalette';
import { ConnectionBanner } from './ui/shell/ConnectionBanner';
import { NavGuardDialog } from './ui/shell/NavGuardDialog';
import { Sidebar } from './ui/shell/Sidebar';
import { Topbar } from './ui/shell/Topbar';
import { buildPaletteCommands, type PaletteActions } from './ui/shell/commands';
import { NAV_PANEL_ID, pageTitle } from './ui/shell/navModel';
import { isErrorNotice, useNoticeTimeout } from './useNoticeTimeout';

/** The compact shell breakpoint in shell.css and mobile.css: below it the navigation is a drawer. */
const COMPACT_SHELL_QUERY = '(max-width: 680px)';

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
  const noticeHandlers = useNoticeTimeout(notice, () => setNotice(''));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteInvoker = useRef<HTMLElement | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
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
  const [queuedNav, setQueuedNav] = useState<{
    next: Page;
    then?: () => void;
    source: 'goals' | 'workflows';
  } | null>(null);
  // A request from another page to open part of Settings. It carries no workflow data; drafts stay in their own store.
  const [settingsRequest, setSettingsRequest] = useState<{ intent: SettingsIntent; signal: number } | null>(
    null,
  );
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
  // The drawer's Escape and scrim paths hand focus back to the hamburger. The hand-back runs after the commit, because
  // .app-main is inert while the drawer is open and focus() on an inert element does nothing.
  const returnFocusToMenu = useRef(false);
  const closeMenu = (returnFocus: boolean) => {
    returnFocusToMenu.current = returnFocus;
    setMobileMenuOpen(false);
  };
  useLayoutEffect(() => {
    if (mobileMenuOpen) {
      const sidebar = document.getElementById(NAV_PANEL_ID);
      (
        sidebar?.querySelector<HTMLElement>('.nav-link-active') ??
        sidebar?.querySelector<HTMLElement>('.nav-link')
      )?.focus();
      return;
    }
    if (!returnFocusToMenu.current) return;
    returnFocusToMenu.current = false;
    menuButton.current?.focus();
  }, [mobileMenuOpen]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The Grand Projects guard handles its own Escape; it must not also close the drawer behind it.
      if (event.key !== 'Escape' || event.defaultPrevented || queuedNav) return;
      event.preventDefault();
      returnFocusToMenu.current = true;
      setMobileMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen, queuedNav]);
  /**
   * Every shell navigation that can leave Goals goes through here. Destination side effects (`then`) run only once the
   * navigation is actually accepted, so cancelling leaves the app exactly where it was.
   */
  const navigate = (next: Page, then?: () => void) => {
    const source =
      page === 'goals' && next !== 'goals' && goalsUnsaved
        ? 'goals'
        : page === 'workflows' && next !== 'workflows' && hasUnsavedWorkflowDrafts()
          ? 'workflows'
          : null;
    if (source) {
      setQueuedNav({ next, source, ...(then ? { then } : {}) });
      return;
    }
    then?.();
    changePage(next);
  };
  /** Workflow drafts survive leaving, so a deliberate trip to Settings to finish a setup step needs no prompt. */
  const openSettings = (intent: SettingsIntent) => {
    setSettingsRequest((current) => ({ intent, signal: (current?.signal ?? 0) + 1 }));
    changePage('settings');
  };
  useEffect(() => {
    if (page !== 'settings') setSettingsRequest(null);
  }, [page]);
  const cancelNavigation = () => {
    navGuardCancelled.current = true;
    setQueuedNav(null);
  };
  const discardAndLeave = () => {
    if (!queuedNav) return;
    const { next, then, source } = queuedNav;
    setQueuedNav(null);
    if (source === 'goals') setGoalsUnsaved(false);
    focusNextPageHeading.current = true;
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
  /** Palette navigation, like every palette command, moves focus to the new page heading once the page really changes. */
  const paletteNavigate = (next: Page, then?: () => void) =>
    navigate(next, () => {
      then?.();
      if (next !== page) focusNextPageHeading.current = true;
    });
  const paletteActions: PaletteActions = {
    navigate: (next) =>
      paletteNavigate(next, next === 'command' || next === 'runs' ? () => setSelectedRunId(null) : undefined),
    openRun: (runId) => paletteNavigate('runs', () => setSelectedRunId(runId)),
    refresh: () => void refresh(true),
  };
  const openPalette = () => {
    const active = document.activeElement;
    paletteInvoker.current = active instanceof HTMLElement ? active : null;
    setMobileMenuOpen(false);
    setPaletteOpen(true);
  };
  const closePalette = () => {
    setPaletteOpen(false);
    paletteInvoker.current?.focus();
  };
  // A palette left open must not reappear after pairing; the pairing page replaces the shell entirely.
  useEffect(() => {
    if (requiresPairing) setPaletteOpen(false);
  }, [requiresPairing]);
  // The drawer exists only in the compact shell (shell.css, 680px). Widening the viewport closes it, so .app-main is
  // never left inert on a layout that shows no drawer.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const compact = window.matchMedia(COMPACT_SHELL_QUERY);
    const onChange = () => {
      if (!compact.matches) setMobileMenuOpen(false);
    };
    compact.addEventListener('change', onChange);
    return () => compact.removeEventListener('change', onChange);
  }, []);
  // Ctrl/Cmd+K toggles the palette. Not while the Grand Projects guard is open, nor while this device must be paired.
  useEffect(() => {
    if (requiresPairing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey || event.isComposing) return;
      if (paletteOpen) {
        event.preventDefault();
        closePalette();
        return;
      }
      if (queuedNav) return;
      event.preventDefault();
      openPalette();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requiresPairing, paletteOpen, queuedNav]);
  const pageLabel = pageTitle(page);
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
    <>
      <div className="app-shell" aria-hidden={paletteOpen || undefined}>
        {queuedNav && (
          <NavGuardDialog
            dialogRef={navGuard}
            onKeepEditing={cancelNavigation}
            onDiscard={discardAndLeave}
            {...(queuedNav.source === 'workflows'
              ? {
                  title: 'Leave Workflow Studio with unsaved changes?',
                  description:
                    'Your edits stay as a draft while this window is open, but they are not saved to the Desktop Master. Closing or reloading the app discards them.',
                  discardLabel: 'Leave and keep draft',
                  destructive: false,
                }
              : {})}
          />
        )}
        <Sidebar
          open={mobileMenuOpen}
          page={page}
          selectedRunId={selectedRunId}
          railTasks={railTasks}
          activeRunCount={activeRuns.length}
          pendingApprovalCount={snapshot?.approvals.length ?? 0}
          goalApprovalCount={approvalCounts.goal}
          machineName={snapshot?.machine.name}
          connection={error ? 'unavailable' : snapshot ? 'online' : 'connecting'}
          onNavigate={navigate}
          onSelectRun={setSelectedRunId}
        />

        {mobileMenuOpen && (
          <button className="mobile-scrim" aria-label="Close menu" onClick={() => closeMenu(true)} />
        )}

        <div className="app-main" inert={mobileMenuOpen}>
          <Topbar
            title={pageLabel}
            titleQuiet={titleQuiet}
            menuOpen={mobileMenuOpen}
            menuButtonRef={menuButton}
            connectionError={error !== ''}
            pendingApprovalCount={approvalCounts.total}
            onToggleMenu={() => setMobileMenuOpen((value) => !value)}
            onNotifications={() => navigate('runs')}
            onOpenPalette={openPalette}
          />

          {error && snapshot && (
            <ConnectionBanner
              message={error}
              onRetry={() => void refresh()}
              {...(isDesktopShell() ? { onRestart: () => void restartDesktopMaster() } : {})}
            />
          )}
          {notice && (
            <div
              className={`toast ${isErrorNotice(notice) ? 'toast-error' : ''}`}
              role="status"
              {...noticeHandlers}
            >
              <span className="toast-text">{notice}</span>
              <button onClick={() => setNotice('')} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )}

          {loading && !snapshot ? (
            <Loading />
          ) : !snapshot && error ? (
            <ErrorState
              message={error}
              onRetry={() => void refresh()}
              {...(isDesktopShell() ? { onRestart: () => void restartDesktopMaster() } : {})}
            />
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
                  onOpenSettings={openSettings}
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
                <SettingsPage
                  snapshot={snapshot}
                  onNotice={setNotice}
                  onChanged={() => void refresh(true)}
                  intent={settingsRequest?.intent}
                  intentSignal={settingsRequest?.signal}
                  onReturnToWorkflows={() => changePage('workflows')}
                />
              )}
            </>
          )}
        </div>
      </div>
      {paletteOpen && (
        <CommandPalette
          commands={buildPaletteCommands(railTasks)}
          actions={paletteActions}
          onClose={closePalette}
        />
      )}
    </>
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
