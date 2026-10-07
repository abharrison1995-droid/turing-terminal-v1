import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Cpu,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  HardDrive,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Mic,
  MoreHorizontal,
  Monitor,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Scale,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Target,
  Shield,
  Smartphone,
  Sparkles,
  Square,
  StopCircle,
  TerminalSquare,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import QRCode from 'qrcode';
import { notificationsForSnapshot } from './notificationEvents.js';
import { APP_VERSION } from '../shared/version';
import type {
  ConnectionProfile,
  DashboardSnapshot,
  ExecutionOperation,
  ExecutionProfile,
  GitOperation,
  PermissionMode,
  ProjectProfile,
  ProviderStatus,
  RunPreview,
  RunSummary,
  ModelConfiguration,
  ModelPreset,
  StageKind,
  WorkflowCondition,
  WorkflowConditionPath,
  TuringRule,
  WorkflowDefinition,
  WorkflowStage,
} from '../shared/types';
import { api } from './api';
import { approvalSignature, pendingApprovalCounts } from './goals/dashboard';
import { GoalsPage } from './goals/GoalsPage';
import { UnifiedApprovals } from './goals/UnifiedApprovals';
import {
  billingLaneLabel,
  billingLanesForBackend,
  billingModeLabel,
  inferBillingLane as inferClientBillingLane,
} from '../shared/billing';
import { pruneModelSettings, classifyModelIdentity } from '../shared/modelSettings';
import {
  BillingSafetyFields,
  DecisionGateEditor,
  DecisionResultsPanel,
  MeteredBudgetSettingsPanel,
  ModelSettingsFields,
  ModelStatusLine,
  OpenRouterSettings,
  OrchestratorBranchesEditor,
  RoutingSummaryPanel,
  UsageExplorer,
  decisionAssignmentLine,
  defaultDecisionConfig,
} from './phase36';
import { desktop, isDesktopShell, masterApiUrl, setMasterApiBase, type DesktopRuntime } from './desktop';
import { makePairingQrUrl, parsePairingRequestId } from './pairingQr.js';
import { decodeVapidPublicKey, pushSubscriptionStorageKey } from './pushNotifications.js';
import {
  addMachineProfile,
  importMachineProfilesFromLocation,
  machineSwitchUrl,
  probeMachine,
  readMachineProfiles,
  removeMachineProfile,
  upsertCurrentMachine,
  writeMachineProfiles,
  type MachineProfile,
} from './machineProfiles';

type Page = 'command' | 'workflows' | 'projects' | 'goals' | 'runs' | 'usage' | 'machines' | 'settings';

const navItems: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: 'workflows', label: 'Workflows', icon: WorkflowIcon },
  { id: 'projects', label: 'Projects', icon: FileCode2 },
  { id: 'goals', label: 'Grand Projects', icon: Target },
  { id: 'runs', label: 'Runs & history', icon: Activity },
  { id: 'usage', label: 'Usage', icon: Radio },
  { id: 'machines', label: 'Machines', icon: Monitor },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const activeStatuses = new Set([
  'queued',
  'preparing',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'retrying',
  'cancelling',
]);
const waitingStatuses = new Set(['waiting_for_approval', 'waiting_for_user']);
const quotaProviderOptions = [
  { id: 'anthropic-subscription', name: 'Claude subscription' },
  { id: 'openai-codex', name: 'OpenAI Codex subscription' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'cline-pass', name: 'ClinePass' },
];
const stageLabels: Record<StageKind, string> = {
  planner: 'Planner',
  promptRefinement: 'Prompt refinement',
  implementer: 'Implementer',
  build: 'Build',
  test: 'Test',
  reviewer: 'Reviewer',
  parallelReview: 'Parallel review',
  consolidate: 'Consolidation',
  orchestrator: 'AI Orchestrator',
  remediation: 'Remediation',
  finalGate: 'Final gate',
  gitCheckpoint: 'Git checkpoint',
  gitCommit: 'Git commit',
  gitPush: 'Git push',
  gitMerge: 'Git merge',
  gitRollback: 'Git rollback / restore',
  conditionalBranch: 'Conditional branch',
  shellCommand: 'Shell command',
  notification: 'Notification',
  humanApproval: 'Human approval',
  decisionGate: 'Decision Gate',
};

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [machineProfiles, setMachineProfiles] = useState<MachineProfile[]>(readBrowserMachineProfiles);
  const [page, setPage] = useState<Page>('command');
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
            className="goal-confirm nav-guard"
            role="alertdialog"
            aria-label="Confirm leave Grand Projects"
          >
            <strong>Discard unsaved Grand Project changes?</strong>
            <p>
              You have definition text that has not been saved. Leaving Grand Projects will discard those
              local changes.
            </p>
            <div className="goal-control-buttons">
              <button
                type="button"
                className="secondary-button goal-danger"
                onClick={() => {
                  const { next, then } = queuedNav;
                  setQueuedNav(null);
                  setGoalsUnsaved(false);
                  then?.();
                  changePage(next);
                }}
              >
                Discard and leave
              </button>
              <button type="button" className="secondary-button" onClick={() => setQueuedNav(null)}>
                Keep editing
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
                onOpenProjects={() => navigate('projects')}
                onUnsavedChange={setGoalsUnsaved}
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

