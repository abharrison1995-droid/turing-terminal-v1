import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { GOAL_TERMINAL_STATUSES, TERMINAL_RUN_STATUSES } from '../../shared/goals.js';
import type { GoalApproval } from '../../shared/goals.js';
import type { Db } from '../db.js';
import {
  gitTry,
  loadContext,
  preflightFinalApply,
  repositoryObjectFormat,
  type FinalApplyPreflight,
  type ObjectFormat,
} from '../goalGit.js';
import { activeCycle } from './cycles.js';
import { evaluateCompletion } from './completionEvaluation.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
import { isManualReconciliation } from './readModel.js';
import {
  computeFinalApplyIntentDigest,
  computeFinalApplyRepositoryIdentity,
  finalApplyApprovalDetailSchema,
  parseFinalApplyOperationRecord,
  sameFinalApplyIntent,
} from './finalApplyOperation.js';
export { computeFinalApplyIntentDigest } from './finalApplyOperation.js';

export const FINAL_APPLY_INTENT_SCHEMA_VERSION = 1 as const;
const ACTION = 'apply_to_base_intent' as const;
const MAX_DETAIL_CHARS = 4_000;
const PREVIEW_CHARS = 1_000;
const DIFF_STAT_CHARS = 600;

export interface FinalApplyIntent {
  schemaVersion: typeof FINAL_APPLY_INTENT_SCHEMA_VERSION;
  action: typeof ACTION;
  goalId: string;
  definitionVersion: number;
  definitionHash: string;
  source: {
    goalRef: string;
    integrationHead: string;
    integrationTree: string;
  };
  destination: {
    repoIdentity: string;
    baseBranch: string;
    baseRef: string;
    expectedBaseCommit: string;
  };
  review: {
    changedPathDigest: string;
    diffStatDigest: string;
    diffPreviewDigest: string;
    diffPreviewTruncated: boolean;
  };
  intentDigest: string;
}

export interface FinalApplyReviewDisplay {
  diffStat: string;
  diffPreview: string;
}

export interface PreparedFinalApplyIntent {
  intent: FinalApplyIntent;
  reviewDisplay: FinalApplyReviewDisplay;
  databaseBinding: { projectId: string; baseBranch: string; baseCommit: string };
}

export type FinalApplyAuthorityErrorCode =
  | 'goal_not_found'
  | 'goal_terminal'
  | 'manual_reconciliation_required'
  | 'active_work'
  | 'integration_operation_in_progress'
  | 'definition_not_approved'
  | 'definition_invalid'
  | 'completion_not_ready'
  | 'preflight_not_ready'
  | 'preflight_goal_not_initialized'
  | 'preflight_wrong_branch'
  | 'preflight_dirty_checkout'
  | 'preflight_base_diverged'
  | 'preflight_goal_ref_changed'
  | 'preflight_not_fast_forward'
  | 'preflight_unsafe_changes'
  | 'approval_not_found'
  | 'approval_mismatch'
  | 'approval_not_pending'
  | 'approval_not_approved'
  | 'final_apply_intent_invalid'
  | 'final_apply_intent_digest_mismatch'
  | 'final_apply_intent_stale';

export class FinalApplyAuthorityError extends Error {
  constructor(
    readonly code: FinalApplyAuthorityErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'FinalApplyAuthorityError';
  }
}

const detailSchema = finalApplyApprovalDetailSchema;

