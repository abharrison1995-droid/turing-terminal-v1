import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type {
  GoalDefinition,
  GoalDefinitionAuthor,
  GoalDefinitionStatus,
  GoalDefinitionVersion,
} from '../../shared/goals.js';
import { decideGoalApproval, getGoalApproval, requestGoalApproval } from './approvals.js';
import { hashGoalDefinition } from './definitionHash.js';
import {
  mergeValidations,
  validateGoalDefinition,
  validateGoalDefinitionContext,
  type DefinitionIssue,
  type DefinitionValidation,
  type WorkflowContext,
} from './definitionValidation.js';
import { writeGoalEvent } from './events.js';
import { transitionGoal } from './stateMachine.js';

export type GoalDefinitionErrorCode =
  | 'project_not_found'
  | 'goal_not_found'
  | 'definition_not_found'
  | 'definition_not_serialisable'
  | 'definition_not_editable'
  | 'definition_not_proposed'
  | 'definition_invalid'
  | 'definition_hash_mismatch'
  | 'definition_stale'
  | 'user_approval_required'
  | 'goal_not_amendable'
  | 'approval_definition_changed'
  | 'proposal_exists'
  | 'gate_denial_not_settled'
  | 'approval_mismatch';

export class GoalDefinitionError extends Error {
  constructor(
    readonly code: GoalDefinitionErrorCode,
    message: string,
    readonly issues: DefinitionIssue[] = [],
  ) {
    super(message);
    this.name = 'GoalDefinitionError';
  }
}

interface VersionRow {
  goal_id: string;
  version: number;
  parent_version: number | null;
  status: GoalDefinitionStatus;
  contract_json: string;
  milestones_json: string;
  routing_json: string;
  review_json: string;
  limits_json: string;
  definition_hash: string;
  change_summary: string;
  created_by: GoalDefinitionAuthor;
  approved_by: 'user' | null;
  approval_id: string | null;
  created_at: string;
  approved_at: string | null;
}

function hashOrThrow(definition: GoalDefinition): string {
  try {
    return hashGoalDefinition(definition);
  } catch (error) {
    throw new GoalDefinitionError('definition_not_serialisable', (error as Error).message);
  }
}

function serialise(definition: GoalDefinition) {
  return {
    contract: JSON.stringify(definition.contract),
    milestones: JSON.stringify(definition.milestones),
    routing: JSON.stringify(definition.routing),
    review: JSON.stringify(definition.review),
    limits: JSON.stringify(definition.limits),
  };
}

