import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition, GoalRole } from '../../shared/goals.js';
import { isModelBackedStage } from '../../shared/workflowKinds.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import { loadDefinitionVersion } from './definitions.js';
import { readStoredResolutions } from './routeResolution.js';
import type { RouteSnapshot } from './routeIdentity.js';
import { identityOf, model, NOW, passRecords, provider } from './routingKit.js';
import { mapRefusal, ResolvedGoalRunPlanProvider } from './routePlan.js';
import type { GoalRunPlanRequest } from './runPlan.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';
import {
  TuringExecutorError,
  TuringGoalExecutor,
  canonicalNonRouteWorkflow,
  registeredGoalWorkflow,
} from './turingExecutor.js';
import { FixedGoalRunPlanProvider } from './testPlanProvider.js';
import type { Db } from '../db.js';

afterEach(cleanupTestDatabases);

const MODELS = ['orch', 'orch-b', 'orch-c', 'impl', 'final', 'rev-a', 'rev-b'];
const catalog = (down: string[] = []) => [
  provider(
    {},
    MODELS.map((id) => model(id, down.includes(id) ? { status: 'unavailable' } : {})),
  ),
];

const memberOf = (modelId: string) => ({
  configuration: {
    backendId: 'opencode',
    providerId: 'opencode-go',
    billingLane: 'opencode-go-subscription' as const,
    modelId,
  },
  identityKind: 'pinned' as const,
  freshnessClass: 'stable-subscription' as const,
});

interface Fx {
  db: Db;
  goalId: string;
  cycleId: string;
  base: string;
  definition: GoalDefinition;
  snapshot: { providers: ReturnType<typeof catalog> };
  provider: ResolvedGoalRunPlanProvider;
  setProviders(next: ReturnType<typeof catalog>): void;
}

/** A running Goal whose orchestrator is a three-member pool (`pooled`) or pinned, with one proposing cycle. */
function fx(
  options: { pooled?: 'ordered' | 'round_robin'; firstUse?: boolean; validate?: boolean } = {},
): Fx {
  const db = freshDatabase();
  const projectId = seedProject(db);
  const definition = validDefinition();
  definition.routing.workflows = {
    planning: 'goal-planning-v1',
    execution: 'goal-execution-v1',
    review: 'goal-review-v1',
    verification: 'goal-verification-v1',
  };
  definition.limits.humanGates.poolRouteFirstUse = options.firstUse ?? true;
  if (options.pooled) {
    definition.routing.roles.orchestrator = { kind: 'pool', poolId: 'orchestrators' };
    definition.routing.pools.push({
      id: 'orchestrators',
      label: 'Orchestrators',
      members: [memberOf('orch'), memberOf('orch-b'), memberOf('orch-c')],
      admission: 'static',
      availability: 'live-catalog',
      requireRoleValidation: false,
      selection: options.pooled,
      laneClass: 'subscription',
      autoRevalidate: false,
    });
  }
  const { goalId } = createGoalDraft(db, { projectId, title: 'G', definition });
  approveDefinition(db, { goalId, version: 1, actor: 'user' });
  db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(goalId);
  const cycleId = randomUUID();
  const base = 'b'.repeat(40);
  const milestoneId = (
    db.prepare('SELECT id FROM goal_milestones WHERE goal_id = ? ORDER BY rowid LIMIT 1').get(goalId) as {
      id: string;
    }
  ).id;
  db.prepare(
    `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, milestone_id, created_at)
     VALUES (?, ?, 1, 1, 'execution', 't', 'proposing', ?, ?, ?)`,
  ).run(cycleId, goalId, base, milestoneId, NOW);
  let current = catalog();
  const observe = async (): Promise<RouteSnapshot> => ({ providers: current, profiles: [] });
  const instance: Fx = {
    db,
    goalId,
    cycleId,
    base,
    definition,
    snapshot: { providers: current },
    provider: new ResolvedGoalRunPlanProvider(db, { observe, now: () => NOW }),
    setProviders(next) {
      current = next;
    },
  };
  if (options.validate !== false) validate(instance);
  return instance;
}

function validate(f: Fx) {
  const insert = f.db.prepare(
    `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'turing_probe_run', ?, ?, ?, ?)`,
  );
  const snapshot = { providers: catalog(), profiles: [] };
  for (const role of ['orchestrator', 'implementer'] as const) {
    const route = f.definition.routing.roles[role];
    if (route?.kind !== 'pinned') continue;
    for (const record of passRecords(route.member, role, snapshot))
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
  }
}