type IntentBody = Omit<FinalApplyIntent, 'intentDigest'>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedDisplay(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = '\n… [truncated]';
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

function ensure(
  condition: unknown,
  code: FinalApplyAuthorityErrorCode,
  message: string,
  detail?: string,
): asserts condition {
  if (!condition) throw new FinalApplyAuthorityError(code, message, detail);
}

function sameIntent(left: FinalApplyIntent, right: FinalApplyIntent): boolean {
  return sameFinalApplyIntent(left, right);
}

function activeRun(db: Db, goalId: string): boolean {
  const placeholders = [...TERMINAL_RUN_STATUSES].map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 FROM goal_runs gr JOIN runs r ON r.id = gr.run_id
       WHERE gr.goal_id = ? AND r.status NOT IN (${placeholders}) LIMIT 1`,
    )
    .get(goalId, ...TERMINAL_RUN_STATUSES) as { 1: number } | undefined;
  return Boolean(row);
}

function hasPlannedOperation(db: Db, goalId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned' LIMIT 1")
      .get(goalId),
  );
}

export interface PlannedFinalApplyAllowance {
  operationId: string;
  approvalId: string;
  operationDigest: string;
  intent: FinalApplyIntent;
}

function assertDatabaseEligibility(
  db: Db,
  goalId: string,
  allowance?: PlannedFinalApplyAllowance,
): {
  projectId: string;
  definitionVersion: number;
  definitionHash: string;
  integrationHead: string;
  baseBranch: string;
  baseCommit: string;
} {
  const goal = db
    .prepare(
      `SELECT g.status, g.project_id, g.current_definition_version AS definition_version,
              r.integration_head, r.base_branch, r.base_commit
       FROM goals g JOIN goal_runtime r ON r.goal_id = g.id WHERE g.id = ?`,
    )
    .get(goalId) as
    | {
        status: string;
        project_id: string;
        definition_version: number | null;
        integration_head: string | null;
        base_branch: string | null;
        base_commit: string | null;
      }
    | undefined;
  ensure(goal, 'goal_not_found', 'The Goal does not exist or has no runtime state.');
  ensure(
    !GOAL_TERMINAL_STATUSES.includes(goal.status as (typeof GOAL_TERMINAL_STATUSES)[number]),
    'goal_terminal',
    'A completed or abandoned Goal cannot request final-apply authority.',
  );
  ensure(
    !isManualReconciliation(db, goalId),
    'manual_reconciliation_required',
    'This Goal needs manual reconciliation before final-apply authority can be prepared.',
  );
  ensure(
    !activeCycle(db, goalId) && !activeRun(db, goalId),
    'active_work',
    'Goal work is still active; final-apply authority requires a stable source.',
  );
  const planned = db
    .prepare(
      "SELECT id, approval_id, expected_old, new_commit, checks_json FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned'",
    )
    .get(goalId) as
    | {
        id: string;
        approval_id: string | null;
        expected_old: string | null;
        new_commit: string;
        checks_json: string;
      }
    | undefined;
  if (planned) {
    ensure(allowance, 'integration_operation_in_progress', 'A Goal integration operation is unresolved.');
    const record = parseFinalApplyOperationRecord(planned.checks_json);
    ensure(
      record !== null &&
        planned.id === allowance.operationId &&
        planned.approval_id === allowance.approvalId &&
        record.operationId === allowance.operationId &&
        record.goalId === goalId &&
        record.approvalId === allowance.approvalId &&
        record.operationDigest === allowance.operationDigest &&
        sameIntent(record.intent, allowance.intent) &&
        planned.expected_old === record.destination.expectedBaseCommit &&
        planned.new_commit === record.source.integrationHead,
      'integration_operation_in_progress',
      'Only the exact matching planned final-apply operation may pass this recheck.',
    );
  } else if (allowance) {
    ensure(
      false,
      'integration_operation_in_progress',
      'The planned final-apply operation is no longer active.',
    );
  }
  ensure(
    goal.definition_version !== null,
    'definition_not_approved',
    'The Goal has no current approved definition.',
  );
  const version = loadDefinitionVersion(db, goalId, goal.definition_version);
  ensure(
    version?.status === 'approved',
    'definition_not_approved',
    'The current Goal definition is not approved.',
  );
  ensure(verifyDefinitionHash(version), 'definition_invalid', 'The stored Goal definition hash is invalid.');
  ensure(
    version.definition.contract.completionPolicy.applyToBase === 'required',
    'completion_not_ready',
    'This Goal does not require application to its base branch.',
  );
  ensure(goal.integration_head, 'preflight_not_ready', 'The Goal integration head is unavailable.');
  ensure(
    goal.base_branch && goal.base_commit,
    'preflight_not_ready',
    'The recorded base branch is unavailable.',
  );
  return {
    projectId: goal.project_id,
    definitionVersion: version.version,
    definitionHash: version.definitionHash,
    integrationHead: goal.integration_head,
    baseBranch: goal.base_branch,
    baseCommit: goal.base_commit,
  };
}

function validObjectId(value: string | null, format: ObjectFormat): value is string {
  const length = format === 'sha256' ? 64 : 40;
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
}

function preflightRefusal(preflight: FinalApplyPreflight): {
  code: FinalApplyAuthorityErrorCode;
  message: string;
} {
  switch (preflight.status) {
    case 'wrong_branch':
      return { code: 'preflight_wrong_branch', message: 'The registered base branch is not checked out.' };
    case 'dirty_checkout':
      return {
        code: 'preflight_dirty_checkout',
        message: 'The base checkout has tracked or untracked changes.',
      };
    case 'base_diverged':
      return {
        code: 'preflight_base_diverged',
        message: 'The base branch no longer points to its recorded commit.',
      };
    case 'goal_ref_changed':
      return {
        code: 'preflight_goal_ref_changed',
        message: 'The Goal ref moved or is checked out in another worktree.',
      };
    case 'not_fast_forward':
      return {
        code: 'preflight_not_fast_forward',
        message: 'The Goal ref is not a fast-forward from the recorded base.',
      };
    case 'unsafe_changes':
      return {
        code: 'preflight_unsafe_changes',
        message: 'The complete changed-path or content safety scan refused this change.',
      };
    case 'goal_not_initialized':
      return {
        code: 'preflight_goal_not_initialized',
        message: 'The Goal has no initialized integration head.',
      };
    default:
      return { code: 'preflight_not_ready', message: 'The final-apply Git preflight is not ready.' };
  }
}

/**
 * Constructs the only prospective authority record. This is read-only: completion evaluation and Git preflight only
 * inspect persisted Goal state and repository objects/worktree state.
 */
async function prepareIntent(
  db: Db,
  goalId: string,
  allowance?: PlannedFinalApplyAllowance,
): Promise<PreparedFinalApplyIntent> {
  const eligibility = assertDatabaseEligibility(db, goalId, allowance);
  const evaluation = await evaluateCompletion(db, goalId);
  // `evaluateCompletion` returns the exact proof basis, including the current definition and integration head.
  const completionReady =
    !evaluation.ok &&
    evaluation.failures.length === 1 &&
    evaluation.failures[0]?.code === 'final_apply_required';
  ensure(
    completionReady,
    'completion_not_ready',
    'Every completion requirement except final application must pass.',
    evaluation.failures.map((failure) => failure.code).join(', ') || 'completion already passed',
  );
  ensure(
    evaluation.definitionVersion === eligibility.definitionVersion &&
      evaluation.definitionHash === eligibility.definitionHash &&
      evaluation.integrationHead === eligibility.integrationHead,
    'completion_not_ready',
    'Completion evidence changed while final-apply authority was being prepared.',
  );

  const context = loadContext(db, goalId);
  const preflight = await preflightFinalApply(db, goalId, { previewChars: PREVIEW_CHARS });
  if (preflight.status !== 'ready_for_approved_apply') {
    const refusal = preflightRefusal(preflight);
    throw new FinalApplyAuthorityError(refusal.code, refusal.message, preflight.status);
  }
  const format = await repositoryObjectFormat(context.repoRoot);
  const treeResult = await gitTry(context.repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${eligibility.integrationHead}^{tree}`,
  ]);
  const integrationTree = treeResult.ok ? treeResult.stdout.trim() : null;
  ensure(
    validObjectId(eligibility.integrationHead, format),
    'preflight_not_ready',
    'The full Goal commit id is invalid.',
  );
  ensure(
    validObjectId(integrationTree, format),
    'preflight_not_ready',
    'The full Goal tree id is unavailable.',
  );
  ensure(
    validObjectId(preflight.recordedBaseCommit, format),
    'preflight_not_ready',
    'The full base commit id is invalid.',
  );
  ensure(
    preflight.goalRef === eligibility.integrationHead &&
      preflight.integrationHead === eligibility.integrationHead &&
      preflight.currentHead === preflight.recordedBaseCommit &&
      preflight.currentBranch === preflight.recordedBaseBranch &&
      preflight.recordedBaseBranch === eligibility.baseBranch &&
      preflight.recordedBaseCommit === eligibility.baseCommit &&
      preflight.safety.ok,
    'preflight_not_ready',
    'The source or destination changed during Git preflight.',
  );

  const commonResult = await gitTry(context.repoRoot, ['rev-parse', '--git-common-dir']);
  ensure(
    commonResult.ok && commonResult.stdout.trim(),
    'preflight_not_ready',
    'The Git common directory is unavailable.',
  );
  const commonPath = commonResult.stdout.trim();
  const gitCommonDir = realpathSync(
    isAbsolute(commonPath) ? commonPath : resolve(context.repoRoot, commonPath),
  );
  const repoIdentity = computeFinalApplyRepositoryIdentity(
    context.projectId,
    context.repoRoot,
    gitCommonDir,
    context.scope,
  );
  const reviewDisplay: FinalApplyReviewDisplay = {
    diffStat: boundedDisplay(preflight.diffStat, DIFF_STAT_CHARS),
    diffPreview: preflight.diffPreview,
  };
  const paths = [...preflight.changedPaths].sort();
  const body: IntentBody = {
    schemaVersion: FINAL_APPLY_INTENT_SCHEMA_VERSION,
    action: ACTION,
    goalId,
    definitionVersion: eligibility.definitionVersion,
    definitionHash: eligibility.definitionHash,
    source: {
      goalRef: context.ref,
      integrationHead: eligibility.integrationHead,
      integrationTree,
    },
    destination: {
      repoIdentity,
      baseBranch: preflight.recordedBaseBranch!,
      baseRef: `refs/heads/${preflight.recordedBaseBranch!}`,
      expectedBaseCommit: preflight.recordedBaseCommit!,
    },
    review: {
      changedPathDigest: sha256(JSON.stringify(paths)),
      diffStatDigest: sha256(reviewDisplay.diffStat),
      diffPreviewDigest: sha256(reviewDisplay.diffPreview),
      diffPreviewTruncated: preflight.diffPreviewTruncated,
    },
  };
  const intent: FinalApplyIntent = {
    ...body,
    intentDigest: computeFinalApplyIntentDigest(body),
  };
  return {
    intent,
    reviewDisplay,
    databaseBinding: {
      projectId: eligibility.projectId,
      baseBranch: eligibility.baseBranch,
      baseCommit: eligibility.baseCommit,
    },
  };
}