function toVersion(row: VersionRow): GoalDefinitionVersion {
  return {
    goalId: row.goal_id,
    version: row.version,
    parentVersion: row.parent_version,
    status: row.status,
    definition: {
      contract: JSON.parse(row.contract_json),
      milestones: JSON.parse(row.milestones_json),
      routing: JSON.parse(row.routing_json),
      review: JSON.parse(row.review_json),
      limits: JSON.parse(row.limits_json),
    },
    definitionHash: row.definition_hash,
    changeSummary: row.change_summary,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export function loadDefinitionVersion(
  db: Db,
  goalId: string,
  version: number,
): GoalDefinitionVersion | undefined {
  const row = db
    .prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
    .get(goalId, version) as VersionRow | undefined;
  return row ? toVersion(row) : undefined;
}

/** True when the stored hash equals the hash of the stored content. */
export function verifyDefinitionHash(version: GoalDefinitionVersion): boolean {
  try {
    return hashGoalDefinition(version.definition) === version.definitionHash;
  } catch {
    return false;
  }
}

function insertVersion(
  db: Db,
  input: {
    goalId: string;
    version: number;
    parentVersion: number | null;
    definition: GoalDefinition;
    changeSummary: string;
    createdBy: GoalDefinitionAuthor;
    now: string;
  },
): string {
  const hash = hashOrThrow(input.definition);
  const json = serialise(input.definition);
  db.prepare(
    `INSERT INTO goal_definition_versions (goal_id, version, parent_version, status, contract_json, milestones_json, routing_json,
       review_json, limits_json, definition_hash, change_summary, created_by, created_at)
     VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.goalId,
    input.version,
    input.parentVersion,
    json.contract,
    json.milestones,
    json.routing,
    json.review,
    json.limits,
    hash,
    input.changeSummary,
    input.createdBy,
    input.now,
  );
  writeGoalEvent(
    db,
    input.goalId,
    'definition_proposed',
    { version: input.version, parentVersion: input.parentVersion, definitionHash: hash },
    input.now,
  );
  return hash;
}

/**
 * Creates a draft Goal and its mutable runtime row with NO definition: no version row exists and
 * `current_definition_version` stays NULL. Must run inside the caller's transaction when it is part of a larger
 * atomic step (a nested call simply joins it).
 */
export function createGoalShell(
  db: Db,
  input: { projectId: string; title: string; goalId?: string; now?: string },
): { goalId: string } {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const project = db.prepare('SELECT machine_id FROM projects WHERE id = ?').get(input.projectId) as
      { machine_id: string } | undefined;
    if (!project) throw new GoalDefinitionError('project_not_found', 'The project does not exist.');
    const goalId = input.goalId ?? randomUUID();
    db.prepare(
      `INSERT INTO goals (id, machine_id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(goalId, project.machine_id, input.projectId, input.title, now, now);
    db.prepare('INSERT INTO goal_runtime (goal_id, updated_at) VALUES (?, ?)').run(goalId, now);
    writeGoalEvent(
      db,
      goalId,
      'goal_created',
      { projectId: input.projectId, title: input.title.slice(0, 200) },
      now,
    );
    return { goalId };
  })();
}

/** Creates a draft Goal with its mutable runtime row and a proposed version 1. The proposal may be incomplete. */
export function createGoalDraft(
  db: Db,
  input: {
    projectId: string;
    title: string;
    definition: GoalDefinition;
    changeSummary?: string;
    createdBy?: GoalDefinitionAuthor;
    goalId?: string;
    now?: string;
  },
): { goalId: string; version: number; definitionHash: string } {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const { goalId } = createGoalShell(db, {
      projectId: input.projectId,
      title: input.title,
      goalId: input.goalId,
      now,
    });
    const definitionHash = insertVersion(db, {
      goalId,
      version: 1,
      parentVersion: null,
      definition: input.definition,
      changeSummary: input.changeSummary ?? 'Initial definition',
      createdBy: input.createdBy ?? 'user',
      now,
    });
    return { goalId, version: 1, definitionHash };
  })();
}

/**
 * Stores an authoring run's output as proposed version 1 of a Goal that has no definition yet. Proves, inside the
 * caller's transaction, that the Goal is still a draft with no version and no current-definition pointer. It never
 * approves and never sets `goals.current_definition_version`.
 */
export function proposeAuthoredDefinition(
  db: Db,
  input: { goalId: string; definition: GoalDefinition; changeSummary: string; now?: string },
): { version: 1; definitionHash: string } {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const goal = db
      .prepare('SELECT status, current_definition_version FROM goals WHERE id = ?')
      .get(input.goalId) as { status: string; current_definition_version: number | null } | undefined;
    if (!goal) throw new GoalDefinitionError('goal_not_found', 'The Goal does not exist.');
    const existing = db
      .prepare('SELECT 1 FROM goal_definition_versions WHERE goal_id = ? LIMIT 1')
      .get(input.goalId);
    if (goal.status !== 'draft' || goal.current_definition_version !== null || existing)
      throw new GoalDefinitionError('proposal_exists', 'The Goal already has a definition.');
    const definitionHash = insertVersion(db, {
      goalId: input.goalId,
      version: 1,
      parentVersion: null,
      definition: input.definition,
      changeSummary: input.changeSummary,
      createdBy: 'authoring_run',
      now,
    });
    return { version: 1 as const, definitionHash };
  })();
}

