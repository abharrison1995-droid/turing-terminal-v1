import { randomUUID } from 'node:crypto';
import type { GoalDefinition, GoalReviewKind } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { evaluateBounds } from './bounds.js';
import { activeCycle, CycleError, getCycle, type CreateCycleResult } from './cycles.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import { writeGoalEvent } from './events.js';
import { isAncestorOfHead, resolveGoalRepository } from './repository.js';
import { REVIEW_PLAN_LIMITS, type ReviewPlan } from './reviewPlan.js';
import { reviewerCountFor } from './reviewWorkflow.js';
import { registeredGoalWorkflow } from './turingExecutor.js';
import { transitionGoal } from './stateMachine.js';

/**
 * Chooses the honest start of the reviewed range (design section 11). `null` means "the whole relevant
 * history"; a commit is returned only when it is still an ancestor of the integration head. `createReview()` re-proves
 * ancestry when the review row is bound, so this is a deterministic hint, never authority.
 *
 *  - periodic + full_diff, and final: null.
 *  - periodic + since_last_review, repeated_failure, scope_change: the previous completed review's reviewed-to commit,
 *    or null when there is none or it is no longer in the history.
 *  - milestone: the integration commit the milestone's first successful execution/remediation cycle started from
 *    (the head before the milestone's work), or null when unavailable.
 */