export async function prepareFinalApplyIntent(db: Db, goalId: string): Promise<PreparedFinalApplyIntent> {
  return prepareIntent(db, goalId);
}

function parseProspectiveDetail(approval: NonNullable<ReturnType<typeof getGoalApproval>>): {
  intent: FinalApplyIntent;
  repositoryProjectId: string;
  reviewDisplay: FinalApplyReviewDisplay;
} {
  const parsed = detailSchema.safeParse(approval.detail);
  if (!parsed.success)
    throw new FinalApplyAuthorityError(
      'final_apply_intent_invalid',
      'The prospective final-apply approval detail is malformed.',
    );
  if (approval.intentDigest !== parsed.data.intent.intentDigest)
    throw new FinalApplyAuthorityError(
      'final_apply_intent_digest_mismatch',
      'The typed approval digest does not match its immutable intent detail.',
    );
  if (approval.intentDigest !== parsed.data.intentDigest)
    throw new FinalApplyAuthorityError(
      'final_apply_intent_digest_mismatch',
      'The top-level approval digest does not match its immutable intent detail.',
    );
  const { intent, reviewDisplay } = parsed.data;
  const { intentDigest, ...body } = intent;
  if (computeFinalApplyIntentDigest(body) !== intentDigest)
    throw new FinalApplyAuthorityError(
      'final_apply_intent_digest_mismatch',
      'The prospective final-apply intent digest is invalid.',
    );
  if (
    sha256(reviewDisplay.diffStat) !== intent.review.diffStatDigest ||
    sha256(reviewDisplay.diffPreview) !== intent.review.diffPreviewDigest
  )
    throw new FinalApplyAuthorityError(
      'final_apply_intent_digest_mismatch',
      'The reviewed diff display does not match its immutable digest.',
    );
  return { intent, repositoryProjectId: parsed.data.repositoryProjectId, reviewDisplay };
}

