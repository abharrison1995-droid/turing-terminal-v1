import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { RunEngine } from './runEngine.js';
import { assertLoopbackHost } from './networkPolicy.js';
import { deliverPushNotice } from './webPush.js';
import { recoverQueuedRunsAfterRestart, startQueuedRun } from './runLauncher.js';
import { createProductionGoalComposition } from './goals/productionComposition.js';
import type { StartRunResult } from './goals/supervisor.js';
import { AuthoringReconciler } from './goals/authoring.js';
import { RouteProbeReconciler } from './goals/routeProbe.js';
import { GoalEventPublisher } from './goalEventPublisher.js';
import { createMasterEventPublisher, MasterEventHub, registerMasterEventRoute } from './masterEvents.js';
import { DeferredStartupStarts } from './startupStarts.js';

const host = process.env.TT_HOST ?? '127.0.0.1';
assertLoopbackHost(host);

const database = openDatabase();
const eventHub = new MasterEventHub();
const masterEventPublisher = createMasterEventPublisher(eventHub, (event, payload) =>
  deliverPushNotice(database, event, payload),
);
const engine = new RunEngine(database, masterEventPublisher.publishRun);
engine.reconcileInterruptedRuns();
// Providers call back through the HTTP broker, so no startup reconciliation may start provider work before the listener
// is bound. Every startup start below goes through this one gate; the queued rows and their claims are still persisted
// synchronously, and a listener bind failure simply leaves them for the next boot.
const startupStarts = new DeferredStartupStarts();
const startRun = (runId: string): StartRunResult => {
  if (!startupStarts.isFlushed) {
    startupStarts.defer(`run:${runId}`, () => {
      startQueuedRun(database, engine, runId);
    });
    return { started: false, reason: 'deferred' };
  }
  return startQueuedRun(database, engine, runId);
};
const resumeRun = (runId: string): void => {
  if (!startupStarts.isFlushed) {
    startupStarts.defer(`resume:${runId}`, () => engine.start(runId, true));
    return;
  }
  engine.start(runId, true);
};
// HR-Q4: ordinary runs left queued by a crash before start. Goal-owned and probe runs are left to their reconcilers.
// Recovery claims `queued` -> `preparing` synchronously and defers only the engine start behind the listener gate.
recoverQueuedRunsAfterRestart(database, engine, (runId) =>
  startupStarts.defer(`run:${runId}`, () => engine.start(runId)),
);
// The Goal supervisor runs with the persisted-route executor. It decides every state transition and starts at most one
// ordinary queued run at a time through the same RunEngine; the exact backend, provider, model and billing lane come
// from the cycle's write-once role resolution, never from a fallback or a new selection.
const { supervisor: goalSupervisor } = createProductionGoalComposition({
  db: database,
  engine,
  startRun,
  resumeRun,
});
await goalSupervisor.reconcile();
// User-triggered Goal authoring runs are consumed from persisted state, with or without the HTTP request
// that started them, and use the user's exact pinned route.
const authoringReconciler = new AuthoringReconciler(database, startRun);
await authoringReconciler.reconcile();
// User-initiated route-validation probes are consumed from persisted state. This reconciler only advances
// probes that already exist; it never creates one and never revalidates anything because a record expired.
const routeProbeReconciler = new RouteProbeReconciler(database, startRun);
await routeProbeReconciler.reconcile();
// Establish the Goal event high-water mark only after startup reconciliation; these rows are history, not new notices.
const goalEventPublisher = new GoalEventPublisher(database, masterEventPublisher.publishGoal);
goalEventPublisher.initialize();
const app = createApp({ database, engine, goalSupervisor });
registerMasterEventRoute(app, database, eventHub);

app.addHook('onClose', async () => {
  database.close();
});

const port = Number.parseInt(process.env.TT_PORT ?? '4317', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error('TT_PORT must be a valid TCP port.');
await app.listen({ host, port });
// The broker is reachable now. Release every startup start before ready logging, timers or normal scheduling.
startupStarts.flush();
app.log.info({ host, port }, 'Turing Terminal local master is ready');
goalSupervisor.start();
authoringReconciler.start();
routeProbeReconciler.start();
goalEventPublisher.start();

const shutdown = async () => {
  goalSupervisor.shutdown();
  authoringReconciler.shutdown();
  routeProbeReconciler.shutdown();
  goalEventPublisher.shutdown();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
