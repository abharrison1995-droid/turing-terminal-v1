import type { BillingMode, ModelConfiguration } from './types.js';

/**
 * Canonical Goal domain types (design sections 5, 6 and 11). Pure data: no I/O and no behaviour beyond constants and
 * the transition table, so the server, validator and future client share one vocabulary.
 */

export type GoalStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'reviewing'
  | 'needs_user'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'abandoned';
export const GOAL_STATUSES: readonly GoalStatus[] = [
  'draft',
  'ready',
  'running',
  'reviewing',
  'needs_user',
  'blocked',
  'paused',
  'completed',
  'abandoned',
];
/** Statuses that hold the project lease (mirrors the 015 partial unique index). */
export const GOAL_LEASE_STATUSES: readonly GoalStatus[] = [
  'running',
  'reviewing',
  'needs_user',
  'blocked',
  'paused',
];

export type GoalRunPurpose =
  'authoring' | 'proposal' | 'execution' | 'review' | 'remediation' | 'verification';
export type GoalCycleKind = 'authoring' | 'execution' | 'remediation' | 'review' | 'verification';
export type GoalRole =
  'orchestrator' | 'implementer' | 'routine_reviewer' | 'milestone_reviewer' | 'final_reviewer';
export const GOAL_ROLES: readonly GoalRole[] = [
  'orchestrator',
  'implementer',
  'routine_reviewer',
  'milestone_reviewer',
  'final_reviewer',
];

export type GoalEvidenceKind =
  | 'test_result'
  | 'build_result'
  | 'lint_result'
  | 'run_result'
  | 'commit'
  | 'review_verdict'
  | 'artifact'
  | 'user_confirmation';

// --- Definition -------------------------------------------------------------------------------------------------

export interface GoalDefinition {
  contract: GoalContract;
  milestones: GoalMilestoneSpec[];
  routing: GoalRoutingPolicy;
  review: GoalReviewPolicy;
  limits: GoalLimits;
}

export interface Deliverable {
  key: string;
  description: string;
  /** Project-relative path the deliverable lives at, if it is a file. */
  path?: string;
  /** Criteria that verify this deliverable; every key must exist. */
  criterionKeys: string[];
}

export interface GoalContract {
  outcome: string;
  successCriteria: SuccessCriterion[];
  nonGoals: string[];
  constraints: string[];
  deliverables: Deliverable[];
  completionPolicy: CompletionPolicy;
}

export interface SuccessCriterion {
  /** Stable across definition versions. */
  key: string;
  statement: string;
  verification: VerificationSpec[];
  required: boolean;
}

export type VerificationSpec =
  | { kind: 'build'; command?: string[] }
  | { kind: 'test'; command?: string[] }
  | { kind: 'lint'; command?: string[] }
  | { kind: 'file_exists'; path: string }
  | { kind: 'review_verdict'; reviewKind: 'milestone' | 'final' }
  | { kind: 'commit_on_branch' }
  | { kind: 'user_confirmation'; prompt: string; freshness: 'any' | 'head-bound' };
export type VerificationKind = VerificationSpec['kind'];

export interface CompletionPolicy {
  /** Absent on historical v1 definitions so their canonical hashes remain unchanged. */
  completionContractVersion?: 2;
  /** Required together with completionContractVersion: 2. */
  integrationMode?: 'external_user_attested';
  requireFinalReview: boolean;
  requireUserAcceptance: boolean;
  applyToBase: 'required' | 'leave-on-goal-branch';
  maxOpenFindings: { critical: 0; high: 0; medium?: number };
  highSeverityResolution: 'review-only' | 'review-plus-head-bound-verifier';
}

export interface GoalMilestoneSpec {
  key: string;
  title: string;
  objective: string;
  /** Criterion keys this milestone owns. */
  criteria: string[];
  dependsOn: string[];
  allowedScope: { includeGlobs: string[]; excludeGlobs: string[] };
  requiredEvidence: Array<{ criterionKey: string; kinds: GoalEvidenceKind[] }>;
  reviewRequirements: { milestoneReview: boolean };
}

export type RouteAvailability = 'live-catalog' | 'fresh-validation' | 'live-catalog-or-fresh-validation';
export type FreshnessClass = 'stable-subscription' | 'opportunity';
export type ValidationProfile =
  'structured-readonly' | 'review-json' | 'orchestrator-json' | 'broker-read' | 'broker-edit';
