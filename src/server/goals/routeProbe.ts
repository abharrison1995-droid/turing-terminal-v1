import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { GOAL_ROLES, type GoalRole, type RouteMember, type ValidationProfile } from '../../shared/goals.js';
import {
  PROBE_COMMIT_STAGE_KEY,
  PROBE_FIXTURE,
  PROBE_PROFILE_ORDER,
  PROBE_STAGE_KEYS,
  PROBE_TASK,
  PROBE_WORKFLOW_ID,
} from '../../shared/routeProbe.js';
import type { ModelConfiguration, WorkflowDefinition } from '../../shared/types.js';
import { isModelBackedStage } from '../../shared/workflowKinds.js';
import type { Db } from '../db.js';
import { gitTry } from '../goalGit.js';
import { buildPreview, queueRun } from '../runLauncher.js';
import { canonicalJson } from './definitionHash.js';
import { routeMemberSchema } from './definitionValidation.js';
import { computeRouteIdentity, sha256, type RouteIdentity } from './routeIdentity.js';
import { judgeProfile, type ProfileVerdict } from './routeProbeChecks.js';
import { dataDirectory, ensureFixture, ensureFixtureProject, verifyFixture } from './routeProbeFixture.js';
import { FRESHNESS_WINDOW_MS, ROLE_VALIDATION_PROFILES } from './routeValidation.js';
import { observeRouteSnapshot } from './routingSnapshot.js';
import { canonicalNonRouteWorkflow, PLAN_ROUTE_FIELDS, registeredGoalWorkflow } from './turingExecutor.js';

/**
 * Route-validation probes (Goal Engine Stage 5B.1). A probe is a USER-INITIATED, ordinary, billed run of the reserved
 * `goal-probe-v1` workflow against the Turing-owned fixture repository, on exactly the route the user named. It is
 * persisted before any provider work (`route_validation_probes`, migration 021), survives a restart, and is consumed
 * from persisted run state alone into immutable `route_validations` rows by `reconcileRouteProbe`.
 *
 * Nothing here chooses, substitutes or falls back to a route, resolves a Goal route, refreshes a validation on its own,
 * or reads a credential. The identity is computed from the server's own provider/profile observation BEFORE the run is
 * queued; a hash, fingerprint, adapter version or provider claim from the caller is never accepted.
 */

// --- Request ----------------------------------------------------------------------------------------------------------

/**
 * The whole HTTP body. The member is parsed with the SAME schema the approved-definition validator uses, so any route a
 * definition can accept can be submitted for validation; nothing here keeps a smaller private copy of its limits. The
 * body itself stays bounded by the server's request limit. No identity hash, fingerprint, adapter version, model
 * snapshot or readiness claim exists in the (strict) schema.
 */
export const routeProbeRequestSchema = z
  .object({
    member: routeMemberSchema,
    roles: z
      .array(z.enum(GOAL_ROLES as unknown as [GoalRole, ...GoalRole[]]))
      .min(1)
      .max(GOAL_ROLES.length)
      .refine((roles) => new Set(roles).size === roles.length, { message: 'roles must be unique' }),
  })
  .strict();
export type RouteProbeRequest = z.infer<typeof routeProbeRequestSchema>;

/** The unique union of the profiles the roles require, derived from `ROLE_VALIDATION_PROFILES` and nothing else. */
export function profilesForRoles(roles: readonly GoalRole[]): ValidationProfile[] {
  const required = new Set(roles.flatMap((role) => ROLE_VALIDATION_PROFILES[role]));
  return PROBE_PROFILE_ORDER.filter((profile) => required.has(profile));
}

export type RouteProbeErrorCode =
  | 'route_incomplete'
  | 'identity_unresolved'
  | 'identity_changed'
  | 'fixture_unavailable'
  | 'preview_not_startable'
  | 'route_substituted'
  | 'workflow_invalid'
  | 'probe_in_progress'
  | 'probe_not_found';

export class RouteProbeError extends Error {
  constructor(
    readonly code: RouteProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RouteProbeError';
  }
}

// --- Workflow ---------------------------------------------------------------------------------------------------------

const ROUTE_KEYS: ReadonlySet<string> = new Set(PLAN_ROUTE_FIELDS);

