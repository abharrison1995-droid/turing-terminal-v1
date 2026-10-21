import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUTHORING_LIMITS,
  GoalAuthoringError,
  getAuthoringStatus,
  retryGoalAuthoring,
  startGoalAuthoring,
} from '../goals/authoring.js';
import { TuringExecutorError } from '../goals/turingExecutor.js';
import { startQueuedRun } from '../runLauncher.js';
import type { RouteContext } from './routeUtils.js';
import { modelConfigurationSchema } from './workflowSchemas.js';

/**
 * Goal authoring. Starting or retrying persists a draft Goal, an authoring cycle and one queued run, then answers 202 at once;
 * the user-pinned route is exact (no pool, fallback or substitution) and the output is consumed later. The other Goal
 * routes are in goals/goalRoutes.ts.
 */
export function registerGoalAuthoringRoutes(app: FastifyInstance, { db, engine }: RouteContext): void {
  const authoringBody = {
    title: z.string().trim().min(1).max(AUTHORING_LIMITS.titleChars),
    prompt: z.string().trim().min(1).max(AUTHORING_LIMITS.promptChars),
    route: modelConfigurationSchema.strict(),
  };
  const authoringSchema = z.strictObject({ projectId: z.string().min(1).max(100), ...authoringBody });
  const authoringRetrySchema = z.strictObject({
    prompt: authoringBody.prompt,
    route: authoringBody.route,
  });
  const authoringFailure = (
    error: unknown,
    reply: { code(status: number): { send(body: unknown): unknown } },
  ) => {
    if (error instanceof GoalAuthoringError) {
      const status =
        error.code === 'project_not_found' || error.code === 'goal_not_found'
          ? 404
          : error.code === 'route_invalid' ||
              error.code === 'prompt_invalid' ||
              error.code === 'workflow_invalid'
            ? 400
            : 409;
      return reply.code(status).send({ error: error.message, code: error.code });
    }
    if (error instanceof TuringExecutorError)
      return reply.code(409).send({ error: error.message, code: error.code });
    throw error;
  };

  app.post('/api/goals/authoring', async (request, reply) => {
    const parsed = authoringSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid authoring request.' });
    try {
      const started = await startGoalAuthoring(db, parsed.data, (runId) => startQueuedRun(db, engine, runId));
      return reply.code(202).send(started);
    } catch (error) {
      return authoringFailure(error, reply);
    }
  });

  app.post('/api/goals/:goalId/authoring/retry', async (request, reply) => {
    const parsed = authoringRetrySchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid authoring request.' });
    try {
      const started = await retryGoalAuthoring(
        db,
        { goalId: (request.params as { goalId: string }).goalId, ...parsed.data },
        (runId) => startQueuedRun(db, engine, runId),
      );
      return reply.code(202).send(started);
    } catch (error) {
      return authoringFailure(error, reply);
    }
  });

  app.get('/api/goals/:goalId/authoring', async (request, reply) => {
    const status = getAuthoringStatus(db, (request.params as { goalId: string }).goalId);
    if (!status) return reply.code(404).send({ error: 'The Goal has no authoring attempt.' });
    return { authoring: status };
  });
}
