import type { Db } from '../db.js';
import {
  GOAL_ROLES,
  type GoalApproval,
  type GoalDefinitionVersion,
  type GoalRole,
  type IndependencePolicy,
} from '../../shared/goals.js';
import { canonicalJson } from './definitionHash.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import type { AuthorityModel } from './independence.js';
import { parseRoleResolution, type RoleResolution, type RoutingResult } from './routeAudit.js';
import { computeRouteIdentity, type ProfileObservation } from './routeIdentity.js';
import {
  ROLE_VALIDATION_PROFILES,
  readRouteValidations,
  recordFromRow,
  type ValidationRow,
} from './routeValidation.js';
import {
  reproveRoleResolution,
  resolveRoutes,
  type PriorRouteResolution,
  type RoutingEnvironment,
  type RoutingRequest,
} from './routing.js';
import type { ProviderStatus } from '../../shared/types.js';
import { isCycleTerminal, type CycleStatus } from './cycles.js';

/**
 * SQLite-facing side of routing: reads the stored snapshot parts (validations, first-use approvals, resolution
 * history), persists per-role resolutions write-once into `goal_cycles.route_resolution_json`, and offers the
 * read-only preview. The decision itself stays in the pure `resolveRoutes`.
 */

/** Total persisted audit size for one cycle. If a resolution cannot fit it is refused, never trimmed. */
export const MAX_ROUTE_RESOLUTION_JSON = 64_000;

export type RouteResolutionErrorCode =
  | 'goal_not_found'
  | 'cycle_not_found'
  | 'cycle_goal_mismatch'
  | 'cycle_terminal'
  | 'definition_mismatch'
  | 'resolution_invalid'
  | 'route_resolution_conflict'
  | 'route_resolution_corrupt'
  | 'route_resolution_too_large';

export class RouteResolutionError extends Error {
  constructor(
    readonly code: RouteResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RouteResolutionError';
  }
}

export interface StoredRouteResolutions {
  schema: 1;
  roles: Partial<Record<GoalRole, RoleResolution>>;
}

/** Lenient read: only structurally valid role entries count; anything else establishes nothing. */
export function readStoredResolutions(raw: string | null): Partial<Record<GoalRole, RoleResolution>> {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const roles = (value as { roles?: unknown }).roles;
  if (!roles || typeof roles !== 'object') return {};
  const result: Partial<Record<GoalRole, RoleResolution>> = {};
  for (const role of GOAL_ROLES) {
    const parsed = parseRoleResolution((roles as Record<string, unknown>)[role]);
    if (parsed && parsed.role === role) result[role] = parsed;
  }
  return result;
}

/** The current cycle's stored role entries: the proven-shape ones, and the roles whose entry is present but malformed. */
export function readCycleResolutions(raw: string | null): {
  valid: Partial<Record<GoalRole, RoleResolution>>;
  malformed: GoalRole[];
} {
  const valid = readStoredResolutions(raw);
  const malformed: GoalRole[] = [];
  if (raw) {
    try {
      const roles = (JSON.parse(raw) as { roles?: Record<string, unknown> } | null)?.roles;
      if (roles && typeof roles === 'object')
        for (const role of GOAL_ROLES) if (roles[role] !== undefined && !valid[role]) malformed.push(role);
    } catch {
      // unreadable JSON is reported as route_resolution_corrupt when something new is written
    }
  }
  return { valid, malformed };
}

interface CycleLookup {
  id: string;
  goal_id: string;
  definition_version: number | null;
  status: CycleStatus;
  route_resolution_json: string | null;
}

/**
 * Proves, from canonical SQLite, the approval and validation records a resolution cites. Returns a finite failure
 * code or null. Reads only: nothing is created, validated or refreshed.
 */