/**
 * The registered `goal-probe-v1` with the exact route on every enabled model-backed stage, only the requested profile
 * stages enabled, and nothing else changed (proven against the registered definition). No modelSnapshot is supplied: the
 * ordinary preview observes it.
 */
export function probeWorkflow(
  db: Db,
  route: ModelConfiguration,
  profiles: readonly ValidationProfile[],
): WorkflowDefinition {
  for (const key of Object.keys(route))
    if (!ROUTE_KEYS.has(key)) throw new RouteProbeError('route_incomplete', `"${key}" is not a route field.`);
  if (!route.backendId || !route.providerId || !route.modelId || !route.billingLane)
    throw new RouteProbeError(
      'route_incomplete',
      'A probe route needs backendId, providerId, modelId and billingLane.',
    );
  const registered = registeredGoalWorkflow(db, PROBE_WORKFLOW_ID);
  const enabledKeys = new Set<string>(profiles.map((profile) => PROBE_STAGE_KEYS[profile]));
  if (profiles.includes('broker-edit')) enabledKeys.add(PROBE_COMMIT_STAGE_KEY);
  const known = new Set<string>([...Object.values(PROBE_STAGE_KEYS), PROBE_COMMIT_STAGE_KEY]);
  if (
    registered.stages.length !== known.size ||
    registered.stages.some((stage) => !known.has(stage.id)) ||
    !registered.isolatedWorktree ||
    registered.permissionMode === 'enigma' ||
    (registered.billingMode ?? 'subscriptions-only') !== 'subscriptions-only'
  )
    throw new RouteProbeError(
      'workflow_invalid',
      'The probe workflow is not the registered probe definition.',
    );
  const workflow: WorkflowDefinition = {
    ...registered,
    stages: registered.stages.map((stage) => {
      const copy: Record<string, unknown> = { ...stage, enabled: enabledKeys.has(stage.id) };
      if (isModelBackedStage(stage.kind)) {
        for (const key of PLAN_ROUTE_FIELDS) delete copy[key];
        for (const [key, value] of Object.entries(route)) if (value !== undefined) copy[key] = value;
      }
      return copy as unknown as typeof stage;
    }),
  };
  const normalize = (candidate: WorkflowDefinition) =>
    canonicalNonRouteWorkflow({
      ...candidate,
      stages: candidate.stages.map((stage) => ({ ...stage, enabled: true })),
    });
  if (normalize(workflow) !== normalize(registered))
    throw new RouteProbeError('workflow_invalid', 'The route changes more than the probe stage routes.');
  return workflow;
}

// --- Creation ---------------------------------------------------------------------------------------------------------

export interface RouteProbeStarted {
  probeId: string;
  runId: string;
  identityHash: string;
  profiles: ValidationProfile[];
}

type StartRun = (runId: string) => unknown;

/** The exact identity of a member against the server's own observation. Complete or refused: never partial. */
export async function captureRouteIdentity(db: Db, member: RouteMember): Promise<RouteIdentity> {
  const snapshot = await observeRouteSnapshot(db);
  const result = computeRouteIdentity(member, snapshot);
  if (!result.ok)
    throw new RouteProbeError(
      'route_incomplete',
      'The route needs backendId, providerId, modelId and billingLane.',
    );
  if (result.value.issues.length > 0 || !result.value.provider)
    throw new RouteProbeError(
      'identity_unresolved',
      `The route identity cannot be established: ${result.value.issues.join(', ') || 'provider_missing'}.`,
    );
  return result.value;
}

interface ProbeRow {
  id: string;
  run_id: string;
  identity_hash: string;
  identity_json: string;
  freshness_class: 'stable-subscription' | 'opportunity';
  profiles_json: string;
  fixture_commit: string;
  status: 'pending' | 'consumed' | 'failed';
  failure_code: string | null;
  created_at: string;
  completed_at: string | null;
  worktree_released_at: string | null;
}

const probeRow = (db: Db, probeId: string): ProbeRow | undefined =>
  db.prepare('SELECT * FROM route_validation_probes WHERE id = ?').get(probeId) as ProbeRow | undefined;

const probeProfiles = (row: ProbeRow): ValidationProfile[] => {
  const parsed = JSON.parse(row.profiles_json) as string[];
  return PROBE_PROFILE_ORDER.filter((profile) => parsed.includes(profile));
};

