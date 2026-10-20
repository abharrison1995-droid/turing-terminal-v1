import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import type {
  ConnectionProfile,
  ExecutionProfile,
  PermissionMode,
  ProviderStatus,
  ModelConfiguration,
  ModelPreset,
  StageKind,
  WorkflowCondition,
  WorkflowConditionPath,
  WorkflowDefinition,
  WorkflowStage,
} from '../../shared/types';
import { api } from '../api';
import {
  billingLaneLabel,
  billingLanesForBackend,
  billingModeLabel,
  inferBillingLane as inferClientBillingLane,
} from '../../shared/billing';
import { pruneModelSettings } from '../../shared/modelSettings';
import { DecisionGateEditor, defaultDecisionConfig } from './shared/DecisionPanels';
import {
  BillingSafetyFields,
  ModelSettingsFields,
  ModelStatusLine,
  OrchestratorBranchesEditor,
} from './workflows/StageFields';
import { PageHeading, EmptyState } from './shared/parts';
import { isAiStage, iconForStage, stageLabels } from './shared/stageMeta';
import { capitalize } from './shared/runStatus';

export function WorkflowsPage({
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
