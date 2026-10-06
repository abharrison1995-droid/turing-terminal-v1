import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';
import { call, goalApp } from './apiKit.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { beginAmendment } from './definitions.js';
import { verifyAmendmentResolution } from './amendmentAuthority.js';
import { runPreflight } from './preflight.js';
import { cleanupRepoFixtures, milestone, passDeterministic, simpleDefinition } from './repoKit.js';
import { transitionGoal } from './stateMachine.js';
import { goalAt } from './testKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

const post = (goalId: string, path: string, body: unknown = {}) =>
  call(app!, 'POST', `/api/goals/${goalId}/${path}`, body);
const detail = async (goalId: string) => (await call(app!, 'GET', `/api/goals/${goalId}`)).body.goal;
const decide = (id: string, decision: 'approved' | 'denied') =>
  call(app!, 'POST', `/api/goal-approvals/${id}/decision`, { decision });
const rows = (h: Harness, sql: string) => h.fx.db.prepare(sql).all() as Array<Record<string, unknown>>;
const versions = (h: Harness) =>
  rows(
    h,
    `SELECT version, status FROM goal_definition_versions WHERE goal_id = '${h.fx.goalId}' ORDER BY version`,
  );

function acceptanceHarness() {
  const h = harness({
    definition: simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'])],
      gates: { finalAcceptance: true },
    }),
  });
  app = goalApp(h.fx.db, h.supervisor);
  return h;
}
async function toGate(h: Harness, until: () => boolean) {
  await h.start();
  for (let i = 0; i < 10 && !until(); i += 1) await h.tick();
  expect(until()).toBe(true);
}
const gatePending = (h: Harness) => h.status().reason === 'gate_pending';
const exactApproval = (h: Harness) =>
  JSON.parse(rows(h, 'SELECT status_detail_json AS d FROM goals')[0]!.d as string).approvalId as string;

/** A definition edit that stays valid under the registered workflows. */
async function changedDefinition(h: Harness) {
  const read = await call(app!, 'GET', `/api/goals/${h.fx.goalId}/definitions/1`);
  const definition = structuredClone(read.body.definition.definition);
  definition.routing.workflows = {
    planning: GOAL_WORKFLOW_IDS.planning,
    execution: GOAL_WORKFLOW_IDS.execution,
    review: GOAL_WORKFLOW_IDS.review,
    verification: GOAL_WORKFLOW_IDS.verification,
  };
  definition.limits.maxExecutionCycles += 3;
  return definition;
}

describe('denied final acceptance can be revised', () => {
  it('denial -> revise_goal -> amendment in the same needs_user quiescence -> approve -> resume -> new request later', async () => {
    const h = acceptanceHarness();
    await passDeterministic(h.fx);
    await toGate(h, () => gatePending(h));
    const denied = exactApproval(h);
    await decide(denied, 'denied');
    expect((await detail(h.fx.goalId)).nextAction).toEqual({ kind: 'revise_goal' });

    const begun = await post(h.fx.goalId, 'definitions', {
      changeSummary: 'revise',
      definition: await changedDefinition(h),
    });
    expect(begun.status).toBe(201);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
    expect(versions(h).map((v) => v.status)).toEqual(['approved', 'proposed']);
    expect(rows(h, "SELECT id FROM goal_approvals WHERE gate = 'final_acceptance'")).toHaveLength(1);

    // The new episode is recognised by the amendment authority.
    expect(verifyAmendmentResolution(h.fx.db, h.fx.goalId, 'amendment_approved').ok).toBe(false);
    expect((await post(h.fx.goalId, 'definitions/2/approve')).status).toBe(200);
    expect(versions(h).map((v) => v.status)).toEqual(['superseded', 'approved']);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
    expect(verifyAmendmentResolution(h.fx.db, h.fx.goalId, 'amendment_approved')).toEqual({ ok: true });
    expect(verifyAmendmentResolution(h.fx.db, h.fx.goalId, 'amendment_discarded').ok).toBe(false);

    // The historical denied approval is not a pending mandatory gate.
    expect(rows(h, `SELECT status FROM goal_approvals WHERE id = '${denied}'`)).toEqual([
      { status: 'denied' },
    ]);
    const preflight = await runPreflight(h.fx.db, h.fx.goalId, {
      executor: h.executor,
      now: new Date().toISOString(),
    });
    expect(preflight.ok === true || preflight.code !== 'gate_pending').toBe(true);
    const resumed = await post(h.fx.goalId, 'resume', { reason: 'amendment_approved' });
    expect(resumed.body).toEqual({ ok: true, goalStatus: 'running' });
    expect(h.status().status).toBe('running');
  });

  it('a discarded revision resumes under the previous definition and may later ask for acceptance again', async () => {
    const h = acceptanceHarness();
    await passDeterministic(h.fx);
    await toGate(h, () => gatePending(h));
    const denied = exactApproval(h);
    await decide(denied, 'denied');
    expect((await post(h.fx.goalId, 'definitions')).status).toBe(201);
    expect((await post(h.fx.goalId, 'definitions/2/reject')).status).toBe(200);
    expect(verifyAmendmentResolution(h.fx.db, h.fx.goalId, 'amendment_discarded')).toEqual({ ok: true });
    expect((await post(h.fx.goalId, 'resume', { reason: 'amendment_discarded' })).status).toBe(200);
    expect(h.status().status).toBe('running');
    expect(await h.tick()).toBe('gate_requested');
    const all = rows(
      h,
      "SELECT id, status FROM goal_approvals WHERE gate = 'final_acceptance' ORDER BY rowid",
    );
    expect(all.map((a) => a.status)).toEqual(['denied', 'pending']);
    expect(all[0]!.id).toBe(denied);
  });
});

