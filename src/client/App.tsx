import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
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
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Mic,
  Monitor,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
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
import { notificationsForSnapshot } from './notificationEvents.js';
import type {
  Approval,
  DashboardSnapshot,
  ExecutionOperation,
  ExecutionProfile,
  GitOperation,
  PermissionMode,
  ProjectProfile,
  ProviderStatus,
  RunPreview,
  RunSummary,
  StageKind,
  WorkflowCondition,
  WorkflowConditionPath,
  TuringRule,
  WorkflowDefinition,
  WorkflowStage,
} from '../shared/types';
import { api } from './api';
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

type Page = 'command' | 'workflows' | 'projects' | 'runs' | 'usage' | 'machines' | 'settings';

const navItems: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: 'command', label: 'Command Center', icon: LayoutDashboard },
  { id: 'workflows', label: 'Workflows', icon: WorkflowIcon },
  { id: 'projects', label: 'Projects', icon: FileCode2 },
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
const stageLabels: Record<StageKind, string> = {
  planner: 'Planner',
  promptRefinement: 'Prompt refinement',
  implementer: 'Implementer',
  build: 'Build',
  test: 'Test',
  reviewer: 'Reviewer',
  parallelReview: 'Parallel review',
  consolidate: 'Consolidation',
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
    const events = new EventSource(`/api/events?runId=${encodeURIComponent(selectedRunId)}`);
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
  const pageLabel = navItems.find((item) => item.id === page)?.label ?? 'Command Center';
  const activeRuns = snapshot?.runs.filter((run) => activeStatuses.has(run.status)) ?? [];
  const selectedRun = snapshot?.runs.find((run) => run.id === selectedRunId) ?? null;

  if (requiresPairing) return <DevicePairingPage onPaired={pairedSuccessfully} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`} aria-label="Primary navigation">
        <button
          className="brand-lockup"
          onClick={() => changePage('command')}
          aria-label="Turing Terminal home"
        >
          <span className="brand-mark">
            <Command size={17} strokeWidth={2.2} />
          </span>
          <span className="brand-name">
            Turing Terminal<small>LOCAL CONTROL PLANE</small>
          </span>
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="primary-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-link ${page === id ? 'nav-link-active' : ''}`}
              onClick={() => changePage(id)}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon size={17} strokeWidth={1.8} /> <span>{label}</span>
              {id === 'runs' && activeRuns.length > 0 && (
                <span className="nav-count">{activeRuns.length}</span>
              )}
              {id === 'runs' && snapshot && snapshot.approvals.length > 0 && (
                <span
                  className="nav-alert-dot"
                  aria-label={`${snapshot.approvals.length} approvals pending`}
                />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="machine-rail">
          <span className="presence-dot" />
          <span className="machine-rail-copy">
            <strong>{snapshot?.machine.name ?? 'Desktop master'}</strong>
            <small>Local machine · online</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <div className="sidebar-foot">
          TURING TERMINAL <span>V1.0.0</span>
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
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{pageLabel}</strong>
          </div>
          <div className="topbar-right">
            <span className="connection-state">
              <span className="presence-dot" /> Desktop master online
            </span>
            <button
              className="icon-button notification-button"
              aria-label={
                snapshot?.approvals.length
                  ? `${snapshot.approvals.length} pending approvals`
                  : 'Notifications'
              }
              onClick={() => changePage('runs')}
            >
              <Bell size={17} />
              {(snapshot?.approvals.length ?? 0) > 0 && <i />}
            </button>
            <span className="avatar-small">TT</span>
          </div>
        </header>

        {error && (
          <div className="global-error" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button onClick={() => void refresh()}>
              <RefreshCw size={14} /> Retry
            </button>
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
            {page === 'runs' && snapshot && (
              <RunsPage
                snapshot={snapshot}
                selectedRun={selectedRun}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                onRefresh={() => refresh(true)}
                onNotice={setNotice}
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
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button
          className={page === 'command' ? 'mobile-nav-active' : ''}
          onClick={() => changePage('command')}
        >
          <LayoutDashboard size={19} />
          <span>Home</span>
        </button>
        <button className={page === 'runs' ? 'mobile-nav-active' : ''} onClick={() => changePage('runs')}>
          <Activity size={19} />
          <span>Runs</span>
        </button>
        <button
          className="mobile-launch"
          onClick={() => changePage('command')}
          aria-label="Launch a workflow"
        >
          <Plus size={23} />
          <span>Launch</span>
        </button>
        <button className={page === 'usage' ? 'mobile-nav-active' : ''} onClick={() => changePage('usage')}>
          <Radio size={19} />
          <span>Usage</span>
        </button>
        <button
          className={
            page === 'settings' || page === 'machines' || page === 'projects' || page === 'workflows'
              ? 'mobile-nav-active'
              : ''
          }
          onClick={() => setMobileMenuOpen(true)}
        >
          <Menu size={19} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

function DevicePairingPage({ onPaired }: { onPaired: () => void }) {
  const [deviceName, setDeviceName] = useState('My phone');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!requestId || !code) return;
    let live = true;
    const check = async () => {
      try {
        const result = await api.completePairing(requestId, code);
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
  }, [requestId, code, onPaired]);

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.claimPairing(code.trim().toUpperCase(), deviceName.trim());
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
          Open this page through the desktop’s Tailscale Serve address. Enter the short-lived code shown in
          Turing Terminal on that desktop. The desktop owner must approve this device before it can view runs.
        </p>
        <label className="form-field">
          <span>Device name</span>
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} />
        </label>
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
            disabled={busy || code.length !== 16 || !deviceName.trim()}
          >
            {busy ? 'Checking code…' : 'Request approval'}
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
  const [refinePrompt, setRefinePrompt] = useState(
    snapshot.workflows.find((workflow) => workflow.id === workflowId)?.promptRefinementDefault ?? false,
  );
  const [enigmaConfirmed, setEnigmaConfirmed] = useState(false);
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!snapshot.projects.some((project) => project.id === projectId))
      setProjectId(snapshot.projects[0]?.id ?? '');
    if (!snapshot.workflows.some((workflow) => workflow.id === workflowId))
      setWorkflowId(snapshot.workflows[0]?.id ?? '');
  }, [snapshot.projects, snapshot.workflows, projectId, workflowId]);

  const selectedProject = snapshot.projects.find((project) => project.id === projectId);
  const selectedWorkflow = snapshot.workflows.find((workflow) => workflow.id === workflowId);
  const missingAssignments =
    selectedWorkflow?.stages.filter(
      (stage) =>
        stage.enabled !== false &&
        isAiStage(stage.kind) &&
        !(stage.backendId && stage.providerId && stage.modelId),
    ) ?? [];

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

  return (
    <main className="page-content command-page">
      <PageHeading
        title="Command Center"
        description="Set the context. Review the execution plan. Then let the desktop master work."
        actions={
          <div className="machine-chip">
            <Laptop size={16} />
            <span>{snapshot.machine.name}</span>
            <span className="presence-dot" />
          </div>
        }
      />
      {snapshot.approvals.length > 0 && <ApprovalInbox approvals={snapshot.approvals} onNotice={onNotice} />}
      <div className="command-layout">
        <section className="launch-column" aria-label="Launch a workflow">
          <form className="launch-form surface-panel" onSubmit={makePreview}>
            <div className="panel-title-row">
              <div>
                <h2>Start a workflow</h2>
                <p>Your task stays on this machine and follows its saved workflow.</p>
              </div>
              <span className="panel-spark">
                <Sparkles size={17} />
              </span>
            </div>
            <label className="field-label" htmlFor="task-input">
              What should the agents do?
            </label>
            <div className="task-field-wrap">
              <textarea
                id="task-input"
                rows={5}
                maxLength={12_000}
                placeholder="Describe the change, the behavior you expect, and any constraints…"
                value={task}
                onChange={(event) => {
                  setTask(event.target.value);
                  setPreview(null);
                }}
              />
              <div className="task-field-footer">
                <span>{task.length.toLocaleString()} / 12,000</span>
                <button
                  className={`voice-button ${listening ? 'voice-live' : ''}`}
                  type="button"
                  onClick={beginVoice}
                  aria-pressed={listening}
                >
                  <Mic size={15} />
                  {listening ? 'Listening…' : 'Voice input'}
                </button>
              </div>
            </div>
            <div className="form-grid-two">
              <label className="form-field">
                <span>Project</span>
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
              <label className="form-field">
                <span>Workflow</span>
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
                    and out-of-project paths stay blocked; network, destructive commands, Git pushes, merges,
                    and rollbacks remain approval-gated.
                  </p>
                </div>
              </label>
            )}
            {missingAssignments.length > 0 && (
              <div className="inline-callout">
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
              </div>
            )}
            {!selectedProject && (
              <div className="inline-callout">
                <FileCode2 size={16} />
                <div>
                  <strong>No project registered</strong>
                  <p>Add a local repository before creating a run.</p>
                </div>
                <button type="button" className="text-button" onClick={() => onNavigate('projects')}>
                  Add project <ChevronRight size={14} />
                </button>
              </div>
            )}
            {preview ? (
              <div className="preview-actions">
                <button type="button" className="secondary-button" onClick={() => setPreview(null)}>
                  Edit request
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void start()}
                  disabled={!preview.canStart || busy || (permissionMode === 'enigma' && !enigmaConfirmed)}
                >
                  <Play size={15} fill="currentColor" />
                  {busy ? 'Starting…' : 'Start workflow'}
                </button>
              </div>
            ) : (
              <button
                type="submit"
                className="primary-button review-run-button"
                disabled={busy || !task.trim() || !projectId || !workflowId}
              >
                <Search size={15} />
                {busy ? 'Preparing preview…' : 'Review run preview'}
                <ChevronRight size={15} />
              </button>
            )}
          </form>

          {preview && <RunPreviewPanel preview={preview} />}
          {pending.length > 0 && (
            <section className="active-runs-block">
              <div className="section-title-row">
                <div>
                  <h2>Active runs</h2>
                  <p>Running on {snapshot.machine.name}</p>
                </div>
                <button className="text-button" onClick={() => onNavigate('runs')}>
                  View all <ChevronRight size={14} />
                </button>
              </div>
              <div className="compact-run-list">
                {pending.slice(0, 3).map((run) => (
                  <RunListRow run={run} key={run.id} onSelect={() => onStart(run.id)} />
                ))}
              </div>
            </section>
          )}
          <RecentRuns
            runs={snapshot.runs.filter((run) => !activeStatuses.has(run.status)).slice(0, 4)}
            onSelect={onStart}
            onAll={() => onNavigate('runs')}
          />
        </section>

        <aside className="command-inspector">
          <ProviderHealth providers={snapshot.providers} onNavigate={() => onNavigate('settings')} />
          <section className="surface-panel inspector-panel">
            <div className="section-title-row">
              <div>
                <h2>Machine</h2>
                <p>Execution target for this workspace</p>
              </div>
              <Laptop size={17} className="muted-icon" />
            </div>
            <div className="machine-detail-row">
              <span className="machine-symbol">
                <Monitor size={17} />
              </span>
              <span>
                <strong>{snapshot.machine.name}</strong>
                <small>
                  {snapshot.machine.hostname} · {snapshot.machine.os}
                </small>
              </span>
              <span className="status-pill status-online">Online</span>
            </div>
            <div className="inspector-data-row">
              <span>Projects</span>
              <strong>{snapshot.projects.length}</strong>
            </div>
            <div className="inspector-data-row">
              <span>Active runs</span>
              <strong>{pending.length}</strong>
            </div>
            <button className="quiet-button full-width" onClick={() => onNavigate('machines')}>
              Manage machines <ChevronRight size={14} />
            </button>
          </section>
          <section className="surface-panel inspector-panel usage-summary-panel">
            <div className="section-title-row">
              <div>
                <h2>Activity today</h2>
                <p>Locally observed, not a quota meter</p>
              </div>
              <Radio size={17} className="muted-icon" />
            </div>
            <div className="usage-inline-stats">
              <div>
                <strong>{snapshot.usage.events}</strong>
                <span>provider & process events</span>
              </div>
              <div>
                <strong>
                  {snapshot.usage.localMinutesToday}
                  <small>m</small>
                </strong>
                <span>process time today</span>
              </div>
            </div>
            <div className="quiet-note">
              <LockKeyhole size={14} />
              <span>Provider allowance is unavailable unless the provider reports it.</span>
            </div>
            <button className="quiet-button full-width" onClick={() => onNavigate('usage')}>
              Open usage dashboard <ChevronRight size={14} />
            </button>
          </section>
        </aside>
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
        <span className={`status-pill ${preview.canStart ? 'status-ready' : 'status-attention'}`}>
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
              {stage.label}
            </span>
          ))}
        </div>
      </div>
      <RuleListDetails rules={preview.effectiveRules} title="Effective run rules" />
      {preview.providerAssignments.length > 0 && (
        <div className="assignment-summary">
          {preview.providerAssignments.map((item) => (
            <div key={`${item.stage}-${item.backendId}`}>
              <span className={item.ready ? 'assignment-dot-ready' : 'assignment-dot-error'} />
              {item.stage}
              <strong>
                {item.ready
                  ? `${item.backendId} · ${item.providerId}/${item.modelId}`
                  : 'Needs provider/model setup'}
              </strong>
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
        <Shield size={14} /> Credentials remain on the desktop. No OpenAI or Anthropic API-key fallback is
        enabled.
      </p>
    </section>
  );
}

function ApprovalInbox({
  approvals,
  onNotice,
}: {
  approvals: Approval[];
  onNotice: (message: string) => void;
}) {
  return (
    <section className="approval-inbox" aria-label="Approvals requiring attention">
      <div className="approval-inbox-head">
        <div>
          <span className="approval-icon">
            <LockKeyhole size={17} />
          </span>
          <div>
            <h2>Approval required</h2>
            <p>
              {approvals.length} workflow {approvals.length === 1 ? 'action needs' : 'actions need'} your
              decision before continuing.
            </p>
          </div>
        </div>
      </div>
      <div className="approval-items">
        {approvals.slice(0, 2).map((approval) => (
          <div className="approval-item" key={approval.id}>
            <div className="approval-copy">
              <strong>{approval.operation}</strong>
              <pre className="approval-reason">{approval.reason}</pre>
              <small>Risk: {capitalize(approval.risk)}</small>
            </div>
            <div className="approval-actions">
              <button className="secondary-button" onClick={() => void decide(approval.id, false)}>
                Deny
              </button>
              <button
                className="primary-button compact-button"
                onClick={() => void decide(approval.id, true)}
              >
                <Check size={14} />
                Approve once
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
  async function decide(id: string, approved: boolean) {
    try {
      await api.decideApproval(id, approved);
      onNotice(approved ? 'Approval recorded.' : 'Approval denied.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not save that decision.');
    }
  }
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

function RecentRuns({
  runs,
  onSelect,
  onAll,
}: {
  runs: RunSummary[];
  onSelect: (id: string) => void;
  onAll: () => void;
}) {
  return (
    <section className="recent-runs-block">
      <div className="section-title-row">
        <div>
          <h2>Recent runs</h2>
          <p>Finished and interrupted work</p>
        </div>
        <button className="text-button" onClick={onAll}>
          History <ChevronRight size={14} />
        </button>
      </div>
      {runs.length ? (
        <div className="compact-run-list">
          {runs.map((run) => (
            <RunListRow key={run.id} run={run} onSelect={() => onSelect(run.id)} />
          ))}
        </div>
      ) : (
        <div className="empty-inline">
          <Clock3 size={17} />
          <span>No completed runs yet. Your run history will appear here.</span>
        </div>
      )}
    </section>
  );
}

function RunListRow({ run, onSelect }: { run: RunSummary; onSelect: () => void }) {
  const stage =
    run.stages.find((item) => item.status === 'running') ??
    run.stages.find((item) => item.status === 'failed');
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
      <span className={`status-pill status-${run.status}`}>{humanStatus(run.status)}</span>
      <ChevronRight size={15} className="row-chevron" />
    </button>
  );
}

function WorkflowsPage({
  workflows,
  providers,
  onSaved,
  onNotice,
}: {
  workflows: WorkflowDefinition[];
  providers: ProviderStatus[];
  onSaved: () => void;
  onNotice: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(workflows[0]?.id ?? '');
  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0];
  const [draft, setDraft] = useState<WorkflowDefinition | null>(selected ?? null);
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState('');

  useEffect(() => {
    if (!workflows.some((workflow) => workflow.id === selectedId)) setSelectedId(workflows[0]?.id ?? '');
  }, [workflows, selectedId]);
  useEffect(() => {
    setDraft(selected ?? null);
    setValidationMessage('');
  }, [selectedId, selected?.version, selected?.updatedAt]);
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
      const created = await api.saveWorkflow(
        { ...workflow, id: '', version: 1, isDefault: false, createdAt: '', updatedAt: '' },
        true,
      );
      onSaved();
      setSelectedId(created.workflow.id);
      setDraft(created.workflow);
      onNotice('Workflow imported. Review its provider/model assignments before running.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Workflow import failed.');
    }
  };

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
        <aside className="workflow-list-panel surface-panel">
          <div className="panel-title-row">
            <div>
              <h2>Templates</h2>
              <p>Editable starting points</p>
            </div>
            <WorkflowIcon size={17} className="muted-icon" />
          </div>
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
        </aside>

        <section className="workflow-editor">
          <div className="surface-panel workflow-settings-panel">
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
                <input
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
            </div>
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
                checked={draft.promptRefinementDefault}
                disabled={
                  !draft.stages.some((stage) => stage.kind === 'promptRefinement' && stage.enabled !== false)
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

          <div className="stage-editor-heading">
            <div>
              <h2>Stage sequence</h2>
              <p>
                Drag to reorder, or use the arrow controls. Select a backend, provider, and model on each AI
                stage.
              </p>
            </div>
            <button className="secondary-button" onClick={addStage}>
              <Plus size={14} />
              Add reviewer stage
            </button>
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

function WorkflowStageEditor({
  stage,
  index,
  count,
  stages,
  providers,
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
  onChange: (patch: Partial<WorkflowStage>) => void;
  onMove: (direction: number) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const Icon = iconForStage(stage.kind);
  const backend = providers.find((provider) => provider.id === stage.backendId);
  const discovered = backend?.models ?? [];
  const modelListId = `models-${stage.id}`;
  const aiStage = isAiStage(stage.kind);
  const updateCondition = (condition: NonNullable<WorkflowStage['condition']>) => onChange({ condition });
  const laterStages = stages.filter((_, stageIndex) => stageIndex > index);
  return (
    <article
      className={`workflow-stage-node ${stage.enabled === false ? 'workflow-stage-disabled' : ''}`}
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
        </div>
        <div className="stage-node-config">
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
                          ].includes(event.target.value)
                        ? undefined
                        : (stage.role ?? event.target.value),
                  condition:
                    event.target.value === 'conditionalBranch'
                      ? (stage.condition ?? { path: 'build.success', operator: 'equals', value: true })
                      : undefined,
                  skipStageIds:
                    event.target.value === 'conditionalBranch' ? (stage.skipStageIds ?? []) : undefined,
                  command:
                    event.target.value === 'shellCommand'
                      ? (stage.command ?? ['npm', 'run', 'test'])
                      : undefined,
                  notificationMessage:
                    event.target.value === 'notification' ? (stage.notificationMessage ?? '') : undefined,
                  commitMessage: event.target.value === 'gitCommit' ? (stage.commitMessage ?? '') : undefined,
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
                  value={stage.backendId ?? ''}
                  onChange={(event) =>
                    onChange({
                      backendId: event.target.value || undefined,
                      providerId:
                        event.target.value === 'claude-code'
                          ? 'anthropic-subscription'
                          : event.target.value === 'codex-cli'
                            ? 'openai-codex'
                            : stage.providerId,
                      modelId: '',
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
                  value={stage.providerId ?? ''}
                  onChange={(event) => onChange({ providerId: event.target.value })}
                  placeholder={
                    stage.backendId === 'cline'
                      ? 'openai-codex or cline-pass'
                      : stage.backendId === 'claude-code'
                        ? 'anthropic-subscription'
                        : stage.backendId === 'codex-cli'
                          ? 'openai-codex'
                          : 'openai, openai-codex, opencode-go'
                  }
                />
              </label>
              <label className="form-field stage-model-field">
                <span>Model {discovered.length > 0 && <small>· discovered</small>}</span>
                <input
                  list={discovered.length ? modelListId : undefined}
                  value={stage.modelId ?? ''}
                  onChange={(event) => {
                    const modelId = event.target.value;
                    const discoveredModel = discovered.find((model) => model.id === modelId);
                    onChange({
                      modelId,
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
                <small>Force push is never used. Push always waits for approval, including in ENIGMA.</small>
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
            <label className="form-field reasoning-field">
              <span>Reasoning level</span>
              <select
                value={stage.reasoning ?? ''}
                onChange={(event) => onChange({ reasoning: event.target.value || undefined })}
              >
                <option value="">Provider default</option>
                {['minimal', 'low', 'medium', 'high', 'xhigh'].map((level) => (
                  <option value={level} key={level}>
                    {capitalize(level)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="stage-node-foot">
          <label className="toggle-line compact-toggle">
            <input
              type="checkbox"
              checked={stage.enabled !== false}
              onChange={(event) => onChange({ enabled: event.target.checked })}
            />
            <span>Stage enabled</span>
          </label>
          <span>
            {aiStage
              ? stage.backendId && stage.providerId && stage.modelId
                ? `${stage.backendId} · ${stage.providerId}/${stage.modelId}`
                : 'Provider and model required'
              : stage.kind === 'build' || stage.kind === 'test'
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
                          : 'No model assignment required'}
          </span>
        </div>
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
      <div className="projects-layout">
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
      <div className="metadata-grid">
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
      </div>
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
}: {
  snapshot: DashboardSnapshot;
  selectedRun: RunSummary | null;
  selectedRunId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const runs = snapshot.runs.filter(
    (run) => filter === 'all' || activeStatuses.has(run.status) === (filter === 'active'),
  );
  return (
    <main className="page-content">
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
      {snapshot.approvals.length > 0 && <ApprovalInbox approvals={snapshot.approvals} onNotice={onNotice} />}
      <div className={`runs-layout ${selectedRun ? 'runs-detail-open' : ''}`}>
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
          ) : (
            <EmptyState
              icon={Activity}
              title="No runs match"
              body="Start a workflow from Command Center or change the filter."
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
          <section className="run-inspector-empty surface-panel">
            <Activity size={21} />
            <h2>Select a run</h2>
            <p>Stage output, approvals, findings, and Git changes appear here.</p>
          </section>
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
  const findings = details?.findings ?? [];
  const gitOperations = details?.gitOperations ?? [];
  return (
    <section className="run-detail-panel surface-panel">
      <div className="run-detail-top">
        <button
          className="icon-button tiny-icon run-close-button"
          aria-label="Close run detail"
          onClick={onClose}
        >
          <X size={15} />
        </button>
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
        {run.stages.map((stage) => (
          <RunStageRow
            key={stage.id}
            stage={stage}
            findings={findings.filter((finding) => finding.stage_id === stage.id)}
          />
        ))}
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
      <RuleListDetails rules={details?.effectiveRules ?? []} title="Saved rule snapshot" />
      <div className="run-detail-tools">
        <button className="secondary-button" onClick={() => void loadDiff()}>
          <GitCompareArrows size={14} />
          View diff
        </button>
        {run.status === 'paused' || run.status === 'failed' ? (
          <button className="primary-button compact-button" onClick={() => void resume()}>
            <Play size={14} />
            Resume run
          </button>
        ) : isActive ? (
          <button
            className="secondary-button danger-button"
            onClick={() =>
              void api
                .cancelRun(run.id)
                .then(() => {
                  onRefresh();
                  onNotice('Stop requested. The provider process is being terminated.');
                })
                .catch((error) => onNotice(error.message))
            }
          >
            <StopCircle size={14} />
            Stop run
          </button>
        ) : null}
      </div>
      {isActive && (
        <div className="intervention-box">
          <label className="form-field">
            <span>Intervene in this run</span>
            <textarea
              rows={2}
              maxLength={4_000}
              value={intervention}
              onChange={(event) => setIntervention(event.target.value)}
              placeholder="Add a constraint or redirect the next stage…"
            />
          </label>
          <button
            className="secondary-button"
            onClick={() => void sendIntervention()}
            disabled={!intervention.trim()}
          >
            <Send size={14} />
            Record intervention
          </button>
        </div>
      )}
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
              ? `${stage.backendId} · ${stage.providerId}/${stage.modelId}`
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

function UsagePage({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [windowSize, setWindowSize] = useState<'today' | '7d' | '30d'>('7d');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
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
  const providers = Array.isArray(data?.providers) ? (data.providers as Array<Record<string, unknown>>) : [];
  const models = Array.isArray(data?.models) ? (data.models as Array<Record<string, unknown>>) : [];
  const projects = Array.isArray(data?.projects) ? (data.projects as Array<Record<string, unknown>>) : [];
  const daily = Array.isArray(data?.daily) ? (data.daily as Array<Record<string, unknown>>) : [];
  const maxDuration = Math.max(1, ...daily.map((item) => Number(item.duration_ms ?? 0)));
  return (
    <main className="page-content">
      <PageHeading
        title="Usage"
        description="Observed workflow activity, separated from provider quotas and billing estimates."
        actions={
          <div className="window-switcher" role="group" aria-label="Usage time window">
            {(['today', '7d', '30d'] as const).map((window) => (
              <button
                className={windowSize === window ? 'window-selected' : ''}
                onClick={() => setWindowSize(window)}
                key={window}
              >
                {window === 'today' ? 'Today' : window}
              </button>
            ))}
          </div>
        }
      />
      <div className="usage-honesty-banner">
        <div>
          <Radio size={17} />
          <strong>Measured activity only</strong>
          <span>
            Quota remaining, reset time, and subscription allowance are unavailable unless reported by the
            provider.
          </span>
        </div>
        <span className="status-pill status-attention">No fabricated quota estimates</span>
      </div>
      {error && (
        <div className="form-error">
          <AlertTriangle size={15} />
          {error}
        </div>
      )}
      <div className="usage-summary-grid">
        <Metric
          label="Local provider/process events"
          value={String(data?.eventCount ?? snapshot.usage.events)}
          help="Recorded by this machine"
        />
        <Metric
          label="Measured input tokens"
          value={sumMetric(providers, 'inputTokens')}
          help="Unavailable where the adapter emits no token counts"
        />
        <Metric
          label="Measured output tokens"
          value={sumMetric(providers, 'outputTokens')}
          help="Provider-reported only"
        />
        <Metric
          label="Allowance remaining"
          value="Unavailable"
          help="No provider quota endpoint is queried"
        />
      </div>
      <div className="usage-two-column">
        <section className="surface-panel usage-table-panel">
          <div className="panel-title-row">
            <div>
              <h2>Provider activity</h2>
              <p>Duration and requests observed in the selected window</p>
            </div>
            <Cpu size={16} className="muted-icon" />
          </div>
          {providers.length ? (
            <UsageTable rows={providers} labelProvider />
          ) : (
            <div className="empty-inline">No provider activity recorded in this window.</div>
          )}
        </section>
        <section className="surface-panel usage-table-panel">
          <div className="panel-title-row">
            <div>
              <h2>Activity by model</h2>
              <p>Model identity recorded by each run stage</p>
            </div>
            <Sparkles size={16} className="muted-icon" />
          </div>
          {models.length ? (
            <UsageTable rows={models} />
          ) : (
            <div className="empty-inline">No model activity recorded in this window.</div>
          )}
        </section>
      </div>
      <div className="usage-two-column">
        <section className="surface-panel usage-chart-panel">
          <div className="panel-title-row">
            <div>
              <h2>Daily runtime</h2>
              <p>Locally measured process duration</p>
            </div>
            <Clock3 size={16} className="muted-icon" />
          </div>
          {daily.length ? (
            <div className="daily-bars">
              {daily.map((item) => (
                <div className="daily-bar-row" key={String(item.day)}>
                  <span>{formatDay(String(item.day))}</span>
                  <div className="bar-track">
                    <i
                      style={{
                        width: `${Math.max(3, (Number(item.duration_ms ?? 0) / maxDuration) * 100)}%`,
                      }}
                    />
                  </div>
                  <strong>{Math.round(Number(item.duration_ms ?? 0) / 60_000)}m</strong>
                  <small>{String(item.events)} events</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-inline">
              Runtime is recorded when a provider or project command completes.
            </div>
          )}
        </section>
        <section className="surface-panel usage-table-panel">
          <div className="panel-title-row">
            <div>
              <h2>Activity by project</h2>
              <p>Observed process activity, not ownership of provider quota</p>
            </div>
            <FileCode2 size={16} className="muted-icon" />
          </div>
          {projects.length ? (
            <div className="project-usage-list">
              {projects.map((item) => (
                <div className="project-usage-row" key={String(item.name)}>
                  <span>{String(item.name ?? 'Unassigned project')}</span>
                  <strong>{String(item.events)} events</strong>
                  <small>{Math.round(Number(item.duration_ms ?? 0) / 60_000)} min</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-inline">No project activity yet.</div>
          )}
        </section>
      </div>
      <div className="usage-footnote">
        <Shield size={14} />
        <span>
          API-equivalent cost, subscription value ratio, remaining allowance, and exhaustion forecasts are
          unavailable until there is verified provider pricing and telemetry.
        </span>
      </div>
    </main>
  );
}

function UsageTable({
  rows,
  labelProvider = false,
}: {
  rows: Array<Record<string, unknown>>;
  labelProvider?: boolean;
}) {
  return (
    <div className="usage-table">
      <div className="usage-table-head">
        <span>{labelProvider ? 'Provider / backend' : 'Provider model'}</span>
        <span>Requests</span>
        <span>Runtime</span>
        <span>Tokens</span>
      </div>
      {rows.map((row) => (
        <div className="usage-table-row" key={String(row.key)}>
          <span className="usage-key">
            <strong>{String(row.key) === 'unavailable' ? 'Unavailable' : String(row.key)}</strong>
            <small>
              {row.costProvenance === 'unavailable'
                ? 'Equivalent cost unavailable'
                : String(row.costProvenance)}
            </small>
          </span>
          <span>{String(row.events)}</span>
          <span>{Math.round(Number(row.durationMs ?? 0) / 60_000)} min</span>
          <span>
            {row.inputTokens === null
              ? 'Unavailable'
              : `${Number(row.inputTokens).toLocaleString()} in · ${Number(row.outputTokens).toLocaleString()} out`}
          </span>
        </div>
      ))}
    </div>
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
  return (
    <main className="page-content">
      <PageHeading
        title="Settings"
        description="Local master identity, provider health, and safety boundaries."
      />
      <div className="settings-grid">
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
                <div className="capability-tags">
                  {Object.entries(provider.capabilities)
                    .filter(([, enabled]) => enabled)
                    .map(([key]) => (
                      <span key={key}>{humanize(key)}</span>
                    ))}
                </div>
              </div>
            </div>
          ))}
        </section>
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
              <small>Permission and delivery are browser-specific. Native push is not configured.</small>
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

function PairingSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof api.pairingRequests>>['requests']>([]);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof api.pairedDevices>>['devices']>([]);
  const [newCode, setNewCode] = useState<{ code: string; expiresAt: string } | null>(null);
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
  const createRequest = async () => {
    setBusy(true);
    try {
      const result = await api.createPairingRequest();
      setNewCode({ code: result.request.code, expiresAt: result.request.expiresAt });
      await load();
      onNotice('One-time pairing code created. Share it only with the device you are pairing.');
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
      {newCode && (
        <div className="pairing-code-display">
          <strong>{newCode.code}</strong>
          <small>
            Enter this on the phone before {formatDate(newCode.expiresAt)}. Keep this code private.
          </small>
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
                <button className="secondary-button" onClick={() => void approve(request.id)}>
                  Approve
                </button>
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

function Metric({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="usage-metric surface-panel">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{help}</small>
    </div>
  );
}
function Meta({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <div className="metadata-item">
      <Icon size={15} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  );
}
function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="empty-state">
      <span>
        <Icon size={20} />
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
function StatusIcon({ status }: { status: string }) {
  if (status === 'completed' || status === 'passed' || status === 'approved') return <Check size={14} />;
  if (status === 'failed' || status === 'denied') return <X size={14} />;
  if (status === 'cancelled') return <Square size={12} />;
  if (status === 'running') return <LoaderCircle size={14} className="spin" />;
  if (status === 'waiting_for_approval') return <LockKeyhole size={13} />;
  if (status === 'waiting_for_user') return <Sparkles size={13} />;
  if (status === 'paused') return <Pause size={13} />;
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
    'remediation',
    'finalGate',
  ].includes(kind);
}
function humanStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
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
function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(date);
}
function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const duration = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime());
  const seconds = Math.floor(duration / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function commandText(command: string[] | null): string {
  return command?.join(' ') ?? '';
}
function parseCommand(value: string): string[] | null {
  const parts = value.trim().split(/\s+/);
  return !value.trim() ? null : parts.length === 3 ? parts : null;
}
function sumMetric(rows: Array<Record<string, unknown>>, key: string): string {
  const known = rows.map((row) => row[key]).filter((value): value is number => typeof value === 'number');
  return known.length ? known.reduce((sum, value) => sum + value, 0).toLocaleString() : 'Unavailable';
}

export default App;
