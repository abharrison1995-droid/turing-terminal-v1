import type {
  CompletionEvaluation,
  CompletionFailure,
  CriterionEvaluation,
  GoalDefinition,
  MilestoneEvaluation,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import { verifyGoalRef } from '../goalGit.js';
import { issueCompletionProof } from './completionProof.js';
import { loadDefinitionVersion } from './definitions.js';
import { writeGoalEvent } from './events.js';
import { openFindingCounts } from './findings.js';
import { evaluateCriteria } from './freshness.js';
import { evaluateMilestones, userApprovals } from './milestones.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';
import { listReviews } from './reviews.js';
import { transitionGoal } from './stateMachine.js';

const EMPTY_COUNTS = { critical: 0, high: 0, medium: 0, low: 0 };

function blank(goalId: string, now: string, failure: CompletionFailure): CompletionEvaluation {
  return {
    ok: false,
    goalId,
    definitionVersion: 0,
    definitionHash: '',
    integrationHead: '',
    integrationTree: '',
    evaluatedAt: now,
    criteria: [],
    milestones: [],
    findings: { open: { ...EMPTY_COUNTS }, limits: { critical: 0, high: 0, medium: null }, ok: false },
    finalReview: { required: false, ok: false, reviewId: null, reason: null },
    finalAcceptance: { required: false, ok: false, approvalId: null, reason: null },
    finalApply: { required: false, ok: false, basis: null, reason: null },
    failures: [failure],
  };
}

function finalReview(
  db: Db,
  goalId: string,
  definition: GoalDefinition,
  version: number,
  tree: string,
): CompletionEvaluation['finalReview'] {
  if (!definition.contract.completionPolicy.requireFinalReview)
    return { required: false, ok: true, reviewId: null, reason: null };
  const finals = listReviews(db, goalId)
    .filter((review) => review.reviewKind === 'final' && review.status === 'completed')
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''));
  const current = finals.filter(
    (review) => review.definitionVersion === version && review.reviewedToTree === tree,
  );
  if (current.length === 0)
    return {
      required: true,
      ok: false,
      reviewId: null,
      reason: finals.length === 0 ? 'final_review_missing' : 'final_review_stale',
    };
  const latest = current.at(-1)!;
  if (latest.verdict !== 'pass' || latest.blocking !== false)
    return { required: true, ok: false, reviewId: latest.id, reason: 'final_review_not_passing' };
  const policy = definition.routing.independence.finalReview;
  // Independence is only ever taken from the recorded payload; it is never inferred from model names.
  if (
    policy !== 'none' &&
    !(latest.independence?.established === true && latest.independence.policy === policy)
  )
    return { required: true, ok: false, reviewId: latest.id, reason: 'final_review_independence' };
  return { required: true, ok: true, reviewId: latest.id, reason: null };
}

/**
 * A deterministic evaluation of whether the Goal is complete, over persisted rows plus fresh Git reads at the verified
 * integration head. It changes nothing and never launches work: stale or missing evidence is simply reported. The
 * returned object is the only thing the `completed` transition accepts as authority.
 *
 * Conditions (design 6.2): every required current criterion satisfied by fresh evidence (criteria owned only by
 * user-skipped milestones excepted); every current milestone satisfied or explicitly user-skipped; open findings within
 * `maxOpenFindings`; a current, passing, independently established final review when required; a user
 * `final_acceptance` approval bound to the current definition and tree when required; and the final apply satisfied.
 */
