import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  Clock3,
  FileCode2,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Play,
  Settings,
  SlidersHorizontal,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import type {
  DashboardSnapshot,
  ExecutionProfile,
  PermissionMode,
  ProviderStatus,
  RunPreview,
  RunSummary,
  WorkflowDefinition,
} from '../../shared/types';
import { api } from '../api';
import { approvalSignature, pendingApprovalCounts } from '../goals/dashboard';
import { UnifiedApprovals } from '../goals/UnifiedApprovals';
import { billingModeLabel } from '../../shared/billing';
import type { Page } from './shared/types';
import { isAiStage } from './shared/stageMeta';
import { activeStatuses, waitingStatuses, shortTask, humanStatus, rowTime } from './shared/runStatus';
import { StatusIcon } from './shared/parts';
import { MascotStatus } from '../ui/mascot';
import { mascotForPreview } from '../ui/mascot/mascotState';
import { LaunchBlockers } from './home/LaunchBlockers';
import { RunPreviewPanel } from './home/RunPreviewPanel';
import { Safeguards } from './home/Safeguards';

export function CommandCenter({
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
  const [previewPending, setPreviewPending] = useState(false);
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
  const previewMark = mascotForPreview(previewPending);
  const makePreview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task.trim() || !projectId || !workflowId) return;
    setBusy(true);
    setPreviewPending(true);
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
      onNotice(
        response.preview.canStart
          ? 'Run preview is ready. Check its project, stages, and Git strategy before starting.'
          : 'Preview loaded. Setup is needed before this can start.',
      );
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : 'Could not prepare the run preview.');
    } finally {
      setPreviewPending(false);
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
  const blockersShown = missingAssignments.length > 0 || !selectedProject;
  const describedBy =
    [blockersShown ? 'launch-blockers' : null, reviewBlockedReason ? 'launch-hint' : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <main className="page-content command-page">
      <div className={`home-column ${snapshot.runs.length > 0 ? 'home-has-activity' : ''}`}>
        <div className="home-intro">
          <h1>What should the agents do?</h1>
          <p>Your task stays on this machine and follows its saved workflow.</p>
        </div>
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
        {preview && <RunPreviewPanel preview={preview} />}
        <LaunchBlockers
          missingCount={missingAssignments.length}
          projectMissing={!selectedProject}
          onNavigate={onNavigate}
        />
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
            <span className="mascot-slot" aria-hidden={previewMark ? undefined : true}>
              {previewMark && (
                <MascotStatus animation={previewMark} size={24} label="Preparing run preview…" />
              )}
            </span>
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
                aria-describedby={describedBy}
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

        {selectedWorkflow && (
          <Safeguards
            billingMode={
              selectedWorkflow.billingMode ??
              (selectedWorkflow.subscriptionOnly ? 'subscriptions-only' : 'custom')
            }
            lockProviders={selectedWorkflow.lockProviders}
            permissionMode={selectedWorkflow.permissionMode}
          />
        )}
        <div className="home-status" aria-label="Workspace status">
          <span>
            <span className="presence-dot" /> {snapshot.machine.name} · online
          </span>
          <span>
            {snapshot.projects.length} {snapshot.projects.length === 1 ? 'project' : 'projects'}
          </span>
          <span>{pending.length} active</span>
          <span>
            {snapshot.usage.events} events today · {snapshot.usage.provenance}
          </span>
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
