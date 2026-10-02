import { randomUUID } from 'node:crypto';
import type {
  BillingLane,
  BillingMode,
  MeteredBudgetSettings,
  UnknownCostPolicy,
  WorkloadType,
} from '../shared/types.js';
import {
  addDays,
  isValidTimeZone,
  localDayKey,
  systemTimeZone,
  zonedMidnightUtc,
} from '../shared/timezone.js';
import type { Db } from './db.js';

/**
 * Turing-side metered spending control. Every metered request reserves a conservative amount
 * before it starts. The check and the insert run inside one BEGIN IMMEDIATE transaction, so
 * concurrent requests in this process (and other processes sharing the database) cannot both pass
 * a check against the same remaining budget. Actual provider cost later reconciles the
 * reservation; failures release it. These caps are separate from any provider-enforced key limit.
 */

const SETTINGS_KEY = 'metered_budget_settings';

export function defaultBudgetSettings(): MeteredBudgetSettings {
  return { dailyUsd: null, monthlyUsd: null, warningRatio: 0.8, timezone: null, updatedAt: null };
}

export function getBudgetSettings(db: Db): MeteredBudgetSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    { value: string } | undefined;
  if (!row) return defaultBudgetSettings();
  try {
    return { ...defaultBudgetSettings(), ...(JSON.parse(row.value) as Partial<MeteredBudgetSettings>) };
  } catch {
    return defaultBudgetSettings();
  }
}