/** Replaces the content of a proposed (undecided) version and recomputes its hash. */
export function editProposedDefinition(
  db: Db,
  input: { goalId: string; version: number; definition: GoalDefinition; changeSummary?: string },
): { definitionHash: string } {
  return db.transaction(() => {
    const existing = loadDefinitionVersion(db, input.goalId, input.version);
    if (!existing) throw new GoalDefinitionError('definition_not_found', 'No such definition version.');
    if (existing.status !== 'proposed')
      throw new GoalDefinitionError(
        'definition_not_editable',
        `A ${existing.status} definition cannot be edited.`,
      );
    const hash = hashOrThrow(input.definition);
    const json = serialise(input.definition);
    db.prepare(
      `UPDATE goal_definition_versions SET contract_json = ?, milestones_json = ?, routing_json = ?, review_json = ?, limits_json = ?,
         definition_hash = ?, change_summary = COALESCE(?, change_summary)
       WHERE goal_id = ? AND version = ? AND status = 'proposed'`,
    ).run(
      json.contract,
      json.milestones,
      json.routing,
      json.review,
      json.limits,
      hash,
      input.changeSummary ?? null,
      input.goalId,
      input.version,
    );
    return { definitionHash: hash };
  })();
}

export function validateStoredDefinition(
  db: Db,
  goalId: string,
  version: number,
  workflows?: readonly WorkflowContext[],
): DefinitionValidation {
  const stored = loadDefinitionVersion(db, goalId, version);
  if (!stored) throw new GoalDefinitionError('definition_not_found', 'No such definition version.');
  const pure = validateGoalDefinition(stored.definition);
  return workflows && pure.valid
    ? mergeValidations(pure, validateGoalDefinitionContext(stored.definition, workflows))
    : pure;
}

/**
 * Starts an amendment: quiesces the Goal (the supervisor launches nothing new) and creates a proposed N+1 that
 * copies the current approved definition. A ready Goal returns to draft instead (a revision before any run).
 */
export function beginAmendment(
  db: Db,
  input: {
    goalId: string;
    actor: 'user';
    changeSummary?: string;
    definition?: GoalDefinition;
    createdBy?: GoalDefinitionAuthor;
    now?: string;
  },
): { version: number; definitionHash: string } {
  if (input.actor !== 'user')
    throw new GoalDefinitionError('user_approval_required', 'Only the user starts an amendment.');
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const goal = db
      .prepare('SELECT status, status_reason_code, current_definition_version FROM goals WHERE id = ?')
      .get(input.goalId) as
      | { status: string; status_reason_code: string | null; current_definition_version: number | null }
      | undefined;
    if (!goal) throw new GoalDefinitionError('goal_not_found', 'The Goal does not exist.');
    const current = goal.current_definition_version;
    if (current === null)
      throw new GoalDefinitionError('goal_not_amendable', 'The Goal has no approved definition to amend.');
    if (
      db
        .prepare("SELECT 1 FROM goal_definition_versions WHERE goal_id = ? AND status = 'proposed'")
        .get(input.goalId)
    )
      throw new GoalDefinitionError('proposal_exists', 'An undecided proposal already exists for this Goal.');
    if (goal.status === 'ready')
      transitionGoal(db, {
        goalId: input.goalId,
        to: 'draft',
        reasonCode: 'user_revision',
        actor: 'user',
        now,
      });
    else if (goal.status === 'running' || goal.status === 'blocked' || goal.status === 'paused')
      transitionGoal(db, {
        goalId: input.goalId,
        to: 'needs_user',
        reasonCode: 'amendment_in_progress',
        actor: 'user',
        now,
      });
    else if (goal.status === 'needs_user' && goal.status_reason_code === 'amendment_in_progress') {
      // A previous proposal was discarded; the Goal is still quiesced for amendment.
    } else if (goal.status === 'needs_user' && goal.status_reason_code === 'gate_pending') {
      // Only a DENIED non-pool gate (proved from the exact approval in the status detail) may be revised. The supervisor
      // owns the denial's cycle cleanup, so an unsettled active cycle refuses; nothing is retired here.
      const detail = db
        .prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?')
        .get(input.goalId) as {
        d: string | null;
      };
      let named: { approvalId?: unknown; gate?: unknown } = {};
      try {
        named = detail.d ? (JSON.parse(detail.d) as typeof named) : {};
      } catch {
        named = {};
      }
      const approval =
        typeof named.approvalId === 'string' ? getGoalApproval(db, named.approvalId) : undefined;
      if (
        !approval ||
        approval.goalId !== input.goalId ||
        approval.status !== 'denied' ||
        approval.gate !== named.gate ||
        !['each_cycle', 'milestone_complete', 'final_acceptance'].includes(approval.gate)
      )
        throw new GoalDefinitionError(
          'goal_not_amendable',
          'A Goal waiting on a gate cannot be amended unless that gate was denied.',
        );
      if (
        db
          .prepare(
            "SELECT 1 FROM goal_cycles WHERE goal_id = ? AND status NOT IN ('succeeded','failed','cancelled','rejected')",
          )
          .get(input.goalId)
      )
        throw new GoalDefinitionError(
          'gate_denial_not_settled',
          'The gate denial has not been settled by the supervisor yet; retry shortly.',
        );
      transitionGoal(db, {
        goalId: input.goalId,
        to: 'needs_user',
        reasonCode: 'amendment_in_progress',
        actor: 'user',
        detail: { deniedApprovalId: approval.id, gate: approval.gate },
        now,
      });
    } else if (goal.status === 'needs_user' && goal.status_reason_code === 'scope_violation') {
      // Already quiesced by the supervisor. The reason is deliberately kept: it is cleared only by a resume that
      // follows an approved (or discarded) amendment, never merely because a proposal exists.
    } else throw new GoalDefinitionError('goal_not_amendable', `A ${goal.status} Goal cannot be amended.`);
    const base = loadDefinitionVersion(db, input.goalId, current)!;
    const next =
      (
        db
          .prepare('SELECT MAX(version) AS v FROM goal_definition_versions WHERE goal_id = ?')
          .get(input.goalId) as {
          v: number;
        }
      ).v + 1;
    const definitionHash = insertVersion(db, {
      goalId: input.goalId,
      version: next,
      parentVersion: current,
      definition: input.definition ?? base.definition,
      changeSummary: input.changeSummary ?? 'Amendment',
      createdBy: input.createdBy ?? 'user',
      now,
    });
    writeGoalEvent(db, input.goalId, 'amendment_started', { fromVersion: current, toVersion: next }, now);
    return { version: next, definitionHash };
  })();
}

