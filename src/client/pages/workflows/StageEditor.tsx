import type {
  ConnectionProfile,
  ModelConfiguration,
  ModelPreset,
  ProviderStatus,
  StageKind,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';
import type { ConnectionProfileWithCredentials } from '../../api';
import { isAiStage, stageLabels } from '../shared/stageMeta';
import { DecisionGateEditor } from './DecisionGateEditor';
import { StageAssignment } from './StageAssignment';
import { StageLimitsFields, StageTypeFields } from './StageEditorFields';
import { kindChangePatch } from './stageFactory';
import type { StageIssue } from './stageIssues';

/** Everything an open stage editor needs from the page. One object so rows stay small. */
export interface StageEditorContext {
  workflow: WorkflowDefinition;
  providers: ProviderStatus[];
  connections: ConnectionProfileWithCredentials[];
  presets: ModelPreset[];
  refreshing: boolean;
  onRefreshModels: () => void;
  onSavePreset: (name: string, configuration: ModelConfiguration) => void;
  onPromoteToDefault: (stageId: string, kind: StageKind, configuration: ModelConfiguration) => void;
  onOpenProviders: () => void;
  onOpenOpenRouterSettings: () => void;
  onWorkflowChange: (patch: Partial<WorkflowDefinition>) => void;
}

export function StageEditor({
  stage,
  index,
  issues,
  context,
  onChange,
  onClose,
}: {
  stage: WorkflowStage;
  index: number;
  issues: StageIssue[];
  context: StageEditorContext;
  onChange: (patch: Partial<WorkflowStage>) => void;
  onClose: () => void;
}) {
  const { workflow } = context;
  const laterStages = workflow.stages.filter((_, stageIndex) => stageIndex > index);
  const ai = isAiStage(stage.kind);
  return (
    <div
      className="stage-editor"
      id={`stage-editor-${stage.id}`}
      role="group"
      aria-label={`${stage.label} settings`}
    >
      {issues.length > 0 && (
        <ul className="stage-editor-issues" aria-label="Configuration issues">
          {issues.map((issue) => (
            <li className={`assignment-issue assignment-issue-${issue.severity}`} key={issue.message}>
              {issue.severity === 'blocking' ? 'Blocking · ' : 'Check · '}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <div className="form-grid-two stage-basics">
        <label className="form-field">
          <span>Stage name</span>
          <input
            value={stage.label}
            maxLength={120}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </label>
        <label className="form-field">
          <span>Stage type</span>
          <select
            value={stage.kind}
            onChange={(event) => onChange(kindChangePatch(stage, event.target.value as StageKind))}
          >
            {Object.entries(stageLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {stage.modelSnapshot?.status === 'unavailable' && ai && (
        <div className="inline-callout model-repair-note" role="note">
          <span>
            <strong>Model unavailable</strong>
            <small>
              Choose a currently discovered model from this provider. Turing will not migrate the historical
              assignment automatically.
            </small>
          </span>
        </div>
      )}
      {ai && (
        <StageAssignment
          stage={stage}
          workflow={workflow}
          providers={context.providers}
          connections={context.connections as ConnectionProfile[]}
          presets={context.presets}
          issues={issues}
          refreshing={context.refreshing}
          onChange={onChange}
          onRefreshModels={context.onRefreshModels}
          onSavePreset={context.onSavePreset}
          onPromoteToDefault={(kind, configuration) =>
            context.onPromoteToDefault(stage.id, kind, configuration)
          }
          onOpenProviders={context.onOpenProviders}
        />
      )}
      {stage.kind === 'decisionGate' && (
        <DecisionGateEditor
          stage={stage}
          laterStages={laterStages}
          workflow={workflow}
          providers={context.providers}
          connections={context.connections}
          onChange={onChange}
          onWorkflowChange={context.onWorkflowChange}
          onOpenOpenRouterSettings={context.onOpenOpenRouterSettings}
        />
      )}
      <StageTypeFields stage={stage} laterStages={laterStages} onChange={onChange} />
      <StageLimitsFields stage={stage} workflowContextPolicy={workflow.contextPolicy} onChange={onChange} />
      <div className="stage-actions-row stage-editor-footer">
        <button type="button" className="quiet-button" onClick={onClose}>
          Done editing {stage.label}
        </button>
      </div>
    </div>
  );
}
