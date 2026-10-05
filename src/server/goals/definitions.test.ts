import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { GoalDefinition } from '../../shared/goals.js';
import { getGoalApproval, requestGoalApproval } from './approvals.js';
import { hashGoalDefinition } from './definitionHash.js';
import {
  GoalDefinitionError,
  approveDefinition,
  beginAmendment,
  createGoalDraft,
  editProposedDefinition,
  loadDefinitionVersion,
  rejectDefinition,
  validateStoredDefinition,
  verifyDefinitionHash,
} from './definitions.js';
import { listGoalEvents } from './events.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';

afterEach(cleanupTestDatabases);

function setup(definition: GoalDefinition = validDefinition()) {
  const db = freshDatabase();
  const projectId = seedProject(db);
  const created = createGoalDraft(db, { projectId, title: 'Goal', definition });
  return { db, projectId, ...created };
}

const goalRow = (db: Db, goalId: string) =>
  db
    .prepare(
      'SELECT status, status_reason_code, current_definition_version, approved_at FROM goals WHERE id = ?',
    )
    .get(goalId) as {
    status: string;
    status_reason_code: string | null;
    current_definition_version: number | null;
    approved_at: string | null;
  };
const milestones = (db: Db, goalId: string) =>
  db
    .prepare('SELECT milestone_key, ordinal, status FROM goal_milestones WHERE goal_id = ? ORDER BY ordinal')
    .all(goalId) as Array<{
    milestone_key: string;
    ordinal: number;
    status: string;
  }>;
const statuses = (db: Db, goalId: string) =>
  db
    .prepare('SELECT version, status FROM goal_definition_versions WHERE goal_id = ? ORDER BY version')
    .all(goalId);
const approvalCount = (db: Db) =>
  (db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get() as { n: number }).n;
const eventTypes = (db: Db, goalId: string) => listGoalEvents(db, goalId).map((event) => event.type);

/** A running Goal with real counters and a satisfied first milestone, ready to be amended. */
function runningGoal() {
  const ctx = setup();
  approveDefinition(ctx.db, { goalId: ctx.goalId, version: 1, actor: 'user' });
  ctx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(ctx.goalId);
  ctx.db
    .prepare(
      'UPDATE goal_runtime SET cycles_executed = 7, consecutive_failed_cycles = 2, active_ms = 123456, remediation_attempts_json = \'{"core":2}\', memory_json = \'{"note":1}\' WHERE goal_id = ?',
    )
    .run(ctx.goalId);
  ctx.db
    .prepare(
      "UPDATE goal_milestones SET status = 'satisfied', satisfied_at = '2026-01-02T00:00:00Z' WHERE milestone_key = 'core'",
    )
    .run();
  return ctx;
}
const counters = (db: Db, goalId: string) =>
  db
    .prepare(
      'SELECT cycles_executed, consecutive_failed_cycles, active_ms, remediation_attempts_json, memory_json FROM goal_runtime WHERE goal_id = ?',
    )
    .get(goalId);

/** An amendment of validDefinition(): core changes objective and takes over `tests`, polish is removed, extra is added. */
function amended(): GoalDefinition {
  const d = validDefinition();
  d.milestones[0]!.objective = 'Build the core, differently';
  d.milestones[0]!.criteria = ['builds', 'tests'];
  d.milestones[0]!.requiredEvidence.push({ criterionKey: 'tests', kinds: ['test_result'] });
  d.milestones = [
    d.milestones[0]!,
    {
      key: 'extra',
      title: 'Extra',
      objective: 'Extra work',
      criteria: [],
      dependsOn: ['core'],
      allowedScope: { includeGlobs: ['src/**'], excludeGlobs: [] },
      requiredEvidence: [],
      reviewRequirements: { milestoneReview: false },
    },
  ];
  d.limits.maxExecutionCycles = 40;
  return d;
}

