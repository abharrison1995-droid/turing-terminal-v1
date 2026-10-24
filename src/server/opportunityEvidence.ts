import { createHash } from 'node:crypto';
import type { GoalDefinition, GoalRole, RouteMember } from '../shared/goals.js';
import type { OpportunityApprovalDetail, OpportunityBinding } from '../shared/opportunityContract.js';
import { opportunityApprovalDetailSchema, opportunityBindingSchema } from '../shared/opportunityContract.js';
import type { Db } from './db.js';
import { canonicalJson, hashGoalDefinition } from './goals/definitionHash.js';
import { computeRouteIdentity, effectiveIdentityKind, type RouteSnapshot } from './goals/routeIdentity.js';
import { freshValidationSet, readRouteValidations } from './goals/routeValidation.js';
import { MODEL_OBSERVATION_RETENTION_DAYS, readVerifiedModelObservation } from './modelOpportunity.js';

export type OpportunityAdmissionPath = 'provider-advertised' | 'locally-discovered';

export class OpportunityEvidenceError extends Error {
  constructor(
    readonly code:
      | 'opportunity_binding_invalid'
      | 'opportunity_observation_missing'
      | 'opportunity_observation_invalid'
      | 'opportunity_observation_ineligible'
      | 'opportunity_identity_unavailable'
      | 'opportunity_validation_required'
      | 'opportunity_approval_invalid',
  ) {
    super(code);
    this.name = 'OpportunityEvidenceError';
  }
}

export function computeOpportunityDigest(input: {
  backendId: string;
  providerId: string;
  modelId: string;
  observationIds: readonly string[];
}): string {
  const observationIds = [...input.observationIds].sort();
  return createHash('sha256')
    .update(
      canonicalJson({
        schema: 1,
        backendId: input.backendId,
        providerId: input.providerId,
        modelId: input.modelId,
        observationIds,
      }),
    )
    .digest('hex');
}

export function opportunityRolesUsingPool(definition: GoalDefinition, poolId: string): GoalRole[] {
  return (
    Object.entries(definition.routing.roles) as Array<
      [GoalRole, GoalDefinition['routing']['roles'][GoalRole]]
    >
  ).flatMap(([role, route]) => (route?.kind === 'pool' && route.poolId === poolId ? [role] : []));
}

function requireKnownRouteIdentity(member: RouteMember, snapshot: RouteSnapshot) {
  const result = computeRouteIdentity(member, snapshot);
  if (
    !result.ok ||
    effectiveIdentityKind(member) === 'unknown' ||
    !result.value.provider ||
    !result.value.model ||
    result.value.issues.length > 0
  )
    throw new OpportunityEvidenceError('opportunity_identity_unavailable');
  return result;
}

export function opportunityBindingForMember(member: RouteMember): OpportunityBinding {
  const parsed = opportunityBindingSchema.safeParse(member.opportunity);
  if (!parsed.success) throw new OpportunityEvidenceError('opportunity_binding_invalid');
  const { backendId, providerId, modelId } = member.configuration;
  if (!backendId || !providerId || !modelId)
    throw new OpportunityEvidenceError('opportunity_binding_invalid');
  if (
    computeOpportunityDigest({
      backendId,
      providerId,
      modelId,
      observationIds: parsed.data.observationIds,
    }) !== parsed.data.opportunityDigest
  )
    throw new OpportunityEvidenceError('opportunity_binding_invalid');
  return parsed.data;
}

function admissionProofDigest(input: {
  approvalId: string;
  goalId: string;
  definitionVersion: number;
  poolId: string;
  memberIndex: number;
  memberIdentityHash: string;
  opportunityDigest: string;
  observationIds: readonly string[];
  acceptedAt: string;
}): string {
  return createHash('sha256')
    .update(canonicalJson({ schemaVersion: 1, ...input, observationIds: [...input.observationIds] }))
    .digest('hex');
}

