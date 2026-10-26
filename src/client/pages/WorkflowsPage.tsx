import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Save,
  Settings2,
  Upload,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import type {
  ModelConfiguration,
  ModelPreset,
  ProviderStatus,
  StageKind,
  WorkflowDefinition,
  WorkflowStage,
} from '../../shared/types';
import { billingModeLabel, resolveBillingMode } from '../../shared/billing';
import { decisionEngineInfo } from '../../shared/decisions';
import { api, type ConnectionProfileWithCredentials } from '../api';
import { EmptyState, PageHeading } from './shared/parts';
import { isAiStage } from './shared/stageMeta';
import { capitalize } from './shared/runStatus';
import type { SettingsIntent } from './shared/settingsIntent';
import {
  discardStoredDraft,
  getOpenStageId,
  getSelectedWorkflowId,
  getStoredDraft,
  hasUnsavedWorkflowDrafts,
  isDraftDirty,
  isDraftStale,
  setOpenStageId,
  setSelectedWorkflowId,
  storeDraft,
} from './workflows/draftStore';
import { downloadWorkflowJson, prepareImportedWorkflow } from './workflows/importExport';
import { describeSaveFailure, type SaveState } from './workflows/saveState';
import { StageRow } from './workflows/StageRow';
import type { StageEditorContext } from './workflows/StageEditor';
import { stageForKind, type AddStageOption } from './workflows/stageFactory';
import { stageIssues, workflowProblems, type IssueContext } from './workflows/stageIssues';
import { AddStageMenu, MoreActionsMenu } from './workflows/WorkflowMenus';
import { WorkflowSettingsPanels, type SettingsPanelId } from './workflows/WorkflowSettingsPanels';

const STAGE_FIELDS_TO_INHERIT = [
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
] as const;

