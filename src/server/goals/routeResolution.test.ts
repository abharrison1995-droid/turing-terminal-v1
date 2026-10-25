import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { GoalDefinition, GoalRole } from '../../shared/goals.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';
import { canonicalJson } from './definitionHash.js';
import { memberConfigHashOf } from './routeIdentity.js';
import { readRouteValidations } from './routeValidation.js';
import { readStoredResolutions } from './routeResolution.js';
import {
  MAX_ROUTE_RESOLUTION_JSON,
  RouteResolutionError,
  loadAuthoritySet,
  loadPriorResolutions,
  loadStoredEnvironment,
  isOpportunityResolutionForRoute,
  persistRoleResolution,
  previewGoalRoutes,
  resolveRolesForCycle,
} from './routeResolution.js';
import type { RoleResolution } from './routeAudit.js';
import { identityOf, model, passRecords, provider } from './routingKit.js';
import { NOW, hoursAgo } from './routingKit.js';
import type { RoutingEnvironment } from './routing.js';

afterEach(cleanupTestDatabases);

describe('opportunity reservation route binding', () => {
  const configuration = {
    backendId: 'openrouter',
    providerId: 'openrouter',
    billingLane: 'openrouter-metered' as const,
    modelId: 'acme/model',
    connectionProfileId: 'profile-1',
    variantId: 'fast',
    reasoning: 'low',
    nativeSettings: { maxOutputTokens: 4_000 },
  };

  it('uses the opportunity estimator only for the exact persisted admitted route', () => {
    const resolution = {
      selected: { configuration },
      approval: { admissionKind: 'opportunity' as const },
    } as Pick<RoleResolution, 'selected' | 'approval'>;
    expect(isOpportunityResolutionForRoute({ implementer: resolution }, configuration)).toBe(true);
    expect(
      isOpportunityResolutionForRoute(
        { implementer: resolution },
        { ...configuration, modelId: 'other/model' },
      ),
    ).toBe(false);
    expect(
      isOpportunityResolutionForRoute({ implementer: { ...resolution, approval: {} } }, configuration),
    ).toBe(false);
  });
});

const XS = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'];
const MODELS = [
  'orch',
  'impl',
  'final',
  'rev-a',
  'rev-b',
  'rev-c',
  'claude-sonnet-4-5',
  'glm-4.6',
  'gpt-5',
  ...XS,
];
const providers = (down: string[] = []) => [
  provider(
    {},
    MODELS.map((id) => model(id, down.includes(id) ? { status: 'unavailable' } : {})),
  ),
];

interface Fixture {
  db: Db;
  goalId: string;
  definition: GoalDefinition;
  hash: string;
}

function fixture(mutate?: (definition: GoalDefinition) => void, projectName = 'P'): Fixture {
  const db = freshDatabase();
  return seed(db, mutate, projectName);
}

