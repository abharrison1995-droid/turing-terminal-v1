import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { RunEngine } from './runEngine.js';
import { assertLoopbackHost } from './networkPolicy.js';
import { deliverPushNotice } from './webPush.js';
import { recoverQueuedRunsAfterRestart, startQueuedRun } from './runLauncher.js';
import { createProductionGoalComposition } from './goals/productionComposition.js';
import { AuthoringReconciler } from './goals/authoring.js';
import { RouteProbeReconciler } from './goals/routeProbe.js';
import { GoalEventPublisher } from './goalEventPublisher.js';
import { createMasterEventPublisher, MasterEventHub, registerMasterEventRoute } from './masterEvents.js';

const host = process.env.TT_HOST ?? '127.0.0.1';
assertLoopbackHost(host);

const database = openDatabase();
const eventHub = new MasterEventHub();
const masterEventPublisher = createMasterEventPublisher(eventHub, (event, payload) =>
  deliverPushNotice(database, event, payload),
);
const engine = new RunEngine(database, masterEventPublisher.publishRun);
engine.reconcileInterruptedRuns();
// HR-Q4: ordinary runs left queued by a crash before start. Goal-owned and probe runs are left to their reconcilers.
recoverQueuedRunsAfterRestart(database, engine);
// The Goal supervisor runs with the persisted-route executor. It decides every state transition and starts at most one
// ordinary queued run at a time through the same RunEngine; the exact backend, provider, model and billing lane come
// from the cycle's write-once role resolution, never from a fallback or a new selection.
const { supervisor: goalSupervisor } = createProductionGoalComposition({ db: database, engine });
await goalSupervisor.reconcile();
// User-triggered Goal authoring runs are consumed from persisted state, with or without the HTTP request
// that started them, and use the user's exact pinned route.
const authoringReconciler = new AuthoringReconciler(database, (runId) =>
  startQueuedRun(database, engine, runId),
);
await authoringReconciler.reconcile();
// User-initiated route-validation probes are consumed from persisted state. This reconciler only advances
// probes that already exist; it never creates one and never revalidates anything because a record expired.
const routeProbeReconciler = new RouteProbeReconciler(database, (runId) =>
  startQueuedRun(database, engine, runId),
);
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
