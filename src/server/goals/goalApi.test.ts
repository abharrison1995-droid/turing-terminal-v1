import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';
import type { GoalDefinition } from '../../shared/goals.js';
import { call, disabledSupervisor, goalApp } from './apiKit.js';
import { cleanupTestDatabases, freshDatabase, seedProject, validDefinition } from './testKit.js';

/** A definition whose workflow ids are Turing's registered Goal built-ins, so contextual validation can pass. */
function registeredDefinition(): GoalDefinition {
  const definition = validDefinition();
  definition.routing.workflows = {
    planning: GOAL_WORKFLOW_IDS.planning,
    execution: GOAL_WORKFLOW_IDS.execution,
    review: GOAL_WORKFLOW_IDS.review,
    verification: GOAL_WORKFLOW_IDS.verification,
  };
  definition.limits.humanGates.finalAcceptance = false;
  return definition;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupTestDatabases();
});

function setup() {
  const db = freshDatabase();
  const projectId = seedProject(db);
  const instance = goalApp(db, disabledSupervisor(db));
  app = instance;
  return { db, projectId, app: instance };
}

const statusOf = (db: ReturnType<typeof freshDatabase>, goalId: string) =>
  db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string };

describe('manual Goal drafts and definition authoring over HTTP', () => {
  it('creates a draft from a manual definition without any model call, and never approves it', async () => {
    const { db, projectId, app } = setup();
    const created = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'Parser',
      definition: registeredDefinition(),
      changeSummary: 'by hand',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ version: 1, validation: { valid: true } });
    expect(created.body.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(statusOf(db, created.body.goalId).status).toBe('draft');
    expect(
      db
        .prepare('SELECT status, created_by FROM goal_definition_versions WHERE goal_id = ?')
        .get(created.body.goalId),
    ).toEqual({ status: 'proposed', created_by: 'user' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 0 });
  });

  it('refuses unknown fields and server-owned authority on create', async () => {
    const { db, projectId, app } = setup();
    for (const extra of [
      { status: 'running' },
      { actor: 'system' },
      { approvedBy: 'user' },
      { definitionHash: 'a'.repeat(64) },
      { approvalId: 'x' },
    ]) {
      const response = await call(app, 'POST', '/api/goals', {
        projectId,
        title: 'T',
        definition: registeredDefinition(),
        ...extra,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_request');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM goals').get()).toEqual({ n: 0 });
  });

  it('returns 404 for an unknown project and 422 for a definition that cannot be serialised', async () => {
    const { app } = setup();
    const missing = await call(app, 'POST', '/api/goals', {
      projectId: 'nope',
      title: 'T',
      definition: registeredDefinition(),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('project_not_found');
  });

  it('edits only a proposed version, revalidates it, and does not approve or start', async () => {
    const { db, projectId, app } = setup();
    const { body } = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registeredDefinition(),
    });
    const edited = registeredDefinition();
    edited.contract.outcome = 'Ship the better parser';
    const put = await call(app, 'PUT', `/api/goals/${body.goalId}/definitions/1`, { definition: edited });
    expect(put.status).toBe(200);
    expect(put.body.definition.definition.contract.outcome).toBe('Ship the better parser');
    expect(put.body.definition.definitionHash).not.toBe(body.definitionHash);
    expect(put.body.definition.validation.valid).toBe(true);
    expect(statusOf(db, body.goalId).status).toBe('draft');

    const broken = registeredDefinition();
    broken.routing.workflows.planning = 'no-such-workflow';
    const invalid = await call(app, 'PUT', `/api/goals/${body.goalId}/definitions/1`, { definition: broken });
    expect(invalid.status).toBe(200);
    expect(invalid.body.definition.validation.valid).toBe(false);
    expect(invalid.body.definition.validation.errors[0]).toMatchObject({ severity: 'error' });
  });

  it('approves as the user only after contextual validation passes; approval does not start the Goal', async () => {
    const { db, projectId, app } = setup();
    const { body } = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registeredDefinition(),
    });
    // Client-supplied approval authority is refused outright.
    for (const extra of [
      { approvalId: 'a' },
      { actor: 'system' },
      { decidedBy: 'user' },
      { definitionHash: 'h' },
    ]) {
      const refused = await call(app, 'POST', `/api/goals/${body.goalId}/definitions/1/approve`, extra);
      expect(refused.status).toBe(400);
    }
    expect(statusOf(db, body.goalId).status).toBe('draft');
    const approved = await call(app, 'POST', `/api/goals/${body.goalId}/definitions/1/approve`, {
      note: 'ok',
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ version: 1, goalStatus: 'ready' });
    expect(approved.body.definitionHash).toBe(body.definitionHash);
    expect(approved.body.approvalId).toBeTruthy();
    const row = db
      .prepare(
        'SELECT approved_by, approval_id FROM goal_definition_versions WHERE goal_id = ? AND version = 1',
      )
      .get(body.goalId) as { approved_by: string; approval_id: string };
    expect(row.approved_by).toBe('user');
    expect(
      db.prepare('SELECT decided_by, status FROM goal_approvals WHERE id = ?').get(row.approval_id),
    ).toEqual({ decided_by: 'user', status: 'approved' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 0 });
    // Approved versions are immutable over HTTP.
    const edit = await call(app, 'PUT', `/api/goals/${body.goalId}/definitions/1`, {
      definition: registeredDefinition(),
    });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('definition_not_editable');
  });

  it('refuses to approve an invalid definition with 422 and issues, changing nothing', async () => {
    const { db, projectId, app } = setup();
    const broken = registeredDefinition();
    broken.routing.workflows.execution = 'no-such-workflow';
    const { body } = await call(app, 'POST', '/api/goals', { projectId, title: 'T', definition: broken });
    const refused = await call(app, 'POST', `/api/goals/${body.goalId}/definitions/1/approve`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('definition_invalid');
    expect(Array.isArray(refused.body.detail)).toBe(true);
    expect(statusOf(db, body.goalId).status).toBe('draft');
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get()).toEqual({ n: 0 });
  });

  it('rejects a proposed version, and an unknown version or goal is a 404', async () => {
    const { db, projectId, app } = setup();
    const { body } = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registeredDefinition(),
    });
    const rejected = await call(app, 'POST', `/api/goals/${body.goalId}/definitions/1/reject`, {});
    expect(rejected.status).toBe(200);
    expect(
      db.prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ?').get(body.goalId),
    ).toEqual({
      status: 'rejected',
    });
    expect(
      (
        await call(
          app,
          'POST',
          `/api/goals/${body.goalId}/definitions/9/reject`,
          {},
          { 'if-match': `"${'a'.repeat(64)}"` },
        )
      ).status,
    ).toBe(404);
    expect((await call(app, 'GET', '/api/goals/missing/definitions')).status).toBe(404);
    expect((await call(app, 'GET', `/api/goals/${body.goalId}/definitions/abc`)).status).toBe(400);
  });

  it('serves definition history as summaries and full versions with validation', async () => {
    const { projectId, app } = setup();
    const { body } = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registeredDefinition(),
    });
    const list = await call(app, 'GET', `/api/goals/${body.goalId}/definitions`);
    expect(list.body.definitions).toHaveLength(1);
    expect(list.body.definitions[0]).toMatchObject({ version: 1, status: 'proposed', createdBy: 'user' });
    expect(list.body.definitions[0].definition).toBeUndefined();
    const full = await call(app, 'GET', `/api/goals/${body.goalId}/definitions/1`);
    expect(full.body.definition.definition.contract.outcome).toBe('Ship the parser');
    expect(full.body.definition.validation.valid).toBe(true);
  });
});

