import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition, GoalReviewKind, GoalRole } from '../../shared/goals.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import { isModelBackedStage } from '../../shared/workflowKinds.js';
import type { Db } from '../db.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import { requestGoalApproval } from './approvals.js';
import { readStoredResolutions } from './routeResolution.js';
import type { RouteSnapshot } from './routeIdentity.js';
import { identityOf, model, NOW, passRecords, provider } from './routingKit.js';
import { READINESS_ROLES, ResolvedGoalRunPlanProvider } from './routePlan.js';
import { reviewRoleForKind } from './reviewRole.js';
import type { GoalRunPlanRequest } from './runPlan.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';
import { canonicalNonRouteWorkflow, registeredGoalWorkflow } from './turingExecutor.js';

afterEach(cleanupTestDatabases);

const IMPLEMENTER = 'claude-sonnet-4-5';
const ids = [IMPLEMENTER, 'orch', 'gpt-5', 'claude-opus-4-1', 'rev-a', 'rev-b', 'opus'];
const catalog = () => [
  provider(
    {},
    ids.map((id) => model(id)),
  ),
];
const meteredOf = (modelId: string) => ({
  configuration: {
    backendId: 'opencode',
    providerId: 'anthropic',
    billingLane: 'anthropic-api' as const,
    modelId,
  },
  identityKind: 'pinned' as const,
  freshnessClass: 'stable-subscription' as const,
});
const memberOf = (modelId: string, identityKind: 'pinned' | 'floating' = 'pinned') => ({
  configuration: {
    backendId: 'opencode',
    providerId: 'opencode-go',
    billingLane: 'opencode-go-subscription' as const,
    modelId,
  },
  identityKind,
  freshnessClass: 'stable-subscription' as const,
});

interface Options {
  finalModel?: string;
  finalKind?: 'pinned' | 'floating';
  allowFloating?: boolean;
  firstUse?: boolean;
  selection?: 'ordered' | 'round_robin';
  metered?: boolean;
  prepare?: (db: Db, definition: GoalDefinition) => void;
}

