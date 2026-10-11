import { afterEach, describe, expect, it } from 'vitest';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import {
  cleanupRepoFixtures,
  milestone,
  passDeterministic,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { goalAt } from './testKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

afterEach(() => cleanupRepoFixtures());

type Gate = 'final_acceptance' | 'each_cycle' | 'milestone_complete' | 'pool_route_first_use';
const detailOf = (h: Harness) =>
  JSON.parse(
    (
      h.fx.db.prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?').get(h.fx.goalId) as {
        d: string;
      }
    ).d,
  ) as { approvalId: string; gate: string };
const setDetail = (h: Harness, raw: string | null) =>
  h.fx.db.prepare('UPDATE goals SET status_detail_json = ? WHERE id = ?').run(raw, h.fx.goalId);
const decide = (h: Harness, id: string, decision: 'approved' | 'denied', goalId = h.fx.goalId) =>
  decideGoalApproval(h.fx.db, { goalId, approvalId: id, decision, decidedBy: 'user' });
const request = (h: Harness, gate: Gate, goalId = h.fx.goalId) =>
  requestGoalApproval(h.fx.db, {
    goalId,
    gate,
    risk: 'low',
    reason: 'x',
    requestedBy: 'supervisor',
    detail: {},
  });
const cycles = (h: Harness) => h.fx.db.prepare('SELECT id, status FROM goal_cycles ORDER BY sequence').all();
const approvalRows = (h: Harness) => h.fx.db.prepare('SELECT * FROM goal_approvals ORDER BY rowid').all();

/** A Goal with a real active cycle waiting on its real each_cycle gate. */
async function eachCycleGate() {
  const h = harness({ definition: simpleDefinition({ gates: { eachCycle: true } }) });
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('gate_requested');
  expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
  return h;
}
async function acceptanceGate() {
  const h = harness({
    definition: simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'])],
      gates: { finalAcceptance: true },
    }),
  });
  await passDeterministic(h.fx);
  await h.start();
  for (let i = 0; i < 10 && h.status().reason !== 'gate_pending'; i += 1) await h.tick();
  expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
  return h;
}

/** Ticks a corrupt gate and proves nothing changed anywhere. */
async function expectInert(h: Harness) {
  const before = {
    cycles: cycles(h),
    approvals: approvalRows(h),
    status: h.status(),
    detail: h.fx.db.prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?').all(h.fx.goalId),
    events: h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_events').get(),
    work: [h.workStarts(), h.proposalStarts(), h.model.calls],
  };
  const result = await h.supervisor.tickGoal(h.fx.goalId);
  expect(result).toMatchObject({ action: 'idle', code: 'gate_binding_invalid' });
  expect({
    cycles: cycles(h),
    approvals: approvalRows(h),
    status: h.status(),
    detail: h.fx.db.prepare('SELECT status_detail_json AS d FROM goals WHERE id = ?').all(h.fx.goalId),
    events: h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_events').get(),
    work: [h.workStarts(), h.proposalStarts(), h.model.calls],
  }).toEqual(before);
  expect(h.cycle()!.status).not.toBe('cancelled');
}

describe('tickNeedsUser acts only on an exactly bound gate', () => {
  it(
    'a foreign denied approval cannot cancel this Goal’s active cycle',
    async () => {
      const h = await eachCycleGate();
      const foreignGoal = goalAt(h.fx.db, h.fx.projectId, 'draft');
      const foreign = request(h, 'each_cycle', foreignGoal);
      decide(h, foreign.id, 'denied', foreignGoal);
      setDetail(h, JSON.stringify({ approvalId: foreign.id, gate: 'each_cycle' }));
      await expectInert(h);
      expect(h.fx.db.prepare('SELECT status FROM goal_approvals WHERE id = ?').get(foreign.id)).toEqual({
        status: 'denied',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a gate-mismatched denied approval cannot cancel the cycle',
    async () => {
      const h = await eachCycleGate();
      const wrong = request(h, 'final_acceptance');
      decide(h, wrong.id, 'denied');
      setDetail(h, JSON.stringify({ approvalId: wrong.id, gate: 'each_cycle' }));
      await expectInert(h);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a foreign approved approval cannot resume the Goal',
    async () => {
      const h = await eachCycleGate();
      const foreignGoal = goalAt(h.fx.db, h.fx.projectId, 'draft');
      const foreign = request(h, 'each_cycle', foreignGoal);
      decide(h, foreign.id, 'approved', foreignGoal);
      setDetail(h, JSON.stringify({ approvalId: foreign.id, gate: 'each_cycle' }));
      await expectInert(h);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a mismatched denied pool approval never reaches the pool resolver',
    async () => {
      const h = await eachCycleGate();
      const pool = request(h, 'pool_route_first_use');
      decide(h, pool.id, 'denied');
      setDetail(h, JSON.stringify({ approvalId: pool.id, gate: 'each_cycle' }));
      await expectInert(h);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'malformed detail (missing id, missing gate, bad JSON, unknown id) is inert',
    async () => {
      const h = await eachCycleGate();
      const { approvalId } = detailOf(h);
      decide(h, approvalId, 'denied');
      for (const raw of [
        JSON.stringify({ gate: 'each_cycle' }),
        JSON.stringify({ approvalId }),
        '{not json',
        JSON.stringify({ approvalId: 'unknown', gate: 'each_cycle' }),
        null,
      ]) {
        setDetail(h, raw);
        await expectInert(h);
      }
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('valid exact gates keep the accepted supervisor behaviour', () => {
  it(
    'each_cycle: pending waits; denied with an active cycle cancels it as gate_denied; approved resumes',
    async () => {
      const pending = await eachCycleGate();
      expect(await pending.tick()).toBe('waiting_gate');
      expect(pending.cycle()!.status).not.toBe('cancelled');
      cleanupRepoFixtures();

      const denied = await eachCycleGate();
      decide(denied, detailOf(denied).approvalId, 'denied');
      expect(await denied.tick()).toBe('gate_denied');
      expect(cycles(denied)).toMatchObject([{ status: 'cancelled' }]);
      expect(denied.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
      cleanupRepoFixtures();

      const approved = await eachCycleGate();
      decide(approved, detailOf(approved).approvalId, 'approved');
      expect(await approved.tick()).toBe('resumed');
      expect(approved.status().status).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'final_acceptance: pending waits; denied stays with the user; approved resumes',
    async () => {
      const pending = await acceptanceGate();
      expect(await pending.tick()).toBe('waiting_gate');
      cleanupRepoFixtures();

      const denied = await acceptanceGate();
      decide(denied, detailOf(denied).approvalId, 'denied');
      expect(await denied.tick()).toBe('idle');
      expect(denied.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
      cleanupRepoFixtures();

      const approved = await acceptanceGate();
      decide(approved, detailOf(approved).approvalId, 'approved');
      expect(await approved.tick()).toBe('resumed');
      expect(await approved.tick()).toBe('completed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a validly bound denied pool gate goes through the pool resolution path (resume), not gate denial',
    async () => {
      const h = await eachCycleGate();
      const pool = request(h, 'pool_route_first_use');
      decide(h, pool.id, 'denied');
      setDetail(h, JSON.stringify({ approvalId: pool.id, gate: 'pool_route_first_use' }));
      const result = await h.supervisor.tickGoal(h.fx.goalId);
      expect(result.action).not.toBe('gate_denied');
      expect(result.code).not.toBe('gate_binding_invalid');
      expect(h.cycle()!.status).not.toBe('cancelled');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