function seed(db: Db, mutate?: (definition: GoalDefinition) => void, projectName = 'P'): Fixture {
  const projectId = seedProject(db, projectName);
  const definition = validDefinition();
  mutate?.(definition);
  const { goalId } = createGoalDraft(db, { projectId, title: 'G', definition });
  approveDefinition(db, { goalId, version: 1, actor: 'user' });
  db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(goalId);
  const hash = (
    db
      .prepare('SELECT definition_hash FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
      .get(goalId) as {
      definition_hash: string;
    }
  ).definition_hash;
  return { db, goalId, definition, hash };
}

/** A rotation fixture: reviewers round-robin, no first-use gate, live catalog only. */
const roundRobin = (definition: GoalDefinition) => {
  definition.limits.humanGates.poolRouteFirstUse = false;
  const reviewers = definition.routing.pools[0]!;
  reviewers.selection = 'round_robin';
  reviewers.availability = 'live-catalog';
  reviewers.requireRoleValidation = false;
  reviewers.members.push({
    ...reviewers.members[0]!,
    configuration: { ...reviewers.members[0]!.configuration, modelId: 'rev-c' },
  });
};

function insertCycle(
  fx: Fixture,
  input: { status?: string; kind?: string; resolution?: string | null; sequenceNo?: number } = {},
): string {
  const id = randomUUID();
  fx.db
    .prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, route_resolution_json, created_at)
       VALUES (?, ?, 1, ?, ?, 't', ?, ?, ?)`,
    )
    .run(
      id,
      fx.goalId,
      input.sequenceNo ??
        (
          fx.db
            .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM goal_cycles WHERE goal_id = ?')
            .get(fx.goalId) as { n: number }
        ).n,
      input.kind ?? 'execution',
      input.status ?? 'planned',
      input.resolution ?? null,
      NOW,
    );
  return id;
}
const finish = (fx: Fixture, cycleId: string) =>
  fx.db
    .prepare("UPDATE goal_cycles SET status = 'succeeded', finished_at = ? WHERE id = ?")
    .run(NOW, cycleId);
const rawResolution = (fx: Fixture, cycleId: string) =>
  (
    fx.db.prepare('SELECT route_resolution_json AS j FROM goal_cycles WHERE id = ?').get(cycleId) as {
      j: string | null;
    }
  ).j;

function seedValidations(fx: Fixture, records: ReturnType<typeof passRecords>) {
  const insert = fx.db.prepare(
    `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'turing_probe_run', ?, ?, ?, ?)`,
  );
  for (const record of records)
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

/** Passing validations for every live-catalog-or-fresh pinned role of the fixture definition. */
function validateAll(fx: Fixture) {
  const snapshot = { providers: providers(), profiles: [] };
  const routing = fx.definition.routing;
  for (const role of ['orchestrator', 'implementer', 'final_reviewer'] as const) {
    const route = routing.roles[role];
    if (route?.kind === 'pinned') seedValidations(fx, passRecords(route.member, role, snapshot));
  }
  for (const role of ['routine_reviewer', 'milestone_reviewer'] as const)
    for (const poolMember of routing.pools[0]!.members)
      seedValidations(fx, passRecords(poolMember, role, snapshot, {}));
}

const environmentFor = (fx: Fixture, down: string[] = [], excludeCycleId?: string): RoutingEnvironment =>
  loadStoredEnvironment(fx.db, {
    goalId: fx.goalId,
    definition: fx.definition,
    now: NOW,
    providers: providers(down),
    profiles: [],
    excludeCycleId,
  });

const countOf = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const selected = (outcome: { status: string } | undefined) =>
  outcome && outcome.status === 'resolved'
    ? (outcome as { resolution: RoleResolution }).resolution.selected.configuration.modelId
    : null;

describe('read-only goal route preview', () => {
  it('resolves every routed role from stored validations and approvals, and writes nothing', () => {
    const fx = fixture();
    validateAll(fx);
    const cycleId = insertCycle(fx);
    const before = {
      approvals: countOf(fx.db, 'goal_approvals'),
      events: countOf(fx.db, 'goal_events'),
      validations: countOf(fx.db, 'route_validations'),
      runs: countOf(fx.db, 'runs'),
      version: fx.db.prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ?').all(fx.goalId),
    };
    const preview = previewGoalRoutes(fx.db, { goalId: fx.goalId, environment: environmentFor(fx) });
    expect(preview).toMatchObject({ definitionVersion: 1, definitionHash: fx.hash });
    const roles = preview.result.roles;
    expect(selected(roles.orchestrator)).toBe('orch');
    expect(selected(roles.implementer)).toBe('impl');
    // No integrated work yet means there is nothing to be independent of, so independence is unestablished.
    expect(roles.final_reviewer).toMatchObject({ status: 'refused', code: 'independence_unestablished' });
    // The fixture gates pool first use, so the reviewer pool asks for an approval it must not create.
    expect(roles.routine_reviewer).toMatchObject({ status: 'refused', code: 'approval_required' });
    expect(roles.milestone_reviewer).toMatchObject({ status: 'refused', code: 'approval_required' });
    expect(preview.result.ok).toBe(false);
    expect({
      approvals: countOf(fx.db, 'goal_approvals'),
      events: countOf(fx.db, 'goal_events'),
      validations: countOf(fx.db, 'route_validations'),
      runs: countOf(fx.db, 'runs'),
      version: fx.db.prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ?').all(fx.goalId),
    }).toEqual(before);
    expect(rawResolution(fx, cycleId)).toBeNull();
  });

  it('treats missing validations as plain ineligibility and never starts a validation', () => {
    const fx = fixture();
    const preview = previewGoalRoutes(fx.db, { goalId: fx.goalId, environment: environmentFor(fx) });
    expect(preview.result.roles.implementer).toMatchObject({ status: 'refused', code: 'route_unavailable' });
    expect(countOf(fx.db, 'route_validations')).toBe(0);
  });

  it('honours a stored user approval for the exact pool member and ignores one for another member', () => {
    const fx = fixture();
    validateAll(fx);
    const snapshot = { providers: providers(), profiles: [] };
    const first = fx.definition.routing.pools[0]!.members[0]!;
    const hash = identityOf(first, snapshot).identityHash;
    const ask = (memberIdentityHash: string) => {
      const pending = requestGoalApproval(fx.db, {
        goalId: fx.goalId,
        gate: 'pool_route_first_use',
        risk: 'low',
        reason: 'first use',
        requestedBy: 'supervisor',
        detail: { poolId: 'reviewers', memberIdentityHash },
      });
      decideGoalApproval(fx.db, {
        goalId: fx.goalId,
        approvalId: pending.id,
        decision: 'approved',
        decidedBy: 'user',
      });
    };
    ask('f'.repeat(64));
    expect(
      previewGoalRoutes(fx.db, {
        goalId: fx.goalId,
        environment: environmentFor(fx),
        roles: ['routine_reviewer'],
      }).result.roles.routine_reviewer,
    ).toMatchObject({ code: 'approval_required' });
    ask(hash);
    const resolved = previewGoalRoutes(fx.db, {
      goalId: fx.goalId,
      environment: environmentFor(fx),
      roles: ['routine_reviewer'],
    });
    expect(selected(resolved.result.roles.routine_reviewer)).toBe('rev-a');
  });

  it('refuses a Goal whose stored definition fails its hash', () => {
    const fx = fixture();
    fx.db.exec('DROP TRIGGER trg_goal_definition_immutable');
    fx.db
      .prepare('UPDATE goal_definition_versions SET limits_json = ? WHERE goal_id = ?')
      .run(JSON.stringify({ ...fx.definition.limits, maxExecutionCycles: 3 }), fx.goalId);
    expect(() => previewGoalRoutes(fx.db, { goalId: fx.goalId, environment: environmentFor(fx) })).toThrow(
      expect.objectContaining({ code: 'definition_mismatch' }),
    );
  });
});

describe('role resolution persistence', () => {
  async function setup() {
    const fx = fixture();
    validateAll(fx);
    return { fx, cycleId: insertCycle(fx) };
  }

  it('writes each role once, lets orchestrator and implementer coexist, and is idempotent on retry', () => {
    const { fx, cycleId } = (() => {
      const f = fixture();
      validateAll(f);
      return { fx: f, cycleId: insertCycle(f) };
    })();
    const first = resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['orchestrator'],
      environment: environmentFor(fx),
    });
    expect(first.ok).toBe(true);
    const afterFirst = rawResolution(fx, cycleId)!;
    expect(Object.keys(readStoredResolutions(afterFirst))).toEqual(['orchestrator']);
    const second = resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['orchestrator', 'implementer'],
      environment: environmentFor(fx),
    });
    expect(second.roles.orchestrator).toMatchObject({ status: 'resolved', source: 'persisted' });
    expect(second.roles.implementer).toMatchObject({ status: 'resolved', source: 'computed' });
    const stored = readStoredResolutions(rawResolution(fx, cycleId));
    expect(Object.keys(stored).sort()).toEqual(['implementer', 'orchestrator']);
    expect(JSON.stringify(stored.orchestrator)).toBe(
      JSON.stringify(readStoredResolutions(afterFirst).orchestrator),
    );
    // Retrying the same call changes nothing.
    const snapshot = rawResolution(fx, cycleId);
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['orchestrator', 'implementer'],
      environment: environmentFor(fx),
    });
    expect(rawResolution(fx, cycleId)).toBe(snapshot);
    expect(
      persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId, resolution: stored.implementer! }),
    ).toEqual({
      written: false,
    });
    void setup;
  });

  it('returns the persisted resolution even after the environment changed, instead of recomputing', () => {
    const fx = fixture(roundRobin);
    const cycleId = insertCycle(fx);
    const first = resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx),
    });
    expect(selected(first.roles.routine_reviewer)).toBe('rev-a');
    const again = resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx, ['rev-a', 'rev-b', 'rev-c']),
    });
    expect(again.roles.routine_reviewer).toMatchObject({ status: 'resolved', source: 'persisted' });
    expect(selected(again.roles.routine_reviewer)).toBe('rev-a');
  });

  it('refuses a different second resolution for a role and never replaces the stored one', () => {
    const fx = fixture(roundRobin);
    const cycleId = insertCycle(fx);
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx),
    });
    const before = rawResolution(fx, cycleId);
    // A semantically valid resolution for another member: what the rotation would pick after rev-a.
    const preview = previewGoalRoutes(fx.db, {
      goalId: fx.goalId,
      environment: environmentFor(fx),
      roles: ['routine_reviewer'],
    }).result.roles.routine_reviewer as { resolution: RoleResolution };
    const different = preview.resolution;
    expect(different.selected.configuration.modelId).toBe('rev-b');
    expect(() => persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId, resolution: different })).toThrow(
      expect.objectContaining({ code: 'route_resolution_conflict' }),
    );
    expect(rawResolution(fx, cycleId)).toBe(before);
  });

  it('proves the cycle, goal, definition and size before writing', () => {
    const fx = fixture(roundRobin);
    validateAll(fx);
    const cycleId = insertCycle(fx);
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx),
    });
    const resolution = readStoredResolutions(rawResolution(fx, cycleId)).routine_reviewer!;
    const other: RoleResolution = { ...resolution, role: 'milestone_reviewer' };
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as RouteResolutionError).code;
      }
      return 'no error';
    };
    expect(
      code(() =>
        persistRoleResolution(fx.db, {
          goalId: fx.goalId,
          cycleId,
          resolution: { ...other, definitionHash: 'b'.repeat(64) },
        }),
      ),
    ).toBe('definition_mismatch');
    expect(
      code(() =>
        persistRoleResolution(fx.db, {
          goalId: fx.goalId,
          cycleId,
          resolution: { ...other, definitionVersion: 2 },
        }),
      ),
    ).toBe('definition_mismatch');
    expect(
      code(() => persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId: 'nope', resolution: other })),
    ).toBe('cycle_not_found');
    expect(code(() => persistRoleResolution(fx.db, { goalId: 'nope', cycleId, resolution: other }))).toBe(
      'goal_not_found',
    );
    expect(
      code(() =>
        persistRoleResolution(fx.db, {
          goalId: fx.goalId,
          cycleId,
          resolution: { ...other, schema: 2 } as never,
        }),
      ),
    ).toBe('resolution_invalid');
    expect(Object.keys(readStoredResolutions(rawResolution(fx, cycleId)))).toEqual(['routine_reviewer']);
  });

  it('refuses a terminal cycle and another Goal’s cycle', () => {
    const fx = fixture(roundRobin);
    const cycleId = insertCycle(fx);
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx),
    });
    const resolution = readStoredResolutions(rawResolution(fx, cycleId)).routine_reviewer!;
    const otherGoal = seed(fx.db, roundRobin, 'Other');
    const foreign = insertCycle(otherGoal);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as RouteResolutionError).code;
      }
      return 'no error';
    };
    expect(
      code(() => persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId: foreign, resolution })),
    ).toBe('cycle_goal_mismatch');
    finish(fx, cycleId);
    const milestone: RoleResolution = { ...resolution, role: 'milestone_reviewer' };
    expect(
      code(() => persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId, resolution: milestone })),
    ).toBe('cycle_terminal');
    expect(
      code(() =>
        resolveRolesForCycle(fx.db, {
          goalId: fx.goalId,
          cycleId,
          roles: ['milestone_reviewer'],
          environment: environmentFor(fx),
        }),
      ),
    ).toBe('cycle_terminal');
  });

  it('fails closed on corrupt stored JSON in the current cycle', () => {
    const fx = fixture(roundRobin);
    const cycleId = insertCycle(fx, { resolution: 'not json' });
    expect(() =>
      resolveRolesForCycle(fx.db, {
        goalId: fx.goalId,
        cycleId,
        roles: ['routine_reviewer'],
        environment: environmentFor(fx),
      }),
    ).toThrow(expect.objectContaining({ code: 'route_resolution_corrupt' }));
    expect(rawResolution(fx, cycleId)).toBe('not json');
  });
});

describe('round robin derived from persisted resolutions', () => {
  it('rotates across cycles from history alone, ignoring malformed historical rows, and a dry run never advances it', () => {
    const fx = fixture(roundRobin);
    const run = (cycleId: string) =>
      selected(
        resolveRolesForCycle(fx.db, {
          goalId: fx.goalId,
          cycleId,
          roles: ['routine_reviewer'],
          environment: environmentFor(fx, [], cycleId),
        }).roles.routine_reviewer,
      );
    const dry = () =>
      selected(
        previewGoalRoutes(fx.db, {
          goalId: fx.goalId,
          environment: environmentFor(fx),
          roles: ['routine_reviewer'],
        }).result.roles.routine_reviewer,
      );

    expect(dry()).toBe('rev-a');
    expect(dry()).toBe('rev-a');
    const c1 = insertCycle(fx);
    expect(run(c1)).toBe('rev-a');
    finish(fx, c1);
    // Malformed historical rows establish no cursor authority and do not crash routing.
    for (const junk of ['not json', '{"roles":{"routine_reviewer":{"schema":1}}}', '{"roles":5}', '[]']) {
      const id = insertCycle(fx, { resolution: junk });
      finish(fx, id);
    }
    expect(loadPriorResolutions(fx.db, fx.goalId)).toHaveLength(1);
    expect(dry()).toBe('rev-b');
    expect(dry()).toBe('rev-b');
    const c2 = insertCycle(fx);
    expect(run(c2)).toBe('rev-b');
    finish(fx, c2);
    const c3 = insertCycle(fx);
    expect(run(c3)).toBe('rev-c');
    finish(fx, c3);
    const c4 = insertCycle(fx);
    expect(run(c4)).toBe('rev-a');
    // A selection that later fails still counts: history is the resolution, not the outcome.
    fx.db
      .prepare("UPDATE goal_cycles SET status = 'failed', finished_at = ? WHERE id = ?")
      .run(hoursAgo(0), c4);
    expect(dry()).toBe('rev-b');
  });

  it('does not repair historical rows while resolving', () => {
    const fx = fixture(roundRobin);
    const bad = insertCycle(fx, { resolution: 'not json', status: 'succeeded' });
    const cycle = insertCycle(fx);
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId: cycle,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx),
    });
    expect(rawResolution(fx, bad)).toBe('not json');
  });
});

const COMMIT = (n: number) => String(n).repeat(40).slice(0, 40);

/** Ends a cycle the way the supervisor ends an integrated one: succeeded + result commit + an applied advance op. */
function integrate(fx: Fixture, cycleId: string, commit = COMMIT(1), opCommit = commit) {
  fx.db
    .prepare(
      "UPDATE goal_cycles SET status = 'succeeded', result_integration_commit = ?, outcome_json = ?, finished_at = ? WHERE id = ?",
    )
    .run(commit, JSON.stringify({ code: 'integrated' }), NOW, cycleId);
  const opId = randomUUID();
  fx.db
    .prepare(
      `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, run_id, op, expected_old, new_commit, status, checks_json, created_at)
       VALUES (?, ?, ?, NULL, 'advance', NULL, ?, 'planned', '{}', ?)`,
    )
    .run(opId, fx.goalId, cycleId, opCommit, NOW);
  fx.db
    .prepare("UPDATE goal_integration_ops SET status = 'applied', finished_at = ? WHERE id = ?")
    .run(NOW, opId);
}
/** Ends a cycle without integrating anything. */
function endWithout(fx: Fixture, cycleId: string, status: string, code: string) {
  fx.db
    .prepare('UPDATE goal_cycles SET status = ?, outcome_json = ?, finished_at = ? WHERE id = ?')
    .run(status, JSON.stringify({ code }), NOW, cycleId);
}

describe('authority set for independence', () => {
  const resolved = (fx: Fixture, kind: 'execution' | 'remediation', roles: GoalRole[]) => {
    const id = insertCycle(fx, { kind });
    resolveRolesForCycle(fx.db, { goalId: fx.goalId, cycleId: id, roles, environment: environmentFor(fx) });
    return id;
  };
  const authority = (fx: Fixture) =>
    loadAuthoritySet(fx.db, fx.goalId, ['implementer', 'remediation', 'orchestrator']);

  it('derives implementer, remediation and orchestrator models from integrated cycles and resolved telemetry', () => {
    const fx = fixture();
    validateAll(fx);
    const exec = resolved(fx, 'execution', ['orchestrator', 'implementer']);
    integrate(fx, exec, COMMIT(1));
    const fix = resolved(fx, 'remediation', ['implementer']);
    integrate(fx, fix, COMMIT(2));
    // Telemetry: the execution run reported a different underlying model than configured.
    fx.db.pragma('foreign_keys = OFF');
    fx.db
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at, goal_cycle_id, goal_run_purpose)
         VALUES ('run-1', 'm', 'p', 'w', '{}', 'x', 'economy', 'normal', 'completed', ?, ?, 'execution')`,
      )
      .run(NOW, exec);
    fx.db
      .prepare(
        "INSERT INTO usage_events (id, occurred_at, run_id, provenance, resolved_model_id) VALUES ('u1', ?, 'run-1', 'reported', 'openai/gpt-5')",
      )
      .run(NOW);
    fx.db.pragma('foreign_keys = ON');
    expect(authority(fx)).toEqual([
      { role: 'orchestrator', configuredModelId: 'orch', resolvedModelId: null, identityKind: 'pinned' },
      {
        role: 'implementer',
        configuredModelId: 'impl',
        resolvedModelId: 'openai/gpt-5',
        identityKind: 'pinned',
      },
      { role: 'remediation', configuredModelId: 'impl', resolvedModelId: null, identityKind: 'pinned' },
    ]);
    // The default policy leaves the orchestrator out.
    expect(
      loadAuthoritySet(fx.db, fx.goalId, ['implementer', 'remediation']).map((entry) => entry.role),
    ).toEqual(['implementer', 'remediation']);
    // Authority whose telemetry contradicts its configured id leaves independence unproven: no final review route.
    const preview = previewGoalRoutes(fx.db, {
      goalId: fx.goalId,
      environment: environmentFor(fx),
      roles: ['final_reviewer'],
    });
    expect(preview.result.roles.final_reviewer).toMatchObject({
      status: 'refused',
      code: 'independence_unestablished',
    });
  });

  it('includes only work that entered the Goal: failed, cancelled, no-change, scope-violating and rejected cycles do not count', () => {
    // Each cycle's implementer rotates to a distinct model so every excluded cycle would be visible if it leaked in.
    const fx = fixture((definition) => {
      definition.limits.humanGates.poolRouteFirstUse = false;
      const template = definition.routing.pools[0]!.members[0]!;
      definition.routing.pools.push({
        id: 'impls',
        label: 'Implementers',
        members: XS.map((modelId) => ({
          ...template,
          configuration: { ...template.configuration, modelId },
        })),
        admission: 'static',
        availability: 'live-catalog',
        requireRoleValidation: false,
        selection: 'round_robin',
        laneClass: 'subscription',
        autoRevalidate: false,
      });
      definition.routing.roles.implementer = { kind: 'pool', poolId: 'impls' };
    });
    validateAll(fx);
    const attempt = (kind: 'execution' | 'remediation', finish: (cycleId: string) => void) => {
      const id = insertCycle(fx, { kind });
      const result = resolveRolesForCycle(fx.db, {
        goalId: fx.goalId,
        cycleId: id,
        roles:
          kind === 'execution' && countOf(fx.db, 'goal_cycles') === 1
            ? ['orchestrator', 'implementer']
            : ['implementer'],
        environment: environmentFor(fx, [], id),
      });
      finish(id);
      return selected(result.roles.implementer);
    };
    expect(attempt('execution', (id) => integrate(fx, id, COMMIT(1)))).toBe('x1');
    expect(attempt('execution', (id) => endWithout(fx, id, 'failed', 'run_failed'))).toBe('x2');
    expect(attempt('execution', (id) => endWithout(fx, id, 'cancelled', 'cancelled'))).toBe('x3');
    expect(attempt('execution', (id) => endWithout(fx, id, 'failed', 'no_change'))).toBe('x4');
    expect(attempt('execution', (id) => endWithout(fx, id, 'failed', 'scope_violation'))).toBe('x5');
    expect(attempt('execution', (id) => endWithout(fx, id, 'failed', 'integration_rejected'))).toBe('x6');
    // Succeeded with no applied advance op, or with an op for another commit, is not integrated work either.
    expect(
      attempt('execution', (id) =>
        fx.db
          .prepare(
            "UPDATE goal_cycles SET status = 'succeeded', result_integration_commit = ?, outcome_json = ?, finished_at = ? WHERE id = ?",
          )
          .run(COMMIT(3), JSON.stringify({ code: 'integrated' }), NOW, id),
      ),
    ).toBe('x7');
    expect(attempt('execution', (id) => integrate(fx, id, COMMIT(5), COMMIT(4)))).toBe('x8');
    // A remediation that integrated counts, as the remediation role.
    expect(attempt('remediation', (id) => integrate(fx, id, COMMIT(6)))).toBe('x1');
    expect(authority(fx).map((entry) => `${entry.role}:${entry.configuredModelId}`)).toEqual([
      'orchestrator:orch',
      'implementer:x1',
      'remediation:x1',
    ]);
  });

  it('does not let a failed or no-change cycle poison final-review independence', () => {
    // The implementer rotates glm -> claude. The glm attempt changed nothing; only claude's work entered the Goal.
    const fx = fixture((definition) => {
      definition.limits.humanGates.poolRouteFirstUse = false;
      const template = definition.routing.pools[0]!.members[0]!;
      const at = (modelId: string) => ({
        ...template,
        configuration: { ...template.configuration, modelId },
      });
      definition.routing.pools.push({
        id: 'impls',
        label: 'Implementers',
        members: [at('glm-4.6'), at('claude-sonnet-4-5')],
        admission: 'static',
        availability: 'live-catalog',
        requireRoleValidation: false,
        selection: 'round_robin',
        laneClass: 'subscription',
        autoRevalidate: false,
      });
      definition.routing.roles.implementer = { kind: 'pool', poolId: 'impls' };
      (
        definition.routing.roles.final_reviewer as { member: { configuration: { modelId: string } } }
      ).member.configuration.modelId = 'glm-4.6';
    });
    validateAll(fx);
    const attempt = (finish: (cycleId: string) => void) => {
      const id = insertCycle(fx, { kind: 'execution' });
      const result = resolveRolesForCycle(fx.db, {
        goalId: fx.goalId,
        cycleId: id,
        roles: ['implementer'],
        environment: environmentFor(fx, [], id),
      });
      finish(id);
      return selected(result.roles.implementer);
    };
    expect(attempt((id) => endWithout(fx, id, 'failed', 'no_change'))).toBe('glm-4.6');
    expect(attempt((id) => integrate(fx, id))).toBe('claude-sonnet-4-5');
    expect(authority(fx).map((entry) => entry.configuredModelId)).toEqual(['claude-sonnet-4-5']);
    const final = previewGoalRoutes(fx.db, {
      goalId: fx.goalId,
      environment: environmentFor(fx),
      roles: ['final_reviewer'],
    }).result.roles.final_reviewer as { status: string; resolution: RoleResolution };
    expect(final.status).toBe('resolved');
    expect(final.resolution.independence).toMatchObject({ established: true, reasonCode: 'established' });
  });
});