function proveDurableReferences(db: Db, goalId: string, resolution: RoleResolution): string | null {
  const { approval, selected } = resolution;
  if (approval.state === 'approved') {
    const row = db
      .prepare('SELECT goal_id, gate, status, decided_by, detail_json FROM goal_approvals WHERE id = ?')
      .get(approval.approvalId) as
      | { goal_id: string; gate: string; status: string; decided_by: string | null; detail_json: string }
      | undefined;
    if (
      !row ||
      row.goal_id !== goalId ||
      row.gate !== 'pool_route_first_use' ||
      row.status !== 'approved' ||
      row.decided_by !== 'user'
    )
      return 'approval_reference';
    let detail: { poolId?: unknown; memberIdentityHash?: unknown };
    try {
      detail = JSON.parse(row.detail_json) as typeof detail;
    } catch {
      return 'approval_reference';
    }
    if (
      !detail ||
      typeof detail !== 'object' ||
      detail.poolId !== resolution.poolId ||
      detail.memberIdentityHash !== selected.identityHash
    )
      return 'approval_reference';
  } else if (approval.approvalId !== null || approval.memberIdentityHash !== null)
    return 'approval_reference';

  const entry = resolution.evaluatedMembers[resolution.selectedIndex];
  for (const id of resolution.validationRecordIds) {
    const row = db.prepare('SELECT * FROM route_validations WHERE id = ?').get(id) as
      ValidationRow | undefined;
    const record = row ? recordFromRow(row) : null;
    const audited = entry?.validation.profiles.find((state) => state.recordId === id);
    if (
      !record ||
      record.identityHash !== selected.identityHash ||
      record.status !== 'pass' ||
      !ROLE_VALIDATION_PROFILES[resolution.role].includes(record.profile) ||
      audited?.profile !== record.profile
    )
      return 'validation_reference';
  }
  return null;
}

/**
 * Persists one role's resolution into the cycle. Each role entry is write-once: absent -> appended, identical ->
 * idempotent success, different -> `route_resolution_conflict`. Never replaces, never edits the definition.
 */
export function persistRoleResolution(
  db: Db,
  input: { goalId: string; cycleId: string; resolution: RoleResolution },
): { written: boolean } {
  const { resolution } = input;
  if (!parseRoleResolution(resolution))
    throw new RouteResolutionError('resolution_invalid', 'The route resolution is not well formed.');
  return db.transaction(() => {
    const goal = db
      .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
      .get(input.goalId) as { version: number | null } | undefined;
    if (!goal) throw new RouteResolutionError('goal_not_found', 'The Goal does not exist.');
    const cycle = db
      .prepare(
        'SELECT id, goal_id, definition_version, status, route_resolution_json FROM goal_cycles WHERE id = ?',
      )
      .get(input.cycleId) as CycleLookup | undefined;
    if (!cycle) throw new RouteResolutionError('cycle_not_found', 'The cycle does not exist.');
    if (cycle.goal_id !== input.goalId)
      throw new RouteResolutionError('cycle_goal_mismatch', 'The cycle belongs to another Goal.');
    if (isCycleTerminal(cycle.status))
      throw new RouteResolutionError('cycle_terminal', 'A finished cycle cannot take a route resolution.');
    if (goal.version === null || cycle.definition_version !== goal.version)
      throw new RouteResolutionError(
        'definition_mismatch',
        "The cycle is not on the Goal's current definition.",
      );
    const stored = loadDefinitionVersion(db, input.goalId, goal.version);
    if (
      !stored ||
      stored.status !== 'approved' ||
      !verifyDefinitionHash(stored) ||
      stored.definitionHash !== resolution.definitionHash ||
      stored.version !== resolution.definitionVersion
    )
      throw new RouteResolutionError(
        'definition_mismatch',
        'The resolution is not bound to the approved definition.',
      );

    // Write authority = read authority: the same semantic proof against the approved definition, then proof that every
    // approval and validation reference exists in canonical SQLite. In-memory environments are never durable evidence.
    const failure = reproveRoleResolution(
      {
        definitionVersion: stored.version,
        definitionHash: stored.definitionHash,
        routingPolicy: stored.definition.routing,
        limits: stored.definition.limits,
      },
      resolution.role,
      resolution,
    );
    if (failure)
      throw new RouteResolutionError(
        'resolution_invalid',
        `The resolution is not the approved route (${failure}).`,
      );
    const reference = proveDurableReferences(db, input.goalId, resolution);
    if (reference)
      throw new RouteResolutionError(
        'resolution_invalid',
        `The resolution cites evidence that does not exist (${reference}).`,
      );

    let roles: Partial<Record<GoalRole, unknown>> = {};
    if (cycle.route_resolution_json) {
      try {
        const parsed = JSON.parse(cycle.route_resolution_json) as StoredRouteResolutions;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.roles !== 'object' || !parsed.roles)
          throw new Error('shape');
        roles = parsed.roles;
      } catch {
        throw new RouteResolutionError(
          'route_resolution_corrupt',
          'The stored route resolution is unreadable.',
        );
      }
    }
    const existing = roles[resolution.role];
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(resolution)) return { written: false };
      throw new RouteResolutionError(
        'route_resolution_conflict',
        `The cycle already has a different ${resolution.role} route resolution.`,
      );
    }
    const next = JSON.stringify({ schema: 1, roles: { ...roles, [resolution.role]: resolution } });
    if (next.length > MAX_ROUTE_RESOLUTION_JSON)
      throw new RouteResolutionError(
        'route_resolution_too_large',
        'The route resolution audit is too large.',
      );
    db.prepare('UPDATE goal_cycles SET route_resolution_json = ? WHERE id = ?').run(next, input.cycleId);
    return { written: true };
  })();
}

