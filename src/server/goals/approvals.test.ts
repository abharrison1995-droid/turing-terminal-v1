import { afterEach, describe, expect, it } from 'vitest';
import {
  bindExactGate,
  GoalApprovalError,
  decideGoalApproval,
  getGoalApproval,
  pendingGoalApprovals,
  requestGoalApproval,
} from './approvals.js';
import { listGoalEvents } from './events.js';
import { copyGoalApprovalRow, testDigest } from './repoKit.js';
import { cleanupTestDatabases, freshDatabase, goalAt, seedProject } from './testKit.js';

afterEach(cleanupTestDatabases);

function setup() {
  const db = freshDatabase();
  const project = seedProject(db);
  const goalId = goalAt(db, project, 'running');
  const other = goalAt(db, seedProject(db), 'running');
  return { db, goalId, other };
}
const request = (db: ReturnType<typeof setup>['db'], goalId: string) =>
  requestGoalApproval(db, {
    goalId,
    gate: 'final_acceptance',
    risk: 'high',
    reason: 'Accept the result',
    requestedBy: 'supervisor',
    detail: { tree: 'abc' },
  });

describe('Goal approvals', () => {
  it('records a pending approval with all first-class fields and an event', () => {
    const { db, goalId } = setup();
    const approval = request(db, goalId);
    expect(approval).toMatchObject({
      goalId,
      gate: 'final_acceptance',
      risk: 'high',
      reason: 'Accept the result',
      requestedBy: 'supervisor',
      detail: { tree: 'abc' },
      status: 'pending',
      decidedBy: null,
      decisionNote: null,
      respondedAt: null,
    });
    expect(pendingGoalApprovals(db, goalId)).toHaveLength(1);
    expect(listGoalEvents(db, goalId).at(-1)).toMatchObject({
      type: 'approval_requested',
      payload: { approvalId: approval.id, gate: 'final_acceptance', risk: 'high' },
    });
  });

  it('is separate from run approvals', () => {
    const { db, goalId } = setup();
    const before = db.prepare('SELECT COUNT(*) AS n FROM approvals').get();
    request(db, goalId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual(before);
  });

  it('records an explicit user approval once', () => {
    const { db, goalId } = setup();
    const { id } = request(db, goalId);
    const result = decideGoalApproval(db, {
      goalId,
      approvalId: id,
      decision: 'approved',
      decidedBy: 'user',
      note: 'looks good',
    });
    expect(result.changed).toBe(true);
    expect(result.approval).toMatchObject({
      status: 'approved',
      decidedBy: 'user',
      decisionNote: 'looks good',
    });
    expect(result.approval.respondedAt).not.toBeNull();
    expect(listGoalEvents(db, goalId).at(-1)).toMatchObject({
      type: 'approval_decided',
      payload: { approvalId: id, gate: 'final_acceptance', status: 'approved', decidedBy: 'user' },
    });
    expect(pendingGoalApprovals(db, goalId)).toHaveLength(0);
  });

  it('is idempotent for the same decision and refuses a conflicting second decision', () => {
    const { db, goalId } = setup();
    const { id } = request(db, goalId);
    const first = decideGoalApproval(db, { goalId, approvalId: id, decision: 'denied', decidedBy: 'user' });
    const events = listGoalEvents(db, goalId).length;
    const again = decideGoalApproval(db, {
      goalId,
      approvalId: id,
      decision: 'denied',
      decidedBy: 'user',
      note: 'later',
    });
    expect(again.changed).toBe(false);
    expect(again.approval).toEqual(first.approval);
    expect(listGoalEvents(db, goalId)).toHaveLength(events);
    expect(() =>
      decideGoalApproval(db, { goalId, approvalId: id, decision: 'approved', decidedBy: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'already_decided' }));
    expect(getGoalApproval(db, id)!.status).toBe('denied');
  });

  it('has no automatic or model approval path', () => {
    const { db, goalId } = setup();
    const { id } = request(db, goalId);
    expect(() =>
      decideGoalApproval(db, { goalId, approvalId: id, decision: 'approved', decidedBy: 'system' }),
    ).toThrow(expect.objectContaining({ code: 'user_decision_required' }));
    expect(() =>
      decideGoalApproval(db, { goalId, approvalId: id, decision: 'approved', decidedBy: 'model' as never }),
    ).toThrow();
    expect(getGoalApproval(db, id)!.status).toBe('pending');
    // The system may deny, for example when a restart interrupts a gate.
    expect(
      decideGoalApproval(db, { goalId, approvalId: id, decision: 'denied', decidedBy: 'system' }).approval,
    ).toMatchObject({
      status: 'denied',
      decidedBy: 'system',
    });
  });

  it('refuses an approval that belongs to another Goal or does not exist', () => {
    const { db, goalId, other } = setup();
    const { id } = request(db, goalId);
    expect(() =>
      decideGoalApproval(db, { goalId: other, approvalId: id, decision: 'approved', decidedBy: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'approval_not_found' }));
    expect(() =>
      decideGoalApproval(db, { goalId, approvalId: 'ghost', decision: 'approved', decidedBy: 'user' }),
    ).toThrow(GoalApprovalError);
    expect(getGoalApproval(db, id)!.status).toBe('pending');
  });

  it('validates the gate and the Goal on request', () => {
    const { db, goalId } = setup();
    expect(() =>
      requestGoalApproval(db, {
        goalId,
        gate: 'teleport' as never,
        risk: 'low',
        reason: 'r',
        requestedBy: 'user',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_gate' }));
    expect(() =>
      requestGoalApproval(db, {
        goalId: 'ghost',
        gate: 'start',
        risk: 'low',
        reason: 'r',
        requestedBy: 'user',
      }),
    ).toThrow(expect.objectContaining({ code: 'goal_not_found' }));
  });

  it('rolls back the decision when its event cannot be written', () => {
    const { db, goalId } = setup();
    const { id } = request(db, goalId);
    db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON goal_events WHEN NEW.type = 'approval_decided'
             BEGIN SELECT RAISE(ABORT, 'event write failed'); END`);
    expect(() =>
      decideGoalApproval(db, { goalId, approvalId: id, decision: 'approved', decidedBy: 'user' }),
    ).toThrow(/event write failed/);
    expect(getGoalApproval(db, id)!.status).toBe('pending');
  });
});

describe('bindExactGate: a completion decision is never a gate (paired)', () => {
  it('binds the plain control gate, and refuses a copy of it that carries only a completion digest', () => {
    const { db, goalId } = setup();
    const control = requestGoalApproval(db, {
      goalId,
      gate: 'user_confirmation',
      risk: 'high',
      reason: 'Ordinary user confirmation gate.',
      requestedBy: 'user',
      detail: { note: 'control' },
    });
    const gateNamingControl = {
      status: 'needs_user',
      reasonCode: 'gate_pending',
      detail: { approvalId: control.id, gate: 'user_confirmation' },
    };
    expect(bindExactGate(db, goalId, gateNamingControl)).toMatchObject({
      ok: true,
      approval: { id: control.id },
    });

    db.exec('DROP TRIGGER trg_goal_approval_external_completion_action_guard;');
    const completionCopy = copyGoalApprovalRow(db, control.id, {
      externalCompletion: testDigest('bind-completion-copy'),
      attestationCorrection: null,
    });
    expect(getGoalApproval(db, completionCopy)).toMatchObject({
      gate: 'user_confirmation',
      detail: { note: 'control' },
      externalCompletionActionDigest: testDigest('bind-completion-copy'),
    });
    expect(
      bindExactGate(db, goalId, {
        status: 'needs_user',
        reasonCode: 'gate_pending',
        detail: { approvalId: completionCopy, gate: 'user_confirmation' },
      }),
    ).toEqual({ ok: false });
  });
});