/** A running Goal with a finished execution cycle (the implementer authority) and one active review cycle. */
function fx(options: Options = {}) {
  const db = freshDatabase();
  const projectId = seedProject(db);
  const definition = validDefinition();
  definition.routing.workflows = {
    planning: 'goal-planning-v1',
    execution: 'goal-execution-v1',
    review: 'goal-review-v1',
    verification: 'goal-verification-v1',
  };
  definition.limits.humanGates.poolRouteFirstUse = options.firstUse ?? false;
  const pin = (id: string, kind: 'pinned' | 'floating' = 'pinned') => ({
    kind: 'pinned' as const,
    member: memberOf(id, kind),
    availability: 'live-catalog-or-fresh-validation' as const,
    requireRoleValidation: true,
  });
  definition.routing.roles.orchestrator = pin('orch');
  definition.routing.roles.implementer = pin(IMPLEMENTER);
  definition.routing.roles.final_reviewer = pin(options.finalModel ?? 'gpt-5', options.finalKind);
  definition.routing.pools = [
    {
      id: 'reviewers',
      label: 'Reviewers',
      members: options.metered
        ? [meteredOf('anthropic/rev-a'), meteredOf('anthropic/rev-b')]
        : [memberOf('rev-a'), memberOf('rev-b')],
      admission: 'static',
      availability: 'live-catalog-or-fresh-validation',
      requireRoleValidation: true,
      selection: options.selection ?? 'ordered',
      laneClass: options.metered ? 'metered' : 'subscription',
      autoRevalidate: false,
    },
  ];
  definition.routing.independence = {
    finalReview: 'different-family',
    against: ['implementer', 'remediation'],
    allowFloatingFinalReviewer: options.allowFloating ?? false,
  };
  options.prepare?.(db, definition);
  const { goalId } = createGoalDraft(db, { projectId, title: 'G', definition });
  approveDefinition(db, { goalId, version: 1, actor: 'user' });
  db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(goalId);
  const base = 'b'.repeat(40);
  const milestoneId = (
    db.prepare('SELECT id FROM goal_milestones WHERE goal_id = ? ORDER BY rowid LIMIT 1').get(goalId) as {
      id: string;
    }
  ).id;
  const snapshot = { providers: catalog(), profiles: [] };
  const insert = db.prepare(
    `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'turing_probe_run', ?, ?, ?, ?)`,
  );
  const validate = (member: ReturnType<typeof memberOf>, role: GoalRole) => {
    for (const record of passRecords(member, role, snapshot))
      insert.run(
        record.id,
        record.identityHash,
        JSON.stringify(record.identity),
        record.profile,
        record.status,
        record.adapterVersion,
        record.capabilityFingerprint,
        record.testedAt,
        record.expiresAt,
      );
  };
  validate(memberOf('orch'), 'orchestrator');
  validate(memberOf(IMPLEMENTER), 'implementer');
  validate(memberOf(options.finalModel ?? 'gpt-5', options.finalKind), 'final_reviewer');
  for (const role of ['routine_reviewer', 'milestone_reviewer'] as const)
    for (const id of ['rev-a', 'rev-b'])
      validate(options.metered ? meteredOf(`anthropic/${id}`) : memberOf(id), role);
  const observe = async (): Promise<RouteSnapshot> => snapshot;
  const planner = new ResolvedGoalRunPlanProvider(db, { observe, now: () => NOW });
  let sequence = 0;
  const cycle = (kind: 'execution' | 'review', status: string, reviewKind?: GoalReviewKind) => {
    sequence += 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, milestone_id, outcome_json, created_at, finished_at)
       VALUES (?, ?, 1, ?, ?, 't', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      goalId,
      sequence,
      kind,
      status,
      base,
      milestoneId,
      reviewKind
        ? JSON.stringify({ reviewPlan: { reviewKind, reviewerCount: 2, reviewedFromCommit: null } })
        : null,
      NOW,
      status === 'succeeded' ? NOW : null,
    );
    return id;
  };
  const f = {
    db,
    goalId,
    base,
    definition,
    planner,
    cycle,
    /** The implementer authority (an executed cycle) that final-review independence compares against. */
    async withImplementerAuthority() {
      const id = cycle('execution', 'launching');
      const plan = await planner.planRun({
        goalId,
        cycleId: id,
        purpose: 'execution',
        definitionVersion: 1,
        workflowId: 'goal-execution-v1',
        baseCommit: base,
      });
      expect(plan.ready).toBe(true);
      const result = 'd'.repeat(40);
      db.prepare(
        `UPDATE goal_cycles SET status = 'succeeded', finished_at = ?, result_integration_commit = ?, outcome_json = ? WHERE id = ?`,
      ).run(NOW, result, JSON.stringify({ code: 'integrated' }), id);
      const op = randomUUID();
      db.prepare(
        `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, op, expected_old, new_commit, status, checks_json, created_at)
         VALUES (?, ?, ?, 'advance', ?, ?, 'planned', '{}', ?)`,
      ).run(op, goalId, id, base, result, NOW);
      db.prepare("UPDATE goal_integration_ops SET status = 'applied', finished_at = ? WHERE id = ?").run(
        NOW,
        op,
      );
    },
    review(kind: GoalReviewKind) {
      return cycle('review', 'launching', kind);
    },
    request(cycleId: string, kind: GoalReviewKind): GoalRunPlanRequest {
      return {
        goalId,
        cycleId,
        purpose: 'review',
        reviewRole: reviewRoleForKind(kind),
        definitionVersion: 1,
        workflowId: 'goal-review-v1',
        baseCommit: base,
      };
    },
    stored(cycleId: string, role: GoalRole) {
      return readStoredResolutions(
        (
          db.prepare('SELECT route_resolution_json AS j FROM goal_cycles WHERE id = ?').get(cycleId) as {
            j: string | null;
          }
        ).j,
      )[role];
    },
  };
  return f;
}

const modelBacked = (workflow: WorkflowDefinition) =>
  workflow.stages.filter((s) => isModelBackedStage(s.kind));
const finish = (f: ReturnType<typeof fx>, id: string) =>
  f.db.prepare("UPDATE goal_cycles SET status = 'succeeded', finished_at = ? WHERE id = ?").run(NOW, id);