export interface MilestoneReconciliation {
  added: string[];
  reopened: string[];
  skipped: string[];
}

/**
 * Reconciles milestone runtime rows with a newly approved definition, by stable milestone key: new keys are
 * pending, a satisfied milestone whose objective or criteria changed is re-opened, a skipped key that returns is
 * pending again, and a removed unfinished milestone is skipped. Existing statuses and runtime counters are otherwise
 * untouched. Runs inside the approval transaction.
 */
export function reconcileMilestones(
  db: Db,
  goalId: string,
  previous: GoalDefinition | null,
  next: GoalDefinition,
): MilestoneReconciliation {
  const result: MilestoneReconciliation = { added: [], reopened: [], skipped: [] };
  const rows = db
    .prepare('SELECT id, milestone_key, status FROM goal_milestones WHERE goal_id = ?')
    .all(goalId) as Array<{ id: string; milestone_key: string; status: string }>;
  const existing = new Map(rows.map((row) => [row.milestone_key, row]));
  const before = new Map((previous?.milestones ?? []).map((milestone) => [milestone.key, milestone]));
  const kept = new Set<string>();
  next.milestones.forEach((milestone, ordinal) => {
    kept.add(milestone.key);
    const row = existing.get(milestone.key);
    if (!row) {
      db.prepare(
        "INSERT INTO goal_milestones (id, goal_id, milestone_key, ordinal, status) VALUES (?, ?, ?, ?, 'pending')",
      ).run(randomUUID(), goalId, milestone.key, ordinal);
      result.added.push(milestone.key);
      return;
    }
    db.prepare('UPDATE goal_milestones SET ordinal = ? WHERE id = ?').run(ordinal, row.id);
    const old = before.get(milestone.key);
    const changed =
      old !== undefined &&
      (old.objective !== milestone.objective ||
        [...old.criteria].sort().join('\0') !== [...milestone.criteria].sort().join('\0'));
    if (row.status === 'skipped' || (row.status === 'satisfied' && changed)) {
      db.prepare("UPDATE goal_milestones SET status = 'pending', satisfied_at = NULL WHERE id = ?").run(
        row.id,
      );
      result.reopened.push(milestone.key);
    }
  });
  let tail = next.milestones.length;
  for (const row of rows) {
    if (kept.has(row.milestone_key)) continue;
    // Keys no longer in the definition sort after the live ones so ordinals stay unique.
    db.prepare('UPDATE goal_milestones SET ordinal = ? WHERE id = ?').run(tail++, row.id);
    if (row.status === 'satisfied' || row.status === 'skipped') continue;
    db.prepare("UPDATE goal_milestones SET status = 'skipped' WHERE id = ?").run(row.id);
    db.prepare('UPDATE goals SET active_milestone_id = NULL WHERE id = ? AND active_milestone_id = ?').run(
      goalId,
      row.id,
    );
    result.skipped.push(row.milestone_key);
  }
  return result;
}

