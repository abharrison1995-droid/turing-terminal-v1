import type {
  GoalDefinition,
  GoalReviewKind,
  MilestoneBlocker,
  MilestoneEvaluation,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import { changedEntries, changedPathSet, diffLineCount } from '../goalGit.js';
import { resolveGoalRepository, type GoalRepositoryState } from './repository.js';
import { selectReviewRange } from './reviewCycle.js';

/**
 * Deterministic review triggering (Stage 6B.1). Everything here is derived from durable facts: the approved definition,
 * `goal_cycles`, `goal_reviews`, `goal_runtime` counters, `goal_integration_ops` and the Goal's integration head/tree.
 * There is no cursor, flag or in-memory counter: a restart with unchanged DB/Git state selects the same trigger, and
 * evaluating never consumes one. A trigger is "satisfied" only because history proves the relevant source state already
 * received that review.
 *
 * The selector never creates cycles, transitions the Goal, calls a provider, resolves a route, requests an approval or
 * touches findings; the supervisor hands the chosen trigger to the accepted `createReviewCycle`.
 *
 * Precedence when several are due (one review per tick): repeated_failure > scope_change > milestone > periodic > final
 * (`final` is only considered once no milestone remains).
 *
 * Definition boundary: every piece of history used for deduplication or counting is restricted to the CURRENT approved
 * definition version, so a review made under definition N never suppresses one required by N+1; the periodic interval,
 * the failure-episode and scope-source windows all restart at a new approved version.
 */

export type TriggerDetailValue = string | number | boolean | null;

export interface ReviewTrigger {
  kind: GoalReviewKind;
  triggerCode:
    'periodic_interval' | 'milestone_complete' | 'repeated_failure' | 'scope_change' | 'final_review';
  milestoneKey?: string;
  reviewedFromCommit: string | null;
  /** Bounded, finite facts (ids, counts, thresholds, a few paths). Never a diff or provider output. */
  detail: Record<string, TriggerDetailValue>;
}

export type TriggerSelection =
  | { ok: true; trigger: ReviewTrigger | null }
  /** The repository could not establish a trigger fact; the supervisor treats this as a Git-state block. */
  | { ok: false; code: 'review_trigger_unavailable' };

export const REVIEW_TRIGGER_LIMITS = { scopeCandidates: 8, pathSample: 3, pathChars: 120 } as const;

const WORK_KINDS = "('execution','remediation')";
const ATTEMPTED = "('succeeded','failed','rejected')";
const TERMINAL = "('succeeded','failed','cancelled','rejected')";

type TriggerBody = Omit<ReviewTrigger, 'reviewedFromCommit'>;

/** Sequence of the newest terminal review cycle of this kind under this definition version (0 when none). */
function lastReviewSequence(db: Db, goalId: string, version: number, kind: GoalReviewKind): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS s FROM goal_cycles
          WHERE goal_id = ? AND kind = 'review' AND definition_version = ? AND status IN ${TERMINAL}
            AND json_extract(outcome_json, '$.reviewPlan.reviewKind') = ?`,
      )
      .get(goalId, version, kind) as { s: number }
  ).s;
}

/** repeated_failure: the current failure streak's newest source cycle has not yet been followed by its review. */
export function repeatedFailureTrigger(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  version: number,
): TriggerBody | null {
  const policy = definition.review.onRepeatedFailure;
  if (!policy) return null;
  const runtime = db
    .prepare('SELECT consecutive_failed_cycles AS n FROM goal_runtime WHERE goal_id = ?')
    .get(goalId) as { n: number } | undefined;
  if (!runtime || runtime.n < policy.afterConsecutiveFailures) return null;
  const source = db
    .prepare(
      `SELECT id, sequence, status FROM goal_cycles
        WHERE goal_id = ? AND kind IN ${WORK_KINDS} AND status IN ${ATTEMPTED}
        ORDER BY sequence DESC LIMIT 1`,
    )
    .get(goalId) as { id: string; sequence: number; status: string } | undefined;
  // A streak always ends in a failed/rejected attempt; anything else means the counter is not describing history.
  if (!source || source.status === 'succeeded') return null;
  if (lastReviewSequence(db, goalId, version, 'repeated_failure') > source.sequence) return null;
  return {
    kind: 'repeated_failure',
    triggerCode: 'repeated_failure',
    detail: {
      sourceCycleId: source.id,
      sourceSequence: source.sequence,
      consecutiveFailures: runtime.n,
      threshold: policy.afterConsecutiveFailures,
    },
  };
}

/** periodic: N attempted work cycles under this definition since the last terminal periodic review. */
export function periodicTrigger(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  version: number,
): TriggerBody | null {
  const policy = definition.review.periodic;
  if (!policy) return null;
  const since = lastReviewSequence(db, goalId, version, 'periodic');
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM goal_cycles
          WHERE goal_id = ? AND kind IN ${WORK_KINDS} AND status IN ${ATTEMPTED}
            AND definition_version = ? AND sequence > ?`,
      )
      .get(goalId, version, since) as { n: number }
  ).n;
  if (count < policy.everyNExecutionCycles) return null;
  return {
    kind: 'periodic',
    triggerCode: 'periodic_interval',
    detail: { attemptedCycles: count, threshold: policy.everyNExecutionCycles, afterSequence: since },
  };
}

