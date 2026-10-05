import { randomUUID } from 'node:crypto';
import type { GoalCycleKind, GoalDefinition, NextTask } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import { writeGoalEvent } from './events.js';
import { evaluateBounds, type BoundBreach } from './bounds.js';

/**
 * The single authority over goal_cycles.status. Every status write in the application goes through
 * `transitionCycle`; terminal finalisation (`finalizeCycle`) additionally recomputes the Goal's runtime counters from
 * cycle history in the same transaction. Migration 020 backs this up: one active cycle per Goal, immutable identity,
 * forward-only status, immutable terminal rows.
 */
export type CycleStatus =
  | 'planned'
  | 'proposing'
  | 'proposed'
  | 'launching'
  | 'running'
  | 'collecting'
  | 'integrating'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export const CYCLE_TERMINAL: readonly CycleStatus[] = ['succeeded', 'failed', 'cancelled', 'rejected'];
export const isCycleTerminal = (status: CycleStatus) => CYCLE_TERMINAL.includes(status);

/** Legal forward path of each kind. Any non-terminal status may also end failed or cancelled. */
const PATH: Record<GoalCycleKind, readonly CycleStatus[]> = {
  // A proposal is produced, validated (or rejected), launched, run, collected and integrated into the Goal ref.
  execution: [
    'planned',
    'proposing',
    'proposed',
    'launching',
    'running',
    'collecting',
    'integrating',
    'succeeded',
  ],
  remediation: [
    'planned',
    'proposing',
    'proposed',
    'launching',
    'running',
    'collecting',
    'integrating',
    'succeeded',
  ],
  // Reviews and verification run against the head and integrate nothing.
  review: ['planned', 'launching', 'running', 'collecting', 'succeeded'],
  verification: ['planned', 'launching', 'running', 'collecting', 'succeeded'],
  // Authoring proposes a definition; the user (not the cycle) approves it.
  authoring: ['planned', 'proposing', 'proposed', 'succeeded'],
};

/** Only a proposal that fails validation or a refused gate is "rejected"; it never reached a run. */
const REJECTABLE: readonly CycleStatus[] = ['proposing', 'proposed'];

export function legalCycleTransitions(kind: GoalCycleKind, from: CycleStatus): CycleStatus[] {
  if (isCycleTerminal(from)) return [];
  const path = PATH[kind];
  const position = path.indexOf(from);
  // A status that is not on the kind's path (for example `integrating` for a review) has no forward edge at all.
  const next = position === -1 ? undefined : path[position + 1];
  const out: CycleStatus[] = next ? [next] : [];
  out.push('failed', 'cancelled');
  if (REJECTABLE.includes(from) && path.includes('proposing')) out.push('rejected');
  return out;
}

export type CycleErrorCode =
  | 'cycle_not_found'
  | 'illegal_cycle_transition'
  | 'terminal_cycle'
  | 'not_terminal_status'
  | 'goal_not_running'
  | 'active_cycle_exists'
  | 'definition_not_current'
  | 'definition_hash_mismatch'
  | 'milestone_not_current'
  | 'goal_not_initialized'
  | 'bound_exceeded';

export class CycleError extends Error {
  constructor(
    readonly code: CycleErrorCode,
    message: string,
    readonly breach?: BoundBreach,
  ) {
    super(message);
    this.name = 'CycleError';
  }
}