describe('createGoalDraft', () => {
  it('creates a draft Goal, its runtime row and a proposed version 1', () => {
    const { db, goalId, definitionHash } = setup();
    expect(goalRow(db, goalId)).toMatchObject({ status: 'draft', current_definition_version: null });
    expect(
      db.prepare('SELECT cycles_executed, active_ms FROM goal_runtime WHERE goal_id = ?').get(goalId),
    ).toEqual({
      cycles_executed: 0,
      active_ms: 0,
    });
    const v1 = loadDefinitionVersion(db, goalId, 1)!;
    expect(v1).toMatchObject({ status: 'proposed', parentVersion: null, approvedBy: null, definitionHash });
    expect(definitionHash).toBe(hashGoalDefinition(validDefinition()));
    expect(verifyDefinitionHash(v1)).toBe(true);
    expect(eventTypes(db, goalId)).toEqual(['goal_created', 'definition_proposed']);
  });

  it('keeps an incomplete proposal editable, then validates it on approval', () => {
    const incomplete = validDefinition();
    incomplete.contract.outcome = '';
    const { db, goalId } = setup(incomplete);
    expect(validateStoredDefinition(db, goalId, 1).errors.map((e) => e.code)).toContain(
      'contract.outcome_empty',
    );
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_invalid' }),
    );
    expect(statuses(db, goalId)).toEqual([{ version: 1, status: 'proposed' }]);
    const { definitionHash } = editProposedDefinition(db, {
      goalId,
      version: 1,
      definition: validDefinition(),
      changeSummary: 'fixed',
    });
    expect(definitionHash).toBe(hashGoalDefinition(validDefinition()));
    expect(approveDefinition(db, { goalId, version: 1, actor: 'user' }).version).toBe(1);
  });

  it('reports a missing project and an unserialisable definition', () => {
    const db = freshDatabase();
    expect(() =>
      createGoalDraft(db, { projectId: 'ghost', title: 'G', definition: validDefinition() }),
    ).toThrow(expect.objectContaining({ code: 'project_not_found' }));
    const bad = validDefinition();
    bad.limits.maxExecutionCycles = Infinity;
    expect(() => createGoalDraft(db, { projectId: seedProject(db), title: 'G', definition: bad })).toThrow(
      expect.objectContaining({ code: 'definition_not_serialisable' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM goals').get()).toEqual({ n: 0 });
  });
});

describe('approveDefinition (first approval)', () => {
  it('approves v1, points the Goal at it and makes it ready in one transaction', () => {
    const { db, goalId } = setup();
    const result = approveDefinition(db, { goalId, version: 1, actor: 'user', note: 'go' });
    expect(result.milestones.added).toEqual(['core', 'polish']);
    expect(goalRow(db, goalId)).toMatchObject({
      status: 'ready',
      status_reason_code: 'definition_approved',
      current_definition_version: 1,
    });
    expect(goalRow(db, goalId).approved_at).not.toBeNull();
    expect(loadDefinitionVersion(db, goalId, 1)).toMatchObject({
      status: 'approved',
      approvedBy: 'user',
      approvalId: result.approvalId,
    });
    expect(getGoalApproval(db, result.approvalId)).toMatchObject({
      gate: 'definition',
      status: 'approved',
      decidedBy: 'user',
      decisionNote: 'go',
      detail: { version: 1 },
    });
    expect(milestones(db, goalId)).toEqual([
      { milestone_key: 'core', ordinal: 0, status: 'pending' },
      { milestone_key: 'polish', ordinal: 1, status: 'pending' },
    ]);
    expect(eventTypes(db, goalId)).toEqual([
      'goal_created',
      'definition_proposed',
      'approval_requested',
      'approval_decided',
      'state_changed',
      'definition_approved',
    ]);
  });

  it('can only be done by the user', () => {
    const { db, goalId } = setup();
    for (const actor of ['model', 'supervisor', 'system', undefined])
      expect(() => approveDefinition(db, { goalId, version: 1, actor: actor as never })).toThrow(
        expect.objectContaining({ code: 'user_approval_required' }),
      );
    expect(() => beginAmendment(db, { goalId, actor: 'supervisor' as never })).toThrow(
      expect.objectContaining({ code: 'user_approval_required' }),
    );
    expect(() => rejectDefinition(db, { goalId, version: 1, actor: 'model' as never })).toThrow(
      expect.objectContaining({ code: 'user_approval_required' }),
    );
    expect(statuses(db, goalId)).toEqual([{ version: 1, status: 'proposed' }]);
    expect(approvalCount(db)).toBe(0);
  });

  it('refuses a tampered stored hash', () => {
    const { db, goalId } = setup();
    db.prepare(
      'UPDATE goal_definition_versions SET limits_json = REPLACE(limits_json, \'"maxExecutionCycles":20\', \'"maxExecutionCycles":21\') WHERE goal_id = ?',
    ).run(goalId);
    expect(verifyDefinitionHash(loadDefinitionVersion(db, goalId, 1)!)).toBe(false);
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_hash_mismatch' }),
    );
    expect(goalRow(db, goalId).status).toBe('draft');
  });

  it('validates against supplied workflows', () => {
    const { db, goalId } = setup();
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user', workflows: [] })).toThrow(
      expect.objectContaining({
        code: 'definition_invalid',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'context.workflow_missing' })]),
      }),
    );
    expect(goalRow(db, goalId).status).toBe('draft');
  });

  it('uses a pre-existing pending approval only when it matches the exact version and hash', () => {
    const { db, goalId, definitionHash } = setup();
    const wrongGate = requestGoalApproval(db, {
      goalId,
      gate: 'start',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: { version: 1, definitionHash },
    });
    expect(() =>
      approveDefinition(db, { goalId, version: 1, actor: 'user', approvalId: wrongGate.id }),
    ).toThrow(expect.objectContaining({ code: 'approval_mismatch' }));
    const wrongVersion = requestGoalApproval(db, {
      goalId,
      gate: 'definition',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: { version: 2, definitionHash },
    });
    expect(() =>
      approveDefinition(db, { goalId, version: 1, actor: 'user', approvalId: wrongVersion.id }),
    ).toThrow(expect.objectContaining({ code: 'approval_mismatch' }));
    const noHash = requestGoalApproval(db, {
      goalId,
      gate: 'definition',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: { version: 1 },
    });
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user', approvalId: noHash.id })).toThrow(
      expect.objectContaining({ code: 'approval_definition_changed' }),
    );
    const right = requestGoalApproval(db, {
      goalId,
      gate: 'definition',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: { version: 1, definitionHash },
    });
    expect(
      approveDefinition(db, { goalId, version: 1, actor: 'user', approvalId: right.id }).approvalId,
    ).toBe(right.id);
    expect(getGoalApproval(db, right.id)!.status).toBe('approved');
  });

  it('does not let an approval bound to an earlier hash approve edited content', () => {
    const { db, goalId, definitionHash: h1 } = setup();
    const stale = requestGoalApproval(db, {
      goalId,
      gate: 'definition',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: { version: 1, definitionHash: h1 },
    });
    const edited = validDefinition();
    edited.limits.maxExecutionCycles = 25;
    const { definitionHash: h2 } = editProposedDefinition(db, { goalId, version: 1, definition: edited });
    expect(h2).not.toBe(h1);
    const before = {
      goal: goalRow(db, goalId),
      versions: statuses(db, goalId),
      events: eventTypes(db, goalId),
    };
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user', approvalId: stale.id })).toThrow(
      expect.objectContaining({ code: 'approval_definition_changed' }),
    );
    expect(getGoalApproval(db, stale.id)).toMatchObject({ status: 'pending', decidedBy: null });
    expect(statuses(db, goalId)).toEqual(before.versions);
    expect(goalRow(db, goalId)).toEqual(before.goal);
    expect(eventTypes(db, goalId)).toEqual(before.events);
    expect(loadDefinitionVersion(db, goalId, 1)).toMatchObject({ status: 'proposed', definitionHash: h2 });

    const fresh = requestGoalApproval(db, {
      goalId,
      gate: 'definition',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: { version: 1, definitionHash: h2 },
    });
    expect(approveDefinition(db, { goalId, version: 1, actor: 'user', approvalId: fresh.id })).toMatchObject({
      approvalId: fresh.id,
      definitionHash: h2,
    });
    expect(getGoalApproval(db, stale.id)!.status).toBe('pending');
    expect(loadDefinitionVersion(db, goalId, 1)).toMatchObject({ status: 'approved', approvalId: fresh.id });
  });

  it('keeps approved content immutable, in the service and in SQL', () => {
    const { db, goalId } = setup();
    approveDefinition(db, { goalId, version: 1, actor: 'user' });
    expect(() => editProposedDefinition(db, { goalId, version: 1, definition: validDefinition() })).toThrow(
      expect.objectContaining({ code: 'definition_not_editable' }),
    );
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_not_proposed' }),
    );
    expect(() =>
      db.prepare("UPDATE goal_definition_versions SET contract_json = '{}' WHERE goal_id = ?").run(goalId),
    ).toThrow(/immutable/);
  });
});