describe('gate-specific eligibility', () => {
  it('denied each_cycle: wait_for_turing and 409 until the supervisor settles the cycle, then revision works', async () => {
    const h = harness({ definition: simpleDefinition({ gates: { eachCycle: true } }) });
    app = goalApp(h.fx.db, h.supervisor);
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await toGate(h, () => gatePending(h));
    await decide(exactApproval(h), 'denied');
    const view = await detail(h.fx.goalId);
    expect(view.flags.cycleActive).toBe(true);
    expect(view.nextAction).toEqual({ kind: 'wait_for_turing' });

    const cycleBefore = rows(h, 'SELECT id, status FROM goal_cycles');
    const refused = await post(h.fx.goalId, 'definitions');
    expect([refused.status, refused.body.code]).toEqual([409, 'gate_denial_not_settled']);
    expect(versions(h)).toHaveLength(1);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    expect(rows(h, 'SELECT id, status FROM goal_cycles')).toEqual(cycleBefore);

    expect(await h.tick()).toBe('gate_denied');
    expect(rows(h, 'SELECT status FROM goal_cycles')[0]).toMatchObject({ status: 'cancelled' });
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    expect((await detail(h.fx.goalId)).nextAction).toEqual({ kind: 'revise_goal' });
    expect((await post(h.fx.goalId, 'definitions')).status).toBe(201);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
  });

  it('denied milestone_complete with no active cycle is revisable', async () => {
    const h = harness({
      definition: simpleDefinition({
        milestones: [milestone('m1', ['build', 'tests'])],
        gates: { beforeMilestoneComplete: true },
      }),
    });
    app = goalApp(h.fx.db, h.supervisor);
    await passDeterministic(h.fx);
    await toGate(h, () => gatePending(h));
    expect(
      rows(h, 'SELECT gate FROM goal_approvals WHERE id = ?'.replace('?', `'${exactApproval(h)}'`)),
    ).toEqual([{ gate: 'milestone_complete' }]);
    await decide(exactApproval(h), 'denied');
    await h.tick();
    expect((await detail(h.fx.goalId)).nextAction).toEqual({ kind: 'revise_goal' });
    expect((await post(h.fx.goalId, 'definitions')).status).toBe(201);
    expect(h.status().reason).toBe('amendment_in_progress');
  });

  it('a denied pool gate is a resume, never a revision', async () => {
    const h = harness();
    app = goalApp(h.fx.db, h.supervisor);
    await h.start();
    const approval = requestGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      gate: 'pool_route_first_use',
      risk: 'low',
      reason: 'x',
      requestedBy: 'supervisor',
      detail: {},
    });
    transitionGoal(h.fx.db, {
      goalId: h.fx.goalId,
      to: 'needs_user',
      reasonCode: 'gate_pending',
      actor: 'supervisor',
      detail: { approvalId: approval.id, gate: 'pool_route_first_use' },
    });
    decideGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      approvalId: approval.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    expect((await detail(h.fx.goalId)).nextAction).toEqual({ kind: 'resume' });
    const refused = await post(h.fx.goalId, 'definitions');
    expect([refused.status, refused.body.code]).toEqual([409, 'goal_not_amendable']);
    expect(versions(h)).toHaveLength(1);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
  });

  it.each(['pending', 'approved'] as const)('a %s gate cannot be revised', async (status) => {
    for (const gate of ['final_acceptance', 'each_cycle', 'milestone_complete'] as const) {
      const h = harness();
      app = goalApp(h.fx.db, h.supervisor);
      await h.start();
      const approval = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate,
        risk: 'low',
        reason: 'x',
        requestedBy: 'supervisor',
        detail: {},
      });
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'needs_user',
        reasonCode: 'gate_pending',
        actor: 'supervisor',
        detail: { approvalId: approval.id, gate },
      });
      if (status === 'approved')
        decideGoalApproval(h.fx.db, {
          goalId: h.fx.goalId,
          approvalId: approval.id,
          decision: 'approved',
          decidedBy: 'user',
        });
      expect((await detail(h.fx.goalId)).nextAction).toEqual(
        status === 'pending' ? { kind: 'review_approval', approvalId: approval.id } : { kind: 'resume' },
      );
      const refused = await post(h.fx.goalId, 'definitions');
      expect([refused.status, refused.body.code]).toEqual([409, 'goal_not_amendable']);
      expect(versions(h)).toHaveLength(1);
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
      await app.close();
      cleanupRepoFixtures();
    }
    app = undefined;
  });

  it('fails closed on missing, unknown, foreign or mismatched status detail', async () => {
    const h = harness();
    app = goalApp(h.fx.db, h.supervisor);
    await h.start();
    const real = requestGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      gate: 'final_acceptance',
      risk: 'low',
      reason: 'x',
      requestedBy: 'supervisor',
      detail: {},
    });
    decideGoalApproval(h.fx.db, {
      goalId: h.fx.goalId,
      approvalId: real.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    const details: Array<Record<string, unknown> | undefined> = [
      undefined,
      { gate: 'final_acceptance' },
      { approvalId: 'nope', gate: 'final_acceptance' },
      { approvalId: real.id, gate: 'each_cycle' },
      { approvalId: real.id },
    ];
    // A denied approval that belongs to another Goal of the same project.
    const foreignGoal = goalAt(h.fx.db, h.fx.projectId, 'draft');
    const foreign = requestGoalApproval(h.fx.db, {
      goalId: foreignGoal,
      gate: 'final_acceptance',
      risk: 'low',
      reason: 'x',
      requestedBy: 'supervisor',
      detail: {},
    });
    decideGoalApproval(h.fx.db, {
      goalId: foreignGoal,
      approvalId: foreign.id,
      decision: 'denied',
      decidedBy: 'user',
    });
    details.push({ approvalId: foreign.id, gate: 'final_acceptance' });
    for (const [index, detailValue] of details.entries()) {
      if (index > 0)
        h.fx.db
          .prepare("UPDATE goals SET status = 'running', status_reason_code = 'user_start' WHERE id = ?")
          .run(h.fx.goalId);
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'needs_user',
        reasonCode: 'gate_pending',
        actor: 'supervisor',
        ...(detailValue ? { detail: detailValue } : {}),
      });
      const refused = await post(h.fx.goalId, 'definitions');
      expect([refused.status, refused.body.code]).toEqual([409, 'goal_not_amendable']);
      expect(versions(h)).toHaveLength(1);
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    }
  });
});

describe('denied-gate revision is atomic', () => {
  it('a failure creating the proposal rolls back the needs_user self-transition', async () => {
    const h = acceptanceHarness();
    await passDeterministic(h.fx);
    await toGate(h, () => gatePending(h));
    await decide(exactApproval(h), 'denied');
    const events = rows(h, 'SELECT COUNT(*) AS n FROM goal_events');
    h.fx.db.exec(
      "CREATE TRIGGER inject BEFORE INSERT ON goal_definition_versions BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => beginAmendment(h.fx.db, { goalId: h.fx.goalId, actor: 'user' })).toThrow(/injected/);
    h.fx.db.exec('DROP TRIGGER inject');
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
    expect(rows(h, 'SELECT COUNT(*) AS n FROM goal_events')).toEqual(events);
    expect(versions(h)).toHaveLength(1);
  });
});