export interface CycleRow {
  id: string;
  goalId: string;
  definitionVersion: number | null;
  milestoneId: string | null;
  milestoneKey: string | null;
  sequence: number;
  kind: GoalCycleKind;
  triggerCode: string;
  status: CycleStatus;
  baseIntegrationCommit: string | null;
  resultIntegrationCommit: string | null;
  validatedTask: NextTask | null;
  outcome: Record<string, unknown> | null;
  nextActionCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface RawCycle {
  id: string;
  goal_id: string;
  definition_version: number | null;
  milestone_id: string | null;
  milestone_key: string | null;
  sequence: number;
  kind: GoalCycleKind;
  trigger_code: string;
  status: CycleStatus;
  base_integration_commit: string | null;
  result_integration_commit: string | null;
  validated_task_json: string | null;
  outcome_json: string | null;
  next_action_code: string | null;
  created_at: string;
  finished_at: string | null;
}

const CYCLE_SELECT = `SELECT c.*, m.milestone_key FROM goal_cycles c
  LEFT JOIN goal_milestones m ON m.id = c.milestone_id`;

function toCycle(row: RawCycle): CycleRow {
  return {
    id: row.id,
    goalId: row.goal_id,
    definitionVersion: row.definition_version,
    milestoneId: row.milestone_id,
    milestoneKey: row.milestone_key,
    sequence: row.sequence,
    kind: row.kind,
    triggerCode: row.trigger_code,
    status: row.status,
    baseIntegrationCommit: row.base_integration_commit,
    resultIntegrationCommit: row.result_integration_commit,
    validatedTask: row.validated_task_json ? (JSON.parse(row.validated_task_json) as NextTask) : null,
    outcome: row.outcome_json ? (JSON.parse(row.outcome_json) as Record<string, unknown>) : null,
    nextActionCode: row.next_action_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function getCycle(db: Db, cycleId: string): CycleRow | undefined {
  const row = db.prepare(`${CYCLE_SELECT} WHERE c.id = ?`).get(cycleId) as RawCycle | undefined;
  return row ? toCycle(row) : undefined;
}

export function activeCycle(db: Db, goalId: string): CycleRow | undefined {
  const row = db
    .prepare(
      `${CYCLE_SELECT} WHERE c.goal_id = ? AND c.status NOT IN ('succeeded','failed','cancelled','rejected')`,
    )
    .get(goalId) as RawCycle | undefined;
  return row ? toCycle(row) : undefined;
}

export function listCycles(db: Db, goalId: string): CycleRow[] {
  return (
    db.prepare(`${CYCLE_SELECT} WHERE c.goal_id = ? ORDER BY c.sequence`).all(goalId) as RawCycle[]
  ).map(toCycle);
}

const MAX_OUTCOME_CHARS = 8_000;

export interface CycleTransition {
  cycleId: string;
  to: CycleStatus;
  /** Recorded alongside the transition in the same statement. */
  validatedTask?: NextTask;
  outcome?: Record<string, unknown>;
  nextActionCode?: string;
  resultIntegrationCommit?: string;
  now?: string;
}

/** The only `UPDATE goal_cycles SET status` in the application. Validates the edge against the per-kind matrix. */
export function transitionCycle(db: Db, request: CycleTransition): CycleRow {
  const now = request.now ?? new Date().toISOString();
  return db.transaction(() => {
    const current = getCycle(db, request.cycleId);
    if (!current) throw new CycleError('cycle_not_found', 'The cycle does not exist.');
    if (isCycleTerminal(current.status))
      throw new CycleError('terminal_cycle', `A ${current.status} cycle cannot change.`);
    if (!legalCycleTransitions(current.kind, current.status).includes(request.to))
      throw new CycleError(
        'illegal_cycle_transition',
        `A ${current.kind} cycle cannot move from ${current.status} to ${request.to}.`,
      );
    const outcomeJson = request.outcome ? JSON.stringify(request.outcome) : null;
    if (outcomeJson && outcomeJson.length > MAX_OUTCOME_CHARS)
      throw new CycleError('illegal_cycle_transition', 'The cycle outcome is too large.');
    db.prepare(
      `UPDATE goal_cycles SET status = ?,
         validated_task_json = COALESCE(?, validated_task_json),
         outcome_json = COALESCE(?, outcome_json),
         next_action_code = COALESCE(?, next_action_code),
         result_integration_commit = COALESCE(?, result_integration_commit),
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END
       WHERE id = ? AND status = ?`,
    ).run(
      request.to,
      request.validatedTask ? JSON.stringify(request.validatedTask) : null,
      outcomeJson,
      request.nextActionCode ?? null,
      request.resultIntegrationCommit ?? null,
      isCycleTerminal(request.to) ? 1 : 0,
      now,
      request.cycleId,
      current.status,
    );
    return getCycle(db, request.cycleId)!;
  })();
}

// --- Counters ----------------------------------------------------------------------------------------------------

export interface RuntimeCounters {
  cyclesExecuted: number;
  consecutiveFailedCycles: number;
  remediationAttempts: Record<string, number>;
}

/**
 * Recomputes every runtime counter from cycle history alone. Execution and remediation cycles that finished
 * succeeded or failed count as executed (a rejected proposal never ran; a cancelled cycle is not an attempt). A
 * success resets the consecutive-failure run; failed and rejected extend it; cancelled changes nothing.
 */
export function computeCounters(db: Db, goalId: string): RuntimeCounters {
  const rows = db
    .prepare(
      `SELECT c.kind, c.status, m.milestone_key FROM goal_cycles c
       LEFT JOIN goal_milestones m ON m.id = c.milestone_id
       WHERE c.goal_id = ? AND c.kind IN ('execution','remediation')
         AND c.status IN ('succeeded','failed','rejected','cancelled')
       ORDER BY c.sequence`,
    )
    .all(goalId) as Array<{ kind: string; status: string; milestone_key: string | null }>;
  const counters: RuntimeCounters = {
    cyclesExecuted: 0,
    consecutiveFailedCycles: 0,
    remediationAttempts: {},
  };
  for (const row of rows) {
    if (row.status === 'succeeded' || row.status === 'failed') counters.cyclesExecuted += 1;
    if (row.status === 'succeeded') counters.consecutiveFailedCycles = 0;
    else if (row.status === 'failed' || row.status === 'rejected') counters.consecutiveFailedCycles += 1;
    if (
      row.kind === 'remediation' &&
      row.milestone_key &&
      (row.status === 'succeeded' || row.status === 'failed')
    )
      counters.remediationAttempts[row.milestone_key] =
        (counters.remediationAttempts[row.milestone_key] ?? 0) + 1;
  }
  return counters;
}

function sortedJson(record: Record<string, number>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
}

function writeCounters(db: Db, goalId: string, counters: RuntimeCounters, now: string): boolean {
  const before = db
    .prepare(
      'SELECT cycles_executed, consecutive_failed_cycles, remediation_attempts_json FROM goal_runtime WHERE goal_id = ?',
    )
    .get(goalId) as
    | { cycles_executed: number; consecutive_failed_cycles: number; remediation_attempts_json: string }
    | undefined;
  const attempts = sortedJson(counters.remediationAttempts);
  let storedAttempts = '{}';
  try {
    storedAttempts = sortedJson(
      JSON.parse(before?.remediation_attempts_json ?? '{}') as Record<string, number>,
    );
  } catch {
    storedAttempts = '<corrupt>';
  }
  const changed =
    !before ||
    before.cycles_executed !== counters.cyclesExecuted ||
    before.consecutive_failed_cycles !== counters.consecutiveFailedCycles ||
    storedAttempts !== attempts;
  if (changed)
    db.prepare(
      `UPDATE goal_runtime SET cycles_executed = ?, consecutive_failed_cycles = ?, remediation_attempts_json = ?,
         updated_at = ? WHERE goal_id = ?`,
    ).run(counters.cyclesExecuted, counters.consecutiveFailedCycles, attempts, now, goalId);
  return changed;
}

/**
 * Restores the runtime counter cache from cycle history. Deterministic and idempotent; it never touches a cycle row.
 * The counters are a cache: history is the authority.
 */
export function reconcileCounters(db: Db, goalId: string, now = new Date().toISOString()) {
  return db.transaction(() => {
    const counters = computeCounters(db, goalId);
    const corrected = writeCounters(db, goalId, counters, now);
    if (corrected) writeGoalEvent(db, goalId, 'counters_reconciled', { ...counters, corrected }, now);
    return { counters, corrected };
  })();
}

/**
 * Terminal finalisation: the cycle row and the counters it affects change in one transaction, so a crash can leave
 * neither a finished cycle with stale counters nor counters ahead of history.
 */
export function finalizeCycle(
  db: Db,
  request: Omit<CycleTransition, 'to' | 'outcome'> & {
    to: Extract<CycleStatus, 'succeeded' | 'failed' | 'cancelled' | 'rejected'>;
    outcomeCode: string;
    detail?: Record<string, unknown>;
  },
): CycleRow {
  if (!isCycleTerminal(request.to))
    throw new CycleError('not_terminal_status', `${request.to} is not a terminal cycle status.`);
  const now = request.now ?? new Date().toISOString();
  return db.transaction(() => {
    const cycle = transitionCycle(db, {
      ...request,
      now,
      outcome: { code: request.outcomeCode, ...request.detail },
      nextActionCode: request.nextActionCode ?? request.outcomeCode,
    });
    writeCounters(db, cycle.goalId, computeCounters(db, cycle.goalId), now);
    writeGoalEvent(
      db,
      cycle.goalId,
      'cycle_finished',
      {
        cycleId: cycle.id,
        sequence: cycle.sequence,
        kind: cycle.kind,
        status: cycle.status,
        outcomeCode: request.outcomeCode,
      },
      now,
    );
    return cycle;
  })();
}

// --- Creation ----------------------------------------------------------------------------------------------------

export type CreateCycleResult =
  { created: true; cycle: CycleRow } | { created: false; reason: 'active_cycle_exists'; cycle: CycleRow };

export interface CreateCycleInput {
  goalId: string;
  kind: Extract<GoalCycleKind, 'execution' | 'remediation'>;
  triggerCode: string;
  /** Must be a milestone of the current approved definition. */
  milestoneKey: string;
  now?: string;
  /** Active time the caller has accumulated beyond the persisted value (see ActiveTimeTracker). */
  liveActiveMs?: number;
}

/**
 * Idempotent, transactional creation. If the Goal already has a non-terminal cycle that cycle is returned and nothing
 * is written; otherwise it captures the current definition version and the integration head as the immutable base,
 * checks the bounds and allocates the next sequence. Creating a cycle consumes nothing: counters change only when a
 * cycle finishes. The unique index of migration 020 makes a competing creation fail instead of double-booking.
 */
export function createCycle(db: Db, input: CreateCycleInput): CreateCycleResult {
  const now = input.now ?? new Date().toISOString();
  return db.transaction((): CreateCycleResult => {
    const goal = db
      .prepare('SELECT status, current_definition_version FROM goals WHERE id = ?')
      .get(input.goalId) as { status: string; current_definition_version: number | null } | undefined;
    if (!goal || goal.status !== 'running')
      throw new CycleError('goal_not_running', 'Cycles are created only for a running Goal.');
    const existing = activeCycle(db, input.goalId);
    if (existing) return { created: false, reason: 'active_cycle_exists', cycle: existing };

    const version =
      goal.current_definition_version === null
        ? undefined
        : loadDefinitionVersion(db, input.goalId, goal.current_definition_version);
    if (!version || version.status !== 'approved')
      throw new CycleError('definition_not_current', 'The current definition is not approved.');
    if (!verifyDefinitionHash(version))
      throw new CycleError('definition_hash_mismatch', 'The stored definition does not match its hash.');
    const milestone = db
      .prepare('SELECT id FROM goal_milestones WHERE goal_id = ? AND milestone_key = ?')
      .get(input.goalId, input.milestoneKey) as { id: string } | undefined;
    if (
      !milestone ||
      !(version.definition as GoalDefinition).milestones.some((m) => m.key === input.milestoneKey)
    )
      throw new CycleError('milestone_not_current', 'The milestone is not part of the current definition.');
    const runtime = db
      .prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?')
      .get(input.goalId) as { integration_head: string | null } | undefined;
    if (!runtime?.integration_head)
      throw new CycleError('goal_not_initialized', 'The Goal has no integration head.');
    const breach = evaluateBounds(db, input.goalId, {
      now,
      liveActiveMs: input.liveActiveMs,
      next: { kind: input.kind, milestoneKey: input.milestoneKey },
    });
    if (breach) throw new CycleError('bound_exceeded', breach.message, breach);

    const sequence =
      (
        db
          .prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM goal_cycles WHERE goal_id = ?')
          .get(input.goalId) as { s: number }
      ).s + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status,
         base_integration_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
    ).run(
      id,
      input.goalId,
      version.version,
      milestone.id,
      sequence,
      input.kind,
      input.triggerCode,
      runtime.integration_head,
      now,
    );
    writeGoalEvent(
      db,
      input.goalId,
      'cycle_created',
      {
        cycleId: id,
        sequence,
        kind: input.kind,
        triggerCode: input.triggerCode,
        milestoneKey: input.milestoneKey,
        definitionVersion: version.version,
        baseIntegrationCommit: runtime.integration_head,
      },
      now,
    );
    return { created: true, cycle: getCycle(db, id)! };
  })();
}
