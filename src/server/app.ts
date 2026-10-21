import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from './db.js';
import { registerGoalRoutes } from './goals/goalRoutes.js';
import type { GoalSupervisor } from './goals/supervisor.js';
import { registerAccessHooks } from './routes/accessHooks.js';
import { registerDecisionGateRoutes } from './routes/decisionGateRoutes.js';
import { registerGoalAuthoringRoutes } from './routes/goalAuthoringRoutes.js';
import { registerNotificationRoutes } from './routes/notificationRoutes.js';
import { registerPairingRoutes } from './routes/pairingRoutes.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';
import { registerProviderRoutes } from './routes/providerRoutes.js';
import { getTailscaleLogin, isRemoteRequest } from './routes/requestIdentity.js';
import { registerRouteProbeRoutes } from './routes/routeProbeRoutes.js';
import { registerRuleRoutes } from './routes/ruleRoutes.js';
import { registerRunRoutes } from './routes/runRoutes.js';
import { registerSystemRoutes } from './routes/systemRoutes.js';
import { registerUsageRoutes, usageFilterFromQuery } from './routes/usageRoutes.js';
import { registerWorkflowRoutes } from './routes/workflowRoutes.js';
import type { RunEngine } from './runEngine.js';

export interface AppOptions {
  database: Db;
  engine: RunEngine;
  /** Serves the Goal start/resume endpoints. Without it they answer 503. */
  goalSupervisor?: GoalSupervisor;
}

export function createApp({ database: db, engine, goalSupervisor }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.TT_LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.tailscale-user-login',
          'req.body.password',
          'req.body.token',
          'req.body.apiKey',
          'req.body.code',
          'req.body.endpoint',
          'req.body.keys.auth',
          'req.body.keys.p256dh',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1_000_000,
  });

  // The access hooks are added before any route, so every /api/ route passes them.
  registerAccessHooks(app, db);
  const context = { db, engine };
  registerSystemRoutes(app, context);
  registerPairingRoutes(app, context);
  registerProviderRoutes(app, context);
  registerUsageRoutes(app, context);
  registerDecisionGateRoutes(app, context);
  registerProjectRoutes(app, context);
  registerRuleRoutes(app, context);
  registerWorkflowRoutes(app, context);
  registerRunRoutes(app, context);
  registerGoalAuthoringRoutes(app, context);

  // The Goal read models, explicit user controls and unified approvals (thin adapters over the services).
  // Desktop-only authority: paired remote devices (Tailscale identity) are refused on the user-only completion and correction routes.
  // This is the same predicate the global hook uses; it does not distinguish the desktop UI from a same-user local process.
  registerGoalRoutes(app, {
    db,
    supervisor: goalSupervisor,
    usageFilterFromQuery,
    requireDesktopCaller: (request) =>
      !isRemoteRequest(request.headers, getTailscaleLogin(request.headers['tailscale-user-login'])),
  });

  registerRouteProbeRoutes(app, context);
  registerNotificationRoutes(app, context);

  const outputDir = resolve(process.cwd(), 'dist');
  if (existsSync(outputDir)) {
    app.register(fastifyStatic, { root: outputDir, prefix: '/', decorateReply: true });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        request.headers.accept?.includes('text/html') &&
        !request.url.startsWith('/api/')
      )
        return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Route was not found.' });
    });
  }
  return app;
}