export function saveBudgetSettings(
  db: Db,
  value: Omit<MeteredBudgetSettings, 'updatedAt'>,
): MeteredBudgetSettings {
  const saved: MeteredBudgetSettings = {
    dailyUsd: value.dailyUsd,
    monthlyUsd: value.monthlyUsd,
    warningRatio: value.warningRatio,
    timezone: value.timezone && isValidTimeZone(value.timezone) ? value.timezone : null,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(SETTINGS_KEY, JSON.stringify(saved), saved.updatedAt);
  return saved;
}

export function budgetTimeZone(settings: MeteredBudgetSettings): string {
  return settings.timezone && isValidTimeZone(settings.timezone) ? settings.timezone : systemTimeZone();
}

export interface ReservationRequest {
  runId: string | null;
  stageId: string | null;
  billingLane: BillingLane;
  connectionProfileId: string | null;
  workload: WorkloadType;
  billingMode: BillingMode;
  /** Conservative upper bound in USD, or null when the request cost cannot be bounded. */
  amountUsd: number | null;
  perRunUsd: number | null;
  unknownCostPolicy: UnknownCostPolicy;
  /** Set only after the user explicitly approved an unbounded request under the Ask policy. */
  unboundedApproved?: boolean;
  reason: string;
  now?: number;
}

export type ReservationOutcome =
  | { ok: true; reservationId: string; bounded: boolean; warnings: string[] }
  | {
      ok: false;
      code: 'cap_exceeded' | 'unknown_cost_blocked' | 'unknown_cost_needs_approval' | 'run_cap_required';
      reason: string;
    };

interface WindowCommit {
  committed: number;
}

function committedSql(where: string): string {
  return `SELECT COALESCE(SUM(CASE
      WHEN status = 'reserved' THEN reserved_usd
      WHEN status = 'reconciled' THEN COALESCE(actual_usd, reserved_usd)
      ELSE COALESCE(actual_usd, 0) END), 0) AS committed
    FROM metered_reservations WHERE ${where}`;
}

export function budgetWindows(settings: MeteredBudgetSettings, now = Date.now()) {
  const timeZone = budgetTimeZone(settings);
  const today = localDayKey(now, timeZone);
  const monthStart = `${today.slice(0, 8)}01`;
  const [year, month] = today.split('-').map(Number) as [number, number];
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return {
    timeZone,
    dayFrom: zonedMidnightUtc(today, timeZone).toISOString(),
    dayTo: zonedMidnightUtc(addDays(today, 1), timeZone).toISOString(),
    monthFrom: zonedMidnightUtc(monthStart, timeZone).toISOString(),
    monthTo: zonedMidnightUtc(nextMonth, timeZone).toISOString(),
  };
}

export function budgetStatus(db: Db, runId: string | null, perRunUsd: number | null, now = Date.now()) {
  const settings = getBudgetSettings(db);
  const windows = budgetWindows(settings, now);
  const run = runId ? (db.prepare(committedSql('run_id = ?')).get(runId) as WindowCommit).committed : 0;
  const day = (
    db
      .prepare(committedSql('created_at >= ? AND created_at < ?'))
      .get(windows.dayFrom, windows.dayTo) as WindowCommit
  ).committed;
  const month = (
    db
      .prepare(committedSql('created_at >= ? AND created_at < ?'))
      .get(windows.monthFrom, windows.monthTo) as WindowCommit
  ).committed;
  return {
    timeZone: windows.timeZone,
    run: { committedUsd: run, capUsd: perRunUsd },
    daily: { committedUsd: day, capUsd: settings.dailyUsd },
    monthly: { committedUsd: month, capUsd: settings.monthlyUsd },
    warningRatio: settings.warningRatio,
  };
}

export function reserveMetered(db: Db, request: ReservationRequest): ReservationOutcome {
  const now = request.now ?? Date.now();
  const attempt = db.transaction((): ReservationOutcome => {
    if (request.billingMode === 'subscriptions-plus-decision-budget' && request.perRunUsd === null)
      return {
        ok: false,
        code: 'run_cap_required',
        reason:
          'Subscriptions + Decision Budget requires a per-run metered cap before any Decision Engine may spend.',
      };
    const status = budgetStatus(db, request.runId, request.perRunUsd, now);
    const bounded = request.amountUsd !== null && Number.isFinite(request.amountUsd);
    if (!bounded) {
      if (request.unknownCostPolicy === 'block')
        return {
          ok: false,
          code: 'unknown_cost_blocked',
          reason:
            'This metered request cannot be cost-bounded before launch, and the unknown-cost policy is Block.',
        };
      if (request.unknownCostPolicy === 'ask' && !request.unboundedApproved)
        return {
          ok: false,
          code: 'unknown_cost_needs_approval',
          reason: 'This metered request cannot be cost-bounded before launch. Approval is required.',
        };
    }
    const amount = bounded ? Math.max(0, request.amountUsd!) : 0;
    const caps: Array<[string, number, number | null]> = [
      ['per-run', status.run.committedUsd, request.runId ? request.perRunUsd : null],
      ['daily', status.daily.committedUsd, status.daily.capUsd],
      ['monthly', status.monthly.committedUsd, status.monthly.capUsd],
    ];
    const warnings: string[] = [];
    for (const [name, committed, cap] of caps) {
      if (cap === null) continue;
      // Unbounded requests may only start while the window still has headroom; a hard cap is
      // then explicitly not guaranteed.
      if (committed + amount > cap + 1e-12 || (!bounded && committed >= cap))
        return {
          ok: false,
          code: 'cap_exceeded',
          reason: `The ${name} Turing metered budget ($${cap.toFixed(4)}) would be exceeded: $${committed.toFixed(4)} committed + $${amount.toFixed(4)} reserved.`,
        };
      if (cap > 0 && (committed + amount) / cap >= status.warningRatio)
        warnings.push(
          `${name} metered budget is at ${Math.round(((committed + amount) / cap) * 100)}% of $${cap.toFixed(2)}.`,
        );
    }
    if (!bounded)
      warnings.push('Unbounded metered request: Turing cannot guarantee the hard cap for this request.');
    const id = randomUUID();
    db.prepare(
      `INSERT INTO metered_reservations (id, run_id, stage_id, billing_lane, connection_profile_id, workload_type, reserved_usd, status, cost_bound, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    ).run(
      id,
      request.runId,
      request.stageId,
      request.billingLane,
      request.connectionProfileId,
      request.workload,
      amount,
      bounded ? 'bounded' : 'unbounded',
      request.reason.slice(0, 300),
      new Date(now).toISOString(),
    );
    return { ok: true, reservationId: id, bounded, warnings };
  });
  return attempt.immediate();
}

export function attachReservationUsage(db: Db, reservationId: string, usageEventId: string): void {
  db.prepare('UPDATE metered_reservations SET usage_event_id = ? WHERE id = ?').run(
    usageEventId,
    reservationId,
  );
}

/** Replace the reservation with provider-measured actual cost; unused headroom is released. */
export function reconcileReservation(
  db: Db,
  reservationId: string,
  actualUsd: number | null,
  provenance: string,
): { overrunUsd: number } {
  const row = db
    .prepare('SELECT reserved_usd, status FROM metered_reservations WHERE id = ?')
    .get(reservationId) as { reserved_usd: number; status: string } | undefined;
  if (!row || row.status !== 'reserved') return { overrunUsd: 0 };
  db.prepare(
    "UPDATE metered_reservations SET status = 'reconciled', actual_usd = ?, actual_provenance = ?, settled_at = ? WHERE id = ?",
  ).run(actualUsd, provenance, new Date().toISOString(), reservationId);
  return { overrunUsd: actualUsd !== null ? Math.max(0, actualUsd - row.reserved_usd) : 0 };
}

/** Release a reservation for a request that failed or was cancelled before any provider charge was reported. */
export function releaseReservation(db: Db, reservationId: string, reason: string): void {
  db.prepare(
    "UPDATE metered_reservations SET status = 'released', settled_at = ?, reason = substr(reason || ' · ' || ?, 1, 300) WHERE id = ? AND status = 'reserved'",
  ).run(new Date().toISOString(), reason, reservationId);
}
