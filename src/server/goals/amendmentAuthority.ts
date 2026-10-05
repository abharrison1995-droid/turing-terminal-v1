import type { Db } from '../db.js';
import { getGoalApproval } from './approvals.js';
import { loadDefinitionVersion } from './definitions.js';

/**
 * `amendment_approved` and `amendment_discarded` are facts, not caller labels. Before the supervisor accepts either as
 * the reason for leaving `needs_user`, this module proves from persisted history that the matching amendment action
 * happened after the Goal entered its current quiescent episode. Ordering uses `goal_events` insertion order (rowid),
 * the append-only authoritative history; timestamps are never compared.
 */
export type AmendmentReason = 'amendment_approved' | 'amendment_discarded';

export type AmendmentResolution = { ok: true } | { ok: false; why: string };

interface EventRow {
  rowid: number;
  payload_json: string;
}

function payload<T>(row: EventRow): Partial<T> {
  try {
    return JSON.parse(row.payload_json) as Partial<T>;
  } catch {
    return {};
  }
}

/** rowid of the event that began the Goal's current `needs_user` episode, or null when it is not in one. */
function episodeStart(db: Db, goalId: string): number | null {
  const rows = db
    .prepare(
      "SELECT rowid, payload_json FROM goal_events WHERE goal_id = ? AND type = 'state_changed' ORDER BY rowid DESC",
    )
    .all(goalId) as EventRow[];
  for (const row of rows) if (payload<{ to: string }>(row).to === 'needs_user') return row.rowid;
  return null;
}

export function verifyAmendmentResolution(
  db: Db,
  goalId: string,
  reason: AmendmentReason,
): AmendmentResolution {
  const goal = db.prepare('SELECT status, current_definition_version FROM goals WHERE id = ?').get(goalId) as
    { status: string; current_definition_version: number | null } | undefined;
  if (!goal || goal.status !== 'needs_user' || goal.current_definition_version === null)
    return { ok: false, why: 'not_quiesced' };
  const start = episodeStart(db, goalId);
  if (start === null) return { ok: false, why: 'no_episode' };
  // An undecided proposal means the amendment is still in progress.
  if (
    db.prepare("SELECT 1 FROM goal_definition_versions WHERE goal_id = ? AND status = 'proposed'").get(goalId)
  )
    return { ok: false, why: 'proposal_undecided' };
  const current = goal.current_definition_version;

  if (reason === 'amendment_approved') {
    const events = db
      .prepare(
        "SELECT rowid, payload_json FROM goal_events WHERE goal_id = ? AND type = 'definition_approved' AND rowid > ? ORDER BY rowid DESC",
      )
      .all(goalId, start) as EventRow[];
    const event = events.find((row) => payload<{ version: number }>(row).version === current);
    if (!event) return { ok: false, why: 'no_approval_event' };
    const recorded = payload<{ supersededVersion: number | null; approvalId: string }>(event);
    const version = loadDefinitionVersion(db, goalId, current);
    if (
      !version ||
      version.status !== 'approved' ||
      version.parentVersion === null ||
      version.approvedBy !== 'user' ||
      !version.approvalId ||
      recorded.supersededVersion !== version.parentVersion ||
      recorded.approvalId !== version.approvalId
    )
      return { ok: false, why: 'definition_not_an_approved_amendment' };
    const approval = getGoalApproval(db, version.approvalId);
    if (
      !approval ||
      approval.goalId !== goalId ||
      approval.gate !== 'amendment' ||
      approval.status !== 'approved' ||
      approval.decidedBy !== 'user' ||
      approval.detail.version !== current ||
      approval.detail.definitionHash !== version.definitionHash
    )
      return { ok: false, why: 'approval_invalid' };
    return { ok: true };
  }

  const events = db
    .prepare(
      "SELECT rowid, payload_json FROM goal_events WHERE goal_id = ? AND type = 'definition_rejected' AND rowid > ? ORDER BY rowid DESC",
    )
    .all(goalId, start) as EventRow[];
  for (const row of events) {
    const rejected = loadDefinitionVersion(db, goalId, payload<{ version: number }>(row).version ?? -1);
    if (rejected && rejected.status === 'rejected' && rejected.parentVersion === current) return { ok: true };
  }
  return { ok: false, why: 'no_rejection_event' };
}
