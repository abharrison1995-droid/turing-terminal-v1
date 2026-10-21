import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { createApp } from '../app.js';
import type { RunEngine } from '../runEngine.js';
import { DisabledGoalExecutor } from './executor.js';
import { createGoalSupervisor, type GoalSupervisor } from './supervisor.js';

/**
 * Test helper for the Goal HTTP surface. The engine is a stub that fails loudly if a Goal route ever reaches for it: the
 * Goal API must not start, resume or decide ordinary runs.
 */
const engineStub = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`The Goal API must not use the run engine (${String(property)}).`);
    },
  },
) as unknown as RunEngine;

export function goalApp(db: Db, goalSupervisor?: GoalSupervisor): FastifyInstance {
  process.env.TT_LOG_LEVEL = 'silent';
  return createApp({ database: db, engine: engineStub, ...(goalSupervisor ? { goalSupervisor } : {}) });
}

/** A test-only wiring: a supervisor whose executor is disabled, so no route is ever ready. */
export function disabledSupervisor(db: Db): GoalSupervisor {
  return createGoalSupervisor({
    db,
    executor: new DisabledGoalExecutor(),
    startRun: () => ({ started: false, reason: 'not-found' }),
    resumeRun: () => undefined,
  });
}

export async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  /** `headers` replaces the default. By default a definition mutation carries the CURRENT persisted hash. */
  headers?: Record<string, string>,
  // Test responses are untyped JSON; the assertions state the shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  let sent = headers;
  const target = /^(\/api\/goals\/[^/]+\/definitions\/\d+)(\/approve|\/reject)?$/.exec(url);
  if (!sent && target && (method === 'PUT' || (method === 'POST' && target[2]))) {
    const read = await app.inject({ method: 'GET', url: target[1]! });
    const hash = (JSON.parse(read.body) as { definition?: { definitionHash?: string } }).definition
      ?.definitionHash;
    if (hash) sent = { 'if-match': `"${hash}"` };
  }
  const response = await app.inject({
    method,
    url,
    ...(sent ? { headers: sent } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
}