const request = (f: Fx, purpose: GoalRunPlanRequest['purpose'] = 'proposal'): GoalRunPlanRequest => ({
  goalId: f.goalId,
  cycleId: f.cycleId,
  purpose,
  definitionVersion: 1,
  workflowId: purpose === 'proposal' ? 'goal-planning-v1' : 'goal-execution-v1',
  baseCommit: f.base,
});

const idHash = (modelId: string) =>
  identityOf(memberOf(modelId), { providers: catalog(), profiles: [] }).identityHash;
const poolApproval = (
  f: Fx,
  modelId: string,
  input: { decision?: 'approved' | 'denied'; by?: 'user' | 'system'; poolId?: string } = {},
) => {
  const created = requestGoalApproval(f.db, {
    goalId: f.goalId,
    gate: 'pool_route_first_use',
    risk: 'low',
    reason: 'first use',
    requestedBy: 'supervisor',
    detail: {
      poolId: input.poolId ?? 'orchestrators',
      memberIdentityHash: idHash(modelId),
      role: 'orchestrator',
      memberIndex: 0,
    },
    now: NOW,
  });
  if (input.decision)
    decideGoalApproval(f.db, {
      goalId: f.goalId,
      approvalId: created.id,
      decision: input.decision,
      decidedBy: input.by ?? 'user',
      now: NOW,
    });
  return created;
};
const storedRole = (f: Fx, role: GoalRole) =>
  readStoredResolutions(
    (
      f.db.prepare('SELECT route_resolution_json AS j FROM goal_cycles WHERE id = ?').get(f.cycleId) as {
        j: string | null;
      }
    ).j,
  )[role];
const modelOf = (workflow: WorkflowDefinition) =>
  workflow.stages.filter((stage) => isModelBackedStage(stage.kind)).map((stage) => stage.modelId);

describe('ResolvedGoalRunPlanProvider: pinned routes', () => {
  it('maps proposal to the orchestrator and execution/remediation to the implementer, applying exactly the persisted route', async () => {
    const f = fx();
    const proposal = await f.provider.planRun(request(f, 'proposal'));
    expect(proposal.ready).toBe(true);
    if (!proposal.ready) return;
    expect(new Set(modelOf(proposal.workflowOverride))).toEqual(new Set(['orch']));
    expect(proposal.routeBinding).toMatchObject({ role: 'orchestrator' });
    expect(storedRole(f, 'orchestrator')?.selected.configuration.modelId).toBe('orch');
    expect(storedRole(f, 'implementer')).toBeUndefined();
    for (const stage of proposal.workflowOverride.stages.filter((s) => isModelBackedStage(s.kind))) {
      expect(stage).toMatchObject({
        backendId: 'opencode',
        providerId: 'opencode-go',
        billingLane: 'opencode-go-subscription',
      });
      // modelSnapshot stays observed data: the plan never supplies one.
      expect((stage as unknown as Record<string, unknown>).modelSnapshot).toBeUndefined();
    }
    // Nothing but the route of model-backed stages differs from the registered workflow.
    expect(canonicalNonRouteWorkflow(proposal.workflowOverride)).toBe(
      canonicalNonRouteWorkflow(registeredGoalWorkflow(f.db, 'goal-planning-v1')),
    );
    for (const purpose of ['execution', 'remediation'] as const) {
      const plan = await f.provider.planRun(request(f, purpose));
      expect(plan.ready).toBe(true);
      if (plan.ready) {
        expect(new Set(modelOf(plan.workflowOverride))).toEqual(new Set(['impl']));
        expect(plan.routeBinding?.role).toBe('implementer');
      }
    }
    expect(storedRole(f, 'implementer')?.selected.configuration.modelId).toBe('impl');
  });

  it('is idempotent for a cycle: a second plan returns the persisted resolution, never a recomputed one', async () => {
    const f = fx({ pooled: 'round_robin', firstUse: false });
    const first = await f.provider.planRun(request(f));
    const second = await f.provider.planRun(request(f));
    expect(first.ready && second.ready && first.routeBinding).toEqual(second.ready && second.routeBinding);
    expect(storedRole(f, 'orchestrator')?.selected.configuration.modelId).toBe('orch');
  });

  it('checks only the orchestrator and implementer: reviewer pools awaiting approval do not affect readiness', async () => {
    const f = fx();
    expect(await f.provider.checkRoutes(f.goalId)).toEqual({ ready: true });
  });

  it('builds a fresh environment on every call: a provider that disappears is not used', async () => {
    const f = fx();
    expect(await f.provider.checkRoutes(f.goalId)).toEqual({ ready: true });
    f.setProviders(catalog(['orch']));
    const check = await f.provider.checkRoutes(f.goalId);
    expect(check.ready).toBe(false);
    const plan = await f.provider.planRun(request(f));
    expect(plan.ready).toBe(false);
    expect(storedRole(f, 'orchestrator')).toBeUndefined();
    f.setProviders([provider({ detected: false }, [model('orch'), model('impl')])]);
    expect(await f.provider.checkRoutes(f.goalId)).toMatchObject({
      ready: false,
      code: 'provider_unavailable',
    });
  });

  it('fails closed on a corrupt persisted resolution and does not overwrite it', async () => {
    const f = fx();
    f.db.prepare("UPDATE goal_cycles SET route_resolution_json = 'not json' WHERE id = ?").run(f.cycleId);
    const plan = await f.provider.planRun(request(f));
    expect(plan).toMatchObject({ ready: false, code: 'route_unavailable' });
    expect((plan as { message: string }).message).toMatch(/corrupt|persisted_resolution_invalid/);
    expect(
      (
        f.db.prepare('SELECT route_resolution_json AS j FROM goal_cycles WHERE id = ?').get(f.cycleId) as {
          j: string;
        }
      ).j,
    ).toBe('not json');
  });

  it('refuses a stale cycle, definition or base without resolving anything', async () => {
    const f = fx();
    expect(await f.provider.planRun({ ...request(f), baseCommit: 'c'.repeat(40) })).toMatchObject({
      ready: false,
    });
    expect(await f.provider.planRun({ ...request(f), definitionVersion: 2 })).toMatchObject({ ready: false });
    expect(await f.provider.planRun({ ...request(f), cycleId: 'nope' })).toMatchObject({ ready: false });
    expect(storedRole(f, 'orchestrator')).toBeUndefined();
  });

  it('never produces provider_exhausted: no authoritative quota signal exists', () => {
    for (const code of [
      'route_unavailable',
      'independence_unestablished',
      'persisted_resolution_invalid',
      'route_not_defined',
    ] as const)
      expect(
        mapRefusal({
          status: 'refused',
          role: 'orchestrator',
          code,
          definitionVersion: 1,
          definitionHash: 'h',
          routeKind: null,
          poolId: null,
          evaluatedMembers: [],
        }).code,
      ).not.toBe('provider_exhausted');
  });
});

