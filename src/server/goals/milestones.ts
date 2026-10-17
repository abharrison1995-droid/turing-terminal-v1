import type {
  CriterionEvaluation,
  GoalDefinition,
  MilestoneBlocker,
  MilestoneEvaluation,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import { writeGoalEvent } from './events.js';

interface UserApproval {
  id: string;
  detail: Record<string, unknown>;
}

/** Approved, user-decided Goal approvals for a gate, oldest first. Only these carry user authority. */
export function userApprovals(db: Db, goalId: string, gate: string): UserApproval[] {
  return (
    db
      .prepare(
        `SELECT id, detail_json FROM goal_approvals
         WHERE goal_id = ? AND gate = ? AND status = 'approved' AND decided_by = 'user' ORDER BY created_at, rowid`,
      )
      .all(goalId, gate) as Array<{ id: string; detail_json: string }>
  ).map((row) => ({ id: row.id, detail: JSON.parse(row.detail_json) as Record<string, unknown> }));
}

interface ReviewLookup {
  definition_version: number;
  reviewed_to_tree: string;
  verdict: string;
  blocking: number;
}

/**
 * Evaluates the milestones of the CURRENT approved definition only (removed historical milestones never count), from
 * current criteria evaluations, never from a stored `goal_milestones.status`. A milestone is satisfied when all of its
 * required criteria are satisfied, each `requiredEvidence` kind backs its criterion, any required milestone review is
 * current and passing, and any configured human gate is satisfied. A user skip needs an approved user
 * `milestone_complete` approval with action `skip`, bound to the milestone key and the current definition version and
 * hash; a `skipped` runtime row alone is not authority.
 */
export function evaluateMilestones(
  db: Db,
  input: {
    goalId: string;
    definitionVersion: number;
    definitionHash: string;
    definition: GoalDefinition;
    integrationTree: string;
    criteria: readonly CriterionEvaluation[];
  },
): MilestoneEvaluation[] {
  const { definition } = input;
  const approvals = userApprovals(db, input.goalId, 'milestone_complete');
  const bound = (action: string, key: string) =>
    approvals.find(
      (approval) =>
        approval.detail.action === action &&
        approval.detail.milestoneKey === key &&
        approval.detail.definitionVersion === input.definitionVersion &&
        approval.detail.definitionHash === input.definitionHash,
    );
  const byKey = new Map(input.criteria.map((criterion) => [criterion.key, criterion]));
  return definition.milestones.map((spec) => {
    const row = db
      .prepare('SELECT id FROM goal_milestones WHERE goal_id = ? AND milestone_key = ?')
      .get(input.goalId, spec.key) as { id: string } | undefined;
    const criteria = spec.criteria.map((key) => ({
      key,
      state: byKey.get(key)?.state ?? ('missing' as const),
    }));
    const skip = bound('skip', spec.key);
    if (skip)
      return {
        key: spec.key,
        milestoneId: row?.id ?? null,
        state: 'skipped_by_user' as const,
        blockers: [],
        skipApprovalId: skip.id,
        criteria,
      };

    const blockers: MilestoneBlocker[] = [];
    const owned = spec.criteria
      .map((key) => byKey.get(key))
      .filter((criterion): criterion is CriterionEvaluation => criterion !== undefined);
    if (owned.some((criterion) => criterion.required && criterion.state !== 'satisfied'))
      blockers.push('criteria_unsatisfied');
    for (const requirement of spec.requiredEvidence) {
      const criterion = byKey.get(requirement.criterionKey);
      const kinds = new Set(
        criterion?.verifiers
          .filter((verifier) => verifier.state === 'satisfied' && verifier.decidingKind)
          .map((verifier) => verifier.decidingKind),
      );
      if (!criterion || !requirement.kinds.every((kind) => kinds.has(kind))) {
        blockers.push('required_evidence_missing');
        break;
      }
    }
    if (spec.reviewRequirements.milestoneReview) {
      const reviews = row
        ? (db
            .prepare(
              `SELECT definition_version, reviewed_to_tree, verdict, blocking FROM goal_reviews
               WHERE goal_id = ? AND milestone_id = ? AND review_kind = 'milestone' AND status = 'completed'
               ORDER BY completed_at, rowid`,
            )
            .all(input.goalId, row.id) as ReviewLookup[])
        : [];
      const atVersion = reviews.filter((review) => review.definition_version === input.definitionVersion);
      const atTree = atVersion.filter((review) => review.reviewed_to_tree === input.integrationTree);
      if (atTree.length === 0)
        blockers.push(reviews.length === 0 ? 'milestone_review_missing' : 'milestone_review_stale');
      else {
        const latest = atTree.at(-1)!;
        if (latest.verdict === 'block' || latest.blocking === 1)
          blockers.push('milestone_review_not_passing');
      }
    }
    if (definition.limits.humanGates.beforeMilestoneComplete && !bound('complete', spec.key))
      blockers.push('human_gate_missing');
    return {
      key: spec.key,
      milestoneId: row?.id ?? null,
      state: blockers.length === 0 ? ('satisfied' as const) : ('unsatisfied' as const),
      blockers,
      skipApprovalId: null,
      criteria,
    };
  });
}

/**
 * Brings the runtime `goal_milestones.status` in line with a fresh evaluation: a newly satisfied milestone becomes
 * `satisfied` (event `milestone_satisfied`); a milestone recorded satisfied whose current evidence no longer holds goes
 * back to `pending`. Removed or user-skipped rows are left alone. Never consulted by completion.
 */
export function syncMilestoneRuntime(
  db: Db,
  input: {
    goalId: string;
    definitionVersion: number;
    milestones: readonly MilestoneEvaluation[];
    now?: string;
  },
): { satisfied: string[]; reopened: string[] } {
  const now = input.now ?? new Date().toISOString();
  const result = { satisfied: [] as string[], reopened: [] as string[] };
  db.transaction(() => {
    for (const milestone of input.milestones) {
      if (!milestone.milestoneId || milestone.state === 'skipped_by_user') continue;
      const row = db.prepare('SELECT status FROM goal_milestones WHERE id = ?').get(milestone.milestoneId) as
        { status: string } | undefined;
      if (!row || row.status === 'skipped') continue;
      if (milestone.state === 'satisfied' && row.status !== 'satisfied') {
        db.prepare("UPDATE goal_milestones SET status = 'satisfied', satisfied_at = ? WHERE id = ?").run(
          now,
          milestone.milestoneId,
        );
        writeGoalEvent(
          db,
          input.goalId,
          'milestone_satisfied',
          { milestoneKey: milestone.key, definitionVersion: input.definitionVersion },
          now,
        );
        result.satisfied.push(milestone.key);
      } else if (milestone.state === 'unsatisfied' && row.status === 'satisfied') {
        db.prepare("UPDATE goal_milestones SET status = 'pending', satisfied_at = NULL WHERE id = ?").run(
          milestone.milestoneId,
        );
        result.reopened.push(milestone.key);
      }
    }
  })();
  return result;
}
