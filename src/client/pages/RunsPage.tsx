import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  GitBranch,
  GitCompareArrows,
  LockKeyhole,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  StopCircle,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardSnapshot, ExecutionOperation, GitOperation, RunSummary } from '../../shared/types';
import { api } from '../api';
import { approvalSignature, pendingApprovalCounts } from '../goals/dashboard';
import { UnifiedApprovals } from '../goals/UnifiedApprovals';
import { billingLaneLabel } from '../../shared/billing';
import { DecisionResultsPanel } from '../phase36';
import type { Page } from './shared/types';
import { activeStatuses, shortTask, humanStatus, humanize } from './shared/runStatus';
import { PageHeading, StatusIcon, EmptyState } from './shared/parts';
import { MascotStatus } from '../ui/mascot';
import { mascotForRunStatus } from '../ui/mascot/mascotState';
import { formatDate, formatDuration, formatMilliseconds } from './shared/format';
import { RuleListDetails } from './shared/RuleListDetails';
import { useDismissibleDetails } from './shared/useDismissibleDetails';
import { iconForStage } from './shared/stageMeta';
import { RunWorkspaceTabs, type RunTab } from './runs/RunWorkspaceTabs';
import { RunDiff, type RunDiffState } from './runs/RunDiff';

export function RunsPage({
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
  const listRef = useRef<HTMLDivElement>(null);
  const openedFrom = useRef<string | null>(null);
  const runs = snapshot.runs.filter(
    (run) => filter === 'all' || activeStatuses.has(run.status) === (filter === 'active'),
  );
  // Closing a run returns focus to the row that opened it. The first render never moves focus.
  useEffect(() => {
    if (selectedRunId) {
      openedFrom.current = selectedRunId;
      return;
    }
    const id = openedFrom.current;
    openedFrom.current = null;
    if (!id) return;
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('.full-run-row') ?? [])
      .find((row) => row.dataset.runId === id)
      ?.focus();
  }, [selectedRunId]);
  return (
    <main className="page-content">
      {selectedRun ? (
        <h1 className="sr-only">Runs &amp; history</h1>
      ) : (
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
            <div className="full-run-list" ref={listRef}>
              {runs.map((run) => (
                <button
                  key={run.id}
                  data-run-id={run.id}
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
              mascot="idle"
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
            key={selectedRun.id}
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

export function RunDetail({
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
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  // Null until the execution operations have been fetched, so a count is never shown for data that was not loaded.
  const [operations, setOperations] = useState<ExecutionOperation[] | null>(null);
  const [tab, setTab] = useState<RunTab>('activity');
  const [diffState, setDiffState] = useState<RunDiffState>({ status: 'idle' });
  const diffRequest = useRef(0);
  const [intervention, setIntervention] = useState('');
  const runMenuRef = useRef<HTMLDetailsElement>(null);
  useDismissibleDetails(runMenuRef);
  const isActive = activeStatuses.has(run.status);
  useEffect(() => {
    let live = true;
    void Promise.all([api.run(run.id), api.executionOperations(run.id)])
      .then(([result, operationResult]) => {
        if (live) {
          setDetails(result);
          setOperations(operationResult.operations);
          setDetailsFailed(false);
        }
      })
      .catch(() => {
        if (live) setDetailsFailed(true);
      });
    return () => {
      live = false;
    };
  }, [run.id, run.status, run.stages.map((stage) => stage.status).join(','), detailsAttempt]);
  // Each request gets a number. A response that is not the latest request is dropped, so a slow earlier call cannot
  // overwrite a newer diff.
  const loadDiff = async () => {
    const request = ++diffRequest.current;
    setDiffState({ status: 'loading' });
    try {
      const result = await api.diff(run.id);
      if (request === diffRequest.current) setDiffState({ status: 'ready', result });
    } catch {
      if (request === diffRequest.current) setDiffState({ status: 'error' });
    }
  };
  // The working tree of an active run keeps changing, so Changes refetches on every activation. A finished run's diff
  // is fetched once, on first activation, and kept with this run's detail.
  const selectTab = (next: RunTab) => {
    setTab(next);
    if (next === 'changes' && (isActive || diffState.status === 'idle')) void loadDiff();
  };
  // "View diff" selects Changes and moves focus to its tab. When Changes is already selected it only moves focus.
  const viewDiff = () => {
    if (tab !== 'changes') selectTab('changes');
    document.getElementById('run-tab-changes')?.focus();
  };
  const retryDetails = () => {
    setDetailsFailed(false);
    setDetailsAttempt((attempt) => attempt + 1);
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
      .then((result) => {
        onRefresh();
        onNotice(
          result.status === 'cancelled'
            ? 'Queued run cancelled. It will not start.'
            : 'Stop requested. The provider process is being terminated.',
        );
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
  // The thinking mark sits beside the running title ("Running · elapsed") only while the run is actually running.
  const runningMark = threadState.tone === 'running' ? mascotForRunStatus(run.status) : null;
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
        <details className="run-menu" ref={runMenuRef}>
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
          <span className="thread-state-mark" aria-hidden="true">
            {!runningMark && <StateIcon size={18} aria-hidden="true" />}
          </span>
          <div>
            <strong>
              {runningMark ? (
                <MascotStatus animation={runningMark} size={24} label={threadState.title} />
              ) : (
                threadState.title
              )}
            </strong>
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
          {isActive && run.cancellable && (
            <button className="danger-button" onClick={stop}>
              <StopCircle size={14} />
              Stop run
            </button>
          )}
          <button className="secondary-button" onClick={viewDiff}>
            <GitCompareArrows size={14} />
            View diff
          </button>
        </div>
      </div>
      {!details && !detailsFailed && (
        <p className="run-details-status" role="status">
          Loading run details…
        </p>
      )}
      {detailsFailed && (
        <div className="run-details-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {details ? (
            <p>
              <strong>Showing earlier details.</strong> The latest run details could not be loaded.
            </p>
          ) : (
            <p>
              <strong>Error:</strong> Run details could not be loaded.
            </p>
          )}
          <button type="button" className="secondary-button" onClick={retryDetails}>
            Retry
          </button>
        </div>
      )}
      <RunWorkspaceTabs
        tab={tab}
        onSelect={selectTab}
        panels={{
          activity: (
            <>
              <div className="thread-user">
                <p>{run.prompt}</p>
              </div>
              <div className="run-runtime-summary">
                <span>Elapsed: {formatMilliseconds(run.elapsedMs)}</span>
                {run.remainingMs !== null && (
                  <span>Run time remaining: {formatMilliseconds(run.remainingMs)}</span>
                )}
                {run.status === 'paused_limit_reached' && (
                  <strong>
                    Maximum workflow duration reached. The working tree is preserved for inspection.
                  </strong>
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
                    {run.stages.filter((stage) => stage.status === 'passed').length} / {run.stages.length}{' '}
                    complete
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
            </>
          ),
          changes: <RunDiff state={diffState} onRetry={() => void loadDiff()} />,
          details: (
            <>
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
              {details && operations && (
                <>
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
                                {operation.approvalRequired
                                  ? (operation.approvalId ?? 'Required')
                                  : 'Not required'}
                              </dd>
                              <dt>Action</dt>
                              <dd>
                                <pre>{JSON.stringify(operation.action, null, 2)}</pre>
                              </dd>
                              {(operation.stdout || operation.stderr) && (
                                <>
                                  <dt>Result output</dt>
                                  <dd>
                                    <pre>
                                      {[operation.stdout, operation.stderr].filter(Boolean).join('\n')}
                                    </pre>
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
                  <DecisionResultsPanel decisions={details.decisions ?? []} />
                  <RuleListDetails rules={details.effectiveRules} title="Saved rule snapshot" />
                </>
              )}
            </>
          ),
        }}
      />
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
