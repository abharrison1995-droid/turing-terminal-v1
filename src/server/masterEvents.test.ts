import Fastify from 'fastify';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabases, freshDatabase, goalAt, seedProject } from './goals/testKit.js';
import { createMasterEventPublisher, MasterEventHub, registerMasterEventRoute } from './masterEvents.js';

afterEach(cleanupTestDatabases);

describe('Master event subscriptions', () => {
  it('filters Goal and run events by the exact published identity', () => {
    const hub = new MasterEventHub();
    const a: string[] = [];
    const b: string[] = [];
    const run: string[] = [];
    hub.subscribeGoal('goal-a', (event) => a.push(event));
    hub.subscribeGoal('goal-b', (event) => b.push(event));
    hub.subscribeRun('run-a', (event) => run.push(event));

    hub.publishGoal('state_changed', { goalId: 'goal-a', to: 'running' });
    hub.publishRun('run_updated', { runId: 'run-a', status: 'running' });

    expect(a).toEqual(['state_changed']);
    expect(b).toEqual([]);
    expect(run).toEqual(['run_updated']);
  });

  it('keeps the authoritative event fan-out healthy when a subscriber or Web Push delivery fails', async () => {
    const hub = new MasterEventHub();
    const received: string[] = [];
    hub.subscribeGoal('goal-a', () => {
      throw new Error('closed stream');
    });
    hub.subscribeGoal('goal-a', (event) => received.push(event));
    const publish = createMasterEventPublisher(hub, async () => {
      throw new Error('push unavailable');
    });

    expect(() => publish.publishGoal('state_changed', { goalId: 'goal-a', to: 'completed' })).not.toThrow();
    await Promise.resolve();
    expect(received).toEqual(['state_changed']);
  });

  it('routes by explicit event source when Goal and Run payloads contain both identities', () => {
    const hub = new MasterEventHub();
    const goalEvents: string[] = [];
    const runEvents: string[] = [];
    hub.subscribeGoal('goal-a', (event) => goalEvents.push(event));
    hub.subscribeRun('run-a', (event) => runEvents.push(event));

    hub.publishGoal('run_evidence_collected', {
      goalId: 'goal-a',
      runId: 'run-a',
      cycleId: 'cycle-a',
      definitionVersion: 1,
      evidenceCount: 2,
    });
    expect(goalEvents).toEqual(['run_evidence_collected']);
    expect(runEvents).toEqual([]);

    hub.publishRun('run_updated', { runId: 'run-a', goalId: 'goal-a', status: 'running' });
    expect(runEvents).toEqual(['run_updated']);
    expect(goalEvents).toEqual(['run_evidence_collected']);
  });

  it('keeps Run and Goal events on the same Web Push delivery path', () => {
    const hub = new MasterEventHub();
    const delivered: Array<[string, Record<string, unknown>]> = [];
    const publisher = createMasterEventPublisher(hub, (event, payload) => delivered.push([event, payload]));

    publisher.publishRun('run_updated', { runId: 'run-a', status: 'running' });
    publisher.publishGoal('state_changed', { goalId: 'goal-a', to: 'completed' });

    expect(delivered).toEqual([
      ['run_updated', { runId: 'run-a', status: 'running' }],
      ['state_changed', { goalId: 'goal-a', to: 'completed' }],
    ]);
  });

  it('requires exactly one known identity and streams both existing run and exact Goal events', async () => {
    const db = freshDatabase();
    const projectId = seedProject(db);
    const goalA = goalAt(db, projectId, 'ready');
    goalAt(db, projectId, 'ready');
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const workflowId = (db.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string }).id;
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, status, created_at) VALUES ('run-a', ?, ?, ?, '{}', 'test', 'economy', 'normal', 'queued', ?)`,
    ).run(machineId, projectId, workflowId, new Date().toISOString());
    const hub = new MasterEventHub();
    const app = Fastify();
    registerMasterEventRoute(app, db, hub);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test listener.');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await app.inject('/api/events')).statusCode).toBe(400);
      expect((await app.inject('/api/events?runId=run-a&goalId=goal-a')).statusCode).toBe(400);
      expect((await app.inject('/api/events?runId=missing')).statusCode).toBe(404);
      expect((await app.inject('/api/events?goalId=missing')).statusCode).toBe(404);

      const goalStream = await openStream(`${base}/api/events?goalId=${encodeURIComponent(goalA)}`);
      const runStream = await openStream(`${base}/api/events?runId=run-a`);
      let goalFrames = '';
      let runFrames = '';
      goalStream.response.on('data', (chunk: Buffer) => {
        goalFrames += chunk.toString('utf8');
      });
      runStream.response.on('data', (chunk: Buffer) => {
        runFrames += chunk.toString('utf8');
      });
      const goalData = nextData(goalStream.response);
      hub.publishGoal('run_evidence_collected', {
        goalId: goalA,
        runId: 'run-a',
        cycleId: 'cycle-a',
        definitionVersion: 1,
        evidenceCount: 1,
      });
      expect(await goalData).toContain('event: run_evidence_collected');
      await flushSseTurns();
      expect(runFrames).not.toContain('event: run_evidence_collected');
      expect(goalStream.response.statusCode).toBe(200);

      const runData = nextData(runStream.response);
      hub.publishRun('run_updated', { runId: 'run-a', goalId: goalA, status: 'running' });
      expect(await runData).toContain('event: run_updated');
      await flushSseTurns();
      expect(goalFrames).not.toContain('event: run_updated');
      expect(runStream.response.statusCode).toBe(200);

      expect(hub.subscriberCount).toBe(2);
      await closeStream(goalStream.request, goalStream.response, hub, 1);
      expect(hub.subscriberCount).toBe(1);
      await closeStream(runStream.request, runStream.response, hub, 0);
      expect(hub.subscriberCount).toBe(0);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
});

async function openStream(url: string): Promise<{ request: ClientRequest; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => resolve({ request, response }));
    request.once('error', reject);
  });
}

async function flushSseTurns(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function nextData(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    response.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    response.once('error', reject);
  });
}

async function closeStream(
  request: ClientRequest,
  response: IncomingMessage,
  hub: MasterEventHub,
  subscriberCount: number,
): Promise<void> {
  const socket = response.socket;
  request.destroy();
  response.destroy();
  socket?.destroy();
  for (let turn = 0; turn < 20 && hub.subscriberCount !== subscriberCount; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
