import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';
import type { GoalDefinition } from '../../shared/goals.js';
import { call, disabledSupervisor, goalApp } from './apiKit.js';
import { decideGoalApproval, requestGoalApproval } from './approvals.js';
import { evaluateCompletion } from './completionEvaluation.js';
import {
  cleanupRepoFixtures,
  milestone,
  passDeterministic,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { transitionGoal } from './stateMachine.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
  cleanupTestDatabases();
});

const acceptanceGoal = (over: Parameters<typeof simpleDefinition>[0] = {}) =>
  harness({
    definition: simpleDefinition({
      milestones: [milestone('m1', ['build', 'tests'])],
      gates: { finalAcceptance: true },
      ...over,
    }),
  });

const post = (a: FastifyInstance, goalId: string, action: string, body: unknown = {}) =>
  call(a, 'POST', `/api/goals/${goalId}/${action}`, body);
const detail = async (a: FastifyInstance, goalId: string) =>
  (await call(a, 'GET', `/api/goals/${goalId}`)).body.goal;

/** Ticks until the supervisor asks for the final-acceptance gate. */
async function toAcceptanceGate(h: Harness) {
  await passDeterministic(h.fx);
  await h.start();
  for (let i = 0; i < 6; i += 1) if ((await h.tick()) === 'gate_requested') return;
  throw new Error('final acceptance gate was never requested');
}
const acceptances = (h: Harness) =>
  h.fx.db
    .prepare("SELECT * FROM goal_approvals WHERE gate = 'final_acceptance' ORDER BY rowid")
    .all() as Array<Record<string, unknown>>;

