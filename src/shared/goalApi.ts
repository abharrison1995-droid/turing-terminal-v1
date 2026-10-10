import type {
  CompletionFailure,
  FindingSeverity,
  GoalApprovalGate,
  GoalApprovalRisk,
  GoalApprovalStatus,
  GoalCycleKind,
  GoalDefinition,
  GoalDefinitionAuthor,
  GoalDefinitionStatus,
  GoalEventType,
  GoalFindingStatus,
  GoalReviewKind,
  GoalReviewStatus,
  GoalStatus,
  ReviewIndependence,
  ReviewReport,
  ReviewVerdict,
} from './goals.js';

/**
 * Stage 7A: the typed Goal HTTP surface. Pure data. Every shape here is a bounded, JSON-safe projection built by the
 * server read-model layer from canonical rows; none of them is an authority and none exposes a raw `*_json` column.
 */

export interface GoalApiError {
  error: string;
  code: string;
  detail?: unknown;
}

/** Small history row. Git currentness is intentionally revalidated only for a selected handoff. */
export interface GoalManualHandoffSummary {
  handoffId: string;
  createdAt: string;
  definitionVersion: number;
  sourceCommit: string;
  handoffDigest: string;
}

export interface GoalManualHandoffListResponse {
  handoffs: GoalManualHandoffSummary[];
  limit: number;
  nextOffset: number | null;
}

/** Immutable, bounded handoff record v1 returned by the server's validated projection. */
export interface GoalManualIntegrationHandoff {
  schemaVersion: 1;
  kind: 'turing_goal_manual_integration_handoff';
  handoffId: string;
  goalId: string;
  definition: { version: number; hash: string; approvalId: string; approvalIdentityDigest: string };
  finalAcceptance: { approvalId: string; identityDigest: string };
  repository: { projectId: string; identity: string; objectFormat: 'sha1' | 'sha256'; scope: string };
  source: { goalRef: string; commit: string; tree: string };
  target: { baseBranch: string; baseRef: string; observedBaseCommit: string; observedBaseTree: string };
  completion: { identityDigest: string; findingsIdentityDigest: string };
  review: {
    finalReviewId: string;
    reviewIdentityDigest: string;
    evidenceIdentityDigest: string;
    evidence: Array<{
      evidenceId: string;
      criterionKey: string;
      verifierDigest: string;
      kind: string;
      verdict: 'satisfies';
      identityDigest: string;
    }>;
    changedPathDigest: string;
    changedPathCount: number;
    changedPathSummaryDigest: string;
    diffPreviewLimit: number;
    diffStatDigest: string;
    diffStatTruncated: boolean;
    diffPreviewDigest: string;
    diffPreviewTruncated: boolean;
  };
  projection: {
    changedPaths: string[];
    changedPathsTruncated: boolean;
    diffStat: string;
    diffPreview: string;
    inspectionCommands: string[];
    manualIntegrationRequired: true;
    warning: string;
  };
  createdAt: string;
  handoffDigest: string;
}

export interface GoalManualHandoffProjection {
  state: 'current' | 'stale' | 'unavailable' | 'invalid';
  label: 'Ready for manual integration' | 'Handoff stale' | 'Handoff unavailable' | 'Handoff invalid';
  handoff: GoalManualIntegrationHandoff | null;
  reason: { code: string; message: string } | null;
  actualApplication: 'not_performed_by_turing';
  goalCompletion: 'not_completed_by_handoff';
}

export interface GoalManualHandoffPrepared {
  handoffId: string;
  handoffDigest: string;
  reused: boolean;
}

/** Closed set of reasons a client may claim when resuming. The supervisor decides whether the claim is factual. */
export const GOAL_RESUME_REASONS = [
  'user_resume',
  'gate_resolved',
  'run_resumed',
  'blocker_resolved',
  'amendment_approved',
  'amendment_discarded',
] as const;
export type GoalResumeReason = (typeof GOAL_RESUME_REASONS)[number];