export function WorkflowsPage({
  workflows,
  providers: discoveredProviders,
  onSaved,
  onNotice,
  onOpenSettings,
}: {
  workflows: WorkflowDefinition[];
  providers: ProviderStatus[];
  onSaved: () => void;
  onNotice: (message: string) => void;
  /** Opens a part of Settings. The workflow draft is kept while the person is away. */
  onOpenSettings?: (intent: SettingsIntent) => void;
}) {
  const [selectedId, setSelectedId] = useState(() => {
    const remembered = getSelectedWorkflowId();
    return workflows.some((workflow) => workflow.id === remembered) ? remembered : (workflows[0]?.id ?? '');
  });
  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0];
  const [draft, setDraft] = useState<WorkflowDefinition | null>(
    () => (selected && getStoredDraft(selected.id)?.draft) || selected || null,
  );
  const [refreshedProviders, setRefreshedProviders] = useState<ProviderStatus[] | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const providers = refreshedProviders ?? discoveredProviders;
  const [connections, setConnections] = useState<ConnectionProfileWithCredentials[]>([]);
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  const [openStage, setOpenStage] = useState<string | null>(() =>
    selected ? getOpenStageId(selected.id) : null,
  );
  const [openPanel, setOpenPanel] = useState<SettingsPanelId | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [staleDismissed, setStaleDismissed] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    void Promise.all([api.connectionProfiles(), api.modelPresets()])
      .then(([connectionResponse, presetResponse]) => {
        setConnections(connectionResponse.profiles);
        setPresets(presetResponse.presets);
      })
      .catch((error) =>
        onNotice(error instanceof Error ? error.message : 'Configuration catalog could not be loaded.'),
      );
  }, []);

  useEffect(() => {
    if (!workflows.some((workflow) => workflow.id === selectedId) && workflows[0])
      setSelectedId(workflows[0].id);
  }, [workflows, selectedId]);

  // A different workflow, or a newly saved version of this one, replaces the draft only when no edits would be lost.
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      return;
    }
    setDraft(getStoredDraft(selected.id)?.draft ?? selected);
    setOpenStage(getOpenStageId(selected.id));
    setStaleDismissed(false);
    setSave({ phase: 'idle' });
  }, [selected?.id, selected?.version, selected?.updatedAt]);

  const base = draft ? (getStoredDraft(draft.id)?.base ?? selected) : undefined;
  const dirty = useMemo(() => isDraftDirty(draft, base), [draft, base]);
  const stale = Boolean(draft && selected && draft.id === selected.id && isDraftStale(draft.id, selected));

  // Unsaved edits live in a module-level store so they survive leaving the page (for example to set up a provider).
  useEffect(() => {
    if (!draft || !selected || draft.id !== selected.id) return;
    storeDraft(draft, getStoredDraft(draft.id)?.base ?? selected);
  }, [draft]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWorkflowDrafts()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  if (!draft || !selected)
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

  const context: IssueContext = { workflow: draft, providers, connections };
  const issuesByStage = draft.stages.map((stage, index) => stageIssues(stage, index, context));
  const blockingStages = draft.stages
    .map((stage, index) => ({
      stage,
      issues: issuesByStage[index]!.filter((issue) => issue.severity === 'blocking'),
    }))
    .filter((entry) => entry.issues.length > 0);
  const problems = workflowProblems(draft);

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
      next.splice(to, 0, item!);
      return { ...current, stages: next };
    });
  const showStage = (id: string | null) => {
    setOpenStage(id);
    setOpenStageId(draft.id, id);
    if (id)
      window.requestAnimationFrame(() => {
        const editor = document.getElementById(`stage-editor-${id}`);
        editor?.scrollIntoView?.({ block: 'nearest' });
      });
  };
  const addStage = (option: AddStageOption) => {
    const stage = stageForKind(
      option,
      draft.stages.map((item) => item.id),
    );
    // Prompt refinement has to be the first enabled stage, so it goes to the front; every other stage goes last.
    const stages = option.kind === 'promptRefinement' ? [stage, ...draft.stages] : [...draft.stages, stage];
    changeWorkflow({ stages });
    showStage(stage.id);
    window.requestAnimationFrame(() =>
      document
        .getElementById(`stage-editor-${stage.id}`)
        ?.querySelector<HTMLElement>('input, select, textarea')
        ?.focus(),
    );
  };
  const removeStage = (id: string) => {
    changeWorkflow({ stages: draft.stages.filter((item) => item.id !== id) });
    if (openStage === id) showStage(null);
  };
  const promoteToDefault = (stageId: string, kind: StageKind, configuration: ModelConfiguration) =>
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        stageDefaults: { ...current.stageDefaults, [kind]: configuration },
        stages: current.stages.map((item) => {
          if (item.id !== stageId) return item;
          const inherited = { ...item };
          for (const key of STAGE_FIELDS_TO_INHERIT) delete (inherited as Record<string, unknown>)[key];
          return inherited;
        }),
      };
    });
  const savePreset = (name: string, configuration: ModelConfiguration) =>
    void api
      .createModelPreset(name, configuration)
      .then((response) => {
        setPresets((current) => [...current, response.preset]);
        onNotice(`Model preset “${name}” saved without credentials.`);
      })
      .catch((error) => onNotice(error instanceof Error ? error.message : 'Preset could not be saved.'));
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

  const saveWorkflow = async () => {
    setSave({ phase: 'saving' });
    try {
      const result = await api.saveWorkflow(draft);
      discardStoredDraft(result.workflow.id);
      setDraft(result.workflow);
      setSelectedId(result.workflow.id);
      setSelectedWorkflowId(result.workflow.id);
      setSave({ phase: 'saved', version: result.workflow.version });
      onSaved();
      onNotice(`“${result.workflow.name}” saved as version ${result.workflow.version}.`);
    } catch (error) {
      setSave({ phase: 'error', ...describeSaveFailure(error) });
    }
  };
  const discardChanges = () => {
    discardStoredDraft(selected.id);
    setDraft(selected);
    setSave({ phase: 'idle' });
    setStaleDismissed(false);
  };
  const selectWorkflow = (id: string) => {
    if (id === draft.id) return;
    if (dirty) onNotice(`Unsaved edits to “${draft.name}” are kept. Switch back to continue or save them.`);
    setSelectedId(id);
    setSelectedWorkflowId(id);
  };
  const duplicate = async () => {
    try {
      const result = await api.duplicateWorkflow(draft.id);
      onSaved();
      setSelectedId(result.workflow.id);
      setSelectedWorkflowId(result.workflow.id);
      onNotice('Workflow duplicated from its saved version.');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Workflow could not be duplicated.');
    }
  };
  const exportJson = () =>
    downloadWorkflowJson(JSON.stringify(api.exportWorkflows([draft]), null, 2), `${draft.id}.workflow.json`);
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const prepared = prepareImportedWorkflow(JSON.parse(await file.text()), connections);
      const created = await api.saveWorkflow(prepared, true);
      onSaved();
      setSelectedId(created.workflow.id);
      setSelectedWorkflowId(created.workflow.id);
      onNotice(
        'Workflow imported. Connection references were matched to local connections where available; review each stage’s connection and model before running.',
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Workflow import failed.');
    }
  };

  const editorContext: StageEditorContext = {
    workflow: draft,
    providers,
    connections,
    presets,
    refreshing: refreshingModels,
    onRefreshModels: () => void refreshModels(),
    onSavePreset: savePreset,
    onPromoteToDefault: promoteToDefault,
    onOpenProviders: () => onOpenSettings?.({ target: 'providers', returnTo: 'workflows' }),
    onOpenOpenRouterSettings: () => onOpenSettings?.({ target: 'openrouter', returnTo: 'workflows' }),
    onWorkflowChange: changeWorkflow,
  };

  const mode = resolveBillingMode(draft);
  const externalGate = draft.stages.some(
    (stage) =>
      stage.kind === 'decisionGate' && stage.decision && decisionEngineInfo(stage.decision.engine).external,
  );
  const aiStageCount = draft.stages.filter((stage) => isAiStage(stage.kind)).length;
  const attentionCount = blockingStages.length + problems.length;
  const jumpTo = (stageId: string) => {
    showStage(stageId);
    window.requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-stage-id="${stageId}"] .stage-row-toggle`)?.focus(),
    );
  };
  const openPanelFor = (id: SettingsPanelId) => {
    setOpenPanel(id);
    window.requestAnimationFrame(() =>
      document.getElementById(`workflow-setting-${id}`)?.scrollIntoView?.({ block: 'start' }),
    );
  };

  return (
    <main className="page-content workflow-page">
      <PageHeading
        title="Workflow Studio"
        description="Order the stages a run follows and choose which connection and model each one uses."
        actions={
          <MoreActionsMenu>
            <button type="button" className="quiet-button" onClick={() => void duplicate()} disabled={dirty}>
              <Copy size={14} aria-hidden="true" /> Duplicate
            </button>
            {dirty && <small>Duplicate copies the saved version. Save first to include your edits.</small>}
            <label className="quiet-button file-import-button">
              <Upload size={14} aria-hidden="true" /> Import JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importJson(event.target.files?.[0])}
              />
            </label>
            <button type="button" className="quiet-button" onClick={exportJson}>
              <Download size={14} aria-hidden="true" /> Export JSON
            </button>
          </MoreActionsMenu>
        }
      />

      <div className="workflow-picker">
        <label className="form-field">
          <span>Workflow</span>
          <select value={draft.id} onChange={(event) => selectWorkflow(event.target.value)}>
            {workflows.map((workflow) => (
              <option value={workflow.id} key={workflow.id}>
                {workflow.name}
                {getStoredDraft(workflow.id) ? ' · unsaved changes' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="workflow-picker-meta">
          {draft.stages.length} {draft.stages.length === 1 ? 'stage' : 'stages'} · {aiStageCount} AI · saved
          version {selected.version}
        </p>
      </div>

      {stale && !staleDismissed && (
        <div className="workflow-banner workflow-banner-attention" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <div>
            <strong>A newer saved version exists</strong>
            <p>
              This draft started from version {getStoredDraft(draft.id)?.base.version}; the saved workflow is
              now version {selected.version}. Saving your draft replaces it.
            </p>
            <div className="stage-actions-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  storeDraft(draft, selected);
                  setStaleDismissed(true);
                }}
              >
                Keep my draft
              </button>
              <button type="button" className="secondary-button" onClick={discardChanges}>
                Load the saved version
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="workflow-layout">
        <div className="workflow-main">
          <section className="workflow-overview" aria-label="Workflow overview">
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
                  rows={2}
                  value={draft.description}
                  maxLength={500}
                  onChange={(event) => changeWorkflow({ description: event.target.value })}
                />
              </label>
            </div>
            <ul className="policy-chips" aria-label="Safety and billing summary">
              <li>{billingModeLabel(mode)}</li>
              <li>{capitalize(draft.permissionMode)} permissions</li>
              <li>{draft.isolatedWorktree ? 'Worktree isolation on' : 'Worktree isolation off'}</li>
              <li>{draft.lockProviders ? 'Providers locked' : 'Providers unlocked'}</li>
              {draft.meteredBudget?.perRunUsd != null && (
                <li>Cap ${draft.meteredBudget.perRunUsd.toFixed(2)} per run</li>
              )}
              {externalGate && (
                <li>
                  External decision data:{' '}
                  {
                    { 'ask-first': 'ask first', allow: 'allowed', block: 'blocked' }[
                      draft.externalDecisionDataPolicy ?? 'ask-first'
                    ]
                  }
                </li>
              )}
            </ul>
            <button type="button" className="link-button" onClick={() => openPanelFor('safety')}>
              <Settings2 size={13} aria-hidden="true" /> Safety and billing settings
            </button>
          </section>

          {attentionCount > 0 && (
            <section className="workflow-banner workflow-banner-blocking" aria-label="Problems to fix">
              <AlertTriangle size={15} aria-hidden="true" />
              <div>
                <strong>
                  {attentionCount} {attentionCount === 1 ? 'problem' : 'problems'} to fix before this workflow
                  can run
                </strong>
                <ul>
                  {problems.map((problem) => (
                    <li key={problem.message}>
                      {problem.message}
                      {/worktree/i.test(problem.message) && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => openPanelFor('safety')}
                          >
                            Open Safety and billing
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                  {blockingStages.map(({ stage, issues }) => (
                    <li key={stage.id}>
                      <button type="button" className="link-button" onClick={() => jumpTo(stage.id)}>
                        {stage.label}
                      </button>
                      : {issues[0]!.message}
                      {issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="workflow-stages" aria-labelledby="stage-sequence-title">
            <div className="stage-editor-heading">
              <div>
                <h2 id="stage-sequence-title">Stage sequence</h2>
                <p>
                  Runs top to bottom. Use the arrow buttons or Alt + arrow keys to reorder; drag works on a
                  mouse.
                </p>
              </div>
              <AddStageMenu onAdd={addStage} />
            </div>
            {draft.stages.length === 0 ? (
              <p className="quiet-note">No stages yet. Add one to start.</p>
            ) : (
              <ol className="stage-list" ref={listRef} aria-label="Stages">
                {draft.stages.map((stage, index) => (
                  <StageRow
                    key={stage.id}
                    stage={stage}
                    index={index}
                    count={draft.stages.length}
                    open={openStage === stage.id}
                    issues={issuesByStage[index]!}
                    context={editorContext}
                    onToggle={() => showStage(openStage === stage.id ? null : stage.id)}
                    onChange={(patch) => changeStage(stage.id, patch)}
                    onMove={(direction) => {
                      const target = draft.stages[index + direction];
                      if (target) reorder(stage.id, target.id);
                    }}
                    onRemove={() => removeStage(stage.id)}
                    onDragStart={() => setDragged(stage.id)}
                    onDrop={() => {
                      if (dragged) reorder(dragged, stage.id);
                      setDragged(null);
                    }}
                  />
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="workflow-aside">
          <WorkflowSettingsPanels
            draft={draft}
            providers={providers}
            connections={connections}
            openPanel={openPanel}
            onOpenPanel={setOpenPanel}
            onChange={changeWorkflow}
          />
        </aside>
      </div>

      <div
        className={`workflow-save-bar ${!dirty && (save.phase === 'idle' || save.phase === 'saved') ? 'workflow-save-bar-idle' : ''}`}
        role="region"
        aria-label="Save workflow"
      >
        <p
          className={`save-status save-status-${save.phase === 'error' ? 'error' : dirty ? 'dirty' : 'clean'}`}
          role={save.phase === 'error' ? 'alert' : 'status'}
        >
          {save.phase === 'saving' ? (
            'Saving…'
          ) : save.phase === 'error' ? (
            <>
              <AlertTriangle size={14} aria-hidden="true" /> {save.message}
            </>
          ) : dirty ? (
            'Unsaved changes'
          ) : save.phase === 'saved' ? (
            <>
              <CheckCircle2 size={14} aria-hidden="true" /> Saved as version {save.version}
            </>
          ) : (
            `All changes saved · version ${selected.version}`
          )}
        </p>
        <div className="save-actions">
          {dirty && (
            <button
              type="button"
              className="quiet-button"
              onClick={discardChanges}
              disabled={save.phase === 'saving'}
            >
              Discard changes
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={() => void saveWorkflow()}
            disabled={save.phase === 'saving' || (!dirty && save.phase !== 'error')}
          >
            <Save size={15} aria-hidden="true" />
            {save.phase === 'saving' ? 'Saving…' : 'Save workflow'}
          </button>
        </div>
      </div>
    </main>
  );
}