// --- Snapshot readers ---------------------------------------------------------------------------------------------

/** Round-robin history: structurally valid persisted role resolutions of the Goal, in cycle order. */
export function loadPriorResolutions(
  db: Db,
  goalId: string,
  excludeCycleId?: string,
): PriorRouteResolution[] {
  const rows = db
    .prepare(
      'SELECT id, sequence, route_resolution_json FROM goal_cycles WHERE goal_id = ? ORDER BY sequence',
    )
    .all(goalId) as Array<{ id: string; sequence: number; route_resolution_json: string | null }>;
  const history: PriorRouteResolution[] = [];
  for (const row of rows) {
    if (row.id === excludeCycleId) continue;
    const roles = readStoredResolutions(row.route_resolution_json);
    for (const role of GOAL_ROLES) {
      const entry = roles[role];
      if (entry)
        history.push({
          cycleSequence: row.sequence,
          role,
          poolId: entry.poolId,
          selectedIdentityHash: entry.selected.identityHash,
          memberConfigHash: entry.selected.memberConfigHash,
        });
    }
  }
  return history;
}

/** Pool first-use approvals recorded for the Goal (read only; creating one is the supervisor's job in Stage 5B). */
export function loadFirstUseApprovals(db: Db, goalId: string): GoalApproval[] {
  const rows = db
    .prepare(
      "SELECT * FROM goal_approvals WHERE goal_id = ? AND gate = 'pool_route_first_use' ORDER BY created_at, rowid",
    )
    .all(goalId) as Array<Record<string, unknown>>;
  const approvals: GoalApproval[] = [];
  for (const row of rows) {
    try {
      const detail = JSON.parse(String(row.detail_json)) as unknown;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
      approvals.push({
        id: row.id as string,
        goalId: row.goal_id as string,
        gate: 'pool_route_first_use',
        risk: row.risk as GoalApproval['risk'],
        reason: row.reason as string,
        requestedBy: row.requested_by as GoalApproval['requestedBy'],
        detail: detail as Record<string, unknown>,
        status: row.status as GoalApproval['status'],
        decidedBy: row.decided_by as GoalApproval['decidedBy'],
        decisionNote: (row.decision_note as string | null) ?? null,
        createdAt: row.created_at as string,
        respondedAt: (row.responded_at as string | null) ?? null,
      });
    } catch {
      continue;
    }
  }
  return approvals;
}

