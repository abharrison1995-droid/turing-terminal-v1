import type { GoalExternalIntegrationStoredStatus } from '../../shared/goalApi.js';
import type { GoalApproval } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { decideGoalApprovalAsUser } from './goalCommands.js';
import { canonicalJson } from './definitionHash.js';
import {
  buildExternalIntegrationObservation,
  createExternalIntegrationApprovalDetail,
  ExternalIntegrationError,
  persistExternalIntegrationAttestation,
  type ExternalIntegrationObservationV1,
} from './externalIntegration.js';
import { parseExternalIntegrationApprovalDetail } from './externalIntegrationApproval.js';
import { getGoalApproval, requestGoalApproval } from './approvals.js';

const HISTORY_LIMIT = 20;
const MAX_ACTIVE_VERIFICATIONS_PER_GOAL = 2;
const activeVerifications = new Map<string, number>();

/** Keep repeated user/API verification from spawning an unbounded number of Git subprocesses for one Goal. */
export async function withExternalIntegrationVerificationSlot<T>(
  goalId: string,
  run: () => Promise<T>,
): Promise<T> {
  const active = activeVerifications.get(goalId) ?? 0;
  if (active >= MAX_ACTIVE_VERIFICATIONS_PER_GOAL)
    throw new ExternalIntegrationError(
      'verification_busy',
      'Two Git verification requests are already active for this Goal. Try again shortly.',
    );
  activeVerifications.set(goalId, active + 1);
  try {
    return await run();
  } finally {
    const remaining = (activeVerifications.get(goalId) ?? 1) - 1;
    if (remaining === 0) activeVerifications.delete(goalId);
    else activeVerifications.set(goalId, remaining);
  }
}

