import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { GOAL_TERMINAL_STATUSES, TERMINAL_RUN_STATUSES } from '../../shared/goals.js';
import type { GoalApproval } from '../../shared/goals.js';
import type { Db } from '../db.js';
import {
  changedEntries,
  changedPathSet,
  checkChangedPaths,
  gitTry,
  goalRefName,
  loadContext,
  repositoryObjectFormat,
  scanChangedContent,
  type GoalContext,
  type ObjectFormat,
} from '../goalGit.js';
import { redactSecrets } from '../security.js';
import { computeFinalApplyRepositoryIdentity } from './finalApplyOperation.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import { getGoalApproval } from './approvals.js';
import { getReview, type GoalReviewRow } from './reviews.js';
import { activeCycle } from './cycles.js';
import { isManualReconciliation } from './readModel.js';
import { listVerifiers } from './verifierDigest.js';
import { canonicalJson } from './definitionHash.js';
import type { EvidenceRow } from './freshness.js';

const SHA256 = /^[0-9a-f]{64}$/;
const OID = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ } as const;
const MAX_CHANGED_PATHS = 100_000;
const MAX_PATHS_IN_PROJECTION = 100;
const MAX_PATH_DISPLAY_CHARS = 300;
const MAX_DIFF_STAT_CHARS = 4_000;
const MAX_DIFF_PREVIEW_CHARS = 12_000;
const MAX_EVIDENCE_ROWS = 1_000;
const HANDOFF_WARNING =
  'Turing prepared this result but did not apply it. Recheck both commit identities and your worktree before integrating it manually.';

const hexDigest = z.string().regex(SHA256);
const uuid = z.string().uuid();
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const evidenceIdentitySchema = z
  .object({
    evidenceId: z.string().min(1).max(200),
    criterionKey: z.string().min(1).max(200),
    verifierDigest: hexDigest,
    kind: z.string().min(1).max(40),
    verdict: z.literal('satisfies'),
    identityDigest: hexDigest,
  })
  .strict();

const handoffSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('turing_goal_manual_integration_handoff'),
    handoffId: uuid,
    goalId: uuid,
    definition: z
      .object({
        version: z.number().int().positive(),
        hash: hexDigest,
        approvalId: z.string().min(1).max(200),
        approvalIdentityDigest: hexDigest,
      })
      .strict(),
    finalAcceptance: z.object({ approvalId: z.string().min(1).max(200), identityDigest: hexDigest }).strict(),
    repository: z
      .object({
        projectId: z.string().min(1).max(200),
        identity: hexDigest,
        objectFormat: z.enum(['sha1', 'sha256']),
        scope: z.string().max(1_000),
      })
      .strict(),
    source: z.object({ goalRef: z.string().min(1).max(500), commit: objectId, tree: objectId }).strict(),
    target: z
      .object({
        baseBranch: z.string().min(1).max(300),
        baseRef: z.string().min(1).max(500),
        observedBaseCommit: objectId,
        observedBaseTree: objectId,
      })
      .strict(),
    completion: z.object({ identityDigest: hexDigest, findingsIdentityDigest: hexDigest }).strict(),
    review: z
      .object({
        finalReviewId: z.string().min(1).max(200),
        reviewIdentityDigest: hexDigest,
        evidenceIdentityDigest: hexDigest,
        evidence: z.array(evidenceIdentitySchema).max(MAX_EVIDENCE_ROWS),
        changedPathDigest: hexDigest,
        changedPathCount: z.number().int().nonnegative().max(MAX_CHANGED_PATHS),
        changedPathSummaryDigest: hexDigest,
        diffPreviewLimit: z.number().int().min(128).max(MAX_DIFF_PREVIEW_CHARS),
        diffStatDigest: hexDigest,
        diffStatTruncated: z.boolean(),
        diffPreviewDigest: hexDigest,
        diffPreviewTruncated: z.boolean(),
      })
      .strict(),
    projection: z
      .object({
        changedPaths: z.array(z.string().max(MAX_PATH_DISPLAY_CHARS)).max(MAX_PATHS_IN_PROJECTION),
        changedPathsTruncated: z.boolean(),
        diffStat: z.string().max(MAX_DIFF_STAT_CHARS),
        diffPreview: z.string().max(MAX_DIFF_PREVIEW_CHARS),
        inspectionCommands: z.array(z.string().max(2_000)).length(3),
        manualIntegrationRequired: z.literal(true),
        warning: z.string().max(500),
      })
      .strict(),
    createdAt: z.string().datetime(),
    handoffDigest: hexDigest,
  })
  .strict();

export type ManualIntegrationHandoffV1 = z.infer<typeof handoffSchema>;
type HandoffIdentity = Omit<ManualIntegrationHandoffV1, 'handoffId' | 'createdAt' | 'handoffDigest'>;

export type ManualHandoffErrorCode =
  | 'goal_not_found'
  | 'goal_ineligible'
  | 'manual_reconciliation_required'
  | 'active_work'
  | 'pending_review'
  | 'integration_operation_in_progress'
  | 'definition_not_approved'
  | 'final_acceptance_changed'
  | 'final_review_changed'
  | 'criterion_unsatisfied'
  | 'findings_blocked'
  | 'repository_identity_changed'
  | 'completion_not_ready'
  | 'repository_unavailable'
  | 'git_unavailable'
  | 'source_ref_missing'
  | 'source_changed'
  | 'source_tree_unavailable'
  | 'base_ref_invalid'
  | 'base_ref_missing'
  | 'base_diverged'
  | 'base_tree_unavailable'
  | 'not_fast_forward'
  | 'no_changes'
  | 'unsafe_changes'
  | 'snapshot_changed'
  | 'evidence_invalid'
  | 'handoff_invalid';

const ERROR_MESSAGES: Record<ManualHandoffErrorCode, string> = {
  goal_not_found: 'The Goal does not exist.',
  goal_ineligible: 'This Goal is not eligible for a manual integration handoff.',
  manual_reconciliation_required: 'The Goal requires manual reconciliation before a handoff can be prepared.',
  active_work: 'Goal execution or a review cycle is still active.',
  pending_review: 'A review is still pending and may change the accepted result.',
  integration_operation_in_progress: 'A Goal integration operation is unresolved.',
  definition_not_approved: 'The current Goal definition is not validly approved.',
  final_acceptance_changed: 'The final user acceptance no longer matches this handoff.',
  final_review_changed: 'The independent final review no longer matches this handoff.',
  criterion_unsatisfied: 'A required verification criterion is no longer satisfied.',
  findings_blocked: 'Open findings now block this Goal from handoff.',
  repository_identity_changed: 'The registered project now points to a different repository identity.',
  completion_not_ready: 'The Goal has unmet completion requirements other than final integration.',
  repository_unavailable: 'The registered Git repository could not be identified safely.',
  git_unavailable: 'Required Git objects or read-only repository data are unavailable.',
  source_ref_missing: 'The Goal source ref is missing.',
  source_changed: 'The Goal source ref changed while the handoff was being prepared.',
  source_tree_unavailable: 'The Goal source tree cannot be read.',
  base_ref_invalid: 'The recorded target branch is not a valid local branch ref.',
  base_ref_missing: 'The recorded target branch is missing.',
  base_diverged: 'The target branch moved from the base commit recorded for this Goal.',
  base_tree_unavailable: 'The target branch tree cannot be read.',
  not_fast_forward: 'The Goal source is not a fast-forward from the recorded target base.',
  no_changes: 'The Goal source contains no changes from the recorded target base.',
  unsafe_changes: 'The result contains a path or content that cannot be handed off safely.',
  snapshot_changed: 'Authoritative Goal or Git state changed while preparing the handoff.',
  evidence_invalid: 'The evidence selected by completion could not be verified.',
  handoff_invalid: 'The stored manual handoff is malformed or its identity does not verify.',
};