/**
 * Approves a proposed version. User only. One transaction: validation, the approval record, supersession of the
 * parent, the new approved row, goals.current_definition_version, milestone reconciliation, the Goal's draft -> ready
 * transition (first approval, or a revision of a ready Goal) and the events. Any failure changes nothing. An
 * amendment of a running/blocked/paused Goal leaves the Goal in needs_user: the supervisor re-runs preflight and
 * moves it on. Runtime counters are never reset.
 */
export function approveDefinition(
  db: Db,
  input: {
    goalId: string;
    version: number;
    actor: 'user';
    approvalId?: string;
    note?: string;
    workflows?: readonly WorkflowContext[];
    now?: string;
  },
): {
  version: number;
  definitionHash: string;
  approvalId: string;
  warnings: DefinitionIssue[];
  milestones: MilestoneReconciliation;
} {
  if (input.actor !== 'user')
    throw new GoalDefinitionError('user_approval_required', 'A definition can only be approved by the user.');
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const goal = db
      .prepare('SELECT status, current_definition_version, approved_at FROM goals WHERE id = ?')
      .get(input.goalId) as
      { status: string; current_definition_version: number | null; approved_at: string | null } | undefined;
    if (!goal) throw new GoalDefinitionError('goal_not_found', 'The Goal does not exist.');
    const proposed = loadDefinitionVersion(db, input.goalId, input.version);
    if (!proposed) throw new GoalDefinitionError('definition_not_found', 'No such definition version.');
    if (proposed.status !== 'proposed')
      throw new GoalDefinitionError(
        'definition_not_proposed',
        `A ${proposed.status} definition cannot be approved.`,
      );
    if (!verifyDefinitionHash(proposed))
      throw new GoalDefinitionError(
        'definition_hash_mismatch',
        'The stored hash does not match the stored content.',
      );
    if (proposed.parentVersion !== goal.current_definition_version)
      throw new GoalDefinitionError(
        'definition_stale',
        'The proposal is not based on the current approved version.',
      );
    const amendment = goal.current_definition_version !== null;
    const reviseDraft = goal.status === 'draft';
    const amendInPlace = amendment && goal.status === 'needs_user';
    if (!reviseDraft && !amendInPlace)
      throw new GoalDefinitionError(
        'goal_not_amendable',
        `A ${goal.status} Goal cannot take a definition approval.`,
      );

    const validation = mergeValidations(
      validateGoalDefinition(proposed.definition),
      input.workflows
        ? validateGoalDefinitionContext(proposed.definition, input.workflows)
        : { valid: true, errors: [], warnings: [] },
    );
    if (!validation.valid)
      throw new GoalDefinitionError(
        'definition_invalid',
        `The definition has ${validation.errors.length} error(s).`,
        validation.errors,
      );

    const gate = amendment ? 'amendment' : 'definition';
    let approvalId = input.approvalId;
    if (approvalId) {
      const existing = getGoalApproval(db, approvalId);
      if (
        !existing ||
        existing.goalId !== input.goalId ||
        existing.gate !== gate ||
        existing.detail.version !== input.version
      )
        throw new GoalDefinitionError(
          'approval_mismatch',
          'The approval does not belong to this definition version.',
        );
      if (existing.detail.definitionHash !== proposed.definitionHash)
        throw new GoalDefinitionError(
          'approval_definition_changed',
          'The approval was bound to different definition content; request a new approval.',
        );
    } else {
      approvalId = requestGoalApproval(db, {
        goalId: input.goalId,
        gate,
        risk: amendment ? 'medium' : 'low',
        reason: `Approve definition version ${input.version}`,
        requestedBy: 'user',
        detail: { version: input.version, definitionHash: proposed.definitionHash },
        now,
      }).id;
    }
    decideGoalApproval(db, {
      goalId: input.goalId,
      approvalId,
      decision: 'approved',
      decidedBy: 'user',
      note: input.note,
      now,
    });

    const parent =
      proposed.parentVersion === null
        ? null
        : loadDefinitionVersion(db, input.goalId, proposed.parentVersion)!;
    if (parent) {
      if (parent.status !== 'approved')
        throw new GoalDefinitionError('definition_stale', 'The parent version is no longer approved.');
      db.prepare(
        "UPDATE goal_definition_versions SET status = 'superseded' WHERE goal_id = ? AND version = ?",
      ).run(input.goalId, parent.version);
    }
    db.prepare(
      `UPDATE goal_definition_versions SET status = 'approved', approved_by = 'user', approved_at = ?, approval_id = ?
       WHERE goal_id = ? AND version = ? AND status = 'proposed'`,
    ).run(now, approvalId, input.goalId, input.version);
    db.prepare(
      'UPDATE goals SET current_definition_version = ?, approved_at = COALESCE(approved_at, ?), updated_at = ? WHERE id = ?',
    ).run(input.version, now, now, input.goalId);
    const milestones = reconcileMilestones(db, input.goalId, parent?.definition ?? null, proposed.definition);
    if (reviseDraft)
      transitionGoal(db, {
        goalId: input.goalId,
        to: 'ready',
        reasonCode: 'definition_approved',
        actor: 'user',
        now,
      });
    writeGoalEvent(
      db,
      input.goalId,
      'definition_approved',
      {
        version: input.version,
        definitionHash: proposed.definitionHash,
        approvalId,
        supersededVersion: parent?.version ?? null,
        milestones: {
          added: milestones.added.length,
          reopened: milestones.reopened.length,
          skipped: milestones.skipped.length,
        },
      },
      now,
    );
    return {
      version: input.version,
      definitionHash: proposed.definitionHash,
      approvalId,
      warnings: validation.warnings,
      milestones,
    };
  })();
}

