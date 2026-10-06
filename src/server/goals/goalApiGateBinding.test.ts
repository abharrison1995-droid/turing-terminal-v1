import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, goalApp } from './apiKit.js';
import { bindExactGate, decideGoalApproval, requestGoalApproval } from './approvals.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { transitionGoal } from './stateMachine.js';
import { goalAt } from './testKit.js';
import { harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

type Gate =
  'final_acceptance' | 'each_cycle' | 'milestone_complete' | 'pool_route_first_use' | 'finding_decision';

async function running() {
  const h = harness();
  app = goalApp(h.fx.db, h.supervisor);
  await h.start();
  return h;
}
const approve = (h: Harness, gate: Gate, goalId = h.fx.goalId) =>
  requestGoalApproval(h.fx.db, {
    goalId,
    gate,
    risk: 'low',
    reason: 'x',
    requestedBy: 'supervisor',
    detail: {},
  });
const decideAs = (h: Harness, id: string, decision: 'approved' | 'denied', goalId = h.fx.goalId) =>
  decideGoalApproval(h.fx.db, { goalId, approvalId: id, decision, decidedBy: 'user' });
function waitOn(h: Harness, detail?: Record<string, unknown>) {
  transitionGoal(h.fx.db, {
    goalId: h.fx.goalId,
    to: 'needs_user',
    reasonCode: 'gate_pending',
    actor: 'supervisor',
    ...(detail ? { detail } : {}),
  });
}
const nextAction = async (h: Harness) =>
  (await call(app!, 'GET', `/api/goals/${h.fx.goalId}`)).body.goal.nextAction;
const resume = (h: Harness) =>
  call(app!, 'POST', `/api/goals/${h.fx.goalId}/resume`, { reason: 'gate_resolved' });

describe('malformed gate_pending state fails closed', () => {
  it('an unknown approval id never surfaces an unrelated pending approval', async () => {
    const h = await running();
    const unrelated = approve(h, 'finding_decision');
    waitOn(h, { approvalId: 'unknown', gate: 'each_cycle' });
    expect(await nextAction(h)).toEqual({ kind: 'manual_reconciliation' });
    expect(unrelated.status).toBe('pending');
    const refused = await resume(h);
    expect([refused.status, refused.body.code]).toEqual([409, 'gate_not_resolved']);
    expect(h.status().status).toBe('needs_user');
  });

  it('a missing approvalId or gate is manual reconciliation', async () => {
    for (const detail of [undefined, { gate: 'each_cycle' }, { approvalId: 'x' }]) {
      const h = await running();
      approve(h, 'finding_decision');
      waitOn(h, detail);
      expect(await nextAction(h)).toEqual({ kind: 'manual_reconciliation' });
      expect((await resume(h)).body.code).toBe('gate_not_resolved');
      await app!.close();
      cleanupRepoFixtures();
    }
    app = undefined;
  });

  it('a gate mismatch is manual reconciliation and not resolvable, even when approved', async () => {
    const h = await running();
    const a = approve(h, 'final_acceptance');
    decideAs(h, a.id, 'approved');
    waitOn(h, { approvalId: a.id, gate: 'each_cycle' });
    expect(await nextAction(h)).toEqual({ kind: 'manual_reconciliation' });
    const refused = await resume(h);
    expect([refused.status, refused.body.code]).toEqual([409, 'gate_not_resolved']);
    expect(h.status().status).toBe('needs_user');
  });

  it('an approval of another Goal is manual reconciliation and not resolvable', async () => {
    const h = await running();
    const foreignGoal = goalAt(h.fx.db, h.fx.projectId, 'draft');
    const foreign = approve(h, 'each_cycle', foreignGoal);
    decideAs(h, foreign.id, 'approved', foreignGoal);
    waitOn(h, { approvalId: foreign.id, gate: 'each_cycle' });
    expect(await nextAction(h)).toEqual({ kind: 'manual_reconciliation' });
    expect((await resume(h)).body.code).toBe('gate_not_resolved');
    expect(
      bindExactGate(h.fx.db, h.fx.goalId, {
        status: 'needs_user',
        reasonCode: 'gate_pending',
        detail: { approvalId: foreign.id, gate: 'each_cycle' },
      }),
    ).toEqual({ ok: false });
  });
});

describe('valid exact gates keep their accepted behaviour', () => {
  it.each(['final_acceptance', 'each_cycle', 'milestone_complete'] as const)(
    '%s: pending, approved, denied',
    async (gate) => {
      for (const status of ['pending', 'approved', 'denied'] as const) {
        const h = await running();
        const a = approve(h, gate);
        if (status !== 'pending') decideAs(h, a.id, status);
        waitOn(h, { approvalId: a.id, gate });
        expect(await nextAction(h)).toEqual(
          status === 'pending'
            ? { kind: 'review_approval', approvalId: a.id }
            : status === 'approved'
              ? { kind: 'resume' }
              : { kind: 'revise_goal' },
        );
        const resumed = await resume(h);
        expect(resumed.status).toBe(status === 'approved' ? 200 : 409);
        if (status !== 'approved') expect(resumed.body.code).toBe('gate_not_resolved');
        await app!.close();
        cleanupRepoFixtures();
      }
      app = undefined;
    },
  );

  it('a denied pool gate resumes (resolver consideration); a pending one does not', async () => {
    const h = await running();
    const a = approve(h, 'pool_route_first_use');
    waitOn(h, { approvalId: a.id, gate: 'pool_route_first_use' });
    expect(await nextAction(h)).toEqual({ kind: 'review_approval', approvalId: a.id });
    expect((await resume(h)).body.code).toBe('gate_not_resolved');
    decideAs(h, a.id, 'denied');
    expect(await nextAction(h)).toEqual({ kind: 'resume' });
    // Resolved for pool semantics: it passes the factual check (preflight then decides; no route is ready here).
    expect((await resume(h)).body.code).not.toBe('gate_not_resolved');
  });
});