function pendingOverlap(db: Db, identityHash: string, profiles: readonly ValidationProfile[]): boolean {
  const rows = db
    .prepare(
      "SELECT profiles_json FROM route_validation_probes WHERE identity_hash = ? AND status = 'pending'",
    )
    .all(identityHash) as Array<{ profiles_json: string }>;
  return rows.some((row) =>
    (JSON.parse(row.profiles_json) as string[]).some((p) => profiles.includes(p as never)),
  );
}

const asRecord = (value: unknown) => (value ?? {}) as Record<string, unknown>;

/**
 * Creates a probe. Everything that can be refused is refused before anything is written, so a refused request leaves no
 * run and no probe. The run and the probe row are persisted in ONE transaction; the run is started only afterwards (and,
 * if that start fails, the reconciler starts it: a queued probe run is never lost).
 */
export async function createRouteProbe(
  db: Db,
  request: RouteProbeRequest,
  startRun: StartRun,
): Promise<RouteProbeStarted> {
  const member = request.member as RouteMember;
  const profiles = profilesForRoles(request.roles);
  const fixture = await ensureFixture();
  if (!fixture.ok || !ensureFixtureProject(db, fixture.path))
    throw new RouteProbeError(
      'fixture_unavailable',
      'The route-validation fixture repository is unavailable.',
    );
  const identity = await captureRouteIdentity(db, member);
  if (pendingOverlap(db, identity.identityHash, profiles))
    throw new RouteProbeError('probe_in_progress', 'A probe for this exact route is already in progress.');

  const workflow = probeWorkflow(db, member.configuration, profiles);
  const preview = await buildPreview(
    db,
    { task: PROBE_TASK, projectId: PROBE_FIXTURE.projectId, workflowId: PROBE_WORKFLOW_ID },
    workflow,
  );
  if (!preview)
    throw new RouteProbeError('workflow_invalid', 'The probe workflow or fixture project is not registered.');
  if (!preview.canStart)
    throw new RouteProbeError(
      'preview_not_startable',
      `The probe run cannot start: ${preview.warnings.slice(0, 3).join(' | ')}`.slice(0, 400),
    );
  // The preview must carry exactly the pinned route on every enabled model-backed stage.
  for (const stage of preview.workflow.stages) {
    if (stage.enabled === false || !isModelBackedStage(stage.kind)) continue;
    const mismatch = Object.entries(member.configuration).some(
      ([key, value]) =>
        value !== undefined &&
        key !== 'modelDisplayName' &&
        JSON.stringify(asRecord(stage)[key]) !== JSON.stringify(value),
    );
    if (mismatch) throw new RouteProbeError('route_substituted', 'The preview did not keep the exact route.');
  }
  // The identity is captured again after the preview: a provider that changed in between is refused, not mixed.
  const again = await captureRouteIdentity(db, member);
  if (again.identityHash !== identity.identityHash)
    throw new RouteProbeError('identity_changed', 'The route identity changed while the probe was prepared.');
  const stillGood = await verifyFixture(fixture.path);
  if (!stillGood.ok)
    throw new RouteProbeError(
      'fixture_unavailable',
      'The route-validation fixture repository is unavailable.',
    );

  const probeId = randomUUID();
  const now = new Date().toISOString();
  const { runId } = db.transaction(() => {
    if (pendingOverlap(db, identity.identityHash, profiles))
      throw new RouteProbeError('probe_in_progress', 'A probe for this exact route is already in progress.');
    const queued = queueRun(db, preview, {
      eventType: 'route_probe_queued',
      eventDetails: { probeId, profiles },
    });
    db.prepare(
      `INSERT INTO route_validation_probes (id, run_id, identity_hash, identity_json, freshness_class, profiles_json,
         fixture_commit, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      probeId,
      queued.runId,
      identity.identityHash,
      canonicalJson(identity.identity),
      member.freshnessClass,
      JSON.stringify(profiles),
      fixture.commit,
      now,
    );
    return queued;
  })();
  // The same pre-start proof as the reconciler: the persisted identity must still be the identity about to execute.
  // A failed start leaves the persisted queued run for the reconciler.
  const persisted = probeRow(db, probeId);
  if (persisted) await startProbe(db, persisted, startRun, () => new Date().toISOString());
  return { probeId, runId, identityHash: identity.identityHash, profiles };
}

// --- The one authoritative validation-record writer --------------------------------------------------------------------

function resolvedModelFor(db: Db, runId: string, stageKey: string): string | null {
  const row = db
    .prepare(
      `SELECT u.resolved_model_id AS id FROM usage_events u JOIN stages s ON s.id = u.stage_id
       WHERE u.run_id = ? AND s.stage_key = ? AND u.resolved_model_id IS NOT NULL
       ORDER BY u.occurred_at DESC, u.rowid DESC LIMIT 1`,
    )
    .get(runId, stageKey) as { id: string } | undefined;
  return row?.id ?? null;
}

/** When the profile's stage finished, from persisted state, so a replay after a crash writes the identical timestamp. */
function testedAtFor(db: Db, probe: ProbeRow, stageKey: string, now: string): string {
  const stage = db
    .prepare('SELECT finished_at FROM stages WHERE run_id = ? AND stage_key = ?')
    .get(probe.run_id, stageKey) as { finished_at: string | null } | undefined;
  const run = db.prepare('SELECT completed_at FROM runs WHERE id = ?').get(probe.run_id) as
    { completed_at: string | null } | undefined;
  const candidate = [stage?.finished_at, run?.completed_at, probe.created_at].find(
    (value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)),
  )!;
  // A record is never dated in the future, and never before the probe existed.
  const clamped = Math.min(Date.parse(now), Math.max(Date.parse(candidate), Date.parse(probe.created_at)));
  return new Date(clamped).toISOString();
}

/**
 * Writes the validation record of ONE profile of ONE probe, at most once. The identity is the server-captured identity
 * stored on the probe: the hash is recomputed from it here and never taken from outside, adapter version and capability
 * fingerprint are copied from it, and provenance is fixed. Returns false when the record already exists.
 */
export function writeProbeRecord(
  db: Db,
  probeId: string,
  profile: ValidationProfile,
  verdict: ProfileVerdict,
  now = new Date().toISOString(),
): boolean {
  return db.transaction(() => {
    const probe = probeRow(db, probeId);
    if (!probe) throw new RouteProbeError('probe_not_found', 'No such probe.');
    if (!probeProfiles(probe).includes(profile))
      throw new Error('The profile was not requested by this probe.');
    const identity = JSON.parse(probe.identity_json) as {
      adapterVersion: string;
      capabilityFingerprint: string;
    };
    const identityHash = sha256(canonicalJson(identity));
    if (identityHash !== probe.identity_hash)
      throw new Error('The probe identity does not authenticate itself.');
    const existing = db
      .prepare('SELECT 1 FROM route_validations WHERE evidence_run_id = ? AND profile = ?')
      .get(probe.run_id, profile);
    if (existing) return false;
    const stageKey = PROBE_STAGE_KEYS[profile];
    const testedAt = testedAtFor(db, probe, stageKey, now);
    const expiresAt = new Date(
      Date.parse(testedAt) + FRESHNESS_WINDOW_MS[probe.freshness_class],
    ).toISOString();
    db.prepare(
      `INSERT INTO route_validations (id, identity_hash, identity_json, profile, status, evidence_run_id,
         resolved_model_reported, checks_json, provenance, adapter_version, capability_fingerprint, tested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'turing_probe_run', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      identityHash,
      probe.identity_json,
      profile,
      verdict.status,
      probe.run_id,
      resolvedModelFor(db, probe.run_id, stageKey),
      JSON.stringify({ schema: 1, checks: verdict.checks }),
      identity.adapterVersion,
      identity.capabilityFingerprint,
      testedAt,
      expiresAt,
    );
    return true;
  })();
}

// --- Reconciliation ---------------------------------------------------------------------------------------------------

export type RouteProbeState = 'started' | 'queued' | 'active' | 'paused' | 'consumed' | 'failed' | 'pending';

export interface RouteProbeObservation {
  probeId: string;
  runId: string;
  state: RouteProbeState;
  runStatus: string | null;
  recorded: ValidationProfile[];
  untested: ValidationProfile[];
  code?: string;
}

const ACTIVE_RUN = new Set([
  'preparing',
  'running',
  'retrying',
  'cancelling',
  'waiting_for_approval',
  'waiting_for_user',
]);
const PAUSED_RUN = new Set(['paused', 'paused_limit_reached']);
const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);

