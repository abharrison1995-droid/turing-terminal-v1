import type { DecisionGateConfig, StageKind, WorkflowStage } from '../../../shared/types';
import { DEFAULT_JEV_MODEL } from '../../../shared/decisions';

/** Stage kinds that carry no role. Every other kind uses its own name as the role. */
const ROLELESS_KINDS: readonly StageKind[] = [
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
];

export function roleForKind(kind: StageKind, previousRole?: string): string | undefined {
  if (kind === 'promptRefinement') return 'prompt-refinement';
  if (ROLELESS_KINDS.includes(kind)) return undefined;
  return previousRole ?? kind;
}

export function defaultDecisionConfig(): DecisionGateConfig {
  return {
    engine: 'deterministic-rules',
    questionType: 'boolean',
    question: 'Are there no failing test stages?',
    inputs: ['tests'],
    rule: { path: 'tests.failed', operator: 'equals', value: 0 },
    routing: {
      field: 'probability',
      passAtOrAbove: 0.95,
      failAtOrBelow: 0.15,
      onPass: { action: 'continue' },
      onFail: { action: 'fail-run' },
      onUncertain: { action: 'human-approval' },
    },
  };
}

/**
 * A new JEV gate. Its evidence starts as the structured test and build summaries only; the person widens it on purpose.
 * It names an exact model version and nothing else: no connection, no spending cap, no external-data
 * permission. Those are separate decisions the person makes in the prerequisites panel, so adding the gate never
 * enables spending or sends data.
 */
export function defaultJevConfig(): DecisionGateConfig {
  return {
    engine: 'jev-openrouter',
    modelId: DEFAULT_JEV_MODEL,
    questionType: 'boolean',
    question: 'Is this change ready to ship?',
    inputs: ['tests', 'build'],
    routing: {
      field: 'probability',
      passAtOrAbove: 0.95,
      failAtOrBelow: 0.15,
      onPass: { action: 'continue' },
      onFail: { action: 'fail-run' },
      onUncertain: { action: 'human-approval' },
    },
  };
}

export interface AddStageOption {
  /** Unique within the menu. */
  id: string;
  kind: StageKind;
  label: string;
  description: string;
  /** Selects a starting configuration for a kind that has more than one. */
  preset?: 'jev' | 'rules';
}

export interface AddStageGroup {
  id: string;
  label: string;
  options: AddStageOption[];
}