export const VALIDATION_PROFILES: readonly ValidationProfile[] = [
  'structured-readonly',
  'review-json',
  'orchestrator-json',
  'broker-read',
  'broker-edit',
];

export interface RouteMember {
  /** Exact route; the billing lane is fixed here. Reused from the existing model-configuration types. */
  configuration: ModelConfiguration;
  identityKind?: 'pinned' | 'floating' | 'unknown';
  freshnessClass: FreshnessClass;
}

export type GoalRoute =
  | { kind: 'pinned'; member: RouteMember; availability: RouteAvailability; requireRoleValidation: boolean }
  | { kind: 'pool'; poolId: string };

export interface RoutePool {
  id: string;
  label: string;
  members: RouteMember[];
  admission: 'static' | 'opportunity';
  availability: RouteAvailability;
  requireRoleValidation: boolean;
  selection: 'ordered' | 'round_robin';
  laneClass: 'subscription' | 'permitted-by-billing-mode';
  autoRevalidate: false;
}

export interface IndependencePolicy {
  finalReview: 'different-family' | 'different-model' | 'none';
  against: Array<'implementer' | 'remediation' | 'orchestrator'>;
  allowFloatingFinalReviewer: boolean;
}

export interface GoalRoutingPolicy {
  roles: Partial<Record<GoalRole, GoalRoute>>;
  pools: RoutePool[];
  /** Workflow ids by purpose; checked against the registered workflows by the contextual validator. */
  workflows: { planning: string; execution: string; review: string; verification: string };
  independence: IndependencePolicy;
}

export interface GoalReviewPolicy {
  periodic?: {
    everyNExecutionCycles: number;
    reviewerCount: number;
    scope: 'since_last_review' | 'full_diff';
  };
  onMilestoneComplete: boolean;
  onRepeatedFailure?: { afterConsecutiveFailures: number };
  onScopeChange?: { pathsOutsideScopeAtLeast: number; diffLinesAtLeast?: number };
  final: boolean;
  blocking: { periodic: boolean; milestone: true; final: true };
}

export interface GoalHumanGates {
  eachCycle: boolean;
  beforeMilestoneComplete: boolean;
  poolRouteFirstUse: boolean;
  finalAcceptance: boolean;
}

export interface GoalLimits {
  maxExecutionCycles: number;
  maxConsecutiveFailedCycles: number;
  maxRemediationAttempts: number;
  maxActiveMinutes: number;
  maxWallClockDays: number;
  maxParallelAgents: number;
  /** null only when the billing mode forbids metered lanes. */
  maxMeteredUsd: number | null;
  billingMode: BillingMode;
  humanGates: GoalHumanGates;
}

/** Conservative V1 maxima: every autonomous loop is finite and small enough to supervise. */
export const GOAL_LIMIT_MAXIMA = {
  maxExecutionCycles: 200,
  maxConsecutiveFailedCycles: 20,
  maxRemediationAttempts: 20,
  maxActiveMinutes: 20_160,
  maxWallClockDays: 30,
  maxParallelAgents: 8,
  maxMeteredUsd: 1_000,
} as const;

export interface NextTask {
  milestoneKey: string;
  title: string;
  /** Bounded length. */
  instructions: string;
  targetCriteria: string[];
  expectedPaths: string[];
  workflowId?: string;
  rationale: string;
}

// --- Definition versions ----------------------------------------------------------------------------------------

export type GoalDefinitionStatus = 'proposed' | 'approved' | 'superseded' | 'rejected';
export type GoalDefinitionAuthor = 'user' | 'authoring_run' | 'amendment_assist';

export interface GoalDefinitionVersion {
  goalId: string;
  version: number;
  parentVersion: number | null;
  status: GoalDefinitionStatus;
  definition: GoalDefinition;
  definitionHash: string;
  changeSummary: string;
  createdBy: GoalDefinitionAuthor;
  approvedBy: 'user' | null;
  approvalId: string | null;
  createdAt: string;
  approvedAt: string | null;
}

// --- State machine ----------------------------------------------------------------------------------------------

