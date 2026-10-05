import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { GoalDefinition, GoalRole } from '../../shared/goals.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { approveDefinition, createGoalDraft } from './definitions.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';
import { readStoredResolutions } from './routeResolution.js';
import {
  MAX_ROUTE_RESOLUTION_JSON,
  RouteResolutionError,
  loadAuthoritySet,
  loadPriorResolutions,
  loadStoredEnvironment,
  persistRoleResolution,
  previewGoalRoutes,
  resolveRolesForCycle,
} from './routeResolution.js';
import type { RoleResolution } from './routeAudit.js';
import { identityOf, model, passRecords, provider } from './routingKit.js';
import { NOW, hoursAgo } from './routingKit.js';
import type { RoutingEnvironment } from './routing.js';

afterEach(cleanupTestDatabases);

const MODELS = ['orch', 'impl', 'final', 'rev-a', 'rev-b', 'rev-c'];
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
    expect(selected(roles.final_reviewer)).toBe('final');
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
    const stored = (() => {
      resolveRolesForCycle(fx.db, {
        goalId: fx.goalId,
        cycleId,
        roles: ['routine_reviewer'],
        environment: environmentFor(fx),
      });
      return readStoredResolutions(rawResolution(fx, cycleId)).routine_reviewer!;
    })();
    const before = rawResolution(fx, cycleId);
    const different: RoleResolution = {
      ...stored,
      selectedIndex: 1,
      selected: { ...stored.selected, configuration: { ...stored.selected.configuration, modelId: 'rev-b' } },
    };
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
    // Too large: a resolution carrying more audit than the cap is refused, not trimmed.
    const huge: RoleResolution = {
      ...other,
      evaluatedMembers: Array.from({ length: 400 }, () => resolution.evaluatedMembers[0]!),
    };
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_ROUTE_RESOLUTION_JSON);
    expect(code(() => persistRoleResolution(fx.db, { goalId: fx.goalId, cycleId, resolution: huge }))).toBe(
      'route_resolution_too_large',
    );
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

describe('authority set for independence', () => {
  it('derives implementer, remediation and orchestrator models from persisted resolutions and resolved telemetry', () => {
    const fx = fixture();
    validateAll(fx);
    const exec = insertCycle(fx, { kind: 'execution' });
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId: exec,
      roles: ['orchestrator', 'implementer'],
      environment: environmentFor(fx),
    });
    finish(fx, exec);
    const fix = insertCycle(fx, { kind: 'remediation' });
    resolveRolesForCycle(fx.db, {
      goalId: fx.goalId,
      cycleId: fix,
      roles: ['implementer'],
      environment: environmentFor(fx),
    });
    finish(fx, fix);
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
    const both = loadAuthoritySet(fx.db, fx.goalId, ['implementer', 'remediation', 'orchestrator']);
    expect(both).toEqual([
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
    // The preview resolves the final reviewer against this authority set.
    const preview = previewGoalRoutes(fx.db, {
      goalId: fx.goalId,
      environment: environmentFor(fx),
      roles: ['final_reviewer'],
    });
    const final = preview.result.roles.final_reviewer as { status: string; resolution: RoleResolution };
    expect(final.status).toBe('resolved');
    expect(final.resolution.independence).toMatchObject({
      established: false,
      reasonCode: 'identity_conflict',
      comparedAgainst: expect.arrayContaining([expect.objectContaining({ resolvedKey: 'gpt-5' })]),
    });
    const roles: GoalRole[] = [];
    void roles;
  });
});