export const ADD_STAGE_GROUPS: readonly AddStageGroup[] = [
  {
    id: 'plan',
    label: 'Plan and prepare',
    options: [
      { id: 'planner', kind: 'planner', label: 'Planner', description: 'An agent writes the plan.' },
      {
        id: 'promptRefinement',
        kind: 'promptRefinement',
        label: 'Prompt refinement',
        description: 'Sharpens the request before anything else runs. Must come first.',
      },
      {
        id: 'orchestrator',
        kind: 'orchestrator',
        label: 'AI Orchestrator',
        description: 'Chooses between branches you define.',
      },
    ],
  },
  {
    id: 'build',
    label: 'Build and verify',
    options: [
      {
        id: 'implementer',
        kind: 'implementer',
        label: 'Implementer',
        description: 'An agent changes the project.',
      },
      {
        id: 'remediation',
        kind: 'remediation',
        label: 'Remediation',
        description: 'Fixes findings from review.',
      },
      { id: 'build', kind: 'build', label: 'Build', description: 'Runs the detected build command.' },
      { id: 'test', kind: 'test', label: 'Test', description: 'Runs the detected test command.' },
      {
        id: 'shellCommand',
        kind: 'shellCommand',
        label: 'Project script',
        description: 'Runs a build, test or lint package script.',
      },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    options: [
      { id: 'reviewer', kind: 'reviewer', label: 'Reviewer', description: 'An agent reviews the change.' },
      {
        id: 'parallelReview',
        kind: 'parallelReview',
        label: 'Parallel review',
        description: 'Several reviewers at once, capped by the workflow limit.',
      },
      {
        id: 'consolidate',
        kind: 'consolidate',
        label: 'Consolidation',
        description: 'Merges reviewer findings.',
      },
      {
        id: 'finalGate',
        kind: 'finalGate',
        label: 'Final gate',
        description: 'An agent gives the PASS or FAIL verdict.',
      },
    ],
  },
  {
    id: 'decide',
    label: 'Decide and route',
    options: [
      {
        id: 'decision-jev',
        kind: 'decisionGate',
        preset: 'jev',
        label: 'Decision gate · JEV via OpenRouter',
        description: 'Optional. Metered, sends the evidence you choose to OpenRouter, and needs setup first.',
      },
      {
        id: 'decision-rules',
        kind: 'decisionGate',
        preset: 'rules',
        label: 'Decision gate · Deterministic rules',
        description: 'Local rule over test, build and review results. Free and sends nothing.',
      },
      {
        id: 'conditionalBranch',
        kind: 'conditionalBranch',
        label: 'Conditional branch',
        description: 'Skips later stages when a condition is false.',
      },
      {
        id: 'humanApproval',
        kind: 'humanApproval',
        label: 'Human approval',
        description: 'Pauses until a person approves.',
      },
      {
        id: 'notification',
        kind: 'notification',
        label: 'Notification',
        description: 'Tells connected browsers that the run reached this point.',
      },
    ],
  },
  {
    id: 'git',
    label: 'Git',
    options: [
      {
        id: 'gitCheckpoint',
        kind: 'gitCheckpoint',
        label: 'Checkpoint',
        description: 'Saves a restorable snapshot.',
      },
      { id: 'gitCommit', kind: 'gitCommit', label: 'Commit', description: 'Commits checked changes.' },
      {
        id: 'gitPush',
        kind: 'gitPush',
        label: 'Push',
        description: 'Pushes the run branch without force. Always asks.',
      },
      {
        id: 'gitMerge',
        kind: 'gitMerge',
        label: 'Merge',
        description: 'Fast-forward merge with explicit approval.',
      },
      {
        id: 'gitRollback',
        kind: 'gitRollback',
        label: 'Rollback / restore',
        description: 'Restores only the registered project subtree.',
      },
    ],
  },
];

export function newStageId(kind: StageKind, taken: readonly string[] = []): string {
  for (;;) {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    if (!taken.includes(id)) return id;
  }
}

/** Fields a kind owns, so changing the kind clears the ones that no longer apply. */
export function stageForKind(
  option: Pick<AddStageOption, 'kind' | 'preset' | 'label'>,
  taken: readonly string[] = [],
): WorkflowStage {
  const { kind } = option;
  const label =
    kind === 'decisionGate'
      ? option.preset === 'jev'
        ? 'JEV decision'
        : 'Decision gate'
      : option.label.replace(/ \(.*$/, '');
  const stage: WorkflowStage = {
    id: newStageId(kind, taken),
    label,
    kind,
    role: roleForKind(kind),
    enabled: true,
  };
  if (kind === 'conditionalBranch') {
    stage.condition = { path: 'build.success', operator: 'equals', value: true };
    stage.skipStageIds = [];
  }
  if (kind === 'decisionGate')
    stage.decision = option.preset === 'jev' ? defaultJevConfig() : defaultDecisionConfig();
  if (kind === 'shellCommand') stage.command = ['npm', 'run', 'test'];
  if (kind === 'gitPush') stage.pushRemote = 'origin';
  if (kind === 'gitRollback') stage.rollbackTarget = 'runStart';
  if (kind === 'parallelReview') stage.parallelism = 1;
  return stage;
}

/** The patch for changing an existing stage to another kind, clearing configuration the new kind does not use. */
export function kindChangePatch(stage: WorkflowStage, kind: StageKind): Partial<WorkflowStage> {
  return {
    kind,
    role: roleForKind(kind, stage.role),
    condition:
      kind === 'conditionalBranch'
        ? (stage.condition ?? { path: 'build.success', operator: 'equals', value: true })
        : undefined,
    decision: kind === 'decisionGate' ? (stage.decision ?? defaultDecisionConfig()) : undefined,
    orchestration: kind === 'orchestrator' ? stage.orchestration : undefined,
    skipStageIds: kind === 'conditionalBranch' ? (stage.skipStageIds ?? []) : undefined,
    command: kind === 'shellCommand' ? (stage.command ?? ['npm', 'run', 'test']) : undefined,
    notificationMessage: kind === 'notification' ? (stage.notificationMessage ?? '') : undefined,
    commitMessage: kind === 'gitCommit' ? (stage.commitMessage ?? '') : undefined,
    pushRemote: kind === 'gitPush' ? (stage.pushRemote ?? 'origin') : undefined,
    pushBranch: kind === 'gitPush' ? (stage.pushBranch ?? '') : undefined,
    rollbackTarget: kind === 'gitRollback' ? (stage.rollbackTarget ?? 'runStart') : undefined,
  };
}
