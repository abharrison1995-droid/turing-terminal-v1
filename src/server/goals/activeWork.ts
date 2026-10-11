import { TERMINAL_RUN_STATUSES } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { activeCycle } from './cycles.js';
import { isManualReconciliation } from './readModel.js';

/** The blocker codes, in the order `activeWorkBlocker` checks them. Every code is also a ManualHandoffErrorCode. */
export type ActiveWorkBlocker =
  'manual_reconciliation_required' | 'active_work' | 'pending_review' | 'integration_operation_in_progress';

/**
 * The single read-only predicate for "this Goal has work that could still change its history". Shared by the manual
 * handoff (`ensureNoActiveWork`) and the external completion terminal, so the two cannot drift. It returns the first
 * blocker in fixed order, or null. It never writes, never repairs and never reads Git.
 */
export function activeWorkBlocker(db: Db, goalId: string): ActiveWorkBlocker | null {
  if (isManualReconciliation(db, goalId)) return 'manual_reconciliation_required';
  if (activeCycle(db, goalId)) return 'active_work';
  const placeholders = [...TERMINAL_RUN_STATUSES].map(() => '?').join(', ');
  if (
    db
      .prepare(
        `SELECT 1 FROM goal_runs gr JOIN runs r ON r.id = gr.run_id
         WHERE gr.goal_id = ? AND r.status NOT IN (${placeholders}) LIMIT 1`,
      )
      .get(goalId, ...TERMINAL_RUN_STATUSES)
  )
    return 'active_work';
  if (db.prepare("SELECT 1 FROM goal_reviews WHERE goal_id = ? AND status = 'pending' LIMIT 1").get(goalId))
    return 'pending_review';
  if (
    db
      .prepare("SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND status = 'planned' LIMIT 1")
      .get(goalId)
  )
    return 'integration_operation_in_progress';
  if (
    db
      .prepare(
        "SELECT 1 FROM goal_integration_ops WHERE goal_id = ? AND op = 'apply_to_base' AND status IN ('applied','failed') LIMIT 1",
      )
      .get(goalId)
  )
    return 'manual_reconciliation_required';
  return null;
}