/** Stored metadata only. It does not validate records, scan Git, request approvals, or claim success. */
export function getExternalIntegrationStoredStatus(
  db: Db,
  goalId: string,
  handoffId: string,
): GoalExternalIntegrationStoredStatus {
  const handoff = db
    .prepare('SELECT 1 FROM goal_result_handoffs WHERE goal_id = ? AND id = ?')
    .get(goalId, handoffId);
  if (!handoff)
    throw new ExternalIntegrationError('handoff_not_found', 'The handoff does not exist for this Goal.');

  const attestationRows = db
    .prepare(
      `SELECT id, action_digest, record_digest, approval_id, observed_at, decided_at
       FROM goal_external_integration_attestations
       WHERE goal_id = ? AND handoff_id = ?
       ORDER BY decided_at DESC, id DESC LIMIT ?`,
    )
    .all(goalId, handoffId, HISTORY_LIMIT + 1) as Array<{
    id: string;
    action_digest: string;
    record_digest: string;
    approval_id: string;
    observed_at: string;
    decided_at: string;
  }>;
  const attestationsHaveMore = attestationRows.length > HISTORY_LIMIT;
  const attestations = attestationRows.slice(0, HISTORY_LIMIT).map((row) => ({
    attestationId: row.id,
    actionDigest: row.action_digest,
    recordDigest: row.record_digest,
    approvalId: row.approval_id,
    observedAt: row.observed_at,
    decidedAt: row.decided_at,
  }));

  const approvalRows = db
    .prepare(
      `SELECT a.id, a.status, a.decided_by, a.created_at, a.responded_at,
              a.external_integration_action_digest, e.id AS attestation_id
       FROM goal_approvals a
       LEFT JOIN goal_external_integration_attestations e
         ON e.goal_id = a.goal_id AND e.handoff_id = ?
        AND e.action_digest = a.external_integration_action_digest
       WHERE a.goal_id = ? AND a.external_integration_action_digest IS NOT NULL
         AND json_valid(a.detail_json)
         AND json_extract(a.detail_json, '$.action') = 'confirm_external_integration'
         AND json_extract(a.detail_json, '$.handoffId') = ?
       ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    )
    .all(handoffId, goalId, handoffId, HISTORY_LIMIT + 1) as Array<{
    id: string;
    status: GoalApproval['status'];
    decided_by: GoalApproval['decidedBy'];
    created_at: string;
    responded_at: string | null;
    external_integration_action_digest: string;
    attestation_id: string | null;
  }>;
  const approvalsHaveMore = approvalRows.length > HISTORY_LIMIT;
  const approvals = approvalRows.slice(0, HISTORY_LIMIT).flatMap((row) => {
    const approval = getGoalApproval(db, row.id);
    const detail = approval && parseExternalIntegrationApprovalDetail(approval.detail);
    if (
      !approval ||
      !detail ||
      approval.goalId !== goalId ||
      approval.externalIntegrationActionDigest !== row.external_integration_action_digest ||
      detail.goalId !== goalId ||
      detail.handoffId !== handoffId ||
      detail.actionDigest !== row.external_integration_action_digest
    )
      return [];
    return [
      {
        approvalId: row.id,
        actionDigest: row.external_integration_action_digest,
        status: row.status,
        decidedBy: row.decided_by,
        createdAt: row.created_at,
        respondedAt: row.responded_at,
        attestationId: row.attestation_id,
      },
    ];
  });

  return {
    goalId,
    handoffId,
    hasAttestation: attestations.length > 0 || attestationsHaveMore,
    attestations,
    approvals,
    limit: HISTORY_LIMIT,
    attestationsHaveMore,
    approvalsHaveMore,
  };
}

export async function confirmExternalIntegration(
  db: Db,
  input: { goalId: string; handoffId: string; reviewedActionDigest: string },
): Promise<{
  attestationId: string;
  approvalId: string;
  actionDigest: string;
  reusedAttestation: boolean;
  reusedApproval: boolean;
}> {
  const observation = await buildExternalIntegrationObservation(db, input.goalId, input.handoffId);
  if (observation.actionDigest !== input.reviewedActionDigest)
    throw new ExternalIntegrationError(
      'reviewed_observation_changed',
      'The Git evidence changed after review. Nothing was approved; verify and review it again.',
    );

  const detail = createExternalIntegrationApprovalDetail(observation);
  let approval = findMatchingApproval(db, input.goalId, observation, detail);
  let reusedApproval = approval !== undefined;

  if (!approval) {
    try {
      approval = requestGoalApproval(db, {
        goalId: input.goalId,
        gate: 'final_apply',
        risk: 'high',
        reason: 'Confirm the exact reviewed external Git history observation.',
        requestedBy: 'user',
        detail,
        externalIntegrationActionDigest: observation.actionDigest,
      });
    } catch {
      // Migration 026 permits exactly one approval per Goal/action digest. A concurrent or recovered request
      // must reuse that exact row; it must never create a second decision for the same evidence.
      approval = findMatchingApproval(db, input.goalId, observation, detail);
      if (!approval)
        throw new ExternalIntegrationError(
          'approval_persistence_failed',
          'The exact user approval could not be recorded safely.',
        );
      reusedApproval = true;
    }
  }

  if (approval.status === 'denied')
    throw new ExternalIntegrationError(
      'approval_denied',
      'This exact Git observation was previously denied and cannot be approved again.',
    );
  if (approval.status === 'pending') {
    await decideGoalApprovalAsUser(db, { approvalId: approval.id, decision: 'approved' });
    approval = getGoalApproval(db, approval.id);
  }
  if (
    !approval ||
    approval.status !== 'approved' ||
    approval.decidedBy !== 'user' ||
    !approval.respondedAt ||
    !approvalExactlyMatches(approval, input.goalId, observation, detail)
  )
    throw new ExternalIntegrationError(
      'approval_mismatch',
      'The stored approval does not authorize this exact user-confirmed observation.',
    );

  const persisted = await persistExternalIntegrationAttestation(db, {
    goalId: input.goalId,
    handoffId: input.handoffId,
    observation,
    approvalId: approval.id,
  });
  return {
    attestationId: persisted.record.attestationId,
    approvalId: approval.id,
    actionDigest: observation.actionDigest,
    reusedAttestation: persisted.reused,
    reusedApproval,
  };
}

function findMatchingApproval(
  db: Db,
  goalId: string,
  observation: ExternalIntegrationObservationV1,
  expectedDetail: ReturnType<typeof createExternalIntegrationApprovalDetail>,
): GoalApproval | undefined {
  const row = db
    .prepare(
      `SELECT id FROM goal_approvals
       WHERE goal_id = ? AND external_integration_action_digest = ?`,
    )
    .get(goalId, observation.actionDigest) as { id: string } | undefined;
  if (!row) return undefined;
  const approval = getGoalApproval(db, row.id);
  if (!approvalExactlyMatches(approval, goalId, observation, expectedDetail))
    throw new ExternalIntegrationError(
      'approval_conflict',
      'A conflicting approval already exists for this exact Git observation.',
    );
  return approval;
}

function approvalExactlyMatches(
  approval: GoalApproval | undefined,
  goalId: string,
  observation: ExternalIntegrationObservationV1,
  expectedDetail: ReturnType<typeof createExternalIntegrationApprovalDetail>,
): approval is GoalApproval {
  const detail = approval && parseExternalIntegrationApprovalDetail(approval.detail);
  return Boolean(
    approval &&
    detail &&
    approval.goalId === goalId &&
    approval.gate === 'final_apply' &&
    approval.risk === 'high' &&
    approval.requestedBy === 'user' &&
    approval.externalIntegrationActionDigest === observation.actionDigest &&
    approval.intentDigest === undefined &&
    detail.action === 'confirm_external_integration' &&
    detail.actionDigest === observation.actionDigest &&
    canonicalJson(detail) === canonicalJson(expectedDetail),
  );
}