export interface ValidatedFinalApplyAuthority {
  goalId: string;
  approvalId: string;
  repositoryProjectId: string;
  intent: FinalApplyIntent;
  reviewDisplay: FinalApplyReviewDisplay;
}

export type FinalApplyAuthorityValidation =
  | { ok: true; authority: ValidatedFinalApplyAuthority }
  | { ok: false; code: FinalApplyAuthorityErrorCode; detail: string };

/**
 * Read-only revalidation for approval and the future 7C.2B writer. No caller-supplied replacement authority values are
 * accepted. The `pending` mode is used only before the existing explicit user decision is committed.
 */
export async function validateFinalApplyAuthority(
  db: Db,
  goalId: string,
  approvalId: string,
  options: {
    expectedStatus?: 'pending' | 'approved';
    allowPlannedOperation?: PlannedFinalApplyAllowance;
  } = {},
): Promise<FinalApplyAuthorityValidation> {
  try {
    const approval = getGoalApproval(db, approvalId);
    ensure(approval, 'approval_not_found', 'No such Goal approval.');
    ensure(
      approval.goalId === goalId && approval.gate === 'final_apply',
      'approval_mismatch',
      'The approval does not authorize this Goal final apply.',
    );
    // Completion and correction approvals are never final-apply authority (D.3E F2).
    ensure(
      approval.externalCompletionActionDigest === undefined &&
        approval.attestationCorrectionActionDigest === undefined,
      'approval_mismatch',
      'Completion and correction approvals are never final-apply authority.',
    );
    ensure(
      approval.risk === 'high' && approval.requestedBy === 'user',
      'approval_mismatch',
      'Final-apply authority requires a high-risk user-requested approval.',
    );
    const expectedStatus = options.expectedStatus ?? 'approved';
    ensure(
      approval.status === expectedStatus,
      expectedStatus === 'pending' ? 'approval_not_pending' : 'approval_not_approved',
      `The approval must be ${expectedStatus}.`,
    );
    if (expectedStatus === 'approved')
      ensure(
        approval.decidedBy === 'user',
        'approval_mismatch',
        'Only an explicit user decision can approve final apply.',
      );
    else
      ensure(
        approval.decidedBy === null,
        'approval_mismatch',
        'A pending approval cannot already have a decision actor.',
      );

    const stored = parseProspectiveDetail(approval);
    ensure(stored.intent.goalId === goalId, 'approval_mismatch', 'The intent belongs to a different Goal.');
    if (options.allowPlannedOperation) {
      ensure(
        options.allowPlannedOperation.approvalId === approvalId &&
          sameIntent(options.allowPlannedOperation.intent, stored.intent),
        'integration_operation_in_progress',
        'The planned-operation exception is not bound to this complete approved intent.',
      );
    }
    const current = await prepareIntent(db, goalId, options.allowPlannedOperation);
    ensure(
      sameIntent(stored.intent, current.intent) &&
        stored.intent.intentDigest === current.intent.intentDigest &&
        stored.repositoryProjectId === current.databaseBinding.projectId &&
        JSON.stringify(stored.reviewDisplay) === JSON.stringify(current.reviewDisplay),
      'final_apply_intent_stale',
      'The approved final-apply intent no longer matches the current Goal and repository state.',
    );
    return {
      ok: true,
      authority: {
        goalId,
        approvalId,
        repositoryProjectId: stored.repositoryProjectId,
        intent: stored.intent,
        reviewDisplay: stored.reviewDisplay,
      },
    };
  } catch (error) {
    if (error instanceof FinalApplyAuthorityError)
      return { ok: false, code: error.code, detail: error.message };
    return {
      ok: false,
      code: 'preflight_not_ready',
      detail: 'Final-apply authority could not be revalidated against current state.',
    };
  }
}