/** A deterministic, read-only projection of "what can the user do next". It has no state authority. */
export type GoalNextAction =
  | { kind: 'author_definition' }
  | { kind: 'approve_definition'; version: number }
  | { kind: 'start' }
  | { kind: 'resume' }
  | { kind: 'wait_for_turing' }
  | { kind: 'review_approval'; approvalId: string }
  | { kind: 'resume_run'; runId: string }
  | { kind: 'resolve_blocker'; reasonCode: string }
  | { kind: 'revise_goal' }
  /** `resolved`: the amendment outcomes persisted history proves (the supervisor's own proof); empty = none yet. */
  | { kind: 'resume_after_amendment'; resolved: Array<'amendment_approved' | 'amendment_discarded'> }
  | { kind: 'final_acceptance'; approvalId: string | null }
  | { kind: 'final_apply' }
  | { kind: 'manual_reconciliation' }
  | { kind: 'completed' }
  | { kind: 'abandoned' };

export type GoalAttentionReason = 'status_needs_user' | 'status_blocked' | 'pending_goal_approval';

export interface GoalUsageSummary {
  events: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Committed metered spend from the canonical ledger (0 for a subscriptions-only Goal). */
  meteredSpendUsd: number;
}

export type GoalOpenFindingCounts = Record<FindingSeverity, number>;

export interface GoalCycleBrief {
  id: string;
  sequence: number;
  kind: GoalCycleKind;
  status: string;
  triggerCode: string;
  finishedAt: string | null;
}

export interface GoalListItem {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: GoalStatus;
  reasonCode: string | null;
  reasonDetail: Record<string, unknown> | null;
  /** Derived, never stored: needs_user, blocked, or an outstanding human Goal approval. */
  needsUser: boolean;
  attention: GoalAttentionReason[];
  /** Paused is reported separately; it is not "broken". */
  paused: boolean;
  pendingApprovalCount: number;
  currentDefinitionVersion: number | null;
  activeMilestone: { key: string; title: string; runtimeStatus: string } | null;
  lastCycle: GoalCycleBrief | null;
  nextAction: GoalNextAction;
  integrationBranch: string | null;
  integrationHead: string | null;
  openFindingCounts: GoalOpenFindingCounts;
  usageSummary: GoalUsageSummary;
  createdAt: string;
  updatedAt: string;
}

export interface GoalListResponse {
  goals: GoalListItem[];
  total: number;
  limit: number;
}

export interface GoalDefinitionSummary {
  version: number;
  parentVersion: number | null;
  status: GoalDefinitionStatus;
  definitionHash: string;
  changeSummary: string;
  createdBy: GoalDefinitionAuthor;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: 'user' | null;
  approvalId: string | null;
}

export interface GoalValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  code: string;
  message: string;
}

export interface GoalDefinitionValidation {
  valid: boolean;
  errors: GoalValidationIssue[];
  warnings: GoalValidationIssue[];
}

export interface GoalCreateResponse {
  goalId: string;
  version: number;
  definitionHash: string;
  validation: GoalDefinitionValidation;
}

export interface GoalDefinitionFull extends GoalDefinitionSummary {
  goalId: string;
  definition: GoalDefinition;
  validation: GoalDefinitionValidation;
}

export interface GoalApprovalView {
  id: string;
  goalId: string;
  gate: GoalApprovalGate;
  risk: GoalApprovalRisk;
  reason: string;
  requestedBy: string;
  status: GoalApprovalStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  respondedAt: string | null;
  /** Bounded identity-only detail (ids, versions, hashes, enumerated codes). */
  detail: Record<string, unknown>;
}

export interface GoalMilestoneView {
  key: string;
  title: string;
  ordinal: number;
  runtimeStatus: string;
  satisfiedAt: string | null;
  /** Fresh evaluation at the Goal head; null when the repository could not be read. */
  evaluation: { state: string; blockers: string[] } | null;
}

export interface GoalCompletionView {
  ok: boolean;
  definitionVersion: number | null;
  definitionHash: string | null;
  integrationHead: string;
  integrationTree: string;
  failures: CompletionFailure[];
  finalReview: { required: boolean; ok: boolean; reason: string | null };
  finalAcceptance: { required: boolean; ok: boolean; approvalId: string | null; reason: string | null };
  finalApply: { required: boolean; ok: boolean; basis: string | null; reason: string | null };
}