describe('first use of a pool member', () => {
  it('reports approval_required with the exact member, creates no approval and persists nothing', async () => {
    const f = fx({ pooled: 'ordered' });
    const before = (f.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get() as { n: number }).n;
    const check = await f.provider.checkRoutes(f.goalId);
    expect(check).toMatchObject({
      ready: false,
      code: 'approval_required',
      approval: {
        poolId: 'orchestrators',
        memberIdentityHash: idHash('orch'),
        role: 'orchestrator',
        memberIndex: 0,
      },
    });
    const plan = await f.provider.planRun(request(f));
    expect(plan).toMatchObject({
      ready: false,
      code: 'approval_required',
      approval: { memberIdentityHash: idHash('orch') },
    });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get() as { n: number }).n).toBe(before);
    expect(storedRole(f, 'orchestrator')).toBeUndefined();
  });

  it('reports approval_pending with the existing approval id, then resolves after a user approval', async () => {
    const f = fx({ pooled: 'ordered' });
    const pending = poolApproval(f, 'orch');
    expect(await f.provider.checkRoutes(f.goalId)).toMatchObject({
      code: 'approval_pending',
      approval: { approvalId: pending.id },
    });
    decideGoalApproval(f.db, {
      goalId: f.goalId,
      approvalId: pending.id,
      decision: 'approved',
      decidedBy: 'user',
      now: NOW,
    });
    expect(await f.provider.checkRoutes(f.goalId)).toEqual({ ready: true });
    const plan = await f.provider.planRun(request(f));
    expect(plan.ready && modelOf(plan.workflowOverride)[0]).toBe('orch');
  });

  it('accepts only a user approval for exactly this pool and member', async () => {
    const f = fx({ pooled: 'ordered' });
    poolApproval(f, 'orch', { decision: 'approved', poolId: 'another-pool' });
    expect(await f.provider.checkRoutes(f.goalId)).toMatchObject({ code: 'approval_required' });
    poolApproval(f, 'orch-b', { decision: 'approved' });
    expect(await f.provider.checkRoutes(f.goalId)).toMatchObject({
      code: 'approval_required',
      approval: { memberIdentityHash: idHash('orch') },
    });
    // The database itself refuses a non-user approval, so only a user approval can ever exist.
    expect(() => poolApproval(f, 'orch', { decision: 'approved', by: 'system' })).toThrow();
    expect(await f.provider.checkRoutes(f.goalId)).toMatchObject({ code: 'approval_pending' });
  });

  it('makes the pool consider the next member after a denial', async () => {
    const f = fx({ pooled: 'ordered' });
    poolApproval(f, 'orch', { decision: 'denied' });
    const check = await f.provider.checkRoutes(f.goalId);
    expect(check).toMatchObject({
      code: 'approval_required',
      approval: { memberIdentityHash: idHash('orch-b'), memberIndex: 1 },
    });
    poolApproval(f, 'orch-b', { decision: 'approved' });
    const plan = await f.provider.planRun(request(f));
    expect(plan.ready && modelOf(plan.workflowOverride)[0]).toBe('orch-b');
  });

  it('does not advance round robin by asking: the first selection after approval is the first member', async () => {
    const f = fx({ pooled: 'round_robin' });
    for (let i = 0; i < 3; i++) await f.provider.planRun(request(f));
    expect(await f.provider.checkRoutes(f.goalId)).toMatchObject({ approval: { memberIndex: 0 } });
    poolApproval(f, 'orch', { decision: 'approved' });
    const plan = await f.provider.planRun(request(f));
    expect(plan.ready && modelOf(plan.workflowOverride)[0]).toBe('orch');
    // The next cycle rotates to the following member, which needs its own approval.
    f.db
      .prepare("UPDATE goal_cycles SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .run(NOW, f.cycleId);
    const next = randomUUID();
    f.db
      .prepare(
        `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, base_integration_commit, created_at)
         VALUES (?, ?, 1, 2, 'execution', 't', 'proposing', ?, ?)`,
      )
      .run(next, f.goalId, f.base, NOW);
    const second = await f.provider.planRun({ ...request(f), cycleId: next });
    expect(second).toMatchObject({
      ready: false,
      code: 'approval_required',
      approval: { memberIdentityHash: idHash('orch-b'), memberIndex: 1 },
    });
  });
});