const CLEARED_BEFORE_REVIEW: ReadonlySet<MilestoneBlocker> = new Set<MilestoneBlocker>([
  'milestone_review_missing',
  'milestone_review_stale',
  'human_gate_missing',
]);

const currentReviewExists = (
  db: Db,
  goalId: string,
  version: number,
  tree: string,
  kind: 'milestone' | 'final',
  milestoneId?: string | null,
): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM goal_reviews
        WHERE goal_id = ? AND review_kind = ? AND status = 'completed' AND definition_version = ?
          AND reviewed_to_tree = ? AND (? IS NULL OR milestone_id = ?) LIMIT 1`,
    )
    .get(goalId, kind, version, tree, milestoneId ?? null, milestoneId ?? null);

/**
 * milestone: a milestone whose FRESH evaluation has only the review (and optionally the human completion gate) left, with
 * no completed review of it at this definition version and integration tree. The cached runtime status is not consulted.
 * One review satisfies both `onMilestoneComplete` and `reviewRequirements.milestoneReview`.
 */
export function milestoneTrigger(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  version: number,
  tree: string,
  evaluations: readonly MilestoneEvaluation[] | undefined,
): TriggerBody | null {
  if (!evaluations) return null;
  const byKey = new Map(evaluations.map((entry) => [entry.key, entry]));
  const settled = (key: string) => {
    const state = byKey.get(key)?.state;
    return state === 'satisfied' || state === 'skipped_by_user';
  };
  for (const spec of definition.milestones) {
    if (!definition.review.onMilestoneComplete && !spec.reviewRequirements.milestoneReview) continue;
    const evaluation = byKey.get(spec.key);
    if (!evaluation || evaluation.state === 'skipped_by_user') continue;
    if (!evaluation.blockers.every((blocker) => CLEARED_BEFORE_REVIEW.has(blocker))) continue;
    if (!spec.dependsOn.every(settled)) continue;
    if (currentReviewExists(db, goalId, version, tree, 'milestone', evaluation.milestoneId ?? 'none'))
      continue;
    return {
      kind: 'milestone',
      triggerCode: 'milestone_complete',
      milestoneKey: spec.key,
      detail: {
        milestoneKey: spec.key,
        requiredByMilestone: spec.reviewRequirements.milestoneReview,
        onMilestoneComplete: definition.review.onMilestoneComplete,
        humanGatePending: evaluation.blockers.includes('human_gate_missing'),
      },
    };
  }
  return null;
}

/** final: every milestone is done and no completed final review exists at this version and tree (any verdict). */
export function finalTrigger(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  version: number,
  tree: string,
): TriggerBody | null {
  if (!definition.review.final) return null;
  if (currentReviewExists(db, goalId, version, tree, 'final')) return null;
  return { kind: 'final', triggerCode: 'final_review', detail: { definitionVersion: version } };
}

/** Project-relative, forward-slash, no leading `./` or trailing `/`; null when the path is unusable as a baseline. */
function normalizeProjectPath(raw: string): string | null {
  const path = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').includes('..')) return null;
  return path;
}

/** Exact match, or a descendant of the expected entry by whole path components. Never substring containment. */
export function coveredByExpected(path: string, expected: readonly string[]): boolean {
  return expected.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/**
 * scope_change: the newest-first window of integrated work cycles after the last terminal scope_change review is
 * examined oldest-first; the first whose integrated change set has at least `pathsOutsideScopeAtLeast` paths outside the
 * planner's advisory `expectedPaths` (and, when configured, at least `diffLinesAtLeast` changed lines) is the source.
 * `expectedPaths` only ever feeds this advisory comparison; it grants and denies nothing.
 */
export async function scopeChangeTrigger(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  version: number,
  state: GoalRepositoryState,
): Promise<TriggerBody | null | 'unavailable'> {
  const policy = definition.review.onScopeChange;
  if (!policy) return null;
  const after = lastReviewSequence(db, goalId, version, 'scope_change');
  const candidates = (
    db
      .prepare(
        `SELECT c.id, c.sequence, c.base_integration_commit AS base, c.result_integration_commit AS result,
                c.validated_task_json AS task
           FROM goal_cycles c
          WHERE c.goal_id = ? AND c.kind IN ${WORK_KINDS} AND c.status = 'succeeded' AND c.definition_version = ?
            AND c.sequence > ? AND c.base_integration_commit IS NOT NULL AND c.result_integration_commit IS NOT NULL
            AND json_extract(c.outcome_json, '$.code') = 'integrated'
            AND EXISTS (SELECT 1 FROM goal_integration_ops o
                         WHERE o.goal_id = c.goal_id AND o.cycle_id = c.id AND o.op = 'advance'
                           AND o.status = 'applied' AND o.new_commit = c.result_integration_commit)
          ORDER BY c.sequence DESC LIMIT ?`,
      )
      .all(goalId, version, after, REVIEW_TRIGGER_LIMITS.scopeCandidates) as Array<{
      id: string;
      sequence: number;
      base: string;
      result: string;
      task: string | null;
    }>
  ).reverse();
  for (const cycle of candidates) {
    let expected: string[] = [];
    try {
      const raw = (JSON.parse(cycle.task ?? 'null') as { expectedPaths?: unknown } | null)?.expectedPaths;
      if (Array.isArray(raw))
        expected = raw
          .filter((entry): entry is string => typeof entry === 'string')
          .map(normalizeProjectPath)
          .filter((entry): entry is string => entry !== null);
    } catch {
      expected = [];
    }
    // No usable baseline: the planner predicted nothing, so nothing can be said to have drifted from it.
    if (expected.length === 0) continue;
    let paths: string[];
    try {
      paths = changedPathSet(await changedEntries(state.repoRoot, cycle.base, cycle.result));
    } catch {
      return 'unavailable';
    }
    const scopePrefix = state.scope ? `${state.scope}/` : '';
    const outside = paths
      .map((path) => (scopePrefix && path.startsWith(scopePrefix) ? path.slice(scopePrefix.length) : path))
      .filter((path) => !coveredByExpected(path, expected))
      .sort();
    if (outside.length < policy.pathsOutsideScopeAtLeast) continue;
    let lines: number | null = null;
    if (policy.diffLinesAtLeast !== undefined) {
      const counted = await diffLineCount(state.repoRoot, cycle.base, cycle.result);
      if (!counted.ok) return 'unavailable';
      if (!counted.capped && counted.lines < policy.diffLinesAtLeast) continue;
      lines = counted.lines;
    }
    return {
      kind: 'scope_change',
      triggerCode: 'scope_change',
      detail: {
        sourceCycleId: cycle.id,
        sourceSequence: cycle.sequence,
        outsidePathCount: outside.length,
        pathsOutsideScopeAtLeast: policy.pathsOutsideScopeAtLeast,
        diffLines: lines,
        diffLinesAtLeast: policy.diffLinesAtLeast ?? null,
        pathSample: outside
          .slice(0, REVIEW_TRIGGER_LIMITS.pathSample)
          .map((path) => path.slice(0, REVIEW_TRIGGER_LIMITS.pathChars))
          .join(', '),
      },
    };
  }
  return null;
}

/**
 * The single trigger due for a Goal with no active cycle, or none. Reads only; the one Git-backed fact (scope drift) is
 * a read-only object comparison. `includeFinal` is true only when no milestone remains.
 */
export async function determineReviewTrigger(
  db: Db,
  goalId: string,
  input: {
    definition: GoalDefinition;
    version: number;
    evaluations: readonly MilestoneEvaluation[] | undefined;
    includeFinal: boolean;
  },
): Promise<TriggerSelection> {
  const { definition, version } = input;
  const resolved = await resolveGoalRepository(db, goalId);
  if (!resolved.ok) return { ok: false, code: 'review_trigger_unavailable' };
  const { state } = resolved;
  const finish = async (body: TriggerBody): Promise<TriggerSelection> => ({
    ok: true,
    trigger: {
      ...body,
      reviewedFromCommit: await selectReviewRange(db, goalId, body.kind, { milestoneKey: body.milestoneKey }),
    },
  });
  const failure = repeatedFailureTrigger(db, goalId, definition, version);
  if (failure) return finish(failure);
  const scope = await scopeChangeTrigger(db, goalId, definition, version, state);
  if (scope === 'unavailable') return { ok: false, code: 'review_trigger_unavailable' };
  if (scope) return finish(scope);
  const milestone = milestoneTrigger(db, goalId, definition, version, state.tree, input.evaluations);
  if (milestone) return finish(milestone);
  const periodic = periodicTrigger(db, goalId, definition, version);
  if (periodic) return finish(periodic);
  if (input.includeFinal) {
    const final = finalTrigger(db, goalId, definition, version, state.tree);
    if (final) return finish(final);
  }
  return { ok: true, trigger: null };
}
