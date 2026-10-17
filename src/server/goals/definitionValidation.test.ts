import { describe, expect, it } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import {
  mergeValidations,
  validateGoalDefinition,
  validateGoalDefinitionContext,
  type WorkflowContext,
} from './definitionValidation.js';
import { validDefinition } from './testKit.js';

type Mutation = (d: GoalDefinition) => void;
const bad = (build: Mutation) => {
  const definition = validDefinition();
  build(definition);
  return validateGoalDefinition(definition);
};
const metered = {
  backendId: 'openrouter',
  providerId: 'openrouter',
  billingLane: 'openrouter-metered' as const,
  modelId: 'm',
};

describe('validateGoalDefinition', () => {
  it('accepts the reference definition without errors', () => {
    const result = validateGoalDefinition(validDefinition());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('never throws on malformed input and reports schema issues with a path', () => {
    for (const input of [null, undefined, 42, 'x', [], {}, { contract: 1 }]) {
      const result = validateGoalDefinition(input);
      expect(result.valid).toBe(false);
      expect(result.errors.every((issue) => issue.code === 'schema_invalid')).toBe(true);
    }
    const result = bad((d) => ((d.limits as unknown as Record<string, unknown>).maxExecutionCycles = 'many'));
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'schema_invalid', path: 'limits.maxExecutionCycles' }),
    );
  });

  it('rejects unknown keys so nothing unvalidated reaches the hash', () => {
    const result = bad((d) => ((d.contract as unknown as Record<string, unknown>).sneaky = true));
    expect(result.errors[0]).toMatchObject({ code: 'schema_invalid' });
  });

  const errorCases: Array<[string, string, string, Mutation]> = [
    ['empty outcome', 'contract.outcome_empty', 'contract.outcome', (d) => (d.contract.outcome = '  ')],
    [
      'duplicate criterion key',
      'criterion.duplicate_key',
      'contract.successCriteria[1].key',
      (d) => (d.contract.successCriteria[1]!.key = 'builds'),
    ],
    [
      'invalid criterion key',
      'criterion.key_invalid',
      'contract.successCriteria[0].key',
      (d) => (d.contract.successCriteria[0]!.key = 'Not Valid!'),
    ],
    [
      'no criteria',
      'criteria.none',
      'contract.successCriteria',
      (d) => {
        d.contract.successCriteria = [];
        d.contract.deliverables = [];
        d.milestones.forEach((m) => {
          m.criteria = [];
          m.requiredEvidence = [];
        });
      },
    ],
    [
      'required criterion without a verifier',
      'criterion.no_verifier',
      'contract.successCriteria[0].verification',
      (d) => {
        d.contract.successCriteria[0]!.verification = [];
        d.milestones[0]!.requiredEvidence = [];
      },
    ],
    [
      'required criterion satisfied only by a model verdict',
      'criterion.model_only_verification',
      'contract.successCriteria[0].verification',
      (d) => {
        d.contract.successCriteria[0]!.verification = [{ kind: 'review_verdict', reviewKind: 'final' }];
        d.milestones[0]!.requiredEvidence = [{ criterionKey: 'builds', kinds: ['review_verdict'] }];
      },
    ],
    [
      'unsafe verification command',
      'verification.unsafe_command',
      'contract.successCriteria[0].verification[0].command',
      (d) =>
        (d.contract.successCriteria[0]!.verification[0] = {
          kind: 'build',
          command: ['sh', '-c', 'rm -rf /'],
        }),
    ],
    [
      'safe command for the wrong kind',
      'verification.command_kind_mismatch',
      'contract.successCriteria[0].verification[0].command',
      (d) =>
        (d.contract.successCriteria[0]!.verification[0] = { kind: 'build', command: ['npm', 'run', 'test'] }),
    ],
    [
      'file_exists path escaping the project',
      'verification.unsafe_path',
      'contract.successCriteria[0].verification[1].path',
      (d) => {
        d.contract.successCriteria[0]!.verification.push({ kind: 'file_exists', path: '../secret' });
        d.milestones[0]!.requiredEvidence = [];
      },
    ],
    [
      'final verdict verifier without a final review',
      'review.verifier_without_review',
      'contract.successCriteria[1].verification[1]',
      (d) => {
        d.review.final = false;
        d.contract.completionPolicy.requireFinalReview = false;
        d.routing.roles.final_reviewer = undefined;
      },
    ],
    [
      'deliverable with an unknown criterion',
      'deliverable.unknown_criterion',
      'contract.deliverables[0].criterionKeys[0]',
      (d) => (d.contract.deliverables[0]!.criterionKeys = ['ghost']),
    ],
    [
      'duplicate deliverable key',
      'deliverable.duplicate_key',
      'contract.deliverables[1].key',
      (d) => d.contract.deliverables.push({ key: 'parser', description: 'again', criterionKeys: ['tests'] }),
    ],
    [
      'deliverable path escaping the project',
      'deliverable.unsafe_path',
      'contract.deliverables[0].path',
      (d) => (d.contract.deliverables[0]!.path = '/etc/passwd'),
    ],
    [
      'final review required but off',
      'review.final_required',
      'review.final',
      (d) => {
        d.review.final = false;
        d.contract.successCriteria[1]!.verification = [{ kind: 'test' }];
        d.milestones[1]!.requiredEvidence = [{ criterionKey: 'tests', kinds: ['test_result'] }];
        d.routing.roles.final_reviewer = undefined;
      },
    ],
    ['no milestones', 'milestones.none', 'milestones', (d) => (d.milestones = [])],
    [
      'duplicate milestone key',
      'milestone.duplicate_key',
      'milestones[1].key',
      (d) => (d.milestones[1]!.key = 'core'),
    ],
    [
      'milestone referencing a missing criterion',
      'milestone.unknown_criterion',
      'milestones[0].criteria[1]',
      (d) => d.milestones[0]!.criteria.push('ghost'),
    ],
    [
      'unknown dependency',
      'milestone.unknown_dependency',
      'milestones[1].dependsOn[0]',
      (d) => (d.milestones[1]!.dependsOn = ['ghost']),
    ],
    [
      'self dependency',
      'milestone.dependency_cycle',
      'milestones[0].dependsOn[0]',
      (d) => (d.milestones[0]!.dependsOn = ['core']),
    ],
    [
      'cyclic milestone graph',
      'milestone.dependency_cycle',
      'milestones[0].dependsOn',
      (d) => (d.milestones[0]!.dependsOn = ['polish']),
    ],
    [
      'required criterion owned by no milestone',
      'criterion.unowned',
      'contract.successCriteria[1]',
      (d) => {
        d.milestones[1]!.criteria = [];
        d.milestones[1]!.requiredEvidence = [];
      },
    ],
    [
      'scope that escapes the project',
      'scope.escapes_project',
      'milestones[0].allowedScope.includeGlobs[0]',
      (d) => (d.milestones[0]!.allowedScope.includeGlobs = ['../**']),
    ],
    [
      'absolute scope',
      'scope.escapes_project',
      'milestones[0].allowedScope.includeGlobs[0]',
      (d) => (d.milestones[0]!.allowedScope.includeGlobs = ['/etc/**']),
    ],
    [
      'scope into repository metadata',
      'scope.escapes_project',
      'milestones[0].allowedScope.includeGlobs[0]',
      (d) => (d.milestones[0]!.allowedScope.includeGlobs = ['.git/**']),
    ],
    [
      'invalid glob syntax',
      'scope.invalid_glob',
      'milestones[0].allowedScope.excludeGlobs[0]',
      (d) => (d.milestones[0]!.allowedScope.excludeGlobs = ['src/{a,b']),
    ],
    [
      'unsupported glob characters',
      'scope.invalid_glob',
      'milestones[0].allowedScope.includeGlobs[0]',
      (d) => (d.milestones[0]!.allowedScope.includeGlobs = ['!src/**']),
    ],
    [
      'empty include scope',
      'scope.empty_include',
      'milestones[0].allowedScope.includeGlobs',
      (d) => (d.milestones[0]!.allowedScope.includeGlobs = []),
    ],
    [
      'evidence kind no verifier produces',
      'evidence.kind_without_verifier',
      'milestones[0].requiredEvidence[0].kinds[0]',
      (d) => (d.milestones[0]!.requiredEvidence = [{ criterionKey: 'builds', kinds: ['test_result'] }]),
    ],
    [
      'milestone review required while milestone review is off',
      'review.milestone_review_disabled',
      'milestones[0].reviewRequirements.milestoneReview',
      (d) => {
        d.review.onMilestoneComplete = false;
        d.routing.roles.milestone_reviewer = undefined;
      },
    ],
    [
      'duplicate pool id',
      'pool.duplicate_id',
      'routing.pools[1].id',
      (d) => d.routing.pools.push({ ...structuredClone(d.routing.pools[0]!) }),
    ],
    [
      'role referencing an unknown pool',
      'route.unknown_pool',
      'routing.roles.routine_reviewer.poolId',
      (d) => (d.routing.roles.routine_reviewer = { kind: 'pool', poolId: 'ghost' }),
    ],
    [
      'opportunity pool before the Opportunity Layer',
      'pool.opportunity_unsupported',
      'routing.pools[0].admission',
      (d) => (d.routing.pools[0]!.admission = 'opportunity'),
    ],
    [
      'automatic revalidation',
      'pool.auto_revalidate_unsupported',
      'routing.pools[0].autoRevalidate',
      (d) => ((d.routing.pools[0] as unknown as Record<string, unknown>).autoRevalidate = true),
    ],
    ['empty pool', 'pool.empty', 'routing.pools[0].members', (d) => (d.routing.pools[0]!.members = [])],
    [
      'pool member without an explicit configuration',
      'route.member_not_explicit',
      'routing.pools[0].members[0].configuration',
      (d) => (d.routing.pools[0]!.members[0]!.configuration = { modelId: 'x' }),
    ],
    [
      'unknown billing lane on a member',
      'route.member_not_explicit',
      'routing.pools[0].members[1].configuration',
      (d) => (d.routing.pools[0]!.members[1]!.configuration.billingLane = 'unknown'),
    ],
    [
      'metered lane under Subscriptions Only',
      'route.lane_not_permitted',
      'routing.pools[0].members[0].configuration.billingLane',
      (d) => {
        d.routing.pools[0]!.laneClass = 'permitted-by-billing-mode';
        d.routing.pools[0]!.members[0]!.configuration = { ...metered };
      },
    ],
    [
      'metered lane inside a subscription pool',
      'pool.lane_class_violation',
      'routing.pools[0].members[0].configuration.billingLane',
      (d) => {
        d.limits.billingMode = 'custom';
        d.limits.maxMeteredUsd = 5;
        d.routing.pools[0]!.members[0]!.configuration = { ...metered };
      },
    ],
    [
      'missing implementer route',
      'routing.role_missing',
      'routing.roles.implementer',
      (d) => (d.routing.roles.implementer = undefined),
    ],
    [
      'floating final reviewer',
      'independence.floating_final_reviewer',
      'routing.roles.final_reviewer.member.identityKind',
      (d) => {
        const route = d.routing.roles.final_reviewer;
        if (route?.kind === 'pinned') route.member.identityKind = 'floating';
      },
    ],
    [
      'blank workflow id',
      'routing.workflow_missing',
      'routing.workflows.review',
      (d) => (d.routing.workflows.review = ' '),
    ],
    [
      'periodic interval of zero',
      'review.periodic_interval_invalid',
      'review.periodic.everyNExecutionCycles',
      (d) => (d.review.periodic!.everyNExecutionCycles = 0),
    ],
    [
      'periodic interval beyond the cycle bound',
      'review.periodic_interval_invalid',
      'review.periodic.everyNExecutionCycles',
      (d) => (d.review.periodic!.everyNExecutionCycles = 21),
    ],
    [
      'zero reviewers',
      'review.reviewer_count_invalid',
      'review.periodic.reviewerCount',
      (d) => (d.review.periodic!.reviewerCount = 0),
    ],
    [
      'negative reviewers',
      'review.reviewer_count_invalid',
      'review.periodic.reviewerCount',
      (d) => (d.review.periodic!.reviewerCount = -2),
    ],
    [
      'reviewers exceeding Goal parallelism',
      'review.parallelism_exceeds_limit',
      'review.periodic.reviewerCount',
      (d) => (d.review.periodic!.reviewerCount = 4),
    ],
    [
      'repeated-failure threshold at the hard limit',
      'review.failure_threshold_invalid',
      'review.onRepeatedFailure.afterConsecutiveFailures',
      (d) => (d.review.onRepeatedFailure!.afterConsecutiveFailures = 4),
    ],
    [
      'scope-change threshold of zero',
      'review.scope_threshold_invalid',
      'review.onScopeChange.pathsOutsideScopeAtLeast',
      (d) => (d.review.onScopeChange = { pathsOutsideScopeAtLeast: 0 }),
    ],
  ];
  it.each(errorCases)('rejects %s', (_name, code, path, mutate) => {
    const result = bad(mutate);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ severity: 'error', code, path }));
  });

  describe('limits', () => {
    const fields = [
      'maxExecutionCycles',
      'maxConsecutiveFailedCycles',
      'maxRemediationAttempts',
      'maxActiveMinutes',
      'maxWallClockDays',
      'maxParallelAgents',
    ] as const;
    it.each(fields)('requires %s to be a bounded positive whole number', (field) => {
      const set = (value: unknown) =>
        bad((d) => ((d.limits as unknown as Record<string, unknown>)[field] = value));
      expect(set(0).errors).toContainEqual(
        expect.objectContaining({ code: 'limits.below_minimum', path: `limits.${field}` }),
      );
      expect(set(-1).errors).toContainEqual(expect.objectContaining({ code: 'limits.below_minimum' }));
      expect(set(1.5).errors).toContainEqual(expect.objectContaining({ code: 'limits.not_integer' }));
      expect(set(1e9).errors).toContainEqual(expect.objectContaining({ code: 'limits.exceeds_maximum' }));
      for (const unbounded of [Infinity, Number.NaN, null, undefined, '5'])
        expect(set(unbounded).errors).toContainEqual(
          expect.objectContaining({ code: 'schema_invalid', path: `limits.${field}` }),
        );
    });

    it('ties the metered cap to the billing mode', () => {
      expect(bad((d) => (d.limits.maxMeteredUsd = 5)).errors).toContainEqual(
        expect.objectContaining({ code: 'limits.metered_cap_forbidden' }),
      );
      expect(
        bad((d) => {
          d.limits.billingMode = 'custom';
          d.limits.maxMeteredUsd = null;
        }).errors,
      ).toContainEqual(expect.objectContaining({ code: 'limits.metered_cap_required' }));
      expect(
        bad((d) => {
          d.limits.billingMode = 'subscriptions-plus-decision-budget';
          d.limits.maxMeteredUsd = 0;
        }).errors,
      ).toContainEqual(
        expect.objectContaining({ code: 'limits.below_minimum', path: 'limits.maxMeteredUsd' }),
      );
      expect(
        bad((d) => {
          d.limits.billingMode = 'custom';
          d.limits.maxMeteredUsd = 5_000;
        }).errors,
      ).toContainEqual(
        expect.objectContaining({ code: 'limits.exceeds_maximum', path: 'limits.maxMeteredUsd' }),
      );
      expect(
        bad((d) => {
          d.limits.billingMode = 'custom';
          d.limits.maxMeteredUsd = 25;
        }).valid,
      ).toBe(true);
    });
  });

  it('reports warnings separately from errors', () => {
    const result = bad((d) => {
      d.contract.completionPolicy.requireUserAcceptance = false;
      d.contract.deliverables[0]!.criterionKeys = [];
      d.milestones[1]!.criteria.push('builds');
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'completion.no_user_acceptance',
        'deliverable.unverified',
        'criterion.multiply_owned',
      ]),
    );
    expect(result.warnings.every((w) => w.severity === 'warning')).toBe(true);
  });

  it('reports every issue with a stable code and a path', () => {
    const result = bad((d) => {
      d.contract.outcome = '';
      d.milestones = [];
      d.limits.maxExecutionCycles = 0;
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    for (const issue of [...result.errors, ...result.warnings]) {
      expect(issue.code).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
      expect(typeof issue.path).toBe('string');
      expect(issue.message).not.toBe('');
    }
  });
});

