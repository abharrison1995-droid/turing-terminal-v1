import type { Db } from '../db.js';
import { initGoalRef, recoverIntegrationOps, verifyGoalRef, GoalGitError } from '../goalGit.js';
import { pendingGoalApprovals } from './approvals.js';
import { evaluateBounds } from './bounds.js';
import { activeCycle } from './cycles.js';
import { loadDefinitionVersion, validateStoredDefinition, verifyDefinitionHash } from './definitions.js';
import type { FirstUseRequest, GoalExecutor } from './executor.js';

/**
 * Goal preflight: the deterministic checks every start and resume must pass before `-> running`. It returns a
 * structured result and never changes Goal status itself; the supervisor turns a pass into the `preflight`
 * precondition of `transitionGoal`. Routing readiness comes only from the injected executor.
 */
export type PreflightFailureCode =
  | 'goal_not_found'
  | 'wrong_status'
  | 'definition_not_approved'
  | 'definition_hash_mismatch'
  | 'definition_invalid'
  | 'project_lease_conflict'
  | 'goal_ref_changed'
  | 'goal_ref_missing'
  | 'git_state_invalid'
  | 'pending_operation'
  | 'conflicting_cycle'
  | 'gate_pending'
  | 'route_unavailable'
  | 'provider_unavailable'
  | 'provider_exhausted'
  | 'approval_required'
  | 'approval_pending'
  | 'bound_cycles'
  | 'bound_failures'
  | 'bound_remediation'
  | 'bound_active_time'
  | 'bound_wall_clock'
  | 'bound_spend';

export type PreflightResult =
  | { ok: true; head: string; initializedRef: boolean }
  | { ok: false; code: PreflightFailureCode; message: string; approval?: FirstUseRequest };

const STARTABLE = new Set(['ready', 'needs_user', 'blocked', 'paused']);
const fail = (code: PreflightFailureCode, message: string): PreflightResult => ({ ok: false, code, message });

export async function runPreflight(
  db: Db,
  goalId: string,
  deps: { executor: GoalExecutor; now?: string; liveActiveMs?: number },
): Promise<PreflightResult> {
  const goal = db
    .prepare('SELECT status, project_id, current_definition_version FROM goals WHERE id = ?')
    .get(goalId) as
    { status: string; project_id: string; current_definition_version: number | null } | undefined;
  if (!goal) return fail('goal_not_found', 'The Goal does not exist.');
  if (!STARTABLE.has(goal.status)) return fail('wrong_status', `A ${goal.status} Goal cannot be started.`);

  // 1. Approved definition whose stored hash verifies and which still validates.
  const version =
    goal.current_definition_version === null
      ? undefined
      : loadDefinitionVersion(db, goalId, goal.current_definition_version);
  if (!version || version.status !== 'approved')
    return fail('definition_not_approved', 'The current definition is not approved.');
  if (!verifyDefinitionHash(version))
    return fail('definition_hash_mismatch', 'The stored definition does not match its hash.');
  if (!validateStoredDefinition(db, goalId, version.version).valid)
    return fail('definition_invalid', 'The approved definition no longer validates.');

  // 2. Project lease.
  const holder = db
    .prepare(
      `SELECT id FROM goals WHERE project_id = ? AND id <> ?
         AND status IN ('running','reviewing','needs_user','blocked','paused')`,
    )
    .get(goal.project_id, goalId);
  if (holder) return fail('project_lease_conflict', 'Another Goal is active on this project.');

  // 3. A cycle may exist only when the Goal already holds work in flight (resume); a fresh start has none.
  if (goal.status === 'ready' && activeCycle(db, goalId))
    return fail('conflicting_cycle', 'A ready Goal cannot have an unfinished cycle.');

  // 4. Mandatory human gates must not be waiting.
  if (
    pendingGoalApprovals(db, goalId).some(
      (approval) => approval.gate === 'each_cycle' || approval.gate === 'milestone_complete',
    )
  )
    return fail('gate_pending', 'A mandatory approval is still pending.');

  // 5. Goal ref: resolve any half-finished integration first, then initialise or verify.
  try {
    for (const recovered of await recoverIntegrationOps(db, goalId))
      if (recovered.outcome === 'goal_ref_changed')
        return fail('goal_ref_changed', 'The Goal ref moved during an unfinished integration operation.');
    const planned = db
      .prepare("SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned'")
      .get(goalId);
    if (planned) return fail('pending_operation', 'An integration operation is still unresolved.');

    const runtime = db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as
      { integration_head: string | null } | undefined;
    let initializedRef = false;
    if (!runtime?.integration_head) {
      const initialised = await initGoalRef(db, goalId);
      if (initialised.outcome === 'conflict') return fail('goal_ref_changed', 'The Goal ref already exists.');
      if (initialised.outcome === 'refused')
        return fail(
          initialised.code === 'goal_ref_exists' ? 'goal_ref_changed' : 'git_state_invalid',
          initialised.message,
        );
      initializedRef = true;
    }
    const verified = await verifyGoalRef(db, goalId);
    if (!verified.ok) {
      if (verified.code === 'goal_ref_missing') return fail('goal_ref_missing', 'The Goal ref is missing.');
      if (verified.code === 'goal_ref_changed')
        return fail('goal_ref_changed', 'The Goal ref does not match the recorded integration head.');
      return fail('git_state_invalid', `The Goal ref is not usable (${verified.code}).`);
    }
    // 6. Bounds.
    const breach = evaluateBounds(db, goalId, {
      now: deps.now ?? new Date().toISOString(),
      liveActiveMs: deps.liveActiveMs,
    });
    if (breach) return fail(breach.reason, breach.message);
    // 7. Routing readiness comes only from the executor.
    const routes = await deps.executor.checkRoutes(goalId);
    if (!routes.ready) {
      return {
        ok: false,
        code: routes.code,
        message: routes.message,
        ...('approval' in routes ? { approval: routes.approval } : {}),
      };
    }
    return { ok: true, head: verified.head, initializedRef };
  } catch (error) {
    if (error instanceof GoalGitError) return fail('git_state_invalid', error.message);
    throw error;
  }
}
