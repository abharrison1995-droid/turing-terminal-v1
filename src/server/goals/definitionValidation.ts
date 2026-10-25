import { z } from 'zod';
import {
  GOAL_LIMIT_MAXIMA,
  GOAL_ROLES,
  type GoalDefinition,
  type GoalEvidenceKind,
  type GoalRole,
  type RouteMember,
  type VerificationSpec,
} from '../../shared/goals.js';
import { isMeteredLane } from '../../shared/billing.js';
import { OPPORTUNITY_POOL_MEMBERS_CAP, opportunityBindingSchema } from '../../shared/opportunityContract.js';
import type { BillingMode, StageKind } from '../../shared/types.js';
import { isSafeProjectCommand } from '../commandPolicy.js';

export type IssueSeverity = 'error' | 'warning';

export interface DefinitionIssue {
  severity: IssueSeverity;
  /** Stable machine code. */
  code: string;
  /** Dotted field path into the definition, for example `milestones[1].dependsOn[0]`. */
  path: string;
  message: string;
}

export interface DefinitionValidation {
  valid: boolean;
  errors: DefinitionIssue[];
  warnings: DefinitionIssue[];
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BILLING_MODES = ['subscriptions-only', 'subscriptions-plus-decision-budget', 'custom'] as const;
const BILLING_LANES = [
  'opencode-go-subscription',
  'opencode-metered',
  'clinepass-subscription',
  'cline-usage-billing',
  'chatgpt-subscription',
  'claude-subscription',
  'openai-api',
  'anthropic-api',
  'openrouter-metered',
  'unknown',
] as const;
const EVIDENCE_KINDS = [
  'test_result',
  'build_result',
  'lint_result',
  'run_result',
  'commit',
  'review_verdict',
  'artifact',
  'user_confirmation',
] as const;

const text = z.string();
const flag = z.boolean();
const count = z.number();

const verification = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('build'), command: z.array(text).optional() }),
  z.strictObject({ kind: z.literal('test'), command: z.array(text).optional() }),
  z.strictObject({ kind: z.literal('lint'), command: z.array(text).optional() }),
  z.strictObject({ kind: z.literal('file_exists'), path: text }),
  z.strictObject({ kind: z.literal('review_verdict'), reviewKind: z.enum(['milestone', 'final']) }),
  z.strictObject({ kind: z.literal('commit_on_branch') }),
  z.strictObject({
    kind: z.literal('user_confirmation'),
    prompt: text,
    freshness: z.enum(['any', 'head-bound']),
  }),
]);

const modelConfiguration = z.strictObject({
  backendId: text.optional(),
  connectionProfileId: text.optional(),
  providerId: text.optional(),
  billingLane: z.enum(BILLING_LANES).optional(),
  modelId: text.optional(),
  modelDisplayName: text.optional(),
  variantId: text.optional(),
  reasoning: text.optional(),
  nativeSettings: z.record(z.string(), z.union([text, count, flag, z.null()])).optional(),
});

/** The one RouteMember shape: Goal definitions and the route-validation request both parse with it. */
export const routeMemberSchema = z.strictObject({
  configuration: modelConfiguration,
  identityKind: z.enum(['pinned', 'floating', 'unknown']).optional(),
  freshnessClass: z.enum(['stable-subscription', 'opportunity']),
  opportunity: opportunityBindingSchema.optional(),
});

const availability = z.enum(['live-catalog', 'fresh-validation', 'live-catalog-or-fresh-validation']);

const route = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pinned'),
    member: routeMemberSchema,
    availability,
    requireRoleValidation: flag,
  }),
  z.strictObject({ kind: z.literal('pool'), poolId: text }),
]);

