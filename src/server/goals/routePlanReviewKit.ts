/** TEST-ONLY fixture for Goal review route plans (never imported by production code). */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { GoalDefinition, GoalReviewKind, GoalRole } from '../../shared/goals.js';
import type {} from '../../shared/types.js';
import {} from '../../shared/workflowKinds.js';
import type { Db } from '../db.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import {} from './approvals.js';
import { readStoredResolutions } from './routeResolution.js';
import type { RouteSnapshot } from './routeIdentity.js';
import { model, NOW, passRecords, provider } from './routingKit.js';
import { ResolvedGoalRunPlanProvider } from './routePlan.js';
import {} from './reviewIndependence.js';
import type {} from './reviews.js';
import { reviewRoleForKind } from './reviewRole.js';
import type { GoalRunPlanRequest } from './runPlan.js';
import { freshDatabase, seedProject, validDefinition } from './testKit.js';
import {} from './turingExecutor.js';

export const IMPLEMENTER = 'claude-sonnet-4-5';
export const ids = [IMPLEMENTER, 'orch', 'gpt-5', 'claude-opus-4-1', 'rev-a', 'rev-b', 'opus'];
export const catalog = () => [
  provider(
    {},
    ids.map((id) => model(id)),
  ),
];
export const meteredOf = (modelId: string) => ({
  configuration: {
    backendId: 'opencode',
    providerId: 'anthropic',
    billingLane: 'anthropic-api' as const,
    modelId,
  },
  identityKind: 'pinned' as const,
  freshnessClass: 'stable-subscription' as const,
});
export const memberOf = (modelId: string, identityKind: 'pinned' | 'floating' = 'pinned') => ({
  configuration: {
    backendId: 'opencode',
    providerId: 'opencode-go',
    billingLane: 'opencode-go-subscription' as const,
    modelId,
  },
  identityKind,
  freshnessClass: 'stable-subscription' as const,
});

export interface Options {
  finalModel?: string;
  finalKind?: 'pinned' | 'floating';
  allowFloating?: boolean;
  firstUse?: boolean;
  selection?: 'ordered' | 'round_robin';
  metered?: boolean;
  prepare?: (db: Db, definition: GoalDefinition) => void;
}

/** A running Goal with a finished execution cycle (the implementer authority) and one active review cycle. */
export function fx(options: Options = {}) {
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
      laneClass: (options.metered ? 'metered' : 'subscription') as 'subscription',
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
        `UPDATE goal_cycles SET finished_at = ?, status = 'succeeded', result_integration_commit = ?, outcome_json = ? WHERE id = ?`,
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
      return id;
    },
    /** A run (with canonical usage telemetry naming the model it actually resolved to) owned by a cycle. */
    telemetry(cycleId: string, purpose: 'execution' | 'review', resolvedModelId: string) {
      const runId = randomUUID();
      db.pragma('foreign_keys = OFF');
      db.prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, goal_cycle_id, goal_run_purpose)
         VALUES (?, 'm', 'p', 'w', '{}', 'x', 'economy', 'normal', 'completed', ?, ?, ?)`,
      ).run(runId, NOW, cycleId, purpose);
      db.prepare(
        "INSERT INTO usage_events (id, occurred_at, run_id, provenance, resolved_model_id) VALUES (?, ?, ?, 'reported', ?)",
      ).run(randomUUID(), NOW, runId, resolvedModelId);
      db.pragma('foreign_keys = ON');
      return runId;
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
