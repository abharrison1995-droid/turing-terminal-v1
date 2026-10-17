import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  GoalReviewKind,
  GoalReviewStatus,
  ReviewIndependence,
  ReviewReport,
  ReviewVerdict,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import type { CycleRow } from './cycles.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import { readReviewPlan } from './reviewPlan.js';
import { writeGoalEvent } from './events.js';
import { isAncestorOfHead, resolveGoalRepository } from './repository.js';

export type GoalReviewErrorCode =
  | 'goal_not_found'
  | 'definition_not_found'
  | 'definition_not_current'
  | 'milestone_required'
  | 'milestone_not_found'
  | 'cycle_not_found'
  | 'run_not_in_goal'
  | 'repository_unavailable'
  | 'repository_changed'
  | 'from_commit_invalid'
  | 'review_not_found'
  | 'review_not_pending'
  | 'report_invalid'
  | 'independence_invalid'
  | 'review_binding_invalid';

export class GoalReviewError extends Error {
  constructor(
    readonly code: GoalReviewErrorCode,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'GoalReviewError';
  }
}

export interface GoalReviewRow {
  id: string;
  goalId: string;
  cycleId: string | null;
  milestoneId: string | null;
  definitionVersion: number;
  runId: string | null;
  reviewKind: GoalReviewKind;
  status: GoalReviewStatus;
  reviewedFromCommit: string | null;
  reviewedToCommit: string;
  reviewedToTree: string;
  verdict: ReviewVerdict | null;
  blocking: boolean | null;
  report: ReviewReport | null;
  independence: ReviewIndependence | null;
  createdAt: string;
  completedAt: string | null;
}

interface DbRow {
  id: string;
  goal_id: string;
  cycle_id: string | null;
  milestone_id: string | null;
  definition_version: number;
  run_id: string | null;
  review_kind: GoalReviewKind;
  status: GoalReviewStatus;
  reviewed_from_commit: string | null;
  reviewed_to_commit: string;
  reviewed_to_tree: string;
  verdict: ReviewVerdict | null;
  blocking: number | null;
  report_json: string | null;
  independence_json: string | null;
  created_at: string;
  completed_at: string | null;
}