const goalDefinitionSchema = z.strictObject({
  contract: z.strictObject({
    outcome: text,
    successCriteria: z.array(
      z.strictObject({
        key: text,
        statement: text,
        verification: z.array(verification),
        required: flag,
      }),
    ),
    nonGoals: z.array(text),
    constraints: z.array(text),
    deliverables: z.array(
      z.strictObject({
        key: text,
        description: text,
        path: text.optional(),
        criterionKeys: z.array(text),
      }),
    ),
    completionPolicy: z.strictObject({
      completionContractVersion: z.literal(2).optional(),
      integrationMode: z.literal('external_user_attested').optional(),
      requireFinalReview: flag,
      requireUserAcceptance: flag,
      applyToBase: z.enum(['required', 'leave-on-goal-branch']),
      maxOpenFindings: z.strictObject({
        critical: z.literal(0),
        high: z.literal(0),
        medium: count.optional(),
      }),
      highSeverityResolution: z.enum(['review-only', 'review-plus-head-bound-verifier']),
    }),
  }),
  milestones: z.array(
    z.strictObject({
      key: text,
      title: text,
      objective: text,
      criteria: z.array(text),
      dependsOn: z.array(text),
      allowedScope: z.strictObject({ includeGlobs: z.array(text), excludeGlobs: z.array(text) }),
      requiredEvidence: z.array(
        z.strictObject({ criterionKey: text, kinds: z.array(z.enum(EVIDENCE_KINDS)) }),
      ),
      reviewRequirements: z.strictObject({ milestoneReview: flag }),
    }),
  ),
  routing: z.strictObject({
    roles: z.strictObject(
      Object.fromEntries(GOAL_ROLES.map((role) => [role, route.optional()])) as Record<
        GoalRole,
        z.ZodOptional<typeof route>
      >,
    ),
    pools: z.array(
      z.strictObject({
        id: text,
        label: text,
        members: z.array(routeMemberSchema),
        admission: z.enum(['static', 'opportunity']),
        availability,
        requireRoleValidation: flag,
        selection: z.enum(['ordered', 'round_robin']),
        laneClass: z.enum(['subscription', 'permitted-by-billing-mode']),
        autoRevalidate: flag,
      }),
    ),
    workflows: z.strictObject({
      planning: text,
      execution: text,
      review: text,
      verification: text,
    }),
    independence: z.strictObject({
      finalReview: z.enum(['different-family', 'different-model', 'none']),
      against: z.array(z.enum(['implementer', 'remediation', 'orchestrator'])),
      allowFloatingFinalReviewer: flag,
    }),
  }),
  review: z.strictObject({
    periodic: z
      .strictObject({
        everyNExecutionCycles: count,
        reviewerCount: count,
        scope: z.enum(['since_last_review', 'full_diff']),
      })
      .optional(),
    onMilestoneComplete: flag,
    onRepeatedFailure: z.strictObject({ afterConsecutiveFailures: count }).optional(),
    onScopeChange: z
      .strictObject({ pathsOutsideScopeAtLeast: count, diffLinesAtLeast: count.optional() })
      .optional(),
    final: flag,
    blocking: z.strictObject({ periodic: flag, milestone: z.literal(true), final: z.literal(true) }),
  }),
  limits: z.strictObject({
    maxExecutionCycles: count,
    maxConsecutiveFailedCycles: count,
    maxRemediationAttempts: count,
    maxActiveMinutes: count,
    maxWallClockDays: count,
    maxParallelAgents: count,
    maxMeteredUsd: count.nullable(),
    billingMode: z.enum(BILLING_MODES),
    humanGates: z.strictObject({
      eachCycle: flag,
      beforeMilestoneComplete: flag,
      poolRouteFirstUse: flag,
      finalAcceptance: flag,
    }),
  }),
});

function formatPath(segments: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out;
}

const VERIFIER_EVIDENCE: Record<VerificationSpec['kind'], GoalEvidenceKind> = {
  build: 'build_result',
  test: 'test_result',
  lint: 'lint_result',
  file_exists: 'artifact',
  review_verdict: 'review_verdict',
  commit_on_branch: 'commit',
  user_confirmation: 'user_confirmation',
};

/** A project-relative path: no absolute, drive, home, parent traversal, NUL, backslash or repository metadata. */
function pathProblem(path: string): string | null {
  if (!path.trim()) return 'is empty';
  if (path.length > 256) return 'is longer than 256 characters';
  if (/[\0\\]/.test(path)) return 'contains a NUL or backslash';
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path))
    return 'is not project-relative';
  const segments = path.split('/');
  if (segments.includes('..')) return 'escapes the project with ..';
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return 'targets repository metadata';
  return null;
}