/** Database-only write-boundary recheck. Caller holds BEGIN IMMEDIATE and supplies the complete matching plan. */
export function assertFinalApplyOperationDatabaseCurrent(
  db: Db,
  goalId: string,
  approvalId: string,
  allowance: PlannedFinalApplyAllowance,
): void {
  const approval = getGoalApproval(db, approvalId);
  ensure(approval, 'approval_not_found', 'No such Goal approval.');
  ensure(
    approval.goalId === goalId &&
      approval.gate === 'final_apply' &&
      approval.risk === 'high' &&
      approval.requestedBy === 'user' &&
      approval.status === 'approved' &&
      approval.decidedBy === 'user',
    'approval_mismatch',
    'Only the explicit approved user authority may apply this Goal.',
  );
  ensure(
    approval.externalCompletionActionDigest === undefined &&
      approval.attestationCorrectionActionDigest === undefined,
    'approval_mismatch',
    'Completion and correction approvals are never final-apply authority.',
  );
  const stored = parseProspectiveDetail(approval);
  ensure(
    allowance.approvalId === approvalId && sameIntent(allowance.intent, stored.intent),
    'integration_operation_in_progress',
    'The write-boundary exception is not bound to the complete approved intent.',
  );
  const current = assertDatabaseEligibility(db, goalId, allowance);
  ensure(
    current.projectId === stored.repositoryProjectId &&
      current.definitionVersion === stored.intent.definitionVersion &&
      current.definitionHash === stored.intent.definitionHash &&
      current.integrationHead === stored.intent.source.integrationHead &&
      current.baseBranch === stored.intent.destination.baseBranch &&
      current.baseCommit === stored.intent.destination.expectedBaseCommit,
    'final_apply_intent_stale',
    'The approved intent no longer matches the current Goal database state.',
  );
}