describe('review route plans', () => {
  const EXPECTED: Array<[GoalReviewKind, GoalRole, string]> = [
    ['periodic', 'routine_reviewer', 'rev-a'],
    ['repeated_failure', 'routine_reviewer', 'rev-a'],
    ['scope_change', 'routine_reviewer', 'rev-a'],
    ['milestone', 'milestone_reviewer', 'rev-a'],
    ['final', 'final_reviewer', 'gpt-5'],
  ];

  it.each(EXPECTED)(
    '%s resolves exactly %s and applies the persisted route to every model-backed stage',
    async (kind, role, expectedModel) => {
      const f = fx();
      await f.withImplementerAuthority();
      const cycleId = f.review(kind);
      const plan = await f.planner.planRun(f.request(cycleId, kind));
      expect(plan).toMatchObject({ ready: true });
      if (!plan.ready) return;
      expect(plan.routeBinding).toMatchObject({ role });
      const stages = modelBacked(plan.workflowOverride);
      expect(stages.map((s) => s.kind)).toEqual(['parallelReview', 'consolidate', 'finalGate']);
      expect(new Set(stages.map((s) => s.modelId))).toEqual(new Set([expectedModel]));
      expect(f.stored(cycleId, role)?.selected.configuration.modelId).toBe(expectedModel);
      // Only the requested reviewer role was resolved for this cycle.
      for (const other of [
        'routine_reviewer',
        'milestone_reviewer',
        'final_reviewer',
        'implementer',
      ] as const)
        if (other !== role) expect(f.stored(cycleId, other)).toBeUndefined();
      // Nothing but the route differs from the registered workflow; modelSnapshot stays observed metadata.
      expect(canonicalNonRouteWorkflow(plan.workflowOverride)).toBe(
        canonicalNonRouteWorkflow(registeredGoalWorkflow(f.db, 'goal-review-v1')),
      );
      for (const stage of stages)
        expect((stage as unknown as Record<string, unknown>).modelSnapshot).toBeUndefined();
    },
  );

  it('does not rotate on a retry of the same cycle: the persisted resolution is returned', async () => {
    const f = fx({ selection: 'round_robin' });
    const first = f.review('periodic');
    const a = await f.planner.planRun(f.request(first, 'periodic'));
    const b = await f.planner.planRun(f.request(first, 'periodic'));
    expect(a.ready && b.ready && a.routeBinding).toEqual(b.ready && b.routeBinding);
    expect(f.stored(first, 'routine_reviewer')?.selected.configuration.modelId).toBe('rev-a');
    // The NEXT review cycle rotates to the following member.
    finish(f, first);
    const second = f.review('periodic');
    const next = await f.planner.planRun(f.request(second, 'periodic'));
    expect(next.ready && modelBacked(next.workflowOverride)[0]!.modelId).toBe('rev-b');
  });

  it('fails closed on a corrupt persisted resolution and does not overwrite it', async () => {
    const f = fx();
    const cycleId = f.review('milestone');
    f.db.prepare("UPDATE goal_cycles SET route_resolution_json = 'not json' WHERE id = ?").run(cycleId);
    const plan = await f.planner.planRun(f.request(cycleId, 'milestone'));
    expect(plan).toMatchObject({ ready: false, code: 'route_unavailable' });
    expect(
      (
        f.db.prepare('SELECT route_resolution_json AS j FROM goal_cycles WHERE id = ?').get(cycleId) as {
          j: string;
        }
      ).j,
    ).toBe('not json');
  });

  it('surfaces a first-use requirement for a reviewer pool member as a typed approval and never substitutes', async () => {
    const f = fx({ firstUse: true });
    const cycleId = f.review('periodic');
    const plan = await f.planner.planRun(f.request(cycleId, 'periodic'));
    expect(plan).toMatchObject({
      ready: false,
      code: 'approval_required',
      approval: { poolId: 'reviewers', role: 'routine_reviewer', memberIndex: 0 },
    });
    expect(f.stored(cycleId, 'routine_reviewer')).toBeUndefined();
    const identity = identityOf(memberOf('rev-a'), { providers: catalog(), profiles: [] }).identityHash;
    const pending = requestGoalApproval(f.db, {
      goalId: f.goalId,
      gate: 'pool_route_first_use',
      risk: 'low',
      reason: 'first use',
      requestedBy: 'supervisor',
      detail: { poolId: 'reviewers', memberIdentityHash: identity, role: 'routine_reviewer', memberIndex: 0 },
      now: NOW,
    });
    expect(await f.planner.planRun(f.request(cycleId, 'periodic'))).toMatchObject({
      ready: false,
      code: 'approval_pending',
      approval: { approvalId: pending.id },
    });
  });

  const billed = (lanes: string[]) =>
    fx({
      metered: true,
      prepare(db, definition) {
        const row = db.prepare("SELECT * FROM workflows WHERE id = 'goal-review-v1'").get() as Record<
          string,
          string
        >;
        const config = JSON.parse(row.config_json) as Record<string, unknown>;
        config.billingMode = 'custom';
        config.customAllowedLanes = lanes;
        delete config.subscriptionOnly;
        db.prepare(
          'INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
        ).run('review-custom', 'rc', row.description, row.template, JSON.stringify(config), NOW, NOW);
        definition.routing.workflows.review = 'review-custom';
        definition.limits.billingMode = 'custom';
        definition.limits.maxMeteredUsd = 5;
        definition.routing.pools![0]!.laneClass = 'permitted-by-billing-mode';
      },
    });

  it('judges billing conjunctively: a review workflow that does not allow the lane refuses the route', async () => {
    const f = billed(['openrouter-metered']);
    const cycleId = f.review('periodic');
    const plan = await f.planner.planRun({ ...f.request(cycleId, 'periodic'), workflowId: 'review-custom' });
    expect(plan).toMatchObject({ ready: false, code: 'route_unavailable' });
    expect(f.stored(cycleId, 'routine_reviewer')).toBeUndefined();
  });

  it('accepts the same metered lane when the review workflow allows it', async () => {
    const f = billed(['anthropic-api']);
    const cycleId = f.review('periodic');
    const plan = await f.planner.planRun({ ...f.request(cycleId, 'periodic'), workflowId: 'review-custom' });
    expect(plan).toMatchObject({ ready: true });
  });

  it('refuses an unknown reviewer role and a stale cycle, base or definition without resolving anything', async () => {
    const f = fx();
    const cycleId = f.review('periodic');
    const request = f.request(cycleId, 'periodic');
    for (const bad of [
      { ...request, reviewRole: 'implementer' as never },
      { ...request, reviewRole: undefined as never },
      { ...request, baseCommit: 'c'.repeat(40) },
      { ...request, definitionVersion: 2 },
    ])
      expect(await f.planner.planRun(bad)).toMatchObject({ ready: false });
    expect(f.stored(cycleId, 'routine_reviewer')).toBeUndefined();
    expect(f.stored(cycleId, 'implementer')).toBeUndefined();
  });

  it('keeps reviewer roles out of readiness', async () => {
    expect([...READINESS_ROLES]).toEqual(['orchestrator', 'implementer']);
    const f = fx({ firstUse: true });
    expect(await f.planner.checkRoutes(f.goalId)).toEqual({ ready: true });
  });
});