export class ManualHandoffError extends Error {
  constructor(
    readonly code: ManualHandoffErrorCode,
    message = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = 'ManualHandoffError';
  }
}

export interface ManualHandoffSnapshot {
  identity: HandoffIdentity;
  handoffDigest: string;
  databaseFingerprint: string;
}

export interface ManualHandoffBuildOptions {
  previewChars?: number;
}

interface RuntimeRow {
  integration_head: string | null;
  base_branch: string | null;
  base_commit: string | null;
}

interface HandoffDbRow {
  id: string;
  goal_id: string;
  schema_version: number;
  kind: string;
  handoff_digest: string;
  definition_version: number;
  final_acceptance_approval_id: string;
  final_review_id: string;
  source_commit: string;
  source_tree: string;
  base_ref: string;
  observed_base_commit: string;
  payload_json: string;
  created_at: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function identityFromRecord(record: ManualIntegrationHandoffV1): HandoffIdentity {
  const { handoffId: _handoffId, createdAt: _createdAt, handoffDigest: _handoffDigest, ...identity } = record;
  void _handoffId;
  void _createdAt;
  void _handoffDigest;
  return identity;
}

export function computeManualHandoffDigest(identity: HandoffIdentity): string {
  return sha256(`turing-goal-manual-integration-handoff-v1\n${canonicalJson(identity)}`);
}

function parseHandoff(raw: string): ManualIntegrationHandoffV1 | null {
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = handoffSchema.safeParse(value);
    if (!parsed.success || canonicalJson(parsed.data) !== raw) return null;
    if (
      parsed.data.source.goalRef !== `refs/heads/turing/goal/${parsed.data.goalId}` ||
      parsed.data.target.baseRef !== `refs/heads/${parsed.data.target.baseBranch}`
    )
      return null;
    if (computeManualHandoffDigest(identityFromRecord(parsed.data)) !== parsed.data.handoffDigest)
      return null;
    const format = parsed.data.repository.objectFormat;
    if (
      !OID[format].test(parsed.data.source.commit) ||
      !OID[format].test(parsed.data.source.tree) ||
      !OID[format].test(parsed.data.target.observedBaseCommit) ||
      !OID[format].test(parsed.data.target.observedBaseTree)
    )
      return null;
    const expectedCommands = [
      `git show --stat ${parsed.data.source.commit}`,
      `git diff --stat ${parsed.data.target.observedBaseCommit} ${parsed.data.source.commit}`,
      `git diff ${parsed.data.target.observedBaseCommit} ${parsed.data.source.commit}`,
    ];
    if (canonicalJson(parsed.data.projection.inspectionCommands) !== canonicalJson(expectedCommands))
      return null;
    if (parsed.data.projection.warning !== HANDOFF_WARNING) return null;
    if (safeDisplayPath(parsed.data.target.baseBranch) !== parsed.data.target.baseBranch) return null;
    if (parsed.data.projection.changedPaths.some((path) => safeDisplayPath(path) !== path)) return null;
    if (
      parsed.data.review.changedPathCount === 0 ||
      parsed.data.review.changedPathCount < parsed.data.projection.changedPaths.length ||
      parsed.data.projection.changedPathsTruncated !==
        parsed.data.review.changedPathCount > parsed.data.projection.changedPaths.length ||
      parsed.data.review.changedPathSummaryDigest !==
        digest({
          paths: parsed.data.projection.changedPaths,
          truncated: parsed.data.projection.changedPathsTruncated,
        }) ||
      parsed.data.review.diffStatDigest !== sha256(parsed.data.projection.diffStat) ||
      parsed.data.review.diffPreviewDigest !== sha256(parsed.data.projection.diffPreview)
    )
      return null;
    if (
      boundedDisplay(parsed.data.projection.diffStat, MAX_DIFF_STAT_CHARS).value !==
        parsed.data.projection.diffStat ||
      boundedDisplay(parsed.data.projection.diffPreview, MAX_DIFF_PREVIEW_CHARS).value !==
        parsed.data.projection.diffPreview
    )
      return null;
    const truncationSuffix = '\n… [truncated]';
    if (
      (parsed.data.review.diffPreviewTruncated &&
        (parsed.data.projection.diffPreview.length !== parsed.data.review.diffPreviewLimit ||
          !parsed.data.projection.diffPreview.endsWith(truncationSuffix))) ||
      (parsed.data.review.diffStatTruncated &&
        (parsed.data.projection.diffStat.length !== MAX_DIFF_STAT_CHARS ||
          !parsed.data.projection.diffStat.endsWith(truncationSuffix)))
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function assert(condition: unknown, code: ManualHandoffErrorCode): asserts condition {
  if (!condition) throw new ManualHandoffError(code);
}

interface DefinitionApprovalLineage {
  gate: 'definition' | 'amendment';
  approval: GoalApproval;
}

/**
 * Re-proves the approved definition chain using the same parent-version rule as approveDefinition() and migration
 * 018: a root version 1 uses `definition`; every linked child version uses `amendment`. The current version must be
 * the Goal pointer, and every ancestor must be a user-approved, hash-valid superseded version with its own matching
 * persisted approval. This also fails closed for pre-migration or corrupted rows that the status trigger did not
 * revalidate.
 */
function definitionApprovalLineage(
  db: Db,
  goalId: string,
  version: NonNullable<ReturnType<typeof loadDefinitionVersion>>,
): DefinitionApprovalLineage | null {
  try {
    const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
      { current_definition_version: number | null } | undefined;
    if (!goal || goal.current_definition_version !== version.version) return null;

    let candidate = version;
    let isCurrent = true;
    let targetProof: DefinitionApprovalLineage | null = null;
    const visited = new Set<number>();
    for (;;) {
      if (visited.has(candidate.version)) return null;
      visited.add(candidate.version);
      const gate =
        candidate.parentVersion === null ? (candidate.version === 1 ? 'definition' : null) : 'amendment';
      if (
        !gate ||
        candidate.status !== (isCurrent ? 'approved' : 'superseded') ||
        candidate.approvedBy !== 'user' ||
        !candidate.approvalId ||
        !verifyDefinitionHash(candidate)
      )
        return null;

      const approval = getGoalApproval(db, candidate.approvalId);
      if (
        !approval ||
        approval.goalId !== goalId ||
        approval.gate !== gate ||
        approval.status !== 'approved' ||
        approval.decidedBy !== 'user' ||
        approval.detail.version !== candidate.version ||
        approval.detail.definitionHash !== candidate.definitionHash
      )
        return null;
      if (isCurrent) targetProof = { gate, approval };

      if (candidate.parentVersion === null) return candidate.version === 1 ? targetProof : null;
      if (
        !Number.isSafeInteger(candidate.parentVersion) ||
        candidate.parentVersion < 1 ||
        candidate.parentVersion >= candidate.version
      )
        return null;
      const parent = loadDefinitionVersion(db, goalId, candidate.parentVersion);
      if (!parent) return null;
      candidate = parent;
      isCurrent = false;
    }
  } catch {
    return null;
  }
}

function getRuntime(db: Db, goalId: string): RuntimeRow | undefined {
  return db
    .prepare('SELECT integration_head, base_branch, base_commit FROM goal_runtime WHERE goal_id = ?')
    .get(goalId) as RuntimeRow | undefined;
}

function getApprovalIdentity(approval: GoalApproval): Record<string, unknown> {
  return {
    id: approval.id,
    goalId: approval.goalId,
    gate: approval.gate,
    risk: approval.risk,
    reason: approval.reason,
    requestedBy: approval.requestedBy,
    detail: approval.detail,
    status: approval.status,
    decidedBy: approval.decidedBy,
    decisionNote: approval.decisionNote,
    createdAt: approval.createdAt,
    respondedAt: approval.respondedAt,
    intentDigest: approval.intentDigest ?? null,
  };
}

function getReviewIdentity(review: GoalReviewRow): Record<string, unknown> {
  return {
    id: review.id,
    goalId: review.goalId,
    cycleId: review.cycleId,
    milestoneId: review.milestoneId,
    definitionVersion: review.definitionVersion,
    runId: review.runId,
    reviewKind: review.reviewKind,
    status: review.status,
    reviewedFromCommit: review.reviewedFromCommit,
    reviewedToCommit: review.reviewedToCommit,
    reviewedToTree: review.reviewedToTree,
    verdict: review.verdict,
    blocking: review.blocking,
    report: review.report,
    independence: review.independence,
    createdAt: review.createdAt,
    completedAt: review.completedAt,
  };
}

function evidenceIdentity(row: EvidenceRow): Record<string, unknown> {
  let reference: unknown;
  try {
    reference = JSON.parse(row.ref_json) as unknown;
  } catch {
    throw new ManualHandoffError('evidence_invalid');
  }
  return {
    id: row.id,
    goalId: row.goal_id,
    definitionVersion: row.definition_version,
    milestoneId: row.milestone_id,
    criterionKey: row.criterion_key,
    verifierDigest: row.verifier_digest,
    kind: row.kind,
    verdict: row.verdict,
    cycleId: row.cycle_id,
    runId: row.run_id,
    stageId: row.stage_id,
    reviewId: row.review_id,
    subjectCommit: row.subject_commit,
    subjectTree: row.subject_tree,
    subjectPath: row.subject_path,
    subjectBlob: row.subject_blob,
    subjectSha256: row.subject_sha256,
    reviewedFromCommit: row.reviewed_from_commit,
    reviewedToCommit: row.reviewed_to_commit,
    reviewedToTree: row.reviewed_to_tree,
    reference,
    recordedAt: row.recorded_at,
  };
}

function completionIdentity(evaluation: Awaited<ReturnType<typeof evaluateCompletion>>): unknown {
  return {
    goalId: evaluation.goalId,
    definitionVersion: evaluation.definitionVersion,
    definitionHash: evaluation.definitionHash,
    integrationHead: evaluation.integrationHead,
    integrationTree: evaluation.integrationTree,
    criteria: evaluation.criteria.map((criterion) => ({
      key: criterion.key,
      required: criterion.required,
      state: criterion.state,
      verifiers: criterion.verifiers.map((verifier) => ({
        verifierDigest: verifier.verifierDigest,
        kind: verifier.kind,
        state: verifier.state,
        decidingEvidenceId: verifier.decidingEvidenceId,
        decidingKind: verifier.decidingKind,
      })),
    })),
    milestones: evaluation.milestones.map((milestone) => ({
      key: milestone.key,
      milestoneId: milestone.milestoneId,
      state: milestone.state,
      blockers: milestone.blockers,
      skipApprovalId: milestone.skipApprovalId,
    })),
    findings: evaluation.findings,
    finalReview: evaluation.finalReview,
    finalAcceptance: evaluation.finalAcceptance,
    finalApply: evaluation.finalApply,
    failures: evaluation.failures.map((failure) => ({
      code: failure.code,
      subject: failure.subject ?? null,
    })),
  };
}

function findingsIdentityDigest(db: Db, goalId: string): string {
  const rows = db
    .prepare(
      `SELECT id, fingerprint, severity, category, description, affected_files_json, status,
              first_seen_review_id, last_seen_review_id, created_at, updated_at
       FROM goal_findings WHERE goal_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(goalId);
  return digest(rows);
}

function databaseFingerprint(
  db: Db,
  goalId: string,
  options: { excludeExternalIntegrationApprovals?: boolean } = {},
): string {
  const goal = db
    .prepare(
      `SELECT g.status, g.status_reason_code, g.status_detail_json, g.current_definition_version,
              g.project_id, p.path AS project_path, p.git_root
       FROM goals g JOIN projects p ON p.id = g.project_id WHERE g.id = ?`,
    )
    .get(goalId) as Record<string, unknown> | undefined;
  if (!goal) throw new ManualHandoffError('goal_not_found');
  const runtime = getRuntime(db, goalId) ?? null;
  const versionNumber = goal.current_definition_version;
  const version =
    typeof versionNumber === 'number' ? loadDefinitionVersion(db, goalId, versionNumber) : undefined;
  const verifiers = version ? listVerifiers(version.definition) : [];
  const verifierKeys = new Set(verifiers.map((item) => `${item.criterionKey}\0${item.digest}`));
  const evidence = (
    db
      .prepare(
        'SELECT * FROM goal_evidence WHERE goal_id = ? ORDER BY criterion_key, verifier_digest, recorded_at, rowid',
      )
      .all(goalId) as EvidenceRow[]
  ).filter((row) => verifierKeys.has(`${row.criterion_key}\0${row.verifier_digest}`));
  const approvals = db
    .prepare(
      `SELECT * FROM goal_approvals WHERE goal_id = ? AND gate IN ('definition','amendment','final_acceptance','final_apply','milestone_complete')
         ${options.excludeExternalIntegrationApprovals ? "AND json_extract(detail_json, '$.action') IS NOT 'confirm_external_integration'" : ''}
       ORDER BY gate, created_at, rowid`,
    )
    .all(goalId);
  const reviews = db
    .prepare(
      `SELECT * FROM goal_reviews WHERE goal_id = ? AND review_kind IN ('final','milestone')
       ORDER BY review_kind, completed_at, created_at, rowid`,
    )
    .all(goalId);
  const findings = db
    .prepare(
      `SELECT id, fingerprint, severity, category, description, affected_files_json, status,
              first_seen_review_id, last_seen_review_id, created_at, updated_at
       FROM goal_findings WHERE goal_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(goalId);
  const cycles = db
    .prepare(
      `SELECT id, kind, status, definition_version FROM goal_cycles
       WHERE goal_id = ? ORDER BY sequence, id`,
    )
    .all(goalId);
  const activeRuns = db
    .prepare(
      `SELECT r.id, r.status, r.goal_cycle_id, r.goal_run_purpose FROM goal_runs gr JOIN runs r ON r.id = gr.run_id
       WHERE gr.goal_id = ? ORDER BY r.id`,
    )
    .all(goalId);
  const operations = db
    .prepare(
      `SELECT id, op, status, expected_old, new_commit, checks_json, recovery_json, error_code
       FROM goal_integration_ops WHERE goal_id = ? ORDER BY created_at, id`,
    )
    .all(goalId);
  const milestones = db
    .prepare(
      'SELECT id, milestone_key, status FROM goal_milestones WHERE goal_id = ? ORDER BY milestone_key, id',
    )
    .all(goalId);
  const pendingReviews = db
    .prepare("SELECT id, status FROM goal_reviews WHERE goal_id = ? AND status = 'pending' ORDER BY id")
    .all(goalId);
  return digest({
    goal,
    runtime,
    version,
    evidence,
    approvals,
    reviews,
    findings,
    cycles,
    activeRuns,
    operations,
    milestones,
    pendingReviews,
    manualReconciliation: isManualReconciliation(db, goalId),
  });
}

function ensureCompletionReady(
  db: Db,
  goalId: string,
  evaluation: Awaited<ReturnType<typeof evaluateCompletion>>,
  version: NonNullable<ReturnType<typeof loadDefinitionVersion>>,
): { definitionApproval: GoalApproval; acceptance: GoalApproval; review: GoalReviewRow } {
  assert(
    version.status === 'approved' && version.approvedBy === 'user' && verifyDefinitionHash(version),
    'definition_not_approved',
  );
  assert(version.definition.contract.completionPolicy.applyToBase === 'required', 'goal_ineligible');
  assert(
    evaluation.definitionVersion === version.version && evaluation.definitionHash === version.definitionHash,
    'definition_not_approved',
  );
  assert(
    evaluation.failures.length === 1 &&
      evaluation.failures[0]?.code === 'final_apply_required' &&
      evaluation.finalApply.required &&
      !evaluation.finalApply.ok &&
      evaluation.finalApply.reason === 'not_applied',
    'completion_not_ready',
  );
  assert(
    evaluation.finalAcceptance.required &&
      evaluation.finalAcceptance.ok &&
      evaluation.finalAcceptance.approvalId,
    'completion_not_ready',
  );
  assert(
    evaluation.finalReview.required && evaluation.finalReview.ok && evaluation.finalReview.reviewId,
    'completion_not_ready',
  );
  const definitionProof = definitionApprovalLineage(db, goalId, version);
  assert(definitionProof, 'definition_not_approved');
  const definitionApproval = definitionProof.approval;
  const acceptance = getGoalApproval(db, evaluation.finalAcceptance.approvalId);
  assert(
    acceptance &&
      acceptance.goalId === goalId &&
      acceptance.gate === 'final_acceptance' &&
      acceptance.status === 'approved' &&
      acceptance.decidedBy === 'user' &&
      acceptance.detail.definitionVersion === version.version &&
      acceptance.detail.definitionHash === version.definitionHash &&
      acceptance.detail.integrationHead === evaluation.integrationHead &&
      acceptance.detail.integrationTree === evaluation.integrationTree,
    'completion_not_ready',
  );
  const review = getReview(db, evaluation.finalReview.reviewId);
  assert(
    review &&
      review.goalId === goalId &&
      review.reviewKind === 'final' &&
      review.status === 'completed' &&
      review.definitionVersion === version.version &&
      review.reviewedToCommit === evaluation.integrationHead &&
      review.reviewedToTree === evaluation.integrationTree &&
      review.verdict === 'pass' &&
      review.blocking === false &&
      version.definition.routing.independence.finalReview !== 'none' &&
      review.independence?.established === true &&
      review.independence.policy === version.definition.routing.independence.finalReview,
    'completion_not_ready',
  );
  return { definitionApproval, acceptance, review };
}

function ensureNoActiveWork(db: Db, goalId: string): void {
  const goal = db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as
    { status: string } | undefined;
  assert(goal, 'goal_not_found');
  assert(
    !GOAL_TERMINAL_STATUSES.includes(goal.status as (typeof GOAL_TERMINAL_STATUSES)[number]),
    'goal_ineligible',
  );
  assert(!isManualReconciliation(db, goalId), 'manual_reconciliation_required');
  assert(!activeCycle(db, goalId), 'active_work');
  const placeholders = [...TERMINAL_RUN_STATUSES].map(() => '?').join(', ');
  assert(
    !db
      .prepare(
        `SELECT 1 FROM goal_runs gr JOIN runs r ON r.id = gr.run_id
         WHERE gr.goal_id = ? AND r.status NOT IN (${placeholders}) LIMIT 1`,
      )
      .get(goalId, ...TERMINAL_RUN_STATUSES),
    'active_work',
  );
  assert(
    !db.prepare("SELECT 1 FROM goal_reviews WHERE goal_id = ? AND status = 'pending' LIMIT 1").get(goalId),
    'pending_review',
  );
  assert(
    !db
      .prepare("SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned' LIMIT 1")
      .get(goalId),
    'integration_operation_in_progress',
  );
  assert(
    !db
      .prepare(
        "SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base' AND status IN ('applied','failed') LIMIT 1",
      )
      .get(goalId),
    'manual_reconciliation_required',
  );
}

function validOid(value: string | null, format: ObjectFormat): value is string {
  return typeof value === 'string' && OID[format].test(value);
}

async function readRefCommit(context: GoalContext, ref: string): Promise<string | null> {
  const listed = await gitTry(context.repoRoot, ['for-each-ref', '--format=%(refname)%00%(objectname)', ref]);
  if (!listed.ok) throw new ManualHandoffError('git_unavailable');
  const entry = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${ref}\0`));
  if (!entry) return null;
  const objectId = entry.slice(ref.length + 1);
  if (!OID.sha1.test(objectId) && !OID.sha256.test(objectId)) throw new ManualHandoffError('git_unavailable');
  const commit = await gitTry(context.repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${objectId}^{commit}`,
  ]);
  if (!commit.ok || !commit.stdout.trim()) throw new ManualHandoffError('git_unavailable');
  return commit.stdout.trim();
}

async function readTree(
  context: GoalContext,
  commit: string,
  format: ObjectFormat,
  failureCode: ManualHandoffErrorCode = 'git_unavailable',
): Promise<string> {
  const result = await gitTry(context.repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${commit}^{tree}`,
  ]);
  const tree = result.stdout.trim();
  if (!result.ok || !validOid(tree, format)) throw new ManualHandoffError(failureCode);
  return tree;
}

function boundedDisplay(value: string, limit: number): { value: string; truncated: boolean } {
  const redacted = redactSecrets(value)
    .replace(/\u001b/g, '�')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/g, '�')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '�');
  if (redacted.length <= limit) return { value: redacted, truncated: false };
  const suffix = '\n… [truncated]';
  return { value: `${redacted.slice(0, limit - suffix.length)}${suffix}`, truncated: true };
}

function safeDisplayPath(path: string): string {
  return path
    .replace(/[\u0000-\u001f\u007f]/g, '�')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '�')
    .slice(0, MAX_PATH_DISPLAY_CHARS);
}

function selectedEvidence(
  db: Db,
  goalId: string,
  version: number,
  evaluation: Awaited<ReturnType<typeof evaluateCompletion>>,
) {
  const selected = new Map<string, { criterionKey: string; verifierDigest: string }>();
  for (const criterion of evaluation.criteria)
    for (const verifier of criterion.verifiers)
      if (verifier.state === 'satisfied' && verifier.decidingEvidenceId)
        selected.set(verifier.decidingEvidenceId, {
          criterionKey: criterion.key,
          verifierDigest: verifier.verifierDigest,
        });
  assert(selected.size <= MAX_EVIDENCE_ROWS, 'evidence_invalid');
  const evidence: Array<z.infer<typeof evidenceIdentitySchema>> = [];
  const identities: unknown[] = [];
  for (const [evidenceId, selection] of [...selected.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const row = db
      .prepare('SELECT * FROM goal_evidence WHERE id = ? AND goal_id = ?')
      .get(evidenceId, goalId) as EvidenceRow | undefined;
    assert(
      row &&
        row.definition_version === version &&
        row.criterion_key === selection.criterionKey &&
        row.verifier_digest === selection.verifierDigest &&
        row.verdict === 'satisfies',
      'evidence_invalid',
    );
    const identity = evidenceIdentity(row);
    const identityDigest = digest(identity);
    evidence.push({
      evidenceId: row.id,
      criterionKey: row.criterion_key,
      verifierDigest: row.verifier_digest,
      kind: row.kind,
      verdict: 'satisfies',
      identityDigest,
    });
    identities.push(identity);
  }
  const skippedMilestones: unknown[] = [];
  for (const milestone of evaluation.milestones.filter((item) => item.state === 'skipped_by_user')) {
    assert(milestone.skipApprovalId, 'evidence_invalid');
    const approval = getGoalApproval(db, milestone.skipApprovalId);
    assert(
      approval &&
        approval.goalId === goalId &&
        approval.gate === 'milestone_complete' &&
        approval.status === 'approved' &&
        approval.decidedBy === 'user' &&
        approval.detail.action === 'skip' &&
        approval.detail.milestoneKey === milestone.key &&
        approval.detail.definitionVersion === version,
      'evidence_invalid',
    );
    skippedMilestones.push({
      key: milestone.key,
      approvalId: approval.id,
      identityDigest: digest(getApprovalIdentity(approval)),
    });
  }
  return {
    evidence,
    evidenceIdentityDigest: digest({ evidence: identities, skippedMilestones }),
  };
}

async function repositoryBinding(context: GoalContext): Promise<{ identity: string; commonDir: string }> {
  const topLevel = await gitTry(context.repoRoot, ['rev-parse', '--show-toplevel']);
  const common = await gitTry(context.repoRoot, ['rev-parse', '--git-common-dir']);
  if (!topLevel.ok || !common.ok || !topLevel.stdout.trim() || !common.stdout.trim())
    throw new ManualHandoffError('repository_unavailable');
  let canonicalRoot: string;
  let commonDir: string;
  try {
    canonicalRoot = realpathSync(topLevel.stdout.trim());
    const rawCommon = common.stdout.trim();
    commonDir = realpathSync(isAbsolute(rawCommon) ? rawCommon : resolve(context.repoRoot, rawCommon));
  } catch {
    throw new ManualHandoffError('repository_unavailable');
  }
  if (canonicalRoot !== context.repoRoot) throw new ManualHandoffError('repository_unavailable');
  return {
    commonDir,
    identity: computeFinalApplyRepositoryIdentity(
      context.projectId,
      context.repoRoot,
      commonDir,
      context.scope,
    ),
  };
}

async function readReadOnlyGitProjection(
  context: GoalContext,
  runtime: RuntimeRow,
  format: ObjectFormat,
  expectedHead: string,
  expectedTree: string,
  repositoryIdentity: string,
  options: ManualHandoffBuildOptions,
): Promise<Pick<HandoffIdentity, 'source' | 'target' | 'review' | 'projection' | 'repository'>> {
  assert(runtime.base_branch && runtime.base_commit && runtime.integration_head, 'goal_ineligible');
  const baseRef = `refs/heads/${runtime.base_branch}`;
  const validRef = await gitTry(context.repoRoot, ['check-ref-format', baseRef]);
  if (!validRef.ok) throw new ManualHandoffError('base_ref_invalid');
  const sourceRef = await goalRefName(context.goalId, context.repoRoot);
  const [actualSource, actualBase] = await Promise.all([
    readRefCommit(context, sourceRef),
    readRefCommit(context, baseRef),
  ]);
  if (!actualSource) throw new ManualHandoffError('source_ref_missing');
  if (actualSource !== runtime.integration_head)
    throw new ManualHandoffError(
      'source_changed',
      'The source ref no longer matches the recorded Goal head.',
    );
  if (actualSource !== expectedHead)
    throw new ManualHandoffError(
      'source_changed',
      'The source ref no longer matches the completion snapshot.',
    );
  if (!actualBase) throw new ManualHandoffError('base_ref_missing');
  if (actualBase !== runtime.base_commit) throw new ManualHandoffError('base_diverged');
  if (!validOid(actualSource, format) || !validOid(actualBase, format))
    throw new ManualHandoffError('git_unavailable');
  const [sourceTree, baseTree] = await Promise.all([
    readTree(context, actualSource, format, 'source_tree_unavailable'),
    readTree(context, actualBase, format, 'base_tree_unavailable'),
  ]);
  if (sourceTree !== expectedTree)
    throw new ManualHandoffError(
      'source_changed',
      'The source tree no longer matches the completion snapshot.',
    );
  const ancestor = await gitTry(context.repoRoot, ['merge-base', '--is-ancestor', actualBase, actualSource]);
  if (!ancestor.ok) {
    if (ancestor.stderr.trim()) throw new ManualHandoffError('git_unavailable');
    throw new ManualHandoffError('not_fast_forward');
  }

  let entries;
  try {
    entries = await changedEntries(context.repoRoot, actualBase, actualSource);
  } catch {
    throw new ManualHandoffError('git_unavailable');
  }
  const paths = changedPathSet(entries);
  if (paths.length === 0) throw new ManualHandoffError('no_changes');
  if (paths.length > MAX_CHANGED_PATHS) throw new ManualHandoffError('unsafe_changes');
  const violations = checkChangedPaths(entries, context.scope);
  const scan = await scanChangedContent(context.repoRoot, actualBase, actualSource);
  if (violations.length || !scan.ok) throw new ManualHandoffError('unsafe_changes');

  const [statResult, previewResult] = await Promise.all([
    gitTry(context.repoRoot, [
      '-c',
      'diff.algorithm=myers',
      'diff',
      '--stat',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      actualBase,
      actualSource,
      '--',
    ]),
    gitTry(context.repoRoot, [
      '-c',
      'diff.algorithm=myers',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      actualBase,
      actualSource,
      '--',
    ]),
  ]);
  if (!statResult.ok || !previewResult.ok) throw new ManualHandoffError('git_unavailable');
  const stat = boundedDisplay(statResult.stdout, MAX_DIFF_STAT_CHARS);
  const previewLimit = Math.max(
    128,
    Math.min(MAX_DIFF_PREVIEW_CHARS, options.previewChars ?? MAX_DIFF_PREVIEW_CHARS),
  );
  const preview = boundedDisplay(previewResult.stdout, previewLimit);
  const summary = paths.slice(0, MAX_PATHS_IN_PROJECTION).map(safeDisplayPath);
  const summaryTruncated = paths.length > summary.length;
  const changedPathDigest = digest(paths);
  const diffStatDigest = sha256(stat.value);
  const diffPreviewDigest = sha256(preview.value);
  const baseRefAfter = await readRefCommit(context, baseRef);
  const sourceRefAfter = await readRefCommit(context, sourceRef);
  const [baseRefFinal, sourceRefFinal] = await Promise.all([
    readRefCommit(context, baseRef),
    readRefCommit(context, sourceRef),
  ]);
  if (
    baseRefAfter !== actualBase ||
    sourceRefAfter !== actualSource ||
    baseRefFinal !== actualBase ||
    sourceRefFinal !== actualSource
  )
    throw new ManualHandoffError('snapshot_changed');
  const sourceTreeFinal = await readTree(context, actualSource, format);
  const baseTreeFinal = await readTree(context, actualBase, format);
  if (sourceTreeFinal !== sourceTree || baseTreeFinal !== baseTree)
    throw new ManualHandoffError('snapshot_changed');
  const baseBranch = runtime.base_branch;
  return {
    source: { goalRef: sourceRef, commit: actualSource, tree: sourceTree },
    target: { baseBranch, baseRef, observedBaseCommit: actualBase, observedBaseTree: baseTree },
    repository: {
      projectId: context.projectId,
      identity: repositoryIdentity,
      objectFormat: format,
      scope: context.scope,
    },
    review: {
      finalReviewId: '',
      reviewIdentityDigest: '',
      evidenceIdentityDigest: '',
      evidence: [],
      changedPathDigest,
      changedPathCount: paths.length,
      changedPathSummaryDigest: digest({ paths: summary, truncated: summaryTruncated }),
      diffPreviewLimit: previewLimit,
      diffStatDigest,
      diffStatTruncated: stat.truncated,
      diffPreviewDigest,
      diffPreviewTruncated: preview.truncated,
    },
    projection: {
      changedPaths: summary,
      changedPathsTruncated: summaryTruncated,
      diffStat: stat.value,
      diffPreview: preview.value,
      inspectionCommands: [
        `git show --stat ${actualSource}`,
        `git diff --stat ${actualBase} ${actualSource}`,
        `git diff ${actualBase} ${actualSource}`,
      ],
      manualIntegrationRequired: true,
      warning: HANDOFF_WARNING,
    },
  };
}

/** Read-only candidate construction. It deliberately does not call preflightFinalApply(). */
export async function buildManualHandoffSnapshot(
  db: Db,
  goalId: string,
  options: ManualHandoffBuildOptions = {},
): Promise<ManualHandoffSnapshot> {
  ensureNoActiveWork(db, goalId);
  const versionNumber = (
    db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
      { current_definition_version: number | null } | undefined
  )?.current_definition_version;
  assert(typeof versionNumber === 'number', 'definition_not_approved');
  const version = loadDefinitionVersion(db, goalId, versionNumber);
  assert(version, 'definition_not_approved');
  const databaseBefore = databaseFingerprint(db, goalId);
  let context: GoalContext;
  try {
    context = loadContext(db, goalId);
  } catch {
    throw new ManualHandoffError('repository_unavailable');
  }
  const runtime = getRuntime(db, goalId);
  assert(runtime?.integration_head && runtime.base_branch && runtime.base_commit, 'goal_ineligible');
  const format = await repositoryObjectFormat(context.repoRoot).catch(() => {
    throw new ManualHandoffError('repository_unavailable');
  });
  if (!validOid(runtime.integration_head, format) || !validOid(runtime.base_commit, format))
    throw new ManualHandoffError('git_unavailable');
  const sourceRef = await goalRefName(goalId, context.repoRoot);
  const sourceCommit = await readRefCommit(context, sourceRef);
  if (!sourceCommit) throw new ManualHandoffError('source_ref_missing');
  if (sourceCommit !== runtime.integration_head)
    throw new ManualHandoffError(
      'source_changed',
      'The source ref no longer matches the recorded Goal head.',
    );
  const [evaluationBefore, binding] = await Promise.all([
    evaluateCompletion(db, goalId).catch(() => {
      throw new ManualHandoffError('repository_unavailable');
    }),
    repositoryBinding(context),
  ]);
  const authorities = ensureCompletionReady(db, goalId, evaluationBefore, version);
  if (!evaluationBefore.integrationHead || !evaluationBefore.integrationTree)
    throw new ManualHandoffError('completion_not_ready');
  const gitProjection = await readReadOnlyGitProjection(
    context,
    runtime,
    format,
    evaluationBefore.integrationHead,
    evaluationBefore.integrationTree,
    binding.identity,
    options,
  );
  const selected = selectedEvidence(db, goalId, version.version, evaluationBefore);
  const evaluationAfter = await evaluateCompletion(db, goalId).catch(() => {
    throw new ManualHandoffError('repository_unavailable');
  });
  ensureCompletionReady(db, goalId, evaluationAfter, version);
  const databaseAfter = databaseFingerprint(db, goalId);
  const finalSource = await readRefCommit(context, gitProjection.source.goalRef);
  const finalBase = await readRefCommit(context, gitProjection.target.baseRef);
  const [sourceTree, baseTree] = await Promise.all([
    readTree(context, gitProjection.source.commit, format),
    readTree(context, gitProjection.target.observedBaseCommit, format),
  ]);
  if (
    databaseBefore !== databaseAfter ||
    finalSource !== gitProjection.source.commit ||
    finalBase !== gitProjection.target.observedBaseCommit ||
    sourceTree !== gitProjection.source.tree ||
    baseTree !== gitProjection.target.observedBaseTree ||
    digest(completionIdentity(evaluationBefore)) !== digest(completionIdentity(evaluationAfter))
  )
    throw new ManualHandoffError('snapshot_changed');
  ensureNoActiveWork(db, goalId);

  const definitionApprovalIdentityDigest = digest(getApprovalIdentity(authorities.definitionApproval));
  const finalAcceptanceIdentityDigest = digest(getApprovalIdentity(authorities.acceptance));
  const finalReviewIdentityDigest = digest(getReviewIdentity(authorities.review));
  const evidenceIdentityDigest = selected.evidenceIdentityDigest;
  const completionDigest = digest(completionIdentity(evaluationBefore));
  const identity: HandoffIdentity = {
    schemaVersion: 1,
    kind: 'turing_goal_manual_integration_handoff',
    goalId,
    definition: {
      version: version.version,
      hash: version.definitionHash,
      approvalId: authorities.definitionApproval.id,
      approvalIdentityDigest: definitionApprovalIdentityDigest,
    },
    finalAcceptance: {
      approvalId: authorities.acceptance.id,
      identityDigest: finalAcceptanceIdentityDigest,
    },
    repository: gitProjection.repository,
    source: gitProjection.source,
    target: gitProjection.target,
    completion: {
      identityDigest: completionDigest,
      findingsIdentityDigest: findingsIdentityDigest(db, goalId),
    },
    review: {
      ...gitProjection.review,
      finalReviewId: authorities.review.id,
      reviewIdentityDigest: finalReviewIdentityDigest,
      evidenceIdentityDigest,
      evidence: selected.evidence,
    },
    projection: gitProjection.projection,
  };
  const parsedIdentity = handoffSchema
    .omit({ handoffId: true, createdAt: true, handoffDigest: true })
    .safeParse(identity);
  if (!parsedIdentity.success) throw new ManualHandoffError('handoff_invalid');
  return {
    identity: parsedIdentity.data as HandoffIdentity,
    handoffDigest: computeManualHandoffDigest(identity),
    databaseFingerprint: databaseAfter,
  };
}

function rowMatchesRecord(row: HandoffDbRow, record: ManualIntegrationHandoffV1): boolean {
  return (
    row.id === record.handoffId &&
    row.goal_id === record.goalId &&
    row.schema_version === record.schemaVersion &&
    row.kind === record.kind &&
    row.handoff_digest === record.handoffDigest &&
    row.definition_version === record.definition.version &&
    row.final_acceptance_approval_id === record.finalAcceptance.approvalId &&
    row.final_review_id === record.review.finalReviewId &&
    row.source_commit === record.source.commit &&
    row.source_tree === record.source.tree &&
    row.base_ref === record.target.baseRef &&
    row.observed_base_commit === record.target.observedBaseCommit &&
    row.created_at === record.createdAt
  );
}

function readStoredHandoff(
  db: Db,
  goalId: string,
  handoffId: string,
): { row: HandoffDbRow; record: ManualIntegrationHandoffV1 } | null {
  const row = db
    .prepare('SELECT * FROM goal_result_handoffs WHERE goal_id = ? AND id = ?')
    .get(goalId, handoffId) as HandoffDbRow | undefined;
  if (!row) return null;
  const record = parseHandoff(row.payload_json);
  if (!record || !rowMatchesRecord(row, record)) throw new ManualHandoffError('handoff_invalid');
  return { row, record };
}

/** Re-reads and verifies the canonical immutable handoff identity inside short persistence transactions. */
export function readValidatedManualHandoff(
  db: Db,
  goalId: string,
  handoffId: string,
): ManualIntegrationHandoffV1 | null {
  return readStoredHandoff(db, goalId, handoffId)?.record ?? null;
}

export interface PreparedManualHandoff {
  record: ManualIntegrationHandoffV1;
  reused: boolean;
}

/** Explicitly persists one immutable handoff; it never writes to Git or changes Goal state. */
export async function prepareManualHandoff(
  db: Db,
  goalId: string,
  options: ManualHandoffBuildOptions = {},
): Promise<PreparedManualHandoff> {
  const snapshot = await buildManualHandoffSnapshot(db, goalId, options);
  const now = new Date().toISOString();
  const body = {
    ...snapshot.identity,
    handoffId: randomUUID(),
    createdAt: now,
    handoffDigest: snapshot.handoffDigest,
  };
  const parsed = handoffSchema.safeParse(body);
  if (!parsed.success) throw new ManualHandoffError('handoff_invalid');
  const record = parsed.data;
  const payload = canonicalJson(record);
  if (payload.length > 262_144) throw new ManualHandoffError('handoff_invalid');
  const write = db.transaction(() => {
    if (databaseFingerprint(db, goalId) !== snapshot.databaseFingerprint)
      throw new ManualHandoffError('snapshot_changed');
    const prior = db
      .prepare('SELECT * FROM goal_result_handoffs WHERE goal_id = ? AND handoff_digest = ?')
      .get(goalId, snapshot.handoffDigest) as HandoffDbRow | undefined;
    if (prior) {
      const existing = parseHandoff(prior.payload_json);
      if (!existing || !rowMatchesRecord(prior, existing)) throw new ManualHandoffError('handoff_invalid');
      return { record: existing, reused: true };
    }
    db.prepare(
      `INSERT INTO goal_result_handoffs
       (id, goal_id, schema_version, kind, handoff_digest, definition_version, final_acceptance_approval_id,
        final_review_id, source_commit, source_tree, base_ref, observed_base_commit, payload_json, created_at)
       VALUES (?, ?, 1, 'turing_goal_manual_integration_handoff', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.handoffId,
      goalId,
      record.handoffDigest,
      record.definition.version,
      record.finalAcceptance.approvalId,
      record.review.finalReviewId,
      record.source.commit,
      record.source.tree,
      record.target.baseRef,
      record.target.observedBaseCommit,
      payload,
      record.createdAt,
    );
    return { record, reused: false };
  });
  return write.immediate();
}

export interface ManualHandoffValidation {
  state: 'current' | 'stale' | 'unavailable' | 'invalid';
  reason: { code: string; message: string } | null;
  record?: ManualIntegrationHandoffV1;
}

function currentDefinitionMatchesRecord(db: Db, goalId: string, record: ManualIntegrationHandoffV1): boolean {
  const current = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
    { current_definition_version: number | null } | undefined;
  if (!current || current.current_definition_version !== record.definition.version) return false;
  const version = loadDefinitionVersion(db, goalId, record.definition.version);
  if (
    !version ||
    version.status !== 'approved' ||
    version.definitionHash !== record.definition.hash ||
    version.approvalId !== record.definition.approvalId ||
    !verifyDefinitionHash(version)
  )
    return false;
  const lineage = definitionApprovalLineage(db, goalId, version);
  return Boolean(
    lineage &&
    lineage.gate === (version.parentVersion === null ? 'definition' : 'amendment') &&
    lineage.approval.id === record.definition.approvalId &&
    digest(getApprovalIdentity(lineage.approval)) === record.definition.approvalIdentityDigest,
  );
}

export type ExternalHandoffAuthorityValidation =
  | {
      state: 'valid';
      record: ManualIntegrationHandoffV1;
      authorityFingerprint: string;
      databaseFingerprint: string;
    }
  | {
      state: 'stale' | 'unavailable' | 'invalid';
      code: string;
    };

/**
 * Verifies the immutable preparation authority without requiring the recorded base ref to remain at its original
 * commit. A future external-integration verifier uses this after the user's Git operation; the ordinary handoff
 * validator deliberately remains strict about base-ref currentness.
 */
export async function validateManualHandoffAuthorityForExternalIntegration(
  db: Db,
  goalId: string,
  handoffId: string,
): Promise<ExternalHandoffAuthorityValidation> {
  let stored: ReturnType<typeof readStoredHandoff>;
  try {
    stored = readStoredHandoff(db, goalId, handoffId);
  } catch {
    return { state: 'invalid', code: 'handoff_invalid' };
  }
  if (!stored) return { state: 'invalid', code: 'handoff_not_found' };
  const { record } = stored;
  if (record.goalId !== goalId) return { state: 'invalid', code: 'handoff_goal_mismatch' };

  try {
    ensureNoActiveWork(db, goalId);
    if (!currentDefinitionMatchesRecord(db, goalId, record))
      return { state: 'stale', code: 'definition_not_approved' };

    const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
      { current_definition_version: number | null } | undefined;
    const version =
      goal?.current_definition_version === null || goal?.current_definition_version === undefined
        ? undefined
        : loadDefinitionVersion(db, goalId, goal.current_definition_version);
    if (
      !version ||
      version.version !== record.definition.version ||
      version.definitionHash !== record.definition.hash
    )
      return { state: 'stale', code: 'definition_not_approved' };

    const databaseBefore = databaseFingerprint(db, goalId, { excludeExternalIntegrationApprovals: true });
    const context = loadContext(db, goalId);
    const runtime = getRuntime(db, goalId);
    if (
      !runtime ||
      runtime.integration_head !== record.source.commit ||
      runtime.base_branch === null ||
      `refs/heads/${runtime.base_branch}` !== record.target.baseRef ||
      runtime.base_commit !== record.target.observedBaseCommit ||
      context.projectId !== record.repository.projectId ||
      context.scope !== record.repository.scope
    )
      return { state: 'stale', code: 'handoff_repository_or_source_changed' };
    const format = await repositoryObjectFormat(context.repoRoot).catch(() => null);
    if (!format) return { state: 'unavailable', code: 'repository_unavailable' };
    if (format !== record.repository.objectFormat) return { state: 'stale', code: 'object_format_changed' };
    const binding = await repositoryBinding(context).catch(() => null);
    if (!binding) return { state: 'unavailable', code: 'repository_unavailable' };
    if (binding.identity !== record.repository.identity)
      return { state: 'stale', code: 'repository_identity_changed' };
    const initialSourceRef = await readRefCommit(context, record.source.goalRef).catch(() => null);
    if (!initialSourceRef) return { state: 'stale', code: 'source_ref_missing' };
    if (initialSourceRef !== record.source.commit) return { state: 'stale', code: 'source_changed' };

    const evaluation = await evaluateCompletion(db, goalId);
    const authorities = ensureCompletionReady(db, goalId, evaluation, version);
    if (
      evaluation.finalReview.reviewId !== record.review.finalReviewId ||
      evaluation.finalAcceptance.approvalId !== record.finalAcceptance.approvalId ||
      digest(completionIdentity(evaluation)) !== record.completion.identityDigest ||
      findingsIdentityDigest(db, goalId) !== record.completion.findingsIdentityDigest
    )
      return { state: 'stale', code: 'completion_authority_changed' };

    const definitionApprovalIdentityDigest = digest(getApprovalIdentity(authorities.definitionApproval));
    const acceptanceIdentityDigest = digest(getApprovalIdentity(authorities.acceptance));
    const reviewIdentityDigest = digest(getReviewIdentity(authorities.review));
    const selected = selectedEvidence(db, goalId, version.version, evaluation);
    if (
      definitionApprovalIdentityDigest !== record.definition.approvalIdentityDigest ||
      acceptanceIdentityDigest !== record.finalAcceptance.identityDigest ||
      reviewIdentityDigest !== record.review.reviewIdentityDigest ||
      selected.evidenceIdentityDigest !== record.review.evidenceIdentityDigest ||
      canonicalJson(selected.evidence) !== canonicalJson(record.review.evidence)
    )
      return { state: 'stale', code: 'handoff_authority_changed' };

    const sourceRef = await readRefCommit(context, record.source.goalRef).catch(() => null);
    if (!sourceRef) return { state: 'stale', code: 'source_ref_missing' };
    if (sourceRef !== record.source.commit) return { state: 'stale', code: 'source_changed' };
    const sourceTree = await readTree(context, record.source.commit, format).catch(() => null);
    const baseTree = await readTree(context, record.target.observedBaseCommit, format).catch(() => null);
    if (!sourceTree || !baseTree) return { state: 'unavailable', code: 'git_object_unavailable' };
    if (sourceTree !== record.source.tree || baseTree !== record.target.observedBaseTree)
      return { state: 'invalid', code: 'handoff_git_identity_invalid' };

    ensureNoActiveWork(db, goalId);
    const databaseAfter = databaseFingerprint(db, goalId, { excludeExternalIntegrationApprovals: true });
    if (databaseBefore !== databaseAfter) return { state: 'stale', code: 'database_authority_changed' };
    const authorityFingerprint = digest({
      goalId,
      handoffDigest: record.handoffDigest,
      databaseFingerprint: databaseAfter,
      completionIdentity: record.completion.identityDigest,
      definitionApprovalIdentityDigest,
      acceptanceIdentityDigest,
      reviewIdentityDigest,
      evidenceIdentityDigest: selected.evidenceIdentityDigest,
      repositoryIdentity: binding.identity,
      sourceCommit: record.source.commit,
      sourceTree: record.source.tree,
      baseRef: record.target.baseRef,
      expectedBaseCommit: record.target.observedBaseCommit,
      expectedBaseTree: record.target.observedBaseTree,
    });
    return { state: 'valid', record, authorityFingerprint, databaseFingerprint: databaseAfter };
  } catch (error) {
    if (error instanceof ManualHandoffError) {
      const unavailable =
        error.code === 'repository_unavailable' ||
        error.code === 'git_unavailable' ||
        error.code === 'source_tree_unavailable' ||
        error.code === 'base_tree_unavailable';
      return { state: unavailable ? 'unavailable' : 'stale', code: error.code };
    }
    return { state: 'unavailable', code: 'repository_unavailable' };
  }
}

/** A short-transaction recheck; external-attestation approval rows are intentionally excluded. */
export function manualHandoffAttestationDatabaseFingerprint(db: Db, goalId: string): string {
  return databaseFingerprint(db, goalId, { excludeExternalIntegrationApprovals: true });
}

async function diagnoseStaleness(
  db: Db,
  goalId: string,
  record: ManualIntegrationHandoffV1,
  originalCode: ManualHandoffErrorCode,
): Promise<ManualHandoffErrorCode> {
  if (!currentDefinitionMatchesRecord(db, goalId, record)) return 'definition_not_approved';
  try {
    const context = loadContext(db, goalId);
    const runtime = getRuntime(db, goalId);
    if (!runtime || runtime.integration_head !== record.source.commit) return 'source_changed';
    const binding = await repositoryBinding(context);
    if (binding.identity !== record.repository.identity) return 'repository_identity_changed';
    const source = await readRefCommit(context, record.source.goalRef);
    if (!source) return 'source_ref_missing';
    if (source !== record.source.commit) return 'source_changed';
    const base = await readRefCommit(context, record.target.baseRef);
    if (!base) return 'base_ref_missing';
    if (base !== record.target.observedBaseCommit) return 'base_diverged';
    if (originalCode !== 'completion_not_ready') return originalCode;
    const evaluation = await evaluateCompletion(db, goalId);
    if (!evaluation.finalAcceptance.ok) return 'final_acceptance_changed';
    if (!evaluation.finalReview.ok) return 'final_review_changed';
    if (evaluation.criteria.some((criterion) => criterion.required && criterion.state !== 'satisfied'))
      return 'criterion_unsatisfied';
    if (!evaluation.findings.ok) return 'findings_blocked';
  } catch (error) {
    if (error instanceof ManualHandoffError) return error.code;
    return 'repository_unavailable';
  }
  return originalCode;
}

function changedReason(
  record: ManualIntegrationHandoffV1,
  identity: HandoffIdentity,
): ManualHandoffErrorCode {
  if (
    record.definition.version !== identity.definition.version ||
    record.definition.hash !== identity.definition.hash ||
    record.definition.approvalIdentityDigest !== identity.definition.approvalIdentityDigest
  )
    return 'definition_not_approved';
  if (record.finalAcceptance.identityDigest !== identity.finalAcceptance.identityDigest)
    return 'final_acceptance_changed';
  if (
    record.repository.identity !== identity.repository.identity ||
    record.repository.projectId !== identity.repository.projectId
  )
    return 'repository_identity_changed';
  if (record.source.commit !== identity.source.commit || record.source.tree !== identity.source.tree)
    return 'source_changed';
  if (
    record.target.baseRef !== identity.target.baseRef ||
    record.target.observedBaseCommit !== identity.target.observedBaseCommit ||
    record.target.observedBaseTree !== identity.target.observedBaseTree
  )
    return 'base_diverged';
  if (
    record.review.finalReviewId !== identity.review.finalReviewId ||
    record.review.reviewIdentityDigest !== identity.review.reviewIdentityDigest
  )
    return 'final_review_changed';
  if (
    record.review.evidenceIdentityDigest !== identity.review.evidenceIdentityDigest ||
    record.completion.findingsIdentityDigest !== identity.completion.findingsIdentityDigest
  )
    return 'evidence_invalid';
  if (
    record.review.changedPathDigest !== identity.review.changedPathDigest ||
    record.review.diffPreviewDigest !== identity.review.diffPreviewDigest ||
    record.review.diffStatDigest !== identity.review.diffStatDigest
  )
    return 'source_changed';
  return 'snapshot_changed';
}

/** Freshly re-evaluates persisted authority and Git identities. It never updates an old record. */
export async function validateManualHandoff(
  db: Db,
  goalId: string,
  handoffId: string,
): Promise<ManualHandoffValidation> {
  let stored: ReturnType<typeof readStoredHandoff>;
  try {
    stored = readStoredHandoff(db, goalId, handoffId);
  } catch (error) {
    const code = error instanceof ManualHandoffError ? error.code : 'handoff_invalid';
    return { state: 'invalid', reason: { code, message: ERROR_MESSAGES.handoff_invalid } };
  }
  if (!stored)
    return {
      state: 'invalid',
      reason: { code: 'handoff_not_found', message: 'No such handoff for this Goal.' },
    };
  try {
    const current = await buildManualHandoffSnapshot(db, goalId, {
      previewChars: stored.record.review.diffPreviewLimit,
    });
    if (current.handoffDigest === stored.record.handoffDigest)
      return { state: 'current', reason: null, record: stored.record };
    return {
      state: 'stale',
      reason: {
        code: changedReason(stored.record, current.identity),
        message: ERROR_MESSAGES[changedReason(stored.record, current.identity)],
      },
      record: stored.record,
    };
  } catch (error) {
    let code = error instanceof ManualHandoffError ? error.code : 'repository_unavailable';
    code = await diagnoseStaleness(db, goalId, stored.record, code);
    const unavailable =
      code === 'repository_unavailable' ||
      code === 'git_unavailable' ||
      code === 'source_tree_unavailable' ||
      code === 'base_tree_unavailable';
    return {
      state: unavailable ? 'unavailable' : 'stale',
      reason: { code, message: error instanceof ManualHandoffError ? error.message : ERROR_MESSAGES[code] },
      record: stored.record,
    };
  }
}

export interface ManualHandoffProjection {
  state: ManualHandoffValidation['state'];
  label: 'Ready for manual integration' | 'Handoff stale' | 'Handoff unavailable' | 'Handoff invalid';
  handoff: ManualIntegrationHandoffV1 | null;
  reason: ManualHandoffValidation['reason'];
  actualApplication: 'not_performed_by_turing';
  goalCompletion: 'not_completed_by_handoff';
}

/** Read-only bounded projection. A GET-like caller must not use this function to create a handoff. */
export async function getManualHandoffProjection(
  db: Db,
  goalId: string,
  handoffId: string,
): Promise<ManualHandoffProjection> {
  const validation = await validateManualHandoff(db, goalId, handoffId);
  const label = {
    current: 'Ready for manual integration',
    stale: 'Handoff stale',
    unavailable: 'Handoff unavailable',
    invalid: 'Handoff invalid',
  }[validation.state] as ManualHandoffProjection['label'];
  return {
    state: validation.state,
    label,
    handoff: validation.record ?? null,
    reason: validation.reason,
    actualApplication: 'not_performed_by_turing',
    goalCompletion: 'not_completed_by_handoff',
  };
}