function DevicePairingPage({ onPaired }: { onPaired: () => void }) {
  const [deviceName, setDeviceName] = useState('My phone');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [qrRequestId] = useState(() => parsePairingRequestId(window.location.href));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!qrRequestId) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('pairRequest');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [qrRequestId]);

  useEffect(() => {
    if (!requestId || !code) return;
    let live = true;
    const check = async () => {
      try {
        const result = await api.completePairing(requestId, qrRequestId ? undefined : code);
        if (!live || !('deviceId' in result)) return;
        onPaired();
      } catch (reason) {
        if (!live) return;
        const message = reason instanceof Error ? reason.message : 'Pairing status could not be checked.';
        setError(message);
        if (message.toLowerCase().includes('expired') || message.toLowerCase().includes('already completed'))
          setRequestId('');
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [requestId, code, qrRequestId, onPaired]);

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const result = qrRequestId
        ? await api.claimPairingRequest(qrRequestId, deviceName.trim())
        : await api.claimPairing(code.trim().toUpperCase(), deviceName.trim());
      setRequestId(result.requestId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The pairing code could not be used.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pairing-page">
      <section className="pairing-panel surface-panel">
        <span className="pairing-mark">
          <Smartphone size={22} />
        </span>
        <p className="eyebrow">TURING TERMINAL · DEVICE PAIRING</p>
        <h1>Connect this device</h1>
        <p className="pairing-description">
          Open this page through the desktop’s Tailscale Serve address. Scan its short-lived QR or enter the
          fallback code. The desktop owner must approve this device before it can view runs.
        </p>
        <label className="form-field">
          <span>Device name</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} />
        </label>
        {qrRequestId ? (
          <div className="inline-callout">
            QR pairing request detected. The desktop owner must approve this phone.
          </div>
        ) : (
          <label className="form-field">
            <span>Pairing code</span>
            <input
              value={code}
              onChange={(event) =>
                setCode(
                  event.target.value
                    .toUpperCase()
                    .replace(/[^A-F0-9]/g, '')
                    .slice(0, 16),
                )
              }
              autoCapitalize="characters"
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={16}
              placeholder="16-character code"
              disabled={Boolean(requestId)}
            />
          </label>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {requestId ? (
          <div className="pairing-waiting" role="status">
            <LoaderCircle size={16} className="spin" /> Waiting for desktop approval…
          </div>
        ) : (
          <button
            className="primary-button pairing-submit"
            onClick={() => void claim()}
            disabled={busy || (!qrRequestId && code.length !== 16) || !deviceName.trim()}
          >
            {busy ? 'Requesting approval…' : 'Request approval'}
          </button>
        )}
        <small className="pairing-expiry-note">
          Pairing codes expire after five minutes. Provider credentials remain on the desktop.
        </small>
      </section>
    </main>
  );
}

function Loading() {
  return (
    <main className="loading-state">
      <LoaderCircle size={22} className="spin" />
      <span>Connecting to the local master…</span>
    </main>
  );
}

function PageHeading({
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

function CommandCenter({
  snapshot,
  onRefresh,
  onNavigate,
  onStart,
  onNotice,
}: {
  snapshot: DashboardSnapshot;
  onRefresh: () => void;
  onNavigate: (page: Page) => void;
  onStart: (id: string) => void;
  onNotice: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.id ?? '');
  const [workflowId, setWorkflowId] = useState(
    snapshot.workflows.find((workflow) => workflow.id === 'standard-dev-loop')?.id ??
      snapshot.workflows[0]?.id ??
      '',
  );
  const [task, setTask] = useState('');
  const [profile, setProfile] = useState<ExecutionProfile>('balanced');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('normal');
  const [billingMode, setBillingMode] = useState<WorkflowDefinition['billingMode']>('subscriptions-only');
  const [lockProviders, setLockProviders] = useState(true);
  const [refinePrompt, setRefinePrompt] = useState(
    snapshot.workflows.find((workflow) => workflow.id === workflowId)?.promptRefinementDefault ?? false,
  );
  const [enigmaConfirmed, setEnigmaConfirmed] = useState(false);
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  useEffect(() => {
    if (!snapshot.projects.some((project) => project.id === projectId))
      setProjectId(snapshot.projects[0]?.id ?? '');
    if (!snapshot.workflows.some((workflow) => workflow.id === workflowId))
      setWorkflowId(snapshot.workflows[0]?.id ?? '');
  }, [snapshot.projects, snapshot.workflows, projectId, workflowId]);

  const selectedProject = snapshot.projects.find((project) => project.id === projectId);
  const selectedWorkflow = snapshot.workflows.find((workflow) => workflow.id === workflowId);
  useEffect(() => {
    if (!selectedWorkflow) return;
    setBillingMode(
      selectedWorkflow.billingMode ?? (selectedWorkflow.subscriptionOnly ? 'subscriptions-only' : 'custom'),
    );
    setLockProviders(selectedWorkflow.lockProviders);
  }, [selectedWorkflow?.id, selectedWorkflow?.version, selectedWorkflow?.updatedAt]);
  const missingAssignments =
    selectedWorkflow?.stages.filter(
      (stage) =>
        stage.enabled !== false &&
        isAiStage(stage.kind) &&
        !(
          (stage.backendId ??
            selectedWorkflow?.stageDefaults?.[stage.kind]?.backendId ??
            selectedWorkflow?.defaultModelConfiguration?.backendId) &&
          (stage.providerId ??
            selectedWorkflow?.stageDefaults?.[stage.kind]?.providerId ??
            selectedWorkflow?.defaultModelConfiguration?.providerId) &&
          (stage.modelId ??
            selectedWorkflow?.stageDefaults?.[stage.kind]?.modelId ??
            selectedWorkflow?.defaultModelConfiguration?.modelId)
        ),
    ) ?? [];

  const reviewBlockedReason = busy
    ? null
    : !selectedProject
      ? 'Add a project to continue.'
      : !workflowId
        ? 'Choose a workflow to continue.'
        : !task.trim()
          ? 'Describe the task to continue.'
          : null;
  const makePreview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task.trim() || !projectId || !workflowId) return;
    setBusy(true);
    try {
      const response = await api.previewRun({
        task,
        projectId,
        workflowId,
        profile,
        permissionMode,
        enigmaConfirmed,
        refinePrompt,
        billingMode,
        lockProviders,
      });
      setPreview(response.preview);
      onNotice('Run preview is ready. Check its project, stages, and Git strategy before starting.');
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Could not prepare the run preview.');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!preview?.canStart) return;
    setBusy(true);
    try {
      const response = await api.startRun({
        task,
        projectId,
        workflowId,
        profile,
        permissionMode,
        enigmaConfirmed,
        refinePrompt,
        billingMode,
        lockProviders,
      });
      setPreview(null);
      onNotice('Run accepted by the desktop master.');
      onStart(response.run.id);
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'The desktop master did not accept this run.');
    } finally {
      setBusy(false);
    }
  };

  const beginVoice = () => {
    type Recognition = {
      lang: string;
      interimResults: boolean;
      onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    type SpeechApiWindow = Window & {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const apiWindow = window as SpeechApiWindow;
    const SpeechRecognition = apiWindow.SpeechRecognition ?? apiWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      onNotice('Voice input is not available in this browser. You can still type the task.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) setTask((current) => `${current}${current ? ' ' : ''}${transcript}`);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      onNotice('Voice transcription stopped. Your task has not been submitted.');
    };
    setListening(true);
    recognition.start();
  };

  const pending = snapshot.runs.filter((run) => activeStatuses.has(run.status));
  const waitingRuns = pending.filter((run) => waitingStatuses.has(run.status));
  const runningRuns = pending.filter((run) => !waitingStatuses.has(run.status));
  const recentFailed = snapshot.runs
    .filter(
      (run) => run.status === 'failed' && Date.now() - new Date(run.createdAt).getTime() < 7 * 86_400_000,
    )
    .slice(0, 3);
  const recentFinished = snapshot.runs
    .filter((run) => !activeStatuses.has(run.status) && !recentFailed.includes(run))
    .slice(0, 5);
  const agentStages = (selectedWorkflow?.stages ?? [])
    .filter((stage) => stage.enabled !== false && isAiStage(stage.kind))
    .map((stage) => {
      const config = {
        ...selectedWorkflow?.defaultModelConfiguration,
        ...selectedWorkflow?.stageDefaults?.[stage.kind],
        ...stage,
      };
      return { stage, config, ready: Boolean(config.backendId && config.providerId && config.modelId) };
    });
  const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl ↵';

  const blockers = (
    <>
      {(missingAssignments.length > 0 || !selectedProject) && (
        <div className="launch-blockers" role="group" aria-labelledby="launch-blockers-title">
          <h3 id="launch-blockers-title">Before you can run</h3>
          <ul>
            {missingAssignments.length > 0 && (
              <li>
                <CircleHelp size={16} />
                <div>
                  <strong>Set up the stage models first</strong>
                  <p>
                    {missingAssignments.length} active AI{' '}
                    {missingAssignments.length === 1 ? 'stage needs' : 'stages need'} a backend, provider, and
                    model.
                  </p>
                </div>
                <button type="button" className="text-button" onClick={() => onNavigate('workflows')}>
                  Configure workflow <ChevronRight size={14} />
                </button>
              </li>
            )}
            {!selectedProject && (
              <li>
                <FileCode2 size={16} />
                <div>
                  <strong>No project registered</strong>
                  <p>Add a local repository before creating a run.</p>
                </div>
                <button type="button" className="text-button" onClick={() => onNavigate('projects')}>
                  Add project <ChevronRight size={14} />
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </>
  );

  return (
    <main className="page-content command-page">
      <div className={`home-column ${snapshot.runs.length > 0 ? 'home-has-activity' : ''}`}>
        {pendingApprovalCounts(snapshot).total > 0 && (
          <UnifiedApprovals
            heading="Approval required"
            refresh={approvalSignature(snapshot)}
            onDecided={onRefresh}
          />
        )}
        {(runningRuns.length > 0 || waitingRuns.length > 0 || recentFailed.length > 0) && (
          <div className="glance" role="group" aria-label="Runs at a glance">
            {waitingRuns.length > 0 && (
              <button
                type="button"
                className="glance-item glance-attention"
                onClick={() => onStart(waitingRuns[0].id)}
              >
                <LockKeyhole size={14} aria-hidden="true" />
                <strong>{waitingRuns.length}</strong> needs you
              </button>
            )}
            {runningRuns.length > 0 && (
              <button
                type="button"
                className="glance-item glance-running"
                onClick={() => onStart(runningRuns[0].id)}
              >
                <Activity size={14} aria-hidden="true" />
                <strong>{runningRuns.length}</strong> running
              </button>
            )}
            {recentFailed.length > 0 && (
              <button
                type="button"
                className="glance-item glance-failed"
                onClick={() => onStart(recentFailed[0].id)}
              >
                <AlertTriangle size={14} aria-hidden="true" />
                <strong>{recentFailed.length}</strong> failed
              </button>
            )}
          </div>
        )}
        <div className="home-intro">
          <h1>What should the agents do?</h1>
          <p>Your task stays on this machine and follows its saved workflow.</p>
        </div>
        {preview && <RunPreviewPanel preview={preview} />}
        {blockers}
        <form className="composer" onSubmit={makePreview} aria-label="Start a workflow">
          <label className="sr-only" htmlFor="task-input">
            What should the agents do?
          </label>
          <textarea
            id="task-input"
            rows={3}
            maxLength={12_000}
            placeholder="Describe the change, the behavior you expect, and any constraints…"
            value={task}
            onChange={(event) => {
              setTask(event.target.value);
              setPreview(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !preview) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {agentStages.length > 0 && (
            <div className="composer-agents" role="group" aria-label="Agents in this workflow">
              {agentStages.slice(0, 5).map(({ stage, config, ready }) => (
                <button
                  type="button"
                  key={stage.id}
                  className={`agent-chip ${ready ? '' : 'agent-chip-missing'}`}
                  title="Edit in Workflow Studio"
                  onClick={() => onNavigate('workflows')}
                >
                  <b>{stage.label}</b>
                  <code>{ready ? (config.modelDisplayName ?? config.modelId) : 'Choose model'}</code>
                </button>
              ))}
              {agentStages.length > 5 && <span className="agent-chip">+{agentStages.length - 5} more</span>}
            </div>
          )}
          <div className="composer-bar">
            <label className="pill-select">
              <FileCode2 size={15} aria-hidden="true" />
              <span className="sr-only">Project</span>
              <select
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setPreview(null);
                }}
                disabled={!snapshot.projects.length}
              >
                {snapshot.projects.length === 0 ? (
                  <option value="">Add a project first</option>
                ) : (
                  snapshot.projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="pill-select">
              <WorkflowIcon size={15} aria-hidden="true" />
              <span className="sr-only">Workflow</span>
              <select
                value={workflowId}
                onChange={(event) => {
                  setWorkflowId(event.target.value);
                  setRefinePrompt(
                    snapshot.workflows.find((workflow) => workflow.id === event.target.value)
                      ?.promptRefinementDefault ?? false,
                  );
                  setPreview(null);
                }}
                disabled={!snapshot.workflows.length}
              >
                {snapshot.workflows.map((workflow) => (
                  <option value={workflow.id} key={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="pill-button"
              aria-expanded={optionsOpen}
              aria-controls="composer-options"
              onClick={() => setOptionsOpen((value) => !value)}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              Options
            </button>
            <span className="composer-spacer" />
            {task.length >= 8_000 && (
              <span className="char-count">{task.length.toLocaleString()} / 12,000</span>
            )}
            <button
              className={`voice-button ${listening ? 'voice-live' : ''}`}
              type="button"
              onClick={beginVoice}
              aria-pressed={listening}
              aria-label={listening ? 'Listening…' : 'Voice input'}
            >
              <Mic size={17} />
            </button>
            {preview ? (
              <>
                <button type="button" className="secondary-button" onClick={() => setPreview(null)}>
                  Edit request
                </button>
                <button
                  type="button"
                  className="primary-button start-button"
                  onClick={() => void start()}
                  disabled={!preview.canStart || busy || (permissionMode === 'enigma' && !enigmaConfirmed)}
                >
                  <Play size={15} fill="currentColor" />
                  {busy ? 'Starting…' : 'Start workflow'}
                </button>
              </>
            ) : (
              <button
                type="submit"
                className="run-button"
                aria-label={busy ? 'Preparing preview…' : 'Review run preview'}
                title={`Review run preview (${shortcutLabel})`}
                aria-busy={busy}
                disabled={busy || !task.trim() || !projectId || !workflowId}
                aria-describedby={reviewBlockedReason ? 'launch-hint' : undefined}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} />}
                Run
                <kbd aria-hidden="true">{shortcutLabel}</kbd>
              </button>
            )}
          </div>
          {optionsOpen && (
            <div className="composer-options" id="composer-options">
              {agentStages.length > 0 && (
                <div className="options-agents">
                  <span className="field-label">Agents in “{selectedWorkflow?.name}”</span>
                  <div className="agent-list">
                    {agentStages.map(({ stage, config, ready }) => (
                      <div className={`agent-row ${ready ? '' : 'agent-row-missing'}`} key={stage.id}>
                        <span>{stage.label}</span>
                        <code>
                          {ready
                            ? `${config.backendId} · ${config.providerId}/${config.modelId}`
                            : 'Provider and model required'}
                        </code>
                        <small>{config.reasoning ? `reasoning ${config.reasoning}` : ''}</small>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="text-button" onClick={() => onNavigate('workflows')}>
                    Edit in Workflow Studio <ChevronRight size={14} />
                  </button>
                </div>
              )}
              <div className="form-grid-two">
                <label className="form-field">
                  <span>Execution profile</span>
                  <select
                    value={profile}
                    onChange={(event) => {
                      setProfile(event.target.value as ExecutionProfile);
                      setPreview(null);
                    }}
                  >
                    <option value="economy">Economy · one reviewer per parallel review</option>
                    <option value="balanced">Balanced · up to two reviewers</option>
                    <option value="maximum">Maximum · configured reviewer count</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>Permission mode</span>
                  <select
                    value={permissionMode}
                    onChange={(event) => {
                      setPermissionMode(event.target.value as PermissionMode);
                      setEnigmaConfirmed(false);
                      setPreview(null);
                    }}
                  >
                    <option value="normal">Normal · routine broker actions auto-approve</option>
                    <option value="supervised">Supervised · approve consequential operations</option>
                    <option value="yolo">YOLO · autonomous project work</option>
                    <option value="enigma">ENIGMA · maximum configured autonomy</option>
                  </select>
                </label>
              </div>
              <label className="toggle-line prompt-refinement-toggle">
                <input
                  type="checkbox"
                  checked={refinePrompt}
                  disabled={
                    !selectedWorkflow?.stages.some(
                      (stage) => stage.kind === 'promptRefinement' && stage.enabled !== false,
                    )
                  }
                  onChange={(event) => {
                    setRefinePrompt(event.target.checked);
                    setPreview(null);
                  }}
                />
                <span>
                  <strong>Refine and confirm the task before execution</strong>
                  <small>
                    Workflow default: {selectedWorkflow?.promptRefinementDefault ? 'On' : 'Off'}. Review the
                    draft and answer real ambiguities before approving the run.
                  </small>
                </span>
              </label>
              <label className="form-field">
                <span>Billing mode for this run</span>
                <select
                  value={billingMode}
                  onChange={(event) => {
                    setBillingMode(event.target.value as WorkflowDefinition['billingMode']);
                    setPreview(null);
                  }}
                >
                  <option value="subscriptions-only">Subscriptions Only — no metered spending</option>
                  <option value="subscriptions-plus-decision-budget">Subscriptions + Decision Budget</option>
                  <option value="custom">Custom metered lanes</option>
                </select>
                <small>
                  Workflow default: {billingModeLabel(selectedWorkflow?.billingMode ?? 'subscriptions-only')}.
                  Provider-side PAYG fallback cannot be verified by Turing.
                </small>
              </label>
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={lockProviders}
                  onChange={(event) => {
                    setLockProviders(event.target.checked);
                    setPreview(null);
                  }}
                />
                <span>
                  <strong>Lock configured providers and models</strong>
                  <small>
                    Failures pause at the configured stage; Turing does not substitute a model or reasoning
                    setting.
                  </small>
                </span>
              </label>
              {permissionMode === 'enigma' && (
                <label className="inline-callout enigma-confirmation">
                  <input
                    type="checkbox"
                    checked={enigmaConfirmed}
                    onChange={(event) => {
                      setEnigmaConfirmed(event.target.checked);
                      setPreview(null);
                    }}
                  />
                  <div>
                    <strong>Activate ENIGMA for this run</strong>
                    <p>
                      Supported brokered project edits and deletes may proceed without approval. Secret access
                      and out-of-project paths stay blocked; network, destructive commands, Git pushes,
                      merges, and rollbacks remain approval-gated.
                    </p>
                  </div>
                </label>
              )}
            </div>
          )}
        </form>
        {reviewBlockedReason && !preview && (
          <p id="launch-hint" className="composer-hint">
            {reviewBlockedReason}
          </p>
        )}

        <div className="home-status" aria-label="Workspace status">
          <span>
            <span className="presence-dot" /> {snapshot.machine.name} · online
          </span>
          <span>
            {snapshot.projects.length} {snapshot.projects.length === 1 ? 'project' : 'projects'}
          </span>
          <span>{pending.length} active</span>
          <span>{snapshot.usage.events} events today</span>
          <button type="button" className="text-button" onClick={() => onNavigate('machines')}>
            Machines
          </button>
          <button type="button" className="text-button" onClick={() => onNavigate('usage')}>
            Usage
          </button>
        </div>
        <details className="home-providers">
          <summary>
            Provider health · {snapshot.providers.filter((provider) => provider.detected).length} of{' '}
            {snapshot.providers.length} local CLIs detected
          </summary>
          <ProviderHealth providers={snapshot.providers} onNavigate={() => onNavigate('settings')} />
        </details>

        <div className="home-tasks">
          <RunGroup title="Needs you" tone="attention" runs={waitingRuns} onSelect={onStart} />
          <RunGroup title="Running" runs={runningRuns} onSelect={onStart} />
          <RunGroup title="Failed" tone="failed" runs={recentFailed} onSelect={onStart} />
          <RunGroup
            title="Recent"
            runs={recentFinished}
            onSelect={onStart}
            action={{ label: 'History', onClick: () => onNavigate('runs') }}
            emptyText={
              snapshot.runs.length === 0 ? 'No runs yet. Your task history will appear here.' : undefined
            }
          />
        </div>
      </div>
    </main>
  );
}

function RunPreviewPanel({ preview }: { preview: RunPreview }) {
  const plan = preview.workflow.stages.filter((stage) => stage.enabled !== false);
  return (
    <section className="run-preview-panel surface-panel" aria-label="Run preview">
      <div className="preview-heading">
        <div>
          <span className="preview-label">
            <CheckCircle2 size={15} /> RUN PREVIEW
          </span>
          <h2>Ready to hand off</h2>
        </div>
        <span className={`status-pill ${preview.canStart ? 'status-ready' : 'status-waiting_for_user'}`}>
          {preview.canStart ? 'Ready to start' : 'Needs setup'}
        </span>
      </div>
      <div className="preview-summary">
        <div>
          <span>Task</span>
          <strong>{preview.task}</strong>
        </div>
        <div>
          <span>Machine</span>
          <strong>{preview.machine.name}</strong>
        </div>
        <div>
          <span>Project</span>
          <strong>{preview.project.name}</strong>
          <small>{preview.project.path}</small>
        </div>
        <div>
          <span>Workflow</span>
          <strong>{preview.workflow.name}</strong>
          <small>
            {capitalize(preview.profile)} depth · {capitalize(preview.permissionMode)} permissions
          </small>
        </div>
        <div>
          <span>Git strategy</span>
          <strong>
            {preview.branchStrategy === 'worktree' ? 'Create isolated worktree' : 'Use project working tree'}
          </strong>
          <small>
            {preview.project.branch ?? 'No current branch detected'}
            {preview.project.dirty ? ' · uncommitted changes' : ''}
          </small>
        </div>
        <div>
          <span>Prompt refinement</span>
          <strong>{preview.refinePrompt ? 'On · confirmation required' : 'Off'}</strong>
          <small>
            {preview.refinePrompt
              ? 'The workflow pauses until you accept the refined task.'
              : 'The configured workflow starts directly.'}
          </small>
        </div>
      </div>
      <div className="stage-plan">
        <div className="stage-plan-head">
          <span>STAGE SEQUENCE</span>
          <span>{preview.expectedAiStages} configured AI stages</span>
        </div>
        <div className="stage-chips">
          {plan.map((stage, index) => (
            <span className="stage-chip" key={stage.id}>
              <i>{index + 1}</i>
              <span>
                {stage.label}
                <small>
                  {stage.timeoutMinutes ? `${stage.timeoutMinutes} min timeout` : 'run limit'} ·{' '}
                  {stage.retryPolicy?.maxRetries ?? preview.workflow.retryPolicy.maxRetries} retries
                </small>
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="preview-bounds">
        <span>
          <strong>Billing mode</strong>{' '}
          {billingModeLabel(
            preview.billingMode ?? (preview.subscriptionOnly ? 'subscriptions-only' : 'custom'),
          )}
        </span>
        <span>
          <strong>Provider lock</strong> {preview.lockProviders ? 'On · exact configured routes' : 'Off'}
        </span>
        <span>
          <strong>Run limit</strong> {preview.workflow.maxDurationMinutes} minutes
        </span>
        <span>
          <strong>Transient retries</strong> up to {preview.workflow.retryPolicy.maxRetries} · starts at{' '}
          {preview.workflow.retryPolicy.initialDelayMs} ms, capped at{' '}
          {preview.workflow.retryPolicy.maxDelayMs} ms
        </span>
        <span>
          <strong>Remediation</strong> up to {preview.workflow.maxRemediationRounds} rounds
        </span>
        <span>
          <strong>Parallelism</strong> up to {preview.workflow.maxParallelAgents} agents
        </span>
        <span>
          <strong>Approval gates</strong>{' '}
          {
            plan.filter((stage) =>
              ['humanApproval', 'gitPush', 'gitMerge', 'gitRollback'].includes(stage.kind),
            ).length
          }
        </span>
        <span>
          <strong>Target</strong> {preview.machine.name} · {preview.project.name} ·{' '}
          {preview.branchStrategy === 'worktree' ? 'isolated worktree' : 'project working tree'}
        </span>
      </div>
      <RoutingSummaryPanel preview={preview} />
      <RuleListDetails rules={preview.effectiveRules} title="Effective run rules" />
      {preview.providerAssignments.length > 0 && (
        <div className="assignment-summary">
          {preview.providerAssignments.map((item) => (
            <div key={`${item.stage}-${item.backendId}`}>
              <span className={item.ready ? 'assignment-dot-ready' : 'assignment-dot-error'} />
              {item.stage}
              <strong>
                {item.decision
                  ? `Decision Gate · ${item.modelId ?? 'Deterministic Rules'}${item.connectionProfileName ? ` · ${item.connectionProfileName}` : ''}`
                  : item.ready
                    ? `${item.backendId} · ${item.providerId}/${item.modelId}${item.variantId ? ` · variant ${item.variantId}` : ''}${item.connectionProfileName ? ` · ${item.connectionProfileName}` : ''}`
                    : 'Needs provider/model setup'}
              </strong>
              {item.decision && (
                <small className="assignment-native-config">{decisionAssignmentLine(item)}</small>
              )}
              {item.billingAllowed === false && (
                <small className="assignment-native-config">BLOCKED · {item.billingReason}</small>
              )}
              {item.ready && (
                <small className="assignment-native-config">
                  {item.workload === 'deterministic'
                    ? 'decision-gate · local deterministic rules · no provider, no billing lane'
                    : `${item.role ? `${item.role} · ` : ''}${billingLaneLabel(item.billingLane ?? 'unknown')}${item.catalogStatus ? ` · ${item.catalogStatus.toUpperCase().replace('-', ' ')}` : ''} · ${(item.identity ?? classifyModelIdentity(item.backendId ?? undefined, item.modelId ?? undefined)) === 'floating' ? 'FLOATING / ROUTED' : 'PINNED'}`}
                  {item.reasoning ? ` · provider reasoning ${item.reasoning}` : ''}
                  {item.nativeSettings && Object.keys(item.nativeSettings).length
                    ? ` · ${Object.entries(item.nativeSettings)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(', ')}`
                    : ''}
                </small>
              )}
              <small>
                {item.context.label} · ESTIMATED initial input ~
                {item.context.estimatedInputTokens.toLocaleString()} tokens · configured limit{' '}
                {item.context.maxEstimatedTokens.toLocaleString()}
              </small>
            </div>
          ))}
        </div>
      )}
      {preview.warnings.length > 0 && (
        <ul className="preview-warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>
              <AlertTriangle size={14} />
              {warning}
            </li>
          ))}
        </ul>
      )}
      <p className="preview-footnote">
        <Shield size={14} /> Credentials remain in desktop-side storage and are never sent to this device.
        Turing never falls back to API, PAYG, or OpenRouter billing on its own; provider-side PAYG fallback is
        shown as unknown because no supported check can verify it. Token figures are ESTIMATED.
      </p>
    </section>
  );
}

function ProviderHealth({ providers, onNavigate }: { providers: ProviderStatus[]; onNavigate: () => void }) {
  const connected = providers.filter((provider) => provider.detected).length;
  return (
    <section className="surface-panel provider-panel">
      <div className="section-title-row">
        <div>
          <h2>Provider health</h2>
          <p>
            {connected} of {providers.length} local CLIs detected
          </p>
        </div>
        <button className="icon-button small-icon" aria-label="Provider settings" onClick={onNavigate}>
          <Settings size={15} />
        </button>
      </div>
      <div className="provider-list">
        {providers.map((provider) => (
          <div className="provider-row" key={provider.id}>
            <span className={`provider-mark provider-mark-${provider.id}`}>
              {provider.id === 'opencode'
                ? 'O'
                : provider.id === 'claude-code'
                  ? 'C'
                  : provider.id === 'codex-cli'
                    ? 'Cx'
                    : 'Cl'}
            </span>
            <div className="provider-copy">
              <strong>{provider.name}</strong>
              <span>
                {provider.detected ? (provider.version ?? provider.authMechanism) : 'CLI not detected'}
              </span>
            </div>
            <span
              className={`mini-status ${provider.detected ? (provider.authentication === 'connected' ? 'mini-status-connected' : 'mini-status-unknown') : 'mini-status-missing'}`}
            >
              {!provider.detected
                ? 'Missing'
                : provider.authentication === 'connected'
                  ? 'Available'
                  : 'Check auth'}
            </span>
          </div>
        ))}
      </div>
      <button className="quiet-button full-width" onClick={onNavigate}>
        Provider settings <ChevronRight size={14} />
      </button>
    </section>
  );
}

function RunGroup({
  title,
  runs,
  onSelect,
  tone,
  action,
  emptyText,
}: {
  title: string;
  runs: RunSummary[];
  onSelect: (id: string) => void;
  tone?: 'attention' | 'failed';
  action?: { label: string; onClick: () => void };
  emptyText?: string;
}) {
  if (runs.length === 0 && !emptyText) return null;
  return (
    <section
      className={`active-runs-block ${tone ? `attention-block attention-block-${tone}` : ''}`}
      aria-label={title}
    >
      <div className="activity-head">
        <h2>{title}</h2>
        {action && (
          <button className="text-button" onClick={action.onClick}>
            {action.label} <ChevronRight size={14} />
          </button>
        )}
      </div>
      {runs.length ? (
        <div className="compact-run-list">
          {runs.map((run) => (
            <RunListRow key={run.id} run={run} onSelect={() => onSelect(run.id)} />
          ))}
        </div>
      ) : (
        <div className="empty-inline">
          <Clock3 size={16} />
          <span>{emptyText}</span>
        </div>
      )}
    </section>
  );
}

function RunListRow({ run, onSelect }: { run: RunSummary; onSelect: () => void }) {
  const stage =
    run.stages.find((item) => item.status === 'running') ??
    run.stages.find((item) => item.status === 'failed');
  const loud = run.status === 'failed' || waitingStatuses.has(run.status);
  return (
    <button className="run-list-row" onClick={onSelect}>
      <span className={`run-status-glyph run-glyph-${run.status}`}>
        <StatusIcon status={run.status} />
      </span>
      <span className="run-row-main">
        <strong>{shortTask(run.prompt)}</strong>
        <span>
          {run.projectName} <i>·</i> {stage ? stage.title : run.workflowName}
        </span>
      </span>
      {loud ? (
        <span className={`status-pill status-${run.status}`}>{humanStatus(run.status)}</span>
      ) : (
        <span className="run-row-time">{rowTime(run)}</span>
      )}
      <ChevronRight size={15} className="row-chevron" />
    </button>
  );
}

function WorkflowsPage({
  workflows,
  providers: discoveredProviders,
  onSaved,
  onNotice,
}: {
  workflows: WorkflowDefinition[];
  providers: ProviderStatus[];
  onSaved: () => void;
  onNotice: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(workflows[0]?.id ?? '');
  const [refreshedProviders, setRefreshedProviders] = useState<ProviderStatus[] | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const providers = refreshedProviders ?? discoveredProviders;
  const refreshModels = async () => {
    setRefreshingModels(true);
    try {
      setRefreshedProviders((await api.refreshProviders()).providers);
      onNotice('Model catalogs refreshed. Unreachable catalogs show their LAST KNOWN entries.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Models could not be refreshed.');
    } finally {
      setRefreshingModels(false);
    }
  };
  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0];
  const [draft, setDraft] = useState<WorkflowDefinition | null>(selected ?? null);
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState('');
  const [connectionProfiles, setConnectionProfiles] = useState<ConnectionProfile[]>([]);
  const [modelPresets, setModelPresets] = useState<ModelPreset[]>([]);
  const [profileName, setProfileName] = useState('');
  const [profileBackend, setProfileBackend] = useState('opencode');
  const [profileProvider, setProfileProvider] = useState('opencode-go');
  const [profileLane, setProfileLane] =
    useState<ConnectionProfile['billingLane']>('opencode-go-subscription');
  const [openSections, setOpenSections] = useState<Record<StudioSectionId, boolean>>(() => {
    const narrow =
      typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 680px)').matches);
    return { basics: true, safety: !narrow, agents: true, context: !narrow, generation: !narrow };
  });
  const [activeSection, setActiveSection] = useState<StudioSectionId>('basics');

  useEffect(() => {
    void Promise.all([api.connectionProfiles(), api.modelPresets()])
      .then(([connections, presets]) => {
        setConnectionProfiles(connections.profiles);
        setModelPresets(presets.presets);
      })
      .catch((error) =>
        onNotice(error instanceof Error ? error.message : 'Configuration catalog could not be loaded.'),
      );
  }, []);

  useEffect(() => {
    if (!workflows.some((workflow) => workflow.id === selectedId)) setSelectedId(workflows[0]?.id ?? '');
  }, [workflows, selectedId]);
  useEffect(() => {
    setDraft(selected ?? null);
    setValidationMessage('');
  }, [selectedId, selected?.version, selected?.updatedAt]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
        if (first) setActiveSection(first.target.id.replace('studio-', '') as StudioSectionId);
      },
      { rootMargin: '-80px 0px -60% 0px' },
    );
    for (const id of ['basics', 'safety', 'agents', 'context', 'generation']) {
      const element = document.getElementById(`studio-${id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [draft?.id]);
  if (!draft)
    return (
      <main className="page-content">
        <PageHeading
          title="Workflows"
          description="Compose bounded agent stages and save role assignments."
        />
        <EmptyState
          icon={WorkflowIcon}
          title="No workflows yet"
          body="The default workflow templates will be created when the local master starts."
        />
      </main>
    );

  const changeWorkflow = (patch: Partial<WorkflowDefinition>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const changeStage = (id: string, patch: Partial<WorkflowStage>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            stages: current.stages.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)),
          }
        : current,
    );
  const reorder = (id: string, targetId: string) =>
    setDraft((current) => {
      if (!current || id === targetId) return current;
      const next = [...current.stages];
      const from = next.findIndex((stage) => stage.id === id);
      const to = next.findIndex((stage) => stage.id === targetId);
      if (from < 0 || to < 0) return current;
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { ...current, stages: next };
    });
  const save = async () => {
    setBusy(true);
    setValidationMessage('');
    try {
      const result = await api.saveWorkflow(draft);
      setDraft(result.workflow);
      setSelectedId(result.workflow.id);
      onSaved();
      onNotice(`“${result.workflow.name}” saved as version ${result.workflow.version}.`);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : 'Workflow could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const duplicate = async () => {
    try {
      const result = await api.duplicateWorkflow(draft.id);
      onSaved();
      setSelectedId(result.workflow.id);
      setDraft(result.workflow);
      onNotice('Workflow duplicated.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Workflow could not be duplicated.');
    }
  };
  const saveConnection = async () => {
    try {
      const response = await api.saveConnectionProfile({
        name: profileName.trim(),
        backendId: profileBackend,
        providerId: profileProvider.trim(),
        billingLane: profileLane,
        credentialStoreRef: null,
        metadata: {},
      });
      setConnectionProfiles((current) => [...current, response.profile]);
      setProfileName('');
      onNotice(
        'Connection profile saved. Credentials remain managed by the provider CLI or desktop credential store.',
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Connection profile could not be saved.');
    }
  };
  const savePreset = async (name: string, configuration: ModelConfiguration) => {
    const response = await api.createModelPreset(name, configuration);
    setModelPresets((current) => [...current, response.preset]);
    onNotice(`Model preset “${name}” saved without credentials.`);
  };
  const promoteStageToDefault = (stageId: string, kind: StageKind, configuration: ModelConfiguration) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        stageDefaults: { ...current.stageDefaults, [kind]: configuration },
        stages: current.stages.map((item) => {
          if (item.id !== stageId) return item;
          const inherited = { ...item };
          for (const key of [
            'backendId',
            'connectionProfileId',
            'providerId',
            'billingLane',
            'modelId',
            'modelDisplayName',
            'variantId',
            'nativeSettings',
            'reasoning',
            'modelSnapshot',
          ])
            delete (inherited as Record<string, unknown>)[key];
          return inherited;
        }),
      };
    });
  };
  const addStage = () => {
    const kind: StageKind = 'reviewer';
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    changeWorkflow({
      stages: [...draft.stages, { id, label: 'Review', kind, role: 'reviewer', enabled: true }],
    });
  };
  const exportJson = () => {
    const content = JSON.stringify(api.exportWorkflows([draft]), null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${draft.id}.workflow.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as {
        workflows?: WorkflowDefinition[];
        workflow?: WorkflowDefinition;
      };
      const workflow = parsed.workflows?.[0] ?? parsed.workflow;
      if (!workflow?.name || !Array.isArray(workflow.stages))
        throw new Error('The selected file does not contain a workflow definition.');
      const remapConnection = <T extends { connectionProfileId?: string }>(
        configuration: (T & { connectionReference?: string }) | undefined,
      ) => {
        if (!configuration) return configuration;
        const { connectionReference, ...cleanConfiguration } = configuration;
        const match = connectionReference
          ? connectionProfiles.find(
              (connection) =>
                `${connection.backendId}:${connection.providerId}:${connection.billingLane}` ===
                connectionReference,
            )
          : undefined;
        return { ...cleanConfiguration, connectionProfileId: match?.id };
      };
      const remapDecisionRoute = <T extends { connectionProfileId?: string; judge?: ModelConfiguration }>(
        route: T | undefined,
      ): T | undefined =>
        route
          ? ({
              ...remapConnection(route as T & { connectionReference?: string }),
              judge: remapConnection(
                route.judge as (ModelConfiguration & { connectionReference?: string }) | undefined,
              ),
            } as T)
          : route;
      const importedStages = workflow.stages.map((stage) => {
        const remapped = remapConnection(
          stage as WorkflowStage & { connectionReference?: string },
        ) as WorkflowStage;
        return remapped.decision
          ? {
              ...remapped,
              decision: {
                ...remapDecisionRoute(remapped.decision)!,
                escalation: remapDecisionRoute(remapped.decision.escalation),
              },
            }
          : remapped;
      });
      const importedStageDefaults = workflow.stageDefaults
        ? (Object.fromEntries(
            Object.entries(workflow.stageDefaults).map(([kind, configuration]) => [
              kind,
              remapConnection(configuration as typeof configuration & { connectionReference?: string }),
            ]),
          ) as WorkflowDefinition['stageDefaults'])
        : undefined;
      const created = await api.saveWorkflow(
        {
          ...workflow,
          defaultModelConfiguration: remapConnection(
            workflow.defaultModelConfiguration as typeof workflow.defaultModelConfiguration & {
              connectionReference?: string;
            },
          ),
          stageDefaults: importedStageDefaults,
          stages: importedStages,
          id: '',
          version: 1,
          isDefault: false,
          createdAt: '',
          updatedAt: '',
        },
        true,
      );
      onSaved();
      setSelectedId(created.workflow.id);
      setDraft(created.workflow);
      onNotice(
        'Workflow imported. Connection references were matched to local profiles where available; review provider/model assignments before running.',
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Workflow import failed.');
    }
  };

  const toggleSection = (id: StudioSectionId) =>
    setOpenSections((current) => ({ ...current, [id]: !current[id] }));
  const goToSection = (id: StudioSectionId) => {
    setOpenSections((current) => ({ ...current, [id]: true }));
    setActiveSection(id);
    window.requestAnimationFrame(() =>
      document.getElementById(`studio-${id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
    );
  };
  const aiStageCount = draft.stages.filter((stage) => isAiStage(stage.kind)).length;
  const studioNav: Array<{ id: StudioSectionId; label: string; badge?: string }> = [
    { id: 'basics', label: 'Basics' },
    { id: 'safety', label: 'Safety' },
    { id: 'agents', label: 'Agents', badge: String(draft.stages.length) },
    { id: 'context', label: 'Context' },
    { id: 'generation', label: 'Generation' },
  ];

  return (
    <main className="page-content">
      <PageHeading
        title="Workflow Studio"
        description="Set the order, depth, and explicit provider/model assignment for each stage."
        actions={
          <>
            <label className="secondary-button file-import-button">
              <Upload size={14} />
              Import JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importJson(event.target.files?.[0])}
              />
            </label>
            <button className="secondary-button" onClick={exportJson}>
              Export JSON
            </button>
            <button className="primary-button" onClick={() => void save()} disabled={busy}>
              <Save size={15} />
              {busy ? 'Saving…' : 'Save workflow'}
            </button>
          </>
        }
      />
      <div className="workflow-studio-layout">
        <aside className="studio-rail" aria-label="Workflow studio navigation">
          <div className="studio-template-select">
            <label className="form-field">
              <span>Template</span>
              <select
                value={draft.id}
                onChange={(event) => {
                  const next = workflows.find((workflow) => workflow.id === event.target.value);
                  if (next) {
                    setSelectedId(next.id);
                    setDraft(next);
                  }
                }}
              >
                {workflows.map((workflow) => (
                  <option value={workflow.id} key={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="quiet-button" onClick={() => void duplicate()}>
              <Plus size={14} />
              Duplicate
            </button>
          </div>
          <div className="studio-rail-group">
            <p className="studio-rail-label">Templates</p>
            <div className="workflow-select-list">
              {workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  className={`workflow-select-row ${draft.id === workflow.id ? 'workflow-selected' : ''}`}
                  onClick={() => {
                    setSelectedId(workflow.id);
                    setDraft(workflow);
                  }}
                >
                  <span className="workflow-row-icon">
                    <WorkflowIcon size={16} />
                  </span>
                  <span>
                    <strong>{workflow.name}</strong>
                    <small>
                      {workflow.stages.length} stages · v{workflow.version}
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
            <button className="quiet-button full-width" onClick={() => void duplicate()}>
              <Plus size={14} />
              Duplicate selected workflow
            </button>
          </div>
          <nav className="studio-rail-group studio-rail-sections" aria-label="Workflow sections">
            <p className="studio-rail-label">Sections</p>
            <div className="studio-nav">
              {studioNav.map((item) => (
                <a
                  key={item.id}
                  href={`#studio-${item.id}`}
                  aria-current={activeSection === item.id ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    goToSection(item.id);
                  }}
                >
                  {item.label}
                  {item.badge && <span>{item.badge}</span>}
                </a>
              ))}
            </div>
          </nav>
        </aside>

        <section className="workflow-editor">
          <StudioSection
            id="basics"
            title="Basics"
            summary={`${capitalize(draft.executionProfile)} profile · ${capitalize(draft.permissionMode)} permissions`}
            open={openSections.basics}
            onToggle={() => toggleSection('basics')}
          >
            <div className="workflow-title-fields">
              <label className="form-field">
                <span>Workflow name</span>
                <input
                  value={draft.name}
                  maxLength={100}
                  onChange={(event) => changeWorkflow({ name: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>Purpose</span>
                <textarea
                  className="wrap-input"
                  rows={1}
                  value={draft.description}
                  maxLength={500}
                  onChange={(event) => changeWorkflow({ description: event.target.value })}
                />
              </label>
            </div>
            <div className="form-grid-two workflow-options-grid">
              <label className="form-field">
                <span>Execution profile</span>
                <select
                  value={draft.executionProfile}
                  onChange={(event) =>
                    changeWorkflow({ executionProfile: event.target.value as ExecutionProfile })
                  }
                >
                  <option value="economy">Economy · one reviewer per parallel review</option>
                  <option value="balanced">Balanced · up to two reviewers</option>
                  <option value="maximum">Maximum · configured reviewer count</option>
                </select>
              </label>
              <label className="form-field">
                <span>Permission mode</span>
                <select
                  value={draft.permissionMode}
                  onChange={(event) =>
                    changeWorkflow({ permissionMode: event.target.value as PermissionMode })
                  }
                >
                  <option value="supervised">Supervised</option>
                  <option value="normal">Normal</option>
                  <option value="yolo">YOLO</option>
                  <option value="enigma">ENIGMA · requires run confirmation</option>
                </select>
              </label>
            </div>
            <label className="form-field">
              <span>Workflow instructions</span>
              <textarea
                rows={3}
                maxLength={8000}
                value={draft.globalInstructions ?? ''}
                onChange={(event) => changeWorkflow({ globalInstructions: event.target.value })}
                placeholder="Workflow-specific instructions. These stay below Turing security rules and mandatory Global/Project Rules."
              />
            </label>
          </StudioSection>
          <StudioSection
            id="safety"
            title="Safety"
            summary={`${draft.isolatedWorktree ? 'Worktree isolation on' : 'Worktree isolation off'} · ${billingModeLabel(draft.billingMode ?? (draft.subscriptionOnly ? 'subscriptions-only' : 'custom'))} · ${draft.lockProviders ? 'Providers locked' : 'Providers unlocked'}`}
            open={openSections.safety}
            onToggle={() => toggleSection('safety')}
          >
            <div className="toggle-stack">
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={draft.isolatedWorktree}
                  onChange={(event) => changeWorkflow({ isolatedWorktree: event.target.checked })}
                />
                <span>
                  <strong>Isolate Git runs in a worktree</strong>
                  <small>Run setup pauses if the repository has uncommitted changes.</small>
                </span>
              </label>
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={draft.lockProviders}
                  onChange={(event) => changeWorkflow({ lockProviders: event.target.checked })}
                />
                <span>
                  <strong>Lock Providers</strong>
                  <small>
                    ON by default. A failed stage pauses; Turing does not substitute providers, models, or
                    native reasoning values.
                  </small>
                </span>
              </label>
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={draft.promptRefinementDefault}
                  disabled={
                    !draft.stages.some(
                      (stage) => stage.kind === 'promptRefinement' && stage.enabled !== false,
                    )
                  }
                  onChange={(event) => changeWorkflow({ promptRefinementDefault: event.target.checked })}
                />
                <span>
                  <strong>Prompt refinement by default</strong>
                  <small>
                    Add an enabled Prompt refinement stage and assign its provider to use this option.
                  </small>
                </span>
              </label>
            </div>
            <BillingSafetyFields workflow={draft} onChange={changeWorkflow} />
            <div className="field-row">
              <label className="form-field small-number-field">
                <span>Max remediation rounds</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={draft.maxRemediationRounds}
                  onChange={(event) =>
                    changeWorkflow({
                      maxRemediationRounds: Math.min(5, Math.max(0, Number(event.target.value))),
                    })
                  }
                />
              </label>
              <label className="form-field small-number-field">
                <span>Max parallel agents</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={draft.maxParallelAgents}
                  onChange={(event) =>
                    changeWorkflow({
                      maxParallelAgents: Math.min(8, Math.max(1, Number(event.target.value))),
                    })
                  }
                />
              </label>
              <label className="form-field small-number-field">
                <span>Maximum workflow minutes</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.maxDurationMinutes}
                  onChange={(event) =>
                    changeWorkflow({
                      maxDurationMinutes: Math.min(1440, Math.max(1, Number(event.target.value))),
                    })
                  }
                />
              </label>
            </div>
            <details className="settings-disclosure">
              <summary>
                Retry policy
                <small>
                  {draft.retryPolicy.maxRetries} {draft.retryPolicy.maxRetries === 1 ? 'retry' : 'retries'} ·{' '}
                  {draft.retryPolicy.initialDelayMs}–{draft.retryPolicy.maxDelayMs} ms backoff
                </small>
              </summary>
              <div className="field-row">
                <label className="form-field small-number-field">
                  <span>Transient provider retries</span>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={draft.retryPolicy.maxRetries}
                    onChange={(event) =>
                      changeWorkflow({
                        retryPolicy: {
                          ...draft.retryPolicy,
                          maxRetries: Math.min(5, Math.max(0, Number(event.target.value))),
                        },
                      })
                    }
                  />
                </label>
                <label className="form-field small-number-field">
                  <span>Initial retry delay (ms)</span>
                  <input
                    type="number"
                    min={100}
                    max={30000}
                    step={100}
                    value={draft.retryPolicy.initialDelayMs}
                    onChange={(event) =>
                      changeWorkflow({
                        retryPolicy: {
                          ...draft.retryPolicy,
                          initialDelayMs: Math.min(30000, Math.max(100, Number(event.target.value))),
                          maxDelayMs: Math.max(draft.retryPolicy.maxDelayMs, Number(event.target.value)),
                        },
                      })
                    }
                  />
                </label>
                <label className="form-field small-number-field">
                  <span>Maximum retry delay (ms)</span>
                  <input
                    type="number"
                    min={100}
                    max={120000}
                    step={500}
                    value={draft.retryPolicy.maxDelayMs}
                    onChange={(event) =>
                      changeWorkflow({
                        retryPolicy: {
                          ...draft.retryPolicy,
                          maxDelayMs: Math.min(
                            120000,
                            Math.max(draft.retryPolicy.initialDelayMs, Number(event.target.value)),
                          ),
                        },
                      })
                    }
                  />
                </label>
              </div>
            </details>
          </StudioSection>
          <StudioSection
            id="agents"
            title="Agents"
            summary={`${draft.stages.length} stages · ${aiStageCount} AI ${aiStageCount === 1 ? 'agent' : 'agents'}`}
            open={openSections.agents}
            onToggle={() => toggleSection('agents')}
          >
            <details className="settings-disclosure connection-profile-panel">
              <summary>
                Connection profiles
                <small>
                  {connectionProfiles.length} saved · credentials stay in provider CLIs or secure desktop
                  storage
                </small>
              </summary>
              <div className="connection-profile-body">
                <div className="section-title-row">
                  <div>
                    <h2>Connection profiles</h2>
                    <p>
                      Reusable account and billing lane references. Credentials stay in provider CLIs or
                      secure desktop storage.
                    </p>
                  </div>
                  <LockKeyhole size={16} className="muted-icon" />
                </div>
                <div className="form-grid-two">
                  <label className="form-field">
                    <span>Profile name</span>
                    <input
                      value={profileName}
                      onChange={(event) => setProfileName(event.target.value)}
                      placeholder="OpenCode Go — Alex"
                      maxLength={100}
                    />
                  </label>
                  <label className="form-field">
                    <span>Execution backend</span>
                    <select
                      value={profileBackend}
                      onChange={(event) => {
                        setProfileBackend(event.target.value);
                        setProfileLane(billingLanesForBackend(event.target.value)[0] ?? 'unknown');
                        if (event.target.value === 'openrouter') setProfileProvider('openrouter');
                        if (event.target.value === 'codex-cli') setProfileProvider('openai-codex');
                        if (event.target.value === 'claude-code')
                          setProfileProvider('anthropic-subscription');
                      }}
                    >
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    <span>Provider / billing lane ID</span>
                    <input
                      value={profileProvider}
                      onChange={(event) => setProfileProvider(event.target.value)}
                      placeholder="opencode-go or cline-pass"
                      maxLength={80}
                    />
                  </label>
                  <label className="form-field">
                    <span>Billing lane</span>
                    <select
                      value={profileLane}
                      onChange={(event) =>
                        setProfileLane(event.target.value as ConnectionProfile['billingLane'])
                      }
                    >
                      {billingLanesForBackend(profileBackend).map((lane) => (
                        <option value={lane} key={lane}>
                          {billingLaneLabel(lane)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  className="secondary-button"
                  disabled={!profileName.trim() || !profileProvider.trim()}
                  onClick={() => void saveConnection()}
                >
                  <Plus size={14} />
                  Save connection profile
                </button>
                {connectionProfiles.length > 0 && (
                  <div className="connection-profile-list">
                    {connectionProfiles.map((connection) => (
                      <span key={connection.id}>
                        {connection.name} · {connection.backendId} ·{' '}
                        {billingLaneLabel(connection.billingLane)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </details>
            <div className="stage-editor-heading">
              <div>
                <h2>Stage sequence</h2>
                <p>
                  Drag to reorder, or use the arrow controls. Select a backend, provider, and model on each AI
                  stage.
                </p>
              </div>
              <span className="stage-actions-row">
                <button
                  className="quiet-button"
                  onClick={() => void refreshModels()}
                  disabled={refreshingModels}
                >
                  <RefreshCw size={14} />
                  {refreshingModels ? 'Refreshing…' : 'Refresh models'}
                </button>
                <button className="secondary-button" onClick={addStage}>
                  <Plus size={14} />
                  Add reviewer stage
                </button>
              </span>
            </div>
            <div className="workflow-stage-list">
              {draft.stages.map((stage, index) => (
                <WorkflowStageEditor
                  key={stage.id}
                  stage={stage}
                  index={index}
                  count={draft.stages.length}
                  stages={draft.stages}
                  providers={providers}
                  connectionProfiles={connectionProfiles}
                  modelPresets={modelPresets}
                  workflowContextPolicy={draft.contextPolicy}
                  workflowDefaultModelConfiguration={draft.defaultModelConfiguration}
                  stageDefaultModelConfiguration={draft.stageDefaults?.[stage.kind]}
                  permissionMode={draft.permissionMode}
                  onSavePreset={(name, configuration) =>
                    void savePreset(name, configuration).catch((error) =>
                      onNotice(error instanceof Error ? error.message : 'Preset could not be saved.'),
                    )
                  }
                  onPromoteToStageDefault={(kind, configuration) =>
                    promoteStageToDefault(stage.id, kind, configuration)
                  }
                  onChange={(patch) => changeStage(stage.id, patch)}
                  onMove={(direction) => {
                    const target = draft.stages[index + direction];
                    if (target) reorder(stage.id, target.id);
                  }}
                  onRemove={() =>
                    changeWorkflow({ stages: draft.stages.filter((item) => item.id !== stage.id) })
                  }
                  onDragStart={() => setDragged(stage.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragged) reorder(dragged, stage.id);
                    setDragged(null);
                  }}
                />
              ))}
            </div>
            <div className="workflow-limits-note">
              <Shield size={15} />
              <span>
                Parallel groups are capped by this workflow’s maximum. Model identity is never changed by
                Economy, Balanced, or Maximum.
              </span>
            </div>
          </StudioSection>
          <StudioSection
            id="context"
            title="Context"
            summary={`${draft.contextPolicy.strategy} · ${draft.contextPolicy.maxEstimatedTokens.toLocaleString()} token limit`}
            open={openSections.context}
            onToggle={() => toggleSection('context')}
          >
            <div className="form-grid-two">
              <label className="form-field">
                <span>Default context strategy</span>
                <select
                  value={draft.contextPolicy.strategy}
                  onChange={(event) =>
                    changeWorkflow({
                      contextPolicy: {
                        ...draft.contextPolicy,
                        strategy: event.target.value as WorkflowDefinition['contextPolicy']['strategy'],
                      },
                    })
                  }
                >
                  <option value="focused">AUTO / Focused</option>
                  <option value="changed-files">Changed Files</option>
                  <option value="artifacts-only">Artifacts Only</option>
                  <option value="full-project">Full Project / Broad</option>
                </select>
              </label>
              <label className="form-field small-number-field">
                <span>Default estimated token limit</span>
                <input
                  type="number"
                  min={1000}
                  max={500000}
                  value={draft.contextPolicy.maxEstimatedTokens}
                  onChange={(event) =>
                    changeWorkflow({
                      contextPolicy: {
                        ...draft.contextPolicy,
                        maxEstimatedTokens: Math.min(500000, Math.max(1000, Number(event.target.value))),
                      },
                    })
                  }
                />
              </label>
            </div>
            <details className="settings-disclosure">
              <summary>
                File limits
                <small>
                  {draft.contextPolicy.maxFiles} files · {draft.contextPolicy.maxFileBytes.toLocaleString()}{' '}
                  bytes each
                </small>
              </summary>
              <div className="form-grid-two">
                <label className="form-field small-number-field">
                  <span>Default max files</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={draft.contextPolicy.maxFiles}
                    onChange={(event) =>
                      changeWorkflow({
                        contextPolicy: {
                          ...draft.contextPolicy,
                          maxFiles: Math.min(500, Math.max(1, Number(event.target.value))),
                        },
                      })
                    }
                  />
                </label>
                <label className="form-field small-number-field">
                  <span>Default max file size (bytes)</span>
                  <input
                    type="number"
                    min={1024}
                    max={2000000}
                    value={draft.contextPolicy.maxFileBytes}
                    onChange={(event) =>
                      changeWorkflow({
                        contextPolicy: {
                          ...draft.contextPolicy,
                          maxFileBytes: Math.min(2000000, Math.max(1024, Number(event.target.value))),
                        },
                      })
                    }
                  />
                </label>
              </div>
            </details>
          </StudioSection>
          <StudioSection
            id="generation"
            title="Generation"
            summary={draft.defaultModelConfiguration?.modelId || 'No workflow default model'}
            open={openSections.generation}
            onToggle={() => toggleSection('generation')}
          >
            <div className="form-grid-two ">
              <label className="form-field">
                <span>Workflow default connection profile</span>
                <select
                  value={draft.defaultModelConfiguration?.connectionProfileId ?? ''}
                  onChange={(event) => {
                    const selected = connectionProfiles.find((profile) => profile.id === event.target.value);
                    changeWorkflow({
                      defaultModelConfiguration: selected
                        ? {
                            ...draft.defaultModelConfiguration,
                            connectionProfileId: selected.id,
                            backendId: selected.backendId,
                            providerId: selected.providerId,
                            billingLane: selected.billingLane,
                          }
                        : {
                            ...draft.defaultModelConfiguration,
                            connectionProfileId: undefined,
                            backendId: undefined,
                            providerId: undefined,
                            billingLane: undefined,
                          },
                    });
                  }}
                >
                  <option value="">No workflow-level connection</option>
                  {connectionProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {billingLaneLabel(profile.billingLane)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Workflow default exact model ID</span>
                <input
                  value={draft.defaultModelConfiguration?.modelId ?? ''}
                  onChange={(event) =>
                    changeWorkflow({
                      defaultModelConfiguration: {
                        ...draft.defaultModelConfiguration,
                        modelId: event.target.value || undefined,
                      },
                    })
                  }
                  placeholder="provider-native/model-id"
                  maxLength={180}
                />
              </label>
            </div>
          </StudioSection>
          {validationMessage && (
            <div className="form-error" role="alert">
              <AlertTriangle size={15} />
              {validationMessage}
            </div>
          )}
          <div className="workflow-bottom-actions">
            <span className="workflow-version">Saved version {selected?.version ?? draft.version}</span>
            <button className="primary-button" onClick={() => void save()} disabled={busy}>
              <Save size={15} />
              Save changes
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

type StudioSectionId = 'basics' | 'safety' | 'agents' | 'context' | 'generation';

function StudioSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: StudioSectionId;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section id={`studio-${id}`} className={`studio-section ${open ? 'studio-section-open' : ''}`}>
      <h2 className="studio-section-title">
        <button
          type="button"
          className="studio-section-head"
          aria-expanded={open}
          aria-controls={`studio-${id}-body`}
          onClick={onToggle}
        >
          <span className="studio-section-copy">
            <span className="studio-section-name">{title}</span>
            <span className="studio-section-summary">{summary}</span>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <div id={`studio-${id}-body`} className="studio-section-body">
          {children}
        </div>
      )}
    </section>
  );
}

function WorkflowStageEditor({
  stage,
  index,
  count,
  stages,
  providers,
  connectionProfiles,
  modelPresets,
  workflowContextPolicy,
  workflowDefaultModelConfiguration,
  stageDefaultModelConfiguration,
  permissionMode,
  onSavePreset,
  onPromoteToStageDefault,
  onChange,
  onMove,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  stage: WorkflowStage;
  index: number;
  count: number;
  stages: WorkflowStage[];
  providers: ProviderStatus[];
  connectionProfiles: ConnectionProfile[];
  modelPresets: ModelPreset[];
  workflowContextPolicy: WorkflowDefinition['contextPolicy'];
  workflowDefaultModelConfiguration?: ModelConfiguration;
  stageDefaultModelConfiguration?: ModelConfiguration;
  permissionMode: PermissionMode;
  onSavePreset: (name: string, configuration: ModelConfiguration) => void;
  onPromoteToStageDefault: (kind: StageKind, configuration: ModelConfiguration) => void;
  onChange: (patch: Partial<WorkflowStage>) => void;
  onMove: (direction: number) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const Icon = iconForStage(stage.kind);
  const configuredStage = {
    ...workflowDefaultModelConfiguration,
    ...stageDefaultModelConfiguration,
    ...stage,
  };
  const backend = providers.find((provider) => provider.id === configuredStage.backendId);
  const discovered = backend?.models ?? [];
  const selectedModel = discovered.find((model) => model.id === configuredStage.modelId);
  const modelListId = `models-${stage.id}`;
  const aiStage = isAiStage(stage.kind);
  const updateCondition = (condition: NonNullable<WorkflowStage['condition']>) => onChange({ condition });
  const laterStages = stages.filter((_, stageIndex) => stageIndex > index);
  const ready = Boolean(configuredStage.backendId && configuredStage.providerId && configuredStage.modelId);
  const [expanded, setExpanded] = useState(aiStage && !ready);
  return (
    <article
      className={`workflow-stage-node ${stage.enabled === false ? 'workflow-stage-disabled' : ''} ${expanded ? 'workflow-stage-open' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="stage-node-rail">
        <span className="stage-number">{index + 1}</span>
        {index < count - 1 && <i />}
      </div>
      <div className="stage-node-body">
        <div className="stage-node-head">
          <span className="stage-kind-icon">
            <Icon size={16} />
          </span>
          <label className="stage-name-input">
            <span className="sr-only">Stage label</span>
            <input
              value={stage.label}
              onChange={(event) => onChange({ label: event.target.value })}
              maxLength={120}
            />
          </label>
          <span className="stage-kind-badge">{stageLabels[stage.kind]}</span>
          <div className="stage-reorder">
            <button
              className="icon-button tiny-icon"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              aria-label={`Move ${stage.label} up`}
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon-button tiny-icon"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
              aria-label={`Move ${stage.label} down`}
            >
              <ArrowDown size={14} />
            </button>
            <button
              className="icon-button tiny-icon danger-icon"
              onClick={onRemove}
              aria-label={`Remove ${stage.label}`}
            >
              <X size={14} />
            </button>
          </div>
          <button
            type="button"
            className="stage-expand"
            aria-expanded={expanded}
            aria-controls={`stage-config-${stage.id}`}
            aria-label={`${expanded ? 'Hide' : 'Edit'} ${stage.label} settings`}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown size={16} />
          </button>
        </div>
        <div className="stage-summary">
          {aiStage ? (
            ready ? (
              <>
                <span className="agent-chip">
                  <span className="agent-chip-label">Provider</span>
                  <code>
                    {configuredStage.backendId} · {configuredStage.providerId}
                  </code>
                </span>
                <span className="agent-chip">
                  <span className="agent-chip-label">Model</span>
                  <code>{configuredStage.modelDisplayName ?? configuredStage.modelId}</code>
                </span>
                {configuredStage.reasoning && (
                  <span className="agent-chip">
                    <span className="agent-chip-label">Reasoning</span>
                    <code>{configuredStage.reasoning}</code>
                  </span>
                )}
                {configuredStage.variantId && (
                  <span className="agent-chip">
                    <span className="agent-chip-label">Variant</span>
                    <code>{configuredStage.variantId}</code>
                  </span>
                )}
                <span className="agent-chip">
                  <span className="agent-chip-label">Context</span>
                  <code>{stage.contextPolicy?.strategy ?? workflowContextPolicy.strategy}</code>
                </span>
                <span className="agent-chip">
                  <span className="agent-chip-label">Permissions</span>
                  <code>{permissionMode}</code>
                </span>
                {stage.timeoutMinutes && (
                  <span className="agent-chip">
                    <span className="agent-chip-label">Timeout</span>
                    <code>{stage.timeoutMinutes}m</code>
                  </span>
                )}
              </>
            ) : (
              <span className="stage-summary-required">
                <AlertTriangle size={13} aria-hidden="true" /> Provider and model required
              </span>
            )
          ) : (
            <span className="stage-summary-note">
              {stage.kind === 'build' || stage.kind === 'test'
                ? 'Uses detected project command'
                : stage.kind === 'gitCheckpoint'
                  ? 'Saves a restorable project snapshot'
                  : stage.kind === 'gitCommit'
                    ? 'Commits checked project changes in the run branch'
                    : stage.kind === 'gitPush'
                      ? 'Pushes the run branch without force'
                      : stage.kind === 'gitMerge'
                        ? 'Fast-forward merge with explicit approval'
                        : stage.kind === 'gitRollback'
                          ? 'Restores only the registered project subtree'
                          : stage.kind === 'decisionGate'
                            ? `${stage.decision?.engine ?? 'deterministic-rules'} · ${stage.decision?.questionType ?? 'boolean'} · optional constrained judgement`
                            : 'No model assignment required'}
            </span>
          )}
          <label className="toggle-line compact-toggle stage-enabled">
            <input
              type="checkbox"
              checked={stage.enabled !== false}
              aria-label={`${stage.label} enabled`}
              onChange={(event) => onChange({ enabled: event.target.checked })}
            />
            <span>Enabled</span>
          </label>
        </div>
        {aiStage && stage.modelSnapshot?.status === 'unavailable' && (
          <div className="inline-callout model-repair-note">
            <AlertTriangle size={14} />
            <span>
              <strong>Model unavailable</strong>
              <small>
                Choose a currently discovered model from this provider. Turing will not migrate the historical
                assignment automatically.
              </small>
            </span>
          </div>
        )}
        {expanded && (
          <div className="stage-node-config" id={`stage-config-${stage.id}`}>
            <label className="form-field">
              <span>Stage type</span>
              <select
                value={stage.kind}
                onChange={(event) =>
                  onChange({
                    kind: event.target.value as StageKind,
                    role:
                      event.target.value === 'promptRefinement'
                        ? 'prompt-refinement'
                        : [
                              'build',
                              'test',
                              'gitCheckpoint',
                              'gitCommit',
                              'gitPush',
                              'gitMerge',
                              'gitRollback',
                              'conditionalBranch',
                              'shellCommand',
                              'humanApproval',
                              'notification',
                              'decisionGate',
                            ].includes(event.target.value)
                          ? undefined
                          : (stage.role ?? event.target.value),
                    condition:
                      event.target.value === 'conditionalBranch'
                        ? (stage.condition ?? { path: 'build.success', operator: 'equals', value: true })
                        : undefined,
                    decision:
                      event.target.value === 'decisionGate'
                        ? (stage.decision ?? defaultDecisionConfig())
                        : undefined,
                    orchestration: event.target.value === 'orchestrator' ? stage.orchestration : undefined,
                    skipStageIds:
                      event.target.value === 'conditionalBranch' ? (stage.skipStageIds ?? []) : undefined,
                    command:
                      event.target.value === 'shellCommand'
                        ? (stage.command ?? ['npm', 'run', 'test'])
                        : undefined,
                    notificationMessage:
                      event.target.value === 'notification' ? (stage.notificationMessage ?? '') : undefined,
                    commitMessage:
                      event.target.value === 'gitCommit' ? (stage.commitMessage ?? '') : undefined,
                    pushRemote: event.target.value === 'gitPush' ? (stage.pushRemote ?? 'origin') : undefined,
                    pushBranch: event.target.value === 'gitPush' ? (stage.pushBranch ?? '') : undefined,
                    rollbackTarget:
                      event.target.value === 'gitRollback' ? (stage.rollbackTarget ?? 'runStart') : undefined,
                  })
                }
              >
                {Object.entries(stageLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {aiStage && (
              <>
                <label className="form-field">
                  <span>Execution backend</span>
                  <select
                    value={configuredStage.backendId ?? ''}
                    onChange={(event) =>
                      onChange({
                        backendId: event.target.value || undefined,
                        connectionProfileId: undefined,
                        billingLane: undefined,
                        providerId:
                          event.target.value === 'claude-code'
                            ? 'anthropic-subscription'
                            : event.target.value === 'codex-cli'
                              ? 'openai-codex'
                              : event.target.value === 'openrouter'
                                ? 'openrouter'
                                : stage.providerId,
                        modelId: '',
                        reasoning: undefined,
                        variantId: undefined,
                        nativeSettings: undefined,
                        modelSnapshot: undefined,
                      })
                    }
                  >
                    <option value="">Choose local CLI</option>
                    {providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.name}
                        {provider.detected ? '' : ' · not detected'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Provider</span>
                  <input
                    value={configuredStage.providerId ?? ''}
                    onChange={(event) =>
                      onChange({
                        providerId: event.target.value,
                        connectionProfileId: undefined,
                        billingLane: undefined,
                      })
                    }
                    placeholder={
                      stage.backendId === 'openrouter'
                        ? 'openrouter'
                        : stage.backendId === 'cline'
                          ? 'cline, cline-pass, openai-codex, openai, or anthropic'
                          : stage.backendId === 'claude-code'
                            ? 'anthropic-subscription'
                            : stage.backendId === 'codex-cli'
                              ? 'openai-codex'
                              : 'openai, anthropic, openai-codex, opencode-go'
                    }
                  />
                </label>
                <label className="form-field stage-model-field">
                  <span>Model {discovered.length > 0 && <small>· discovered</small>}</span>
                  <input
                    list={discovered.length ? modelListId : undefined}
                    value={configuredStage.modelId ?? ''}
                    onChange={(event) => {
                      const modelId = event.target.value;
                      const discoveredModel = discovered.find((model) => model.id === modelId);
                      onChange({
                        modelId,
                        modelDisplayName: discoveredModel?.name ?? configuredStage.modelDisplayName,
                        ...(discoveredModel
                          ? {
                              modelSnapshot: {
                                providerId: discoveredModel.providerId,
                                modelId: discoveredModel.id,
                                displayName: discoveredModel.name,
                                ...(configuredStage.variantId
                                  ? { variantId: configuredStage.variantId }
                                  : {}),
                                capabilities: {
                                  ...(discoveredModel.capabilities ?? {}),
                                  ...(discoveredModel.reasoningLevels
                                    ? { reasoningLevels: discoveredModel.reasoningLevels }
                                    : {}),
                                  ...(discoveredModel.variantIds
                                    ? { variants: discoveredModel.variantIds }
                                    : {}),
                                  supportsTools:
                                    discoveredModel.supportsTools ??
                                    discoveredModel.capabilities?.tools ??
                                    null,
                                },
                                discoveredAt:
                                  discoveredModel.discoveredAt ??
                                  backend?.checkedAt ??
                                  new Date().toISOString(),
                                adapterVersion: discoveredModel.adapterVersion ?? backend?.version ?? null,
                                status: 'current' as const,
                              },
                            }
                          : {}),
                        ...pruneModelSettings({
                          backendId: configuredStage.backendId,
                          model: discoveredModel,
                          reasoning: configuredStage.reasoning,
                          variantId: configuredStage.variantId,
                          nativeSettings: configuredStage.nativeSettings,
                        }),
                        ...(discoveredModel ? { providerId: discoveredModel.providerId } : {}),
                      });
                    }}
                    placeholder={
                      stage.backendId === 'claude-code'
                        ? 'Enter exact Claude Code model/alias'
                        : stage.backendId === 'cline'
                          ? 'Enter provider model ID'
                          : stage.backendId === 'codex-cli'
                            ? 'Choose a model discovered from ChatGPT'
                            : 'Choose a model reported by OpenCode'
                    }
                  />
                  <ModelStatusLine
                    backendId={configuredStage.backendId}
                    modelId={configuredStage.modelId}
                    model={selectedModel}
                    snapshot={stage.modelSnapshot}
                    catalogSource={backend?.capabilities.modelDiscovery ? backend.catalogSource : undefined}
                  />
                  <datalist id={modelListId}>
                    {discovered.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </datalist>
                </label>
              </>
            )}
            {aiStage && (
              <ModelSettingsFields
                backendId={configuredStage.backendId}
                model={selectedModel}
                reasoning={configuredStage.reasoning}
                variantId={configuredStage.variantId}
                nativeSettings={configuredStage.nativeSettings}
                onChange={onChange}
              />
            )}
            {stage.kind === 'orchestrator' && (
              <OrchestratorBranchesEditor stage={stage} laterStages={laterStages} onChange={onChange} />
            )}
            {stage.kind === 'decisionGate' && (
              <DecisionGateEditor
                stage={stage}
                laterStages={laterStages}
                providers={providers}
                profiles={connectionProfiles}
                onChange={onChange}
              />
            )}
            {stage.kind === 'parallelReview' && (
              <label className="form-field small-number-field">
                <span>Reviewer count</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={stage.parallelism ?? 1}
                  onChange={(event) =>
                    onChange({ parallelism: Math.min(8, Math.max(1, Number(event.target.value))) })
                  }
                />
              </label>
            )}
            {stage.kind === 'shellCommand' && (
              <label className="form-field">
                <span>Project command</span>
                <input
                  value={stage.command?.join(' ') ?? ''}
                  onChange={(event) =>
                    onChange({ command: event.target.value.trim().split(/\s+/).filter(Boolean) })
                  }
                  placeholder="npm run test"
                />
                <small>Only package scripts named build, test, or lint are supported.</small>
              </label>
            )}
            {stage.kind === 'notification' && (
              <label className="form-field">
                <span>Notification message</span>
                <textarea
                  value={stage.notificationMessage ?? ''}
                  maxLength={1_000}
                  onChange={(event) => onChange({ notificationMessage: event.target.value })}
                  placeholder="A workflow notification stage was reached."
                  rows={3}
                />
                <small>Delivered to connected browser clients with notification permission.</small>
              </label>
            )}
            {stage.kind === 'gitCommit' && (
              <label className="form-field">
                <span>Commit message</span>
                <input
                  value={stage.commitMessage ?? ''}
                  maxLength={120}
                  onChange={(event) => onChange({ commitMessage: event.target.value })}
                  placeholder="Turing Terminal run commit"
                />
                <small>Only changes under the registered project folder are included.</small>
              </label>
            )}
            {stage.kind === 'gitPush' && (
              <>
                <label className="form-field">
                  <span>Remote</span>
                  <input
                    value={stage.pushRemote ?? 'origin'}
                    maxLength={61}
                    onChange={(event) => onChange({ pushRemote: event.target.value })}
                    placeholder="origin"
                  />
                </label>
                <label className="form-field">
                  <span>Remote branch</span>
                  <input
                    value={stage.pushBranch ?? ''}
                    maxLength={100}
                    onChange={(event) => onChange({ pushBranch: event.target.value })}
                    placeholder="Same as the Turing run branch"
                  />
                  <small>
                    Force push is never used. Push always waits for approval, including in ENIGMA.
                  </small>
                </label>
              </>
            )}
            {stage.kind === 'gitRollback' && (
              <label className="form-field">
                <span>Restore point</span>
                <select
                  value={stage.rollbackTarget ?? 'runStart'}
                  onChange={(event) =>
                    onChange({ rollbackTarget: event.target.value as WorkflowStage['rollbackTarget'] })
                  }
                >
                  <option value="runStart">Run start</option>
                  <option value="latestCheckpoint">Latest earlier checkpoint</option>
                </select>
                <small>Always asks before changing the isolated run worktree.</small>
              </label>
            )}
            {stage.kind === 'conditionalBranch' && (
              <>
                <label className="form-field">
                  <span>Condition field</span>
                  <select
                    value={stage.condition?.path ?? 'build.success'}
                    onChange={(event) => {
                      const path = event.target.value as WorkflowConditionPath;
                      updateCondition({
                        path,
                        operator: 'equals',
                        value: path === 'build.success' ? true : path === 'finalGate.status' ? 'PASS' : 0,
                      });
                    }}
                  >
                    <option value="build.success">Build succeeded</option>
                    <option value="tests.failed">Failed test stages</option>
                    <option value="review.openCritical">Open critical findings</option>
                    <option value="review.openHigh">Open high findings</option>
                    <option value="finalGate.status">Final gate status</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>Comparison</span>
                  <select
                    value={stage.condition?.operator ?? 'equals'}
                    onChange={(event) =>
                      stage.condition &&
                      updateCondition({
                        ...stage.condition,
                        operator: event.target.value as WorkflowCondition['operator'],
                      })
                    }
                  >
                    <option value="equals">equals</option>
                    <option value="notEquals">does not equal</option>
                    {stage.condition?.path !== 'finalGate.status' && (
                      <>
                        <option value="greaterThan">greater than</option>
                        <option value="lessThan">less than</option>
                      </>
                    )}
                  </select>
                </label>
                <label className="form-field">
                  <span>Expected value</span>
                  {stage.condition?.path === 'build.success' ? (
                    <select
                      value={String(stage.condition.value)}
                      onChange={(event) =>
                        stage.condition &&
                        updateCondition({ ...stage.condition, value: event.target.value === 'true' })
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : stage.condition?.path === 'finalGate.status' ? (
                    <select
                      value={String(stage.condition.value)}
                      onChange={(event) =>
                        stage.condition && updateCondition({ ...stage.condition, value: event.target.value })
                      }
                    >
                      <option value="PASS">PASS</option>
                      <option value="FAIL">FAIL</option>
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      value={Number(stage.condition?.value ?? 0)}
                      onChange={(event) =>
                        stage.condition &&
                        updateCondition({ ...stage.condition, value: Number(event.target.value) })
                      }
                    />
                  )}
                </label>
                <fieldset className="condition-skip-targets">
                  <legend>Skip these later stages when the condition is false</legend>
                  {laterStages.map((later) => (
                    <label className="rule-flag" key={later.id}>
                      <input
                        type="checkbox"
                        checked={(stage.skipStageIds ?? []).includes(later.id)}
                        onChange={(event) =>
                          onChange({
                            skipStageIds: event.target.checked
                              ? [...(stage.skipStageIds ?? []), later.id]
                              : (stage.skipStageIds ?? []).filter((id) => id !== later.id),
                          })
                        }
                      />
                      {later.label}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {['build', 'test', 'shellCommand'].includes(stage.kind) && (
              <label className="rule-flag">
                <input
                  type="checkbox"
                  checked={Boolean(stage.continueOnFailure)}
                  onChange={(event) => onChange({ continueOnFailure: event.target.checked })}
                />
                Continue to conditional stages after failure
              </label>
            )}
            {aiStage && (
              <>
                <label className="form-field stage-wide">
                  <span>Custom stage instructions</span>
                  <textarea
                    rows={3}
                    maxLength={8_000}
                    value={stage.customInstructions ?? ''}
                    onChange={(event) => onChange({ customInstructions: event.target.value })}
                    placeholder="Optional instructions for this stage. They remain below mandatory security, Global Rules, Project Rules, and Turing role instructions."
                  />
                </label>
              </>
            )}
            <details className="settings-disclosure stage-advanced">
              <summary>
                Advanced
                <small>Connection profile, billing lane, presets, limits, context</small>
              </summary>
              <div className="stage-advanced-grid">
                {aiStage && (
                  <>
                    <label className="form-field">
                      <span>Connection / subscription profile</span>
                      <select
                        value={configuredStage.connectionProfileId ?? ''}
                        onChange={(event) => {
                          const connection = connectionProfiles.find(
                            (profile) => profile.id === event.target.value,
                          );
                          onChange(
                            connection
                              ? {
                                  connectionProfileId: connection.id,
                                  backendId: connection.backendId,
                                  providerId: connection.providerId,
                                  billingLane: connection.billingLane,
                                }
                              : { connectionProfileId: undefined, billingLane: undefined },
                          );
                        }}
                      >
                        <option value="">No saved profile · manual connection</option>
                        {connectionProfiles.map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.name} · {profile.backendId} · {billingLaneLabel(profile.billingLane)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>Provider / billing lane</span>
                      <select
                        value={
                          configuredStage.billingLane ??
                          inferClientBillingLane(configuredStage.backendId, configuredStage.providerId)
                        }
                        disabled={Boolean(configuredStage.connectionProfileId)}
                        onChange={(event) =>
                          onChange({
                            billingLane: event.target.value as NonNullable<WorkflowStage['billingLane']>,
                          })
                        }
                      >
                        {billingLanesForBackend(configuredStage.backendId).map((lane) => (
                          <option value={lane} key={lane}>
                            {billingLaneLabel(lane)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>Saved model preset</span>
                      <select
                        value=""
                        onChange={(event) => {
                          const preset = modelPresets.find((item) => item.id === event.target.value);
                          if (preset) onChange(preset.configuration);
                        }}
                      >
                        <option value="">Choose preset to apply</option>
                        {modelPresets.map((preset) => (
                          <option value={preset.id} key={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="stage-wide stage-actions-row">
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => {
                          const name = window.prompt('Name this model configuration preset:');
                          if (name?.trim())
                            onSavePreset(name.trim(), {
                              backendId: configuredStage.backendId,
                              connectionProfileId: configuredStage.connectionProfileId,
                              providerId: configuredStage.providerId,
                              billingLane: configuredStage.billingLane,
                              modelId: configuredStage.modelId,
                              modelDisplayName: configuredStage.modelDisplayName,
                              variantId: configuredStage.variantId,
                              reasoning: configuredStage.reasoning,
                              nativeSettings: configuredStage.nativeSettings,
                            });
                        }}
                        disabled={
                          !configuredStage.backendId ||
                          !configuredStage.providerId ||
                          !configuredStage.modelId
                        }
                      >
                        <Save size={13} />
                        Save model preset
                      </button>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={
                          !configuredStage.backendId ||
                          !configuredStage.providerId ||
                          !configuredStage.modelId
                        }
                        onClick={() =>
                          onPromoteToStageDefault(stage.kind, {
                            backendId: configuredStage.backendId,
                            connectionProfileId: configuredStage.connectionProfileId,
                            providerId: configuredStage.providerId,
                            billingLane: configuredStage.billingLane,
                            modelId: configuredStage.modelId,
                            modelDisplayName: configuredStage.modelDisplayName,
                            variantId: configuredStage.variantId,
                            reasoning: configuredStage.reasoning,
                            nativeSettings: configuredStage.nativeSettings,
                          })
                        }
                      >
                        <Save size={13} />
                        Use for all matching stages
                      </button>
                    </div>
                  </>
                )}
                <label className="form-field small-number-field">
                  <span>Stage timeout (minutes)</span>
                  <input
                    type="number"
                    min={1}
                    max={360}
                    value={stage.timeoutMinutes ?? ''}
                    placeholder="No stage override"
                    onChange={(event) =>
                      onChange({
                        timeoutMinutes: event.target.value
                          ? Math.min(360, Math.max(1, Number(event.target.value)))
                          : undefined,
                      })
                    }
                  />
                </label>
                {aiStage && (
                  <label className="form-field small-number-field">
                    <span>Retry override</span>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={stage.retryPolicy?.maxRetries ?? ''}
                      placeholder="Workflow default"
                      onChange={(event) =>
                        onChange({
                          retryPolicy: {
                            ...stage.retryPolicy,
                            maxRetries: event.target.value
                              ? Math.min(5, Math.max(0, Number(event.target.value)))
                              : undefined,
                          },
                        })
                      }
                    />
                  </label>
                )}
                {aiStage && (
                  <>
                    <div className="form-grid-two stage-context-controls stage-wide">
                      <label className="form-field">
                        <span>Context strategy</span>
                        <select
                          value={stage.contextPolicy?.strategy ?? workflowContextPolicy.strategy}
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                strategy: event.target
                                  .value as WorkflowDefinition['contextPolicy']['strategy'],
                              },
                            })
                          }
                        >
                          <option value="focused">AUTO / Focused</option>
                          <option value="changed-files">Changed Files</option>
                          <option value="artifacts-only">Artifacts Only</option>
                          <option value="full-project">Full Project / Broad</option>
                        </select>
                      </label>
                      <label className="form-field small-number-field">
                        <span>Estimated token limit</span>
                        <input
                          type="number"
                          min={1000}
                          max={500000}
                          value={
                            stage.contextPolicy?.maxEstimatedTokens ??
                            workflowContextPolicy.maxEstimatedTokens
                          }
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                maxEstimatedTokens: Math.min(
                                  500000,
                                  Math.max(1000, Number(event.target.value)),
                                ),
                              },
                            })
                          }
                        />
                      </label>
                      <label className="form-field small-number-field">
                        <span>Maximum files</span>
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={stage.contextPolicy?.maxFiles ?? workflowContextPolicy.maxFiles}
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                maxFiles: Math.min(500, Math.max(1, Number(event.target.value))),
                              },
                            })
                          }
                        />
                      </label>
                      <label className="form-field small-number-field">
                        <span>Maximum file size (bytes)</span>
                        <input
                          type="number"
                          min={1024}
                          max={2000000}
                          value={stage.contextPolicy?.maxFileBytes ?? workflowContextPolicy.maxFileBytes}
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                maxFileBytes: Math.min(2000000, Math.max(1024, Number(event.target.value))),
                              },
                            })
                          }
                        />
                      </label>
                      <label className="form-field">
                        <span>Include globs (one per line)</span>
                        <textarea
                          rows={2}
                          value={(
                            stage.contextPolicy?.includeGlobs ?? workflowContextPolicy.includeGlobs
                          ).join('\n')}
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                includeGlobs: event.target.value
                                  .split(/\r?\n/)
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                          placeholder="src/**/*.ts"
                        />
                      </label>
                      <label className="form-field">
                        <span>Exclude globs (one per line)</span>
                        <textarea
                          rows={2}
                          value={(
                            stage.contextPolicy?.excludeGlobs ?? workflowContextPolicy.excludeGlobs
                          ).join('\n')}
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                excludeGlobs: event.target.value
                                  .split(/\r?\n/)
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                          placeholder="node_modules/**"
                        />
                      </label>
                    </div>
                    <div className="context-inclusion-flags stage-wide">
                      {(
                        [
                          ['includeCurrentDiff', 'Include current diff'],
                          ['includeTestOutput', 'Include structured test summary'],
                          ['includeBuildOutput', 'Include structured build summary'],
                          ['includePreviousArtifact', 'Include previous stage artifact'],
                        ] as const
                      ).map(([key, label]) => (
                        <label className="rule-flag" key={key}>
                          <input
                            type="checkbox"
                            checked={
                              stage.contextPolicy?.[key] ??
                              (key === 'includeCurrentDiff'
                                ? ['reviewer', 'parallelReview', 'finalGate', 'consolidate'].includes(
                                    stage.kind,
                                  ) && workflowContextPolicy[key]
                                : workflowContextPolicy[key])
                            }
                            onChange={(event) =>
                              onChange({
                                contextPolicy: { ...stage.contextPolicy, [key]: event.target.checked },
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                      <label className="rule-flag">
                        <input
                          type="checkbox"
                          checked={
                            stage.contextPolicy?.includePreviousTranscript ??
                            workflowContextPolicy.includePreviousTranscript
                          }
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                includePreviousTranscript: event.target.checked,
                              },
                            })
                          }
                        />
                        Include prior AI stage responses (larger context)
                      </label>
                      <label className="form-field">
                        <span>Over budget</span>
                        <select
                          value={
                            stage.contextPolicy?.onLimitExceeded ?? workflowContextPolicy.onLimitExceeded
                          }
                          onChange={(event) =>
                            onChange({
                              contextPolicy: {
                                ...stage.contextPolicy,
                                onLimitExceeded: event.target.value as 'compact' | 'ask' | 'stop',
                              },
                            })
                          }
                        >
                          <option value="compact">Compact optional context</option>
                          <option value="ask">Require user review</option>
                          <option value="stop">Stop stage</option>
                        </select>
                      </label>
                    </div>
                  </>
                )}
              </div>
            </details>
          </div>
        )}
      </div>
    </article>
  );
}

function ProjectsPage({
  projects,
  onChanged,
  onNotice,
}: {
  projects: ProjectProfile[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState(projects[0]?.id ?? '');
  const selected = projects.find((project) => project.id === selectedId);
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.addProject(path);
      setPath('');
      setSelectedId(result.project.id);
      onChanged();
      onNotice(`${result.project.name} added to this machine.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project could not be added.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page-content">
      <PageHeading
        title="Projects"
        description="Repositories registered on this machine, with detected profile and test commands."
      />
      <div className={`projects-layout ${projects.length === 0 ? 'projects-layout-empty' : ''}`}>
        <section className="surface-panel projects-list-panel">
          <div className="panel-title-row">
            <div>
              <h2>Registered projects</h2>
              <p>{projects.length} on this machine</p>
            </div>
            <FileCode2 size={17} className="muted-icon" />
          </div>
          <form className="add-project-form" onSubmit={add}>
            <label className="form-field">
              <span>Local folder path</span>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/home/alex/code/my-project"
                required
              />
            </label>
            <button className="primary-button" disabled={busy || !path.trim()}>
              <Plus size={15} />
              {busy ? 'Inspecting…' : 'Add project'}
            </button>
            <small>
              Run this interface on the desktop master to register a local folder. A mobile browser cannot
              browse desktop files.
            </small>
          </form>
          <div className="project-select-list">
            {projects.map((project) => (
              <button
                className={`project-row ${project.id === selectedId ? 'project-selected' : ''}`}
                key={project.id}
                onClick={() => setSelectedId(project.id)}
              >
                <span className="project-row-symbol">
                  <HardDrive size={17} />
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
                <span className={`status-pill ${project.dirty ? 'status-attention' : 'status-ready'}`}>
                  {project.dirty === null ? 'No Git' : project.dirty ? 'Dirty' : 'Clean'}
                </span>
              </button>
            ))}
            {projects.length === 0 && (
              <EmptyState
                icon={FileCode2}
                title="No projects yet"
                body="Add a local folder path above. The master will detect Git, languages, package scripts, and project instructions."
              />
            )}
          </div>
        </section>
        {projects.length > 0 && (
          <section className="project-profile-column">
            {selected ? (
              <ProjectProfilePanel
                project={selected}
                onSaved={() => {
                  onChanged();
                  onNotice('Project profile updated.');
                }}
                onNotice={onNotice}
              />
            ) : (
              <EmptyState
                icon={Search}
                title="Select a project"
                body="Detected project details will appear here."
              />
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function ProjectProfilePanel({
  project,
  onSaved,
  onNotice,
}: {
  project: ProjectProfile;
  onSaved: () => void;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [buildCommand, setBuildCommand] = useState(commandText(project.buildCommand));
  const [testCommand, setTestCommand] = useState(commandText(project.testCommand));
  const [lintCommand, setLintCommand] = useState(commandText(project.lintCommand));
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setName(project.name);
    setBuildCommand(commandText(project.buildCommand));
    setTestCommand(commandText(project.testCommand));
    setLintCommand(commandText(project.lintCommand));
  }, [project]);
  const save = async () => {
    try {
      await api.patchProject(project.id, {
        name,
        buildCommand: parseCommand(buildCommand),
        testCommand: parseCommand(testCommand),
        lintCommand: parseCommand(lintCommand),
      });
      onSaved();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project profile could not be saved.');
    }
  };
  const refreshProject = async () => {
    setRefreshing(true);
    try {
      await api.refreshProject(project.id);
      onSaved();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project details could not be refreshed.');
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="surface-panel project-profile-panel">
      <div className="panel-title-row">
        <div>
          <h2>Project profile</h2>
          <p>Correct the detected values before running workflows.</p>
        </div>
        <button
          className="icon-button small-icon"
          title="Refresh project details"
          aria-label="Refresh project details"
          disabled={refreshing}
          onClick={() => void refreshProject()}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="project-detail-banner">
        <span className="project-banner-symbol">
          <FileCode2 size={18} />
        </span>
        <div>
          <strong>{project.name}</strong>
          <code>{project.path}</code>
        </div>
        <span className={`status-pill ${project.gitRoot ? 'status-ready' : 'status-attention'}`}>
          {project.gitRoot ? 'Git repository' : 'Folder'}
        </span>
      </div>
      <dl className="metadata-grid">
        <Meta label="Current branch" value={project.branch ?? 'Not detected'} icon={GitBranch} />
        <Meta
          label="Working tree"
          value={
            project.dirty === null
              ? 'Git status unavailable'
              : project.dirty
                ? 'Uncommitted changes'
                : 'Clean'
          }
          icon={GitCompareArrows}
        />
        <Meta
          label="Package manager"
          value={project.packageManager ?? 'Not detected'}
          icon={TerminalSquare}
        />
        <Meta
          label="Primary languages"
          value={project.languages.join(', ') || 'Not detected'}
          icon={FileCode2}
        />
        <Meta label="Frameworks" value={project.frameworks.join(', ') || 'Not detected'} icon={Cpu} />
        <Meta
          label="Instructions"
          value={project.instructionFiles.length ? project.instructionFiles.join(', ') : 'None found'}
          icon={CircleHelp}
        />
      </dl>
      <div className="project-command-editor">
        <div>
          <h3>Project commands</h3>
          <p>Only these package-script commands run automatically.</p>
        </div>
        <label className="form-field">
          <span>Project name</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <CommandEditor label="Build command" value={buildCommand} onChange={setBuildCommand} />
        <CommandEditor label="Test command" value={testCommand} onChange={setTestCommand} />
        <CommandEditor label="Lint command" value={lintCommand} onChange={setLintCommand} />
        <button className="primary-button align-right" onClick={() => void save()}>
          <Save size={14} />
          Save profile
        </button>
      </div>
    </section>
  );
}

function CommandEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not configured</option>
        {['npm', 'pnpm', 'yarn', 'bun'].map((tool) => (
          <option value={`${tool} run ${label.toLowerCase().split(' ')[0]}`} key={tool}>
            {tool} run {label.toLowerCase().split(' ')[0]}
          </option>
        ))}
      </select>
    </label>
  );
}

function RunsPage({
  snapshot,
  selectedRun,
  selectedRunId,
  onSelect,
  onRefresh,
  onNotice,
  onNavigate,
}: {
  snapshot: DashboardSnapshot;
  selectedRun: RunSummary | null;
  selectedRunId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
  onNavigate: (page: Page) => void;
}) {
  const [filter, setFilter] = useState('all');
  const runs = snapshot.runs.filter(
    (run) => filter === 'all' || activeStatuses.has(run.status) === (filter === 'active'),
  );
  return (
    <main className="page-content">
      {!selectedRun && (
        <PageHeading
          title="Runs & history"
          description="Follow active stages, inspect provider output, and review changes from recent workflows."
          actions={
            <button className="secondary-button" onClick={onRefresh}>
              <RefreshCw size={14} />
              Refresh
            </button>
          }
        />
      )}
      {pendingApprovalCounts(snapshot).total > 0 && (
        <UnifiedApprovals
          heading="Approval required"
          refresh={approvalSignature(snapshot)}
          onDecided={onRefresh}
        />
      )}
      <div
        className={`runs-layout ${selectedRun ? 'runs-detail-open' : ''} ${
          snapshot.runs.length === 0 ? 'runs-layout-empty' : ''
        }`}
      >
        <section className="runs-list-panel surface-panel">
          <div className="runs-list-toolbar">
            <div>
              <h2>Workflow runs</h2>
              <p>{runs.length} shown on this machine</p>
            </div>
            <label className="sr-only" htmlFor="run-filter">
              Filter runs
            </label>
            <select id="run-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All runs</option>
              <option value="active">Active only</option>
              <option value="finished">Finished only</option>
            </select>
          </div>
          {runs.length ? (
            <div className="full-run-list">
              {runs.map((run) => (
                <button
                  key={run.id}
                  className={`full-run-row ${selectedRunId === run.id ? 'full-run-selected' : ''}`}
                  onClick={() => onSelect(run.id)}
                >
                  <span className={`run-status-glyph run-glyph-${run.status}`}>
                    <StatusIcon status={run.status} />
                  </span>
                  <span className="full-run-main">
                    <strong>{shortTask(run.prompt)}</strong>
                    <span>
                      {run.projectName} <i>·</i> {run.workflowName}
                    </span>
                    <small>
                      {formatDate(run.createdAt)} · {run.stages.length} stages
                    </small>
                  </span>
                  <span className={`status-pill status-${run.status}`}>{humanStatus(run.status)}</span>
                </button>
              ))}
            </div>
          ) : snapshot.runs.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No runs yet"
              body="Stage output, approvals, findings, and Git changes appear here once a workflow runs."
              action={{ label: 'Start a task', onClick: () => onNavigate('command') }}
            />
          ) : (
            <EmptyState
              icon={Activity}
              title="No runs match"
              body="No runs match this filter."
              action={{ label: 'Show all runs', onClick: () => setFilter('all') }}
            />
          )}
        </section>
        {selectedRun ? (
          <RunDetail
            run={selectedRun}
            onNotice={onNotice}
            onRefresh={onRefresh}
            onClose={() => onSelect(null)}
          />
        ) : (
          snapshot.runs.length > 0 && (
            <section className="run-inspector-empty surface-panel">
              <Activity size={21} />
              <h2>Select a run</h2>
              <p>Stage output, approvals, findings, and Git changes appear here.</p>
            </section>
          )
        )}
      </div>
    </main>
  );
}

function RunDetail({
  run,
  onNotice,
  onRefresh,
  onClose,
}: {
  run: RunSummary;
  onNotice: (message: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<Awaited<ReturnType<typeof api.run>> | null>(null);
  const [operations, setOperations] = useState<ExecutionOperation[]>([]);
  const [diff, setDiff] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [intervention, setIntervention] = useState('');
  const isActive = activeStatuses.has(run.status);
  useEffect(() => {
    let live = true;
    void Promise.all([api.run(run.id), api.executionOperations(run.id)])
      .then(([result, operationResult]) => {
        if (live) {
          setDetails(result);
          setOperations(operationResult.operations);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [run.id, run.status, run.stages.map((stage) => stage.status).join(',')]);
  const loadDiff = async () => {
    try {
      const result = await api.diff(run.id);
      setDiff(result.diff);
      setShowDiff(true);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Diff could not be loaded.');
    }
  };
  const sendIntervention = async () => {
    if (!intervention.trim()) return;
    try {
      const result = await api.intervene(run.id, intervention);
      setIntervention('');
      onRefresh();
      onNotice(
        result.requiresResume
          ? 'Intervention recorded. The active stage stopped; resume the run to continue with that instruction.'
          : 'Intervention recorded for the next stage.',
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Intervention could not be recorded.');
    }
  };
  const resume = async () => {
    try {
      await api.resumeRun(run.id);
      onRefresh();
      onNotice('Run resumed from its next pending stage.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Run could not be resumed.');
    }
  };
  const replay = async () => {
    const enigmaConfirmed =
      run.permissionMode !== 'enigma' ||
      window.confirm('This historical run used ENIGMA. Activate ENIGMA for this new run?');
    if (!enigmaConfirmed) return;
    try {
      const response = await api.replayRun(run.id, enigmaConfirmed);
      onRefresh();
      onNotice(`Run restarted with its historical provider/model configuration as ${response.run.id}.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Historical configuration could not be replayed.');
    }
  };
  const duplicateWorkflow = async () => {
    try {
      const response = await api.duplicateRunWorkflow(run.id);
      onRefresh();
      const unavailable = response.providerAssignments.filter((assignment) => !assignment.ready);
      onNotice(
        unavailable.length
          ? `Workflow duplicated for editing. ${unavailable.length} stage model assignment(s) need repair before running.`
          : 'Workflow duplicated with its historical configuration. Review and edit it in Workflow Studio.',
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Historical workflow could not be duplicated.');
    }
  };
  const stop = () =>
    void api
      .cancelRun(run.id)
      .then(() => {
        onRefresh();
        onNotice('Stop requested. The provider process is being terminated.');
      })
      .catch((error) => onNotice(error.message));
  const findings = details?.findings ?? [];
  const gitOperations = details?.gitOperations ?? [];
  const liveStage = run.stages.find((stage) =>
    ['running', 'waiting_for_approval', 'waiting_for_user'].includes(stage.status),
  );
  const failedStage = run.stages.find((stage) => stage.status === 'failed');
  const threadState: { tone: string; icon: LucideIcon; title: string; detail: string } =
    run.status === 'failed'
      ? {
          tone: 'failed',
          icon: AlertTriangle,
          title: 'Failed',
          detail: failedStage
            ? `${failedStage.title}${failedStage.error ? `: ${failedStage.error}` : ''}`
            : 'The run stopped before finishing.',
        }
      : run.status === 'completed'
        ? {
            tone: 'completed',
            icon: CheckCircle2,
            title: `Completed in ${formatDuration(run.startedAt, run.completedAt)}`,
            detail: `${run.stages.filter((stage) => stage.status === 'passed').length} of ${run.stages.length} stages passed.`,
          }
        : run.status === 'waiting_for_approval'
          ? {
              tone: 'waiting',
              icon: LockKeyhole,
              title: 'Waiting for your approval',
              detail: liveStage
                ? `${liveStage.title} is paused until you decide.`
                : 'A step needs your decision.',
            }
          : run.status === 'waiting_for_user'
            ? {
                tone: 'waiting',
                icon: CircleHelp,
                title: 'Waiting for your input',
                detail: liveStage
                  ? `${liveStage.title} needs an answer to continue.`
                  : 'The run needs an answer.',
              }
            : run.status === 'paused' || run.status === 'paused_limit_reached'
              ? {
                  tone: 'waiting',
                  icon: Pause,
                  title: 'Paused',
                  detail: 'Resume the run to continue from its next pending stage.',
                }
              : isActive
                ? {
                    tone: 'running',
                    icon: Activity,
                    title: `Running · ${formatMilliseconds(run.elapsedMs)}`,
                    detail: liveStage ? `Now: ${liveStage.title}` : 'Preparing the first stage.',
                  }
                : {
                    tone: 'neutral',
                    icon: Square,
                    title: humanStatus(run.status),
                    detail: 'This run is no longer active.',
                  };
  const StateIcon = threadState.icon;
  return (
    <section className="run-detail-panel">
      <button className="back-link" onClick={onClose}>
        <ArrowLeft size={15} aria-hidden="true" />
        All runs
      </button>
      <div className="run-detail-top">
        <div className="run-detail-title">
          <span className={`run-status-glyph run-glyph-${run.status}`}>
            <StatusIcon status={run.status} />
          </span>
          <div>
            <h2>{shortTask(run.prompt)}</h2>
            <p>
              {run.projectName} · {run.workflowName}
            </p>
          </div>
        </div>
        <span className={`status-pill status-${run.status}`}>{humanStatus(run.status)}</span>
        <details className="run-menu">
          <summary aria-label="Run actions">
            <MoreHorizontal size={18} />
          </summary>
          <div className="run-menu-list">
            <button className="secondary-button" onClick={() => void replay()} disabled={isActive}>
              <RefreshCw size={14} />
              Run Again With Same Configuration
            </button>
            <button className="secondary-button" onClick={() => void duplicateWorkflow()}>
              <Plus size={14} />
              Duplicate and Edit
            </button>
            {isActive && <small>Run again is available once this run finishes.</small>}
          </div>
        </details>
      </div>
      <div className={`thread-state thread-state-${threadState.tone}`}>
        <div className="thread-state-copy">
          <StateIcon size={18} aria-hidden="true" />
          <div>
            <strong>{threadState.title}</strong>
            <p>{threadState.detail}</p>
          </div>
        </div>
        <div className="thread-state-actions">
          {(run.status === 'paused' || run.status === 'failed') && (
            <button className="primary-button" onClick={() => void resume()}>
              <Play size={14} />
              Resume run
            </button>
          )}
          {isActive && (
            <button className="danger-button" onClick={stop}>
              <StopCircle size={14} />
              Stop run
            </button>
          )}
          <button className="secondary-button" onClick={() => void loadDiff()}>
            <GitCompareArrows size={14} />
            View diff
          </button>
        </div>
      </div>
      <div className="thread-user">
        <p>{run.prompt}</p>
      </div>
      <div className="run-detail-meta">
        <span>
          <Clock3 size={13} />
          {formatDuration(run.startedAt, run.completedAt)}
        </span>
        <span>
          <GitBranch size={13} />
          {run.branch ?? 'Project branch'}
        </span>
        <span>{run.profile} profile</span>
        <span>{run.permissionMode}</span>
      </div>
      <div className="run-runtime-summary">
        <span>Elapsed: {formatMilliseconds(run.elapsedMs)}</span>
        {run.remainingMs !== null && <span>Run time remaining: {formatMilliseconds(run.remainingMs)}</span>}
        {run.status === 'paused_limit_reached' && (
          <strong>Maximum workflow duration reached. The working tree is preserved for inspection.</strong>
        )}
      </div>
      {run.summary && (
        <div className="run-summary-banner">
          <strong>Run summary</strong>
          <p>{run.summary}</p>
        </div>
      )}
      {run.status === 'waiting_for_user' &&
        run.stages.some(
          (stage) => stage.kind === 'promptRefinement' && stage.status === 'waiting_for_user',
        ) && (
          <PromptRefinementConfirmation
            runId={run.id}
            stage={run.stages.find(
              (stage) => stage.kind === 'promptRefinement' && stage.status === 'waiting_for_user',
            )!}
            onRefresh={onRefresh}
            onNotice={onNotice}
          />
        )}
      <div className="run-timeline">
        <div className="timeline-heading">
          <h3>Stages</h3>
          <span>
            {run.stages.filter((stage) => stage.status === 'passed').length} / {run.stages.length} complete
          </span>
        </div>
        <div className="stage-list">
          {run.stages.map((stage) => (
            <RunStageRow
              key={stage.id}
              stage={stage}
              findings={findings.filter((finding) => finding.stage_id === stage.id)}
            />
          ))}
        </div>
      </div>
      <section className="execution-activity">
        <div className="timeline-heading">
          <h3>Execution activity</h3>
          <span>{operations.length} brokered operations</span>
        </div>
        {operations.length ? (
          <div className="execution-operation-list">
            {operations.map((operation) => (
              <details className="execution-operation" key={operation.id}>
                <summary>
                  <strong>{humanize(operation.operationType)}</strong>
                  <span>{operation.classification}</span>
                  <span className={`status-pill status-${operation.status}`}>
                    {humanize(operation.status)}
                  </span>
                </summary>
                <dl>
                  <dt>Role</dt>
                  <dd>{operation.role}</dd>
                  <dt>Backend</dt>
                  <dd>
                    {operation.backendId} · {operation.providerId} · {operation.modelId}
                  </dd>
                  <dt>Directory</dt>
                  <dd>{operation.cwd}</dd>
                  <dt>Approval</dt>
                  <dd>
                    {operation.approvalRequired ? (operation.approvalId ?? 'Required') : 'Not required'}
                  </dd>
                  <dt>Action</dt>
                  <dd>
                    <pre>{JSON.stringify(operation.action, null, 2)}</pre>
                  </dd>
                  {(operation.stdout || operation.stderr) && (
                    <>
                      <dt>Result output</dt>
                      <dd>
                        <pre>{[operation.stdout, operation.stderr].filter(Boolean).join('\n')}</pre>
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No mediated provider tools have been requested yet.</div>
        )}
      </section>
      <section className="execution-activity git-activity">
        <div className="timeline-heading">
          <h3>Git activity</h3>
          <span>{gitOperations.length} recorded operations</span>
        </div>
        {gitOperations.length ? (
          <div className="execution-operation-list">
            {gitOperations.map((operation: GitOperation) => (
              <details className="execution-operation" key={operation.id}>
                <summary>
                  <strong>{humanize(operation.operation)}</strong>
                  <span>{operation.branch ?? 'No branch'}</span>
                  <span className={`status-pill status-${operation.status}`}>
                    {humanize(operation.status)}
                  </span>
                </summary>
                <dl>
                  <dt>Target</dt>
                  <dd>{operation.target ?? '—'}</dd>
                  <dt>Approval</dt>
                  <dd>
                    {operation.approvalRequired
                      ? (operation.approvalId ?? 'Required')
                      : 'Not required by this permission mode'}
                  </dd>
                  <dt>Before</dt>
                  <dd>{operation.beforeCommit ?? '—'}</dd>
                  <dt>After</dt>
                  <dd>{operation.afterCommit ?? '—'}</dd>
                  {operation.result && (
                    <>
                      <dt>Result</dt>
                      <dd>
                        <pre>{JSON.stringify(operation.result, null, 2)}</pre>
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No first-class Git operations have run.</div>
        )}
      </section>
      <DecisionResultsPanel decisions={details?.decisions ?? []} />
      <RuleListDetails rules={details?.effectiveRules ?? []} title="Saved rule snapshot" />
      {showDiff && (
        <div className="diff-viewer">
          <div className="diff-viewer-head">
            <h3>Current diff</h3>
            <button
              className="icon-button tiny-icon"
              onClick={() => setShowDiff(false)}
              aria-label="Close diff"
            >
              <X size={14} />
            </button>
          </div>
          {diff ? (
            <pre>{diff}</pre>
          ) : (
            <div className="empty-inline">No tracked changes are present in this working tree.</div>
          )}
        </div>
      )}
      {isActive && (
        <div className="intervention-box">
          <label className="form-field">
            <span className="sr-only">Intervene in this run</span>
            <textarea
              rows={2}
              maxLength={4_000}
              value={intervention}
              onChange={(event) => setIntervention(event.target.value)}
              placeholder="Add a constraint or redirect the next stage…"
            />
          </label>
          <button
            className="primary-button"
            onClick={() => void sendIntervention()}
            disabled={!intervention.trim()}
          >
            <Send size={14} />
            <span className="btn-label">Record intervention</span>
          </button>
        </div>
      )}
    </section>
  );
}

function PromptRefinementConfirmation({
  runId,
  stage,
  onRefresh,
  onNotice,
}: {
  runId: string;
  stage: RunSummary['stages'][number];
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [specification, setSpecification] = useState(String(stage.output?.specification ?? ''));
  const [clarification, setClarification] = useState('');
  const [busy, setBusy] = useState(false);
  const output = stage.output ?? {};
  const questions = Array.isArray(output.questions) ? output.questions : [];
  const ambiguities = Array.isArray(output.ambiguities) ? output.ambiguities : [];
  const confirm = async () => {
    if (!specification.trim()) return;
    setBusy(true);
    try {
      await api.confirmPromptRefinement(runId, specification, clarification);
      onRefresh();
      onNotice('Specification confirmed. The workflow is continuing with the approved task.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'The refined specification could not be confirmed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="prompt-refinement-card">
      <div className="prompt-refinement-heading">
        <Sparkles size={17} />
        <div>
          <h3>Review the refined task</h3>
          <p>The workflow is paused until you confirm this specification.</p>
        </div>
      </div>
      {ambiguities.length > 0 && (
        <div className="prompt-refinement-notes">
          <strong>Potential ambiguities</strong>
          <ul>
            {ambiguities.map((item, index) => (
              <li key={index}>{String(item)}</li>
            ))}
          </ul>
        </div>
      )}
      {questions.length > 0 ? (
        <div className="prompt-refinement-notes">
          <strong>Questions to consider</strong>
          <ul>
            {questions.map((item, index) => (
              <li key={index}>{String(item)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="prompt-refinement-clear">
          No material ambiguities were found. Review the draft before continuing.
        </p>
      )}
      <label className="form-field">
        <span>Refined specification</span>
        <textarea
          value={specification}
          onChange={(event) => setSpecification(event.target.value)}
          rows={7}
          maxLength={12_000}
        />
      </label>
      <label className="form-field">
        <span>
          Clarification or answer <small>Optional</small>
        </span>
        <textarea
          value={clarification}
          onChange={(event) => setClarification(event.target.value)}
          rows={3}
          maxLength={4_000}
          placeholder="Add any details that should guide the workflow."
        />
      </label>
      <button
        className="primary-button compact-button"
        onClick={() => void confirm()}
        disabled={busy || !specification.trim()}
      >
        {busy ? 'Continuing…' : 'Use this specification and continue'}
      </button>
    </section>
  );
}

function RunStageRow({
  stage,
  findings,
}: {
  stage: RunSummary['stages'][number];
  findings: Array<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(
    stage.status === 'running' || stage.status === 'failed' || stage.status === 'waiting_for_user',
  );
  const Icon = iconForStage(stage.kind);
  return (
    <details
      className={`run-stage-row stage-${stage.status}`}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="timeline-index">
          {stage.status === 'passed' ? <Check size={13} /> : <Icon size={14} />}
        </span>
        <span className="run-stage-copy">
          <strong>{stage.title}</strong>
          <small>
            {stage.backendId && stage.providerId && stage.modelId
              ? `${stage.backendId} · ${stage.providerId}/${stage.modelId}${stage.variantId ? ` · variant ${stage.variantId}` : ''}${stage.reasoning ? ` · native reasoning ${stage.reasoning}` : ''}`
              : stage.kind === 'test' || stage.kind === 'build'
                ? 'Project command'
                : stage.kind === 'gitCheckpoint'
                  ? 'Git checkpoint'
                  : stage.kind === 'gitCommit'
                    ? 'Git commit'
                    : stage.kind === 'gitPush'
                      ? 'Git push'
                      : stage.kind === 'gitMerge'
                        ? 'Approved fast-forward merge'
                        : stage.kind === 'gitRollback'
                          ? 'Approved restore'
                          : 'No model assigned'}
          </small>
        </span>
        <span className={`stage-status-label stage-label-${stage.status}`}>{humanStatus(stage.status)}</span>
        <span className="stage-duration">{formatDuration(stage.startedAt, stage.finishedAt)}</span>
        <ChevronDown size={14} className="stage-chevron" />
      </summary>
      <div className="stage-expanded">
        {stage.backendId && stage.modelId && (
          <div className="stage-model-history">
            <strong>Provider/model snapshot</strong>
            <span>
              {stage.modelSnapshot?.connectionProfileName ??
                stage.connectionProfileId ??
                'No saved connection profile'}{' '}
              · {billingLaneLabel(stage.billingLane ?? 'unknown')}
            </span>
            <span>
              {stage.modelSnapshot?.status?.toUpperCase() ?? 'LAST KNOWN'} · discovered{' '}
              {stage.modelSnapshot?.discoveredAt ?? 'unknown'} · adapter{' '}
              {stage.modelSnapshot?.adapterVersion ?? 'unknown'}
            </span>
            {stage.reasoning && <span>Provider-native reasoning: {stage.reasoning}</span>}
            {stage.variantId && <span>Provider-native variant: {stage.variantId}</span>}
            {stage.nativeSettings && Object.keys(stage.nativeSettings).length > 0 && (
              <pre>{JSON.stringify(stage.nativeSettings, null, 2)}</pre>
            )}
          </div>
        )}
        {stage.attempts.length > 0 && (
          <div className="attempt-history">
            <strong>Provider attempts</strong>
            {stage.attempts.map((attempt) => (
              <div key={attempt.id}>
                <span>
                  Attempt {attempt.attempt}
                  {attempt.reviewerIndex ? ` · reviewer ${attempt.reviewerIndex}` : ''}
                </span>
                <span className={`status-pill status-${attempt.status}`}>{humanStatus(attempt.status)}</span>
                {attempt.category && <small>{humanize(attempt.category)}</small>}
                {attempt.error && <small>{attempt.error}</small>}
              </div>
            ))}
          </div>
        )}
        {stage.error && (
          <div className="stage-error-message">
            <AlertTriangle size={14} />
            {stage.error}
          </div>
        )}
        {findings.length > 0 && (
          <div className="findings-list">
            {findings.map((finding, itemIndex) => (
              <div className="finding-row" key={String(finding.id ?? itemIndex)}>
                <span className={`severity severity-${String(finding.severity)}`}>
                  {String(finding.severity)}
                </span>
                <div>
                  <strong>{String(finding.description)}</strong>
                  <p>{String(finding.evidence ?? '')}</p>
                  <small>
                    {String(finding.category)} ·{' '}
                    {Array.isArray(finding.affected_files_json)
                      ? finding.affected_files_json.join(', ')
                      : String(finding.affected_files_json ?? '')}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
        {stage.output && <StageOutput output={stage.output} />}
        {stage.logs && (
          <div className="raw-log">
            <span>PROCESS LOG</span>
            <pre>{stage.logs}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function StageOutput({ output }: { output: Record<string, unknown> }) {
  if (typeof output.specification === 'string')
    return (
      <div className="stage-output">
        <strong>
          {typeof output.confirmedSpecification === 'string'
            ? 'Confirmed specification'
            : 'Proposed specification'}
        </strong>
        <pre>{String(output.confirmedSpecification ?? output.specification)}</pre>
        {Array.isArray(output.questions) && output.questions.length > 0 && (
          <ul>
            {output.questions.map((question, index) => (
              <li key={index}>{String(question)}</li>
            ))}
          </ul>
        )}
        {typeof output.clarification === 'string' && output.clarification && (
          <p>
            <strong>User clarification:</strong> {output.clarification}
          </p>
        )}
      </div>
    );
  if (Array.isArray(output.reviewers))
    return (
      <div className="stage-output">
        <strong>Parallel reviewers</strong>
        <p>{String(output.findingCount ?? 0)} structured findings recorded</p>
      </div>
    );
  if (typeof output.text === 'string')
    return (
      <div className="stage-output">
        <strong>Agent output</strong>
        <pre>{output.text}</pre>
        {typeof output.usageProvenance === 'string' && (
          <small>
            Usage:{' '}
            {output.usageProvenance === 'provider_reported'
              ? 'provider-reported tokens'
              : 'token telemetry unavailable'}
          </small>
        )}
      </div>
    );
  if (output.skipped)
    return (
      <div className="stage-output">
        <strong>Stage skipped</strong>
        <p>{String(output.reason ?? '')}</p>
      </div>
    );
  return (
    <div className="stage-output">
      <pre>{JSON.stringify(output, null, 2)}</pre>
    </div>
  );
}

function UsagePage(_props: { snapshot: DashboardSnapshot }) {
  // Quota envelopes compare against a 30-day window; all other analytics come from UsageExplorer.
  const windowSize = '30d' as const;
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [quotaMessage, setQuotaMessage] = useState('');
  const [savingQuota, setSavingQuota] = useState(false);
  const [quotaDraft, setQuotaDraft] = useState(() => {
    const now = new Date();
    return {
      providerId: '',
      quotaName: '',
      windowLabel: 'Weekly',
      effectiveAt: toDateTimeLocal(now),
      resetAt: toDateTimeLocal(new Date(now.getTime() + 7 * 86_400_000)),
      allowance: '',
      unit: 'total_tokens' as const,
      notes: '',
      subscriptionCostUsd: '',
    };
  });
  useEffect(() => {
    let live = true;
    void api
      .usage(windowSize)
      .then((value) => {
        if (live) {
          setData(value);
          setError('');
        }
      })
      .catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : 'Usage could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [windowSize]);
  useEffect(() => {
    if (!quotaDraft.providerId && quotaProviderOptions.length)
      setQuotaDraft((current) => ({ ...current, providerId: quotaProviderOptions[0]!.id }));
  }, [quotaDraft.providerId]);
  const providers = Array.isArray(data?.providers) ? (data.providers as Array<Record<string, unknown>>) : [];
  const quotas = Array.isArray(data?.quotas) ? (data.quotas as Array<Record<string, unknown>>) : [];
  const usageByProvider = new Map(providers.map((provider) => [String(provider.key), provider]));
  const saveQuota = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingQuota(true);
    setQuotaMessage('');
    try {
      await api.saveQuotaEnvelope({
        providerId: quotaDraft.providerId,
        quotaName: quotaDraft.quotaName.trim(),
        windowLabel: quotaDraft.windowLabel.trim(),
        effectiveAt: new Date(quotaDraft.effectiveAt).toISOString(),
        resetAt: new Date(quotaDraft.resetAt).toISOString(),
        allowance: Number(quotaDraft.allowance),
        unit: quotaDraft.unit,
        notes: quotaDraft.notes,
        subscriptionCostUsd: quotaDraft.subscriptionCostUsd.trim()
          ? Number(quotaDraft.subscriptionCostUsd)
          : null,
      });
      setData(await api.usage(windowSize));
      setQuotaMessage('Quota envelope saved. Its allowance source is user configured.');
    } catch (reason) {
      setQuotaMessage(reason instanceof Error ? reason.message : 'Quota envelope could not be saved.');
    } finally {
      setSavingQuota(false);
    }
  };
  const removeQuota = async (id: string) => {
    try {
      await api.deleteQuotaEnvelope(id);
      setData(await api.usage(windowSize));
      setQuotaMessage('Quota envelope removed.');
    } catch (reason) {
      setQuotaMessage(reason instanceof Error ? reason.message : 'Quota envelope could not be removed.');
    }
  };
  return (
    <main className="page-content">
      <PageHeading
        title="Usage"
        description="Tokens, requests, and spend by provider lane, model, role, and project — one shared query drives every card, chart, table, and export."
      />
      <div className="usage-honesty-banner">
        <div>
          <Radio size={17} />
          <strong>Provenance stays visible · reconciled, never double-counted</strong>
          <span>
            Quota calculations use your manually entered allowance/reset and this master’s observed usage.
            They are estimates, not provider telemetry.
          </span>
        </div>
        <span className="status-pill status-attention">Sources stay visible</span>
      </div>
      {error && (
        <div className="form-error">
          <AlertTriangle size={15} />
          {error}
        </div>
      )}
      <UsageExplorer />
      <section className="surface-panel quota-envelope-panel">
        <div className="panel-title-row">
          <div>
            <h2>User-configured quota envelopes</h2>
            <p>
              Enter values you know from your provider account. Turing never fills allowance or reset values
              for you.
            </p>
          </div>
          <Radio size={16} className="muted-icon" />
        </div>
        {quotaMessage && <div className="inline-callout quota-feedback">{quotaMessage}</div>}
        <form className="quota-envelope-form" onSubmit={(event) => void saveQuota(event)}>
          <label className="form-field">
            <span>Provider</span>
            <select
              required
              value={quotaDraft.providerId}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, providerId: event.target.value })}
            >
              {quotaProviderOptions.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Quota name</span>
            <input
              required
              maxLength={100}
              value={quotaDraft.quotaName}
              placeholder="Claude weekly allowance"
              onChange={(event) => setQuotaDraft({ ...quotaDraft, quotaName: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Window label</span>
            <input
              required
              maxLength={80}
              value={quotaDraft.windowLabel}
              placeholder="Weekly"
              onChange={(event) => setQuotaDraft({ ...quotaDraft, windowLabel: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Allowance</span>
            <input
              required
              type="number"
              min="0.000001"
              step="any"
              value={quotaDraft.allowance}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, allowance: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Unit</span>
            <select
              value={quotaDraft.unit}
              onChange={(event) =>
                setQuotaDraft({ ...quotaDraft, unit: event.target.value as typeof quotaDraft.unit })
              }
            >
              <option value="total_tokens">Total tokens</option>
              <option value="input_tokens">Input tokens</option>
              <option value="output_tokens">Output tokens</option>
              <option value="requests">Requests (local)</option>
              <option value="minutes">Process minutes (local)</option>
            </select>
          </label>
          <label className="form-field">
            <span>Effective from</span>
            <input
              required
              type="datetime-local"
              value={quotaDraft.effectiveAt}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, effectiveAt: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Reset at</span>
            <input
              required
              type="datetime-local"
              value={quotaDraft.resetAt}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, resetAt: event.target.value })}
            />
          </label>
          <label className="form-field">
            <span>Subscription cost per month (USD, optional)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={quotaDraft.subscriptionCostUsd}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, subscriptionCostUsd: event.target.value })}
            />
          </label>
          <label className="form-field quota-notes-field">
            <span>Notes</span>
            <textarea
              maxLength={1_000}
              rows={2}
              value={quotaDraft.notes}
              onChange={(event) => setQuotaDraft({ ...quotaDraft, notes: event.target.value })}
            />
          </label>
          <button
            className="primary-button quota-save-button"
            type="submit"
            disabled={savingQuota || !quotaDraft.providerId}
          >
            <Save size={14} /> {savingQuota ? 'Saving…' : 'Save envelope'}
          </button>
        </form>
        {quotas.length ? (
          <div className="quota-envelope-list">
            {quotas.map((quota) => {
              const forecast = quota.forecast as Record<string, unknown>;
              const providerUsage = usageByProvider.get(String(quota.providerId));
              const estimatedCost =
                providerUsage?.costProvenance === 'estimated' &&
                typeof providerUsage.estimatedCostUsd === 'number'
                  ? providerUsage.estimatedCostUsd
                  : null;
              const subscriptionCost =
                typeof quota.subscriptionCostUsd === 'number' ? quota.subscriptionCostUsd : null;
              const monthlyRatio =
                windowSize === '30d' && estimatedCost !== null && subscriptionCost
                  ? estimatedCost / subscriptionCost
                  : null;
              return (
                <article className="quota-envelope-card" key={String(quota.id)}>
                  <div className="quota-envelope-heading">
                    <div>
                      <strong>{String(quota.quotaName)}</strong>
                      <small>
                        {String(quota.providerId)} · {String(quota.windowLabel)}
                      </small>
                    </div>
                    <span className="status-pill status-attention">USER CONFIGURED</span>
                  </div>
                  <div className="quota-envelope-values">
                    <span>
                      Allowance{' '}
                      <strong>
                        {Number(quota.allowance).toLocaleString()} {quotaUnitLabel(String(quota.unit))}
                      </strong>
                    </span>
                    <span>
                      Observed{' '}
                      <strong>
                        {forecast.observedUsed === null
                          ? 'Unavailable'
                          : `${Number(forecast.observedUsed).toLocaleString()} ${quotaUnitLabel(String(quota.unit))}`}
                      </strong>
                      <small>{humanize(String(forecast.usageProvenance ?? 'unavailable'))}</small>
                    </span>
                    <span>
                      Estimated remaining{' '}
                      <strong>
                        {forecast.remaining === null
                          ? 'Unavailable'
                          : `${Number(forecast.remaining).toLocaleString()} ${quotaUnitLabel(String(quota.unit))}`}
                      </strong>
                    </span>
                    <span>
                      Average burn{' '}
                      <strong>
                        {forecast.averagePerDay === null
                          ? 'Unavailable'
                          : `${Number(forecast.averagePerDay).toLocaleString(undefined, { maximumFractionDigits: 1 })} / day`}
                      </strong>
                    </span>
                    <span>
                      Projected exhaustion{' '}
                      <strong>
                        {forecast.projectedExhaustionAt
                          ? formatDate(String(forecast.projectedExhaustionAt))
                          : 'Not enough measured burn data'}
                      </strong>
                      <small>
                        {forecast.likelyBeforeReset === null
                          ? 'Cannot compare with reset'
                          : forecast.likelyBeforeReset
                            ? 'Likely before reset'
                            : 'Not projected before reset'}
                      </small>
                    </span>
                    <span>
                      Reset <strong>{formatDate(String(quota.resetAt))}</strong>
                      <small>USER CONFIGURED</small>
                    </span>
                    <span>
                      Forecast confidence{' '}
                      <strong>{humanize(String(forecast.confidence ?? 'unavailable'))}</strong>
                      <small>Based on {String(forecast.sampleCount ?? 0)} local usage events</small>
                    </span>
                    <span>
                      API-equivalent value{' '}
                      <strong>
                        {estimatedCost === null
                          ? 'Unavailable for this model/window'
                          : `$${estimatedCost.toFixed(2)} USD · ESTIMATED`}
                      </strong>
                      <small>
                        {monthlyRatio === null
                          ? 'Requires 30-day view, matching public price, and monthly subscription cost'
                          : `${monthlyRatio.toFixed(2)}× configured monthly cost`}
                      </small>
                    </span>
                  </div>
                  {typeof quota.notes === 'string' && quota.notes && (
                    <p className="quota-notes">{quota.notes}</p>
                  )}
                  <button className="text-button" onClick={() => void removeQuota(String(quota.id))}>
                    Remove envelope
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-inline">No manual quota envelopes configured.</div>
        )}
      </section>
      <div className="usage-footnote">
        <Shield size={14} />
        <span>
          Actual metered spend is PROVIDER MEASURED where the provider reports it. API-equivalent values use
          exact public model prices with measured tokens; they are ESTIMATED and are not billed spend.
          Unavailable metrics are never shown as zero. Quota forecasts use USER CONFIGURED limits plus this
          master’s recorded usage.
        </span>
      </div>
    </main>
  );
}

function MachinesPage({
  snapshot,
  profiles,
  onAddProfile,
  onRemoveProfile,
  onReachability,
  onSelectProfile,
}: {
  snapshot: DashboardSnapshot;
  profiles: MachineProfile[];
  onAddProfile: (origin: string, name: string) => boolean;
  onRemoveProfile: (origin: string) => void;
  onReachability: (origin: string, reachability: 'online' | 'offline') => void;
  onSelectProfile: (profile: MachineProfile) => void;
}) {
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const onReachabilityRef = useRef(onReachability);
  const profilesRef = useRef(profiles);
  onReachabilityRef.current = onReachability;
  profilesRef.current = profiles;
  const otherOrigins = profiles
    .map((profile) => profile.origin)
    .filter((profileOrigin) => profileOrigin !== window.location.origin)
    .sort();
  const probeKey = otherOrigins.join('|');

  useEffect(() => {
    if (!probeKey) return;
    let active = true;
    const check = () => {
      void Promise.all(
        profilesRef.current
          .filter((profile) => profile.origin !== window.location.origin)
          .map(async (profile) => {
            const reachability = await probeMachine(profile);
            if (active) onReachabilityRef.current(profile.origin, reachability);
          }),
      );
    };
    check();
    const timer = window.setInterval(check, 20_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [probeKey]);

  const currentProfile = profiles.find((profile) => profile.origin === window.location.origin);
  const activeRuns = snapshot.runs.filter((run) => activeStatuses.has(run.status)).length;
  return (
    <main className="page-content">
      <PageHeading
        title="Machines"
        description="Choose a directly paired desktop master. Runs stay on the machine selected in this browser."
        actions={<span className="status-pill status-ready">{profiles.length} saved</span>}
      />
      <section className="surface-panel machine-list-panel">
        <div className="panel-title-row">
          <div>
            <h2>Machine profiles</h2>
            <p>Profiles are stored on this device. Pair this browser separately with every master.</p>
          </div>
          <Monitor size={17} className="muted-icon" />
        </div>
        {profiles.map((profile) => {
          const selected = profile.origin === window.location.origin;
          const status = selected ? 'online' : profile.reachability;
          return (
            <div className="machine-card-row" key={profile.origin}>
              <span className="machine-symbol machine-symbol-large">
                <Monitor size={19} />
              </span>
              <div className="machine-card-main">
                <strong>
                  {profile.name}
                  {selected ? ' · selected' : ''}
                </strong>
                <span>
                  {profile.hostname && profile.os ? `${profile.hostname} · ${profile.os}` : profile.origin}
                </span>
                {profile.machineId && <small>Machine ID {profile.machineId}</small>}
                <small>
                  {selected
                    ? `${snapshot.projects.length} projects · ${activeRuns} active runs · ${snapshot.providers.filter((provider) => provider.detected).length} providers detected`
                    : `Last reachable ${profile.lastSeenAt ? formatDate(profile.lastSeenAt) : 'not yet checked'}`}
                </small>
              </div>
              <span className={`status-pill status-${status}`}>
                {status === 'unknown' ? 'Checking' : humanize(status)}
              </span>
              <button
                className={selected ? 'quiet-button' : 'secondary-button'}
                disabled={selected}
                onClick={() => onSelectProfile(profile)}
              >
                {selected ? 'Selected' : 'Connect'}
              </button>
              {!selected && (
                <button
                  className="quiet-button"
                  aria-label={`Remove ${profile.name}`}
                  onClick={() => onRemoveProfile(profile.origin)}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
        {currentProfile && (
          <div className="machine-capability-row">
            <span>{snapshot.projects.length} projects on selected machine</span>
            <span>{activeRuns} active runs</span>
            <span>
              {snapshot.providers.filter((provider) => provider.detected).length} provider CLIs detected
            </span>
          </div>
        )}
      </section>
      <section className="surface-panel settings-section machine-profile-form">
        <div className="panel-title-row">
          <div>
            <h2>Add a desktop master</h2>
            <p>Enter its Tailscale Serve HTTPS address. Its pairing cookie stays scoped to that address.</p>
          </div>
          <Plus size={17} className="muted-icon" />
        </div>
        <div className="form-grid-two">
          <label className="form-field">
            <span>Machine name</span>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="form-field">
            <span>Serve address</span>
            <input
              value={origin}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://desktop.tailnet.ts.net"
              onChange={(event) => setOrigin(event.target.value)}
            />
          </label>
        </div>
        <button
          className="primary-button align-right"
          disabled={!name.trim() || !origin.trim()}
          onClick={() => {
            if (onAddProfile(origin, name)) {
              setName('');
              setOrigin('');
            }
          }}
        >
          <Plus size={14} /> Save machine profile
        </button>
      </section>
      <section className="connection-unavailable">
        <span>
          <Smartphone size={20} />
        </span>
        <div>
          <h2>Direct machine selection</h2>
          <p>
            Connect opens the chosen master in this browser and carries only profile metadata. That master
            then serves its own projects, providers, approvals, and runs; no request is rerouted if it is
            unavailable.
          </p>
          <strong>
            Each master must be online through Tailscale Serve and paired on this browser before it can be
            controlled.
          </strong>
        </div>
      </section>
    </main>
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

function SettingsPage({
  snapshot,
  onNotice,
  onChanged,
}: {
  snapshot: DashboardSnapshot;
  onNotice: (message: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(snapshot.machine.name);
  const [notifications, setNotifications] = useState(
    () => typeof Notification !== 'undefined' && Notification.permission === 'granted',
  );
  const [pushConfig, setPushConfig] = useState<{
    enabled: boolean;
    publicKey: string | null;
    reason: string | null;
  } | null>(null);
  const pushStorageKey = pushSubscriptionStorageKey(window.location.origin);
  const [pushSubscribed, setPushSubscribed] = useState(() =>
    Boolean(window.localStorage.getItem(pushStorageKey)),
  );
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNotice, setPushNotice] = useState('');
  useEffect(() => {
    let live = true;
    void api
      .webPushConfig()
      .then((config) => {
        if (live) setPushConfig(config);
      })
      .catch((reason) => {
        if (live) setPushNotice(reason instanceof Error ? reason.message : 'Push readiness is unavailable.');
      });
    return () => {
      live = false;
    };
  }, []);
  const updateMachineName = async () => {
    try {
      await api.renameMachine(name);
      onChanged();
      onNotice('Machine name updated.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Machine name could not be saved.');
    }
  };
  const enableNotifications = async () => {
    if (!('Notification' in window)) {
      onNotice('Browser notifications are not supported here.');
      return;
    }
    const result = await Notification.requestPermission();
    setNotifications(result === 'granted');
    onNotice(
      result === 'granted'
        ? 'Browser notifications enabled for this browser.'
        : 'Notification permission was not granted.',
    );
  };
  const enableClosedPush = async () => {
    setPushBusy(true);
    setPushNotice('');
    try {
      if (!pushConfig?.enabled || !pushConfig.publicKey)
        throw new Error(pushConfig?.reason ?? 'Closed-client Web Push is not configured on this master.');
      if (!('serviceWorker' in navigator) || !('PushManager' in window))
        throw new Error('This browser does not support Web Push. Open-client notifications may still work.');
      if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        setNotifications(permission === 'granted');
        if (permission !== 'granted') throw new Error('Notification permission was not granted.');
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidPublicKey(pushConfig.publicKey),
        }));
      const value = subscription.toJSON();
      if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth)
        throw new Error('The browser returned an incomplete Web Push subscription.');
      const saved = await api.savePushSubscription({
        endpoint: value.endpoint,
        keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
      });
      window.localStorage.setItem(pushStorageKey, saved.id);
      setPushSubscribed(true);
      setPushNotice('Closed-client Web Push is enabled for this browser.');
    } catch (reason) {
      setPushNotice(reason instanceof Error ? reason.message : 'Web Push could not be enabled.');
    } finally {
      setPushBusy(false);
    }
  };
  const disableClosedPush = async () => {
    setPushBusy(true);
    try {
      const id = window.localStorage.getItem(pushStorageKey);
      if (id) await api.deletePushSubscription(id);
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        await subscription?.unsubscribe();
      }
      window.localStorage.removeItem(pushStorageKey);
      setPushSubscribed(false);
      setPushNotice('Closed-client Web Push was disabled for this browser.');
    } catch (reason) {
      setPushNotice(reason instanceof Error ? reason.message : 'Web Push could not be disabled.');
    } finally {
      setPushBusy(false);
    }
  };
  return (
    <main className="page-content">
      <PageHeading
        title="Settings"
        description="Local master identity, provider health, and safety boundaries."
      />
      <div className="settings-grid">
        <DesktopSettingsCard />
        <section className="surface-panel settings-section">
          <div className="panel-title-row">
            <div>
              <h2>Machine identity</h2>
              <p>Shown in run previews and machine selection.</p>
            </div>
            <Laptop size={17} className="muted-icon" />
          </div>
          <label className="form-field">
            <span>Machine name</span>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <button className="primary-button align-right" onClick={() => void updateMachineName()}>
            <Save size={14} />
            Save name
          </button>
          <div className="settings-readonly-row">
            <span>Hostname</span>
            <strong>{snapshot.machine.hostname}</strong>
          </div>
          <div className="settings-readonly-row">
            <span>Operating system</span>
            <strong>{snapshot.machine.os}</strong>
          </div>
        </section>
        <section className="surface-panel settings-section">
          <div className="panel-title-row">
            <div>
              <h2>Provider integrations</h2>
              <p>Authentication stays in each provider’s official CLI.</p>
            </div>
            <LockKeyhole size={17} className="muted-icon" />
          </div>
          {snapshot.providers.map((provider) => (
            <div className="settings-provider-row" key={provider.id}>
              <span className={`provider-mark provider-mark-${provider.id}`}>
                {provider.name.slice(0, 1)}
              </span>
              <div>
                <strong>{provider.name}</strong>
                <small>
                  {provider.detected
                    ? `${provider.version ?? provider.cli} · auth ${provider.authentication}`
                    : 'CLI not detected'}
                </small>
                <p>{provider.note}</p>
                <p className="capability-line">
                  Supports:{' '}
                  {Object.entries(provider.capabilities)
                    .filter(([, enabled]) => enabled)
                    .map(([key]) => humanize(key).toLowerCase())
                    .join(', ') || 'nothing reported'}
                </p>
              </div>
            </div>
          ))}
        </section>
        <TailscaleReadinessCard />
        <section className="surface-panel settings-section">
          <div className="panel-title-row">
            <div>
              <h2>Permission modes</h2>
              <p>Turing mediates supported providers through project-scoped tools and approval policy.</p>
            </div>
            <Shield size={17} className="muted-icon" />
          </div>
          <PermissionInfo
            name="Supervised"
            text="Read-only requests proceed. File changes, commands, Git operations, and unfamiliar actions wait for your approval. Secret access and project-boundary escapes are always denied."
          />
          <PermissionInfo
            name="Normal"
            text="Routine edits and configured build/test/lint scripts proceed. Deletes, commits, pushes, merges, rollbacks, and unfamiliar operations ask first."
          />
          <PermissionInfo
            name="YOLO"
            text="Routine edits and deletes run autonomously. Push, merge, rollback, network, and destructive Git actions remain approval-gated."
          />
          <PermissionInfo
            name="ENIGMA"
            text="Broad supported project edits and deletes may run without approval after explicit per-run activation. Secret and out-of-project access remain denied; push, merge, rollback, network, and destructive Git actions still require approval."
          />
        </section>
        <OpenRouterSettings onNotice={onNotice} />
        <MeteredBudgetSettingsPanel onNotice={onNotice} />
        <RulesSettings projects={snapshot.projects} onNotice={onNotice} />
        <PairingSettings onNotice={onNotice} />
        <section className="surface-panel settings-section">
          <div className="panel-title-row">
            <div>
              <h2>Notifications</h2>
              <p>Browser notifications for this device.</p>
            </div>
            <Bell size={17} className="muted-icon" />
          </div>
          <div className="toggle-line">
            <span className="notification-setting-copy">
              <strong>{notifications ? 'Notifications enabled' : 'Notifications disabled'}</strong>
              <small>
                {isDesktopShell()
                  ? 'Browser notifications appear while the desktop app is open. Use the paired mobile PWA for closed-client Web Push.'
                  : 'Browser notifications appear while Turing Terminal is open. Closed-client Web Push is configured separately below.'}
              </small>
            </span>
            <button
              className="secondary-button"
              onClick={() => void enableNotifications()}
              disabled={notifications}
            >
              {notifications ? <Check size={14} /> : <Bell size={14} />}
              {notifications ? 'Enabled' : 'Enable notifications'}
            </button>
          </div>
          {isDesktopShell() ? (
            <div className="settings-boundary">
              <Bell size={15} />
              <span>
                Closed-client Web Push remains available from the paired mobile PWA in your browser.
              </span>
            </div>
          ) : (
            <>
              <div className="toggle-line push-notification-line">
                <span className="notification-setting-copy">
                  <strong>{pushSubscribed ? 'Closed-client push enabled' : 'Closed-client push'}</strong>
                  <small>
                    {pushConfig?.enabled
                      ? 'The master sends standards-based Web Push. Browser vendor push relays deliver while this page is closed.'
                      : (pushConfig?.reason ?? 'Checking master push configuration…')}
                  </small>
                </span>
                {pushSubscribed ? (
                  <button
                    className="secondary-button"
                    onClick={() => void disableClosedPush()}
                    disabled={pushBusy}
                  >
                    {pushBusy ? 'Disabling…' : 'Disable push'}
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => void enableClosedPush()}
                    disabled={pushBusy || !pushConfig?.enabled}
                  >
                    <Bell size={14} /> {pushBusy ? 'Enabling…' : 'Enable closed-client push'}
                  </button>
                )}
              </div>
              {pushNotice && <div className="inline-callout quota-feedback">{pushNotice}</div>}
            </>
          )}
        </section>
      </div>
      <div className="settings-boundary">
        <AlertTriangle size={16} />
        <span>
          <strong>Bind the master to loopback.</strong> For remote phone access, use Tailscale Serve over
          HTTPS; Turing requires both a paired device token and the Tailscale user identity header.
        </span>
      </div>
    </main>
  );
}

function DesktopSettingsCard() {
  const [runtime, setRuntime] = useState<DesktopRuntime | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    if (!isDesktopShell()) return;
    void desktop
      .runtime()
      .then(setRuntime)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Desktop status could not be read.'),
      );
  }, []);
  useEffect(() => {
    if (!isDesktopShell()) return;
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  if (!isDesktopShell()) return null;

  const toggleKeepOpen = async () => {
    if (!runtime) return;
    setBusy(true);
    setError('');
    try {
      await desktop.setKeepMasterOnClose(!runtime.keepMasterOnClose);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The close preference could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const toggleLogin = async () => {
    if (!runtime) return;
    setBusy(true);
    setError('');
    try {
      await desktop.setStartAtLogin(!runtime.startAtLogin);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The sign-in preference could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const restartMaster = async () => {
    setBusy(true);
    setError('');
    try {
      await desktop.restartMaster();
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Desktop Master could not be restarted.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="surface-panel settings-section">
      <div className="panel-title-row">
        <div>
          <h2>Desktop application</h2>
          <p>Bundled Master process, startup options, and local system readiness.</p>
        </div>
        <Monitor size={17} className="muted-icon" />
      </div>
      {runtime ? (
        <>
          <div className="settings-readonly-row">
            <span>Desktop Master</span>
            <strong>
              {runtime.status}
              {runtime.port ? ` · 127.0.0.1:${runtime.port}` : ''}
            </strong>
          </div>
          <div className="settings-readonly-row">
            <span>Version</span>
            <strong>{runtime.version}</strong>
          </div>
          <div className="settings-readonly-row">
            <span>Application data</span>
            <strong>{runtime.dataPath}</strong>
          </div>
          <div className="settings-readonly-row">
            <span>System readiness</span>
            <strong>
              {runtime.tools.filter((tool) => tool.installed).length}/{runtime.tools.length} optional tools
              found
            </strong>
          </div>
          <div className="capability-tags desktop-readiness-tags">
            {runtime.tools.map((tool) => (
              <span key={tool.id} className={tool.installed ? 'readiness-available' : 'readiness-missing'}>
                {tool.installed ? '✓' : '○'} {tool.name}
              </span>
            ))}
          </div>
          <div className="toggle-line">
            <span className="notification-setting-copy">
              <strong>Keep Master running when this window closes</strong>
              <small>
                On by default. Turn it off to stop a Master started by this app when the window closes.
              </small>
            </span>
            <button
              className="secondary-button"
              onClick={() => void toggleKeepOpen()}
              disabled={busy || !runtime}
            >
              {runtime.keepMasterOnClose ? 'On' : 'Off'}
            </button>
          </div>
          <div className="toggle-line">
            <span className="notification-setting-copy">
              <strong>Start Turing Terminal when I sign in</strong>
              <small>
                Runs in the background at login. Optional tools are never installed automatically.
              </small>
            </span>
            <button
              className="secondary-button"
              onClick={() => void toggleLogin()}
              disabled={busy || !runtime}
            >
              {runtime.startAtLogin ? 'On' : 'Off'}
            </button>
          </div>
          {runtime.error && <div className="form-error">{runtime.error}</div>}
          {error && <div className="form-error">{error}</div>}
          <div className="desktop-diagnostics-actions">
            <button
              className="secondary-button"
              onClick={() => void restartMaster()}
              disabled={busy || (runtime.status === 'Running' && !runtime.startedByApp)}
            >
              <RefreshCw size={14} /> Restart Master
            </button>
            <button className="secondary-button" onClick={() => void desktop.openLogFolder()}>
              Open log folder
            </button>
          </div>
          <small>Logs: {runtime.logPath}</small>
          {runtime.tools.some((tool) => !tool.installed) && (
            <p>
              Missing optional command-line tools only disable their related integrations. Install and sign in
              to a tool to make it available.
            </p>
          )}
        </>
      ) : (
        <p>{error || 'Loading desktop status…'}</p>
      )}
    </section>
  );
}

function TailscaleReadinessCard() {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.tailscaleReadiness>>['tailscale'] | null>(
    null,
  );
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    setError('');
    void api
      .tailscaleReadiness()
      .then((result) => setState(result.tailscale))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Tailscale readiness check failed.'),
      );
  }, []);
  useEffect(() => refresh(), [refresh]);
  return (
    <section className="surface-panel settings-section tailscale-readiness">
      <div className="panel-title-row">
        <div>
          <h2>Tailscale readiness</h2>
          <p>Local CLI check for this master; the Serve identity is checked on the request itself.</p>
        </div>
        <RefreshCw size={16} className="muted-icon" />
      </div>
      {error ? (
        <div className="form-error">{error}</div>
      ) : state ? (
        <>
          <div className="settings-readonly-row">
            <span>Connection</span>
            <strong className={state.connectionHealth === 'ready' ? 'readiness-good' : 'readiness-attention'}>
              {state.message}
            </strong>
          </div>
          <div className="settings-readonly-row">
            <span>Tailscale</span>
            <strong>
              {state.installed
                ? state.running
                  ? 'Installed · running'
                  : 'Installed · stopped'
                : 'Not installed'}
            </strong>
          </div>
          {state.hostname && (
            <div className="settings-readonly-row">
              <span>This machine</span>
              <strong>
                {state.hostname}
                {state.ips.length ? ` · ${state.ips.join(', ')}` : ''}
              </strong>
            </div>
          )}
          <div className="settings-readonly-row">
            <span>Serve → loopback master</span>
            <strong>
              {state.serveConfigured === null
                ? 'Could not inspect'
                : state.serveConfigured
                  ? 'Configured'
                  : 'Not configured'}
            </strong>
          </div>
          <div className="settings-readonly-row">
            <span>Identity header on this request</span>
            <strong>{state.identityHeaderPresent ? 'Present' : 'Not present · local request'}</strong>
          </div>
          <small className="readiness-footnote">
            {state.identityObservation} Peer devices and tailnet account details are never returned.
          </small>
        </>
      ) : (
        <div className="settings-readonly-row">
          <span>Connection</span>
          <strong>Checking…</strong>
        </div>
      )}
      <button className="secondary-button align-right" onClick={refresh}>
        <RefreshCw size={14} /> Check again
      </button>
    </section>
  );
}

function PairingSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.pairingRequests>>['requests']>([]);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof api.pairedDevices>>['devices']>([]);
  const [newCode, setNewCode] = useState<{
    id: string;
    code: string;
    expiresAt: string;
    qrDataUrl: string | null;
  } | null>(null);
  const [serveOrigin, setServeOrigin] = useState(window.location.origin);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [requestResult, deviceResult] = await Promise.all([api.pairingRequests(), api.pairedDevices()]);
      setRequests(requestResult.requests);
      setDevices(deviceResult.devices);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Paired device status could not be loaded.');
    }
  }, [onNotice]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!newCode) return;
    let live = true;
    const qrUrl = makePairingQrUrl(serveOrigin, newCode.id);
    if (!qrUrl) {
      setNewCode((current) =>
        current?.id === newCode.id && current.qrDataUrl !== null ? { ...current, qrDataUrl: null } : current,
      );
      return () => {
        live = false;
      };
    }
    void QRCode.toDataURL(qrUrl, { width: 240, margin: 2 })
      .then((qrDataUrl) => {
        if (!live) return;
        setNewCode((current) =>
          current?.id === newCode.id && current.qrDataUrl !== qrDataUrl ? { ...current, qrDataUrl } : current,
        );
      })
      .catch(() => {
        if (live)
          setNewCode((current) => (current?.id === newCode.id ? { ...current, qrDataUrl: null } : current));
      });
    return () => {
      live = false;
    };
  }, [newCode, serveOrigin]);
  const createRequest = async () => {
    setBusy(true);
    try {
      const result = await api.createPairingRequest();
      setNewCode({
        id: result.request.id,
        code: result.request.code,
        expiresAt: result.request.expiresAt,
        qrDataUrl: null,
      });
      await load();
      onNotice('Short-lived pairing QR and fallback code created. Use them only on the device being paired.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Pairing request could not be created.');
    } finally {
      setBusy(false);
    }
  };
  const approve = async (id: string) => {
    try {
      await api.approvePairingRequest(id);
      await load();
      onNotice('Device pairing approved.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Device pairing could not be approved.');
    }
  };
  const deny = async (id: string) => {
    try {
      await api.denyPairingRequest(id);
      await load();
      onNotice('Pairing request denied.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Pairing request could not be denied.');
    }
  };
  const revoke = async (id: string, name: string) => {
    try {
      await api.revokePairedDevice(id);
      await load();
      onNotice(`${name} was revoked.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Device could not be revoked.');
    }
  };
  return (
    <section className="surface-panel settings-section pairing-settings">
      <div className="panel-title-row">
        <div>
          <h2>Paired devices</h2>
          <p>Remote access uses Tailscale Serve. Each device needs desktop approval and an expiring token.</p>
        </div>
        <Smartphone size={17} className="muted-icon" />
      </div>
      <button className="secondary-button" onClick={() => void createRequest()} disabled={busy}>
        <Plus size={14} /> Create pairing code
      </button>
      <label className="form-field pairing-origin-field">
        <span>HTTPS Tailscale Serve address for QR</span>
        <input
          value={serveOrigin}
          onChange={(event) => setServeOrigin(event.target.value)}
          placeholder="https://desktop.example.ts.net"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      {newCode && (
        <div className="pairing-code-display">
          {newCode.qrDataUrl ? (
            <img src={newCode.qrDataUrl} alt="Short-lived Turing Terminal device pairing QR code" />
          ) : (
            <small>QR needs an HTTPS Serve origin with no path or query. Use the manual code below.</small>
          )}
          <strong>{newCode.code}</strong>
          <small>
            Enter this on the phone before {formatDate(newCode.expiresAt)}. Keep this code private.
          </small>
          <small>QR contains only the Serve origin and short-lived request ID; no code or credentials.</small>
        </div>
      )}
      <div className="pairing-settings-list">
        <strong>Requests</strong>
        {requests.length ? (
          requests.slice(0, 6).map((request) => (
            <div className="pairing-device-row" key={request.id}>
              <span>
                <strong>{request.deviceName}</strong>
                <small>
                  {request.tailscaleLogin ?? 'Waiting for phone'} · expires {formatDate(request.expiresAt)}
                </small>
              </span>
              <span className={`status-pill status-${request.status}`}>{humanize(request.status)}</span>
              {request.status === 'awaiting_approval' && (
                <span className="pairing-request-actions">
                  <button className="secondary-button" onClick={() => void approve(request.id)}>
                    Approve
                  </button>
                  <button className="secondary-button" onClick={() => void deny(request.id)}>
                    Deny
                  </button>
                </span>
              )}
            </div>
          ))
        ) : (
          <small>No pairing requests.</small>
        )}
      </div>
      <div className="pairing-settings-list">
        <strong>Devices</strong>
        {devices.length ? (
          devices.map((device) => (
            <div className="pairing-device-row" key={device.id}>
              <span>
                <strong>{device.name}</strong>
                <small>
                  {device.tailscaleLogin ?? 'Tailscale identity unavailable'} · last seen{' '}
                  {device.lastSeenAt ? formatDate(device.lastSeenAt) : 'never'}
                </small>
              </span>
              <span className={`status-pill status-${device.status}`}>{humanize(device.status)}</span>
              <small>Expires {formatDate(device.expiresAt)}</small>
              <button className="quiet-button" onClick={() => void revoke(device.id, device.name)}>
                Revoke
              </button>
            </div>
          ))
        ) : (
          <small>No devices are paired.</small>
        )}
      </div>
    </section>
  );
}

function RulesSettings({
  projects,
  onNotice,
}: {
  projects: ProjectProfile[];
  onNotice: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [rules, setRules] = useState<TuringRule[]>([]);
  const [scope, setScope] = useState<TuringRule['scope']>('global');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState(0);
  const [mandatory, setMandatory] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [appliesToAll, setAppliesToAll] = useState(true);
  const [appliesTo, setAppliesTo] = useState<StageKind[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stageKinds = Object.keys(stageLabels) as StageKind[];

  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) setProjectId(projects[0]?.id ?? '');
  }, [projects, projectId]);

  const loadRules = useCallback(async () => {
    try {
      const result = await api.rules(projectId || undefined);
      setRules(result.rules);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rules could not be loaded.');
    }
  }, [onNotice, projectId]);
  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const clearForm = () => {
    setEditingId(null);
    setScope('global');
    setName('');
    setDescription('');
    setContent('');
    setPriority(0);
    setMandatory(false);
    setEnabled(true);
    setAppliesToAll(true);
    setAppliesTo([]);
  };
  const editRule = (rule: TuringRule) => {
    setEditingId(rule.id);
    setScope(rule.scope);
    setProjectId(rule.projectId ?? projectId);
    setName(rule.name);
    setDescription(rule.description);
    setContent(rule.content);
    setPriority(rule.priority);
    setMandatory(rule.mandatory);
    setEnabled(rule.enabled);
    setAppliesToAll(rule.appliesTo.length === 0);
    setAppliesTo(rule.appliesTo);
  };
  const saveRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !content.trim()) return;
    if (!appliesToAll && appliesTo.length === 0) {
      onNotice('Choose at least one stage or enable “Apply to all workflow stages.”');
      return;
    }
    setBusy(true);
    try {
      await api.saveRule(
        {
          scope,
          projectId: scope === 'project' ? projectId : null,
          name: name.trim(),
          description: description.trim(),
          content: content.trim(),
          enabled,
          priority,
          mandatory,
          appliesTo: appliesToAll ? [] : appliesTo,
        },
        editingId ?? undefined,
      );
      await loadRules();
      clearForm();
      onNotice(editingId ? 'Rule updated. New runs will use its new version.' : 'Rule created.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rule could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const toggleRule = async (rule: TuringRule) => {
    try {
      await api.saveRule({ ...rule, enabled: !rule.enabled }, rule.id);
      await loadRules();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rule could not be updated.');
    }
  };
  const removeRule = async (rule: TuringRule) => {
    try {
      await api.deleteRule(rule.id);
      await loadRules();
      if (editingId === rule.id) clearForm();
      onNotice('Rule deleted. Saved run snapshots remain unchanged.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Rule could not be deleted.');
    }
  };

  return (
    <section className="surface-panel settings-section rules-settings">
      <div className="panel-title-row">
        <div>
          <h2>Global and project rules</h2>
          <p>
            New runs snapshot enabled rules. Mandatory rules rank first; within that level project rules
            precede global rules, then higher priority wins.
          </p>
        </div>
        <Shield size={17} className="muted-icon" />
      </div>
      <label className="form-field">
        <span>Project rules to manage</span>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Select a project</option>
          {projects.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <form className="rule-editor-form" onSubmit={(event) => void saveRule(event)}>
        <div className="form-grid-two">
          <label className="form-field">
            <span>Scope</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as TuringRule['scope'])}>
              <option value="global">Global</option>
              <option value="project" disabled={!projectId}>
                Selected project
              </option>
            </select>
          </label>
          <label className="form-field">
            <span>Priority (-100 to 100)</span>
            <input
              type="number"
              min={-100}
              max={100}
              value={priority}
              onChange={(event) => setPriority(Math.max(-100, Math.min(100, Number(event.target.value))))}
            />
          </label>
        </div>
        <label className="form-field">
          <span>Rule name</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="form-field">
          <span>Description</span>
          <input
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="form-field">
          <span>Instruction</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={8_000}
            rows={4}
            required
            placeholder="Describe a durable project convention or restriction."
          />
        </label>
        <label className="rule-flag">
          <input
            type="checkbox"
            checked={mandatory}
            onChange={(event) => setMandatory(event.target.checked)}
          />
          Mandatory: lower-priority rules cannot override this rule
        </label>
        <label className="rule-flag">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled for new runs
        </label>
        <label className="rule-flag">
          <input
            type="checkbox"
            checked={appliesToAll}
            onChange={(event) => setAppliesToAll(event.target.checked)}
          />
          Apply to all workflow stages
        </label>
        {!appliesToAll && (
          <div className="rule-stage-grid">
            {stageKinds.map((kind) => (
              <label className="rule-flag" key={kind}>
                <input
                  type="checkbox"
                  checked={appliesTo.includes(kind)}
                  onChange={(event) =>
                    setAppliesTo((current) =>
                      event.target.checked ? [...current, kind] : current.filter((item) => item !== kind),
                    )
                  }
                />
                {stageLabels[kind]}
              </label>
            ))}
          </div>
        )}
        <div className="rule-form-actions">
          {editingId && (
            <button type="button" className="secondary-button" onClick={clearForm}>
              Cancel edit
            </button>
          )}
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !name.trim() || !content.trim() || (scope === 'project' && !projectId)}
          >
            <Save size={14} />
            {editingId ? 'Save rule' : 'Add rule'}
          </button>
        </div>
      </form>
      <div className="managed-rule-list">
        {rules.map((rule) => (
          <article className={`managed-rule ${rule.enabled ? '' : 'managed-rule-disabled'}`} key={rule.id}>
            <div>
              <strong>{rule.name}</strong>
              <small>
                {rule.scope} · priority {rule.priority} · {rule.mandatory ? 'mandatory' : 'advisory'}
                {rule.appliesTo.length
                  ? ` · ${rule.appliesTo.map((kind) => stageLabels[kind]).join(', ')}`
                  : ' · all stages'}
              </small>
              <p>{rule.description || rule.content}</p>
            </div>
            <div className="managed-rule-actions">
              <button className="quiet-button" onClick={() => void toggleRule(rule)}>
                {rule.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="quiet-button" onClick={() => editRule(rule)}>
                Edit
              </button>
              <button className="quiet-button danger-text" onClick={() => void removeRule(rule)}>
                Delete
              </button>
            </div>
          </article>
        ))}
        {!rules.length && <div className="empty-inline">No global or selected project rules yet.</div>}
      </div>
    </section>
  );
}

function RuleListDetails({ rules, title }: { rules: TuringRule[]; title: string }) {
  return (
    <details className="rule-snapshot">
      <summary>
        {title} <span>{rules.length}</span>
      </summary>
      {rules.length ? (
        <ol>
          {rules.map((rule) => (
            <li key={rule.id}>
              <strong>
                {rule.mandatory ? 'Mandatory' : 'Advisory'} · {rule.scope} · {rule.name}
              </strong>
              <p>{rule.content}</p>
              <small>
                Priority {rule.priority}
                {rule.appliesTo.length
                  ? ` · ${rule.appliesTo.map((kind) => stageLabels[kind]).join(', ')}`
                  : ' · all stages'}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <p>No rules were active for this run.</p>
      )}
    </details>
  );
}

function PermissionInfo({
  name,
  text,
  disabled = false,
}: {
  name: string;
  text: string;
  disabled?: boolean;
}) {
  return (
    <div className={`permission-info ${disabled ? 'permission-disabled' : ''}`}>
      <span className={`permission-dot ${disabled ? '' : 'permission-dot-on'}`} />
      <div>
        <strong>
          {name}
          {disabled && <small>Unavailable</small>}
        </strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Meta({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
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
function EmptyState({
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
function StatusIcon({ status }: { status: string }) {
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
function iconForStage(kind: StageKind): LucideIcon {
  return {
    planner: Sparkles,
    promptRefinement: Sparkles,
    implementer: FileCode2,
    build: TerminalSquare,
    test: CheckCircle2,
    reviewer: Search,
    parallelReview: Search,
    consolidate: GitCompareArrows,
    orchestrator: Sparkles,
    remediation: RefreshCw,
    finalGate: Shield,
    gitCheckpoint: GitCommitHorizontal,
    gitCommit: GitCommitHorizontal,
    gitPush: GitBranch,
    gitMerge: GitCompareArrows,
    gitRollback: RefreshCw,
    conditionalBranch: GitCompareArrows,
    shellCommand: TerminalSquare,
    notification: Bell,
    humanApproval: LockKeyhole,
    decisionGate: Scale,
  }[kind];
}
function isAiStage(kind: StageKind): boolean {
  return [
    'planner',
    'promptRefinement',
    'implementer',
    'reviewer',
    'parallelReview',
    'consolidate',
    'orchestrator',
    'remediation',
    'finalGate',
  ].includes(kind);
}
function humanStatus(value: string): string {
  const text = value.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function humanize(value: string): string {
  return value
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
    .replace(/^./, (letter) => letter.toUpperCase());
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function shortTask(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const duration = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime());
  const seconds = Math.floor(duration / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function rowTime(run: RunSummary): string {
  if (activeStatuses.has(run.status)) return formatMilliseconds(run.elapsedMs);
  const then = new Date(run.completedAt ?? run.createdAt).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}
function formatMilliseconds(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, durationMs) / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function toDateTimeLocal(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function quotaUnitLabel(unit: string): string {
  return (
    {
      input_tokens: 'input tokens',
      output_tokens: 'output tokens',
      total_tokens: 'tokens',
      requests: 'requests',
      minutes: 'minutes',
    }[unit] ?? unit
  );
}
function commandText(command: string[] | null): string {
  return command?.join(' ') ?? '';
}
function parseCommand(value: string): string[] | null {
  const parts = value.trim().split(/\s+/);
  return !value.trim() ? null : parts.length === 3 ? parts : null;
}

export default App;
