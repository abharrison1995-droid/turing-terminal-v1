import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { call, disabledSupervisor, goalApp } from './apiKit.js';
import { openFinding } from './remediationKit.js';
import { cleanupRepoFixtures } from './repoKit.js';
import { GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';
import { transitionGoal } from './stateMachine.js';
import { GOOD_TASK, harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  app = goalApp(h.fx.db, h.supervisor);
  return { h, app, goalId: h.fx.goalId, db: h.fx.db };
}

const statusOf = (h: Harness) => h.status();
const post = (a: FastifyInstance, goalId: string, action: string, body: unknown = {}) =>
  call(a, 'POST', `/api/goals/${goalId}/${action}`, body);

/** Replaces an amendment's copied fixture definition with one whose workflows are the registered Goal built-ins. */
async function makeAmendmentValid(h: Harness, a: FastifyInstance, version: number) {
  const read = await call(a, 'GET', `/api/goals/${h.fx.goalId}/definitions/${version}`);
  const definition = structuredClone(read.body.definition.definition);
  definition.routing.workflows = {
    planning: GOAL_WORKFLOW_IDS.planning,
    execution: GOAL_WORKFLOW_IDS.execution,
    review: GOAL_WORKFLOW_IDS.review,
    verification: GOAL_WORKFLOW_IDS.verification,
  };
  const put = await call(a, 'PUT', `/api/goals/${h.fx.goalId}/definitions/${version}`, { definition });
  expect(put.status).toBe(200);
}

/** Drives the Goal until its first execution run is in flight. */
async function toRunning(h: Harness) {
  h.model.script.push({ ok: true, proposal: GOOD_TASK });
  await h.start();
  await h.until('waiting_for_run');
}

describe('start over HTTP', () => {
  it('starts a ready Goal through the supervisor (preflight included) and reports the status', async () => {
    const { h, app, goalId } = setup();
    const response = await post(app, goalId, 'start');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, goalStatus: 'running' });
    expect(statusOf(h)).toEqual({ status: 'running', reason: 'user_start' });
  });

  it('answers 503 without a supervisor and refuses unknown fields', async () => {
    const h = harness();
    await app?.close();
    app = goalApp(h.fx.db);
    const none = await post(app, h.fx.goalId, 'start');
    expect(none.status).toBe(503);
    expect(none.body.code).toBe('goal_supervisor_unavailable');
    const { app: other, goalId } = setup();
    for (const extra of [{ actor: 'system' }, { reasonCode: 'blocker_resolved' }, { approvalId: 'x' }]) {
      const refused = await post(other, goalId, 'start', extra);
      expect(refused.status).toBe(400);
    }
  });

  it('with the production executor (disabled) the start is refused as route_unavailable and changes nothing', async () => {
    const h = harness();
    app = goalApp(h.fx.db, disabledSupervisor(h.fx.db));
    const response = await post(app, h.fx.goalId, 'start');
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false, code: 'route_unavailable' });
    expect(statusOf(h).status).toBe('ready');
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 0 });
    expect(h.fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });

  it('an unknown Goal is a 404 and a Goal that is already running is refused, not restarted', async () => {
    const { h, app, goalId } = setup();
    expect((await post(app, 'missing', 'start')).status).toBe(404);
    await post(app, goalId, 'start');
    const again = await post(app, goalId, 'start');
    expect(again.status).toBe(409);
    expect(statusOf(h).status).toBe('running');
  });
});