export const NEEDS_USER_REASONS = [
  'gate_pending',
  'run_interrupted',
  'scope_violation',
  'base_diverged',
  'user_confirmation_pending',
  'review_needs_decision',
  'amendment_in_progress',
  'verification_failed',
] as const;
export const BLOCKED_REASONS = [
  'bound_cycles',
  'bound_failures',
  'bound_remediation',
  'bound_active_time',
  'bound_wall_clock',
  'bound_spend',
  'provider_exhausted',
  'provider_unavailable',
  'route_unavailable',
  'goal_ref_changed',
  'goal_ref_missing',
  'evidence_contradiction',
  'git_state_invalid',
  'review_blocked',
] as const;
export const PAUSED_REASONS = ['user', 'master_shutdown'] as const;
/** Reasons for statuses other than the three above. Machine-facing and enumerated; human text goes in detail. */
export const GOAL_TRANSITION_REASONS = [
  'definition_approved',
  'user_start',
  'user_resume',
  'user_revision',
  'user_abandoned',
  'review_triggered',
  'review_passed',
  'review_stale',
  'amendment_approved',
  'amendment_discarded',
  'gate_resolved',
  'run_resumed',
  'blocker_resolved',
  'completion_verified',
] as const;

export type NeedsUserReason = (typeof NEEDS_USER_REASONS)[number];
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
export type PausedReason = (typeof PAUSED_REASONS)[number];
export type GoalTransitionReason = (typeof GOAL_TRANSITION_REASONS)[number];
export type GoalReasonCode = NeedsUserReason | BlockedReason | PausedReason | GoalTransitionReason;

/**
 * The one reason code for a version-2 external completion. It is deliberately NOT in GOAL_TRANSITION_REASONS and not in
 * any GOAL_TRANSITIONS row, so the generic transition path cannot name it. Only the proof-bound terminal writer
 * (goals/externalCompletionTerminal.ts) records it.
 */
export const EXTERNAL_COMPLETION_REASON = 'external_completion_user_confirmed' as const;
export type ExternalCompletionReason = typeof EXTERNAL_COMPLETION_REASON;

export type GoalActor = 'user' | 'supervisor';

export interface GoalTransitionRule {
  from: GoalStatus;
  to: GoalStatus;
  /** Reason codes accepted for this edge. */
  reasons: readonly GoalReasonCode[];
  /** Who may cause the edge. */
  actors: readonly GoalActor[];
}

const either: readonly GoalActor[] = ['user', 'supervisor'];
const userOnly: readonly GoalActor[] = ['user'];
const supervisorOnly: readonly GoalActor[] = ['supervisor'];

/** The authoritative transition table (design section 6.1). Anything not listed is illegal. */
export const GOAL_TRANSITIONS: readonly GoalTransitionRule[] = [
  {
    from: 'draft',
    to: 'ready',
    reasons: ['definition_approved', 'amendment_discarded'],
    actors: userOnly,
  },
  { from: 'draft', to: 'abandoned', reasons: ['user_abandoned'], actors: userOnly },
  { from: 'ready', to: 'abandoned', reasons: ['user_abandoned'], actors: userOnly },
  { from: 'ready', to: 'running', reasons: ['user_start'], actors: userOnly },
  { from: 'ready', to: 'draft', reasons: ['user_revision'], actors: userOnly },
  { from: 'running', to: 'reviewing', reasons: ['review_triggered'], actors: supervisorOnly },
  {
    from: 'running',
    to: 'needs_user',
    reasons: NEEDS_USER_REASONS,
    actors: either,
  },
  { from: 'running', to: 'blocked', reasons: BLOCKED_REASONS, actors: supervisorOnly },
  { from: 'running', to: 'paused', reasons: PAUSED_REASONS, actors: either },
  { from: 'running', to: 'completed', reasons: ['completion_verified'], actors: supervisorOnly },
  { from: 'reviewing', to: 'running', reasons: ['review_passed', 'review_stale'], actors: supervisorOnly },
  { from: 'reviewing', to: 'blocked', reasons: ['review_blocked'], actors: supervisorOnly },
  { from: 'reviewing', to: 'needs_user', reasons: ['review_needs_decision'], actors: supervisorOnly },
  {
    from: 'needs_user',
    to: 'running',
    reasons: ['gate_resolved', 'run_resumed', 'amendment_approved', 'amendment_discarded'],
    actors: either,
  },
  { from: 'needs_user', to: 'abandoned', reasons: ['user_abandoned'], actors: userOnly },
  { from: 'blocked', to: 'abandoned', reasons: ['user_abandoned'], actors: userOnly },
  { from: 'paused', to: 'abandoned', reasons: ['user_abandoned'], actors: userOnly },
  { from: 'blocked', to: 'running', reasons: ['blocker_resolved', 'amendment_approved'], actors: either },
  { from: 'blocked', to: 'needs_user', reasons: ['amendment_in_progress'], actors: userOnly },
  { from: 'paused', to: 'needs_user', reasons: ['amendment_in_progress'], actors: userOnly },
  // The one needs_user self-transition: the user leaves a denied-gate episode and starts an amendment (a new episode).
  { from: 'needs_user', to: 'needs_user', reasons: ['amendment_in_progress'], actors: userOnly },
  { from: 'paused', to: 'running', reasons: ['user_resume'], actors: userOnly },
];