function recordedProfiles(db: Db, probe: ProbeRow): ValidationProfile[] {
  const rows = db
    .prepare('SELECT profile FROM route_validations WHERE evidence_run_id = ?')
    .all(probe.run_id) as Array<{ profile: ValidationProfile }>;
  return PROBE_PROFILE_ORDER.filter((profile) => rows.some((row) => row.profile === profile));
}

function finishProbe(
  db: Db,
  probeId: string,
  outcome: { status: 'consumed' } | { status: 'failed'; code: string },
  now: string,
): void {
  db.prepare(
    `UPDATE route_validation_probes SET status = ?, failure_code = ?, completed_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(outcome.status, outcome.status === 'failed' ? outcome.code : null, now, probeId);
}

/** A queued run whose probe cannot start (fixture unavailable) is cancelled, never started. */
function cancelQueuedRun(db: Db, runId: string, now: string, reason: string): void {
  db.transaction(() => {
    const changed = db
      .prepare(
        "UPDATE runs SET status = 'cancelled', completed_at = ?, summary = ? WHERE id = ? AND status = 'queued'",
      )
      .run(
        now,
        reason === 'identity_changed'
          ? 'The route identity changed before the probe started; no validation was performed.'
          : 'The route-validation fixture was unavailable; the probe was not started.',
        runId,
      ).changes;
    if (!changed) return;
    db.prepare(
      "UPDATE stages SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status = 'pending'",
    ).run(now, runId);
    db.prepare(
      'INSERT INTO run_events (id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), runId, 'run_cancelled', JSON.stringify({ status: 'cancelled', reason }), now);
  })();
}

/** The exact member a probe was created for, rebuilt only from its immutable identity and freshness class. */
function memberFromIdentity(probe: ProbeRow, kind?: 'pinned' | 'floating' | 'unknown'): RouteMember {
  const identity = JSON.parse(probe.identity_json) as {
    backendId: string;
    providerId: string;
    billingLane: ModelConfiguration['billingLane'];
    modelId: string;
    connectionProfile: { id: string } | null;
    variantId: string | null;
    reasoning: string | null;
    nativeSettings: Record<string, string | number | boolean | null>;
  };
  const configuration: ModelConfiguration = {
    backendId: identity.backendId,
    providerId: identity.providerId,
    billingLane: identity.billingLane,
    modelId: identity.modelId,
    ...(identity.connectionProfile ? { connectionProfileId: identity.connectionProfile.id } : {}),
    ...(identity.variantId ? { variantId: identity.variantId } : {}),
    ...(identity.reasoning ? { reasoning: identity.reasoning } : {}),
    ...(Object.keys(identity.nativeSettings ?? {}).length ? { nativeSettings: identity.nativeSettings } : {}),
  };
  return { configuration, freshnessClass: probe.freshness_class, ...(kind ? { identityKind: kind } : {}) };
}

/**
 * Whether the persisted exact identity is still the identity that is about to execute: a FRESH provider/profile
 * observation through the normal infrastructure must reproduce the stored identity byte for byte (adapter version and
 * capability fingerprint included). The stored identity is never changed or upgraded. The identity kind is part of the
 * fingerprint but not stored separately, so each kind is tried and only an exact canonical match counts.
 */
export async function persistedIdentityStillHolds(db: Db, probe: ProbeRow): Promise<boolean> {
  if (sha256(probe.identity_json) !== probe.identity_hash) return false;
  const snapshot = await observeRouteSnapshot(db);
  for (const kind of [undefined, 'pinned', 'floating', 'unknown'] as const) {
    const computed = computeRouteIdentity(memberFromIdentity(probe, kind), snapshot);
    if (
      computed.ok &&
      computed.value.provider &&
      computed.value.issues.length === 0 &&
      computed.value.identityHash === probe.identity_hash &&
      canonicalJson(computed.value.identity) === probe.identity_json
    )
      return true;
  }
  return false;
}

type StartOutcome = 'started' | 'start_failed' | 'fixture_unavailable' | 'identity_changed';

/**
 * The ONLY place a probe run is started (right after the request and from the reconciler). Before `startRun`: the
 * fixture is the pinned one, and the persisted identity still holds. Either failing cancels the still-queued run,
 * writes no validation record and finishes the probe terminally (`profiles_untested` for a changed identity: nothing was
 * validated; the run event and summary carry `identity_changed`). A new probe must be requested explicitly.
 */
async function startProbe(
  db: Db,
  probe: ProbeRow,
  startRun: StartRun,
  now: () => string,
): Promise<StartOutcome> {
  const fixture = await verifyFixture();
  if (!fixture.ok || fixture.commit !== probe.fixture_commit) {
    cancelQueuedRun(db, probe.run_id, now(), 'fixture_unavailable');
    finishProbe(db, probe.id, { status: 'failed', code: 'fixture_unavailable' }, now());
    return 'fixture_unavailable';
  }
  let holds: boolean;
  try {
    holds = await persistedIdentityStillHolds(db, probe);
  } catch {
    return 'start_failed';
  }
  if (!holds) {
    cancelQueuedRun(db, probe.run_id, now(), 'identity_changed');
    finishProbe(db, probe.id, { status: 'failed', code: 'profiles_untested' }, now());
    return 'identity_changed';
  }
  try {
    startRun(probe.run_id);
  } catch {
    return 'start_failed';
  }
  return 'started';
}

/**
 * Advances ONE probe from persisted state alone, independent of any HTTP request. Queued → fixture re-verified, then
 * started exactly once; active → observed; paused → exposed, never auto-resumed; completed → consumed deterministically;
 * failed → only profiles that produced a judgeable result are recorded; cancelled → nothing is invented; consumed → no-op.
 * A profile already recorded for the run is reused, never rewritten, so a crash between two profile inserts resumes.
 */
export async function reconcileRouteProbe(
  db: Db,
  probeId: string,
  startRun: StartRun,
  now: () => string = () => new Date().toISOString(),
): Promise<RouteProbeObservation> {
  const probe = probeRow(db, probeId);
  if (!probe) throw new RouteProbeError('probe_not_found', 'No such probe.');
  const profiles = probeProfiles(probe);
  const run = db
    .prepare('SELECT status, starting_commit, worktree_path FROM runs WHERE id = ?')
    .get(probe.run_id) as
    { status: string; starting_commit: string | null; worktree_path: string | null } | undefined;
  const base = { probeId, runId: probe.run_id, runStatus: run?.status ?? null };
  const view = (state: RouteProbeState, code?: string): RouteProbeObservation => {
    const recorded = recordedProfiles(db, probe);
    return {
      ...base,
      state,
      recorded,
      untested: profiles.filter((profile) => !recorded.includes(profile)),
      ...(code ? { code } : {}),
    };
  };
  if (probe.status === 'consumed') return view('consumed');
  if (probe.status === 'failed') return view('failed', probe.failure_code ?? undefined);

  const fail = (code: string) => {
    finishProbe(db, probeId, { status: 'failed', code }, now());
    return view('failed', code);
  };
  if (!run) return fail('run_missing');
  if (run.status === 'queued') {
    const outcome = await startProbe(db, probe, startRun, now);
    if (outcome === 'start_failed') return view('queued', 'start_failed');
    if (outcome === 'started') return view('started');
    // The probe was finished by startProbe; report the persisted terminal state.
    return view('failed', probeRow(db, probeId)?.failure_code ?? undefined);
  }
  if (ACTIVE_RUN.has(run.status)) return view('active');
  if (PAUSED_RUN.has(run.status)) return view('paused', 'run_paused');
  if (!TERMINAL_RUN.has(run.status)) return view('active');

  // Terminal run: it must be PROVEN to have started from exactly the pinned fixture commit. A missing base (NULL) or any
  // other commit proves nothing, so nothing is judged and no record is written.
  if (run.starting_commit !== probe.fixture_commit)
    return fail(
      run.status === 'cancelled'
        ? 'run_cancelled'
        : run.status === 'failed'
          ? 'run_failed'
          : 'fixture_unavailable',
    );
  for (const profile of profiles) {
    if (recordedProfiles(db, probe).includes(profile)) continue;
    const verdict = await judgeProfile(db, {
      runId: probe.run_id,
      profile,
      startingCommit: run.starting_commit,
      worktreePath: run.worktree_path,
    });
    if (verdict) writeProbeRecord(db, probeId, profile, verdict, now());
  }
  const recorded = recordedProfiles(db, probe);
  if (profiles.every((profile) => recorded.includes(profile))) {
    finishProbe(db, probeId, { status: 'consumed' }, now());
    return view('consumed');
  }
  return fail(
    run.status === 'cancelled'
      ? 'run_cancelled'
      : run.status === 'failed'
        ? 'run_failed'
        : 'profiles_untested',
  );
}

// --- Worktree retention -----------------------------------------------------------------------------------------------

export type ProbePruneResult =
  | { status: 'pruned' | 'already_pruned' }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; reason: string };

const samePath = (left: string, right: string) => resolve(left) === resolve(right);

/**
 * Removes the isolated worktree of ONE finished, fully consumed probe, through Git, never with `--force`, never with
 * `git worktree prune`, never by sweeping a directory. Every precondition is re-proven; any doubt keeps the worktree.
 * The run, its branch and its Git history are untouched, and a failure here changes no validation record.
 */
export async function pruneProbeWorktree(
  db: Db,
  probeId: string,
  now = new Date().toISOString(),
): Promise<ProbePruneResult> {
  const probe = probeRow(db, probeId);
  if (!probe || probe.status === 'pending') return { status: 'refused', reason: 'probe_not_finished' };
  const run = db
    .prepare('SELECT status, branch, worktree_path, project_id FROM runs WHERE id = ?')
    .get(probe.run_id) as
    { status: string; branch: string | null; worktree_path: string | null; project_id: string } | undefined;
  if (!run || !TERMINAL_RUN.has(run.status)) return { status: 'refused', reason: 'run_not_terminal' };
  const release = () =>
    db
      .prepare(
        'UPDATE route_validation_probes SET worktree_released_at = ? WHERE id = ? AND worktree_released_at IS NULL',
      )
      .run(now, probeId);
  if (run.worktree_path === null) {
    release();
    return { status: 'already_pruned' };
  }
  const fixtureDir = join(dataDirectory(), PROBE_FIXTURE.directoryName);
  const expectedWorktree = join(dataDirectory(), 'worktrees', probe.run_id);
  const project = db.prepare('SELECT git_root FROM projects WHERE id = ?').get(run.project_id) as
    { git_root: string | null } | undefined;
  if (
    run.project_id !== PROBE_FIXTURE.projectId ||
    !project?.git_root ||
    !samePath(project.git_root, fixtureDir) ||
    !samePath(run.worktree_path, expectedWorktree) ||
    run.branch !== `turing/${probe.run_id.slice(0, 8)}`
  )
    return { status: 'refused', reason: 'worktree_mismatch' };
  if (!existsSync(run.worktree_path)) return { status: 'refused', reason: 'worktree_missing' };
  const [top, head, tip, status, listing] = await Promise.all([
    gitTry(run.worktree_path, ['rev-parse', '--show-toplevel']),
    gitTry(run.worktree_path, ['rev-parse', 'HEAD']),
    gitTry(project.git_root, ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}^{commit}`]),
    gitTry(run.worktree_path, ['status', '--porcelain=v1', '--untracked-files=all']),
    gitTry(project.git_root, ['worktree', 'list', '--porcelain']),
  ]);
  const registered = listing.ok
    ? listing.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
    : [];
  if (
    !top.ok ||
    !samePath(top.stdout.trim(), run.worktree_path) ||
    !registered.some((entry) => samePath(entry, run.worktree_path!))
  )
    return { status: 'refused', reason: 'worktree_mismatch' };
  if (!head.ok || !tip.ok || head.stdout.trim() !== tip.stdout.trim())
    return { status: 'refused', reason: 'worktree_head_mismatch' };
  if (!status.ok || status.stdout.trim()) return { status: 'refused', reason: 'worktree_dirty' };
  const removed = await gitTry(project.git_root, ['worktree', 'remove', run.worktree_path]);
  const after = await gitTry(project.git_root, ['worktree', 'list', '--porcelain']);
  const still =
    !after.ok ||
    after.stdout
      .split('\n')
      .some(
        (line) =>
          line.startsWith('worktree ') && samePath(line.slice('worktree '.length), run.worktree_path!),
      );
  if (!removed.ok || existsSync(run.worktree_path) || still)
    return { status: 'failed', reason: 'worktree_remove_failed' };
  db.prepare('UPDATE runs SET worktree_path = NULL WHERE id = ? AND worktree_path = ?').run(
    probe.run_id,
    run.worktree_path,
  );
  release();
  return { status: 'pruned' };
}

