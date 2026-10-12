import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GoalDefinition } from '../../shared/goals.js';
import type {
  GoalApiError,
  GoalAttestationCorrectionDecisionRecorded,
  GoalCompletionStanding,
  GoalExternalCompletionCompleted,
  GoalExternalCompletionDecisionRecorded,
  GoalExternalCompletionPreflightResponse,
  GoalExternalCompletionStatus,
  GoalFinalApplyPreflightView,
  GoalManualHandoffListResponse,
  GoalManualHandoffPrepared,
  GoalManualHandoffProjection,
} from '../../shared/goalApi.js';
import { GOAL_RESUME_REASONS } from '../../shared/goalApi.js';
import type { Db } from '../db.js';
import { GoalGitError, preflightFinalApply } from '../goalGit.js';
import { queryUsageAnalytics, type UsageFilter } from '../usageAnalytics.js';
import { GoalApprovalError } from './approvals.js';
import { readGoalCompletionStanding } from './completionStanding.js';
import {
  AttestationCorrectionError,
  getAttestationCorrectionChainPosition,
  getAttestationCorrectionStanding,
  listAttestationCorrectionHistory,
  type AttestationCorrectionErrorCode,
} from './attestationCorrection.js';
import { decideAttestationCorrectionAsUser } from './attestationCorrectionDecision.js';
import {
  ATTESTATION_CORRECTION_KINDS,
  ATTESTATION_CORRECTION_REASON_CODES,
} from './attestationCorrectionDetail.js';
import {
  listPendingAttestationCorrectionRequests,
  requestAttestationCorrectionAsUser,
} from './attestationCorrectionRequest.js';
import { FinalApplyAuthorityError } from './finalApplyAuthority.js';
import {
  buildExternalIntegrationObservation,
  ExternalIntegrationError,
  getExternalIntegrationProjection,
} from './externalIntegration.js';
import {
  confirmExternalIntegration,
  getExternalIntegrationStoredStatus,
  withExternalIntegrationVerificationSlot,
} from './externalIntegrationWorkflow.js';
import {
  GoalDefinitionError,
  approveDefinition,
  beginAmendment,
  createGoalDraft,
  editProposedDefinition,
  parseDefinitionPrecondition,
  rejectDefinition,
} from './definitions.js';
import { findDecisionByActionDigest, readExternalCompletionStatus } from './externalCompletionApi.js';
import {
  completeGoalFromExternalDecision,
  ExternalCompletionError,
  type ExternalCompletionErrorCode,
} from './externalCompletion.js';
import {
  ExternalCompletionDecisionError,
  recordExternalCompletionDecision,
  type ExternalCompletionDecisionErrorCode,
} from './externalCompletionDecision.js';
import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';
import { GoalFindingError } from './findings.js';
import { getManualHandoffProjection, ManualHandoffError, prepareManualHandoff } from './manualHandoff.js';
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
  if (error instanceof ManualHandoffError) {
    const status =
      error.code === 'goal_not_found'
        ? 404
        : error.code === 'repository_unavailable' || error.code === 'git_unavailable'
          ? 503
          : error.code === 'unsafe_changes'
            ? 422
            : 409;
    return send(reply, status, { error: error.message, code: error.code });
  }
  if (error instanceof FinalApplyAuthorityError)
    return send(reply, error.code === 'approval_not_found' ? 404 : 409, {
      error: error.message,
      code: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    });
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
        : error.code === 'definition_precondition_required'
          ? 428
          : error.code === 'definition_precondition_failed'
            ? 412
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

