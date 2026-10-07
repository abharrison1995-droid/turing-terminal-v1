import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { call, goalApp } from './apiKit.js';
import { requestGoalApproval } from './approvals.js';
import { dashboardGoals } from './readModel.js';
import { openFinding } from './remediationKit.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { transitionGoal } from './stateMachine.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

function setup() {
  const h = harness();
  app = goalApp(h.fx.db, h.supervisor);
  return { h, app, goalId: h.fx.goalId, db: h.fx.db };
}
const post = (a: FastifyInstance, goalId: string, action: string, body: unknown = {}) =>
  call(a, 'POST', `/api/goals/${goalId}/${action}`, body);
const decideApproval = (a: FastifyInstance, id: string, decision: string) =>
  call(a, 'POST', `/api/goal-approvals/${id}/decision`, { decision });

async function toRunning(h: Harness) {
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
}
const gate = (h: Harness, gateName: 'each_cycle' | 'final_acceptance' = 'each_cycle') =>
  requestGoalApproval(h.fx.db, {
    goalId: h.fx.goalId,
    gate: gateName,
    risk: 'medium',
    reason: 'Needs a decision',
    requestedBy: 'system',
  });
const count = (h: Harness, sql: string) => (h.fx.db.prepare(sql).get() as { n: number }).n;
const snapshot = (h: Harness) => ({
  goal: h.fx.db.prepare('SELECT status, status_reason_code FROM goals').all(),
  runs: h.fx.db.prepare('SELECT id, status FROM runs ORDER BY id').all(),
  cycles: h.fx.db.prepare('SELECT id, status, outcome_json FROM goal_cycles ORDER BY id').all(),
  approvals: h.fx.db
    .prepare('SELECT id, status, decided_by, decision_note FROM goal_approvals ORDER BY id')
    .all(),
  ops: h.fx.db.prepare('SELECT id, status FROM goal_integration_ops ORDER BY id').all(),
  events: count(h, 'SELECT COUNT(*) AS n FROM goal_events'),
});