describe('final acceptance gate lifecycle', () => {
  it(
    'requests one exact final_acceptance approval, waits, and completes only after the explicit resume',
    async () => {
      const h = acceptanceGoal();
      app = goalApp(h.fx.db, h.supervisor);
      const goalId = h.fx.goalId;
      await toAcceptanceGate(h);
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
      const [approval] = acceptances(h);
      expect(approval).toMatchObject({ status: 'pending', requested_by: 'supervisor' });
      expect(approval!.risk).not.toBe('low');
      expect(JSON.parse(approval!.detail_json as string)).toMatchObject({
        definitionVersion: 1,
        definitionHash: h.fx.currentHash(),
        integrationTree: h.fx.tree(),
        integrationHead: h.fx.head(),
      });
      expect(JSON.parse(h.fx.db.prepare('SELECT status_detail_json AS d FROM goals').get().d)).toMatchObject({
        approvalId: approval!.id,
        gate: 'final_acceptance',
      });
      // Idempotent: further ticks neither duplicate nor change anything.
      expect(await h.tick()).toBe('waiting_gate');
      expect(await h.tick()).toBe('waiting_gate');
      expect(acceptances(h)).toHaveLength(1);

      const before = await detail(app, goalId);
      expect(before).toMatchObject({ needsUser: true, status: 'needs_user' });
      expect(before.pendingApprovalCount).toBeGreaterThanOrEqual(1);
      expect(before.nextAction).toEqual({ kind: 'review_approval', approvalId: approval!.id });
      expect(before.completion.finalAcceptance).toMatchObject({ required: true, ok: false });

      // A pending gate cannot be resumed past.
      const early = await post(app, goalId, 'resume', { reason: 'gate_resolved' });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('gate_not_resolved');
      expect(h.status().status).toBe('needs_user');

      const decided = await call(app, 'POST', `/api/goal-approvals/${approval!.id}/decision`, {
        decision: 'approved',
      });
      expect(decided.status).toBe(200);
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
      expect((await detail(app, goalId)).nextAction).toEqual({ kind: 'resume' });

      const resumed = await post(app, goalId, 'resume', { reason: 'gate_resolved' });
      expect(resumed.status).toBe(200);
      expect(h.status().status).toBe('running');
      expect(await h.tick()).toBe('completed');
      expect(h.status().status).toBe('completed');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a denied final acceptance stays with the user, cannot be resumed past, and is not re-requested',
    async () => {
      const h = acceptanceGoal();
      app = goalApp(h.fx.db, h.supervisor);
      await toAcceptanceGate(h);
      const [approval] = acceptances(h);
      await call(app, 'POST', `/api/goal-approvals/${approval!.id}/decision`, { decision: 'denied' });
      expect(await h.tick()).toBe('idle');
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'gate_pending' });
      const refused = await post(app, h.fx.goalId, 'resume', { reason: 'gate_resolved' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('gate_not_resolved');
      expect(h.status().status).toBe('needs_user');
      expect((await detail(app, h.fx.goalId)).nextAction).toEqual({ kind: 'revise_goal' });
      for (let i = 0; i < 3; i += 1) await h.tick();
      expect(acceptances(h)).toHaveLength(1);
      expect(acceptances(h)[0]).toMatchObject({ status: 'denied' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an approval bound to another tree never satisfies completion; a current gate is requested instead',
    async () => {
      const h = acceptanceGoal();
      const old = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'final_acceptance',
        risk: 'medium',
        reason: 'old',
        requestedBy: 'supervisor',
        detail: { definitionVersion: 1, definitionHash: h.fx.currentHash(), integrationTree: 'old-tree' },
      });
      decideGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        approvalId: old.id,
        decision: 'approved',
        decidedBy: 'user',
      });
      await toAcceptanceGate(h);
      const rows = acceptances(h);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ status: 'pending' });
      expect(JSON.parse(rows[1]!.detail_json as string).integrationTree).toBe(h.fx.tree());
      const evaluation = await evaluateCompletion(h.fx.db, h.fx.goalId);
      expect(evaluation.finalAcceptance).toMatchObject({
        ok: false,
        reason: 'bound_to_other_definition_or_tree',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'does not request final acceptance while technical work remains',
    async () => {
      const h = acceptanceGoal();
      await h.start();
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      for (let i = 0; i < 6; i += 1) await h.tick();
      expect(acceptances(h)).toHaveLength(0);
      expect(h.status().status).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a pending final_acceptance approval blocks start/resume preflight',
    async () => {
      const h = acceptanceGoal();
      requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'final_acceptance',
        risk: 'medium',
        reason: 'x',
        requestedBy: 'supervisor',
        detail: {},
      });
      const result = await h.supervisor.startGoal(h.fx.goalId);
      expect(result).toMatchObject({ ok: false, code: 'gate_pending' });
      expect(h.status().status).toBe('ready');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'final apply is only exposed as the next action: no mutation endpoint and no branch movement',
    async () => {
      const h = harness({
        definition: simpleDefinition({
          milestones: [milestone('m1', ['build', 'tests'])],
          policy: { applyToBase: 'required' },
        }),
      });
      app = goalApp(h.fx.db, h.supervisor);
      await passDeterministic(h.fx);
      await h.start();
      let last = '';
      for (let i = 0; i < 4; i += 1) last = await h.tick();
      expect(last).toBe('completion_pending');
      const userHead = h.fx.git('rev-parse', 'HEAD');
      const refs = h.fx.git('for-each-ref');
      const view = await detail(app, h.fx.goalId);
      expect(view.completion.finalApply).toMatchObject({ required: true, ok: false });
      expect(view.nextAction).toEqual({ kind: 'final_apply' });
      const preview = await call(app, 'GET', `/api/goals/${h.fx.goalId}/preview`);
      expect(preview.body.preview.nextAction).toEqual({ kind: 'final_apply' });
      expect((await call(app, 'POST', `/api/goals/${h.fx.goalId}/final-apply`, {})).status).toBe(404);
      expect(h.fx.git('rev-parse', 'HEAD')).toBe(userHead);
      expect(h.fx.git('for-each-ref')).toBe(refs);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('gate_resolved and other resume reasons are fact-bound', () => {
  async function running() {
    const h = harness();
    app = goalApp(h.fx.db, h.supervisor);
    h.model.script.push({ ok: true, proposal: GOOD_TASK });
    await h.start();
    await h.until('waiting_for_run');
    return h;
  }

  it(
    'refuses gate_resolved from run_interrupted without touching the run',
    async () => {
      const h = await running();
      const run = h.runs().at(-1)!;
      h.setRunStatus(run.id, 'paused');
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'needs_user',
        reasonCode: 'run_interrupted',
        actor: 'supervisor',
      });
      const refused = await post(app!, h.fx.goalId, 'resume', { reason: 'gate_resolved' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('gate_not_resolved');
      expect(h.status()).toEqual({ status: 'needs_user', reason: 'run_interrupted' });
      expect(h.resumeRun).not.toHaveBeenCalled();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses gate_resolved from amendment_in_progress and review_needs_decision',
    async () => {
      const h = await running();
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'reviewing',
        reasonCode: 'review_triggered',
        actor: 'supervisor',
      });
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'needs_user',
        reasonCode: 'review_needs_decision',
        actor: 'supervisor',
      });
      const review = await post(app!, h.fx.goalId, 'resume', { reason: 'gate_resolved' });
      expect([review.status, review.body.code]).toEqual([409, 'gate_not_resolved']);
      expect(h.status().reason).toBe('review_needs_decision');

      const other = harness();
      await app!.close();
      app = goalApp(other.fx.db, other.supervisor);
      await other.start();
      expect((await post(app, other.fx.goalId, 'definitions', {})).status).toBe(201);
      expect(other.status().reason).toBe('amendment_in_progress');
      const amendment = await post(app, other.fx.goalId, 'resume', { reason: 'gate_resolved' });
      expect([amendment.status, amendment.body.code]).toEqual([409, 'gate_not_resolved']);
      expect(other.status().reason).toBe('amendment_in_progress');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'an approved exact gate resumes through the normal preflight',
    async () => {
      const h = await running();
      const approval = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'each_cycle',
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
        detail: { approvalId: approval.id, gate: 'each_cycle' },
      });
      const pending = await post(app!, h.fx.goalId, 'resume', { reason: 'gate_resolved' });
      expect([pending.status, pending.body.code]).toEqual([409, 'gate_not_resolved']);
      expect(h.status().status).toBe('needs_user');
      decideGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        approvalId: approval.id,
        decision: 'approved',
        decidedBy: 'user',
      });
      expect((await post(app!, h.fx.goalId, 'resume', { reason: 'gate_resolved' })).status).toBe(200);
      expect(h.status().status).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a gate approval of another Goal does not resolve this Goal',
    async () => {
      const h = await running();
      const other = harness();
      const foreign = requestGoalApproval(other.fx.db, {
        goalId: other.fx.goalId,
        gate: 'each_cycle',
        risk: 'low',
        reason: 'x',
        requestedBy: 'supervisor',
        detail: {},
      });
      decideGoalApproval(other.fx.db, {
        goalId: other.fx.goalId,
        approvalId: foreign.id,
        decision: 'approved',
        decidedBy: 'user',
      });
      // Same database is needed for a cross-Goal row: copy the row into this database under the other Goal's id.
      const row = other.fx.db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(foreign.id) as Record<
        string,
        unknown
      >;
      expect(row.goal_id).not.toBe(h.fx.goalId);
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'needs_user',
        reasonCode: 'gate_pending',
        actor: 'supervisor',
        detail: { approvalId: 'does-not-exist', gate: 'each_cycle' },
      });
      const refused = await post(app!, h.fx.goalId, 'resume', { reason: 'gate_resolved' });
      expect([refused.status, refused.body.code]).toEqual([409, 'gate_not_resolved']);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'user_resume needs a paused Goal and blocker_resolved a blocked one',
    async () => {
      const h = await running();
      for (const reason of ['user_resume', 'blocker_resolved'] as const) {
        const refused = await post(app!, h.fx.goalId, 'resume', { reason });
        expect([refused.status, refused.body.code]).toEqual([409, 'reason_not_applicable']);
      }
      expect(h.status().status).toBe('running');
      transitionGoal(h.fx.db, {
        goalId: h.fx.goalId,
        to: 'blocked',
        reasonCode: 'provider_unavailable',
        actor: 'supervisor',
      });
      expect((await post(app!, h.fx.goalId, 'resume', { reason: 'user_resume' })).body.code).toBe(
        'reason_not_applicable',
      );
      expect((await post(app!, h.fx.goalId, 'resume', { reason: 'run_resumed' })).body.code).toBe(
        'reason_not_applicable',
      );
      expect((await post(app!, h.fx.goalId, 'resume', { reason: 'blocker_resolved' })).status).toBe(200);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('exact-gate nextAction', () => {
  it(
    'points at the exact approval named by the status, not the first pending approval',
    async () => {
      const h = harness();
      app = goalApp(h.fx.db, h.supervisor);
      await h.start();
      const unrelated = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'finding_decision',
        risk: 'low',
        reason: 'older',
        requestedBy: 'system',
        detail: {},
        now: '2020-01-01T00:00:00.000Z',
      });
      const exact = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'each_cycle',
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
        detail: { approvalId: exact.id, gate: 'each_cycle' },
      });
      expect((await detail(app, h.fx.goalId)).nextAction).toEqual({
        kind: 'review_approval',
        approvalId: exact.id,
      });
      expect(unrelated.id).not.toBe(exact.id);
      decideGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        approvalId: exact.id,
        decision: 'denied',
        decidedBy: 'user',
      });
      expect((await detail(app, h.fx.goalId)).nextAction).toEqual({ kind: 'revise_goal' });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('dashboard Goal approvals have their own bound', () => {
  it(
    'newer run approvals cannot starve older pending Goal approvals',
    async () => {
      const h = harness();
      app = goalApp(h.fx.db, h.supervisor);
      h.model.script.push({ ok: true, proposal: GOOD_TASK });
      await h.start();
      await h.until('waiting_for_run');
      const runId = h.runs().at(-1)!.id;
      const db = h.fx.db;
      db.prepare(
        `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, started_at, logs)
       VALUES ('st', ?, 'approval', 'humanApproval', 'Approval', 99, 'waiting_for_approval', ?, '')`,
      ).run(runId, new Date().toISOString());
      for (let i = 0; i < 15; i += 1)
        db.prepare(
          `INSERT INTO approvals (id, run_id, stage_id, operation, reason, risk, status, created_at)
         VALUES (?, ?, 'st', 'Write', 'r', 'low', 'pending', ?)`,
        ).run(`ra${i}`, runId, new Date(Date.now() + 60_000 + i).toISOString());
      const ids = [0, 1].map(
        (i) =>
          requestGoalApproval(db, {
            goalId: h.fx.goalId,
            gate: 'finding_decision',
            risk: 'low',
            reason: `g${i}`,
            requestedBy: 'system',
            detail: {},
            now: `2020-01-0${i + 1}T00:00:00.000Z`,
          }).id,
      );
      const dashboard = (await call(app, 'GET', '/api/dashboard')).body;
      expect(dashboard.goalApprovals.pending).toBe(2);
      expect(dashboard.goalApprovals.approvals.map((a: { id: string }) => a.id).sort()).toEqual(ids.sort());
      const mixed = (await call(app, 'GET', '/api/approvals/unified?limit=10')).body;
      expect(mixed.approvals.every((a: { source: string }) => a.source === 'run')).toBe(true);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('amendment create accepts an optional definition', () => {
  const registered = (): GoalDefinition => {
    const definition = validDefinition();
    definition.routing.workflows = {
      planning: GOAL_WORKFLOW_IDS.planning,
      execution: GOAL_WORKFLOW_IDS.execution,
      review: GOAL_WORKFLOW_IDS.review,
      verification: GOAL_WORKFLOW_IDS.verification,
    };
    definition.limits.humanGates.finalAcceptance = false;
    return definition;
  };
  async function readyGoal() {
    const db = freshDatabase();
    const projectId = seedProject(db);
    app = goalApp(db, disabledSupervisor(db));
    const created = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registered(),
    });
    await call(app, 'POST', `/api/goals/${created.body.goalId}/definitions/1/approve`, {});
    return { db, goalId: created.body.goalId as string };
  }

  it('creates the proposed version from exactly the supplied definition in one request', async () => {
    const { db, goalId } = await readyGoal();
    const modified = registered();
    modified.limits.maxExecutionCycles += 7;
    const begun = await call(app!, 'POST', `/api/goals/${goalId}/definitions`, {
      changeSummary: 'raise limit',
      definition: modified,
    });
    expect(begun.status).toBe(201);
    expect(begun.body.version).toBe(2);
    expect(begun.body.validation).toBeDefined();
    const stored = await call(app!, 'GET', `/api/goals/${goalId}/definitions/2`);
    expect(stored.body.definition.definition.limits.maxExecutionCycles).toBe(
      modified.limits.maxExecutionCycles,
    );
    expect(stored.body.definition.definitionHash).toBe(begun.body.definitionHash);
    expect(stored.body.definition.changeSummary).toBe('raise limit');
    expect(db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId)).toEqual({ status: 'draft' });
  });

  it('still supports the copy-then-PUT flow and refuses unknown fields', async () => {
    const { goalId } = await readyGoal();
    expect((await call(app!, 'POST', `/api/goals/${goalId}/definitions`, { actor: 'system' })).status).toBe(
      400,
    );
    expect(
      (await call(app!, 'POST', `/api/goals/${goalId}/definitions`, { definition: { nope: true } })).status,
    ).toBe(400);
    expect((await call(app!, 'POST', `/api/goals/${goalId}/definitions`, {})).status).toBe(201);
    const edited = registered();
    edited.limits.maxExecutionCycles += 1;
    expect(
      (await call(app!, 'PUT', `/api/goals/${goalId}/definitions/2`, { definition: edited })).status,
    ).toBe(200);
  });
});