describe('rejectDefinition', () => {
  it('rejects a proposal terminally and leaves a draft Goal draft', () => {
    const { db, goalId } = setup();
    rejectDefinition(db, { goalId, version: 1, actor: 'user' });
    expect(statuses(db, goalId)).toEqual([{ version: 1, status: 'rejected' }]);
    expect(goalRow(db, goalId)).toMatchObject({ status: 'draft', current_definition_version: null });
    expect(eventTypes(db, goalId).at(-1)).toBe('definition_rejected');
    expect(() => approveDefinition(db, { goalId, version: 1, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_not_proposed' }),
    );
    expect(() => rejectDefinition(db, { goalId, version: 1, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_not_proposed' }),
    );
    expect(() =>
      db
        .prepare(
          "UPDATE goal_definition_versions SET status = 'approved', approved_by = 'user', approved_at = 'x' WHERE goal_id = ?",
        )
        .run(goalId),
    ).toThrow(/illegal|bound to this goal/);
  });
});

describe('amendment', () => {
  it('begins by quiescing the Goal and copying the approved definition as proposal N+1', () => {
    const { db, goalId } = runningGoal();
    const { version, definitionHash } = beginAmendment(db, {
      goalId,
      actor: 'user',
      changeSummary: 'raise limits',
    });
    expect(version).toBe(2);
    expect(definitionHash).toBe(loadDefinitionVersion(db, goalId, 1)!.definitionHash);
    expect(goalRow(db, goalId)).toMatchObject({
      status: 'needs_user',
      status_reason_code: 'amendment_in_progress',
      current_definition_version: 1,
    });
    expect(loadDefinitionVersion(db, goalId, 2)).toMatchObject({
      status: 'proposed',
      parentVersion: 1,
      changeSummary: 'raise limits',
    });
    expect(eventTypes(db, goalId).slice(-3)).toEqual([
      'state_changed',
      'definition_proposed',
      'amendment_started',
    ]);
    expect(() => beginAmendment(db, { goalId, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'proposal_exists' }),
    );
  });

  it('atomically supersedes N, approves N+1, reconciles milestones by key and keeps runtime counters', () => {
    const { db, goalId } = runningGoal();
    const before = counters(db, goalId);
    const { version } = beginAmendment(db, { goalId, actor: 'user', definition: amended() });
    const result = approveDefinition(db, { goalId, version, actor: 'user' });
    expect(statuses(db, goalId)).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'approved' },
    ]);
    expect(goalRow(db, goalId)).toMatchObject({ status: 'needs_user', current_definition_version: 2 });
    expect(getGoalApproval(db, result.approvalId)).toMatchObject({
      gate: 'amendment',
      status: 'approved',
      decidedBy: 'user',
    });
    expect(result.milestones).toEqual({ added: ['extra'], reopened: ['core'], skipped: ['polish'] });
    expect(milestones(db, goalId)).toEqual([
      { milestone_key: 'core', ordinal: 0, status: 'pending' },
      { milestone_key: 'extra', ordinal: 1, status: 'pending' },
      { milestone_key: 'polish', ordinal: 2, status: 'skipped' },
    ]);
    expect(counters(db, goalId)).toEqual(before);
    expect(db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId)).toEqual({
      integration_head: null,
    });
    expect(listGoalEvents(db, goalId).at(-1)).toMatchObject({
      type: 'definition_approved',
      payload: { version: 2, supersededVersion: 1, milestones: { added: 1, reopened: 1, skipped: 1 } },
    });
    // Old rows keep explaining history.
    expect(loadDefinitionVersion(db, goalId, 1)!.definition.limits.maxExecutionCycles).toBe(20);
    expect(loadDefinitionVersion(db, goalId, 2)!.definition.limits.maxExecutionCycles).toBe(40);
  });

  it('does not re-open a satisfied milestone whose objective and criteria are unchanged', () => {
    const { db, goalId } = runningGoal();
    const same = validDefinition();
    same.limits.maxExecutionCycles = 60;
    const { version } = beginAmendment(db, { goalId, actor: 'user', definition: same });
    const result = approveDefinition(db, { goalId, version, actor: 'user' });
    expect(result.milestones).toEqual({ added: [], reopened: [], skipped: [] });
    expect(milestones(db, goalId).find((m) => m.milestone_key === 'core')!.status).toBe('satisfied');
  });

  it('rolls everything back on a deliberate fault part-way through approval', () => {
    const { db, goalId } = runningGoal();
    const before = counters(db, goalId);
    const { version } = beginAmendment(db, { goalId, actor: 'user', definition: amended() });
    const approvalsBefore = approvalCount(db);
    const eventsBefore = listGoalEvents(db, goalId).length;
    const milestonesBefore = milestones(db, goalId);
    db.exec(`CREATE TRIGGER fail_new_milestone BEFORE INSERT ON goal_milestones
             BEGIN SELECT RAISE(ABORT, 'injected fault'); END`);
    expect(() => approveDefinition(db, { goalId, version, actor: 'user' })).toThrow(/injected fault/);
    expect(statuses(db, goalId)).toEqual([
      { version: 1, status: 'approved' },
      { version: 2, status: 'proposed' },
    ]);
    expect(goalRow(db, goalId)).toMatchObject({ status: 'needs_user', current_definition_version: 1 });
    expect(approvalCount(db)).toBe(approvalsBefore);
    expect(listGoalEvents(db, goalId)).toHaveLength(eventsBefore);
    expect(milestones(db, goalId)).toEqual(milestonesBefore);
    expect(counters(db, goalId)).toEqual(before);
    expect(loadDefinitionVersion(db, goalId, 1)!.approvalId).not.toBeNull();
    // With the fault removed the very same approval succeeds.
    db.exec('DROP TRIGGER fail_new_milestone');
    expect(approveDefinition(db, { goalId, version, actor: 'user' }).version).toBe(2);
  });

  it('refuses an invalid amendment without changing anything', () => {
    const { db, goalId } = runningGoal();
    const broken = validDefinition();
    broken.limits.maxExecutionCycles = 0;
    const { version } = beginAmendment(db, { goalId, actor: 'user', definition: broken });
    expect(() => approveDefinition(db, { goalId, version, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_invalid' }),
    );
    expect(statuses(db, goalId)).toEqual([
      { version: 1, status: 'approved' },
      { version: 2, status: 'proposed' },
    ]);
  });

  it('discarding an amendment rejects N+1 and keeps N current', () => {
    const { db, goalId } = runningGoal();
    const { version } = beginAmendment(db, { goalId, actor: 'user' });
    rejectDefinition(db, { goalId, version, actor: 'user' });
    expect(statuses(db, goalId)).toEqual([
      { version: 1, status: 'approved' },
      { version: 2, status: 'rejected' },
    ]);
    expect(goalRow(db, goalId)).toMatchObject({ status: 'needs_user', current_definition_version: 1 });
    // A new amendment may follow.
    expect(beginAmendment(db, { goalId, actor: 'user' }).version).toBe(3);
  });

  it('reopens a ready Goal for revision and returns it to ready', () => {
    const { db, goalId } = setup();
    approveDefinition(db, { goalId, version: 1, actor: 'user' });
    const revision = beginAmendment(db, { goalId, actor: 'user', definition: amended() }).version;
    expect(goalRow(db, goalId)).toMatchObject({
      status: 'draft',
      status_reason_code: 'user_revision',
      current_definition_version: 1,
    });
    rejectDefinition(db, { goalId, version: revision, actor: 'user' });
    expect(goalRow(db, goalId)).toMatchObject({ status: 'ready', current_definition_version: 1 });
    const second = beginAmendment(db, { goalId, actor: 'user', definition: amended() }).version;
    approveDefinition(db, { goalId, version: second, actor: 'user' });
    expect(goalRow(db, goalId)).toMatchObject({ status: 'ready', current_definition_version: 3 });
    expect(statuses(db, goalId)).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'rejected' },
      { version: 3, status: 'approved' },
    ]);
  });

  it('only amends a Goal that has an approved definition and is in an amendable state', () => {
    const { db, goalId } = setup();
    expect(() => beginAmendment(db, { goalId, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'goal_not_amendable' }),
    );
    approveDefinition(db, { goalId, version: 1, actor: 'user' });
    for (const status of ['completed', 'abandoned', 'reviewing']) {
      db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, goalId);
      expect(() => beginAmendment(db, { goalId, actor: 'user' }), status).toThrow(
        expect.objectContaining({ code: 'goal_not_amendable' }),
      );
    }
    expect(() => beginAmendment(db, { goalId: 'ghost', actor: 'user' })).toThrow(GoalDefinitionError);
  });

  it('refuses a proposal whose parent is no longer the current version', () => {
    const { db, goalId } = runningGoal();
    const { version } = beginAmendment(db, { goalId, actor: 'user' });
    db.prepare(
      'UPDATE goal_definition_versions SET parent_version = NULL WHERE goal_id = ? AND version = ?',
    ).run(goalId, version);
    expect(() => approveDefinition(db, { goalId, version, actor: 'user' })).toThrow(
      expect.objectContaining({ code: 'definition_stale' }),
    );
  });
});