function toReview(row: DbRow): GoalReviewRow {
  return {
    id: row.id,
    goalId: row.goal_id,
    cycleId: row.cycle_id,
    milestoneId: row.milestone_id,
    definitionVersion: row.definition_version,
    runId: row.run_id,
    reviewKind: row.review_kind,
    status: row.status,
    reviewedFromCommit: row.reviewed_from_commit,
    reviewedToCommit: row.reviewed_to_commit,
    reviewedToTree: row.reviewed_to_tree,
    verdict: row.verdict,
    blocking: row.blocking === null ? null : row.blocking === 1,
    report: row.report_json ? (JSON.parse(row.report_json) as ReviewReport) : null,
    independence: row.independence_json ? (JSON.parse(row.independence_json) as ReviewIndependence) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function getReview(db: Db, reviewId: string): GoalReviewRow | undefined {
  const row = db.prepare('SELECT * FROM goal_reviews WHERE id = ?').get(reviewId) as DbRow | undefined;
  return row ? toReview(row) : undefined;
}

/** The review bound to a cycle (migration 022 allows at most one). */
export function reviewForCycle(db: Db, cycleId: string): GoalReviewRow | undefined {
  const row = db.prepare('SELECT * FROM goal_reviews WHERE cycle_id = ?').get(cycleId) as DbRow | undefined;
  return row ? toReview(row) : undefined;
}

/** The review bound to a run (migration 022 allows at most one). */
export function reviewForRun(db: Db, runId: string): GoalReviewRow | undefined {
  const row = db.prepare('SELECT * FROM goal_reviews WHERE run_id = ?').get(runId) as DbRow | undefined;
  return row ? toReview(row) : undefined;
}

export function listReviews(db: Db, goalId: string): GoalReviewRow[] {
  return (
    db
      .prepare('SELECT * FROM goal_reviews WHERE goal_id = ? ORDER BY created_at, rowid')
      .all(goalId) as DbRow[]
  ).map(toReview);
}

/**
 * A new review starts only under the current approved authority: the version must be the Goal's current definition
 * version and be `approved`. An in-flight review is not invalidated by a later amendment (it may still complete as
 * history), but it can no longer change current findings (see findings.ts). Synchronous, so it can run again inside
 * the insert transaction after the asynchronous Git reads.
 */
function assertCurrentApprovedDefinition(db: Db, goalId: string, definitionVersion: number): void {
  if (!loadDefinitionVersion(db, goalId, definitionVersion))
    throw new GoalReviewError('definition_not_found', 'No such definition version for this Goal.');
  const row = db
    .prepare(
      `SELECT g.current_definition_version AS current, d.status AS status
       FROM goals g LEFT JOIN goal_definition_versions d ON d.goal_id = g.id AND d.version = ?
       WHERE g.id = ?`,
    )
    .get(definitionVersion, goalId) as { current: number | null; status: string | null } | undefined;
  if (!row || row.current !== definitionVersion || row.status !== 'approved')
    throw new GoalReviewError(
      'definition_not_current',
      'A review can only start against the current approved definition version.',
    );
}

/**
 * Creates a pending review bound to the Goal's integration state: reviewed_to_commit and reviewed_to_tree are read
 * from Git at the verified Goal ref, never supplied by the caller. The binding is immutable (migration 017). An
 * optional `reviewedFromCommit` (the start of the reviewed range) must be an ancestor of the head.
 */
export async function createReview(
  db: Db,
  input: {
    goalId: string;
    definitionVersion: number;
    reviewKind: GoalReviewKind;
    cycleId?: string;
    milestoneId?: string;
    runId?: string;
    reviewedFromCommit?: string;
    now?: string;
  },
): Promise<{ id: string; reviewedToCommit: string; reviewedToTree: string }> {
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(input.goalId))
    throw new GoalReviewError('goal_not_found', 'The Goal does not exist.');
  assertCurrentApprovedDefinition(db, input.goalId, input.definitionVersion);
  if (input.reviewKind === 'milestone' && !input.milestoneId)
    throw new GoalReviewError('milestone_required', 'A milestone review names its milestone.');
  if (
    input.milestoneId &&
    !db
      .prepare('SELECT 1 FROM goal_milestones WHERE id = ? AND goal_id = ?')
      .get(input.milestoneId, input.goalId)
  )
    throw new GoalReviewError('milestone_not_found', 'The milestone does not belong to this Goal.');
  if (
    input.cycleId &&
    !db.prepare('SELECT 1 FROM goal_cycles WHERE id = ? AND goal_id = ?').get(input.cycleId, input.goalId)
  )
    throw new GoalReviewError('cycle_not_found', 'The cycle does not belong to this Goal.');
  if (input.runId) {
    const owner = db.prepare('SELECT goal_id, cycle_id FROM goal_runs WHERE run_id = ?').get(input.runId) as
      { goal_id: string; cycle_id: string } | undefined;
    if (!owner || owner.goal_id !== input.goalId || (input.cycleId && owner.cycle_id !== input.cycleId))
      throw new GoalReviewError('run_not_in_goal', 'The run does not belong to this Goal and cycle.');
  }
  const resolved = await resolveGoalRepository(db, input.goalId);
  if (!resolved.ok) throw new GoalReviewError('repository_unavailable', resolved.detail);
  const { state } = resolved;
  if (input.reviewedFromCommit && !(await isAncestorOfHead(state, input.reviewedFromCommit)))
    throw new GoalReviewError(
      'from_commit_invalid',
      'The start of the reviewed range is not in the Goal history.',
    );
  const now = input.now ?? new Date().toISOString();
  const id = randomUUID();
  db.transaction(() => {
    // The asynchronous Git reads above can interleave with an amendment: re-check the definition authority and the
    // head here, in the same transaction as the insert. Nothing is written if either moved.
    assertCurrentApprovedDefinition(db, input.goalId, input.definitionVersion);
    const head = (
      db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(input.goalId) as
        { integration_head: string | null } | undefined
    )?.integration_head;
    if (head !== state.head)
      throw new GoalReviewError('repository_changed', 'The Goal ref moved while creating the review.');
    db.prepare(
      `INSERT INTO goal_reviews (id, goal_id, cycle_id, milestone_id, definition_version, run_id, review_kind, status,
         reviewed_from_commit, reviewed_to_commit, reviewed_to_tree, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      id,
      input.goalId,
      input.cycleId ?? null,
      input.milestoneId ?? null,
      input.definitionVersion,
      input.runId ?? null,
      input.reviewKind,
      input.reviewedFromCommit ?? null,
      state.head,
      state.tree,
      now,
    );
  })();
  return { id, reviewedToCommit: state.head, reviewedToTree: state.tree };
}

export interface ReviewBindingInput {
  goalId: string;
  cycleId: string;
  runId: string;
  definitionVersion: number;
  reviewKind: GoalReviewKind;
  milestoneId?: string | null;
  reviewedFromCommit?: string | null;
  /** Read from Git by the trusted launcher alongside the head; re-proven against the Goal's head here. */
  reviewedToCommit: string;
  reviewedToTree: string;
  now: string;
}

/**
 * The SYNCHRONOUS immutable binding of a Goal review to its cycle, its run and the exact repository subject. It is
 * meant to run in the SAME outer transaction as `queueRun`, so a review run can never exist durably without its review
 * record. Because Git reads happened before the transaction, everything checkable in SQLite is re-proven here, and a
 * single mismatch throws (rolling the whole launch back): the Goal still owns a non-terminal review cycle of the
 * current approved definition (hash verified) whose plan is this kind/milestone/range, the run's immutable origin is
 * this cycle and purpose `review`, and the Goal head is still the reviewed commit. Never creates a review for a run it
 * cannot prove, and never updates an existing row.
 */
export function bindReviewRecord(db: Db, input: ReviewBindingInput): { id: string } {
  const fail = (message: string): never => {
    throw new GoalReviewError('review_binding_invalid', message);
  };
  assertCurrentApprovedDefinition(db, input.goalId, input.definitionVersion);
  const stored = loadDefinitionVersion(db, input.goalId, input.definitionVersion);
  if (!stored || !verifyDefinitionHash(stored)) fail('The approved definition no longer verifies.');
  const cycle = db
    .prepare(
      `SELECT goal_id, kind, status, definition_version, milestone_id, base_integration_commit, outcome_json
       FROM goal_cycles WHERE id = ?`,
    )
    .get(input.cycleId) as
    | {
        goal_id: string;
        kind: string;
        status: string;
        definition_version: number | null;
        milestone_id: string | null;
        base_integration_commit: string | null;
        outcome_json: string | null;
      }
    | undefined;
  if (!cycle || cycle.goal_id !== input.goalId) fail('The cycle does not belong to this Goal.');
  if (cycle!.kind !== 'review') fail('The cycle is not a review cycle.');
  if (!['planned', 'launching', 'running', 'collecting'].includes(cycle!.status))
    fail('The review cycle is no longer active.');
  if (cycle!.definition_version !== input.definitionVersion)
    fail('The review cycle belongs to another definition version.');
  let outcome: unknown = null;
  try {
    outcome = cycle!.outcome_json ? JSON.parse(cycle!.outcome_json) : null;
  } catch {
    outcome = null;
  }
  const plan = readReviewPlan(outcome);
  if (!plan) fail('The review cycle has no valid review plan.');
  if (plan!.reviewKind !== input.reviewKind) fail('The review kind is not the cycle plan.');
  if ((plan!.reviewedFromCommit ?? null) !== (input.reviewedFromCommit ?? null))
    fail('The reviewed range is not the cycle plan.');
  if ((cycle!.milestone_id ?? null) !== (input.milestoneId ?? null))
    fail('The review milestone is not the cycle milestone.');
  const head = (
    db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(input.goalId) as
      { integration_head: string | null } | undefined
  )?.integration_head;
  if (!head || head !== input.reviewedToCommit || cycle!.base_integration_commit !== input.reviewedToCommit)
    fail('The Goal head is no longer the reviewed commit.');
  const run = db
    .prepare('SELECT goal_cycle_id, goal_run_purpose, goal_base_commit FROM runs WHERE id = ?')
    .get(input.runId) as
    | { goal_cycle_id: string | null; goal_run_purpose: string | null; goal_base_commit: string | null }
    | undefined;
  if (
    !run ||
    run.goal_cycle_id !== input.cycleId ||
    run.goal_run_purpose !== 'review' ||
    run.goal_base_commit !== input.reviewedToCommit
  )
    fail('The run origin is not this review cycle.');
  const id = randomUUID();
  db.prepare(
    `INSERT INTO goal_reviews (id, goal_id, cycle_id, milestone_id, definition_version, run_id, review_kind, status,
       reviewed_from_commit, reviewed_to_commit, reviewed_to_tree, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    id,
    input.goalId,
    input.cycleId,
    input.milestoneId ?? null,
    input.definitionVersion,
    input.runId,
    input.reviewKind,
    input.reviewedFromCommit ?? null,
    input.reviewedToCommit,
    input.reviewedToTree,
    input.now,
  );
  return { id };
}

const text = (max: number) => z.string().max(max);
const path = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\\]/.test(value) && !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'must be a project-relative path',
  });

/** Strict structural schema for a ReviewReport (design 11.3). Unknown keys are rejected. */
export const reviewReportSchema = z.strictObject({
  verdict: z.enum(['pass', 'pass_with_findings', 'block']),
  criterionProgress: z
    .array(
      z.strictObject({
        criterionKey: text(128).min(1),
        assessment: z.enum(['met', 'partial', 'not_met', 'unknown']),
        basis: text(1000),
      }),
    )
    .max(100),
  existingFindings: z
    .array(
      z.strictObject({
        goalFindingId: text(64).min(1),
        status: z.enum(['still_open', 'resolved', 'not_assessed']),
        basis: text(1000),
      }),
    )
    .max(200),
  newFindings: z
    .array(
      z.strictObject({
        severity: z.enum(['critical', 'high', 'medium', 'low']),
        category: text(80).min(1),
        description: text(2000).min(1),
        evidence: text(4000),
        affectedFiles: z.array(path).max(50),
        remediation: text(2000),
      }),
    )
    .max(100),
  regressions: z.array(text(500)).max(50),
  scopeDrift: z.boolean(),
  architectureDrift: z.boolean(),
  furtherWorkJustified: z.boolean(),
});

export const reviewIndependenceSchema = z.strictObject({
  established: z.boolean(),
  policy: z.enum(['different-family', 'different-model', 'none']),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const BLOCKING_KINDS: Record<GoalReviewKind, 'periodic' | 'always'> = {
  periodic: 'periodic',
  milestone: 'always',
  repeated_failure: 'always',
  scope_change: 'always',
  final: 'always',
};

/**
 * Completes a pending review exactly once from a strictly validated ReviewReport. The report's goalFindingIds must
 * exist in this Goal and be unique, and criterion keys must exist in the review's definition version. `blocking` is
 * derived: a `block` verdict blocks, except that a periodic review blocks only when the definition says so.
 * `independence` is recorded as supplied by the routing/review authority; Stage 2B never infers it.
 */
export function completeReview(
  db: Db,
  input: { reviewId: string; report: unknown; independence?: unknown; now?: string },
): GoalReviewRow {
  const parsed = reviewReportSchema.safeParse(input.report);
  if (!parsed.success)
    throw new GoalReviewError(
      'report_invalid',
      'The review report does not match the required structure.',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  const report = parsed.data as ReviewReport;
  let independence: ReviewIndependence | null = null;
  if (input.independence !== undefined) {
    const result = reviewIndependenceSchema.safeParse(input.independence);
    if (!result.success || JSON.stringify(result.data).length > 4_000)
      throw new GoalReviewError('independence_invalid', 'The independence payload is invalid.');
    independence = result.data as ReviewIndependence;
  }
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const review = getReview(db, input.reviewId);
    if (!review) throw new GoalReviewError('review_not_found', 'No such review.');
    if (review.status !== 'pending')
      throw new GoalReviewError('review_not_pending', `A ${review.status} review cannot be completed again.`);
    const definition = loadDefinitionVersion(db, review.goalId, review.definitionVersion)!.definition;
    const issues: string[] = [];
    const criterionKeys = new Set(definition.contract.successCriteria.map((criterion) => criterion.key));
    report.criterionProgress.forEach((entry, index) => {
      if (!criterionKeys.has(entry.criterionKey))
        issues.push(`criterionProgress[${index}].criterionKey: unknown criterion "${entry.criterionKey}"`);
    });
    const seen = new Set<string>();
    report.existingFindings.forEach((entry, index) => {
      if (seen.has(entry.goalFindingId))
        issues.push(`existingFindings[${index}].goalFindingId: reported twice`);
      seen.add(entry.goalFindingId);
      if (
        !db
          .prepare('SELECT 1 FROM goal_findings WHERE id = ? AND goal_id = ?')
          .get(entry.goalFindingId, review.goalId)
      )
        issues.push(`existingFindings[${index}].goalFindingId: not a finding of this Goal`);
    });
    if (issues.length > 0)
      throw new GoalReviewError('report_invalid', 'The review report is inconsistent with the Goal.', issues);
    const blocksWhenBlock =
      BLOCKING_KINDS[review.reviewKind] === 'always' || definition.review.blocking.periodic;
    const blocking = report.verdict === 'block' && blocksWhenBlock;
    const changed = db
      .prepare(
        `UPDATE goal_reviews SET status = 'completed', verdict = ?, blocking = ?, report_json = ?, independence_json = ?,
           completed_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(
        report.verdict,
        blocking ? 1 : 0,
        JSON.stringify(report),
        independence ? JSON.stringify(independence) : null,
        now,
        review.id,
      ).changes;
    if (changed !== 1) throw new GoalReviewError('review_not_pending', 'The review was already decided.');
    writeGoalEvent(
      db,
      review.goalId,
      'review_completed',
      {
        reviewId: review.id,
        reviewKind: review.reviewKind,
        verdict: report.verdict,
        blocking,
        reviewedToTree: review.reviewedToTree,
      },
      now,
    );
    return getReview(db, review.id)!;
  })();
}

/** Marks a pending review failed or cancelled. Both are terminal and carry no report. */
export function closeReview(
  db: Db,
  input: { reviewId: string; status: 'failed' | 'cancelled'; now?: string },
): void {
  const now = input.now ?? new Date().toISOString();
  const changed = db
    .prepare("UPDATE goal_reviews SET status = ?, completed_at = ? WHERE id = ? AND status = 'pending'")
    .run(input.status, now, input.reviewId).changes;
  if (changed !== 1) {
    if (!getReview(db, input.reviewId)) throw new GoalReviewError('review_not_found', 'No such review.');
    throw new GoalReviewError('review_not_pending', 'Only a pending review can be failed or cancelled.');
  }
}

/**
 * Whether a PERSISTED review row still equals the immutable plan of the cycle that owns it: still pending, same kind,
 * milestone and reviewed range start. Used before an existing review run is reused or started; it never rewrites.
 */
export function reviewMatchesCyclePlan(
  review: GoalReviewRow,
  cycle: Pick<CycleRow, 'milestoneId' | 'outcome'>,
): boolean {
  const plan = readReviewPlan(cycle.outcome);
  return (
    !!plan &&
    review.status === 'pending' &&
    review.reviewKind === plan.reviewKind &&
    (review.reviewedFromCommit ?? null) === (plan.reviewedFromCommit ?? null) &&
    (review.milestoneId ?? null) === (cycle.milestoneId ?? null)
  );
}
