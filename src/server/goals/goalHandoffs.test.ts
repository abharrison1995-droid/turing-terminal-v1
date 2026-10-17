import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { call, goalApp } from './apiKit.js';
import { createGoalDraft } from './definitions.js';
import { cleanupRepoFixtures, simpleDefinition, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

describe('manual handoff HTTP boundary', () => {
  it(
    'scopes reads to one Goal, bounds history, and GET does not persist',
    async () => {
      const h = harness();
      app = goalApp(h.fx.db, h.supervisor);
      const other = createGoalDraft(h.fx.db, {
        projectId: h.fx.projectId,
        title: 'Other Goal',
        definition: simpleDefinition(),
      });
      const count = () =>
        h.fx.db.prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs').get() as { n: number };

      expect(await call(app, 'GET', `/api/goals/${h.fx.goalId}/handoffs`)).toMatchObject({
        status: 200,
        body: { handoffs: [], limit: 25, nextOffset: null },
      });
      expect(count()).toEqual({ n: 0 });
      expect((await call(app, 'GET', `/api/goals/${h.fx.goalId}/handoffs?limit=51`)).status).toBe(400);
      expect((await call(app, 'GET', `/api/goals/${h.fx.goalId}/handoffs?unbounded=1`)).status).toBe(400);
      expect(
        (await call(app, 'GET', `/api/goals/${other.goalId}/handoffs/${randomUUID()}`)).body,
      ).toMatchObject({
        code: 'handoff_not_found',
      });
      expect((await call(app, 'GET', `/api/goals/not-a-uuid/handoffs`)).status).toBe(400);
      expect((await call(app, 'GET', `/api/goals/${h.fx.goalId}/handoffs/not-a-uuid`)).status).toBe(400);
      expect(
        (await call(app, 'GET', `/api/goals/00000000-0000-4000-8000-000000000000/handoffs`)).status,
      ).toBe(404);
      expect(count()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'accepts only an empty explicit POST, uses the existing user auth boundary, and refuses ineligible Goals',
    async () => {
      const h = harness();
      app = goalApp(h.fx.db, h.supervisor);
      const path = `/api/goals/${h.fx.goalId}/handoffs`;
      const count = () =>
        h.fx.db
          .prepare('SELECT COUNT(*) AS n FROM goal_result_handoffs WHERE goal_id = ?')
          .get(h.fx.goalId) as { n: number };

      for (const body of [
        { sourceRef: 'refs/heads/main' },
        { sourceCommit: 'a'.repeat(40) },
        { approvalId: 'caller-controlled' },
        { evidence: [] },
        { reviewId: 'caller-controlled' },
      ]) {
        expect((await call(app, 'POST', path, body)).status).toBe(400);
      }
      expect(count()).toEqual({ n: 0 });

      const remote = await app.inject({
        method: 'POST',
        url: path,
        headers: { origin: 'https://desktop.tailnet-example.ts.net' },
        payload: {},
      });
      expect(remote.statusCode).toBe(401);
      expect(count()).toEqual({ n: 0 });

      const refused = await call(app, 'POST', path, {});
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBeTruthy();
      expect(count()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