export async function evaluateCompletion(
  db: Db,
  goalId: string,
  options: { now?: string } = {},
): Promise<CompletionEvaluation> {
  const now = options.now ?? new Date().toISOString();
  const goal = db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(goalId) as
    { current_definition_version: number | null } | undefined;
  if (!goal)
    return issueCompletionProof(
      blank(goalId, now, { code: 'goal_not_found', detail: 'The Goal does not exist.' }),
    );
  const version =
    goal.current_definition_version === null
      ? undefined
      : loadDefinitionVersion(db, goalId, goal.current_definition_version);
  if (!version || version.status !== 'approved')
    return issueCompletionProof(
      blank(goalId, now, {
        code: 'definition_not_approved',
        detail: 'The Goal has no approved current definition.',
      }),
    );
  const { definition } = version;
  const resolved = await resolveGoalRepository(db, goalId);
  if (!resolved.ok) {
    const evaluation = blank(goalId, now, { code: 'goal_ref_unavailable', detail: resolved.detail });
    evaluation.definitionVersion = version.version;
    evaluation.definitionHash = version.definitionHash;
    return issueCompletionProof(evaluation);
  }
  const { state } = resolved;
  const reader = createRepositoryReader(state);
  const failures: CompletionFailure[] = [];

  const criteria: CriterionEvaluation[] = await evaluateCriteria(db, goalId, definition, reader);
  const milestones: MilestoneEvaluation[] = evaluateMilestones(db, {
    goalId,
    definitionVersion: version.version,
    definitionHash: version.definitionHash,
    definition,
    integrationTree: state.tree,
    criteria,
  });

  // A criterion owned only by milestones the user explicitly skipped no longer gates completion.
  const skipped = new Set(
    milestones.filter((milestone) => milestone.state === 'skipped_by_user').map((milestone) => milestone.key),
  );
  const exempt = (criterionKey: string) => {
    const owners = definition.milestones.filter((spec) => spec.criteria.includes(criterionKey));
    return owners.length > 0 && owners.every((owner) => skipped.has(owner.key));
  };
  for (const criterion of criteria)
    if (criterion.required && criterion.state !== 'satisfied' && !exempt(criterion.key))
      failures.push({
        code: 'criterion_unsatisfied',
        subject: criterion.key,
        detail: `Criterion "${criterion.key}" is ${criterion.state}.`,
      });
  for (const milestone of milestones)
    if (milestone.state === 'unsatisfied')
      failures.push({
        code: 'milestone_unsatisfied',
        subject: milestone.key,
        detail: `Milestone "${milestone.key}" is blocked by ${milestone.blockers.join(', ')}.`,
      });

  const policy = definition.contract.completionPolicy;
  const open = openFindingCounts(db, goalId);
  const limits = {
    critical: policy.maxOpenFindings.critical,
    high: policy.maxOpenFindings.high,
    medium: policy.maxOpenFindings.medium ?? null,
  };
  let findingsOk = true;
  for (const severity of ['critical', 'high', 'medium'] as const) {
    const limit = limits[severity];
    if (limit !== null && open[severity] > limit) {
      findingsOk = false;
      failures.push({
        code: 'findings_over_threshold',
        subject: severity,
        detail: `${open[severity]} open ${severity} finding(s); at most ${limit} allowed.`,
      });
    }
  }

  const review = finalReview(db, goalId, definition, version.version, state.tree);
  if (!review.ok)
    failures.push({
      code: review.reason as CompletionFailure['code'],
      detail: `The final review requirement is not met (${review.reason}).`,
    });

  const acceptanceRequired = policy.requireUserAcceptance || definition.limits.humanGates.finalAcceptance;
  let finalAcceptance: CompletionEvaluation['finalAcceptance'] = {
    required: acceptanceRequired,
    ok: true,
    approvalId: null,
    reason: null,
  };
  if (acceptanceRequired) {
    const approvals = userApprovals(db, goalId, 'final_acceptance');
    const match = approvals.find(
      (approval) =>
        approval.detail.definitionVersion === version.version &&
        approval.detail.definitionHash === version.definitionHash &&
        approval.detail.integrationTree === state.tree,
    );
    finalAcceptance = match
      ? { required: true, ok: true, approvalId: match.id, reason: null }
      : {
          required: true,
          ok: false,
          approvalId: null,
          reason: approvals.length > 0 ? 'bound_to_other_definition_or_tree' : 'no_approval',
        };
    if (!match)
      failures.push({
        code: 'final_acceptance_missing',
        detail: `Final user acceptance is ${finalAcceptance.reason}.`,
      });
  }

  let finalApply: CompletionEvaluation['finalApply'];
  if (policy.applyToBase !== 'required')
    finalApply = { required: false, ok: true, basis: 'not_required', reason: null };
  else {
    const applied = db
      .prepare(
        "SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base' AND status = 'applied' AND new_commit = ?",
      )
      .get(goalId, state.head);
    const attested = userApprovals(db, goalId, 'final_apply').find(
      (approval) =>
        approval.detail.action === 'applied_externally' &&
        approval.detail.definitionVersion === version.version &&
        approval.detail.definitionHash === version.definitionHash &&
        approval.detail.integrationHead === state.head,
    );
    if (applied) finalApply = { required: true, ok: true, basis: 'applied_by_turing', reason: null };
    else if (attested) finalApply = { required: true, ok: true, basis: 'applied_externally', reason: null };
    else {
      finalApply = { required: true, ok: false, basis: null, reason: 'not_applied' };
      failures.push({
        code: 'final_apply_required',
        detail: 'The result must be applied to the base branch (or attested as applied externally).',
      });
    }
  }

  return issueCompletionProof({
    ok: failures.length === 0,
    goalId,
    definitionVersion: version.version,
    definitionHash: version.definitionHash,
    integrationHead: state.head,
    integrationTree: state.tree,
    evaluatedAt: now,
    criteria,
    milestones,
    findings: { open, limits, ok: findingsOk },
    finalReview: review,
    finalAcceptance,
    finalApply,
    failures,
  });
}

/** Records a bounded `completion_evaluated` event for an evaluation. The evaluation itself changes no state. */
export function recordCompletionEvaluation(db: Db, evaluation: CompletionEvaluation, now?: string): void {
  writeGoalEvent(
    db,
    evaluation.goalId,
    'completion_evaluated',
    {
      ok: evaluation.ok,
      definitionVersion: evaluation.definitionVersion,
      definitionHash: evaluation.definitionHash,
      integrationHead: evaluation.integrationHead,
      integrationTree: evaluation.integrationTree,
      failureCodes: [...new Set(evaluation.failures.map((failure) => failure.code))].slice(0, 20),
    },
    now ?? evaluation.evaluatedAt,
  );
}

/**
 * Evaluates and, only if every condition holds, performs the `running -> completed` transition with the evaluation as
 * proof. The transition re-reads the definition version, its stored hash and the integration head and refuses a stale
 * proof; the Goal ref is also re-verified immediately before. A model has no path to this function.
 */
export async function completeGoal(
  db: Db,
  goalId: string,
  options: { now?: string } = {},
): Promise<{ completed: boolean; evaluation: CompletionEvaluation }> {
  const evaluation = await evaluateCompletion(db, goalId, options);
  if (!evaluation.ok) {
    recordCompletionEvaluation(db, evaluation, options.now);
    return { completed: false, evaluation };
  }
  const verification = await verifyGoalRef(db, goalId);
  if (!verification.ok || verification.head !== evaluation.integrationHead) {
    recordCompletionEvaluation(db, evaluation, options.now);
    return { completed: false, evaluation };
  }
  db.transaction(() => {
    recordCompletionEvaluation(db, evaluation, options.now);
    transitionGoal(db, {
      goalId,
      to: 'completed',
      reasonCode: 'completion_verified',
      actor: 'supervisor',
      completionProof: evaluation,
      now: options.now,
    });
  })();
  return { completed: true, evaluation };
}