/** Scope globs additionally allow only a conservative glob alphabet with balanced brackets and braces. */
function globProblem(glob: string): { code: string; reason: string } | null {
  const reason = pathProblem(glob);
  if (reason)
    return {
      code: /escapes|not project-relative|metadata/.test(reason)
        ? 'scope.escapes_project'
        : 'scope.invalid_glob',
      reason,
    };
  if (!/^[A-Za-z0-9._\-/*?{},[\]@+]+$/.test(glob))
    return { code: 'scope.invalid_glob', reason: 'contains unsupported glob characters' };
  let braces = 0;
  let brackets = 0;
  for (const ch of glob) {
    if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
    if (braces < 0 || brackets < 0) break;
  }
  if (braces !== 0 || brackets !== 0)
    return { code: 'scope.invalid_glob', reason: 'has unbalanced brackets' };
  return null;
}

function isExplicitMember(member: RouteMember): boolean {
  const c = member.configuration;
  return Boolean(c.backendId && c.providerId && c.modelId && c.billingLane && c.billingLane !== 'unknown');
}

const MODE_RANK: Record<BillingMode, number> = {
  'subscriptions-only': 0,
  'subscriptions-plus-decision-budget': 1,
  custom: 2,
};

function memberIdentity(member: RouteMember): string {
  const c = member.configuration;
  return JSON.stringify([
    c.backendId,
    c.connectionProfileId,
    c.providerId,
    c.billingLane,
    c.modelId,
    c.variantId,
    c.reasoning,
    c.nativeSettings,
  ]);
}

/**
 * Pure structural and semantic validation of a Goal definition. Normal invalid input returns issues; it never throws.
 * No I/O, no live availability resolution, no database. Contextual checks that need registered workflows live in
 * `validateGoalDefinitionContext`.
 */
export function validateGoalDefinition(input: unknown): DefinitionValidation {
  const issues: DefinitionIssue[] = [];
  const add = (severity: IssueSeverity, code: string, path: string, message: string) =>
    issues.push({ severity, code, path, message });
  const error = (code: string, path: string, message: string) => add('error', code, path, message);
  const warn = (code: string, path: string, message: string) => add('warning', code, path, message);

  const parsed = goalDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const problem of parsed.error.issues)
      error('schema_invalid', formatPath(problem.path), problem.message);
    return finish(issues);
  }
  const def = parsed.data as unknown as GoalDefinition;
  const { contract, milestones, routing, review, limits } = def;

  // --- Contract
  if (!contract.outcome.trim())
    error('contract.outcome_empty', 'contract.outcome', 'The outcome must not be empty.');
  const criteria = new Map<string, number>();
  contract.successCriteria.forEach((criterion, index) => {
    const at = `contract.successCriteria[${index}]`;
    if (!KEY.test(criterion.key))
      error('criterion.key_invalid', `${at}.key`, 'Criterion keys are lowercase letters, digits, - and _.');
    if (criteria.has(criterion.key))
      error('criterion.duplicate_key', `${at}.key`, `Criterion key "${criterion.key}" is not unique.`);
    else criteria.set(criterion.key, index);
    if (!criterion.statement.trim())
      error('criterion.statement_empty', `${at}.statement`, 'Empty statement.');
    if (criterion.required && criterion.verification.length === 0)
      error(
        'criterion.no_verifier',
        `${at}.verification`,
        'A required criterion needs at least one verifier.',
      );
    if (
      criterion.verification.length > 0 &&
      criterion.verification.every((verifier) => verifier.kind === 'review_verdict')
    ) {
      if (criterion.required)
        error(
          'criterion.model_only_verification',
          `${at}.verification`,
          'A required criterion cannot be satisfied only by a model review verdict.',
        );
      else
        warn(
          'criterion.optional_model_only',
          `${at}.verification`,
          'Only a model verdict backs this criterion.',
        );
    }
    criterion.verification.forEach((verifier, vIndex) => {
      const vAt = `${at}.verification[${vIndex}]`;
      if (
        (verifier.kind === 'build' || verifier.kind === 'test' || verifier.kind === 'lint') &&
        verifier.command
      ) {
        if (!isSafeProjectCommand(verifier.command))
          error(
            'verification.unsafe_command',
            `${vAt}.command`,
            'The command is not an allowed project script.',
          );
        else if (verifier.command[2] !== verifier.kind)
          error(
            'verification.command_kind_mismatch',
            `${vAt}.command`,
            `A ${verifier.kind} verifier must run the "${verifier.kind}" script.`,
          );
      }
      if (verifier.kind === 'file_exists') {
        const problem = pathProblem(verifier.path);
        if (problem) error('verification.unsafe_path', `${vAt}.path`, `The path ${problem}.`);
      }
      if (verifier.kind === 'user_confirmation' && !verifier.prompt.trim())
        error('verification.prompt_empty', `${vAt}.prompt`, 'A user confirmation needs a prompt.');
      if (verifier.kind === 'review_verdict') {
        if (verifier.reviewKind === 'final' && !review.final)
          error(
            'review.verifier_without_review',
            vAt,
            'A final review verdict is required but final review is off.',
          );
        if (verifier.reviewKind === 'milestone' && !review.onMilestoneComplete)
          error(
            'review.verifier_without_review',
            vAt,
            'A milestone review verdict is required but milestone review is off.',
          );
      }
    });
  });
  if (contract.successCriteria.length === 0)
    error('criteria.none', 'contract.successCriteria', 'At least one success criterion is required.');
  if (!contract.successCriteria.some((criterion) => criterion.required))
    warn(
      'criteria.none_required',
      'contract.successCriteria',
      'No criterion is required; completion would be vacuous.',
    );

  const deliverableKeys = new Set<string>();
  contract.deliverables.forEach((deliverable, index) => {
    const at = `contract.deliverables[${index}]`;
    if (!KEY.test(deliverable.key)) error('deliverable.key_invalid', `${at}.key`, 'Invalid deliverable key.');
    if (deliverableKeys.has(deliverable.key))
      error('deliverable.duplicate_key', `${at}.key`, `Deliverable key "${deliverable.key}" is not unique.`);
    deliverableKeys.add(deliverable.key);
    if (deliverable.path !== undefined) {
      const problem = pathProblem(deliverable.path);
      if (problem) error('deliverable.unsafe_path', `${at}.path`, `The path ${problem}.`);
    }
    if (deliverable.criterionKeys.length === 0)
      warn('deliverable.unverified', `${at}.criterionKeys`, 'No criterion verifies this deliverable.');
    deliverable.criterionKeys.forEach((key, kIndex) => {
      if (!criteria.has(key))
        error(
          'deliverable.unknown_criterion',
          `${at}.criterionKeys[${kIndex}]`,
          `Unknown criterion "${key}".`,
        );
    });
  });

  const completion = contract.completionPolicy;
  const hasCompletionVersion = Object.hasOwn(completion, 'completionContractVersion');
  const hasIntegrationMode = Object.hasOwn(completion, 'integrationMode');
  if (hasCompletionVersion !== hasIntegrationMode) {
    error(
      'completion.versioned_policy_incomplete',
      'contract.completionPolicy',
      'Version 2 completion requires both completionContractVersion and integrationMode.',
    );
  } else if (hasCompletionVersion) {
    if (
      completion.completionContractVersion !== 2 ||
      completion.integrationMode !== 'external_user_attested' ||
      completion.applyToBase !== 'required' ||
      completion.requireFinalReview !== true ||
      completion.requireUserAcceptance !== true
    ) {
      error(
        'completion.versioned_policy_unsupported',
        'contract.completionPolicy',
        'Version 2 requires external_user_attested integration, base application, final review, and user acceptance.',
      );
    }
  }
  if (completion.maxOpenFindings.medium !== undefined) {
    const medium = completion.maxOpenFindings.medium;
    if (!Number.isInteger(medium) || medium < 0 || medium > 100)
      error(
        'completion.medium_findings_invalid',
        'contract.completionPolicy.maxOpenFindings.medium',
        'Must be an integer from 0 to 100.',
      );
  }
  if (completion.requireFinalReview && !review.final)
    error(
      'review.final_required',
      'review.final',
      'The completion policy requires a final review, but final review is off.',
    );
  if (!completion.requireFinalReview)
    warn(
      'completion.no_final_review',
      'contract.completionPolicy.requireFinalReview',
      'Completion will not require a final review.',
    );
  if (!completion.requireUserAcceptance)
    warn(
      'completion.no_user_acceptance',
      'contract.completionPolicy.requireUserAcceptance',
      'Completion will not require user acceptance.',
    );

  // --- Milestones
  if (milestones.length === 0) error('milestones.none', 'milestones', 'At least one milestone is required.');
  const milestoneIndex = new Map<string, number>();
  const owners = new Map<string, string[]>();
  milestones.forEach((milestone, index) => {
    const at = `milestones[${index}]`;
    if (!KEY.test(milestone.key)) error('milestone.key_invalid', `${at}.key`, 'Invalid milestone key.');
    if (milestoneIndex.has(milestone.key))
      error('milestone.duplicate_key', `${at}.key`, `Milestone key "${milestone.key}" is not unique.`);
    else milestoneIndex.set(milestone.key, index);
    if (!milestone.title.trim()) error('milestone.title_empty', `${at}.title`, 'Empty title.');
    if (!milestone.objective.trim())
      error('milestone.objective_empty', `${at}.objective`, 'Empty objective.');
    if (milestone.reviewRequirements.milestoneReview && !review.onMilestoneComplete)
      error(
        'review.milestone_review_disabled',
        `${at}.reviewRequirements.milestoneReview`,
        'The milestone requires a review but milestone review is off.',
      );
    milestone.criteria.forEach((key, cIndex) => {
      if (!criteria.has(key))
        error('milestone.unknown_criterion', `${at}.criteria[${cIndex}]`, `Unknown criterion "${key}".`);
      else owners.set(key, [...(owners.get(key) ?? []), milestone.key]);
    });
    const scope = milestone.allowedScope;
    if (scope.includeGlobs.length === 0)
      error(
        'scope.empty_include',
        `${at}.allowedScope.includeGlobs`,
        'A milestone needs at least one include glob; an empty scope would allow nothing.',
      );
    (['includeGlobs', 'excludeGlobs'] as const).forEach((listName) =>
      scope[listName].forEach((glob, gIndex) => {
        const problem = globProblem(glob);
        if (problem)
          error(problem.code, `${at}.allowedScope.${listName}[${gIndex}]`, `The glob ${problem.reason}.`);
      }),
    );
    milestone.requiredEvidence.forEach((requirement, rIndex) => {
      const rAt = `${at}.requiredEvidence[${rIndex}]`;
      const criterion = contract.successCriteria[criteria.get(requirement.criterionKey) ?? -1];
      if (!criterion) {
        error(
          'evidence.unknown_criterion',
          `${rAt}.criterionKey`,
          `Unknown criterion "${requirement.criterionKey}".`,
        );
        return;
      }
      if (!milestone.criteria.includes(requirement.criterionKey))
        error(
          'evidence.criterion_not_owned',
          `${rAt}.criterionKey`,
          'The milestone does not own this criterion.',
        );
      if (requirement.kinds.length === 0)
        error('evidence.no_kinds', `${rAt}.kinds`, 'Name at least one evidence kind.');
      const producible = new Set(criterion.verification.map((verifier) => VERIFIER_EVIDENCE[verifier.kind]));
      requirement.kinds.forEach((kind, kIndex) => {
        if (kind === 'run_result')
          warn(
            'evidence.run_result_informational',
            `${rAt}.kinds[${kIndex}]`,
            'A run result never satisfies a repository-behaviour criterion.',
          );
        else if (!producible.has(kind))
          error(
            'evidence.kind_without_verifier',
            `${rAt}.kinds[${kIndex}]`,
            `No verifier of "${requirement.criterionKey}" produces ${kind}.`,
          );
      });
    });
  });
  for (const [key, index] of criteria) {
    const criterion = contract.successCriteria[index]!;
    const owning = owners.get(key) ?? [];
    if (criterion.required && owning.length === 0)
      error(
        'criterion.unowned',
        `contract.successCriteria[${index}]`,
        `Required criterion "${key}" is owned by no milestone.`,
      );
    if (owning.length > 1)
      warn(
        'criterion.multiply_owned',
        `contract.successCriteria[${index}]`,
        `Criterion "${key}" is owned by several milestones.`,
      );
  }
  milestones.forEach((milestone, index) =>
    milestone.dependsOn.forEach((dependency, dIndex) => {
      const at = `milestones[${index}].dependsOn[${dIndex}]`;
      if (dependency === milestone.key)
        error('milestone.dependency_cycle', at, 'A milestone cannot depend on itself.');
      else if (!milestoneIndex.has(dependency))
        error('milestone.unknown_dependency', at, `Unknown milestone "${dependency}".`);
    }),
  );
  reportCycles(milestones, (path, message) => error('milestone.dependency_cycle', path, message));

  // --- Limits
  const limitFields = [
    'maxExecutionCycles',
    'maxConsecutiveFailedCycles',
    'maxRemediationAttempts',
    'maxActiveMinutes',
    'maxWallClockDays',
    'maxParallelAgents',
  ] as const;
  for (const field of limitFields) {
    const value = limits[field];
    const at = `limits.${field}`;
    if (!Number.isInteger(value)) error('limits.not_integer', at, 'Must be a whole number.');
    else if (value < 1)
      error(
        'limits.below_minimum',
        at,
        'Must be at least 1: an autonomous loop must be bounded and able to run.',
      );
    else if (value > GOAL_LIMIT_MAXIMA[field])
      error('limits.exceeds_maximum', at, `Exceeds the V1 maximum of ${GOAL_LIMIT_MAXIMA[field]}.`);
  }
  if (limits.maxConsecutiveFailedCycles > limits.maxExecutionCycles)
    warn(
      'limits.failure_bound_unreachable',
      'limits.maxConsecutiveFailedCycles',
      'The failure bound exceeds the cycle bound and can never trigger.',
    );
  if (limits.billingMode === 'subscriptions-only') {
    if (limits.maxMeteredUsd !== null)
      error(
        'limits.metered_cap_forbidden',
        'limits.maxMeteredUsd',
        'Subscriptions Only forbids metered lanes; the cap must be null.',
      );
  } else if (limits.maxMeteredUsd === null)
    error(
      'limits.metered_cap_required',
      'limits.maxMeteredUsd',
      'This billing mode can reach metered lanes and needs an explicit finite cap.',
    );
  if (limits.maxMeteredUsd !== null) {
    if (!(limits.maxMeteredUsd > 0))
      error('limits.below_minimum', 'limits.maxMeteredUsd', 'Must be greater than 0.');
    else if (limits.maxMeteredUsd > GOAL_LIMIT_MAXIMA.maxMeteredUsd)
      error(
        'limits.exceeds_maximum',
        'limits.maxMeteredUsd',
        `Exceeds the V1 maximum of ${GOAL_LIMIT_MAXIMA.maxMeteredUsd}.`,
      );
  }

  // --- Review policy
  if (review.periodic) {
    const { everyNExecutionCycles, reviewerCount } = review.periodic;
    if (
      !Number.isInteger(everyNExecutionCycles) ||
      everyNExecutionCycles < 1 ||
      everyNExecutionCycles > limits.maxExecutionCycles
    )
      error(
        'review.periodic_interval_invalid',
        'review.periodic.everyNExecutionCycles',
        'The interval must be a whole number from 1 to maxExecutionCycles.',
      );
    if (!Number.isInteger(reviewerCount) || reviewerCount < 1)
      error(
        'review.reviewer_count_invalid',
        'review.periodic.reviewerCount',
        'Reviewer count must be a positive whole number.',
      );
    else if (reviewerCount > limits.maxParallelAgents)
      error(
        'review.parallelism_exceeds_limit',
        'review.periodic.reviewerCount',
        'Reviewer count exceeds the Goal maxParallelAgents.',
      );
  }
  if (review.onRepeatedFailure) {
    const n = review.onRepeatedFailure.afterConsecutiveFailures;
    if (!Number.isInteger(n) || n < 1 || n >= limits.maxConsecutiveFailedCycles)
      error(
        'review.failure_threshold_invalid',
        'review.onRepeatedFailure.afterConsecutiveFailures',
        'Must be a whole number below maxConsecutiveFailedCycles.',
      );
  }
  if (review.onScopeChange) {
    const { pathsOutsideScopeAtLeast, diffLinesAtLeast } = review.onScopeChange;
    if (!Number.isInteger(pathsOutsideScopeAtLeast) || pathsOutsideScopeAtLeast < 1)
      error(
        'review.scope_threshold_invalid',
        'review.onScopeChange.pathsOutsideScopeAtLeast',
        'Must be a positive whole number.',
      );
    if (diffLinesAtLeast !== undefined && (!Number.isInteger(diffLinesAtLeast) || diffLinesAtLeast < 1))
      error(
        'review.scope_threshold_invalid',
        'review.onScopeChange.diffLinesAtLeast',
        'Must be a positive whole number.',
      );
  }

  // --- Routing
  const poolIds = new Map<string, number>();
  routing.pools.forEach((pool, index) => {
    const at = `routing.pools[${index}]`;
    if (!KEY.test(pool.id)) error('pool.id_invalid', `${at}.id`, 'Invalid pool id.');
    if (poolIds.has(pool.id)) error('pool.duplicate_id', `${at}.id`, `Pool id "${pool.id}" is not unique.`);
    else poolIds.set(pool.id, index);
    if (pool.autoRevalidate !== false)
      error(
        'pool.auto_revalidate_unsupported',
        `${at}.autoRevalidate`,
        'Automatic revalidation could spend allowance silently and is not supported.',
      );
    if (pool.members.length === 0) error('pool.empty', `${at}.members`, 'A pool needs at least one member.');
    if (pool.admission === 'opportunity' && pool.members.length > OPPORTUNITY_POOL_MEMBERS_CAP)
      error(
        'opportunity.pool_too_large',
        `${at}.members`,
        `An opportunity pool can have at most ${OPPORTUNITY_POOL_MEMBERS_CAP} members.`,
      );
    const seen = new Set<string>();
    pool.members.forEach((poolMember, mIndex) => {
      const mAt = `${at}.members[${mIndex}]`;
      checkMember(poolMember, mAt);
      if (pool.admission === 'opportunity') {
        if (!poolMember.opportunity)
          error(
            'opportunity.binding_required',
            `${mAt}.opportunity`,
            'An opportunity pool member needs an observation binding.',
          );
        if (poolMember.freshnessClass !== 'opportunity')
          error(
            'opportunity.freshness_class_required',
            `${mAt}.freshnessClass`,
            'An opportunity member must use opportunity freshness.',
          );
        if (poolMember.identityKind === 'unknown')
          error(
            'opportunity.identity_unknown',
            `${mAt}.identityKind`,
            'An opportunity member needs a known route identity.',
          );
      } else if (poolMember.opportunity) {
        error(
          'opportunity.binding_on_static_pool',
          `${mAt}.opportunity`,
          'Static pool members cannot carry opportunity evidence.',
        );
      }
      if (
        pool.laneClass === 'subscription' &&
        poolMember.configuration.billingLane &&
        isMeteredLane(poolMember.configuration.billingLane)
      )
        error(
          'pool.lane_class_violation',
          `${mAt}.configuration.billingLane`,
          'A subscription pool cannot contain a metered lane.',
        );
      const identity = memberIdentity(poolMember);
      if (seen.has(identity)) warn('pool.duplicate_member', mAt, 'This member duplicates an earlier one.');
      seen.add(identity);
    });
  });
  function checkMember(routeMember: RouteMember, at: string) {
    if (!isExplicitMember(routeMember))
      error(
        'route.member_not_explicit',
        `${at}.configuration`,
        'A route member needs an explicit backend, provider, model and a known billing lane.',
      );
    const lane = routeMember.configuration.billingLane;
    if (lane && limits.billingMode !== 'custom' && isMeteredLane(lane))
      error(
        'route.lane_not_permitted',
        `${at}.configuration.billingLane`,
        `The ${limits.billingMode} billing mode does not permit the ${lane} lane.`,
      );
  }
  for (const role of GOAL_ROLES) {
    const roleRoute = routing.roles[role];
    if (!roleRoute) continue;
    const at = `routing.roles.${role}`;
    if (roleRoute.kind === 'pool') {
      if (!poolIds.has(roleRoute.poolId))
        error('route.unknown_pool', `${at}.poolId`, `Unknown pool "${roleRoute.poolId}".`);
    } else {
      checkMember(roleRoute.member, `${at}.member`);
      if (roleRoute.member.opportunity)
        error(
          'opportunity.binding_on_pinned_route',
          `${at}.member.opportunity`,
          'Pinned routes cannot carry pool admission evidence.',
        );
      if (
        role === 'final_reviewer' &&
        routing.independence.finalReview !== 'none' &&
        !routing.independence.allowFloatingFinalReviewer &&
        roleRoute.member.identityKind !== 'pinned'
      )
        error(
          'independence.floating_final_reviewer',
          `${at}.member.identityKind`,
          'A final reviewer must be declared pinned unless floating reviewers are allowed.',
        );
    }
  }
  const needed: Array<[GoalRole, boolean]> = [
    ['orchestrator', true],
    ['implementer', true],
    ['routine_reviewer', review.periodic !== undefined],
    ['milestone_reviewer', review.onMilestoneComplete],
    ['final_reviewer', review.final],
  ];
  for (const [role, required] of needed)
    if (required && !routing.roles[role])
      error('routing.role_missing', `routing.roles.${role}`, `The ${role} role needs a route.`);
  (['planning', 'execution', 'review', 'verification'] as const).forEach((purpose) => {
    if (!routing.workflows[purpose].trim())
      error(
        'routing.workflow_missing',
        `routing.workflows.${purpose}`,
        `A ${purpose} workflow id is required.`,
      );
  });
  if (completion.requireFinalReview && routing.independence.finalReview === 'none')
    warn(
      'independence.none',
      'routing.independence.finalReview',
      'The final review has no independence requirement.',
    );

  return finish(issues);
}

function finish(issues: DefinitionIssue[]): DefinitionValidation {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return {
    valid: errors.length === 0,
    errors,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

/** Reports one error per distinct dependency cycle (iterative colouring over known milestones only). */
function reportCycles(
  milestones: GoalDefinition['milestones'],
  report: (path: string, message: string) => void,
): void {
  const byKey = new Map(milestones.map((milestone, index) => [milestone.key, index]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, trail: string[]): void => {
    state.set(key, 'visiting');
    const milestone = milestones[byKey.get(key)!]!;
    for (const dependency of milestone.dependsOn) {
      if (!byKey.has(dependency) || dependency === key) continue;
      if (state.get(dependency) === 'visiting') {
        const cycle = [...trail.slice(trail.indexOf(dependency)), dependency];
        report(`milestones[${byKey.get(dependency)}].dependsOn`, `Dependency cycle: ${cycle.join(' -> ')}.`);
      } else if (!state.has(dependency)) visit(dependency, [...trail, dependency]);
    }
    state.set(key, 'done');
  };
  for (const milestone of milestones)
    if (!state.has(milestone.key) && byKey.get(milestone.key) !== undefined)
      visit(milestone.key, [milestone.key]);
}

// ---------------------------------------------------------------------------------------------------------------

export interface WorkflowContext {
  id: string;
  billingMode: BillingMode;
  isolatedWorktree: boolean;
  maxParallelAgents: number;
  /** When supplied it is checked: `enigma` is never accepted for a Goal workflow. */
  permissionMode?: string;
  stages: Array<{ kind: StageKind }>;
}

const FORBIDDEN_STAGES: readonly StageKind[] = ['gitMerge', 'gitPush', 'gitRollback'];

/**
 * Checks that need registered workflows: every purpose resolves, runs in an isolated worktree, contains no stage that
 * can touch the user's branch, and the Goal never promises more billing authority than the workflows permit.
 * Deterministic and database-free: the caller supplies the workflows.
 */
export function validateGoalDefinitionContext(
  definition: GoalDefinition,
  workflows: readonly WorkflowContext[],
): DefinitionValidation {
  const issues: DefinitionIssue[] = [];
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  for (const purpose of ['planning', 'execution', 'review', 'verification'] as const) {
    const id = definition.routing.workflows[purpose];
    const at = `routing.workflows.${purpose}`;
    const workflow = byId.get(id);
    if (!workflow) {
      issues.push({
        severity: 'error',
        code: 'context.workflow_missing',
        path: at,
        message: `Workflow "${id}" does not exist.`,
      });
      continue;
    }
    if (!workflow.isolatedWorktree)
      issues.push({
        severity: 'error',
        code: 'context.workflow_not_isolated',
        path: at,
        message: 'Goal workflows must use an isolated worktree.',
      });
    if (workflow.stages.some((stage) => FORBIDDEN_STAGES.includes(stage.kind)))
      issues.push({
        severity: 'error',
        code: 'context.workflow_git_stage',
        path: at,
        message: 'Goal workflows cannot merge, push or roll back.',
      });
    if (workflow.permissionMode === 'enigma')
      issues.push({
        severity: 'error',
        code: 'context.workflow_enigma',
        path: at,
        message: 'Goal workflows cannot use ENIGMA permission mode.',
      });
    if (MODE_RANK[definition.limits.billingMode] > MODE_RANK[workflow.billingMode])
      issues.push({
        severity: 'error',
        code: 'context.billing_mode_exceeds_workflow',
        path: 'limits.billingMode',
        message: `The Goal billing mode is more permissive than workflow "${workflow.id}".`,
      });
    if (workflow.maxParallelAgents > definition.limits.maxParallelAgents)
      issues.push({
        severity: 'warning',
        code: 'context.workflow_parallelism_clamped',
        path: at,
        message: 'The workflow allows more parallel agents than the Goal; the Goal limit will clamp it.',
      });
  }
  const errors = issues.filter((issue) => issue.severity === 'error');
  return {
    valid: errors.length === 0,
    errors,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

export function mergeValidations(...results: DefinitionValidation[]): DefinitionValidation {
  const errors = results.flatMap((result) => result.errors);
  return { valid: errors.length === 0, errors, warnings: results.flatMap((result) => result.warnings) };
}