describe('validateGoalDefinitionContext', () => {
  const workflow = (id: string, over: Partial<WorkflowContext> = {}): WorkflowContext => ({
    id,
    billingMode: 'subscriptions-only',
    isolatedWorktree: true,
    maxParallelAgents: 2,
    stages: [{ kind: 'implementer' }, { kind: 'gitCommit' }],
    ...over,
  });
  const all = () => ['wf-plan', 'wf-exec', 'wf-review', 'wf-verify'].map((id) => workflow(id));

  it('accepts isolated, branch-safe workflows that permit the Goal billing mode', () => {
    expect(validateGoalDefinitionContext(validDefinition(), all())).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it('rejects missing, non-isolated and branch-touching workflows', () => {
    const workflows = [
      workflow('wf-plan'),
      workflow('wf-exec', { isolatedWorktree: false }),
      workflow('wf-review', { stages: [{ kind: 'gitMerge' }] }),
    ];
    const codes = validateGoalDefinitionContext(validDefinition(), workflows).errors.map((e) => [
      e.code,
      e.path,
    ]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['context.workflow_not_isolated', 'routing.workflows.execution'],
        ['context.workflow_git_stage', 'routing.workflows.review'],
        ['context.workflow_missing', 'routing.workflows.verification'],
      ]),
    );
  });

  it('never lets the Goal promise more billing authority than a child workflow', () => {
    const definition = validDefinition();
    definition.limits.billingMode = 'subscriptions-plus-decision-budget';
    definition.limits.maxMeteredUsd = 5;
    const result = validateGoalDefinitionContext(definition, all());
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'context.billing_mode_exceeds_workflow' }),
    );
    const permissive = ['wf-plan', 'wf-exec', 'wf-review', 'wf-verify'].map((id) =>
      workflow(id, { billingMode: 'custom' }),
    );
    expect(validateGoalDefinitionContext(definition, permissive).valid).toBe(true);
  });

  it('never accepts ENIGMA permission mode for a Goal workflow, and checks it only when supplied', () => {
    const withEnigma = ['wf-plan', 'wf-exec', 'wf-review', 'wf-verify'].map((id) =>
      workflow(id, id === 'wf-exec' ? { permissionMode: 'enigma' } : { permissionMode: 'yolo' }),
    );
    const result = validateGoalDefinitionContext(validDefinition(), withEnigma);
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([
      ['context.workflow_enigma', 'routing.workflows.execution'],
    ]);
  });

  it('warns when workflow parallelism will be clamped, and merges with the pure result', () => {
    const wide = ['wf-plan', 'wf-exec', 'wf-review', 'wf-verify'].map((id) =>
      workflow(id, { maxParallelAgents: 6 }),
    );
    const context = validateGoalDefinitionContext(validDefinition(), wide);
    expect(context.warnings.map((w) => w.code)).toContain('context.workflow_parallelism_clamped');
    const merged = mergeValidations(validateGoalDefinition(validDefinition()), context);
    expect(merged.valid).toBe(true);
    expect(merged.warnings.length).toBe(context.warnings.length);
  });
});