/**
 * Rejects (discards) a proposed version. User only. A ready Goal that was reopened for revision returns to ready; an
 * amendment of a running/blocked/paused Goal stays in needs_user for the supervisor to resume.
 */
export function rejectDefinition(
  db: Db,
  input: { goalId: string; version: number; actor: 'user'; now?: string },
): { version: number } {
  if (input.actor !== 'user')
    throw new GoalDefinitionError('user_approval_required', 'Only the user rejects a proposal.');
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const proposed = loadDefinitionVersion(db, input.goalId, input.version);
    if (!proposed) throw new GoalDefinitionError('definition_not_found', 'No such definition version.');
    if (proposed.status !== 'proposed')
      throw new GoalDefinitionError(
        'definition_not_proposed',
        `A ${proposed.status} definition cannot be rejected.`,
      );
    db.prepare(
      "UPDATE goal_definition_versions SET status = 'rejected' WHERE goal_id = ? AND version = ? AND status = 'proposed'",
    ).run(input.goalId, input.version);
    writeGoalEvent(
      db,
      input.goalId,
      'definition_rejected',
      { version: input.version, definitionHash: proposed.definitionHash },
      now,
    );
    const goal = db
      .prepare('SELECT status, current_definition_version FROM goals WHERE id = ?')
      .get(input.goalId) as {
      status: string;
      current_definition_version: number | null;
    };
    if (goal.status === 'draft' && goal.current_definition_version !== null)
      transitionGoal(db, {
        goalId: input.goalId,
        to: 'ready',
        reasonCode: 'amendment_discarded',
        actor: 'user',
        now,
      });
    return { version: input.version };
  })();
}
