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

export interface GoalExternalIntegrationObservation {
  schemaVersion: 1;
  kind: 'turing_goal_external_integration_observation';
  goalId: string;
  completionContractVersion: 2;
  handoff: { id: string; digest: string };
  definition: { version: number; hash: string; approvalId: string };
  review: { finalReviewId: string; acceptanceApprovalId: string; evidenceIdentityDigest: string };
  repository: {
    projectId: string;
    identity: string;
    scope: string;
    objectFormat: 'sha1' | 'sha256';
  };
  source: { ref: string; commit: string; tree: string };
  destination: {
    ref: string;
    expectedBaseCommit: string;
    expectedBaseTree: string;
    observedCommit: string;
    observedTree: string;
  };
  proof: {
    mode: 'source_history_observed';
    sourceAncestor: true;
    baseAncestor: true;
    verifierVersion: 1;
    evidenceDigest: string;
  };
  observedAt: string;
  actionDigest: string;
}

export type GoalExternalIntegrationAttestationRecord = Omit<
  GoalExternalIntegrationObservation,
  'kind' | 'observedAt' | 'actionDigest'
> & {
  kind: 'turing_goal_external_integration_attestation';
  attestationId: string;
  approvalId: string;
  decision: {
    value: 'confirm_external_integration';
    decidedBy: 'user';
    decidedAt: string;
  };
  observedAt: string;
  actionDigest: string;
  recordDigest: string;
};

export interface GoalExternalIntegrationStoredStatus {
  goalId: string;
  handoffId: string;
  hasAttestation: boolean;
  attestations: Array<{
    attestationId: string;
    actionDigest: string;
    recordDigest: string;
    approvalId: string;
    observedAt: string;
    decidedAt: string;
  }>;
  approvals: Array<{
    approvalId: string;
    actionDigest: string;
    status: GoalApprovalStatus;
    decidedBy: 'user' | 'system' | null;
    createdAt: string;
    respondedAt: string | null;
    attestationId: string | null;
  }>;
  limit: number;
  attestationsHaveMore: boolean;
  approvalsHaveMore: boolean;
}

export type GoalExternalIntegrationVerification =
  | {
      state: 'verified';
      observation: GoalExternalIntegrationObservation;
      proofLimitations: {
        sourceHistory: 'observed';
        contentPreservation: 'not_proven';
        goalCompletion: 'not_completed_by_attestation';
      };
      reason: null;
    }
  | {
      state: 'stale' | 'not_integrated' | 'unavailable' | 'invalid';
      observation: null;
      proofLimitations: {
        contentPreservation: 'not_proven';
        goalCompletion: 'not_completed_by_attestation';
      };
      reason: { code: string; message: string };
    };

export interface GoalExternalIntegrationAttestationProjection {
  state: 'current' | 'historical' | 'stale' | 'not_integrated' | 'unavailable' | 'invalid';
  record: GoalExternalIntegrationAttestationRecord | null;
  reason: { code: string; message: string } | null;
  claim: 'source_history_observed_at_recorded_time' | 'not_verified';
  contentPreservation: 'not_proven';
  goalCompletion: 'not_completed_by_attestation';
}

