import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { RunEngine } from './runEngine.js';
import { assertLoopbackHost } from './networkPolicy.js';
import { deliverPushNotice } from './webPush.js';
import { startQueuedRun } from './runLauncher.js';
import { createGoalSupervisor } from './goals/supervisor.js';
import { DisabledGoalExecutor } from './goals/executor.js';
import { AuthoringReconciler } from './goals/authoring.js';
import { RouteProbeReconciler } from './goals/routeProbe.js';

const host = process.env.TT_HOST ?? '127.0.0.1';
assertLoopbackHost(host);

const database = openDatabase();
const subscribers = new Set<(event: string, payload: Record<string, unknown>) => void>();
const engine = new RunEngine(database, (event, payload) => {
  for (const subscriber of subscribers) subscriber(event, payload);
  void deliverPushNotice(database, event, payload).catch(() => undefined);
});
engine.reconcileInterruptedRuns();
// Stage 3: the Goal supervisor runs with a disabled executor. It can persist, bound and recover Goal state, but no
// route is ever reported ready and no child run or provider call can be started from a Goal.
const goalSupervisor = createGoalSupervisor({
  db: database,
  executor: new DisabledGoalExecutor(),
  startRun: (runId) => startQueuedRun(database, engine, runId),
  resumeRun: (runId) => engine.start(runId, true),
});
await goalSupervisor.reconcile();
// Stage 4B.2: user-triggered Goal authoring runs are consumed from persisted state, with or without the HTTP request
// that started them. This is the only Goal path that starts a model run, and it uses the user's exact pinned route.
const authoringReconciler = new AuthoringReconciler(database, (runId) =>
  startQueuedRun(database, engine, runId),
);
await authoringReconciler.reconcile();
// Stage 5B.1: user-initiated route-validation probes are consumed from persisted state. This reconciler only advances
// probes that already exist; it never creates one and never revalidates anything because a record expired.
const routeProbeReconciler = new RouteProbeReconciler(database, (runId) =>
  startQueuedRun(database, engine, runId),
);
await routeProbeReconciler.reconcile();
const app = createApp({ database, engine });

app.get('/api/events', async (request, reply) => {
  const runId = (request.query as { runId?: string }).runId;
  if (!runId) return reply.code(400).send({ error: 'Specify a run ID.' });
  if (!database.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId))
    return reply.code(404).send({ error: 'Run was not found.' });
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event: string, payload: Record<string, unknown>) => {
    if (payload.runId !== runId) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
  subscribers.add(send);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(send);
  });
});

app.addHook('onClose', async () => {
  database.close();
});

const port = Number.parseInt(process.env.TT_PORT ?? '4317', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error('TT_PORT must be a valid TCP port.');
await app.listen({ host, port });
app.log.info({ host, port }, 'Turing Terminal local master is ready');
goalSupervisor.start();
authoringReconciler.start();
routeProbeReconciler.start();

const shutdown = async () => {
  goalSupervisor.shutdown();
  authoringReconciler.shutdown();
  routeProbeReconciler.shutdown();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
