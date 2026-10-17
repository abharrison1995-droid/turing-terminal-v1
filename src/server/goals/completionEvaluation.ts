import type {
  CompletionEvaluation,
  CompletionFailure,
  CriterionEvaluation,
  GoalDefinition,
  MilestoneEvaluation,
} from '../../shared/goals.js';
import type { Db } from '../db.js';
import { allowedOpenFindings, openFindingCounts } from './findings.js';
import { evaluateCriteria } from './freshness.js';
import { evaluateMilestones, userApprovals } from './milestones.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';
import { listReviews } from './reviews.js';
import { hasVerifiedAppliedFinalApplyOperation } from './finalApplyOperation.js';
import { readApprovedCompletionAuthority } from './approvedCompletionAuthority.js';

/**
 * Completion authority. This module is the only place a `CompletionEvaluation` can become proof: the registry below
 * and its `issueCompletionProof` are private (not exported), and the one caller is `evaluateCompletion`, after it has
 * run the real deterministic evaluation. `checkCompletionProof` accepts exactly the objects registered here, so a
 * hand-written literal, a spread, a `structuredClone` or a JSON round trip is rejected, and no other module can mint
 * one. Nothing a model emits can reach this registry.
 */
const issued = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function issueCompletionProof(evaluation: CompletionEvaluation): CompletionEvaluation {
  deepFreeze(evaluation);
  issued.add(evaluation);
  return evaluation;
}

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

function invalidCompletionAuthority(goalId: string, now: string, version: number): CompletionEvaluation {
  const evaluation = blank(goalId, now, {
    code: 'completion_policy_unsupported',
    detail: 'The approved definition integrity or completion-policy lineage could not be verified.',
  });
  evaluation.definitionVersion = version;
  evaluation.finalApply = {
    required: false,
    ok: false,
    basis: null,
    reason: 'completion_policy_unsupported',
  };
  return issueCompletionProof(evaluation);
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
  if (goal.current_definition_version === null)
    return issueCompletionProof(
      blank(goalId, now, {
        code: 'definition_not_approved',
        detail: 'The Goal has no approved current definition.',
      }),
    );

  // Do not classify a row as legacy until its approved hash and user-approval lineage have been re-proved. The
  // policy discriminator is part of approved content, not authority that can be trusted independently of its hash.
  const approvedAuthority = readApprovedCompletionAuthority(db, goalId, goal.current_definition_version);
  if (approvedAuthority.kind === 'not_approved')
    return issueCompletionProof(
      blank(goalId, now, {
        code: 'definition_not_approved',
        detail: 'The Goal has no approved current definition.',
      }),
    );
  if (approvedAuthority.kind === 'invalid') {
    return invalidCompletionAuthority(goalId, now, goal.current_definition_version);
  }
  const { version, lineage, parsedPolicy } = approvedAuthority;
  const { definition } = version;
  if (parsedPolicy.mode === 'external_user_attested_v2') {
    if (lineage.mode !== 'external_user_attested_v2') {
      const evaluation = blank(goalId, now, {
        code: 'completion_policy_unsupported',
        detail: 'The approved completion-policy lineage could not be verified.',
      });
      evaluation.definitionVersion = version.version;
      evaluation.definitionHash = version.definitionHash;
      evaluation.finalApply = {
        required: true,
        ok: false,
        basis: null,
        reason: 'completion_policy_unsupported',
      };
      return issueCompletionProof(evaluation);
    }
  }
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
  const limits = allowedOpenFindings(policy);
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
  if (parsedPolicy.mode === 'external_user_attested_v2') {
    finalApply = { required: true, ok: false, basis: null, reason: 'external_completion_not_activated' };
    failures.push({
      code: 'external_completion_not_activated',
      detail: 'Version 2 external-integration completion is not activated.',
    });
  } else if (policy.applyToBase !== 'required')
    finalApply = { required: false, ok: true, basis: 'not_required', reason: null };
  else {
    const applied = await hasVerifiedAppliedFinalApplyOperation(db, goalId, state.head, state.tree);
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

  if (failures.length === 0) {
    // Evidence and Git reads above may take time. Re-prove authority immediately before minting a positive in-memory
    // completion proof so changes made during evaluation cannot make that proof usable.
    const currentAuthority = readApprovedCompletionAuthority(db, goalId, version.version);
    if (
      currentAuthority.kind !== 'valid' ||
      currentAuthority.lineage.currentHash !== lineage.currentHash ||
      currentAuthority.lineage.currentApprovalId !== lineage.currentApprovalId ||
      currentAuthority.lineage.lineageDigest !== lineage.lineageDigest ||
      currentAuthority.lineage.mode !== lineage.mode
    )
      return invalidCompletionAuthority(goalId, now, version.version);
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

export type CompletionProofCheck =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'completion_proof_required'
        | 'completion_proof_failed'
        | 'completion_proof_stale'
        | 'external_completion_not_activated'
        | 'completion_policy_unsupported';
      message: string;
    };

/**
 * Checks, against the database as it is right now, that a proof was issued by `evaluateCompletion`, passed, belongs to
 * this Goal, and is still bound to the current definition version, its stored hash, and the integration head.
 */
export function checkCompletionProof(db: Db, goalId: string, proof: unknown): CompletionProofCheck {
  if (!proof || typeof proof !== 'object' || !issued.has(proof))
    return {
      ok: false,
      code: 'completion_proof_required',
      message: 'Completion needs a proof issued by evaluateCompletion.',
    };
  const evaluation = proof as CompletionEvaluation;
  if (evaluation.goalId !== goalId)
    return { ok: false, code: 'completion_proof_required', message: 'The proof belongs to another Goal.' };
  const row = db
    .prepare(
      `SELECT g.current_definition_version AS version, d.definition_hash AS hash, d.status AS status,
              r.integration_head AS head
       FROM goals g
       LEFT JOIN goal_definition_versions d ON d.goal_id = g.id AND d.version = g.current_definition_version
       LEFT JOIN goal_runtime r ON r.goal_id = g.id
       WHERE g.id = ?`,
    )
    .get(goalId) as
    | {
        version: number | null;
        hash: string | null;
        status: string | null;
        head: string | null;
      }
    | undefined;
  if (row?.status === 'approved' && row.version !== null) {
    const currentAuthority = readApprovedCompletionAuthority(db, goalId, row.version);
    if (currentAuthority.kind === 'invalid')
      return {
        ok: false,
        code: 'completion_policy_unsupported',
        message: 'The approved definition integrity or completion-policy lineage could not be verified.',
      };
    if (currentAuthority.kind === 'not_approved')
      return {
        ok: false,
        code: 'completion_proof_stale',
        message: 'The Goal no longer has the approved definition used by this evaluation.',
      };
    if (currentAuthority.lineage.currentHash !== row.hash)
      return {
        ok: false,
        code: 'completion_policy_unsupported',
        message: 'The approved definition integrity or completion-policy lineage could not be verified.',
      };
    if (currentAuthority.lineage.mode === 'external_user_attested_v2')
      return {
        ok: false,
        code: 'external_completion_not_activated',
        message: 'Version 2 external-integration completion is not activated.',
      };
  }
  if (!evaluation.ok)
    return { ok: false, code: 'completion_proof_failed', message: 'The completion evaluation did not pass.' };
  if (
    !row ||
    row.status !== 'approved' ||
    row.version !== evaluation.definitionVersion ||
    row.hash !== evaluation.definitionHash ||
    row.head !== evaluation.integrationHead
  )
    return {
      ok: false,
      code: 'completion_proof_stale',
      message: 'The definition or the integration head changed after the evaluation.',
    };
  return { ok: true };
}