/** Everything the stored parts of a RoutingEnvironment need; the provider/profile snapshot is supplied by the caller. */
export function loadStoredEnvironment(
  db: Db,
  input: {
    goalId: string;
    definition: GoalDefinitionVersion['definition'];
    now: string;
    providers: readonly ProviderStatus[];
    profiles: readonly ProfileObservation[];
    excludeCycleId?: string;
  },
): RoutingEnvironment {
  const snapshot = { providers: input.providers, profiles: input.profiles };
  const members = [
    ...Object.values(input.definition.routing.roles).flatMap((route) =>
      route?.kind === 'pinned' ? [route.member] : [],
    ),
    ...input.definition.routing.pools.flatMap((pool) => pool.members),
  ];
  const hashes: string[] = [];
  const models: string[] = [];
  for (const member of members) {
    const identity = computeRouteIdentity(member, snapshot);
    if (!identity.ok) continue;
    hashes.push(identity.value.identityHash);
    if (member.configuration.modelId) models.push(member.configuration.modelId);
  }
  return {
    now: input.now,
    providers: input.providers,
    profiles: input.profiles,
    validations: readRouteValidations(db, hashes, models),
    firstUseApprovals: loadFirstUseApprovals(db, input.goalId),
    priorResolutions: loadPriorResolutions(db, input.goalId, input.excludeCycleId),
  };
}

/**
 * The models that authored the Goal's work, from persisted role resolutions plus canonical usage telemetry
 * (`resolved_model_id`) where a run reported one. Reads only; creates nothing.
 */