/** Records the immutable user-approved admission after its fresh observation proof has been rechecked. */
export function recordOpportunityAdmissionProof(
  db: Db,
  input: { approvalId: string; goalId: string; acceptedAt: string },
): void {
  const approval = db
    .prepare(
      `SELECT gate, risk, requested_by, status, decided_by, responded_at, detail_json
    FROM goal_approvals WHERE id = ? AND goal_id = ?`,
    )
    .get(input.approvalId, input.goalId) as
    | {
        gate: string;
        risk: string;
        requested_by: string;
        status: string;
        decided_by: string | null;
        responded_at: string | null;
        detail_json: string;
      }
    | undefined;
  let detail: OpportunityApprovalDetail;
  try {
    detail = opportunityApprovalDetailSchema.parse(JSON.parse(approval?.detail_json ?? 'null'));
  } catch {
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  }
  if (
    !approval ||
    approval.gate !== 'pool_route_first_use' ||
    approval.risk !== 'medium' ||
    approval.requested_by !== 'user' ||
    approval.status !== 'approved' ||
    approval.decided_by !== 'user' ||
    approval.responded_at !== input.acceptedAt
  )
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  const references = db
    .prepare(
      `SELECT goal_id, definition_version, pool_id, member_index, observation_id
    FROM model_observation_admission_refs WHERE admission_id = ? ORDER BY observation_id`,
    )
    .all(input.approvalId) as Array<{
    goal_id: string;
    definition_version: number;
    pool_id: string;
    member_index: number;
    observation_id: string;
  }>;
  const observationIds = references.map((row) => row.observation_id);
  const first = references[0];
  if (
    !first ||
    references.some(
      (row) =>
        row.goal_id !== input.goalId ||
        row.goal_id !== first.goal_id ||
        row.definition_version !== first.definition_version ||
        row.pool_id !== first.pool_id ||
        row.member_index !== first.member_index,
    ) ||
    first.pool_id !== detail.poolId ||
    first.member_index !== detail.memberIndex ||
    canonicalJson(observationIds) !== canonicalJson(detail.observationIds)
  )
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  const proof = {
    approvalId: input.approvalId,
    goalId: input.goalId,
    definitionVersion: first.definition_version,
    poolId: detail.poolId,
    memberIndex: detail.memberIndex,
    memberIdentityHash: detail.memberIdentityHash,
    opportunityDigest: detail.opportunityDigest,
    observationIds: detail.observationIds,
    acceptedAt: input.acceptedAt,
  };
  db.prepare(
    `INSERT INTO model_opportunity_admission_proofs
    (approval_id, goal_id, definition_version, pool_id, member_index, member_identity_hash,
     opportunity_digest, observation_ids_json, proof_digest, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    proof.approvalId,
    proof.goalId,
    proof.definitionVersion,
    proof.poolId,
    proof.memberIndex,
    proof.memberIdentityHash,
    proof.opportunityDigest,
    canonicalJson(proof.observationIds),
    admissionProofDigest(proof),
    proof.acceptedAt,
  );
}

/** Verifies the durable proof for this exact definition and member without requiring expired raw observations. */
export function hasOpportunityAdmissionProof(input: {
  db: Db;
  goalId: string;
  definitionVersion: number;
  poolId: string;
  memberIndex: number;
  member: RouteMember;
  identityHash?: string;
}): boolean {
  let binding: OpportunityBinding;
  try {
    binding = opportunityBindingForMember(input.member);
  } catch {
    return false;
  }
  const row = input.db
    .prepare(
      `SELECT proof.*, approval.gate, approval.risk, approval.requested_by,
      approval.status, approval.decided_by, approval.detail_json
    FROM model_opportunity_admission_proofs proof
    JOIN goal_approvals approval ON approval.id = proof.approval_id
    WHERE proof.goal_id = ? AND proof.definition_version = ? AND proof.pool_id = ? AND proof.member_index = ?
      AND proof.opportunity_digest = ? AND proof.observation_ids_json = ?
      AND (? IS NULL OR proof.member_identity_hash = ?)
    ORDER BY proof.accepted_at DESC, proof.approval_id DESC LIMIT 1`,
    )
    .get(
      input.goalId,
      input.definitionVersion,
      input.poolId,
      input.memberIndex,
      binding.opportunityDigest,
      canonicalJson(binding.observationIds),
      input.identityHash ?? null,
      input.identityHash ?? null,
    ) as
    | (Record<string, unknown> & {
        approval_id: string;
        goal_id: string;
        definition_version: number;
        pool_id: string;
        member_index: number;
        member_identity_hash: string;
        opportunity_digest: string;
        observation_ids_json: string;
        proof_digest: string;
        accepted_at: string;
        gate: string;
        risk: string;
        requested_by: string;
        status: string;
        decided_by: string | null;
        detail_json: string;
      })
    | undefined;
  if (
    !row ||
    row.gate !== 'pool_route_first_use' ||
    row.risk !== 'medium' ||
    row.requested_by !== 'user' ||
    row.status !== 'approved' ||
    row.decided_by !== 'user'
  )
    return false;
  let detail: OpportunityApprovalDetail;
  let observationIds: string[];
  try {
    detail = opportunityApprovalDetailSchema.parse(JSON.parse(row.detail_json));
    const parsedIds = opportunityBindingSchema.shape.observationIds.parse(
      JSON.parse(row.observation_ids_json),
    );
    observationIds = parsedIds;
  } catch {
    return false;
  }
  if (
    detail.poolId !== input.poolId ||
    detail.memberIndex !== input.memberIndex ||
    detail.opportunityDigest !== binding.opportunityDigest ||
    canonicalJson(detail.observationIds) !== canonicalJson(binding.observationIds) ||
    detail.memberIdentityHash !== row.member_identity_hash ||
    (input.identityHash !== undefined && detail.memberIdentityHash !== input.identityHash) ||
    row.opportunity_digest !== binding.opportunityDigest ||
    canonicalJson(observationIds) !== canonicalJson(binding.observationIds)
  )
    return false;
  const proof = {
    approvalId: row.approval_id,
    goalId: row.goal_id,
    definitionVersion: row.definition_version,
    poolId: row.pool_id,
    memberIndex: row.member_index,
    memberIdentityHash: row.member_identity_hash,
    opportunityDigest: row.opportunity_digest,
    observationIds,
    acceptedAt: row.accepted_at,
  };
  return row.proof_digest === admissionProofDigest(proof);
}

/** Recomputes the cited immutable observation and its provider-refresh parent before admission or reuse. */
export function verifyOpportunityObservationEvidence(
  db: Db,
  member: RouteMember,
  now: string,
): OpportunityAdmissionPath {
  const binding = opportunityBindingForMember(member);
  const { backendId, providerId, modelId } = member.configuration;
  if (!backendId || !providerId || !modelId)
    throw new OpportunityEvidenceError('opportunity_binding_invalid');
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new OpportunityEvidenceError('opportunity_binding_invalid');
  const freshAfter = at - MODEL_OBSERVATION_RETENTION_DAYS * 86_400_000;
  let selectedPath: OpportunityAdmissionPath | null = null;
  for (const id of binding.observationIds) {
    const observation = readVerifiedModelObservation(db, id);
    if (!observation) throw new OpportunityEvidenceError('opportunity_observation_missing');
    if (
      observation.backendId !== backendId ||
      observation.providerId !== providerId ||
      observation.modelId !== modelId ||
      Date.parse(observation.observedAt) < freshAfter ||
      Date.parse(observation.observedAt) > at ||
      Date.parse(observation.checkedAt) > at
    )
      throw new OpportunityEvidenceError('opportunity_observation_invalid');

    const parentValid =
      observation.sourceClass === 'live' &&
      observation.claimKind === 'provider-advertised' &&
      observation.refreshOutcome === 'success' &&
      observation.observedAt === observation.checkedAt;
    const adapterValid =
      observation.sourceClass === 'adapter' &&
      observation.claimKind === 'locally-discovered' &&
      observation.refreshOutcome === 'success' &&
      observation.observedAt === observation.checkedAt;
    const path: OpportunityAdmissionPath | null = parentValid
      ? 'provider-advertised'
      : adapterValid
        ? 'locally-discovered'
        : null;
    if (!path) throw new OpportunityEvidenceError('opportunity_observation_ineligible');
    if (selectedPath && selectedPath !== path)
      throw new OpportunityEvidenceError('opportunity_observation_ineligible');
    selectedPath = path;
  }
  if (!selectedPath) throw new OpportunityEvidenceError('opportunity_observation_missing');
  return selectedPath;
}

/**
 * Locally discovered adapters need fresh Turing route validation for every role that references the pool. When called
 * at later approval/reproof sites, the original exact identity hash is supplied and authenticated validation rows are
 * re-evaluated against the same identity.
 */
export function assertOpportunityLocalValidation(input: {
  db: Db;
  definition: GoalDefinition;
  poolId: string;
  member: RouteMember;
  now: string;
  identityHash?: string;
  snapshot?: RouteSnapshot;
}): string {
  const roles = opportunityRolesUsingPool(input.definition, input.poolId);
  if (!roles.length) throw new OpportunityEvidenceError('opportunity_validation_required');
  let identityHash = input.identityHash;
  let identity: Record<string, unknown> | null = null;
  if (input.snapshot) {
    const routeIdentity = requireKnownRouteIdentity(input.member, input.snapshot);
    if (identityHash && identityHash !== routeIdentity.value.identityHash)
      throw new OpportunityEvidenceError('opportunity_identity_unavailable');
    identityHash = routeIdentity.value.identityHash;
    identity = routeIdentity.value.identity;
  }
  if (!identityHash) throw new OpportunityEvidenceError('opportunity_identity_unavailable');
  const modelId = input.member.configuration.modelId;
  if (!modelId) throw new OpportunityEvidenceError('opportunity_identity_unavailable');
  const records = readRouteValidations(input.db, [identityHash], [modelId]);
  identity ??= records.find((record) => record.identityHash === identityHash)?.identity ?? null;
  if (!identity) throw new OpportunityEvidenceError('opportunity_validation_required');
  for (const role of roles) {
    const fresh = freshValidationSet({
      records,
      identityHash,
      identity,
      role,
      freshnessClass: 'opportunity',
      now: input.now,
    });
    if (!fresh.available) throw new OpportunityEvidenceError('opportunity_validation_required');
    for (const profile of fresh.profiles) {
      const record = records.find((candidate) => candidate.id === profile.recordId);
      if (
        !record ||
        record.provenance !== 'turing_probe_run' ||
        record.status !== 'pass' ||
        !record.evidenceRunId
      )
        throw new OpportunityEvidenceError('opportunity_validation_required');
    }
  }
  return identityHash;
}

/** Strictly checks an opportunity admission detail against one proposed definition and its observation evidence. */
export function verifyOpportunityApprovalDetail(input: {
  db: Db;
  goalId: string;
  definitionVersion: number;
  definition: GoalDefinition;
  detail: unknown;
  now: string;
  snapshot?: RouteSnapshot;
}): OpportunityApprovalDetail {
  const parsed = opportunityApprovalDetailSchema.safeParse(input.detail);
  if (!parsed.success) throw new OpportunityEvidenceError('opportunity_approval_invalid');
  const detail = parsed.data;
  const pool = input.definition.routing.pools.find((candidate) => candidate.id === detail.poolId);
  const member = pool?.members[detail.memberIndex];
  if (!pool || pool.admission !== 'opportunity' || !member || !member.opportunity)
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  const binding = opportunityBindingForMember(member);
  if (
    detail.opportunityDigest !== binding.opportunityDigest ||
    canonicalJson(detail.observationIds) !== canonicalJson(binding.observationIds)
  )
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  const path = verifyOpportunityObservationEvidence(input.db, member, input.now);
  if (path === 'locally-discovered')
    assertOpportunityLocalValidation({
      db: input.db,
      definition: input.definition,
      poolId: pool.id,
      member,
      now: input.now,
      identityHash: detail.memberIdentityHash,
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    });
  else if (input.snapshot) {
    const routeIdentity = requireKnownRouteIdentity(member, input.snapshot);
    if (routeIdentity.value.identityHash !== detail.memberIdentityHash)
      throw new OpportunityEvidenceError('opportunity_identity_unavailable');
  }
  return detail;
}

function reproveOpportunityAdmissionAgainstDefinition(
  db: Db,
  input: {
    goalId: string;
    approvalId: string;
    detailJson: string;
    definitionVersion: number;
    definition: GoalDefinition;
    now: string;
  },
): OpportunityApprovalDetail {
  const approval = db
    .prepare(
      `SELECT goal_id, gate, risk, requested_by, status, decided_by, detail_json
    FROM goal_approvals WHERE id = ?`,
    )
    .get(input.approvalId) as
    | {
        goal_id: string;
        gate: string;
        risk: string;
        requested_by: string;
        status: string;
        decided_by: string | null;
        detail_json: string;
      }
    | undefined;
  if (
    !approval ||
    approval.goal_id !== input.goalId ||
    approval.gate !== 'pool_route_first_use' ||
    approval.risk !== 'medium' ||
    approval.requested_by !== 'user' ||
    !['pending', 'approved'].includes(approval.status) ||
    (approval.status === 'approved' && approval.decided_by !== 'user') ||
    approval.detail_json !== input.detailJson
  )
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  let detail: unknown;
  try {
    detail = JSON.parse(input.detailJson);
  } catch {
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  }
  const parsed = opportunityApprovalDetailSchema.safeParse(detail);
  if (!parsed.success) throw new OpportunityEvidenceError('opportunity_approval_invalid');
  verifyOpportunityApprovalDetail({
    db,
    goalId: input.goalId,
    definitionVersion: input.definitionVersion,
    definition: input.definition,
    detail: parsed.data,
    now: input.now,
  });
  const refs = db
    .prepare(
      `SELECT observation_id FROM model_observation_admission_refs
    WHERE admission_id = ? AND goal_id = ? AND definition_version = ? AND pool_id = ? AND member_index = ?
      AND expires_at > ?
    ORDER BY observation_id`,
    )
    .all(
      input.approvalId,
      input.goalId,
      input.definitionVersion,
      parsed.data.poolId,
      parsed.data.memberIndex,
      input.now,
    ) as Array<{ observation_id: string }>;
  if (canonicalJson(refs.map((row) => row.observation_id)) !== canonicalJson(parsed.data.observationIds))
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  return parsed.data;
}

/** Database-only reproof of one pending/approved admission against the sole current proposed Goal definition. */
export function reproveOpportunityAdmissionApproval(
  db: Db,
  input: { goalId: string; approvalId: string; detailJson: string; now: string },
): OpportunityApprovalDetail {
  const versions = db
    .prepare(
      `SELECT version, contract_json, milestones_json, routing_json, review_json, limits_json,
      definition_hash FROM goal_definition_versions WHERE goal_id = ? AND status = 'proposed' ORDER BY version DESC`,
    )
    .all(input.goalId) as Array<{
    version: number;
    contract_json: string;
    milestones_json: string;
    routing_json: string;
    review_json: string;
    limits_json: string;
    definition_hash: string;
  }>;
  if (versions.length !== 1) throw new OpportunityEvidenceError('opportunity_approval_invalid');
  const version = versions[0]!;
  let definition: GoalDefinition;
  try {
    definition = {
      contract: JSON.parse(version.contract_json),
      milestones: JSON.parse(version.milestones_json),
      routing: JSON.parse(version.routing_json),
      review: JSON.parse(version.review_json),
      limits: JSON.parse(version.limits_json),
    } as GoalDefinition;
    if (hashGoalDefinition(definition) !== version.definition_hash) throw new Error('hash');
  } catch {
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  }
  return reproveOpportunityAdmissionAgainstDefinition(db, {
    ...input,
    definitionVersion: version.version,
    definition,
  });
}

/** Requires the durable user-approved proof for every opportunity member in the proposed definition. */
export function assertOpportunityDefinitionAdmissions(
  db: Db,
  goalId: string,
  definitionVersion: number,
  definition: GoalDefinition,
): void {
  const proposed = db
    .prepare(
      `SELECT version, definition_hash FROM goal_definition_versions
    WHERE goal_id = ? AND status = 'proposed' ORDER BY version DESC LIMIT 1`,
    )
    .get(goalId) as { version: number; definition_hash: string } | undefined;
  if (
    !proposed ||
    proposed.version !== definitionVersion ||
    hashGoalDefinition(definition) !== proposed.definition_hash
  )
    throw new OpportunityEvidenceError('opportunity_approval_invalid');
  for (const pool of definition.routing.pools.filter((candidate) => candidate.admission === 'opportunity')) {
    for (const [memberIndex, member] of pool.members.entries()) {
      if (!member.opportunity) throw new OpportunityEvidenceError('opportunity_binding_invalid');
      if (
        !hasOpportunityAdmissionProof({
          db,
          goalId,
          definitionVersion,
          poolId: pool.id,
          memberIndex,
          member,
        })
      )
        throw new OpportunityEvidenceError('opportunity_approval_invalid');
    }
  }
}
