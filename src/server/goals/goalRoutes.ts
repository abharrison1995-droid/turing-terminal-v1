import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { GoalDefinition } from '../../shared/goals.js';
import type { GoalApiError, GoalFinalApplyPreflightView } from '../../shared/goalApi.js';
import { GOAL_RESUME_REASONS } from '../../shared/goalApi.js';
import type { Db } from '../db.js';
import { GoalGitError, preflightFinalApply } from '../goalGit.js';
import { queryUsageAnalytics, type UsageFilter } from '../usageAnalytics.js';
import { GoalApprovalError } from './approvals.js';
import {
  GoalDefinitionError,
  approveDefinition,
  beginAmendment,
  createGoalDraft,
  editProposedDefinition,
  rejectDefinition,
} from './definitions.js';
import { GoalFindingError } from './findings.js';
import { abandonGoal, decideFindingAsUser, decideGoalApprovalAsUser, pauseGoal } from './goalCommands.js';
import { previewGoal } from './preview.js';
import {
  GoalReadError,
  getDefinitionFull,
  getGoalCycles,
  getGoalDetail,
  getGoalEvents,
  getGoalEvidence,
  getGoalFindings,
  getGoalReviews,
  listDefinitionSummaries,
  listGoals,
  unifiedApprovals,
  workflowContexts,
} from './readModel.js';
import { GoalStateError } from './stateMachine.js';
import type { GoalSupervisor } from './supervisor.js';

/**
 * Stage 7A Goal HTTP surface. Every route is a thin adapter over an accepted service:
 *  - status changes only through `transitionGoal` (via `pauseGoal`/`abandonGoal`), the `GoalSupervisor` and the
 *    definition/finding/approval services;
 *  - the actor is the server-fixed `user`; bodies are `z.strictObject`, so a client can never supply an actor,
 *    approval id, definition hash, base/integration commit, route resolution or status;
 *  - read routes make no provider/model/network call and write nothing.
 * Domain refusals map to 400/404/409/422 with `{ error, code, detail? }`; there are no stack traces.
 */
export interface GoalRouteDeps {
  db: Db;
  /** Absent in apps built without a supervisor: start/resume then answer 503. */
  supervisor?: GoalSupervisor | undefined;
  usageFilterFromQuery: (
    db: Db,
    query: Record<string, string | undefined>,
  ) => UsageFilter | { error: string };
}

const send = (reply: FastifyReply, status: number, body: GoalApiError & Record<string, unknown>) =>
  reply.code(status).send(body);

const NOT_FOUND = new Set([
  'goal_not_found',
  'definition_not_found',
  'project_not_found',
  'approval_not_found',
  'finding_not_found',
]);

