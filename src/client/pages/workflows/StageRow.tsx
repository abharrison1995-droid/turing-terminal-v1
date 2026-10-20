import { useRef, type DragEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, GripVertical, X } from 'lucide-react';
import type { WorkflowStage } from '../../../shared/types';
import { iconForStage, isAiStage, stageLabels } from '../shared/stageMeta';
import { describeAssignment, type StageIssue } from './stageIssues';
import { hasStageOverride } from './assignment';
import { StageEditor, type StageEditorContext } from './StageEditor';

const NOTES: Partial<Record<WorkflowStage['kind'], string>> = {
  build: 'Uses the detected project command',
  test: 'Uses the detected project command',
  gitCheckpoint: 'Saves a restorable project snapshot',
  gitCommit: 'Commits checked project changes in the run branch',
  gitPush: 'Pushes the run branch without force',
  gitMerge: 'Fast-forward merge with explicit approval',
  gitRollback: 'Restores only the registered project subtree',
  humanApproval: 'Pauses until a person approves',
  notification: 'Notifies connected browsers',
  conditionalBranch: 'Skips later stages when a condition is false',
  shellCommand: 'Runs a build, test or lint package script',
};

function rowSummary(stage: WorkflowStage, context: StageEditorContext) {
  if (stage.kind === 'decisionGate') {
    const engine = stage.decision?.engine ?? 'deterministic-rules';
    const label =
      engine === 'jev-openrouter'
        ? 'JEV via OpenRouter'
        : engine === 'deterministic-rules'
          ? 'Deterministic rules'
          : engine === 'subscription-llm-judge'
            ? 'Subscription judge'
            : 'OpenRouter judge';
    const type =
      stage.decision?.questionType === 'choice'
        ? 'choose an option'
        : stage.decision?.questionType === 'score'
          ? 'score'
          : 'yes / no';
    return {
      primary: label,
      secondary: `${type}${stage.decision?.modelId ? ` · ${stage.decision.modelId}` : ''}`,
    };
  }
  if (isAiStage(stage.kind)) {
    const { connection, model } = describeAssignment(stage, context.workflow, context.connections);
    return { primary: connection, secondary: model };
  }
  return { primary: NOTES[stage.kind] ?? 'No model assignment required', secondary: '' };
}

export function StageRow({
  stage,
  index,
  count,
  open,
  issues,
  context,
  onToggle,
  onChange,
  onMove,
  onRemove,
  onDragStart,
  onDrop,
}: {
  stage: WorkflowStage;
  index: number;
  count: number;
  open: boolean;
  issues: StageIssue[];
  context: StageEditorContext;
  onToggle: () => void;
  onChange: (patch: Partial<WorkflowStage>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const Icon = iconForStage(stage.kind);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const summary = rowSummary(stage, context);
  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const ai = isAiStage(stage.kind);
  const inherited = ai && !hasStageOverride(stage);
  const move = (direction: -1 | 1) => {
    onMove(direction);
    // A reorder moves the DOM node, which can drop focus. Put it back on the same stage's control.
    window.requestAnimationFrame(() => toggleRef.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    if ((direction === -1 && index > 0) || (direction === 1 && index < count - 1)) move(direction);
  };
  return (
    <li
      className={`stage-row ${open ? 'stage-row-open' : ''} ${stage.enabled === false ? 'stage-row-disabled' : ''} ${blocking.length ? 'stage-row-blocked' : ''}`}
      data-stage-id={stage.id}
      onDragOver={(event: DragEvent) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="stage-row-head">
        <span
          className="stage-grip"
          draggable
          onDragStart={onDragStart}
          aria-hidden="true"
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </span>
        <span className="stage-number">{index + 1}</span>
        <button
          type="button"
          ref={toggleRef}
          className="stage-row-toggle"
          aria-expanded={open}
          aria-controls={`stage-editor-${stage.id}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onClick={onToggle}
          onKeyDown={onKeyDown}
        >
          <span className="stage-kind-icon">
            <Icon size={16} aria-hidden="true" />
          </span>
          <span className="stage-row-name">
            <strong>{stage.label}</strong>
            <small>{stageLabels[stage.kind]}</small>
          </span>
          <span className="stage-row-assignment">
            <span>{summary.primary}</span>
            {summary.secondary && <small>{summary.secondary}</small>}
          </span>
          {inherited && <span className="source-chip source-chip-inherited">Defaults</span>}
          {issues.length > 0 && (
            <span
              className={`stage-row-issue ${blocking.length ? 'stage-row-issue-blocking' : 'stage-row-issue-attention'}`}
            >
              <AlertTriangle size={13} aria-hidden="true" />
              {blocking.length ? blocking[0]!.message : issues[0]!.message}
              {issues.length > 1 && <span className="stage-row-more"> +{issues.length - 1}</span>}
            </span>
          )}
          <ChevronDown size={16} className="stage-row-chevron" aria-hidden="true" />
        </button>
        <label className="toggle-line compact-toggle stage-enabled">
          <input
            type="checkbox"
            checked={stage.enabled !== false}
            aria-label={`${stage.label} enabled`}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          <span>{stage.enabled === false ? 'Off' : 'On'}</span>
        </label>
        <div className="stage-reorder">
          <button
            type="button"
            className="icon-button tiny-icon"
            disabled={index === 0}
            onClick={() => move(-1)}
            aria-label={`Move ${stage.label} up`}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-button tiny-icon"
            disabled={index === count - 1}
            onClick={() => move(1)}
            aria-label={`Move ${stage.label} down`}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-button tiny-icon danger-icon"
            onClick={onRemove}
            aria-label={`Remove ${stage.label}`}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {open && (
        <StageEditor
          stage={stage}
          index={index}
          issues={issues}
          context={context}
          onChange={onChange}
          onClose={() => {
            onToggle();
            window.requestAnimationFrame(() => toggleRef.current?.focus());
          }}
        />
      )}
    </li>
  );
}