export async function selectReviewRange(
  db: Db,
  goalId: string,
  reviewKind: GoalReviewKind,
  options: { milestoneKey?: string } = {},
): Promise<string | null> {
  const goal = db.prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?').get(goalId) as
    { v: number | null } | undefined;
  const definition = goal?.v == null ? undefined : loadDefinitionVersion(db, goalId, goal.v)?.definition;
  if (!definition) return null;
  let candidate: string | null = null;
  if (reviewKind === 'final') return null;
  if (reviewKind === 'periodic' && definition.review.periodic?.scope === 'full_diff') return null;
  if (reviewKind === 'milestone') {
    const row = options.milestoneKey
      ? (db
          .prepare(
            `SELECT c.base_integration_commit AS base FROM goal_cycles c
               JOIN goal_milestones m ON m.id = c.milestone_id
              WHERE c.goal_id = ? AND m.milestone_key = ? AND c.kind IN ('execution','remediation')
                AND c.status = 'succeeded' AND c.base_integration_commit IS NOT NULL
              ORDER BY c.sequence LIMIT 1`,
          )
          .get(goalId, options.milestoneKey) as { base: string } | undefined)
      : undefined;
    candidate = row?.base ?? null;
  } else {
    const row = db
      .prepare(
        `SELECT reviewed_to_commit AS head FROM goal_reviews WHERE goal_id = ? AND status = 'completed'
          ORDER BY completed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(goalId) as { head: string } | undefined;
    candidate = row?.head ?? null;
  }
  if (!candidate) return null;
  const resolved = await resolveGoalRepository(db, goalId);
  if (!resolved.ok) return null;
  return (await isAncestorOfHead(resolved.state, candidate)) ? candidate : null;
}

function boundedDetail(
  detail: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, 12)
      .map(([key, value]) => [key.slice(0, 40), typeof value === 'string' ? value.slice(0, 400) : value]),
  );
}

export interface CreateReviewCycleInput {
  goalId: string;
  reviewKind: GoalReviewKind;
  /** Why the review exists (a stable code, for example `milestone_complete`); recorded on the cycle. */
  triggerCode: string;
  /** Required for a milestone review; optional (and recorded) for the others. */
  milestoneKey?: string;
  /** The start of the reviewed range, from `selectReviewRange`; null = the whole relevant history. */
  reviewedFromCommit?: string | null;
  /** Bounded finite facts about why it was triggered; recorded only in the `cycle_created` event. */
  triggerDetail?: Record<string, string | number | boolean | null>;
  now?: string;
  liveActiveMs?: number;
}

/**
 * The focused review-cycle creator. In ONE transaction it creates a `planned` review cycle bound to the current
 * approved definition and the current integration head (an optional milestone, a trigger code, the next sequence, its
 * review plan) and moves the Goal `running -> reviewing` (`review_triggered`). A review does not count against
 * maxExecutionCycles or maxRemediationAttempts (those counters only ever count execution and remediation cycles); it
 * still obeys wall clock, active time, spend, the one-active-cycle rule and the migration-020 invariants. Idempotent:
 * an existing active cycle is returned and nothing is written. The supervisor's trigger selector (`reviewTriggers.ts`) is its only automatic caller.
 */
export function createReviewCycle(db: Db, input: CreateReviewCycleInput): CreateCycleResult {
  const now = input.now ?? new Date().toISOString();
  return db.transaction((): CreateCycleResult => {
    const goal = db
      .prepare('SELECT status, current_definition_version FROM goals WHERE id = ?')
      .get(input.goalId) as { status: string; current_definition_version: number | null } | undefined;
    if (!goal || goal.status !== 'running')
      throw new CycleError('goal_not_running', 'Review cycles are created only for a running Goal.');
    const existing = activeCycle(db, input.goalId);
    if (existing) return { created: false, reason: 'active_cycle_exists', cycle: existing };
    const version =
      goal.current_definition_version === null
        ? undefined
        : loadDefinitionVersion(db, input.goalId, goal.current_definition_version);
    if (!version || version.status !== 'approved')
      throw new CycleError('definition_not_current', 'The current definition is not approved.');
    if (!verifyDefinitionHash(version))
      throw new CycleError('definition_hash_mismatch', 'The stored definition does not match its hash.');
    const definition = version.definition as GoalDefinition;
    let milestoneId: string | null = null;
    if (input.reviewKind === 'milestone' && !input.milestoneKey)
      throw new CycleError('milestone_not_current', 'A milestone review names its milestone.');
    if (input.milestoneKey) {
      const row = db
        .prepare('SELECT id FROM goal_milestones WHERE goal_id = ? AND milestone_key = ?')
        .get(input.goalId, input.milestoneKey) as { id: string } | undefined;
      if (!row || !definition.milestones.some((milestone) => milestone.key === input.milestoneKey))
        throw new CycleError('milestone_not_current', 'The milestone is not part of the current definition.');
      milestoneId = row.id;
    }
    const runtime = db
      .prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?')
      .get(input.goalId) as { integration_head: string | null } | undefined;
    if (!runtime?.integration_head)
      throw new CycleError('goal_not_initialized', 'The Goal has no integration head.');
    const breach = evaluateBounds(db, input.goalId, { now, liveActiveMs: input.liveActiveMs });
    if (breach) throw new CycleError('bound_exceeded', breach.message, breach);
    // The reviewer count comes from approved authority and the registered review workflow, never from the caller.
    const reviewerCount = reviewerCountFor(
      definition,
      registeredGoalWorkflow(db, definition.routing.workflows.review),
      input.reviewKind,
    );
    if (reviewerCount < 1 || reviewerCount > REVIEW_PLAN_LIMITS.maxReviewers)
      throw new CycleError('bound_exceeded', 'The reviewer count is out of range.');
    const plan: ReviewPlan = {
      reviewKind: input.reviewKind,
      reviewerCount,
      reviewedFromCommit: input.reviewedFromCommit ?? null,
    };
    const sequence =
      (
        db
          .prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM goal_cycles WHERE goal_id = ?')
          .get(input.goalId) as { s: number }
      ).s + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status,
         base_integration_commit, outcome_json, created_at) VALUES (?, ?, ?, ?, ?, 'review', ?, 'planned', ?, ?, ?)`,
    ).run(
      id,
      input.goalId,
      version.version,
      milestoneId,
      sequence,
      input.triggerCode,
      runtime.integration_head,
      JSON.stringify({ reviewPlan: plan }),
      now,
    );
    writeGoalEvent(
      db,
      input.goalId,
      'cycle_created',
      {
        cycleId: id,
        sequence,
        kind: 'review',
        triggerCode: input.triggerCode,
        milestoneKey: input.milestoneKey ?? null,
        ...(input.triggerDetail ? { triggerDetail: boundedDetail(input.triggerDetail) } : {}),
        definitionVersion: version.version,
        baseIntegrationCommit: runtime.integration_head,
      },
      now,
    );
    transitionGoal(db, {
      goalId: input.goalId,
      to: 'reviewing',
      reasonCode: 'review_triggered',
      actor: 'supervisor',
      detail: { cycleId: id, reviewKind: input.reviewKind },
      now,
    });
    return { created: true, cycle: getCycle(db, id)! };
  })();
}
