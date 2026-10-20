import type { WorkflowDefinition, WorkflowStage } from './types.js';
import { DEFAULT_BILLING } from './workflows.js';
import {
  PROBE_COMMIT_MESSAGE,
  PROBE_COMMIT_STAGE_KEY,
  PROBE_INSTRUCTIONS,
  PROBE_PROFILE_ORDER,
  PROBE_STAGE_KEYS,
  PROBE_WORKFLOW_ID,
} from './routeProbe.js';

/**
 * Turing-reserved Goal workflow templates. They are deterministic, versioned in their id, run in
 * an isolated worktree, contain no merge, push or rollback stage, and carry no model route: a concrete route is
 * supplied by the Goal run plan, never chosen here.
 *
 * Permission mode is a static, audited property of each template. Planning, review and authoring are read-only roles
 * (the execution broker denies them every write in every mode). Execution is the only template that edits files and
 * creates the run commit; `git commit` needs approval in `normal` mode, so that one template is explicitly `yolo`.
 * The supervisor never raises a permission mode, and `enigma` is never accepted for a Goal workflow.
 */
export const GOAL_WORKFLOW_IDS = {
  planning: 'goal-planning-v1',
  execution: 'goal-execution-v1',
  review: 'goal-review-v1',
  verification: 'goal-verification-v1',
  authoring: 'goal-authoring-v1',
  probe: PROBE_WORKFLOW_ID,
} as const;

/** The stage key whose persisted output is the proposal a Goal planning run returns. */
export const GOAL_PROPOSE_STAGE_KEY = 'goal-propose';
export const GOAL_AUTHOR_STAGE_KEY = 'goal-author';
export const GOAL_TEMPLATE = 'goal-builtin';

const RESERVED_ID = /^goal-[a-z]+-v\d+$/;
export const isReservedGoalWorkflowId = (id: string): boolean => RESERVED_ID.test(id);

const retryPolicy = { maxRetries: 1, initialDelayMs: 1_000, maxDelayMs: 30_000 };
const contextPolicy = {
  strategy: 'focused' as const,
  maxFiles: 24,
  maxEstimatedTokens: 32_000,
  maxFileBytes: 80_000,
  includeGlobs: [] as string[],
  excludeGlobs: ['.git/**', 'node_modules/**', 'dist/**', 'build/**'],
  includeCurrentDiff: true,
  includeTestOutput: true,
  includeBuildOutput: true,
  includePreviousArtifact: true,
  includePreviousTranscript: false,
  onLimitExceeded: 'compact' as const,
};

const stage = (
  id: string,
  label: string,
  kind: WorkflowStage['kind'],
  role?: string,
  options: Partial<WorkflowStage> = {},
): WorkflowStage => ({ id, label, kind, ...(role ? { role } : {}), enabled: true, ...options });

type BuiltIn = Omit<WorkflowDefinition, 'createdAt' | 'updatedAt'>;

const base = (
  id: string,
  name: string,
  description: string,
  permissionMode: WorkflowDefinition['permissionMode'],
  stages: WorkflowStage[],
  extra: Partial<BuiltIn> = {},
): BuiltIn => ({
  id,
  name,
  description,
  template: GOAL_TEMPLATE,
  executionProfile: 'balanced',
  permissionMode,
  promptRefinementDefault: false,
  maxRemediationRounds: 0,
  maxParallelAgents: 1,
  maxDurationMinutes: 120,
  retryPolicy,
  isolatedWorktree: true,
  ...DEFAULT_BILLING,
  lockProviders: true,
  contextPolicy,
  version: 1,
  isDefault: false,
  stages,
  ...extra,
});