export interface GoalChildRunBrief {
  id: string;
  purpose: string;
  status: string;
}

export interface GoalFlags {
  cycleActive: boolean;
  childRun: 'none' | 'queued' | 'active' | 'paused';
  proposalRequired: boolean;
  userNeeded: boolean;
}

export interface GoalDetail extends GoalListItem {
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  runtime: {
    cyclesExecuted: number;
    consecutiveFailedCycles: number;
    remediationAttempts: Record<string, number>;
    activeMs: number;
  };
  currentDefinition: GoalDefinitionFull | null;
  proposedDefinition: GoalDefinitionFull | null;
  definitions: GoalDefinitionSummary[];
  milestones: GoalMilestoneView[];
  activeCycle: (GoalCycleBrief & { milestoneKey: string | null; createdAt: string }) | null;
  childRun: GoalChildRunBrief | null;
  memory: unknown | null;
  pendingApprovals: GoalApprovalView[];
  completion: GoalCompletionView | null;
  flags: GoalFlags;
}

export interface GoalRouteResolutionSummary {
  role: string;
  routeKind: 'pinned' | 'pool';
  poolId: string | null;
  identityHash: string;
  backendId: string | null;
  providerId: string | null;
  modelId: string | null;
  approvalState: 'not_required' | 'approved';
}

export interface GoalRunBrief {
  id: string;
  purpose: string;
  status: string;
  createdAt: string;
}

export interface GoalCycleView {
  id: string;
  sequence: number;
  kind: GoalCycleKind;
  status: string;
  triggerCode: string;
  definitionVersion: number | null;
  milestoneKey: string | null;
  baseIntegrationCommit: string | null;
  resultIntegrationCommit: string | null;
  validatedTask: {
    milestoneKey: string;
    title: string;
    targetCriteria: string[];
    expectedPaths: string[];
    workflowId: string | null;
  } | null;
  routeResolutions: GoalRouteResolutionSummary[];
  reviewPlan: { reviewKind: GoalReviewKind; reviewerCount: number; reviewedFromCommit: string | null } | null;
  remediationPlan: {
    definitionVersion: number;
    milestoneKey: string;
    episodes: Array<{ findingId: string; reason: string }>;
  } | null;
  verifierDigests: string[] | null;
  outcome: { code: string | null; summary: string | null; changedFiles: string[] } | null;
  runs: Record<string, GoalRunBrief[]>;
  createdAt: string;
  finishedAt: string | null;
}

export interface GoalCyclesResponse {
  cycles: GoalCycleView[];
  total: number;
  limit: number;
}

export interface GoalEvidenceView {
  id: string;
  kind: string;
  criterionKey: string;
  verifierDigest: string;
  verdict: string;
  definitionVersion: number;
  subject: {
    commit: string | null;
    tree: string | null;
    path: string | null;
    reviewedToCommit: string | null;
    reviewedToTree: string | null;
  };
  cycleId: string | null;
  runId: string | null;
  reviewId: string | null;
  recordedAt: string;
  freshness: 'current' | 'stale';
  staleReason?: string;
}

export interface GoalEvidenceResponse {
  evidence: GoalEvidenceView[];
  total: number;
  limit: number;
  /** The Goal head the freshness was computed against; null when the repository could not be read. */
  integrationHead: string | null;
}

