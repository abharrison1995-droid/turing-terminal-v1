import type { BlockedReason, GoalLimits } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { loadDefinitionVersion } from './definitions.js';
import { transitionGoal } from './stateMachine.js';

/**
 * Goal bounds (design 12.1). `evaluateBounds` is a pure read over persisted state; `enforceBounds` turns a breach into
 * a `blocked(bound_*)` transition through the state machine. Counters are caches of cycle history (see
 * `reconcileCounters`); active time is `goal_runtime.active_ms` plus the caller's live delta.
 */
export interface BoundBreach {
  reason: Extract<
    BlockedReason,
    | 'bound_cycles'
    | 'bound_failures'
    | 'bound_remediation'
    | 'bound_active_time'
    | 'bound_wall_clock'
    | 'bound_spend'
  >;
  message: string;
  limit: number;
  observed: number;
}

export interface BoundsContext {
  now: string;
  /** Active time accumulated since the last persist (from the tracker); persisted active_ms is read from the row. */
  liveActiveMs?: number;
  /** The cycle about to be created, if any; remediation attempts are per milestone. */
  next?: { kind: 'execution' | 'remediation'; milestoneKey: string };
  /**
   * True when the caller creates a verification cycle: the execution-cycle and consecutive-failure bounds do not apply
   * to it. Wall-clock, active-time and spend checks always apply. Absent or false keeps every bound in force.
   */
  skipExecutionBounds?: boolean;
}

/**
 * Committed metered spend of a Goal, from the canonical metering ledger only: reservations attached to the Goal's
 * runs (directly or through their usage events), counting open reservations at their reserved amount, reconciled ones
 * at their actual amount and released ones at any actual amount. There is no second Goal-level ledger.
 */
export function goalMeteredSpendUsd(db: Db, goalId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
          WHEN m.status = 'reserved' THEN m.reserved_usd
          WHEN m.status = 'reconciled' THEN COALESCE(m.actual_usd, m.reserved_usd)
          ELSE COALESCE(m.actual_usd, 0) END), 0) AS spend
       FROM metered_reservations m
       WHERE EXISTS (
         SELECT 1 FROM runs r JOIN goal_cycles c ON c.id = r.goal_cycle_id
         WHERE c.goal_id = ?
           AND (m.run_id = r.id
             OR m.usage_event_id IN (SELECT u.id FROM usage_events u WHERE u.run_id = r.id)))`,
    )
    .get(goalId) as { spend: number };
  return row.spend;
}

export function evaluateBounds(db: Db, goalId: string, context: BoundsContext): BoundBreach | null {
  const goal = db
    .prepare('SELECT current_definition_version, approved_at, started_at FROM goals WHERE id = ?')
    .get(goalId) as
    | { current_definition_version: number | null; approved_at: string | null; started_at: string | null }
    | undefined;
  if (!goal || goal.current_definition_version === null) return null;
  const version = loadDefinitionVersion(db, goalId, goal.current_definition_version);
  if (!version) return null;
  const limits: GoalLimits = version.definition.limits;
  const runtime = db
    .prepare(
      'SELECT cycles_executed, consecutive_failed_cycles, remediation_attempts_json, active_ms FROM goal_runtime WHERE goal_id = ?',
    )
    .get(goalId) as
    | {
        cycles_executed: number;
        consecutive_failed_cycles: number;
        remediation_attempts_json: string;
        active_ms: number;
      }
    | undefined;
  if (!runtime) return null;

  if (!context.skipExecutionBounds && runtime.cycles_executed >= limits.maxExecutionCycles)
    return {
      reason: 'bound_cycles',
      message: 'The Goal reached its execution cycle limit.',
      limit: limits.maxExecutionCycles,
      observed: runtime.cycles_executed,
    };
  if (!context.skipExecutionBounds && runtime.consecutive_failed_cycles >= limits.maxConsecutiveFailedCycles)
    return {
      reason: 'bound_failures',
      message: 'The Goal reached its consecutive failed cycle limit.',
      limit: limits.maxConsecutiveFailedCycles,
      observed: runtime.consecutive_failed_cycles,
    };
  if (context.next?.kind === 'remediation') {
    let attempts: Record<string, number> = {};
    try {
      attempts = JSON.parse(runtime.remediation_attempts_json) as Record<string, number>;
    } catch {
      attempts = {};
    }
    const used = attempts[context.next.milestoneKey] ?? 0;
    if (used >= limits.maxRemediationAttempts)
      return {
        reason: 'bound_remediation',
        message: `Milestone ${context.next.milestoneKey} reached its remediation attempt limit.`,
        limit: limits.maxRemediationAttempts,
        observed: used,
      };
  }
  const activeMs = runtime.active_ms + Math.max(0, context.liveActiveMs ?? 0);
  if (activeMs >= limits.maxActiveMinutes * 60_000)
    return {
      reason: 'bound_active_time',
      message: 'The Goal used its active time allowance.',
      limit: limits.maxActiveMinutes,
      observed: Math.floor(activeMs / 60_000),
    };
  const baseline = goal.approved_at ?? goal.started_at;
  if (baseline) {
    const days = (Date.parse(context.now) - Date.parse(baseline)) / 86_400_000;
    if (days >= limits.maxWallClockDays)
      return {
        reason: 'bound_wall_clock',
        message: 'The Goal exceeded its wall clock allowance since approval.',
        limit: limits.maxWallClockDays,
        observed: Math.floor(days),
      };
  }
  const spend = goalMeteredSpendUsd(db, goalId);
  // A subscriptions-only Goal grants no metered permission at all; maxMeteredUsd only ever lowers a metered ceiling.
  const ceiling = limits.billingMode === 'subscriptions-only' ? 0 : (limits.maxMeteredUsd ?? 0);
  if (spend > 0 && spend >= ceiling)
    return {
      reason: 'bound_spend',
      message:
        limits.billingMode === 'subscriptions-only'
          ? 'Metered spend was recorded for a subscriptions-only Goal.'
          : 'The Goal reached its metered spend ceiling.',
      limit: ceiling,
      observed: spend,
    };
  return null;
}

/** Blocks the Goal through the state machine when a bound is breached. Returns the breach, or null. */
export function enforceBounds(db: Db, goalId: string, context: BoundsContext): BoundBreach | null {
  const breach = evaluateBounds(db, goalId, context);
  if (!breach) return null;
  const status = (
    db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string } | undefined
  )?.status;
  if (status === 'running' || status === 'reviewing')
    transitionGoal(db, {
      goalId,
      to: 'blocked',
      reasonCode: breach.reason,
      actor: 'supervisor',
      detail: { limit: breach.limit, observed: breach.observed },
      now: context.now,
    });
  return breach;
}