describe('stored validation rows authenticate themselves', () => {
  it('ignores forged, inconsistent and malformed rows and lets a valid pass control', () => {
    const fx = fixture();
    const snapshot = { providers: providers(), profiles: [] };
    const route = fx.definition.routing.roles.implementer;
    if (route?.kind !== 'pinned') throw new Error('pinned implementer expected');
    const good = passRecords(route.member, 'implementer', snapshot);
    seedValidations(fx, good);
    const base = good[0]!;
    const seal = (identity: unknown) => createHash('sha256').update(canonicalJson(identity)).digest('hex');
    const forged: Array<ReturnType<typeof passRecords>[number]> = [
      { ...base, id: 'f1', identityHash: 'f'.repeat(64) },
      { ...base, id: 'f2', identity: { ...base.identity, modelId: 'other' } },
      { ...base, id: 'f3', adapterVersion: '0.0.0' },
      { ...base, id: 'f4', capabilityFingerprint: 'e'.repeat(64) },
      (() => {
        const rest = { ...base.identity };
        delete rest.variantId;
        return { ...base, id: 'f5', identity: rest, identityHash: seal(rest) };
      })(),
      {
        ...base,
        id: 'f6',
        identity: { ...base.identity, schema: 2 },
        identityHash: seal({ ...base.identity, schema: 2 }),
      },
    ].map((record) => ({ ...record, status: 'fail' as const, testedAt: hoursAgo(0.5) }));
    seedValidations(fx, forged);
    expect(countOf(fx.db, 'route_validations')).toBe(good.length + forged.length);
    const identity = identityOf(route.member, snapshot);
    const read = readRouteValidations(fx.db, [identity.identityHash], [route.member.configuration.modelId!]);
    expect(read.map((record) => record.id).sort()).toEqual(good.map((record) => record.id).sort());
    insertCycle(fx);
    const preview = previewGoalRoutes(fx.db, { goalId: fx.goalId, environment: environmentFor(fx) });
    expect(selected(preview.result.roles.implementer)).toBe('impl');
  });
});