describe('pause over HTTP', () => {
  it('pauses a running Goal as the user and closes the active-time interval', async () => {
    const { h, app, goalId, db } = setup();
    await h.start();
    h.clock.ms += 30_000;
    const paused = await post(app, goalId, 'pause');
    expect(paused.status).toBe(200);
    expect(paused.body).toEqual({ status: 'paused' });
    expect(statusOf(h)).toEqual({ status: 'paused', reason: 'user' });
    expect(h.tracker.pendingMs(goalId)).toBe(0);
    expect(
      (db.prepare('SELECT active_ms AS ms FROM goal_runtime WHERE goal_id = ?').get(goalId) as { ms: number })
        .ms,
    ).toBeGreaterThanOrEqual(30_000);
    const events = db
      .prepare(
        "SELECT payload_json FROM goal_events WHERE goal_id = ? AND type = 'state_changed' ORDER BY rowid DESC LIMIT 1",
      )
      .get(goalId) as { payload_json: string };
    expect(JSON.parse(events.payload_json)).toMatchObject({ to: 'paused', actor: 'user' });
  });

  it('pausing with a child run in flight cancels nothing, and a run finishing while paused is not integrated', async () => {
    const { h, app, goalId, db } = setup();
    await toRunning(h);
    const run = h.runs().at(-1)!;
    const head = h.fx.head();
    expect((await post(app, goalId, 'pause')).status).toBe(200);
    expect(
      (db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id) as { status: string }).status,
    ).toBe('running');
    expect(h.tracker.pendingMs(goalId)).toBe(0);

    h.setRunStatus(run.id, 'completed');
    const action = await h.tick();
    expect(['idle', 'busy', 'not_found']).toContain(action);
    expect(statusOf(h).status).toBe('paused');
    expect(h.fx.head()).toBe(head);
    expect(h.cycle()).toMatchObject({ status: 'running' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_integration_ops').get()).toEqual({ n: 0 });

    // Only an explicit user resume lets the supervisor collect and integrate the finished run.
    const resumed = await post(app, goalId, 'resume', { reason: 'user_resume' });
    expect(resumed.status).toBe(200);
    expect(await h.tick()).toBe('collection_started');
    expect(await h.tick()).toBe('integration_started');
    expect(await h.tick()).toBe('cycle_succeeded');
    expect(h.fx.head()).not.toBe(head);
  });

  it('refuses to pause a Goal that is not running, with a structured 409', async () => {
    const { app, goalId } = setup();
    const refused = await post(app, goalId, 'pause');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('illegal_transition');
    expect((await post(app, 'missing', 'pause')).status).toBe(404);
    expect((await post(app, goalId, 'pause', { actor: 'system' })).status).toBe(400);
  });
});

describe('resume over HTTP', () => {
  it('resumes a paused Goal with user_resume', async () => {
    const { h, app, goalId } = setup();
    await h.start();
    await post(app, goalId, 'pause');
    const resumed = await post(app, goalId, 'resume', { reason: 'user_resume' });
    expect(resumed.body).toEqual({ ok: true, goalStatus: 'running' });
    expect(statusOf(h)).toEqual({ status: 'running', reason: 'user_resume' });
  });

  it('needs_user(run_interrupted) with run_resumed resumes the exact paused run', async () => {
    const { h, app, goalId } = setup();
    await toRunning(h);
    const run = h.runs().at(-1)!;
    h.setRunStatus(run.id, 'paused');
    transitionGoal(h.fx.db, {
      goalId,
      to: 'needs_user',
      reasonCode: 'run_interrupted',
      actor: 'supervisor',
      detail: { runId: run.id },
    });
    const detail = await call(app, 'GET', `/api/goals/${goalId}`);
    expect(detail.body.goal.nextAction).toEqual({ kind: 'resume_run', runId: run.id });
    expect(detail.body.goal.flags.childRun).toBe('paused');
    const resumed = await post(app, goalId, 'resume', { reason: 'run_resumed' });
    expect(resumed.status).toBe(200);
    expect(h.resumeRun).toHaveBeenCalledTimes(1);
    expect(h.resumeRun).toHaveBeenCalledWith(run.id);
    expect(statusOf(h).status).toBe('running');
  });

  it('run_resumed without a paused run is refused and the Goal is unchanged', async () => {
    const { h, app, goalId } = setup();
    await toRunning(h);
    transitionGoal(h.fx.db, { goalId, to: 'needs_user', reasonCode: 'run_interrupted', actor: 'supervisor' });
    const refused = await post(app, goalId, 'resume', { reason: 'run_resumed' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('no_paused_run');
    expect(statusOf(h).status).toBe('needs_user');
    expect(h.resumeRun).not.toHaveBeenCalled();
  });

  it('blocked resumes with blocker_resolved', async () => {
    const { h, app, goalId } = setup();
    await h.start();
    transitionGoal(h.fx.db, {
      goalId,
      to: 'blocked',
      reasonCode: 'provider_unavailable',
      actor: 'supervisor',
    });
    const detail = await call(app, 'GET', `/api/goals/${goalId}`);
    expect(detail.body.goal.nextAction).toEqual({
      kind: 'resolve_blocker',
      reasonCode: 'provider_unavailable',
    });
    const resumed = await post(app, goalId, 'resume', { reason: 'blocker_resolved' });
    expect(resumed.status).toBe(200);
    expect(statusOf(h)).toEqual({ status: 'running', reason: 'blocker_resolved' });
  });

  it('amendment_approved and amendment_discarded resume only after the matching persisted amendment action', async () => {
    const { h, app, goalId } = setup();
    await h.start();
    // A false claim: no amendment exists.
    const none = await post(app, goalId, 'resume', { reason: 'amendment_approved' });
    expect(none.status).toBe(409);

    const begun = await post(app, goalId, 'definitions', { changeSummary: 'tweak' });
    expect(begun.status).toBe(201);
    expect(statusOf(h)).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
    // The amendment is still undecided, so neither claim is a fact yet.
    expect((await post(app, goalId, 'resume', { reason: 'amendment_approved' })).status).toBe(409);
    expect((await post(app, goalId, 'resume', { reason: 'amendment_discarded' })).status).toBe(409);

    await makeAmendmentValid(h, app, 2);
    const approved = await post(app, goalId, 'definitions/2/approve');
    expect(approved.status).toBe(200);
    // A discard claim after an approval is false.
    expect((await post(app, goalId, 'resume', { reason: 'amendment_discarded' })).status).toBe(409);
    const resumed = await post(app, goalId, 'resume', { reason: 'amendment_approved' });
    expect(resumed.status).toBe(200);
    expect(statusOf(h)).toEqual({ status: 'running', reason: 'amendment_approved' });

    await post(app, goalId, 'definitions', {});
    const rejected = await post(app, goalId, 'definitions/3/reject');
    expect(rejected.status).toBe(200);
    expect((await post(app, goalId, 'resume', { reason: 'amendment_approved' })).status).toBe(409);
    const discarded = await post(app, goalId, 'resume', { reason: 'amendment_discarded' });
    expect(discarded.status).toBe(200);
    expect(statusOf(h)).toEqual({ status: 'running', reason: 'amendment_discarded' });
  });

  it('refuses an impossible state, an unknown reason, user_start, and extra authority fields', async () => {
    const { h, app, goalId } = setup();
    expect((await post(app, goalId, 'resume', { reason: 'user_resume' })).status).toBe(409);
    expect(statusOf(h).status).toBe('ready');
    for (const body of [
      { reason: 'user_start' },
      { reason: 'because' },
      {},
      { reason: 'user_resume', actor: 'system' },
      { reason: 'user_resume', runId: 'x' },
    ])
      expect((await post(app, goalId, 'resume', body)).status).toBe(400);
  });
});

describe('abandon over HTTP', () => {
  it('abandons from a legal edge and deletes nothing', async () => {
    const { h, app, goalId, db } = setup();
    await h.start();
    await post(app, goalId, 'pause');
    const abandoned = await post(app, goalId, 'abandon');
    expect(abandoned.body).toEqual({ status: 'abandoned' });
    expect(statusOf(h)).toEqual({ status: 'abandoned', reason: 'user_abandoned' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_definition_versions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId)).not.toEqual({
      n: 0,
    });
  });

  it('a ready Goal can be abandoned; a running or abandoned one cannot', async () => {
    const { h, app, goalId } = setup();
    await h.start();
    const running = await post(app, goalId, 'abandon');
    expect(running.status).toBe(409);
    expect(statusOf(h).status).toBe('running');
    await post(app, goalId, 'pause');
    await post(app, goalId, 'abandon');
    const twice = await post(app, goalId, 'abandon');
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('terminal_state');
    const ready = harness();
    const readyApp = goalApp(ready.fx.db, ready.supervisor);
    try {
      expect((await post(readyApp, ready.fx.goalId, 'abandon')).status).toBe(200);
    } finally {
      await readyApp.close();
    }
  });
});

describe('finding decisions over HTTP', () => {
  const decision = (a: FastifyInstance, goalId: string, findingId: string, body: unknown) =>
    call(a, 'POST', `/api/goals/${goalId}/findings/${findingId}/decision`, body);

  it('accepts and dismisses through one user approval bound to finding, decision and definition', async () => {
    const { h, app, goalId, db } = setup();
    const accepted = await openFinding(h.fx, 'medium');
    const dismissed = await openFinding(h.fx, 'low');
    const first = await decision(app, goalId, accepted, { decision: 'accepted_by_user', note: 'fine' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ findingId: accepted, status: 'accepted_by_user' });
    const approval = db
      .prepare('SELECT * FROM goal_approvals WHERE id = ?')
      .get(first.body.decisionApprovalId) as Record<string, unknown>;
    expect(approval).toMatchObject({
      gate: 'finding_decision',
      status: 'approved',
      decided_by: 'user',
      requested_by: 'user',
      decision_note: 'fine',
    });
    expect(JSON.parse(approval.detail_json as string)).toMatchObject({
      findingId: accepted,
      decision: 'accepted_by_user',
      definitionVersion: 1,
      definitionHash: h.fx.currentHash(),
    });
    expect(
      db.prepare('SELECT status, decision_approval_id FROM goal_findings WHERE id = ?').get(accepted),
    ).toEqual({ status: 'accepted_by_user', decision_approval_id: first.body.decisionApprovalId });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ? AND type = 'finding_decided'")
        .get(goalId),
    ).toEqual({ n: 1 });

    const second = await decision(app, goalId, dismissed, { decision: 'dismissed_by_user' });
    expect(second.body.status).toBe('dismissed_by_user');
    // Decided findings are final: a repeat is a conflict, not a second approval.
    const repeat = await decision(app, goalId, accepted, { decision: 'dismissed_by_user' });
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe('finding_not_open');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'finding_decision'").get(),
    ).toEqual({ n: 2 });
  });

  it('refuses client-supplied approval authority and unknown decisions', async () => {
    const { h, app, goalId, db } = setup();
    const id = await openFinding(h.fx, 'high');
    const approvalsBefore = db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get();
    for (const body of [
      { decision: 'resolved' },
      { decision: 'accepted_by_user', approvalId: 'x' },
      { decision: 'accepted_by_user', actor: 'system' },
      { decision: 'accepted_by_user', status: 'resolved' },
      {},
    ])
      expect((await decision(app, goalId, id, body)).status).toBe(400);
    expect(db.prepare('SELECT status FROM goal_findings WHERE id = ?').get(id)).toEqual({ status: 'open' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get()).toEqual(approvalsBefore);
    expect((await decision(app, goalId, 'missing', { decision: 'accepted_by_user' })).status).toBe(404);
    expect((await decision(app, 'missing', id, { decision: 'accepted_by_user' })).status).toBe(404);
  });

  it('is atomic: a failure after the approval was created leaves no approval and the finding open', async () => {
    const { h, app, goalId, db } = setup();
    const id = await openFinding(h.fx, 'high');
    const eventsBefore = db
      .prepare(
        "SELECT COUNT(*) AS n FROM goal_events WHERE type IN ('approval_requested','approval_decided','finding_decided')",
      )
      .get();
    db.exec(`CREATE TRIGGER inject_failure BEFORE UPDATE ON goal_findings
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const failed = await decision(app, goalId, id, { decision: 'accepted_by_user' });
    expect(failed.status).toBe(500);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'finding_decision'").get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM goal_events WHERE type IN ('approval_requested','approval_decided','finding_decided')",
        )
        .get(),
    ).toEqual(eventsBefore);
    expect(db.prepare('SELECT status, decision_approval_id FROM goal_findings WHERE id = ?').get(id)).toEqual(
      {
        status: 'open',
        decision_approval_id: null,
      },
    );
    db.exec('DROP TRIGGER inject_failure');
    expect((await decision(app, goalId, id, { decision: 'accepted_by_user' })).status).toBe(200);
  });

  it('surfaces finding_integration_in_progress as a 409 and rolls back the approval', async () => {
    const { h, app, goalId, db } = setup();
    const id = await openFinding(h.fx, 'high');
    const cycleId = randomUUID();
    db.prepare(
      `INSERT INTO goal_cycles (id, goal_id, definition_version, milestone_id, sequence, kind, trigger_code, status,
         base_integration_commit, outcome_json, created_at)
       VALUES (?, ?, 1, ?, 1, 'remediation', 'finding_remediation', 'integrating', ?, ?, ?)`,
    ).run(
      cycleId,
      goalId,
      h.fx.milestoneId('m1'),
      h.fx.head(),
      JSON.stringify({ remediationPlan: { episodes: [{ findingId: id }] } }),
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO goal_integration_ops (id, goal_id, cycle_id, op, expected_old, new_commit, status, checks_json, created_at)
       VALUES (?, ?, ?, 'advance', ?, ?, 'planned', '{}', ?)`,
    ).run(randomUUID(), goalId, cycleId, h.fx.head(), h.fx.head(), new Date().toISOString());
    const locked = await decision(app, goalId, id, { decision: 'dismissed_by_user' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('finding_integration_in_progress');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM goal_approvals WHERE gate = 'finding_decision'").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM goal_findings WHERE id = ?').get(id)).toEqual({ status: 'open' });
  });
});
