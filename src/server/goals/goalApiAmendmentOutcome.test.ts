import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GOAL_WORKFLOW_IDS } from '../../shared/goalWorkflows.js';
import { call, goalApp } from './apiKit.js';
import { cleanupRepoFixtures, milestone, passDeterministic, simpleDefinition } from './repoKit.js';
import { harness, type Harness } from './supervisorKit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  cleanupRepoFixtures();
});

const post = (goalId: string, path: string, body: unknown = {}) =>
  call(app!, 'POST', `/api/goals/${goalId}/${path}`, body);
const nextAction = async (goalId: string) =>
  (await call(app!, 'GET', `/api/goals/${goalId}`)).body.goal.nextAction;

/** A valid replacement under the registered workflows (a bare copy of the fixture is not approvable). */
async function changedDefinition(goalId: string) {
  const read = await call(app!, 'GET', `/api/goals/${goalId}/definitions/1`);
  const definition = structuredClone(read.body.definition.definition);
  definition.routing.workflows = {
    planning: GOAL_WORKFLOW_IDS.planning,
    execution: GOAL_WORKFLOW_IDS.execution,
    review: GOAL_WORKFLOW_IDS.review,
    verification: GOAL_WORKFLOW_IDS.verification,
  };
  return definition;
}

async function runningHarness(): Promise<Harness> {
  const h = harness({ definition: simpleDefinition({ milestones: [milestone('m1', ['build', 'tests'])] }) });
  app = goalApp(h.fx.db, h.supervisor);
  await passDeterministic(h.fx);
  await h.start();
  return h;
}

describe('resume_after_amendment names the outcome the persisted history proves', () => {
  it('approved amendment: exactly amendment_approved, and the approve itself does not resume', async () => {
    const h = await runningHarness();
    expect((await post(h.fx.goalId, 'pause')).status).toBe(200);
    expect(
      (
        await post(h.fx.goalId, 'definitions', {
          changeSummary: 'amend',
          definition: await changedDefinition(h.fx.goalId),
        })
      ).status,
    ).toBe(201);
    expect(await nextAction(h.fx.goalId)).toEqual({ kind: 'approve_definition', version: 2 });
    expect((await post(h.fx.goalId, 'definitions/2/approve')).status).toBe(200);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
    expect(await nextAction(h.fx.goalId)).toEqual({
      kind: 'resume_after_amendment',
      resolved: ['amendment_approved'],
    });
  });

  it('discarded amendment: exactly amendment_discarded, and the reject itself does not resume', async () => {
    const h = await runningHarness();
    expect((await post(h.fx.goalId, 'pause')).status).toBe(200);
    expect((await post(h.fx.goalId, 'definitions')).status).toBe(201);
    expect((await post(h.fx.goalId, 'definitions/2/reject')).status).toBe(200);
    expect(h.status()).toEqual({ status: 'needs_user', reason: 'amendment_in_progress' });
    expect(await nextAction(h.fx.goalId)).toEqual({
      kind: 'resume_after_amendment',
      resolved: ['amendment_discarded'],
    });
  });
});