/** Synchronous database-only half of decision-time validation; call inside the approval decision transaction. */
export function assertFinalApplyApprovalDatabaseCurrent(db: Db, approvalId: string): void {
  const approval = getGoalApproval(db, approvalId);
  ensure(approval, 'approval_not_found', 'No such Goal approval.');
  ensure(
    approval.gate === 'final_apply' && approval.risk === 'high' && approval.requestedBy === 'user',
    'approval_mismatch',
    'Final-apply authority requires a high-risk user-requested approval.',
  );
  ensure(
    approval.externalCompletionActionDigest === undefined &&
      approval.attestationCorrectionActionDigest === undefined,
    'approval_mismatch',
    'Completion and correction approvals are never final-apply authority.',
  );
  ensure(
    approval.status === 'pending',
    'approval_not_pending',
    'The final-apply approval is no longer pending.',
  );
  const stored = parseProspectiveDetail(approval);
  const current = assertDatabaseEligibility(db, approval.goalId);
  ensure(
    current.projectId === stored.repositoryProjectId &&
      current.definitionVersion === stored.intent.definitionVersion &&
      current.definitionHash === stored.intent.definitionHash &&
      current.integrationHead === stored.intent.source.integrationHead &&
      current.baseBranch === stored.intent.destination.baseBranch &&
      current.baseCommit === stored.intent.destination.expectedBaseCommit,
    'final_apply_intent_stale',
    'The final-apply intent no longer matches the current Goal database state.',
  );
}