describe('abandonment re-proves quiescence server-side', () => {
  it('refuses Abandon after Pause while a Goal-linked child run is still active, changing nothing', async () => {
    const { h, app, goalId } = setup();
    await toRunning(h);
    const run = h.runs().at(-1)!;
    expect(run.status).toBe('running');
    gate(h);
    expect((await post(app, goalId, 'pause')).status).toBe(200);
    const before = snapshot(h);

    const refused = await post(app, goalId, 'abandon');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('goal_work_in_flight');
    expect(snapshot(h)).toEqual(before);
    expect(h.status().status).toBe('paused');
    expect(h.runs().at(-1)!.status).toBe('running');
    expect(count(h, "SELECT COUNT(*) AS n FROM goal_approvals WHERE status = 'pending'")).toBe(1);

    // Once the work has settled the same request succeeds.
    h.setRunStatus(run.id, 'completed');
    expect((await post(app, goalId, 'abandon')).status).toBe(200);
  });

  it.each(['queued', 'running', 'paused'])('treats a %s Goal run as work in flight', async (status) => {
    const { h, app, goalId } = setup();
    await toRunning(h);
    h.setRunStatus(h.runs().at(-1)!.id, status);
    await post(app, goalId, 'pause');
    expect((await post(app, goalId, 'abandon')).body.code).toBe('goal_work_in_flight');
  });

  it('refuses while a Goal integration operation is still planned, and nothing is altered or cleaned up', async () => {
    const { h, app, goalId, db } = setup();
    await toRunning(h);
    const run = h.runs().at(-1)!;
    h.setRunStatus(run.id, 'completed');
    await post(app, goalId, 'pause');
    gate(h);
    const opId = randomUUID();
    db.prepare(
      `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, op, expected_old, new_commit, status, checks_json, created_at)
       VALUES (?, ?, ?, 'advance', ?, ?, 'planned', '{}', ?)`,
    ).run(opId, goalId, h.cycle()!.id, h.fx.head(), h.fx.head(), new Date().toISOString());
    const before = snapshot(h);

    const refused = await post(app, goalId, 'abandon');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('goal_work_in_flight');
    expect(snapshot(h)).toEqual(before);
    expect(db.prepare('SELECT status FROM goal_integration_ops WHERE id = ?').get(opId)).toEqual({
      status: 'planned',
    });

    db.prepare("UPDATE goal_integration_ops SET status = 'aborted' WHERE id = ?").run(opId);
    expect((await post(app, goalId, 'abandon')).status).toBe(200);
  });

  it('on success settles the active cycle, system-denies only pending approvals and keeps all history', async () => {
    const { h, app, goalId, db } = setup();
    await toRunning(h);
    h.setRunStatus(h.runs().at(-1)!.id, 'completed');
    await post(app, goalId, 'pause');
    const pendingA = gate(h);
    const pendingB = gate(h, 'final_acceptance');
    const userApproved = gate(h);
    const userDenied = gate(h);
    expect((await decideApproval(app, userApproved.id, 'approved')).status).toBe(200);
    expect((await decideApproval(app, userDenied.id, 'denied')).status).toBe(200);
    const decidedBefore = db
      .prepare(
        'SELECT id, status, decided_by, decision_note, responded_at FROM goal_approvals WHERE id IN (?, ?)',
      )
      .all(userApproved.id, userDenied.id);
    const cycleBefore = h.cycle()!;
    expect(cycleBefore.status).not.toBe('cancelled');
    const cyclesTotal = count(h, 'SELECT COUNT(*) AS n FROM goal_cycles');
    const runsTotal = count(h, 'SELECT COUNT(*) AS n FROM runs');
    const decidedEvents = count(h, "SELECT COUNT(*) AS n FROM goal_events WHERE type = 'approval_decided'");

    const abandoned = await post(app, goalId, 'abandon');
    expect(abandoned.body).toEqual({ status: 'abandoned' });
    expect(h.status()).toEqual({ status: 'abandoned', reason: 'user_abandoned' });

    for (const id of [pendingA.id, pendingB.id])
      expect(
        db
          .prepare('SELECT status, decided_by, decision_note, responded_at FROM goal_approvals WHERE id = ?')
          .get(id),
      ).toMatchObject({
        status: 'denied',
        decided_by: 'system',
        decision_note: 'Goal abandoned by user; pending gate is no longer actionable.',
      });
    expect(
      db
        .prepare(
          'SELECT id, status, decided_by, decision_note, responded_at FROM goal_approvals WHERE id IN (?, ?)',
        )
        .all(userApproved.id, userDenied.id),
    ).toEqual(decidedBefore);
    expect(
      count(
        h,
        "SELECT COUNT(*) AS n FROM goal_approvals WHERE status = 'approved' AND decided_by = 'system'",
      ),
    ).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM goal_approvals WHERE status = 'pending'")).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM goal_events WHERE type = 'approval_decided'")).toBe(
      decidedEvents + 2,
    );

    expect(
      count(
        h,
        "SELECT COUNT(*) AS n FROM goal_cycles WHERE status NOT IN ('succeeded','failed','cancelled','rejected')",
      ),
    ).toBe(0);
    expect(
      db
        .prepare('SELECT status, outcome_json, finished_at FROM goal_cycles WHERE id = ?')
        .get(cycleBefore.id),
    ).toMatchObject({ status: 'cancelled' });
    expect(
      JSON.parse(
        (
          db.prepare('SELECT outcome_json AS o FROM goal_cycles WHERE id = ?').get(cycleBefore.id) as {
            o: string;
          }
        ).o,
      ),
    ).toMatchObject({ code: 'goal_abandoned', abandonedBy: 'user' });
    expect(count(h, 'SELECT COUNT(*) AS n FROM goal_cycles')).toBe(cyclesTotal);
    expect(count(h, 'SELECT COUNT(*) AS n FROM runs')).toBe(runsTotal);
    expect(count(h, "SELECT COUNT(*) AS n FROM goal_integration_ops WHERE status = 'planned'")).toBe(0);
  });

  it('is atomic: a failure on the final transition rolls back the cycle and approval settlement', async () => {
    const { h, app, goalId, db } = setup();
    await toRunning(h);
    h.setRunStatus(h.runs().at(-1)!.id, 'completed');
    await post(app, goalId, 'pause');
    gate(h);
    const before = snapshot(h);
    db.exec(`CREATE TRIGGER inject_failure BEFORE UPDATE OF status ON goals WHEN NEW.status = 'abandoned'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const failed = await post(app, goalId, 'abandon');
    expect(failed.status).toBe(500);
    expect(snapshot(h)).toEqual(before);
    expect(h.cycle()!.status).not.toBe('cancelled');
    db.exec('DROP TRIGGER inject_failure');
    expect((await post(app, goalId, 'abandon')).status).toBe(200);
  });
});

describe('a terminal Goal has no actionable gate', () => {
  /** A pre-remediation database: a terminal Goal that still owns a pending approval. */
  function legacy(h: Harness, status: 'abandoned' | 'completed') {
    const approval = gate(h);
    h.fx.db.exec('DROP TRIGGER IF EXISTS never');
    if (status === 'abandoned') {
      h.fx.db
        .prepare("UPDATE goals SET status = 'abandoned', status_reason_code = 'user_abandoned' WHERE id = ?")
        .run(h.fx.goalId);
    } else {
      h.fx.db
        .prepare("UPDATE goals SET status = 'completed', status_reason_code = NULL WHERE id = ?")
        .run(h.fx.goalId);
    }
    return approval;
  }

  it.each(['abandoned', 'completed'] as const)(
    'refuses a user decision on a pending approval of a %s Goal and leaves it untouched',
    async (status) => {
      const { h, app } = setup();
      const approval = legacy(h, status);
      const before = snapshot(h);
      for (const decision of ['approved', 'denied']) {
        const refused = await decideApproval(app, approval.id, decision);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('goal_terminal');
      }
      expect(snapshot(h)).toEqual(before);
    },
  );

  it.each(['abandoned', 'completed'] as const)(
    'does not present a pending approval of a %s Goal as live work, but keeps it as history',
    async (status) => {
      const { h, app } = setup();
      const approval = legacy(h, status);
      const list = await call(app, 'GET', '/api/goals');
      const item = list.body.goals.find((goal: { id: string }) => goal.id === h.fx.goalId);
      expect(item).toMatchObject({ pendingApprovalCount: 0, needsUser: false, attention: [] });
      const detail = await call(app, 'GET', `/api/goals/${h.fx.goalId}`);
      expect(detail.body.goal.pendingApprovals).toEqual([]);
      expect(detail.body.goal.flags.userNeeded).toBe(false);
      expect((await call(app, 'GET', '/api/approvals/unified?status=pending')).body.approvals).toEqual([]);
      expect(
        (await call(app, 'GET', `/api/approvals/unified?status=pending&goalId=${h.fx.goalId}`)).body
          .approvals,
      ).toEqual([]);
      const dashboard = dashboardGoals(h.fx.db);
      expect(dashboard.goalApprovals).toEqual({ pending: 0, approvals: [] });
      expect(dashboard.goals.needsUser).toBe(0);
      // History is still queryable, and is not offered for decision.
      const all = (await call(app, 'GET', '/api/approvals/unified?status=all')).body.approvals;
      expect(all.find((row: { id: string }) => row.id === approval.id)).toMatchObject({
        status: 'pending',
        decidable: false,
      });
      expect(count(h, "SELECT COUNT(*) AS n FROM goal_approvals WHERE status = 'pending'")).toBe(1);
    },
  );

  it('refuses a finding decision on a terminal Goal and leaves no generated approval behind', async () => {
    const { h, app, goalId } = setup();
    const findingId = await openFinding(h.fx, 'high');
    await h.start();
    await post(app, goalId, 'pause');
    expect((await post(app, goalId, 'abandon')).status).toBe(200);
    const before = snapshot(h);
    const refused = await call(app, 'POST', `/api/goals/${goalId}/findings/${findingId}/decision`, {
      decision: 'accepted_by_user',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('goal_terminal');
    expect(snapshot(h)).toEqual(before);
    expect(count(h, "SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'finding_decision'")).toBe(0);
    expect(h.fx.db.prepare('SELECT status FROM goal_findings WHERE id = ?').get(findingId)).toEqual({
      status: 'open',
    });
  });
});

describe('manual reconciliation fails closed at the server boundary', () => {
  async function corruptGate(h: Harness) {
    await h.start();
    const approval = gate(h);
    transitionGoal(h.fx.db, {
      goalId: h.fx.goalId,
      to: 'needs_user',
      reasonCode: 'gate_pending',
      actor: 'supervisor',
      detail: { approvalId: 'no-such-approval', gate: 'each_cycle' },
    });
    return approval;
  }

  it('refuses to decide any approval or finding, guesses no other approval, and repairs nothing', async () => {
    const { h, app, goalId } = setup();
    const findingId = await openFinding(h.fx, 'high');
    const approval = await corruptGate(h);
    const before = snapshot(h);
    const detail = await call(app, 'GET', `/api/goals/${goalId}`);
    expect(detail.body.goal.nextAction).toEqual({ kind: 'manual_reconciliation' });

    for (const decision of ['approved', 'denied']) {
      const refused = await decideApproval(app, approval.id, decision);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('manual_reconciliation_required');
    }
    const finding = await call(app, 'POST', `/api/goals/${goalId}/findings/${findingId}/decision`, {
      decision: 'dismissed_by_user',
    });
    expect(finding.status).toBe(409);
    expect(finding.body.code).toBe('manual_reconciliation_required');
    expect(snapshot(h)).toEqual(before);
    expect(count(h, "SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'finding_decision'")).toBe(0);

    // The global inbox still shows the row (it is audit information) but not as decidable.
    const unified = (await call(app, 'GET', '/api/approvals/unified?status=pending')).body.approvals;
    expect(unified).toHaveLength(1);
    expect(unified[0]).toMatchObject({ id: approval.id, decidable: false });
    expect(dashboardGoals(h.fx.db).goalApprovals.approvals[0]).toMatchObject({ decidable: false });
  });

  it('an exactly bound gate remains decidable, and deciding it does not resume the Goal', async () => {
    const { h, app, goalId } = setup();
    await h.start();
    const approval = gate(h);
    transitionGoal(h.fx.db, {
      goalId,
      to: 'needs_user',
      reasonCode: 'gate_pending',
      actor: 'supervisor',
      detail: { approvalId: approval.id, gate: 'each_cycle' },
    });
    const unified = (await call(app, 'GET', '/api/approvals/unified?status=pending')).body.approvals;
    expect(unified[0]).toMatchObject({ id: approval.id, decidable: true });
    const decided = await decideApproval(app, approval.id, 'approved');
    expect(decided.status).toBe(200);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
  });
});