/** The one definition of a finished run (the runs table has no other terminal status). */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = ['completed', 'abandoned'];

// --- Evidence, reviews, findings, approvals, events, route validations (migration 017) ---------------------------

export type GoalReviewKind = 'periodic' | 'milestone' | 'repeated_failure' | 'scope_change' | 'final';
export type GoalReviewStatus = 'pending' | 'completed' | 'failed' | 'cancelled';
export type ReviewVerdict = 'pass' | 'pass_with_findings' | 'block';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type GoalFindingStatus = 'open' | 'resolved' | 'accepted_by_user' | 'dismissed_by_user';
export type FindingObservationKind = 'new' | 'still_open' | 'resolved' | 'reopened' | 'not_assessed';
export type EvidenceVerdict = 'satisfies' | 'contradicts' | 'inconclusive';

export interface ReviewReport {
  verdict: ReviewVerdict;
  criterionProgress: Array<{
    criterionKey: string;
    assessment: 'met' | 'partial' | 'not_met' | 'unknown';
    basis: string;
  }>;
  existingFindings: Array<{
    goalFindingId: string;
    status: 'still_open' | 'resolved' | 'not_assessed';
    basis: string;
  }>;
  newFindings: Array<{
    severity: FindingSeverity;
    category: string;
    description: string;
    evidence: string;
    affectedFiles: string[];
    remediation: string;
  }>;
  regressions: string[];
  scopeDrift: boolean;
  architectureDrift: boolean;
  furtherWorkJustified: boolean;
}

export const GOAL_APPROVAL_GATES = [
  'definition',
  'amendment',
  'start',
  'each_cycle',
  'milestone_complete',
  'pool_route_first_use',
  'scope_change',
  'review_decision',
  'finding_decision',
  'user_confirmation',
  'final_acceptance',
  'final_apply',
] as const;
export type GoalApprovalGate = (typeof GOAL_APPROVAL_GATES)[number];
export type GoalApprovalRisk = 'low' | 'medium' | 'high';
export type GoalApprovalStatus = 'pending' | 'approved' | 'denied';
export type GoalApprovalRequester = 'user' | 'supervisor' | 'system';

export interface GoalApproval {
  id: string;
  goalId: string;
  gate: GoalApprovalGate;
  risk: GoalApprovalRisk;
  reason: string;
  requestedBy: GoalApprovalRequester;
  detail: Record<string, unknown>;
  status: GoalApprovalStatus;
  decidedBy: 'user' | 'system' | null;
  decisionNote: string | null;
  createdAt: string;
  respondedAt: string | null;
  /** Present only for a prospective final-apply authority record. */
  intentDigest?: string;
  /** Present only for a versioned external-integration confirmation decision. */
  externalIntegrationActionDigest?: string;
  /** Present only for the future, separately approved version-2 Goal-completion decision. */
  externalCompletionActionDigest?: string;
  /** Present only for a versioned, high-risk user decision that appends an attestation correction. */
  attestationCorrectionActionDigest?: string;
}

export const GOAL_EVENT_TYPES = [
  'external_integration_corrected',
  'goal_created',
  'definition_proposed',
  'definition_approved',
  'definition_rejected',
  'amendment_started',
  'state_changed',
  'approval_requested',
  'approval_decided',
  'evidence_recorded',
  'review_completed',
  'review_findings_applied',
  'finding_opened',
  'finding_resolved',
  'finding_reopened',
  'finding_decided',
  'milestone_satisfied',
  'completion_evaluated',
  'cycle_created',
  'cycle_finished',
  'counters_reconciled',
  'run_evidence_collected',
  'goal_authoring_completed',
  'goal_authoring_failed',
  'external_completion_recorded',
] as const;
export type GoalEventType = (typeof GOAL_EVENT_TYPES)[number];

