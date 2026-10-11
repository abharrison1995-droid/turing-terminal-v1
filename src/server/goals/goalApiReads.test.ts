import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import { RunEngine } from '../runEngine.js';
import { call, goalApp } from './apiKit.js';
import { openFinding, reviewWith } from './remediationKit.js';
import { cleanupRepoFixtures, passDeterministic, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

function setup() {
  const h = harness();
  app = goalApp(h.fx.db, h.supervisor);
  return { h, app, goalId: h.fx.goalId, db: h.fx.db };
}
const get = (a: FastifyInstance, url: string) => call(a, 'GET', url);

async function toRunning(h: Harness) {
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
}

/** A run approval on the Goal's real child run. */
function runApproval(h: Harness, runId: string, id = 'run-approval') {
  const db = h.fx.db;
  db.prepare(
    `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, started_at, logs)
     VALUES (?, ?, 'approval', 'humanApproval', 'Approval', 99, 'waiting_for_approval', ?, '')`,
  ).run(`stage-${id}`, runId, new Date().toISOString());
  db.prepare(
    `INSERT INTO approvals (id, run_id, stage_id, operation, reason, risk, status, created_at)
     VALUES (?, ?, ?, 'Write files', 'Needs a write', 'high', 'pending', ?)`,
  ).run(id, runId, `stage-${id}`, new Date().toISOString());
  return id;
}

describe('Goal list and detail', () => {
  it(
    'lists Goals with a bounded, deterministic shape and derives needsUser from persisted facts',
    async () => {
      const { app, goalId } = setup();
      const list = await get(app, '/api/goals');
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.limit).toBeGreaterThan(0);
      const item = list.body.goals[0];
      expect(item).toMatchObject({
        id: goalId,
        status: 'ready',
        needsUser: false,
        paused: false,
        currentDefinitionVersion: 1,
        pendingApprovalCount: 0,
      });
      expect(item.nextAction.kind).toBe('start');
      expect(await get(app, '/api/goals?limit=1')).toMatchObject({ status: 200 });
      expect((await get(app, '/api/goals?status=bogus')).status).toBe(400);
      expect((await get(app, '/api/goals?surprise=1')).status).toBe(400);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'detail carries the definition, runtime, flags and a nextAction; unknown ids are 404',
    async () => {
      const { h, app, goalId } = setup();
      const detail = await get(app, `/api/goals/${goalId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.goal).toMatchObject({
        id: goalId,
        status: 'ready',
        currentDefinition: { version: 1, definitionHash: h.fx.currentHash() },
      });
      expect(detail.body.goal.runtime).toBeDefined();
      expect(detail.body.goal.nextAction.kind).toBe('start');
      expect((await get(app, '/api/goals/missing')).status).toBe(404);
      await h.start();
      const running = await get(app, `/api/goals/${goalId}`);
      expect(running.body.goal.status).toBe('running');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a paused Goal reports paused (not needsUser) and a resume nextAction',
    async () => {
      const { h, app, goalId } = setup();
      await h.start();
      await call(app, 'POST', `/api/goals/${goalId}/pause`, {});
      const detail = await get(app, `/api/goals/${goalId}`);
      expect(detail.body.goal).toMatchObject({ status: 'paused', paused: true, needsUser: false });
      expect(detail.body.goal.nextAction.kind).toBe('resume');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('cycles, evidence, reviews, findings, events, usage', () => {
  it(
    'cycles show the executed cycle with its run purpose and bounded task view',
    async () => {
      const { h, app, goalId } = setup();
      await toRunning(h);
      const cycles = await get(app, `/api/goals/${goalId}/cycles`);
      expect(cycles.status).toBe(200);
      expect(cycles.body.cycles).toHaveLength(1);
      expect(cycles.body.cycles[0]).toMatchObject({ sequence: 1, status: 'running' });
      expect((await get(app, '/api/goals/missing/cycles')).status).toBe(404);
      expect((await get(app, `/api/goals/${goalId}/cycles?limit=0`)).status).toBe(400);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'evidence is current at the Goal head and becomes stale when the head moves, per row',
    async () => {
      const { h, app, goalId } = setup();
      await passDeterministic(h.fx);
      const fresh = await get(app, `/api/goals/${goalId}/evidence`);
      expect(fresh.status).toBe(200);
      expect(fresh.body.integrationHead).toBe(h.fx.head());
      expect(fresh.body.evidence).toHaveLength(2);
      expect(fresh.body.evidence.every((row: { freshness: string }) => row.freshness === 'current')).toBe(
        true,
      );
      const filtered = await get(app, `/api/goals/${goalId}/evidence?criterionKey=build`);
      expect(filtered.body.evidence.map((row: { criterionKey: string }) => row.criterionKey)).toEqual([
        'build',
      ]);

      h.fx.advance({ 'src/new.ts': 'export const n = 1;\n' });
      const stale = await get(app, `/api/goals/${goalId}/evidence`);
      expect(stale.body.evidence.every((row: { freshness: string }) => row.freshness === 'stale')).toBe(true);
      expect(stale.body.evidence[0].staleReason).toBeTruthy();
      expect((await get(app, `/api/goals/${goalId}/evidence?bogus=1`)).status).toBe(400);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'reviews and findings list persisted rows with status filters',
    async () => {
      const { h, app, goalId } = setup();
      await reviewWith(h.fx, { findings: [{ severity: 'high' }] });
      const reviews = await get(app, `/api/goals/${goalId}/reviews`);
      expect(reviews.status).toBe(200);
      expect(reviews.body.reviews).toHaveLength(1);
      expect(reviews.body.reviews[0]).toMatchObject({ status: 'completed', currentAtHead: true });
      const findings = await get(app, `/api/goals/${goalId}/findings`);
      expect(findings.body.findings).toHaveLength(1);
      expect(findings.body.findings[0].severity).toBe('high');
      expect((await get(app, `/api/goals/${goalId}/findings?status=open`)).body.findings).toHaveLength(1);
      expect((await get(app, `/api/goals/${goalId}/findings?status=resolved`)).body.findings).toHaveLength(0);
      expect((await get(app, `/api/goals/${goalId}/findings?status=nope`)).status).toBe(400);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'events are newest first, bounded, and paginate with a stable before cursor',
    async () => {
      const { h, app, goalId, db } = setup();
      await h.start();
      for (let index = 0; index < 5; index += 1)
        db.prepare(
          'INSERT INTO goal_events (id, goal_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(`e${index}`, goalId, 'note', '{}', new Date().toISOString());
      const total = (
        db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId) as { n: number }
      ).n;
      const first = await get(app, `/api/goals/${goalId}/events?limit=3`);
      expect(first.body.events).toHaveLength(3);
      expect(first.body.events[0].seq).toBeGreaterThan(first.body.events[1].seq);
      const second = await get(app, `/api/goals/${goalId}/events?limit=200&before=${first.body.nextBefore}`);
      expect(second.body.events).toHaveLength(total - 3);
      expect(second.body.events[0].seq).toBeLessThan(first.body.events[2].seq);
      expect((await get(app, `/api/goals/${goalId}/events?limit=201`)).status).toBe(400);
      expect((await get(app, `/api/goals/${goalId}/events?before=abc`)).status).toBe(400);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'usage is scoped to the Goal in the route even if a goalId query is supplied',
    async () => {
      const { app, goalId } = setup();
      const usage = await get(app, `/api/goals/${goalId}/usage`);
      expect(usage.status).toBe(200);
      expect((await get(app, '/api/goals/missing/usage')).status).toBe(404);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('unified approvals', () => {
  it(
    'lists one run approval and one Goal approval with source, ids, risk, reason and linkage',
    async () => {
      const { h, app, goalId } = setup();
      await toRunning(h);
      const runId = h.runs().at(-1)!.id;
      runApproval(h, runId);
      const findingId = await openFinding(h.fx, 'high');
      // A pending Goal approval of a different gate, created by the system.
      const { requestGoalApproval } = await import('./approvals.js');
      const goalApproval = requestGoalApproval(h.fx.db, {
        goalId,
        gate: 'finding_decision',
        risk: 'high',
        reason: 'Needs a decision',
        requestedBy: 'system',
        detail: { findingId },
      });
      const unified = await get(app, '/api/approvals/unified');
      expect(unified.status).toBe(200);
      expect(unified.body.approvals).toHaveLength(2);
      expect(unified.body.total).toBe(2);
      const run = unified.body.approvals.find((a: { source: string }) => a.source === 'run');
      const goal = unified.body.approvals.find((a: { source: string }) => a.source === 'goal');
      expect(run).toMatchObject({
        id: 'run-approval',
        runId,
        goalId,
        risk: 'high',
        reason: 'Needs a write',
        status: 'pending',
      });
      expect(goal).toMatchObject({
        id: goalApproval.id,
        goalId,
        gate: 'finding_decision',
        risk: 'high',
        status: 'pending',
      });
      expect((await get(app, `/api/approvals/unified?goalId=${goalId}`)).body.approvals).toHaveLength(2);
      expect((await get(app, '/api/approvals/unified?goalId=other')).body.approvals).toHaveLength(0);
      expect((await get(app, '/api/approvals/unified?status=bogus')).status).toBe(400);
      expect((await get(app, '/api/approvals/unified?surprise=1')).status).toBe(400);

      // Deciding the Goal approval does not touch the run approval.
      const decided = await call(app, 'POST', `/api/goal-approvals/${goalApproval.id}/decision`, {
        decision: 'denied',
        note: 'no',
      });
      expect(decided.status).toBe(200);
      expect(h.fx.db.prepare("SELECT status FROM approvals WHERE id = 'run-approval'").get()).toEqual({
        status: 'pending',
      });
      expect(
        h.fx.db.prepare('SELECT status, decided_by FROM goal_approvals WHERE id = ?').get(goalApproval.id),
      ).toEqual({ status: 'denied', decided_by: 'user' });
      const after = await get(app, '/api/approvals/unified');
      expect(after.body.approvals).toHaveLength(1);
      expect((await get(app, '/api/approvals/unified?status=all')).body.approvals).toHaveLength(3);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'Goal approval decisions are strict: no authority fields, no repeat, unknown ids are 404',
    async () => {
      const { h, app, goalId } = setup();
      const { requestGoalApproval } = await import('./approvals.js');
      const approval = requestGoalApproval(h.fx.db, {
        goalId,
        gate: 'user_confirmation',
        risk: 'medium',
        reason: 'x',
        requestedBy: 'system',
      });
      const url = `/api/goal-approvals/${approval.id}/decision`;
      for (const body of [
        { decision: 'approved', decidedBy: 'system' },
        { decision: 'approved', actor: 'system' },
        { decision: 'maybe' },
        {},
      ])
        expect((await call(app, 'POST', url, body)).status).toBe(400);
      expect(
        (await call(app, 'POST', '/api/goal-approvals/missing/decision', { decision: 'approved' })).status,
      ).toBe(404);
      expect((await call(app, 'POST', url, { decision: 'approved' })).status).toBe(200);
      expect((await call(app, 'POST', url, { decision: 'denied' })).status).toBe(409);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'the ordinary run approval endpoint is unchanged and does not decide Goal approvals',
    async () => {
      const h = harness();
      await toRunning(h);
      const runId = h.runs().at(-1)!.id;
      runApproval(h, runId);
      const { requestGoalApproval } = await import('./approvals.js');
      const goalApproval = requestGoalApproval(h.fx.db, {
        goalId: h.fx.goalId,
        gate: 'finding_decision',
        risk: 'low',
        reason: 'x',
        requestedBy: 'system',
      });
      app = createApp({
        database: h.fx.db,
        engine: new RunEngine(h.fx.db, () => undefined),
        goalSupervisor: h.supervisor,
      });
      const legacy = await call(app, 'GET', '/api/approvals');
      expect(legacy.body.approvals.map((a: { id: string }) => a.id)).toEqual(['run-approval']);
      const decided = await call(app, 'POST', '/api/approvals/run-approval/decision', { approved: true });
      expect(decided.body).toEqual({ decided: true, approved: true });
      expect(h.fx.db.prepare('SELECT status FROM goal_approvals WHERE id = ?').get(goalApproval.id)).toEqual({
        status: 'pending',
      });
      expect(
        (await call(app, 'POST', `/api/approvals/${goalApproval.id}/decision`, { approved: true })).status,
      ).toBe(404);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

const TABLES = [
  'goals',
  'goal_runtime',
  'goal_cycles',
  'goal_approvals',
  'goal_events',
  'route_validations',
  'runs',
  'usage_events',
  'approvals',
  'goal_findings',
];
function snapshot(db: Harness['fx']['db']) {
  return Object.fromEntries(
    TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

describe('preview and final-apply preflight are read-only', () => {
  it(
    'previews a ready and a running Goal repeatably without creating anything or calling a provider',
    async () => {
      const { h, app, goalId, db } = setup();
      const fetchSpy = vi.fn(() => {
        throw new Error('network call in a read route');
      });
      vi.stubGlobal('fetch', fetchSpy);

      const before = snapshot(db);
      const ready = await get(app, `/api/goals/${goalId}/preview`);
      expect(ready.status).toBe(200);
      expect(ready.body.preview).toMatchObject({ goalId, status: 'ready', task: null });
      expect(ready.body.preview.routing.observation).toBe('stored');
      expect(ready.body.preview.limits.hard.maxExecutionCycles).toBeGreaterThan(0);
      const again = await get(app, `/api/goals/${goalId}/preview`);
      expect(again.body).toEqual(ready.body);
      expect(snapshot(db)).toEqual(before);

      await toRunning(h);
      const calls = h.model.calls;
      const runningBefore = snapshot(db);
      const running = await get(app, `/api/goals/${goalId}/preview`);
      expect(running.status).toBe(200);
      expect(running.body.preview.currentCycle).toMatchObject({ status: 'running' });
      expect(running.body.preview.task).not.toBeNull();
      expect(running.body.preview.proposalRequired).toBe(false);
      expect((await get(app, `/api/goals/${goalId}/preview`)).body).toEqual(running.body);
      expect(snapshot(db)).toEqual(runningBefore);
      expect(h.model.calls).toBe(calls);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await get(app, '/api/goals/missing/preview')).status).toBe(404);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'final-apply preflight reads Git objects only and leaves the user branch and all rows untouched',
    async () => {
      const { h, app, goalId, db } = setup();
      const before = snapshot(db);
      const userHead = h.fx.git('rev-parse', 'HEAD');
      const refs = h.fx.git('for-each-ref');
      const response = await get(app, `/api/goals/${goalId}/final-apply/preflight`);
      expect(response.status).toBe(200);
      expect(response.body.preflight).toBeDefined();
      expect(snapshot(db)).toEqual(before);
      expect(h.fx.git('rev-parse', 'HEAD')).toBe(userHead);
      expect(h.fx.git('for-each-ref')).toBe(refs);
      expect((await get(app, '/api/goals/missing/final-apply/preflight')).status).toBe(404);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('dashboard', () => {
  it(
    'adds goals and goalApprovals additively and leaves the existing fields in place',
    async () => {
      const { h, app, goalId } = setup();
      const { requestGoalApproval } = await import('./approvals.js');
      requestGoalApproval(h.fx.db, {
        goalId,
        gate: 'finding_decision',
        risk: 'low',
        reason: 'x',
        requestedBy: 'system',
      });
      const dashboard = await get(app, '/api/dashboard');
      expect(dashboard.status).toBe(200);
      for (const key of ['machine', 'projects', 'workflows', 'providers', 'runs', 'approvals', 'usage'])
        expect(dashboard.body).toHaveProperty(key);
      expect(dashboard.body.goals).toMatchObject({
        total: 1,
        active: 0,
        needsUser: 1,
        blocked: 0,
        paused: 0,
      });
      expect(dashboard.body.goals.cards).toHaveLength(1);
      expect(dashboard.body.goalApprovals.pending).toBe(1);
      expect(dashboard.body.goalApprovals.approvals[0]).toMatchObject({ source: 'goal', goalId });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
