import {} from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalReviewKind, GoalRole } from '../../shared/goals.js';
import type { WorkflowDefinition } from '../../shared/types.js';
import { isModelBackedStage } from '../../shared/workflowKinds.js';
import type {} from '../db.js';
import {} from './definitions.js';
import { requestGoalApproval } from './approvals.js';
import {} from './routeResolution.js';
import type {} from './routeIdentity.js';
import { identityOf, NOW } from './routingKit.js';
import { READINESS_ROLES } from './routePlan.js';
import { deriveReviewIndependence } from './reviewIndependence.js';
import type { GoalReviewRow } from './reviews.js';
import {} from './reviewRole.js';
import type {} from './runPlan.js';
import { cleanupTestDatabases } from './testKit.js';
import { canonicalNonRouteWorkflow, registeredGoalWorkflow } from './turingExecutor.js';

import { IMPLEMENTER, catalog, memberOf, fx } from './routePlanReviewKit.js';

afterEach(cleanupTestDatabases);

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

describe('deriveReviewIndependence (server-derived, never model-supplied)', () => {
  const rowOf = (f: ReturnType<typeof fx>, cycleId: string, reviewKind: GoalReviewKind) =>
    ({ goalId: f.goalId, cycleId, definitionVersion: 1, reviewKind }) as unknown as GoalReviewRow;

  it('returns the persisted established claim for a final review', async () => {
    const f = fx({ finalModel: 'gpt-5' });
    await f.withImplementerAuthority();
    const cycleId = f.review('final');
    await f.planner.planRun(f.request(cycleId, 'final'));
    const result = deriveReviewIndependence(f.db, rowOf(f, cycleId, 'final'));
    expect(result).toMatchObject({
      ok: true,
      independence: { established: true, detail: { reasonCode: 'established', required: true } },
    });
  });

  it('records none for a non-final review', async () => {
    const f = fx();
    const cycleId = f.review('milestone');
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, 'milestone'))).toEqual({
      ok: true,
      independence: undefined,
    });
  });

  it('fails closed when no final_reviewer resolution is stored', async () => {
    const f = fx();
    const cycleId = f.review('final');
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, 'final'))).toEqual({
      ok: false,
      code: 'independence_resolution_missing',
    });
  });

  it('fails closed when the stored resolution was tampered with', async () => {
    const f = fx({ finalModel: 'gpt-5' });
    await f.withImplementerAuthority();
    const cycleId = f.review('final');
    await f.planner.planRun(f.request(cycleId, 'final'));
    const json = (
      f.db.prepare('SELECT route_resolution_json AS j FROM goal_cycles WHERE id = ?').get(cycleId) as {
        j: string;
      }
    ).j;
    f.db
      .prepare('UPDATE goal_cycles SET route_resolution_json = ? WHERE id = ?')
      .run(json.replace('"definitionHash":"', '"definitionHash":"x'), cycleId);
    const result = deriveReviewIndependence(f.db, rowOf(f, cycleId, 'final'));
    expect(result.ok).toBe(false);
  });

  it('carries established=false for an allowed floating final reviewer', async () => {
    const f = fx({ finalModel: 'gpt-5', finalKind: 'floating', allowFloating: true });
    await f.withImplementerAuthority();
    const cycleId = f.review('final');
    await f.planner.planRun(f.request(cycleId, 'final'));
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, 'final'))).toMatchObject({
      ok: true,
      independence: { established: false, detail: { reasonCode: 'candidate_identity_unproven' } },
    });
  });
});

describe('post-run independence uses canonical Stage-5 semantics and telemetry', () => {
  const rowOf = (f: ReturnType<typeof fx>, cycleId: string, runId: string | null) =>
    ({
      goalId: f.goalId,
      cycleId,
      definitionVersion: 1,
      reviewKind: 'final',
      runId,
    }) as unknown as GoalReviewRow;
  const planned = async (options: Parameters<typeof fx>[0] = { finalModel: 'gpt-5' }) => {
    const f = fx(options);
    const authorityCycle = (await f.withImplementerAuthority()) as unknown as string;
    const cycleId = f.review('final');
    expect((await f.planner.planRun(f.request(cycleId, 'final'))).ready).toBe(true);
    return { f, cycleId, authorityCycle };
  };

  it('establishes independence when telemetry agrees with the configured identities', async () => {
    const { f, cycleId, authorityCycle } = await planned();
    f.telemetry(authorityCycle, 'execution', IMPLEMENTER);
    const runId = f.telemetry(cycleId, 'review', 'gpt-5');
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, runId))).toMatchObject({
      ok: true,
      independence: { established: true, detail: { reasonCode: 'established' } },
    });
  });

  it('candidate conflict: configured model A but usage resolves B is never independent', async () => {
    const { f, cycleId } = await planned();
    const runId = f.telemetry(cycleId, 'review', 'gpt-4o');
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, runId))).toMatchObject({
      ok: true,
      independence: { established: false, detail: { reasonCode: 'identity_conflict' } },
    });
  });

  it('authority conflict: the implementer ran as something other than configured, so a different reviewer proves nothing', async () => {
    const { f, cycleId, authorityCycle } = await planned();
    f.telemetry(authorityCycle, 'execution', 'gpt-4o');
    const runId = f.telemetry(cycleId, 'review', 'gpt-5');
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, runId))).toMatchObject({
      ok: true,
      independence: { established: false, detail: { reasonCode: 'identity_conflict' } },
    });
  });

  it('proven overlap after runtime resolution: a floating reviewer that resolves to the implementer model is not independent', async () => {
    const { f, cycleId } = await planned({ finalModel: 'gpt-5', finalKind: 'floating', allowFloating: true });
    const runId = f.telemetry(cycleId, 'review', IMPLEMENTER);
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, runId))).toMatchObject({
      ok: true,
      independence: { established: false, detail: { reasonCode: 'same_model', conflict: true } },
    });
  });

  it('the explicit floating exception stays unestablished even when telemetry later names a distinct model', async () => {
    const { f, cycleId } = await planned({ finalModel: 'gpt-5', finalKind: 'floating', allowFloating: true });
    const none = deriveReviewIndependence(f.db, rowOf(f, cycleId, null));
    expect(none).toMatchObject({
      ok: true,
      independence: { established: false, detail: { reasonCode: 'candidate_identity_unproven' } },
    });
    const runId = f.telemetry(cycleId, 'review', 'gpt-5');
    expect(deriveReviewIndependence(f.db, rowOf(f, cycleId, runId))).toMatchObject({
      ok: true,
      independence: { established: false, detail: { reasonCode: 'candidate_identity_unproven' } },
    });
  });
});