export interface RouteValidationRecord {
  id: string;
  identityHash: string;
  identity: Record<string, unknown>;
  profile: ValidationProfile;
  status: 'pass' | 'fail';
  evidenceRunId: string | null;
  resolvedModelReported: string | null;
  checks: unknown;
  provenance: 'turing_probe_run';
  adapterVersion: string;
  capabilityFingerprint: string;
  testedAt: string;
  expiresAt: string;
}

// --- Evidence evaluation and completion -------------------------------------------------------------------------

/** What a completed final review records about independence; established by the routing authority. */
export interface ReviewIndependence {
  established: boolean;
  /** The policy it was established under; must equal the current definition's `routing.independence.finalReview`. */
  policy: IndependencePolicy['finalReview'];
  detail?: Record<string, unknown>;
}

export type VerifierState = 'satisfied' | 'contradicted' | 'missing' | 'stale' | 'inconclusive';

export type EvidenceIneligibleReason = 'kind_mismatch' | 'verifier_changed';
export type EvidenceStaleReason =
  | 'tree_changed'
  | 'no_subject_tree'
  | 'path_missing'
  | 'path_changed'
  | 'path_present'
  | 'path_outside_scope'
  | 'not_ancestor'
  | 'review_missing'
  | 'review_not_completed'
  | 'approval_missing';

export interface EvidenceAssessment {
  evidenceId: string;
  kind: GoalEvidenceKind;
  verdict: EvidenceVerdict;
  recordedAt: string;
  /** `current` evidence counts; `stale` evidence is ignored; `ineligible` evidence can never count. */
  standing: 'current' | 'stale' | 'ineligible';
  reason?: EvidenceStaleReason | EvidenceIneligibleReason;
}

export interface VerifierEvaluation {
  verifierDigest: string;
  kind: VerificationKind;
  state: VerifierState;
  /** The latest current evidence row that decided the state, when there is one. */
  decidingEvidenceId: string | null;
  decidingKind: GoalEvidenceKind | null;
  evidence: EvidenceAssessment[];
}

export interface CriterionEvaluation {
  key: string;
  required: boolean;
  state: VerifierState;
  verifiers: VerifierEvaluation[];
  /** Evidence ids that satisfy the criterion (empty unless satisfied). */
  satisfiedBy: string[];
}

export type MilestoneState = 'satisfied' | 'skipped_by_user' | 'unsatisfied';
export type MilestoneBlocker =
  | 'criteria_unsatisfied'
  | 'required_evidence_missing'
  | 'milestone_review_missing'
  | 'milestone_review_stale'
  | 'milestone_review_not_passing'
  | 'human_gate_missing';

export interface MilestoneEvaluation {
  key: string;
  milestoneId: string | null;
  state: MilestoneState;
  blockers: MilestoneBlocker[];
  /** The approval that explicitly skipped it, for `skipped_by_user`. */
  skipApprovalId: string | null;
  criteria: Array<{ key: string; state: VerifierState }>;
}

export type CompletionFailureCode =
  | 'goal_not_found'
  | 'definition_not_approved'
  | 'goal_ref_unavailable'
  | 'criterion_unsatisfied'
  | 'milestone_unsatisfied'
  | 'findings_over_threshold'
  | 'final_review_missing'
  | 'final_review_stale'
  | 'final_review_not_passing'
  | 'final_review_independence'
  | 'final_acceptance_missing'
  | 'final_apply_required'
  | 'external_completion_not_activated'
  | 'completion_policy_unsupported';

export interface CompletionFailure {
  code: CompletionFailureCode;
  /** Criterion key, milestone key, severity or other subject, when there is one. */
  subject?: string;
  detail: string;
}

export interface CompletionEvaluation {
  ok: boolean;
  goalId: string;
  definitionVersion: number;
  definitionHash: string;
  integrationHead: string;
  integrationTree: string;
  evaluatedAt: string;
  criteria: CriterionEvaluation[];
  milestones: MilestoneEvaluation[];
  findings: {
    open: Record<FindingSeverity, number>;
    limits: { critical: number; high: number; medium: number | null };
    ok: boolean;
  };
  finalReview: { required: boolean; ok: boolean; reviewId: string | null; reason: string | null };
  finalAcceptance: { required: boolean; ok: boolean; approvalId: string | null; reason: string | null };
  finalApply: {
    required: boolean;
    ok: boolean;
    basis: 'not_required' | 'applied_by_turing' | 'applied_externally' | null;
    reason: string | null;
  };
  failures: CompletionFailure[];
}