export interface GoalExternalIntegrationAttested {
  attestationId: string;
  approvalId: string;
  actionDigest: string;
  reusedAttestation: boolean;
  reusedApproval: boolean;
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

/**
 * The compact completion standing of one completed row in the Goal list (`GET /api/goals`). Additive, and set only for a
 * row whose stored status is `completed`. It is the reader's own classification of that row. `trusted` is the reader's
 * existing `trustedForDownstream` flag. It is NOT a claim that the Goal's content has been verified. No Git, proof or
 * attestation detail is carried here.
 */
export type CompletionStandingBrief =
  | {
      state: 'ready';
      standing:
        | 'uncontested'
        | 'disputed'
        | 'withdrawn'
        | 'superseded'
        | 'reconciliation_required'
        | 'invalid_unverified'
        | 'historical_legacy';
      qualifier: GoalCompletionStandingClaim['qualifier'];
      trusted: boolean;
      contentPreservation: GoalCompletionStandingClaim['contentPreservation'];
    }
  | { state: 'unreadable' };

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
  /**
   * Additive. Set by `GET /api/goals` only, and only on a row whose status is `completed`. A completed row with no brief,
   * or with an unrecognised one, must be shown as unavailable, never as completed.
   */
  completionStandingBrief?: CompletionStandingBrief;
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

/**
 * Mirror of the server's completion standing (`src/server/goals/completionStanding.ts`). The shared layer cannot import
 * the server, so the vocabulary is copied here. The detail route checks that the server reader's result is assignable to
 * this type at compile time, so the response cannot drift silently from this mirror in the server-to-shared direction.
 */
export type GoalCompletionStandingReason =
  | 'attestation_disputed'
  | 'attestation_withdrawn'
  | 'attestation_superseded'
  | 'replacement_not_uncontested'
  | 'attestation_unavailable'
  | 'legacy_completion'
  | 'reason_code_unclassifiable'
  | 'legacy_policy_unverified'
  | 'legacy_with_proof_row'
  | 'proof_without_completion'
  | 'proof_integrity_failed'
  | 'chain_identity_mismatch'
  | 'correction_time_invalid'
  | 'correction_mapping_unclassifiable'
  | 'integrity_check_failed';

export interface GoalCompletionStandingClaim {
  /** Means an uncontested recorded decision on a proof; never content correctness; read with contentPreservation. */
  unqualifiedSuccessAllowed: boolean;
  /** Means an uncontested recorded decision on a proof; never content correctness; read with contentPreservation. */
  trustedForDownstream: boolean;
  qualifier:
    | 'none'
    | 'disputed_by_user'
    | 'withdrawn_by_user'
    | 'superseded_by_user'
    | 'replacement_failed'
    | 'proof_unverified'
    | 'legacy_not_v2_attested'
    | 'not_completed';
  contentPreservation: 'not_proven' | 'not_applicable';
}

export type GoalCompletionStandingProof =
  | {
      state: 'valid';
      proofId: string;
      proofDigest: string;
      attestationId: string;
      attestationRecordDigest: string;
      approvalId: string;
      actionDigest: string;
      observedAt: string;
      chainAtProof: { sequence: 0; digest: string; standing: 'active_uncontested' };
    }
  | { state: 'invalid'; reason: string }
  | { state: 'legacy_no_proof' };

export interface GoalCompletionStandingTip {
  correctionId: string;
  kind: 'dispute' | 'withdraw' | 'supersede';
  sequence: number;
  correctionDigest: string;
  decidedAt: string;
  replacementAttestationId: string | null;
}

export interface GoalCompletionStandingCorrection {
  attestationId: string;
  standing: 'active_uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'invalid' | 'unavailable';
  correctionCount: number;
  tip: GoalCompletionStandingTip | null;
  correctedAfterCompletion: boolean | null;
  invalidCode: string | null;
  replacement: { attestationId: string; standing: GoalCompletionStandingCorrection['standing'] } | null;
}

export interface GoalCompletionStandingClassification {
  trust: 'trusted' | 'qualified' | 'untrusted';
  reconciliation: 'none' | 'required';
  reasons: GoalCompletionStandingReason[];
}

export interface GoalCompletionStandingOtherAttestation {
  attestationId: string;
  recordDigest: string;
  standing: GoalCompletionStandingCorrection['standing'];
  isReplacementOfProofAttestation: boolean;
  restoresCompletion: false;
}

interface GoalCompletionStandingBase {
  schemaVersion: 1;
  goalId: string;
  status: { goalStatus: GoalStatus; completedAt: string | null; reasonCode: string | null };
  claim: GoalCompletionStandingClaim;
}

/**
 * The Goal-level completion standing, a discriminated union on `kind`. `standing` is null only for a Goal that is not
 * completed. Only a version-2 Goal with `uncontested` standing is trusted; the claim says so, not the stored status.
 */
export type GoalCompletionStanding =
  | (GoalCompletionStandingBase & { kind: 'not_completed'; standing: null })
  | (GoalCompletionStandingBase & {
      kind: 'v2';
      standing: 'uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'reconciliation_required';
      proof: Extract<GoalCompletionStandingProof, { state: 'valid' }>;
      correction: GoalCompletionStandingCorrection;
      classification: GoalCompletionStandingClassification;
      otherAttestations: GoalCompletionStandingOtherAttestation[];
      otherAttestationsTruncated: boolean;
    })
  | (GoalCompletionStandingBase & {
      kind: 'legacy';
      standing: 'historical_legacy';
      proof: { state: 'legacy_no_proof' };
      correction: null;
      classification: GoalCompletionStandingClassification;
      otherAttestations: [];
      otherAttestationsTruncated: false;
    })
  | (GoalCompletionStandingBase & {
      kind: 'invalid';
      standing: 'invalid_unverified';
      proof: GoalCompletionStandingProof;
      correction: GoalCompletionStandingCorrection | null;
      classification: GoalCompletionStandingClassification;
      otherAttestations: [];
      otherAttestationsTruncated: false;
    });

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
  /**
   * Additive. Set only by the Goal detail route (`GET /api/goals/:goalId`), which composes it from the completion standing
   * reader. The read model's `getGoalDetail` does not set it, so it is optional on this type.
   */
  completionStanding?: GoalCompletionStanding;
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
  /**
   * Goal approvals only, set only for a row owned by a dedicated decision: a correction approval (any status), or a
   * completion approval while pending. Such a row is never decidable here; this names the review that decides it.
   */
  dedicatedDecision?: 'correction' | 'completion';
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

// --- Version-2 external completion (authenticated API; no completion is made by any read) --------------------------

/** One preflight check's name, in the fixed order the report lists them. */
export type GoalExternalCompletionPreflightCheckName =
  | 'input'
  | 'goal_status'
  | 'definition'
  | 'prior_completion'
  | 'attestation'
  | 'correction_standing'
  | 'snapshot_before'
  | 'completion_evaluation'
  | 'git_observation'
  | 'snapshot_after'
  | 'assemble';

/**
 * The preflight report exactly as the service computes it. A refused report is data (HTTP 200), not an error. `digest`
 * is the report's own digest; a completion decision must name it in If-Match. `actionFields` is null for a refusal.
 */
export interface GoalExternalCompletionPreflightReport {
  schemaVersion: number;
  kind: string;
  goalId: string;
  attestationId: string;
  outcome: 'ready' | 'refused';
  reasons: Array<{ code: string; detail: string | null }>;
  checks: Array<{ name: GoalExternalCompletionPreflightCheckName; status: 'passed' | 'failed' | 'skipped' }>;
  facts: {
    goalStatus: string | null;
    definitionVersion: number | null;
    definitionHash: string | null;
    lineageDigest: string | null;
    mode: 'legacy_v1' | 'external_user_attested_v2' | null;
    handoffId: string | null;
    handoffDigest: string | null;
    attestationActionDigest: string | null;
    attestationRecordDigest: string | null;
    correctionStanding: 'active_uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'invalid' | null;
    correctionSequence: number | null;
    destinationRef: string | null;
    attestedCommit: string | null;
    attestedTree: string | null;
    freshCommit: string | null;
    freshTree: string | null;
    objectFormat: 'sha1' | 'sha256' | null;
  };
  actionFields: Record<string, unknown> | null;
  proofLimitations: {
    contentPreservation: 'not_proven';
    goalCompletion: 'not_completed_by_preflight';
    destinationPolicy: 'exact_attested_tip';
  };
  authority: { mintsApproval: false; mintsProof: false; mintsTerminalAuthority: false };
  digest: string;
}

export interface GoalExternalCompletionPreflightResponse {
  preflight: GoalExternalCompletionPreflightReport;
}

/**
 * Whether a valid decision can still complete the Goal. Eligibility is correction standing only: never Git, never
 * staleness. `invalid` for any row that is not intact, including a row the authority classifier cannot vouch for.
 */
export type GoalExternalCompletionDecisionEligibility = 'eligible' | 'ineligible' | 'invalid';

/** One completion decision row of a Goal. Invalid rows carry no digest, attestation or status. */
export interface GoalExternalCompletionDecisionView {
  approvalId: string;
  actionDigest: string | null;
  attestationId: string | null;
  status: 'approved' | null;
  valid: boolean;
  invalidReason: string | null;
  eligibility: GoalExternalCompletionDecisionEligibility;
  /** The correction standing of the decision's attestation; null when the row is not intact. */
  correctionStanding: 'active_uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'invalid' | null;
}

/** The stored proof identity of a completed version-2 Goal. Historical identity: consult `completionStanding`. */
export interface GoalExternalCompletionRecord {
  proofId: string;
  proofDigest: string;
  approvalId: string;
  actionDigest: string;
  preflightDigest: string;
  observedAt: string;
  completedAt: string;
}

/**
 * The completion identity that R4 reports, read from the completion standing. It has no `preflightDigest`: the standing
 * does not carry the preflight that was reviewed. The POST response keeps `GoalExternalCompletionRecord` for that field.
 */
export interface GoalExternalCompletionStatusRecord {
  proofId: string;
  proofDigest: string;
  approvalId: string;
  actionDigest: string;
  attestationId: string;
  observedAt: string;
  completedAt: string;
}

/**
 * Read-only status. `state` describes the whole Goal and is derived from the decision rows and `completionStanding`, not
 * from the historical stored completion. `invalid` when any decision row or the standing is invalid; `completed` only for
 * a version-2 completion with uncontested standing; `contested` for a version-2 completion that a later correction
 * disputed, withdrew, superseded or left for reconciliation; `legacy` for a version-1 completion; `decided` when at least
 * one decision is `eligible` (a valid decision whose attestation is not corrected); `not_completed` otherwise. A corrected
 * decision stays in `decisions` as history and does not make the Goal `decided`. With `actionDigest`, `decisions` and
 * `completion` are filtered to that exact action.
 */
export interface GoalExternalCompletionStatus {
  goalId: string;
  state: 'not_completed' | 'decided' | 'completed' | 'contested' | 'legacy' | 'invalid';
  decisions: GoalExternalCompletionDecisionView[];
  completion: GoalExternalCompletionStatusRecord | null;
  completionStanding: GoalCompletionStanding;
}

/** Response of the completion decision POST (201 when new, 200 when reused). */
export interface GoalExternalCompletionDecisionRecorded {
  approvalId: string;
  actionDigest: string;
  preflightDigest: string;
  status: 'approved';
  reused: boolean;
}

/**
 * Response of the correction decision POST (201 when new, 200 when reused). `correctionId` and `sequence` are present
 * only for an approved decision. `completionStanding` is the Goal's standing after the decision.
 */
export interface GoalAttestationCorrectionDecisionRecorded {
  approvalId: string;
  status: 'approved' | 'denied';
  actionDigest: string;
  correctionId: string | null;
  sequence: number | null;
  reused: boolean;
  completionStanding: GoalCompletionStanding;
}

/** The seven reason codes of a correction request. The server's list must equal this one (see the drift test). */
export const GOAL_ATTESTATION_CORRECTION_REASON_CODES = [
  'integration_not_performed',
  'wrong_source',
  'wrong_destination',
  'content_not_preserved',
  'observation_error',
  'superseded_by_new_observation',
  'other',
] as const;
export type GoalAttestationCorrectionReasonCode = (typeof GOAL_ATTESTATION_CORRECTION_REASON_CODES)[number];
export type GoalAttestationCorrectionKind = 'dispute' | 'withdraw' | 'supersede';

/** The verified correction standing of one attestation, as the history read returns it. */
export interface GoalAttestationCorrectionStandingView {
  goalId: string;
  attestationId: string;
  standing: 'active_uncontested' | 'disputed' | 'withdrawn' | 'superseded' | 'invalid';
  correctionCount: number;
  tip: {
    correctionId: string;
    kind: GoalAttestationCorrectionKind;
    sequence: number;
    correctionDigest: string;
    replacementAttestationId: string | null;
  } | null;
  invalidCode: string | null;
}

/** One stored correction of an attestation, as the history read returns it. */
export interface GoalAttestationCorrectionEntry {
  correctionId: string;
  correctionKind: GoalAttestationCorrectionKind;
  sequence: number;
  correctionDigest: string;
  previousCorrectionDigest: string | null;
  actionDigest: string;
  approvalId: string;
  reasonCode: GoalAttestationCorrectionReasonCode;
  explanation: string | null;
  replacementAttestationId: string | null;
  replacementRecordDigest: string | null;
  decidedAt: string;
}

/** A correction request awaiting the user's decision. It never carries the explanation text. */
export interface GoalAttestationCorrectionPendingRequest {
  approvalId: string;
  actionDigest: string;
  correctionKind: GoalAttestationCorrectionKind;
  reasonCode: GoalAttestationCorrectionReasonCode;
  sequence: number;
  previousCorrectionDigest: string | null;
  replacementAttestationId: string | null;
  /** True when the decision must re-send the same explanation, because the reviewed action carries one. */
  explanationRequired: boolean;
  requestedAt: string;
}

/**
 * Response of the correction history GET. `chainPosition` is the If-Match value a request must send. `pending` lists
 * requests for this attestation awaiting a decision. The read changes nothing.
 */
export interface GoalAttestationCorrectionHistory {
  goalId: string;
  handoffId: string;
  attestationId: string;
  standing: GoalAttestationCorrectionStandingView;
  corrections: GoalAttestationCorrectionEntry[];
  chainPosition: string;
  pending: GoalAttestationCorrectionPendingRequest[];
  pendingUnreadableCount: number;
}

/** Response of the correction request POST (201 when new, 200 when an identical pending request already exists). */
export interface GoalAttestationCorrectionRequested {
  approvalId: string;
  actionDigest: string;
  status: 'pending';
  reused: boolean;
  detail: {
    correctionKind: GoalAttestationCorrectionKind;
    sequence: number;
    previousCorrectionDigest: string | null;
    replacementAttestationId: string | null;
    explanationDigest: string | null;
    reasonCode: GoalAttestationCorrectionReasonCode;
  };
}

/** Response of the completion POST (201 when new, 200 when reused). */
export interface GoalExternalCompletionCompleted {
  reused: boolean;
  completion: GoalExternalCompletionRecord;
  completionStanding: GoalCompletionStanding;
}
