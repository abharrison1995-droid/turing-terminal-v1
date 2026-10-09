import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Db } from './db.js';

export type MasterEventHandler = (event: string, payload: Record<string, unknown>) => void;

type Subscription = {
  matches: (payload: Record<string, unknown>) => boolean;
  handler: MasterEventHandler;
};

/** One filtered in-process fan-out for run and Goal event streams. */
export class MasterEventHub {
  private readonly subscriptions = new Set<Subscription>();

  subscribeRun(runId: string, handler: MasterEventHandler): () => void {
    return this.add((payload) => payload.runId === runId, handler);
  }

  subscribeGoal(goalId: string, handler: MasterEventHandler): () => void {
    return this.add((payload) => payload.goalId === goalId, handler);
  }

  publish(event: string, payload: Record<string, unknown>): void {
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.matches(payload)) continue;
      try {
        subscription.handler(event, payload);
      } catch {
        // A disconnected/broken listener cannot affect workflow or Goal execution.
      }
    }
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  private add(matches: Subscription['matches'], handler: MasterEventHandler): () => void {
    const subscription = { matches, handler };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }
}

/** Reuses one subscriber fan-out and isolates optional Web Push delivery from all state transitions. */
export function createMasterEventPublisher(
  events: MasterEventHub,
  deliverPush: MasterEventHandler,
): MasterEventHandler {
  return (event, payload) => {
    events.publish(event, payload);
    try {
      void Promise.resolve(deliverPush(event, payload)).catch(() => undefined);
    } catch {
      // A synchronous Web Push failure is also isolated from the authoritative event producer.
    }
  };
}

/** The existing run stream and the Goal stream share this exact query contract and cleanup path. */
export function registerMasterEventRoute(app: FastifyInstance, db: Db, events: MasterEventHub): void {
  const activeStreams = new Set<ServerResponse>();
  app.addHook('onClose', async () => {
    for (const response of activeStreams) response.end();
  });
  app.get('/api/events', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const hasRunId = Object.hasOwn(query, 'runId');
    const hasGoalId = Object.hasOwn(query, 'goalId');
    if (hasRunId === hasGoalId)
      return reply.code(400).send({ error: 'Specify exactly one run ID or Goal ID.' });

    const identity = hasRunId ? query.runId : query.goalId;
    if (typeof identity !== 'string' || identity.length === 0 || identity.length > 128)
      return reply.code(400).send({ error: 'The event subscription ID is invalid.' });
    if (hasRunId && !db.prepare('SELECT 1 FROM runs WHERE id = ?').get(identity))
      return reply.code(404).send({ error: 'Run was not found.' });
    if (hasGoalId && !db.prepare('SELECT 1 FROM goals WHERE id = ?').get(identity))
      return reply.code(404).send({ error: 'Goal was not found.' });

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    let closed = false;
    activeStreams.add(response);
    const unsubscribe = hasRunId
      ? events.subscribeRun(identity, (event, payload) => write(event, payload))
      : events.subscribeGoal(identity, (event, payload) => write(event, payload));
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keep-alive\n\n');
    }, 20_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      activeStreams.delete(response);
    };
    function write(event: string, payload: Record<string, unknown>) {
      if (closed || response.destroyed) {
        cleanup();
        return;
      }
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    response.once('close', cleanup);
    response.once('error', cleanup);
  });
}