describe('persistence re-proves approvals, validations and membership against canonical SQLite', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as RouteResolutionError).code;
    }
    return 'no error';
  };
  const approve = (
    fx: Fixture,
    poolId: string,
    memberIdentityHash: string,
    over: Record<string, unknown> = {},
  ) => {
    const id = randomUUID();
    const row = {
      goal_id: fx.goalId,
      gate: 'pool_route_first_use',
      status: 'approved',
      decided_by: 'user',
      ...over,
    };
    fx.db
      .prepare(
        `INSERT INTO goal_approvals (id, goal_id, gate, risk, reason, requested_by, detail_json, status, decided_by, decision_note, created_at, responded_at)
         VALUES (?, ?, ?, 'low', 'first use', 'supervisor', ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(id, row.goal_id, row.gate, JSON.stringify({ poolId, memberIdentityHash }), hoursAgo(2));
    if (row.status !== 'pending')
      fx.db
        .prepare('UPDATE goal_approvals SET status = ?, decided_by = ?, responded_at = ? WHERE id = ?')
        .run(row.status, row.decided_by, hoursAgo(1), id);
    return id;
  };
  const gatedFixture = () => {
    const fx = fixture();
    validateAll(fx);
    const cycleId = insertCycle(fx);
    const snapshot = { providers: providers(), profiles: [] };
    const first = fx.definition.routing.pools[0]!.members[0]!;
    const memberHash = identityOf(first, snapshot).identityHash;
    return { fx, cycleId, snapshot, memberHash, first };
  };
  const computed = (fx: Fixture, role: GoalRole): RoleResolution => {
    const outcome = previewGoalRoutes(fx.db, {
      goalId: fx.goalId,
      environment: environmentFor(fx),
      roles: [role],
    }).result.roles[role] as { status: string; resolution: RoleResolution; code?: string };
    if (outcome.status !== 'resolved') throw new Error(`fixture must resolve ${role}: ${outcome.code}`);
    return outcome.resolution;
  };
  const persist = (fx: Fixture, cycleId: string, resolution: RoleResolution) =>
    persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId, resolution });
  const withApproval = (resolution: RoleResolution, approvalId: string): RoleResolution => {
    const draft = structuredClone(resolution);
    draft.approval.approvalId = approvalId;
    draft.evaluatedMembers[draft.selectedIndex]!.firstUse.approvalId = approvalId;
    return draft;
  };

  it('accepts a resolution whose approval is the real user approval for this pool member', () => {
    const { fx, cycleId, memberHash } = gatedFixture();
    const real = approve(fx, 'reviewers', memberHash);
    const resolution = computed(fx, 'routine_reviewer');
    expect(resolution.approval).toMatchObject({
      state: 'approved',
      approvalId: real,
      memberIdentityHash: memberHash,
    });
    expect(persist(fx, cycleId, resolution)).toEqual({ written: true });
    // Retry with the environment gone is served from the stored resolution.
    const again = resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId,
      roles: ['routine_reviewer'],
      environment: environmentFor(fx, ['rev-a', 'rev-b']),
    });
    expect(again.roles.routine_reviewer).toMatchObject({ status: 'resolved', source: 'persisted' });
  });

  it('never makes a fabricated or mis-bound approval id durable authority', () => {
    const { fx, cycleId, memberHash } = gatedFixture();
    approve(fx, 'reviewers', memberHash);
    const resolution = computed(fx, 'routine_reviewer');
    const before = rawResolution(fx, cycleId);
    const other = createGoalOther(fx);
    const bad: Record<string, string> = {
      fabricated: 'no-such-approval',
      'another member': approve(fx, 'reviewers', 'c'.repeat(64)),
      'another pool': approve(fx, 'other-pool', memberHash),
      'a system denial': approve(fx, 'reviewers', memberHash, { status: 'denied', decided_by: 'system' }),
      denied: approve(fx, 'reviewers', memberHash, { status: 'denied' }),
      pending: approve(fx, 'reviewers', memberHash, { status: 'pending', decided_by: null }),
      'another gate': approve(fx, 'reviewers', memberHash, { gate: 'scope_change' }),
      'another goal': approve(other, 'reviewers', memberHash),
    };
    for (const [name, id] of Object.entries(bad))
      expect(
        code(() => persist(fx, cycleId, withApproval(resolution, id))),
        name,
      ).toBe('resolution_invalid');
    // not_required must carry no approval reference at all.
    const orchestrator = computed(fx, 'orchestrator');
    const forgedNotRequired = structuredClone(orchestrator);
    forgedNotRequired.approval.approvalId = 'ghost';
    expect(code(() => persist(fx, cycleId, forgedNotRequired))).toBe('resolution_invalid');
    expect(rawResolution(fx, cycleId)).toBe(before);
  });

  const withValidationIds = (
    resolution: RoleResolution,
    replace: (id: string, profile: string) => string,
  ) => {
    const draft = structuredClone(resolution);
    const entry = draft.evaluatedMembers[draft.selectedIndex]!;
    for (const state of entry.validation.profiles)
      if (state.recordId) state.recordId = replace(state.recordId, state.profile);
    draft.validationRecordIds = entry.validation.profiles.map((state) => state.recordId!);
    return draft;
  };

  it('never makes an invented or mismatched validation id durable authority', () => {
    const { fx, cycleId, snapshot } = gatedFixture();
    const resolution = computed(fx, 'implementer');
    expect(resolution.validationRecordIds).toHaveLength(2);
    const route = fx.definition.routing.roles.implementer;
    if (route?.kind !== 'pinned') throw new Error('pinned expected');
    // Rows that exist but must not satisfy this resolution.
    const otherIdentity = passRecords(
      fx.definition.routing.roles.orchestrator!.kind === 'pinned'
        ? (fx.definition.routing.roles.orchestrator as { member: never }).member
        : (undefined as never),
      'implementer',
      snapshot,
    );
    const wrongProfile = passRecords(route.member, 'routine_reviewer', snapshot).filter(
      (r) => r.profile === 'review-json',
    );
    const failed = passRecords(route.member, 'implementer', snapshot, {
      status: 'fail',
      testedAt: hoursAgo(0.1),
    }).slice(0, 1);
    for (const [index, record] of [...wrongProfile, ...failed].entries()) record.id = `extra-${index}`;
    seedValidations(fx, [
      ...otherIdentity.map((r, i) => ({ ...r, id: `oi-${i}` })),
      ...wrongProfile,
      ...failed,
    ]);
    const swapFirst = (id: string) => (draft: RoleResolution) =>
      withValidationIds(draft, (current, profile) =>
        profile === resolution.evaluatedMembers[0]!.validation.profiles[0]!.profile ? id : current,
      );
    const cases: Record<string, RoleResolution> = {
      'a fabricated id': swapFirst('rec-ghost')(resolution),
      'an id of another identity': swapFirst('oi-0')(resolution),
      'an id of a profile the role does not use': swapFirst('extra-0')(resolution),
      'an id of a failing record': swapFirst(`extra-${wrongProfile.length}`)(resolution),
    };
    for (const [name, candidate] of Object.entries(cases))
      expect(
        code(() => persist(fx, cycleId, candidate)),
        name,
      ).toBe('resolution_invalid');
    // Claiming ids the audit does not list, or listing none, is also refused.
    const extraId = structuredClone(resolution);
    extraId.validationRecordIds = [...extraId.validationRecordIds, 'oi-0'];
    expect(code(() => persist(fx, cycleId, extraId))).toBe('resolution_invalid');
    const noIds = structuredClone(resolution);
    noIds.validationRecordIds = [];
    expect(code(() => persist(fx, cycleId, noIds))).toBe('resolution_invalid');
    expect(rawResolution(fx, cycleId)).toBeNull();
    expect(persist(fx, cycleId, resolution)).toEqual({ written: true });
  });

  it('refuses a structurally valid resolution that is not the approved member', () => {
    const { fx, cycleId } = gatedFixture();
    const resolution = computed(fx, 'implementer');
    const wrongRole = { ...resolution, role: 'orchestrator' as const };
    const moved = structuredClone(resolution);
    moved.selected.configuration.modelId = 'rev-a';
    moved.selected.memberConfigHash = memberConfigHashOf(moved.selected.configuration);
    const kind = structuredClone(resolution);
    kind.selected.identityKind = 'floating';
    const pooled = structuredClone(resolution);
    pooled.routeKind = 'pool';
    pooled.poolId = 'reviewers';
    const sel = structuredClone(resolution);
    sel.selection = 'ordered';
    for (const candidate of [wrongRole, moved, kind, pooled, sel])
      expect(code(() => persist(fx, cycleId, candidate))).toBe('resolution_invalid');
    expect(rawResolution(fx, cycleId)).toBeNull();
  });

  it('refuses a stored malformed or corrupted current-cycle entry instead of recomputing over it', () => {
    const { fx, memberHash, cycleId: open } = gatedFixture();
    approve(fx, 'reviewers', memberHash);
    const good = computed(fx, 'routine_reviewer');
    endWithout(fx, open, 'cancelled', 'cancelled');
    const store = (resolution: unknown) =>
      JSON.stringify({ schema: 1, roles: { routine_reviewer: resolution } });
    const malformed = structuredClone(good);
    (malformed.evaluatedMembers[0]!.reasons as string[]) = ['arbitrary provider text'];
    const corrupted = structuredClone(good);
    corrupted.selected.configuration.modelId = 'rev-b';
    for (const stored of [malformed, corrupted, 'junk']) {
      const cycleId = insertCycle(fx, { resolution: store(stored) });
      const outcome = resolveRolesForCycle(fx.db, {
        goalId: fx.goalId,
        cycleId,
        roles: ['routine_reviewer'],
        environment: environmentFor(fx),
      });
      expect(outcome.roles.routine_reviewer).toMatchObject({
        status: 'refused',
        code: 'persisted_resolution_invalid',
      });
      expect(rawResolution(fx, cycleId)).toBe(store(stored));
      endWithout(fx, cycleId, 'cancelled', 'cancelled');
    }
  });

  it('refuses an over-size audit instead of trimming it', () => {
    const fx = fixture((definition) => {
      definition.limits.humanGates.poolRouteFirstUse = false;
      const reviewers = definition.routing.pools[0]!;
      reviewers.availability = 'live-catalog';
      reviewers.requireRoleValidation = false;
      const template = reviewers.members[0]!;
      for (let index = 0; index < 150; index += 1)
        reviewers.members.push({
          ...template,
          configuration: { ...template.configuration, modelId: `extra-model-${index}` },
        });
    });
    const cycleId = insertCycle(fx);
    expect(() =>
      resolveRolesForCycle(fx.db, {
        goalId: fx.goalId,
        cycleId,
        roles: ['routine_reviewer'],
        environment: environmentFor(fx),
      }),
    ).toThrow(expect.objectContaining({ code: 'route_resolution_too_large' }));
    expect(rawResolution(fx, cycleId)).toBeNull();
    void MAX_ROUTE_RESOLUTION_JSON;
  });
});

function createGoalOther(fx: Fixture): Fixture {
  return seed(fx.db, undefined, 'Other goal');
}