export function loadAuthoritySet(
  db: Db,
  goalId: string,
  against: IndependencePolicy['against'],
): AuthorityModel[] {
  // Only work that actually entered the Goal's integration history is authority: a succeeded cycle that integrated a
  // result commit, proven by the applied `advance` op recorded for exactly that commit. Failed, cancelled, no-change,
  // scope-violating and rejected cycles authored nothing the final review must be independent of.
  const cycles = db
    .prepare(
      `SELECT c.id, c.kind, c.route_resolution_json FROM goal_cycles c
       WHERE c.goal_id = ? AND c.kind IN ('execution','remediation') AND c.status = 'succeeded'
         AND c.result_integration_commit IS NOT NULL
         AND CASE WHEN json_valid(c.outcome_json) THEN json_extract(c.outcome_json, '$.code') END = 'integrated'
         AND EXISTS (
           SELECT 1 FROM goal_integration_ops o
           WHERE o.goal_id = c.goal_id AND o.cycle_id = c.id AND o.op = 'advance' AND o.status = 'applied'
             AND o.new_commit = c.result_integration_commit)
       ORDER BY c.sequence`,
    )
    .all(goalId) as Array<{
    id: string;
    kind: 'execution' | 'remediation';
    route_resolution_json: string | null;
  }>;
  const resolvedFor = db.prepare(
    `SELECT u.resolved_model_id AS id FROM usage_events u JOIN runs r ON r.id = u.run_id
     WHERE r.goal_cycle_id = ? AND r.goal_run_purpose = ? AND u.resolved_model_id IS NOT NULL
     ORDER BY u.occurred_at DESC, u.rowid DESC LIMIT 1`,
  );
  const authority: AuthorityModel[] = [];
  const seen = new Set<string>();
  for (const cycle of cycles) {
    const roles = readStoredResolutions(cycle.route_resolution_json);
    const entries: Array<[AuthorityModel['role'], RoleResolution | undefined, string]> = [
      ['orchestrator', roles.orchestrator, 'proposal'],
      [cycle.kind === 'remediation' ? 'remediation' : 'implementer', roles.implementer, cycle.kind],
    ];
    for (const [role, resolution, purpose] of entries) {
      if (!resolution || !against.includes(role) || !resolution.selected.configuration.modelId) continue;
      const resolved = (resolvedFor.get(cycle.id, purpose) as { id: string } | undefined)?.id ?? null;
      const key = `${role}\u0000${resolution.selected.configuration.modelId}\u0000${resolved ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      authority.push({
        role,
        configuredModelId: resolution.selected.configuration.modelId,
        resolvedModelId: resolved,
        identityKind: resolution.selected.identityKind,
      });
    }
  }
  return authority;
}

// --- Services -----------------------------------------------------------------------------------------------------

function loadApproved(db: Db, goalId: string): GoalDefinitionVersion {
  const goal = db
    .prepare('SELECT current_definition_version AS version FROM goals WHERE id = ?')
    .get(goalId) as { version: number | null } | undefined;
  if (!goal) throw new RouteResolutionError('goal_not_found', 'The Goal does not exist.');
  const stored = goal.version === null ? undefined : loadDefinitionVersion(db, goalId, goal.version);
  if (!stored || stored.status !== 'approved' || !verifyDefinitionHash(stored))
    throw new RouteResolutionError('definition_mismatch', 'The Goal has no verified approved definition.');
  return stored;
}

function requestFor(
  stored: GoalDefinitionVersion,
  roles: readonly GoalRole[],
  environment: RoutingEnvironment,
  extra: Partial<RoutingRequest> = {},
): RoutingRequest {
  return {
    definitionVersion: stored.version,
    definitionHash: stored.definitionHash,
    routingPolicy: stored.definition.routing,
    limits: stored.definition.limits,
    roles,
    environment,
    ...extra,
  };
}

const definedRoles = (stored: GoalDefinitionVersion, roles?: readonly GoalRole[]): GoalRole[] =>
  GOAL_ROLES.filter((role) => stored.definition.routing.roles[role] && (!roles || roles.includes(role)));

/**
 * Read-only: resolves every role the approved definition routes (or the requested subset) against the supplied
 * environment. Writes nothing, requests no approval, refreshes nothing, validates nothing, queues nothing.
 */
export function previewGoalRoutes(
  db: Db,
  input: { goalId: string; environment: RoutingEnvironment; roles?: readonly GoalRole[] },
): { definitionVersion: number; definitionHash: string; result: RoutingResult } {
  const stored = loadApproved(db, input.goalId);
  const policy = stored.definition.routing.independence;
  const result = resolveRoutes(
    requestFor(stored, definedRoles(stored, input.roles), input.environment, {
      independenceContext: { authority: loadAuthoritySet(db, input.goalId, policy.against) },
    }),
  );
  return { definitionVersion: stored.version, definitionHash: stored.definitionHash, result };
}

/**
 * Resolves roles for a live cycle. A role the cycle already carries is re-proven and returned, never recomputed (so a
 * retry cannot rotate a pool twice); a newly computed resolution is persisted write-once. Creates no approval.
 */
export function resolveRolesForCycle(
  db: Db,
  input: { goalId: string; cycleId: string; roles: readonly GoalRole[]; environment: RoutingEnvironment },
): RoutingResult {
  const stored = loadApproved(db, input.goalId);
  const cycle = db
    .prepare(
      'SELECT id, goal_id, definition_version, status, route_resolution_json FROM goal_cycles WHERE id = ?',
    )
    .get(input.cycleId) as CycleLookup | undefined;
  if (!cycle) throw new RouteResolutionError('cycle_not_found', 'The cycle does not exist.');
  if (cycle.goal_id !== input.goalId)
    throw new RouteResolutionError('cycle_goal_mismatch', 'The cycle belongs to another Goal.');
  if (isCycleTerminal(cycle.status))
    throw new RouteResolutionError('cycle_terminal', 'A finished cycle cannot take a route resolution.');
  if (cycle.definition_version !== stored.version)
    throw new RouteResolutionError(
      'definition_mismatch',
      "The cycle is not on the Goal's current definition.",
    );
  const policy = stored.definition.routing.independence;
  const current = readCycleResolutions(cycle.route_resolution_json);
  const result = resolveRoutes(
    requestFor(stored, input.roles, input.environment, {
      persistedResolutions: current.valid,
      invalidPersistedRoles: current.malformed,
      independenceContext: { authority: loadAuthoritySet(db, input.goalId, policy.against) },
    }),
  );
  for (const outcome of Object.values(result.roles))
    if (outcome?.status === 'resolved' && outcome.source === 'computed')
      persistRoleResolution(db, {
        goalId: input.goalId,
        cycleId: input.cycleId,
        resolution: outcome.resolution,
      });
  return result;
}