export interface GoalReviewView {
  id: string;
  kind: GoalReviewKind;
  status: GoalReviewStatus;
  cycleId: string | null;
  runId: string | null;
  definitionVersion: number;
  milestoneKey: string | null;
  reviewedFromCommit: string | null;
  reviewedToCommit: string;
  reviewedToTree: string;
  verdict: ReviewVerdict | null;
  blocking: boolean | null;
  independence: ReviewIndependence | null;
  report: ReviewReport | null;
  /** Derived: a completed review whose tree equals the Goal head tree under the current definition. */
  currentAtHead: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface GoalReviewsResponse {
  reviews: GoalReviewView[];
  total: number;
  limit: number;
}

export interface GoalFindingView {
  id: string;
  severity: FindingSeverity;
  category: string;
  description: string;
  affectedFiles: string[];
  status: GoalFindingStatus;
  firstSeenReviewId: string;
  lastSeenReviewId: string;
  resolvedByReviewId: string | null;
  decisionApprovalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalFindingsResponse {
  findings: GoalFindingView[];
  total: number;
  limit: number;
}

export interface GoalEventView {
  id: string;
  seq: number;
  type: GoalEventType;
  payload: unknown;
  createdAt: string;
}

export interface GoalEventsResponse {
  events: GoalEventView[];
  /** Pass as `before` to fetch the next (older) page; null when there is no older event. */
  nextBefore: number | null;
  limit: number;
}

/** One approval in the unified inbox, from either the run-approval or the Goal-approval table. */
export interface UnifiedApproval {
  source: 'run' | 'goal';
  id: string;
  runId?: string;
  goalId?: string;
  /** Run approvals: the operation. Goal approvals: the gate. */
  title: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  status: GoalApprovalStatus;
  requestedBy?: string | null;
  decidedBy?: string | null;
  createdAt: string;
  respondedAt?: string | null;
  gate?: GoalApprovalGate;
  /**
   * Goal approvals only: whether the server would accept a user decision now. False for a Goal that is terminal or
   * needs manual reconciliation; the row is then shown read-only.
   */
  decidable?: boolean;
}

export interface UnifiedApprovalsResponse {
  approvals: UnifiedApproval[];
  total: number;
  limit: number;
}

export interface GoalDashboardSummary {
  total: number;
  active: number;
  needsUser: number;
  blocked: number;
  paused: number;
  /** The most relevant non-terminal Goals (attention first), bounded. */
  cards: GoalListItem[];
}

export interface GoalDashboardApprovals {
  pending: number;
  approvals: UnifiedApproval[];
}

export interface GoalPreview {
  goalId: string;
  status: GoalStatus;
  reasonCode: string | null;
  definition: { version: number; definitionHash: string } | null;
  activeMilestone: { key: string; title: string } | null;
  runtime: GoalDetail['runtime'];
  limits: {
    hard: Record<string, number | string | null>;
    remaining: Record<string, number | null>;
    breach: { reason: string; limit: number; observed: number } | null;
  } | null;
  integration: { branch: string | null; head: string | null; tree: string | null };
  currentCycle: (GoalCycleBrief & { milestoneKey: string | null }) | null;
  routing: {
    /** Always `stored`: derived from persisted observations and the cache, never a live refresh. */
    observation: 'stored';
    ok: boolean;
    roles: Array<{
      role: string;
      status: 'resolved' | 'refused';
      source?: 'computed' | 'persisted';
      code?: string;
      selection?: GoalRouteResolutionSummary;
    }>;
  } | null;
  billing: { mode: string; maxMeteredUsd: number | null; meteredSpendUsd: number } | null;
  proposalRequired: boolean;
  /** The exact persisted task when one exists; otherwise null (nothing is generated). */
  task: GoalCycleView['validatedTask'];
  completion: GoalCompletionView | null;
  blockers: CompletionFailure[];
  pendingApprovals: GoalApprovalView[];
  openFindingCounts: GoalOpenFindingCounts;
  nextAction: GoalNextAction;
}

export interface GoalFinalApplyPreflightView {
  status: string;
  recordedBaseBranch: string | null;
  recordedBaseCommit: string | null;
  currentBranch: string | null;
  currentHead: string | null;
  dirty: boolean | null;
  integrationHead: string | null;
  goalRef: string | null;
  fastForwardPossible: boolean | null;
  ahead: number | null;
  behind: number | null;
  changedPathCount: number;
  changedPaths: string[];
  safety: { ok: boolean; violationCount: number };
  /** The only place applied-externally will be offered; the action itself is not implemented yet (Stage 7C). */
  appliedExternallySupported: false;
  manualReconciliationRequired: boolean;
}