export const GOAL_BUILTIN_WORKFLOWS: readonly BuiltIn[] = [
  base(
    GOAL_WORKFLOW_IDS.planning,
    'Turing Goal · Planning',
    'Reserved for the Goal Engine. Read-only: proposes the next bounded task as strict JSON.',
    'normal',
    [stage(GOAL_PROPOSE_STAGE_KEY, 'Propose next task', 'planner', 'planner', { timeoutMinutes: 30 })],
  ),
  base(
    GOAL_WORKFLOW_IDS.execution,
    'Turing Goal · Execution',
    'Reserved for the Goal Engine. Implements one validated task, runs the project build and test commands, then commits. Permission mode is yolo by design; push, merge and rollback stages are absent.',
    'yolo',
    [
      stage('goal-implement', 'Implement task', 'implementer', 'implementer'),
      stage('goal-build', 'Build', 'build'),
      stage('goal-test', 'Test', 'test'),
      stage('goal-commit', 'Commit run result', 'gitCommit', undefined, {
        commitMessage: 'Turing Goal cycle result',
        allowNoChanges: true,
      }),
    ],
  ),
  base(
    GOAL_WORKFLOW_IDS.review,
    'Turing Goal · Review',
    'Reserved for the Goal Engine. Read-only structured review: parallel reviewers, consolidation and a final gate.',
    'normal',
    [
      stage('goal-review', 'Parallel review', 'parallelReview', 'reviewer', { parallelism: 2 }),
      stage('goal-consolidate', 'Consolidate reviews', 'consolidate', 'consolidator'),
      stage('goal-final', 'Final gate', 'finalGate', 'final-gate'),
    ],
    { maxParallelAgents: 2 },
  ),
  base(
    GOAL_WORKFLOW_IDS.verification,
    'Turing Goal · Verification',
    'Reserved for the Goal Engine. Deterministic only (no model): project build and test commands.',
    'normal',
    [stage('goal-build', 'Build', 'build'), stage('goal-test', 'Test', 'test')],
  ),
  base(
    GOAL_WORKFLOW_IDS.authoring,
    'Turing Goal · Authoring',
    'Reserved for the Goal Engine. Read-only: drafts a Goal definition as strict JSON.',
    'normal',
    [stage(GOAL_AUTHOR_STAGE_KEY, 'Draft Goal definition', 'planner', 'planner', { timeoutMinutes: 30 })],
  ),
  base(
    GOAL_WORKFLOW_IDS.probe,
    'Turing Goal · Route validation probe',
    'Reserved for the Goal Engine. Runs the Turing-owned route-validation tasks against a fixed fixture repository. Only a user-initiated probe applies a route to it. Permission mode is yolo so the single fixture edit can be committed; the read-only roles stay read-only.',
    'yolo',
    [
      ...PROBE_PROFILE_ORDER.flatMap((profile) => {
        const editing = profile === 'broker-edit';
        const role = {
          'structured-readonly': 'planner',
          'orchestrator-json': 'orchestrator',
          'review-json': 'reviewer',
          'broker-read': 'planner',
          'broker-edit': 'implementer',
        }[profile];
        const probeStage = stage(
          PROBE_STAGE_KEYS[profile],
          `Probe ${profile}`,
          editing ? 'implementer' : 'planner',
          role,
          { timeoutMinutes: 15, customInstructions: PROBE_INSTRUCTIONS[profile] },
        );
        return editing
          ? [
              probeStage,
              stage(PROBE_COMMIT_STAGE_KEY, 'Commit probe edit', 'gitCommit', undefined, {
                commitMessage: PROBE_COMMIT_MESSAGE,
                allowNoChanges: true,
              }),
            ]
          : [probeStage];
      }),
    ],
    {
      retryPolicy: { maxRetries: 0, initialDelayMs: 1_000, maxDelayMs: 30_000 },
      contextPolicy: {
        ...contextPolicy,
        includeCurrentDiff: false,
        includeTestOutput: false,
        includeBuildOutput: false,
        includePreviousArtifact: false,
      },
    },
  ),
];

export const goalBuiltinById = (id: string): BuiltIn | undefined =>
  GOAL_BUILTIN_WORKFLOWS.find((workflow) => workflow.id === id);