/** External Git and persistence errors use bounded service messages; unknown failures never expose raw stderr or SQL. */
function externalIntegrationError(error: unknown, reply: FastifyReply) {
  if (error instanceof ExternalIntegrationError) {
    const status =
      error.code === 'handoff_not_found' || error.code === 'goal_not_found'
        ? 404
        : error.code === 'reviewed_observation_changed'
          ? 412
          : error.code === 'verification_busy'
            ? 429
            : error.code === 'repository_unavailable' ||
                error.code === 'git_unavailable' ||
                error.code === 'git_timeout' ||
                error.code === 'persistence_failed' ||
                error.code === 'approval_persistence_failed'
              ? 503
              : error.code === 'attestation_invalid'
                ? 422
                : 409;
    return send(reply, status, { error: error.message, code: error.code });
  }
  if (error instanceof GoalApprovalError)
    return send(reply, error.code === 'goal_not_found' ? 404 : 409, {
      error: error.message,
      code: error.code,
    });
  return send(reply, 503, {
    error: 'External integration could not be verified or recorded safely.',
    code: 'external_integration_unavailable',
  });
}

/**
 * Reads the single quoted lowercase SHA-256 If-Match value that binds a write to one reviewed digest. A missing header
 * sends 428 and a malformed one sends 400; both return undefined so the caller can stop. Duplicate, weak (`W/`) and
 * unquoted values fail the same regular expression.
 */
function readQuotedDigestPrecondition(
  request: FastifyRequest,
  reply: FastifyReply,
  requiredMessage: string,
): string | undefined {
  const ifMatch = request.headers['if-match'];
  if (ifMatch === undefined) {
    send(reply, 428, { error: requiredMessage, code: 'reviewed_action_precondition_required' });
    return undefined;
  }
  const digest = typeof ifMatch === 'string' ? /^"([0-9a-f]{64})"$/.exec(ifMatch)?.[1] : undefined;
  if (!digest) {
    send(reply, 400, {
      error: 'The reviewed action digest must be one quoted SHA-256 value.',
      code: 'reviewed_action_precondition_invalid',
    });
    return undefined;
  }
  return digest;
}

type ExternalCompletionCode = ExternalCompletionErrorCode | ExternalCompletionDecisionErrorCode;

/**
 * The HTTP status of every code of both completion services. The Record type makes a new service code a compile error
 * until it is given a status here. `preflight_refused` is 409 unless its detail is in PREFLIGHT_REFUSED_STATUS.
 */
const EXTERNAL_COMPLETION_STATUS: Record<ExternalCompletionCode, number> = {
  decision_input_invalid: 400,
  completion_input_invalid: 400,
  acknowledgement_required: 400,
  goal_not_found: 404,
  decision_not_found: 404,
  reviewed_preflight_changed: 412,
  decision_corrupt: 422,
  completion_corrupt: 422,
  proof_invalid: 422,
  completion_proof_required: 422,
  completion_busy: 429,
  decision_persistence_failed: 503,
  completion_persistence_failed: 503,
  completion_read_failed: 503,
  completion_internal_state: 503,
  manual_reconciliation_required: 409,
  preflight_refused: 409,
  authority_changed_during_decision: 409,
  authority_changed_during_completion: 409,
  decision_conflict: 409,
  competing_decision: 409,
  completion_conflict: 409,
  completion_already_recorded: 409,
  goal_not_running: 409,
  goal_work_in_flight: 409,
  destination_changed: 409,
  decision_action_mismatch: 409,
  proof_action_mismatch: 409,
};

const PREFLIGHT_REFUSED_STATUS: ReadonlyMap<string, number> = new Map([
  ['goal_not_found', 404],
  ['attestation_not_found', 404],
  ['verification_busy', 429],
  ['git_unavailable', 503],
  ['preflight_unavailable', 503],
  ['attestation_invalid', 422],
]);

const COMPLETION_DETAIL = /^[a-z0-9_]{1,100}$/;

/** The HTTP status for a completion service code, with the detail that refines `preflight_refused`. */
export function externalCompletionStatus(code: ExternalCompletionCode, detail: string | null): number {
  if (code === 'preflight_refused' && detail !== null) return PREFLIGHT_REFUSED_STATUS.get(detail) ?? 409;
  return EXTERNAL_COMPLETION_STATUS[code];
}

