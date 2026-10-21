import type { FastifyInstance } from 'fastify';
import {
  createRouteProbe,
  getRouteProbeStatus,
  RouteProbeError,
  routeProbeRequestSchema,
} from '../goals/routeProbe.js';
import { startQueuedRun } from '../runLauncher.js';
import type { RouteContext } from './routeUtils.js';

export function registerRouteProbeRoutes(app: FastifyInstance, { db, engine }: RouteContext): void {
  // Route-validation probes: a user asks for ONE exact route to be probed. The server derives the profiles from the roles, captures
  // the route identity itself and answers as soon as the run is queued. There is no revalidation endpoint: a probe only
  // ever exists because a user posted this request.
  app.post('/api/route-validations', async (request, reply) => {
    const parsed = routeProbeRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? 'Invalid route validation request.' });
    try {
      const started = await createRouteProbe(db, parsed.data, (runId) => startQueuedRun(db, engine, runId));
      return reply.code(202).send(started);
    } catch (error) {
      if (error instanceof RouteProbeError) {
        const status =
          error.code === 'route_incomplete' || error.code === 'identity_unresolved'
            ? 400
            : error.code === 'fixture_unavailable' || error.code === 'workflow_invalid'
              ? 503
              : 409;
        return reply.code(status).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get('/api/route-validations/:probeId', async (request, reply) => {
    const status = getRouteProbeStatus(db, (request.params as { probeId: string }).probeId);
    if (!status) return reply.code(404).send({ error: 'The route validation probe was not found.' });
    return { probe: status };
  });
}