// --- Status & reconciler ---------------------------------------------------------------------------------------------

export interface RouteProbeStatus {
  probeId: string;
  runId: string;
  identityHash: string;
  profiles: ValidationProfile[];
  status: 'pending' | 'consumed' | 'failed';
  failureCode: string | null;
  runStatus: string | null;
  recorded: Array<{
    profile: ValidationProfile;
    status: 'pass' | 'fail';
    testedAt: string;
    expiresAt: string;
  }>;
  createdAt: string;
  completedAt: string | null;
}

/** Bounded, credential-free status for the user. Reads persisted rows only; starts nothing and calls no provider. */
export function getRouteProbeStatus(db: Db, probeId: string): RouteProbeStatus | undefined {
  const probe = probeRow(db, probeId);
  if (!probe) return undefined;
  const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(probe.run_id) as
    { status: string } | undefined;
  const records = db
    .prepare(
      'SELECT profile, status, tested_at, expires_at FROM route_validations WHERE evidence_run_id = ? ORDER BY tested_at, rowid',
    )
    .all(probe.run_id) as Array<{
    profile: ValidationProfile;
    status: 'pass' | 'fail';
    tested_at: string;
    expires_at: string;
  }>;
  return {
    probeId,
    runId: probe.run_id,
    identityHash: probe.identity_hash,
    profiles: probeProfiles(probe),
    status: probe.status,
    failureCode: probe.failure_code,
    runStatus: run?.status ?? null,
    recorded: records.map((row) => ({
      profile: row.profile,
      status: row.status,
      testedAt: row.tested_at,
      expiresAt: row.expires_at,
    })),
    createdAt: probe.created_at,
    completedAt: probe.completed_at,
  };
}