/**
 * Maps a completion service error to its status and a bounded body. Any other failure is a generic 503 with no stack, no
 * SQL and no service message, so an unexpected fault never reaches the client.
 */
export function externalCompletionError(error: unknown, reply: FastifyReply) {
  if (error instanceof ExternalCompletionDecisionError || error instanceof ExternalCompletionError) {
    const detail = error.detail !== null && COMPLETION_DETAIL.test(error.detail) ? error.detail : null;
    return send(reply, externalCompletionStatus(error.code, detail), {
      error: error.message,
      code: error.code,
      ...(detail !== null ? { detail } : {}),
    });
  }
  return send(reply, 503, {
    error: 'External completion could not be verified or recorded safely.',
    code: 'external_completion_unavailable',
  });
}

/**
 * The HTTP status of every code of the correction service. The Record type makes a new correction error code a compile
 * error until it is given a status here.
 */
const ATTESTATION_CORRECTION_STATUS: Record<AttestationCorrectionErrorCode, number> = {
  goal_not_found: 404,
  attestation_not_found: 404,
  attestation_invalid: 422,
  correction_chain_invalid: 422,
  replacement_invalid: 422,
  explanation_invalid: 400,
  approval_required: 409,
  approval_mismatch: 409,
  correction_action_mismatch: 409,
  correction_chain_changed: 409,
  correction_request_pending: 409,
  correction_request_already_decided: 409,
  correction_transition_not_allowed: 409,
  idempotency_conflict: 409,
  persistence_failed: 503,
};

/**
 * Maps a correction service failure to its status and a bounded body. A Goal-approval refusal (for example
 * `approval_not_found`, `already_decided` or `goal_terminal`) keeps its generic mapping. Any other failure is a generic
 * 503 with no stack and no service message; `unavailable` is the one sentence that 503 carries.
 */
function attestationCorrectionFailure(error: unknown, reply: FastifyReply, unavailable: string) {
  if (error instanceof AttestationCorrectionError)
    return send(reply, ATTESTATION_CORRECTION_STATUS[error.code], { error: error.message, code: error.code });
  if (error instanceof GoalApprovalError) return domainError(error, reply);
  return send(reply, 503, {
    error: unavailable,
    code: 'attestation_correction_unavailable',
  });
}

function attestationCorrectionDecisionError(error: unknown, reply: FastifyReply) {
  return attestationCorrectionFailure(
    error,
    reply,
    'The attestation correction could not be recorded safely.',
  );
}

function attestationCorrectionRequestError(error: unknown, reply: FastifyReply) {
  return attestationCorrectionFailure(error, reply, 'The correction request could not be recorded safely.');
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
const goalIdParams = z.strictObject({ goalId: z.string().uuid() });
const handoffParams = z.strictObject({ goalId: z.string().uuid(), handoffId: z.string().uuid() });
const externalAttestationParams = z.strictObject({
  goalId: z.string().uuid(),
  handoffId: z.string().uuid(),
  attestationId: z.string().uuid(),
});
const externalIntegrationDecisionBody = z.strictObject({
  decision: z.literal('confirm_external_integration'),
});
const completionPreflightQuery = z.strictObject({ attestationId: z.string().uuid() });
const completionDecisionBody = z.strictObject({
  decision: z.literal('record_completion_decision'),
  attestationId: z.string().uuid(),
  acknowledgeContentNotProven: z.boolean(),
  note: z.string().min(1).max(500).optional(),
});
const completionBody = z.strictObject({
  decision: z.literal('complete_goal'),
  acknowledgeContentNotProven: z.boolean(),
});
const completionStatusQuery = z.strictObject({
  actionDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const attestationCorrectionDecisionParams = z.strictObject({
  goalId: z.string().uuid(),
  approvalId: z.string().uuid(),
});
// The client names the decision and, for an approval, the one attested target and kind it reviewed. It never sends an
// actor, a digest of its own, a status or a Goal transition: the digest comes from If-Match and the actor is fixed.
const attestationCorrectionDecisionBody = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('approved'),
    attestationId: z.string().uuid(),
    correctionKind: z.enum(ATTESTATION_CORRECTION_KINDS),
    explanation: z.string().max(10_000).nullable(),
  }),
  z.strictObject({ decision: z.literal('denied'), note }),
]);
// The reviewed chain position is not in this body; it arrives only as If-Match. The replacement is named here, because a
// supersession's replacement is part of the reviewed action. No actor, digest, status or approval identity is accepted.
const attestationCorrectionRequestBody = z
  .strictObject({
    correctionKind: z.enum(ATTESTATION_CORRECTION_KINDS),
    reasonCode: z.enum(ATTESTATION_CORRECTION_REASON_CODES),
    explanation: z.string().max(10_000).nullable(),
    replacementAttestationId: z.string().uuid().nullable(),
  })
  .superRefine((body, context) => {
    if ((body.correctionKind === 'supersede') !== (body.replacementAttestationId !== null))
      context.addIssue({
        code: 'custom',
        path: ['replacementAttestationId'],
        message: 'Only a supersession names a replacement attestation, and it must name one.',
      });
  });
const handoffListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

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
      const goalId = goalIdOf(request);
      const detail = await getGoalDetail(db, goalId, workflowContexts(db));
      // Composed here rather than in readModel.ts, which would close an import cycle through the completion standing's
      // dependencies. A missing Goal throws in getGoalDetail first, so the reader is never called for it.
      const completionStanding: GoalCompletionStanding = readGoalCompletionStanding(db, goalId);
      return { goal: { ...detail, completionStanding } };
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

  // --- Immutable manual-integration handoffs ----------------------------------------------------------------------

  app.get('/api/goals/:goalId/handoffs', async (request, reply) => {
    const params = goalIdParams.safeParse(request.params);
    const query = handoffListQuery.safeParse(request.query);
    if (!params.success || !query.success)
      return send(reply, 400, { error: 'Invalid Goal handoff list request.', code: 'invalid_request' });
    const goalId = params.data.goalId;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    const limit = query.data.limit ?? 25;
    const offset = query.data.offset ?? 0;
    // Metadata only: do not load historical payloads or run a Git scan for each row in the list.
    const rows = db
      .prepare(
        `SELECT id, created_at, definition_version, source_commit, handoff_digest
         FROM goal_result_handoffs WHERE goal_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(goalId, limit + 1, offset) as Array<{
      id: string;
      created_at: string;
      definition_version: number;
      source_commit: string;
      handoff_digest: string;
    }>;
    const hasMore = rows.length > limit;
    const response: GoalManualHandoffListResponse = {
      handoffs: rows.slice(0, limit).map((row) => ({
        handoffId: row.id,
        createdAt: row.created_at,
        definitionVersion: row.definition_version,
        sourceCommit: row.source_commit,
        handoffDigest: row.handoff_digest,
      })),
      limit,
      nextOffset: hasMore ? offset + limit : null,
    };
    return response;
  });

  app.get('/api/goals/:goalId/handoffs/:handoffId', async (request, reply) => {
    const params = handoffParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal handoff identity.', code: 'invalid_request' });
    const { goalId, handoffId } = params.data;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    // Keep unknown and cross-Goal IDs indistinguishable. The projection service receives only a scoped identity.
    if (!db.prepare('SELECT 1 FROM goal_result_handoffs WHERE goal_id = ? AND id = ?').get(goalId, handoffId))
      return send(reply, 404, {
        error: 'The handoff does not exist for this Goal.',
        code: 'handoff_not_found',
      });
    try {
      const projection: GoalManualHandoffProjection = await getManualHandoffProjection(db, goalId, handoffId);
      return { projection };
    } catch {
      return send(reply, 503, {
        error: 'The handoff could not be validated safely. Refresh and try again.',
        code: 'handoff_validation_unavailable',
      });
    }
  });

  app.post('/api/goals/:goalId/handoffs', async (request, reply) => {
    const params = goalIdParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal identity.', code: 'invalid_request' });
    // Only an empty object (or no body) is accepted. In particular, no caller-supplied refs, commits,
    // approvals, evidence, reviews, project identity, or authority metadata can reach the service.
    const body = empty.safeParse(request.body === undefined ? {} : request.body);
    if (!body.success)
      return send(reply, 400, {
        error: 'Handoff preparation accepts an empty object only.',
        code: 'invalid_request',
      });
    try {
      const prepared = await prepareManualHandoff(db, params.data.goalId);
      const response: GoalManualHandoffPrepared = {
        handoffId: prepared.record.handoffId,
        handoffDigest: prepared.record.handoffDigest,
        reused: prepared.reused,
      };
      return reply.code(prepared.reused ? 200 : 201).send(response);
    } catch (error) {
      if (error instanceof ManualHandoffError) return domainError(error, reply);
      return send(reply, 503, {
        error: 'The handoff could not be prepared safely. Refresh the Goal before trying again.',
        code: 'handoff_preparation_unavailable',
      });
    }
  });

  // --- User-confirmed external integration evidence (read-only Git; no Goal completion) ----------------------------

  app.get('/api/goals/:goalId/handoffs/:handoffId/external-integration', async (request, reply) => {
    const params = handoffParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal handoff identity.', code: 'invalid_request' });
    const { goalId, handoffId } = params.data;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    try {
      return getExternalIntegrationStoredStatus(db, goalId, handoffId);
    } catch (error) {
      return externalIntegrationError(error, reply);
    }
  });

  app.get(
    '/api/goals/:goalId/handoffs/:handoffId/external-integration/verification',
    async (request, reply) => {
      const params = handoffParams.safeParse(request.params);
      if (!params.success)
        return send(reply, 400, { error: 'Invalid Goal handoff identity.', code: 'invalid_request' });
      const { goalId, handoffId } = params.data;
      if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
        return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
      if (
        !db.prepare('SELECT 1 FROM goal_result_handoffs WHERE goal_id = ? AND id = ?').get(goalId, handoffId)
      )
        return send(reply, 404, {
          error: 'The handoff does not exist for this Goal.',
          code: 'handoff_not_found',
        });
      try {
        const observation = await withExternalIntegrationVerificationSlot(goalId, () =>
          buildExternalIntegrationObservation(db, goalId, handoffId),
        );
        return {
          verification: {
            state: 'verified' as const,
            observation,
            proofLimitations: {
              sourceHistory: 'observed' as const,
              contentPreservation: 'not_proven' as const,
              goalCompletion: 'not_completed_by_attestation' as const,
            },
            reason: null,
          },
        };
      } catch (error) {
        if (error instanceof ExternalIntegrationError && error.code !== 'verification_busy') {
          const notIntegrated = new Set(['base_not_ancestor', 'source_not_ancestor']);
          const unavailable = new Set(['repository_unavailable', 'git_unavailable', 'git_timeout']);
          const stale = new Set([
            'source_changed',
            'destination_ref_missing',
            'source_ref_missing',
            'repository_identity_changed',
            'handoff_git_identity_invalid',
            'observation_changed',
          ]);
          const state = notIntegrated.has(error.code)
            ? 'not_integrated'
            : unavailable.has(error.code)
              ? 'unavailable'
              : stale.has(error.code)
                ? 'stale'
                : 'invalid';
          return {
            verification: {
              state,
              observation: null,
              proofLimitations: {
                contentPreservation: 'not_proven' as const,
                goalCompletion: 'not_completed_by_attestation' as const,
              },
              reason: { code: error.code, message: error.message },
            },
          };
        }
        return externalIntegrationError(error, reply);
      }
    },
  );

  app.get(
    '/api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId',
    async (request, reply) => {
      const params = externalAttestationParams.safeParse(request.params);
      if (!params.success)
        return send(reply, 400, { error: 'Invalid Goal attestation identity.', code: 'invalid_request' });
      const { goalId, handoffId, attestationId } = params.data;
      if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
        return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
      const scoped = db
        .prepare(
          `SELECT 1 FROM goal_external_integration_attestations
           WHERE goal_id = ? AND handoff_id = ? AND id = ?`,
        )
        .get(goalId, handoffId, attestationId);
      if (!scoped)
        return send(reply, 404, {
          error: 'The attestation does not exist for this Goal and handoff.',
          code: 'attestation_not_found',
        });
      try {
        const projection = await withExternalIntegrationVerificationSlot(goalId, () =>
          getExternalIntegrationProjection(db, goalId, attestationId),
        );
        return { projection };
      } catch (error) {
        return externalIntegrationError(error, reply);
      }
    },
  );

  // Read-only correction history and standing. No write, no Git scan, and no completion effect.
  app.get(
    '/api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections',
    async (request, reply) => {
      const params = externalAttestationParams.safeParse(request.params);
      if (!params.success)
        return send(reply, 400, { error: 'Invalid Goal attestation identity.', code: 'invalid_request' });
      const { goalId, handoffId, attestationId } = params.data;
      if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
        return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
      const scoped = db
        .prepare(
          `SELECT 1 FROM goal_external_integration_attestations
           WHERE goal_id = ? AND handoff_id = ? AND id = ?`,
        )
        .get(goalId, handoffId, attestationId);
      if (!scoped)
        return send(reply, 404, {
          error: 'The attestation does not exist for this Goal and handoff.',
          code: 'attestation_not_found',
        });
      try {
        const standing = getAttestationCorrectionStanding(db, goalId, attestationId);
        const corrections = listAttestationCorrectionHistory(db, goalId, attestationId);
        // The position is the If-Match value a request must send; `pending` lists requests awaiting the user's decision.
        const chainPosition = getAttestationCorrectionChainPosition(db, goalId, attestationId);
        const { pending, pendingUnreadableCount } = listPendingAttestationCorrectionRequests(
          db,
          goalId,
          attestationId,
        );
        return {
          goalId,
          handoffId,
          attestationId,
          standing,
          corrections,
          chainPosition,
          pending,
          pendingUnreadableCount,
        };
      } catch (error) {
        if (error instanceof AttestationCorrectionError)
          return send(reply, 409, {
            error: 'The correction history cannot be verified.',
            code: error.code,
          });
        throw error;
      }
    },
  );

  // Correction request (D.4D). Creates at most one pending high-risk approval for one reviewed action. It decides nothing,
  // changes no Goal, completion or Git state, and the reviewed chain position comes from If-Match only.
  app.post(
    '/api/goals/:goalId/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections',
    async (request, reply) => {
      const params = externalAttestationParams.safeParse(request.params);
      if (!params.success)
        return send(reply, 400, { error: 'Invalid Goal attestation identity.', code: 'invalid_request' });
      const body = parse(attestationCorrectionRequestBody, request.body, reply);
      if (!body.ok) return reply;
      const { goalId, handoffId, attestationId } = params.data;
      if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
        return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
      const scoped = db
        .prepare(
          `SELECT 1 FROM goal_external_integration_attestations
           WHERE goal_id = ? AND handoff_id = ? AND id = ?`,
        )
        .get(goalId, handoffId, attestationId);
      if (!scoped)
        return send(reply, 404, {
          error: 'The attestation does not exist for this Goal and handoff.',
          code: 'attestation_not_found',
        });
      const position = readQuotedDigestPrecondition(
        request,
        reply,
        'Review the current correction history before requesting a correction.',
      );
      if (position === undefined) return reply;
      try {
        const result = requestAttestationCorrectionAsUser(db, {
          goalId,
          handoffId,
          attestationId,
          expectedChainPosition: position,
          ...body.data,
        });
        return reply.code(result.reused ? 200 : 201).send(result);
      } catch (error) {
        return attestationCorrectionRequestError(error, reply);
      }
    },
  );

  app.post('/api/goals/:goalId/handoffs/:handoffId/external-integration/attest', async (request, reply) => {
    const params = handoffParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal handoff identity.', code: 'invalid_request' });
    const parsedBody = externalIntegrationDecisionBody.safeParse(request.body);
    if (!parsedBody.success)
      return send(reply, 400, {
        error: 'Confirm only the reviewed external integration decision.',
        code: 'invalid_request',
      });
    const { goalId, handoffId } = params.data;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    if (!db.prepare('SELECT 1 FROM goal_result_handoffs WHERE goal_id = ? AND id = ?').get(goalId, handoffId))
      return send(reply, 404, {
        error: 'The handoff does not exist for this Goal.',
        code: 'handoff_not_found',
      });

    const digest = readQuotedDigestPrecondition(
      request,
      reply,
      'Review the current Git observation before confirming it.',
    );
    if (digest === undefined) return reply;

    try {
      const result = await withExternalIntegrationVerificationSlot(goalId, () =>
        confirmExternalIntegration(db, { goalId, handoffId, reviewedActionDigest: digest }),
      );
      return reply.code(result.reusedAttestation ? 200 : 201).send(result);
    } catch (error) {
      return externalIntegrationError(error, reply);
    }
  });

  // --- Version-2 external completion ----------------------------------------------------------------------------------

  // The user's decision for one reviewed preflight. It records one approved approval and completes nothing.
  app.post('/api/goals/:goalId/completion-decision', async (request, reply) => {
    const params = goalIdParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal identity.', code: 'invalid_request' });
    const body = parse(completionDecisionBody, request.body, reply);
    if (!body.ok) return reply;
    const goalId = params.data.goalId;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    const digest = readQuotedDigestPrecondition(
      request,
      reply,
      'Review the current completion preflight before recording the decision.',
    );
    if (digest === undefined) return reply;
    try {
      const result = await recordExternalCompletionDecision(db, {
        goalId,
        attestationId: body.data.attestationId,
        reviewedPreflightDigest: digest,
        acknowledgeContentNotProven: body.data.acknowledgeContentNotProven,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      const response: GoalExternalCompletionDecisionRecorded = {
        approvalId: result.approvalId,
        actionDigest: result.actionDigest,
        preflightDigest: result.preflightDigest,
        status: result.status,
        reused: result.reused,
      };
      return reply.code(result.reused ? 200 : 201).send(response);
    } catch (error) {
      return externalCompletionError(error, reply);
    }
  });

  // The explicit "Complete Goal" step. The client names only the exact action digest of a recorded decision; the attestation
  // and the reviewed preflight digest are read from that stored decision, never from the request.
  app.post('/api/goals/:goalId/completion', async (request, reply) => {
    const params = goalIdParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal identity.', code: 'invalid_request' });
    const body = parse(completionBody, request.body, reply);
    if (!body.ok) return reply;
    const goalId = params.data.goalId;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    const digest = readQuotedDigestPrecondition(
      request,
      reply,
      'Record the completion decision and name its action digest before completing the Goal.',
    );
    if (digest === undefined) return reply;
    try {
      const decision = findDecisionByActionDigest(db, goalId, digest);
      const result = await completeGoalFromExternalDecision(db, {
        goalId,
        attestationId: decision.attestationId,
        reviewedPreflightDigest: decision.reviewedPreflightDigest,
        acknowledgeContentNotProven: body.data.acknowledgeContentNotProven,
      });
      const { completion } = result;
      const response: GoalExternalCompletionCompleted = {
        reused: result.reused,
        completion: {
          proofId: completion.proofId,
          proofDigest: completion.proofDigest,
          approvalId: completion.approvalId,
          actionDigest: completion.actionDigest,
          preflightDigest: completion.preflightDigest,
          observedAt: completion.observedAt,
          completedAt: completion.completedAt,
        },
        completionStanding: readGoalCompletionStanding(db, goalId),
      };
      return reply.code(result.reused ? 200 : 201).send(response);
    } catch (error) {
      return externalCompletionError(error, reply);
    }
  });

  // --- Read-only preflight and status (no decision, completion or proof is written) -----------------------------------

  app.get('/api/goals/:goalId/completion-preflight', async (request, reply) => {
    const params = goalIdParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal identity.', code: 'invalid_request' });
    const query = parse(completionPreflightQuery, request.query, reply);
    if (!query.ok) return reply;
    const goalId = params.data.goalId;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    try {
      // A refused report is returned as data with 200; only an unexpected failure reaches the catch.
      const report = await computeExternalCompletionPreflight(db, goalId, {
        attestationId: query.data.attestationId,
      });
      const response: GoalExternalCompletionPreflightResponse = { preflight: report };
      return reply.header('etag', `"${report.digest}"`).send(response);
    } catch (error) {
      return externalCompletionError(error, reply);
    }
  });

  app.get('/api/goals/:goalId/completion', async (request, reply) => {
    const params = goalIdParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal identity.', code: 'invalid_request' });
    const query = parse(completionStatusQuery, request.query, reply);
    if (!query.ok) return reply;
    const goalId = params.data.goalId;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    try {
      const status: GoalExternalCompletionStatus = readExternalCompletionStatus(
        db,
        goalId,
        query.data.actionDigest ?? null,
      );
      return status;
    } catch (error) {
      return externalCompletionError(error, reply);
    }
  });

  // --- Post-attestation correction decision (D.4C) --------------------------------------------------------------------

  // The user's decision on one reviewed correction approval. It decides only that approval and, for an approval, appends
  // exactly that correction. It never starts or resumes the Goal, never touches the completion or Git, and returns the
  // Goal's standing after the decision. The reviewed action digest comes from If-Match only.
  app.post('/api/goals/:goalId/attestation-corrections/:approvalId/decision', async (request, reply) => {
    const params = attestationCorrectionDecisionParams.safeParse(request.params);
    if (!params.success)
      return send(reply, 400, { error: 'Invalid Goal or approval identity.', code: 'invalid_request' });
    const body = parse(attestationCorrectionDecisionBody, request.body, reply);
    if (!body.ok) return reply;
    const { goalId, approvalId } = params.data;
    if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      return send(reply, 404, { error: 'The Goal does not exist.', code: 'goal_not_found' });
    const digest = readQuotedDigestPrecondition(
      request,
      reply,
      'Review the reviewed correction action before recording the decision.',
    );
    if (digest === undefined) return reply;
    try {
      const data = body.data;
      const result = decideAttestationCorrectionAsUser(
        db,
        data.decision === 'approved'
          ? {
              goalId,
              approvalId,
              reviewedActionDigest: digest,
              decision: 'approved',
              attestationId: data.attestationId,
              correctionKind: data.correctionKind,
              explanation: data.explanation,
            }
          : {
              goalId,
              approvalId,
              reviewedActionDigest: digest,
              decision: 'denied',
              ...(data.note ? { note: data.note } : {}),
            },
      );
      const response: GoalAttestationCorrectionDecisionRecorded = {
        approvalId: result.approvalId,
        status: result.status,
        actionDigest: result.actionDigest,
        correctionId: result.correctionId,
        sequence: result.sequence,
        reused: result.reused,
        completionStanding: readGoalCompletionStanding(db, goalId),
      };
      return reply.code(result.reused ? 200 : 201).send(response);
    } catch (error) {
      return attestationCorrectionDecisionError(error, reply);
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
        expectedDefinitionHash: parseDefinitionPrecondition(request.headers['if-match']),
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
        expectedDefinitionHash: parseDefinitionPrecondition(request.headers['if-match']),
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
      const rejected = rejectDefinition(db, {
        goalId,
        version: version.data,
        expectedDefinitionHash: parseDefinitionPrecondition(request.headers['if-match']),
        actor: 'user',
      });
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
      const decided = await decideGoalApprovalAsUser(db, {
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