describe('final review independence comes from the persisted resolution', () => {
  it('records established independence for a different-family final reviewer', async () => {
    const f = fx({ finalModel: 'gpt-5' });
    await f.withImplementerAuthority();
    const cycleId = f.review('final');
    const plan = await f.planner.planRun(f.request(cycleId, 'final'));
    expect(plan).toMatchObject({ ready: true });
    const stored = f.stored(cycleId, 'final_reviewer')!;
    expect(stored.independence).toMatchObject({
      established: true,
      required: true,
      reasonCode: 'established',
    });
    expect(stored.independence?.comparedAgainst[0]).toMatchObject({ role: 'implementer' });
  });

  it('never plans (so never queues) a same-family final review', async () => {
    const f = fx({ finalModel: 'claude-opus-4-1' });
    await f.withImplementerAuthority();
    const cycleId = f.review('final');
    const plan = await f.planner.planRun(f.request(cycleId, 'final'));
    expect(plan).toMatchObject({ ready: false, code: 'route_unavailable' });
    expect(f.stored(cycleId, 'final_reviewer')).toBeUndefined();
  });

  it('lets a floating reviewer run with established=false under the explicit allowance', async () => {
    const f = fx({ finalModel: 'gpt-5', finalKind: 'floating', allowFloating: true });
    await f.withImplementerAuthority();
    const cycleId = f.review('final');
    const plan = await f.planner.planRun(f.request(cycleId, 'final'));
    expect(plan.ready).toBe(true);
    expect(f.stored(cycleId, 'final_reviewer')?.independence).toMatchObject({
      established: false,
      reasonCode: 'candidate_identity_unproven',
    });
  });
});