function assertPreparedDatabaseState(db: Db, prepared: PreparedFinalApplyIntent): void {
  const current = db
    .prepare(
      `SELECT g.status, g.project_id, g.current_definition_version AS definition_version,
              d.definition_hash, r.integration_head, r.base_branch, r.base_commit
       FROM goals g JOIN goal_runtime r ON r.goal_id = g.id
       LEFT JOIN goal_definition_versions d
         ON d.goal_id = g.id AND d.version = g.current_definition_version
       WHERE g.id = ?`,
    )
    .get(prepared.intent.goalId) as
    | {
        status: string;
        project_id: string;
        definition_version: number | null;
        definition_hash: string | null;
        integration_head: string | null;
        base_branch: string | null;
        base_commit: string | null;
      }
    | undefined;
  ensure(current, 'goal_not_found', 'The Goal does not exist.');
  ensure(
    !GOAL_TERMINAL_STATUSES.includes(current.status as (typeof GOAL_TERMINAL_STATUSES)[number]),
    'goal_terminal',
    'A completed or abandoned Goal cannot request final-apply authority.',
  );
  ensure(
    current.definition_version === prepared.intent.definitionVersion &&
      current.definition_hash === prepared.intent.definitionHash &&
      current.integration_head === prepared.intent.source.integrationHead &&
      current.project_id === prepared.databaseBinding.projectId &&
      current.base_branch === prepared.databaseBinding.baseBranch &&
      current.base_commit === prepared.databaseBinding.baseCommit &&
      current.base_branch === prepared.intent.destination.baseBranch &&
      current.base_commit === prepared.intent.destination.expectedBaseCommit,
    'final_apply_intent_stale',
    'The Goal definition or integration head changed before the approval request was stored.',
  );
  ensure(
    !isManualReconciliation(db, prepared.intent.goalId),
    'manual_reconciliation_required',
    'This Goal needs manual reconciliation before final-apply authority can be requested.',
  );
  ensure(
    !activeCycle(db, prepared.intent.goalId) && !activeRun(db, prepared.intent.goalId),
    'active_work',
    'Goal work became active before the approval request was stored.',
  );
  ensure(
    !hasPlannedOperation(db, prepared.intent.goalId),
    'integration_operation_in_progress',
    'A Goal integration operation became unresolved before the approval request was stored.',
  );
}

/**
 * Creates or reuses a high-risk, user-requested approval through the existing Goal approval ledger. Git validation is
 * performed before SQLite locking; BEGIN IMMEDIATE plus the unique partial index converge duplicate requests.
 */
export async function requestFinalApplyApproval(
  db: Db,
  goalId: string,
  options: { retryDenied?: boolean; now?: string } = {},
): Promise<GoalApproval> {
  const prepared = await prepareFinalApplyIntent(db, goalId);
  const now = options.now ?? new Date().toISOString();
  return db
    .transaction(() => {
      assertPreparedDatabaseState(db, prepared);
      const prior = db
        .prepare(
          `SELECT id FROM goal_approvals
           WHERE goal_id = ? AND gate = 'final_apply' AND intent_digest = ?
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(goalId, prepared.intent.intentDigest) as { id: string } | undefined;
      const existing = prior ? getGoalApproval(db, prior.id) : undefined;

      const stalePending = db
        .prepare(
          `SELECT id FROM goal_approvals
           WHERE goal_id = ? AND gate = 'final_apply' AND intent_digest IS NOT NULL
             AND intent_digest <> ? AND status = 'pending' ORDER BY created_at, rowid`,
        )
        .all(goalId, prepared.intent.intentDigest) as Array<{ id: string }>;
      for (const row of stalePending)
        decideGoalApproval(db, {
          goalId,
          approvalId: row.id,
          decision: 'denied',
          decidedBy: 'system',
          note: 'Prospective final-apply intent became stale; request and review the current intent.',
          now,
        });

      if (existing && (existing.status === 'pending' || existing.status === 'approved')) return existing;
      if (existing?.status === 'denied' && !options.retryDenied) return existing;

      const reason = `Approve fast-forward of ${prepared.intent.source.integrationHead.slice(0, 12)} to ${prepared.intent.destination.baseBranch} at ${prepared.intent.destination.expectedBaseCommit.slice(0, 12)} (${prepared.intent.review.changedPathDigest.slice(0, 8)} path-set digest)`;
      const detail = {
        action: ACTION,
        intentDigest: prepared.intent.intentDigest,
        repositoryProjectId: prepared.databaseBinding.projectId,
        intent: prepared.intent,
        reviewDisplay: prepared.reviewDisplay,
      };
      ensure(
        JSON.stringify(detail).length <= MAX_DETAIL_CHARS,
        'preflight_not_ready',
        'The bounded final-apply review cannot fit in the existing approval detail limit.',
      );
      return requestGoalApproval(db, {
        goalId,
        gate: 'final_apply',
        risk: 'high',
        reason,
        requestedBy: 'user',
        detail,
        intentDigest: prepared.intent.intentDigest,
        now,
      });
    })
    .immediate()!;
}