describe('executor binding of the stored resolution to the workflow route', () => {
  const task = (f: Fx) => {
    const definition = loadDefinitionVersion(f.db, f.goalId, 1)!.definition;
    return { definition, milestone: definition.milestones[0]! };
  };
  const queue = (f: Fx, executor: TuringGoalExecutor) => {
    const { milestone } = task(f);
    return executor.queueProposalRun({
      goalId: f.goalId,
      cycleId: f.cycleId,
      definitionVersion: 1,
      milestone: { key: milestone.key } as never,
      baseCommit: f.base,
      memory: { facts: [] } as never,
    });
  };
  const runs = (f: Fx) => (f.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;

  it('refuses a plan with no binding when resolved routes are required, and queues nothing', async () => {
    const f = fx();
    const executor = new TuringGoalExecutor(f.db, new FixedGoalRunPlanProvider(), {
      requireResolvedRoutes: true,
    });
    await expect(queue(f, executor)).rejects.toMatchObject({ code: 'plan_route_unbound' });
    expect(runs(f)).toBe(0);
  });

  it('refuses a plan whose concrete route differs from the persisted resolution, and queues nothing', async () => {
    const f = fx();
    const real = f.provider;
    const tampered = {
      checkRoutes: (goalId: string) => real.checkRoutes(goalId),
      async planRun(req: GoalRunPlanRequest) {
        const plan = await real.planRun(req);
        if (!plan.ready) return plan;
        return {
          ...plan,
          workflowOverride: {
            ...plan.workflowOverride,
            stages: plan.workflowOverride.stages.map((stage, index) =>
              isModelBackedStage(stage.kind) &&
              index === plan.workflowOverride.stages.findIndex((s) => isModelBackedStage(s.kind))
                ? { ...stage, modelId: 'impl' }
                : stage,
            ),
          },
        };
      },
    };
    const executor = new TuringGoalExecutor(f.db, tampered, { requireResolvedRoutes: true });
    await expect(queue(f, executor)).rejects.toBeInstanceOf(TuringExecutorError);
    await expect(queue(f, executor)).rejects.toMatchObject({ code: 'plan_route_mismatch' });
    expect(runs(f)).toBe(0);
  });

  it('carries the first-use request out of the executor as a typed error, queuing nothing', async () => {
    const f = fx({ pooled: 'ordered' });
    const executor = new TuringGoalExecutor(f.db, f.provider, { requireResolvedRoutes: true });
    await expect(queue(f, executor)).rejects.toMatchObject({
      code: 'approval_required',
      approval: { poolId: 'orchestrators', memberIdentityHash: idHash('orch') },
    });
    expect(runs(f)).toBe(0);
  });
});