const openProbes = (db: Db): string[] =>
  (
    db
      .prepare("SELECT id FROM route_validation_probes WHERE status = 'pending' ORDER BY created_at, id")
      .all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);

const unreleasedProbes = (db: Db, limit: number): string[] =>
  (
    db
      .prepare(
        `SELECT p.id FROM route_validation_probes p JOIN runs r ON r.id = p.run_id
         WHERE p.status <> 'pending' AND p.worktree_released_at IS NULL AND r.worktree_path IS NOT NULL
         ORDER BY p.created_at, p.id LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>
  ).map((row) => row.id);

export interface RouteProbeReconcileSummary {
  observed: RouteProbeObservation[];
  pruned: string[];
}

const MAX_PRUNE_FAILURES = 3;

/**
 * Runs at startup and at a bounded cadence. It only ever touches probes that already exist in the database: it creates no
 * probe, revalidates nothing because a record expired, and starts no run that was not queued by an explicit user request.
 */
export class RouteProbeReconciler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly pruneFailures = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly startRun: StartRun,
  ) {}

  async reconcile(): Promise<RouteProbeReconcileSummary> {
    const observed: RouteProbeObservation[] = [];
    for (const probeId of openProbes(this.db))
      try {
        observed.push(await reconcileRouteProbe(this.db, probeId, this.startRun));
      } catch {
        /* A probe that cannot be advanced now is retried on the next pass. */
      }
    const pruned: string[] = [];
    for (const probeId of unreleasedProbes(this.db, 20)) {
      if ((this.pruneFailures.get(probeId) ?? 0) >= MAX_PRUNE_FAILURES) continue;
      try {
        const result = await pruneProbeWorktree(this.db, probeId);
        if (result.status === 'pruned') pruned.push(probeId);
        else if (result.status === 'failed' || result.status === 'refused')
          this.pruneFailures.set(probeId, (this.pruneFailures.get(probeId) ?? 0) + 1);
      } catch {
        this.pruneFailures.set(probeId, (this.pruneFailures.get(probeId) ?? 0) + 1);
      }
    }
    return { observed, pruned };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.reconcile()
        .catch(() => undefined)
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
