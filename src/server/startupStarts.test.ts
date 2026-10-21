import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { RunEngine } from './runEngine.js';
import { cleanupTestDatabases, freshDatabase } from './goals/testKit.js';
import { DeferredStartupStarts } from './startupStarts.js';

afterEach(cleanupTestDatabases);

const brokerStatus = (port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/internal/provider-tools',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ toolName: 'read_file', input: { path: 'package.json' } }));
  });

describe('DeferredStartupStarts', () => {
  it('deduplicates by run key, preserves insertion order and flushes exactly once', () => {
    const starts = new DeferredStartupStarts();
    const calls: string[] = [];
    starts.defer('run-b', () => calls.push('b'));
    starts.defer('run-a', () => calls.push('a'));
    starts.defer('run-b', () => calls.push('b-again'));

    expect(starts.isFlushed).toBe(false);
    expect(calls).toEqual([]);

    starts.flush();
    expect(calls).toEqual(['b', 'a']);
    expect(starts.isFlushed).toBe(true);

    starts.flush();
    expect(calls).toEqual(['b', 'a']);
  });

  it('runs work deferred after the flush immediately', () => {
    const starts = new DeferredStartupStarts();
    const calls: string[] = [];
    starts.flush();
    starts.defer('run-a', () => calls.push('a'));
    expect(calls).toEqual(['a']);
  });

  it('attempts every queued callback and rethrows the first error after all attempts', () => {
    const starts = new DeferredStartupStarts();
    const calls: string[] = [];
    const first = new Error('first failed');
    const second = new Error('second failed');
    starts.defer('run-a', () => {
      calls.push('a');
      throw first;
    });
    starts.defer('run-b', () => {
      calls.push('b');
      throw second;
    });
    starts.defer('run-c', () => calls.push('c'));

    expect(() => starts.flush()).toThrow(first);
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(starts.isFlushed).toBe(true);
  });

  it('proves the real listener is bound before a deferred callback reaches the provider broker', async () => {
    const db = freshDatabase();
    const engine = new RunEngine(db, () => undefined);
    const app = createApp({ database: db, engine });
    const starts = new DeferredStartupStarts();
    let port = 0;
    let callbackRan = false;
    let listeningAtCallback = false;
    let response: Promise<number> | undefined;
    starts.defer('run-test', () => {
      callbackRan = true;
      listeningAtCallback = app.server.listening;
      response = brokerStatus(port);
    });

    expect(callbackRan).toBe(false);
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP test listener.');
      port = address.port;
      starts.flush();

      expect(callbackRan).toBe(true);
      expect(listeningAtCallback).toBe(true);
      expect(await response).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('production startup ordering', () => {
  it('statically flushes deferred starts after listen and before ready logging or timers', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const at = (needle: string): number => {
      const index = source.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };

    const listen = at('await app.listen(');
    const flush = at('startupStarts.flush()');
    const readyLog = at("app.log.info({ host, port }, 'Turing Terminal local master is ready')");
    for (const startup of [
      'recoverQueuedRunsAfterRestart(',
      'createProductionGoalComposition(',
      'await goalSupervisor.reconcile()',
      'await authoringReconciler.reconcile()',
      'await routeProbeReconciler.reconcile()',
    ])
      expect(at(startup), startup).toBeLessThan(listen);
    expect(listen).toBeLessThan(flush);
    expect(flush).toBeLessThan(readyLog);
    for (const timer of [
      'goalSupervisor.start()',
      'authoringReconciler.start()',
      'routeProbeReconciler.start()',
      'goalEventPublisher.start()',
    ])
      expect(flush, timer).toBeLessThan(at(timer));
  });
});