/** Maps a thrown domain error to a response; rethrows anything that is not a known domain refusal. */
function domainError(error: unknown, reply: FastifyReply) {
  if (error instanceof GoalReadError)
    return send(reply, error.code === 'invalid_filter' ? 400 : 404, {
      error: error.message,
      code: error.code,
    });
  if (error instanceof GoalDefinitionError) {
    const status = NOT_FOUND.has(error.code)
      ? 404
      : error.code === 'definition_invalid' || error.code === 'definition_not_serialisable'
        ? 422
        : 409;
    return send(reply, status, {
      error: error.message,
      code: error.code,
      ...(error.issues.length ? { detail: error.issues.slice(0, 50) } : {}),
    });
  }
  if (
    error instanceof GoalStateError ||
    error instanceof GoalApprovalError ||
    error instanceof GoalFindingError
  ) {
    const status = NOT_FOUND.has(error.code) ? 404 : error.code === 'invalid_gate' ? 400 : 409;
    return send(reply, status, { error: error.message, code: error.code });
  }
  if (error instanceof GoalGitError)
    return send(reply, error.code === 'goal_not_found' ? 404 : 409, {
      error: error.message,
      code: error.code,
    });
  throw error;
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  reply: FastifyReply,
): { ok: true; data: T } | { ok: false } {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  send(reply, 400, {
    error: parsed.error.issues[0]?.message ?? 'Invalid request.',
    code: 'invalid_request',
    detail: parsed.error.issues
      .slice(0, 20)
      .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
  return { ok: false };
}

const note = z.string().trim().min(1).max(1_000).optional();
const definitionBody = z
  .object({
    contract: z.unknown().refine((value) => value !== undefined, 'contract is required'),
    milestones: z.unknown().refine((value) => value !== undefined, 'milestones is required'),
    routing: z.unknown().refine((value) => value !== undefined, 'routing is required'),
    review: z.unknown().refine((value) => value !== undefined, 'review is required'),
    limits: z.unknown().refine((value) => value !== undefined, 'limits is required'),
  })
  .strict()
  .transform((value) => value as unknown as GoalDefinition);
const createBody = z.strictObject({
  projectId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  definition: definitionBody,
  changeSummary: z.string().trim().min(1).max(500).optional(),
});
const editBody = z.strictObject({
  definition: definitionBody,
  changeSummary: z.string().trim().min(1).max(500).optional(),
});
const amendBody = z.strictObject({
  changeSummary: z.string().trim().min(1).max(500).optional(),
  definition: definitionBody.optional(),
});
const noteBody = z.strictObject({ note });
const resumeBody = z.strictObject({ reason: z.enum(GOAL_RESUME_REASONS) });
const findingDecisionBody = z.strictObject({
  decision: z.enum(['accepted_by_user', 'dismissed_by_user']),
  note,
});
const goalApprovalDecisionBody = z.strictObject({ decision: z.enum(['approved', 'denied']), note });
const empty = z.strictObject({});

const number = z.coerce.number().int();
const limitQuery = number.min(1).max(200).optional();
const listQuery = z.strictObject({
  limit: limitQuery,
  status: z.string().max(50).optional(),
  projectId: z.string().max(200).optional(),
});
const limitOnly = z.strictObject({ limit: limitQuery });
const evidenceQuery = z.strictObject({ limit: limitQuery, criterionKey: z.string().max(200).optional() });
const findingsQuery = z.strictObject({ limit: limitQuery, status: z.string().max(50).optional() });
const eventsQuery = z.strictObject({ limit: limitQuery, before: number.min(1).optional() });
const approvalsQuery = z.strictObject({
  status: z.string().max(50).optional(),
  goalId: z.string().max(200).optional(),
  limit: limitQuery,
});
const versionParam = z.coerce.number().int().min(1);

export function registerGoalRoutes(app: FastifyInstance, deps: GoalRouteDeps): void {
  const { db } = deps;
  const goalIdOf = (request: { params: unknown }) => (request.params as { goalId: string }).goalId;

  // --- Reads ---------------------------------------------------------------------------------------------------------

  app.get('/api/goals', async (request, reply) => {
    const query = parse(listQuery, request.query, reply);
    if (!query.ok) return reply;
    try {
      return listGoals(db, query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId', async (request, reply) => {
    try {
      return { goal: await getGoalDetail(db, goalIdOf(request), workflowContexts(db)) };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/definitions', async (request, reply) => {
    try {
      return { definitions: listDefinitionSummaries(db, goalIdOf(request)) };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/definitions/:version', async (request, reply) => {
    const version = versionParam.safeParse((request.params as { version: string }).version);
    if (!version.success)
      return send(reply, 400, { error: 'The version must be a positive integer.', code: 'invalid_request' });
    try {
      return { definition: getDefinitionFull(db, goalIdOf(request), version.data, workflowContexts(db)) };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/cycles', async (request, reply) => {
    const query = parse(limitOnly, request.query, reply);
    if (!query.ok) return reply;
    try {
      return getGoalCycles(db, goalIdOf(request), query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/evidence', async (request, reply) => {
    const query = parse(evidenceQuery, request.query, reply);
    if (!query.ok) return reply;
    try {
      return await getGoalEvidence(db, goalIdOf(request), query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/reviews', async (request, reply) => {
    const query = parse(limitOnly, request.query, reply);
    if (!query.ok) return reply;
    try {
      return await getGoalReviews(db, goalIdOf(request), query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/findings', async (request, reply) => {
    const query = parse(findingsQuery, request.query, reply);
    if (!query.ok) return reply;
    try {
      return getGoalFindings(db, goalIdOf(request), query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/events', async (request, reply) => {
    const query = parse(eventsQuery, request.query, reply);
    if (!query.ok) return reply;
    try {
      return getGoalEvents(db, goalIdOf(request), query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/usage', async (request, reply) => {
    const goalId = goalIdOf(request);
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    // The route parameter always wins: a query-supplied goalId can neither widen nor redirect the filter.
    const filter = deps.usageFilterFromQuery(db, {
      ...(request.query as Record<string, string | undefined>),
      goalId,
    });
    if ('error' in filter) return send(reply, 400, { error: filter.error, code: 'invalid_request' });
    return queryUsageAnalytics(db, { ...filter, goalId });
  });

  app.get('/api/goals/:goalId/preview', async (request, reply) => {
    try {
      return { preview: await previewGoal(db, goalIdOf(request)) };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/final-apply/preflight', async (request, reply) => {
    const goalId = goalIdOf(request);
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    try {
      const result = await preflightFinalApply(db, goalId);
      const view: GoalFinalApplyPreflightView = {
        status: result.status,
        recordedBaseBranch: result.recordedBaseBranch,
        recordedBaseCommit: result.recordedBaseCommit,
        currentBranch: result.currentBranch,
        currentHead: result.currentHead,
        dirty: result.dirty,
        integrationHead: result.integrationHead,
        goalRef: result.goalRef,
        fastForwardPossible: result.fastForwardPossible,
        ahead: result.ahead,
        behind: result.behind,
        changedPathCount: result.changedPaths.length,
        changedPaths: result.changedPaths.slice(0, 200),
        safety: { ok: result.safety.ok, violationCount: result.safety.violations.length },
        appliedExternallySupported: false,
        manualReconciliationRequired: ['goal_ref_changed', 'base_diverged', 'not_fast_forward'].includes(
          result.status,
        ),
      };
      return { preflight: view };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.get('/api/approvals/unified', async (request, reply) => {
    const query = parse(approvalsQuery, request.query, reply);
    if (!query.ok) return reply;
    try {
      return unifiedApprovals(db, query.data);
    } catch (error) {
      return domainError(error, reply);
    }
  });

  // --- Definition authoring ------------------------------------------------------------------------------------------

  app.post('/api/goals', async (request, reply) => {
    const body = parse(createBody, request.body, reply);
    if (!body.ok) return reply;
    try {
      const created = createGoalDraft(db, {
        projectId: body.data.projectId,
        title: body.data.title,
        definition: body.data.definition,
        ...(body.data.changeSummary ? { changeSummary: body.data.changeSummary } : {}),
        createdBy: 'user',
      });
      const full = getDefinitionFull(db, created.goalId, created.version, workflowContexts(db));
      return reply.code(201).send({
        goalId: created.goalId,
        version: created.version,
        definitionHash: created.definitionHash,
        validation: full.validation,
      });
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.put('/api/goals/:goalId/definitions/:version', async (request, reply) => {
    const version = versionParam.safeParse((request.params as { version: string }).version);
    if (!version.success)
      return send(reply, 400, { error: 'The version must be a positive integer.', code: 'invalid_request' });
    const body = parse(editBody, request.body, reply);
    if (!body.ok) return reply;
    try {
      const goalId = goalIdOf(request);
      editProposedDefinition(db, {
        goalId,
        version: version.data,
        definition: body.data.definition,
        ...(body.data.changeSummary ? { changeSummary: body.data.changeSummary } : {}),
      });
      return { definition: getDefinitionFull(db, goalId, version.data, workflowContexts(db)) };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.post('/api/goals/:goalId/definitions', async (request, reply) => {
    const body = parse(amendBody, request.body, reply);
    if (!body.ok) return reply;
    try {
      const goalId = goalIdOf(request);
      const started = beginAmendment(db, {
        goalId,
        actor: 'user',
        createdBy: 'user',
        ...(body.data.changeSummary ? { changeSummary: body.data.changeSummary } : {}),
        ...(body.data.definition ? { definition: body.data.definition } : {}),
      });
      return reply.code(201).send({
        version: started.version,
        definitionHash: started.definitionHash,
        validation: getDefinitionFull(db, goalId, started.version, workflowContexts(db)).validation,
      });
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.post('/api/goals/:goalId/definitions/:version/approve', async (request, reply) => {
    const version = versionParam.safeParse((request.params as { version: string }).version);
    if (!version.success)
      return send(reply, 400, { error: 'The version must be a positive integer.', code: 'invalid_request' });
    const body = parse(noteBody, request.body, reply);
    if (!body.ok) return reply;
    try {
      const goalId = goalIdOf(request);
      const approved = approveDefinition(db, {
        goalId,
        version: version.data,
        actor: 'user',
        workflows: workflowContexts(db),
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      const status = (db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string })
        .status;
      return {
        version: approved.version,
        definitionHash: approved.definitionHash,
        approvalId: approved.approvalId,
        warnings: approved.warnings.map((warning) => ({
          severity: warning.severity,
          path: warning.path,
          code: warning.code,
          message: warning.message,
        })),
        milestones: approved.milestones,
        goalStatus: status,
      };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.post('/api/goals/:goalId/definitions/:version/reject', async (request, reply) => {
    const version = versionParam.safeParse((request.params as { version: string }).version);
    if (!version.success)
      return send(reply, 400, { error: 'The version must be a positive integer.', code: 'invalid_request' });
    const body = parse(empty, request.body, reply);
    if (!body.ok) return reply;
    try {
      const goalId = goalIdOf(request);
      const rejected = rejectDefinition(db, { goalId, version: version.data, actor: 'user' });
      const status = (db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string })
        .status;
      return { version: rejected.version, goalStatus: status };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  // --- Explicit user controls ----------------------------------------------------------------------------------------

  const supervisorRefusal = (code: string): { status: number; message: string } => {
    switch (code) {
      case 'goal_not_found':
        return { status: 404, message: 'The Goal does not exist.' };
      case 'gate_pending':
        return { status: 409, message: 'The Goal waits for a first-use route approval.' };
      case 'route_unavailable':
        return { status: 409, message: 'No usable route is available for this Goal right now.' };
      default:
        return { status: 409, message: `The Goal cannot proceed: ${code}.` };
    }
  };

  const supervised = async (
    reply: FastifyReply,
    goalId: string,
    run: (supervisor: GoalSupervisor) => ReturnType<GoalSupervisor['startGoal']>,
  ) => {
    if (!deps.supervisor)
      return send(reply, 503, {
        error: 'The Goal supervisor is not running.',
        code: 'goal_supervisor_unavailable',
      });
    const result = await run(deps.supervisor);
    if (result.ok) {
      const status = (db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string })
        .status;
      return { ok: true, goalStatus: status };
    }
    const refusal = supervisorRefusal(result.code);
    return send(reply, refusal.status, {
      error: refusal.message,
      code: result.code,
      ok: false,
      ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    });
  };

  app.post('/api/goals/:goalId/start', async (request, reply) => {
    const body = parse(empty, request.body, reply);
    if (!body.ok) return reply;
    const goalId = goalIdOf(request);
    return supervised(reply, goalId, (supervisor) => supervisor.startGoal(goalId));
  });

  app.post('/api/goals/:goalId/resume', async (request, reply) => {
    const body = parse(resumeBody, request.body, reply);
    if (!body.ok) return reply;
    const goalId = goalIdOf(request);
    return supervised(reply, goalId, (supervisor) =>
      supervisor.resumeGoal(goalId, { actor: 'user', reasonCode: body.data.reason }),
    );
  });

  app.post('/api/goals/:goalId/pause', async (request, reply) => {
    const body = parse(empty, request.body, reply);
    if (!body.ok) return reply;
    try {
      return pauseGoal(db, goalIdOf(request));
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.post('/api/goals/:goalId/abandon', async (request, reply) => {
    const body = parse(empty, request.body, reply);
    if (!body.ok) return reply;
    try {
      return abandonGoal(db, goalIdOf(request));
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.post('/api/goals/:goalId/findings/:findingId/decision', async (request, reply) => {
    const body = parse(findingDecisionBody, request.body, reply);
    if (!body.ok) return reply;
    try {
      const params = request.params as { goalId: string; findingId: string };
      const decided = decideFindingAsUser(db, {
        goalId: params.goalId,
        findingId: params.findingId,
        decision: body.data.decision,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      return {
        findingId: decided.finding.id,
        status: decided.finding.status,
        decisionApprovalId: decided.approvalId,
      };
    } catch (error) {
      return domainError(error, reply);
    }
  });

  app.post('/api/goal-approvals/:approvalId/decision', async (request, reply) => {
    const body = parse(goalApprovalDecisionBody, request.body, reply);
    if (!body.ok) return reply;
    try {
      // The decider is fixed to the user: this route is the explicit user action. It never starts or resumes the Goal.
      const decided = decideGoalApprovalAsUser(db, {
        approvalId: (request.params as { approvalId: string }).approvalId,
        decision: body.data.decision,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      return { approvalId: decided.approval.id, status: decided.approval.status, changed: decided.changed };
    } catch (error) {
      return domainError(error, reply);
    }
  });
}