describe('amendments over HTTP', () => {
  it('begins an amendment of a ready Goal (returns to draft), then approves the new version', async () => {
    const { db, projectId, app } = setup();
    const { body } = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registeredDefinition(),
    });
    await call(app, 'POST', `/api/goals/${body.goalId}/definitions/1/approve`, {});
    const begun = await call(app, 'POST', `/api/goals/${body.goalId}/definitions`, {
      changeSummary: 'tighten',
    });
    expect(begun.status).toBe(201);
    expect(begun.body.version).toBe(2);
    expect(statusOf(db, body.goalId).status).toBe('draft');
    const detail = await call(app, 'GET', `/api/goals/${body.goalId}`);
    expect(detail.body.goal.proposedDefinition.version).toBe(2);
    expect(detail.body.goal.currentDefinition.version).toBe(1);
    expect(detail.body.goal.nextAction).toEqual({ kind: 'approve_definition', version: 2 });
    const approved = await call(app, 'POST', `/api/goals/${body.goalId}/definitions/2/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.goalStatus).toBe('ready');
    expect(
      db
        .prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
        .get(body.goalId),
    ).toEqual({ status: 'superseded' });
  });

  it('discarding an amendment of a ready Goal returns it to ready', async () => {
    const { db, projectId, app } = setup();
    const { body } = await call(app, 'POST', '/api/goals', {
      projectId,
      title: 'T',
      definition: registeredDefinition(),
    });
    await call(app, 'POST', `/api/goals/${body.goalId}/definitions/1/approve`, {});
    await call(app, 'POST', `/api/goals/${body.goalId}/definitions`, {});
    const rejected = await call(app, 'POST', `/api/goals/${body.goalId}/definitions/2/reject`, {});
    expect(rejected.body.goalStatus).toBe('ready');
    expect(statusOf(db, body.goalId).status).toBe('ready');
  });
});
