import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { readContentVerificationByDigest } from './contentVerification.js';
import { canonicalJson, hashGoalDefinition } from './definitionHash.js';
import { parseCompletionPolicy, validateApprovedCompletionPolicyLineage } from './completionPolicy.js';
import { parseExternalIntegrationAttestation } from './externalIntegration.js';
import { getGoalApproval } from './approvals.js';

const HASH = /^[0-9a-f]{64}$/;
const UUID = z.string().uuid();
const DIGEST = z.string().regex(HASH);
const OBJECT_ID = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const REF = z.string().min(1).max(500);
const OBJECT_FORMAT = z.enum(['sha1', 'sha256']);

const definitionIdentity = z.strictObject({
  version: z.number().int().positive(),
  hash: DIGEST,
  approvalId: UUID,
  lineageDigest: DIGEST,
});
const handoffIdentity = z.strictObject({ id: UUID, digest: DIGEST });
const attestationIdentity = z.strictObject({
  id: UUID,
  actionDigest: DIGEST,
  recordDigest: DIGEST,
  approvalId: UUID,
});
const reviewIdentity = z.strictObject({ finalReviewId: UUID, acceptanceApprovalId: UUID });
const repositoryIdentity = z.strictObject({
  projectId: UUID,
  identity: DIGEST,
  scope: z.string().max(1_000),
  objectFormat: OBJECT_FORMAT,
});
const sourceIdentity = z.strictObject({ ref: REF, commit: OBJECT_ID, tree: OBJECT_ID });
const destinationIdentity = z.strictObject({
  ref: REF,
  recordedBaseCommit: OBJECT_ID,
  recordedBaseTree: OBJECT_ID,
  observedCommit: OBJECT_ID,
  observedTree: OBJECT_ID,
});
const correctionChainIdentity = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('turing_goal_external_integration_correction_chain'),
  attestationId: UUID,
  sequence: z.number().int().nonnegative(),
  digest: DIGEST,
  standing: z.literal('active_uncontested'),
});
const proofLimitations = z.strictObject({ contentPreservation: z.literal('not_proven') });
const gitProofIdentity = z.strictObject({
  mode: z.literal('source_history_observed'),
  sourceAncestor: z.literal(true),
  baseAncestor: z.literal(true),
  verifierVersion: z.literal(1),
  evidenceDigest: DIGEST,
});

const actionBodySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    action: z.literal('complete_goal_external_integration_v2'),
    completionContractVersion: z.literal(2),
    goalId: UUID,
    definition: definitionIdentity,
    integrationMode: z.literal('external_user_attested'),
    handoff: handoffIdentity,
    attestation: attestationIdentity,
    review: reviewIdentity,
    verificationEvidenceDigest: DIGEST,
    contentVerificationDigest: DIGEST.optional(),
    contentVerificationStatus: z.enum(['verified', 'content_not_preserved']).optional(),
    contentOutcomeAcknowledged: z.boolean().optional(),
    milestoneIdentityDigest: DIGEST,
    findingIdentityDigest: DIGEST,
    repository: repositoryIdentity,
    source: sourceIdentity,
    destination: destinationIdentity,
    proof: gitProofIdentity,
    proofLimitations,
    userReviewedPreflightDigest: DIGEST,
    correctionChain: correctionChainIdentity,
  })
  .superRefine((action, context) => {
    const oidLength = action.repository.objectFormat === 'sha1' ? 40 : 64;
    for (const [path, objectId] of [
      ['source.commit', action.source.commit],
      ['source.tree', action.source.tree],
      ['destination.recordedBaseCommit', action.destination.recordedBaseCommit],
      ['destination.recordedBaseTree', action.destination.recordedBaseTree],
      ['destination.observedCommit', action.destination.observedCommit],
      ['destination.observedTree', action.destination.observedTree],
    ] as const) {
      if (objectId.length !== oidLength)
        context.addIssue({
          code: 'custom',
          path: path.split('.'),
          message: 'Object ID does not match Git object format.',
        });
    }
    if (action.correctionChain.attestationId !== action.attestation.id)
      context.addIssue({
        code: 'custom',
        path: ['correctionChain', 'attestationId'],
        message: 'Correction chain belongs to another attestation.',
      });
    if ((action.contentVerificationDigest === undefined) !== (action.contentVerificationStatus === undefined))
      context.addIssue({
        code: 'custom',
        path: ['contentVerificationStatus'],
        message: 'Content verification digest and status must appear together.',
      });
  });

export type ExternalCompletionActionBodyV1 = z.infer<typeof actionBodySchema>;
export interface ExternalCompletionActionV1 extends ExternalCompletionActionBodyV1 {
  actionDigest: string;
}

const actionSchema = actionBodySchema.extend({ actionDigest: DIGEST }).strict();

function domainDigest(domain: string, body: unknown): string {
  return createHash('sha256').update(domain).update('\0').update(canonicalJson(body)).digest('hex');
}

export function computeExternalCompletionActionDigest(input: ExternalCompletionActionBodyV1): string {
  const parsed = actionBodySchema.parse(input);
  return domainDigest('turing-goal-external-completion-action-v2', parsed);
}

export function buildExternalCompletionAction(input: unknown): ExternalCompletionActionV1 | null {
  const parsed = actionBodySchema.safeParse(input);
  if (!parsed.success) return null;
  return { ...parsed.data, actionDigest: computeExternalCompletionActionDigest(parsed.data) };
}

export type ParsedExternalCompletionAction =
  | { valid: true; action: ExternalCompletionActionV1; digest: string }
  | { valid: false; reason: 'schema_invalid' | 'digest_mismatch' };

export function parseExternalCompletionAction(input: unknown): ParsedExternalCompletionAction {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: 'schema_invalid' };
  const { actionDigest, ...body } = parsed.data;
  const digest = computeExternalCompletionActionDigest(body);
  if (digest !== actionDigest) return { valid: false, reason: 'digest_mismatch' };
  return { valid: true, action: parsed.data, digest };
}

const completionProofBodySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('turing_goal_external_completion_proof'),
    contractVersion: z.literal(2),
    goalId: UUID,
    definition: definitionIdentity,
    evaluation: z.strictObject({
      integrationHead: OBJECT_ID,
      integrationTree: OBJECT_ID,
      verificationEvidenceDigest: DIGEST,
      milestoneIdentityDigest: DIGEST,
      findingIdentityDigest: DIGEST,
      finalReviewId: UUID,
      finalAcceptanceApprovalId: UUID,
    }),
    handoff: handoffIdentity,
    attestation: attestationIdentity,
    repository: repositoryIdentity,
    source: sourceIdentity,
    destination: destinationIdentity,
    gitProof: gitProofIdentity.extend({ observedAt: z.string().datetime() }).strict(),
    contentVerificationDigest: DIGEST.optional(),
    contentVerificationStatus: z.enum(['verified', 'content_not_preserved']).optional(),
    decision: z.strictObject({
      approvalId: UUID,
      actionDigest: DIGEST,
      decidedAt: z.string().datetime(),
      classification: z.literal('user_confirmed_historical_external_integration'),
    }),
    proofLimitations,
    correctionChain: correctionChainIdentity,
    userReviewedPreflightDigest: DIGEST,
  })
  .superRefine((proof, context) => {
    const oidLength = proof.repository.objectFormat === 'sha1' ? 40 : 64;
    for (const [path, objectId] of [
      ['evaluation.integrationHead', proof.evaluation.integrationHead],
      ['evaluation.integrationTree', proof.evaluation.integrationTree],
      ['source.commit', proof.source.commit],
      ['source.tree', proof.source.tree],
      ['destination.recordedBaseCommit', proof.destination.recordedBaseCommit],
      ['destination.recordedBaseTree', proof.destination.recordedBaseTree],
      ['destination.observedCommit', proof.destination.observedCommit],
      ['destination.observedTree', proof.destination.observedTree],
    ] as const) {
      if (objectId.length !== oidLength)
        context.addIssue({
          code: 'custom',
          path: path.split('.'),
          message: 'Object ID does not match Git object format.',
        });
    }
    if (proof.evaluation.integrationHead !== proof.source.commit)
      context.addIssue({
        code: 'custom',
        path: ['evaluation', 'integrationHead'],
        message: 'Evaluation source commit mismatch.',
      });
    if (proof.evaluation.integrationTree !== proof.source.tree)
      context.addIssue({
        code: 'custom',
        path: ['evaluation', 'integrationTree'],
        message: 'Evaluation source tree mismatch.',
      });
    if (proof.correctionChain.attestationId !== proof.attestation.id)
      context.addIssue({
        code: 'custom',
        path: ['correctionChain', 'attestationId'],
        message: 'Correction chain belongs to another attestation.',
      });
    if ((proof.contentVerificationDigest === undefined) !== (proof.contentVerificationStatus === undefined))
      context.addIssue({
        code: 'custom',
        path: ['contentVerificationStatus'],
        message: 'Content verification digest and status must appear together.',
      });
  });

export type ExternalCompletionProofBodyV1 = z.infer<typeof completionProofBodySchema>;
export interface ExternalCompletionProofV1 extends ExternalCompletionProofBodyV1 {
  proofDigest: string;
}
const completionProofSchema = completionProofBodySchema.extend({ proofDigest: DIGEST }).strict();

export function computeExternalCompletionProofDigest(input: ExternalCompletionProofBodyV1): string {
  const parsed = completionProofBodySchema.parse(input);
  return domainDigest('turing-goal-external-completion-proof-v2', parsed);
}

export function buildExternalCompletionProof(input: unknown): ExternalCompletionProofV1 | null {
  const parsed = completionProofBodySchema.safeParse(input);
  if (!parsed.success) return null;
  return { ...parsed.data, proofDigest: computeExternalCompletionProofDigest(parsed.data) };
}

/**
 * The exact `payload_json` the terminal writer stores for a validated proof: its canonical JSON, including proofDigest.
 * Canonical form is the single serialisation that `readExternalCompletionProof` re-parses and re-digests.
 */
export function externalCompletionProofPayloadJson(proof: ExternalCompletionProofV1): string {
  return canonicalJson(proof);
}

export type ParsedExternalCompletionProof =
  | { valid: true; proof: ExternalCompletionProofV1; digest: string }
  | { valid: false; reason: 'schema_invalid' | 'digest_mismatch' };

export function parseExternalCompletionProof(input: unknown): ParsedExternalCompletionProof {
  const parsed = completionProofSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: 'schema_invalid' };
  const { proofDigest, ...body } = parsed.data;
  const digest = computeExternalCompletionProofDigest(body);
  if (digest !== proofDigest) return { valid: false, reason: 'digest_mismatch' };
  return { valid: true, proof: parsed.data, digest };
}

interface CompletionProofRow {
  id: string;
  goal_id: string;
  action_digest: string;
  proof_digest: string;
  definition_version: number;
  definition_hash: string;
  definition_approval_id: string;
  handoff_id: string;
  handoff_digest: string;
  attestation_id: string;
  attestation_action_digest: string;
  attestation_record_digest: string;
  attestation_approval_id: string;
  completion_approval_id: string;
  repository_project_id: string;
  repository_identity: string;
  repository_scope: string;
  object_format: 'sha1' | 'sha256';
  source_ref: string;
  source_commit: string;
  source_tree: string;
  destination_ref: string;
  recorded_base_commit: string;
  recorded_base_tree: string;
  observed_destination_commit: string;
  observed_destination_tree: string;
  verification_evidence_digest: string;
  content_verification_digest: string | null;
  content_verification_status: 'verified' | 'content_not_preserved' | null;
  milestone_identity_digest: string;
  finding_identity_digest: string;
  git_evidence_digest: string;
  preflight_digest: string;
  correction_chain_digest: string;
  correction_sequence: number;
  correction_standing: 'active_uncontested';
  observed_at: string;
  decided_at: string;
  payload_json: string;
}

export type ExternalCompletionProofRead =
  | { state: 'not_found' }
  | { state: 'invalid'; reason: string }
  | { state: 'valid'; id: string; goalId: string; proof: ExternalCompletionProofV1 };

/** Read-only integrity check for a persisted proof. It never creates, repairs, or updates completion authority. */
export function readExternalCompletionProof(
  db: Db,
  goalId: string,
  proofId: string,
): ExternalCompletionProofRead {
  try {
    const row = db
      .prepare('SELECT * FROM goal_external_completion_proofs WHERE goal_id = ? AND id = ?')
      .get(goalId, proofId) as CompletionProofRow | undefined;
    if (!row) return { state: 'not_found' };
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      return { state: 'invalid', reason: 'payload_invalid' };
    }
    const parsed = parseExternalCompletionProof(payload);
    if (!parsed.valid) return { state: 'invalid', reason: parsed.reason };
    const proof = parsed.proof;
    if (
      parsed.digest !== row.proof_digest ||
      proof.proofDigest !== row.proof_digest ||
      proof.goalId !== goalId ||
      proof.decision.actionDigest !== row.action_digest ||
      proof.definition.version !== row.definition_version ||
      proof.definition.hash !== row.definition_hash ||
      proof.definition.approvalId !== row.definition_approval_id ||
      proof.handoff.id !== row.handoff_id ||
      proof.handoff.digest !== row.handoff_digest ||
      proof.attestation.id !== row.attestation_id ||
      proof.attestation.actionDigest !== row.attestation_action_digest ||
      proof.attestation.recordDigest !== row.attestation_record_digest ||
      proof.attestation.approvalId !== row.attestation_approval_id ||
      proof.decision.approvalId !== row.completion_approval_id ||
      proof.repository.projectId !== row.repository_project_id ||
      proof.repository.identity !== row.repository_identity ||
      proof.repository.scope !== row.repository_scope ||
      proof.repository.objectFormat !== row.object_format ||
      proof.source.ref !== row.source_ref ||
      proof.source.commit !== row.source_commit ||
      proof.source.tree !== row.source_tree ||
      proof.destination.ref !== row.destination_ref ||
      proof.destination.recordedBaseCommit !== row.recorded_base_commit ||
      proof.destination.recordedBaseTree !== row.recorded_base_tree ||
      proof.destination.observedCommit !== row.observed_destination_commit ||
      proof.destination.observedTree !== row.observed_destination_tree ||
      proof.evaluation.verificationEvidenceDigest !== row.verification_evidence_digest ||
      (proof.contentVerificationDigest ?? null) !== row.content_verification_digest ||
      (proof.contentVerificationStatus ?? null) !== row.content_verification_status ||
      proof.evaluation.milestoneIdentityDigest !== row.milestone_identity_digest ||
      proof.evaluation.findingIdentityDigest !== row.finding_identity_digest ||
      proof.gitProof.evidenceDigest !== row.git_evidence_digest ||
      proof.userReviewedPreflightDigest !== row.preflight_digest ||
      proof.correctionChain.digest !== row.correction_chain_digest ||
      proof.correctionChain.sequence !== row.correction_sequence ||
      proof.correctionChain.standing !== row.correction_standing ||
      proof.gitProof.observedAt !== row.observed_at ||
      proof.decision.decidedAt !== row.decided_at
    )
      return { state: 'invalid', reason: 'indexed_identity_mismatch' };

    if (row.content_verification_digest !== null) {
      const content = readContentVerificationByDigest(db, goalId, row.content_verification_digest);
      if (
        content.state !== 'valid' ||
        content.record.status !== proof.contentVerificationStatus ||
        content.record.verificationDigest !== proof.contentVerificationDigest ||
        content.record.repository.objectFormat !== proof.repository.objectFormat ||
        content.record.source.commit !== proof.source.commit ||
        content.record.destination.expectedBaseCommit !== proof.destination.recordedBaseCommit ||
        content.record.destination.ref !== proof.destination.ref ||
        content.record.destination.tipCommit !== proof.destination.observedCommit
      )
        return { state: 'invalid', reason: 'content_verification_mismatch' };
    } else if (proof.contentVerificationDigest !== undefined) {
      return { state: 'invalid', reason: 'content_verification_mismatch' };
    }

    const definition = db
      .prepare(
        `SELECT definition_hash, approval_id, status, approved_by, contract_json, milestones_json, routing_json,
                review_json, limits_json
         FROM goal_definition_versions WHERE goal_id = ? AND version = ?`,
      )
      .get(goalId, proof.definition.version) as
      | {
          definition_hash: string;
          approval_id: string | null;
          status: string;
          approved_by: string | null;
          contract_json: string;
          milestones_json: string;
          routing_json: string;
          review_json: string;
          limits_json: string;
        }
      | undefined;
    if (
      !definition ||
      !['approved', 'superseded'].includes(definition.status) ||
      definition.approved_by !== 'user' ||
      definition.definition_hash !== proof.definition.hash ||
      definition.approval_id !== proof.definition.approvalId
    )
      return { state: 'invalid', reason: 'definition_identity_mismatch' };
    const contract = JSON.parse(definition.contract_json) as { completionPolicy?: unknown };
    const policy = parseCompletionPolicy(contract.completionPolicy);
    if (policy.kind !== 'valid' || policy.mode !== 'external_user_attested_v2')
      return { state: 'invalid', reason: 'definition_policy_mismatch' };
    const fullDefinition = {
      contract: JSON.parse(definition.contract_json),
      milestones: JSON.parse(definition.milestones_json),
      routing: JSON.parse(definition.routing_json),
      review: JSON.parse(definition.review_json),
      limits: JSON.parse(definition.limits_json),
    };
    if (hashGoalDefinition(fullDefinition) !== proof.definition.hash)
      return { state: 'invalid', reason: 'definition_hash_mismatch' };
    const lineage = validateApprovedCompletionPolicyLineage(db, goalId, proof.definition.version);
    if (lineage.kind !== 'valid' || lineage.lineageDigest !== proof.definition.lineageDigest)
      return { state: 'invalid', reason: 'definition_lineage_mismatch' };
    const definitionApproval = getGoalApproval(db, proof.definition.approvalId);
    if (
      !definitionApproval ||
      definitionApproval.goalId !== goalId ||
      definitionApproval.status !== 'approved' ||
      definitionApproval.decidedBy !== 'user' ||
      definitionApproval.detail.version !== proof.definition.version ||
      definitionApproval.detail.definitionHash !== proof.definition.hash
    )
      return { state: 'invalid', reason: 'definition_approval_mismatch' };

    const handoff = db
      .prepare(
        `SELECT handoff_digest, payload_json, definition_version, final_review_id, final_acceptance_approval_id,
                source_commit, source_tree, base_ref, observed_base_commit
         FROM goal_result_handoffs WHERE goal_id = ? AND id = ?`,
      )
      .get(goalId, proof.handoff.id) as
      | {
          handoff_digest: string;
          payload_json: string;
          definition_version: number;
          final_review_id: string;
          final_acceptance_approval_id: string;
          source_commit: string;
          source_tree: string;
          base_ref: string;
          observed_base_commit: string;
        }
      | undefined;
    if (!handoff || handoff.handoff_digest !== proof.handoff.digest)
      return { state: 'invalid', reason: 'handoff_identity_mismatch' };
    const handoffPayload = JSON.parse(handoff.payload_json) as {
      definition?: { version?: number; hash?: string; approvalId?: string };
      source?: { commit?: string; tree?: string };
      target?: { observedBaseTree?: string };
      handoffDigest?: string;
    };
    if (
      handoffPayload.handoffDigest !== proof.handoff.digest ||
      handoff.definition_version !== proof.definition.version ||
      handoff.final_review_id !== proof.evaluation.finalReviewId ||
      handoff.final_acceptance_approval_id !== proof.evaluation.finalAcceptanceApprovalId ||
      handoff.source_commit !== proof.source.commit ||
      handoff.source_tree !== proof.source.tree ||
      handoff.base_ref !== proof.destination.ref ||
      handoff.observed_base_commit !== proof.destination.recordedBaseCommit ||
      handoffPayload.definition?.version !== proof.definition.version ||
      handoffPayload.definition?.hash !== proof.definition.hash ||
      handoffPayload.definition?.approvalId !== proof.definition.approvalId ||
      handoffPayload.source?.commit !== proof.source.commit ||
      handoffPayload.source?.tree !== proof.source.tree ||
      handoffPayload.target?.observedBaseTree !== proof.destination.recordedBaseTree
    )
      return { state: 'invalid', reason: 'handoff_payload_mismatch' };

    const attestation = db
      .prepare(
        'SELECT payload_json, action_digest, record_digest FROM goal_external_integration_attestations WHERE goal_id = ? AND id = ?',
      )
      .get(goalId, proof.attestation.id) as
      { payload_json: string; action_digest: string; record_digest: string } | undefined;
    if (
      !attestation ||
      attestation.action_digest !== proof.attestation.actionDigest ||
      attestation.record_digest !== proof.attestation.recordDigest
    )
      return { state: 'invalid', reason: 'attestation_identity_mismatch' };
    const attestationPayload = parseExternalIntegrationAttestation(JSON.parse(attestation.payload_json));
    if (
      !attestationPayload ||
      attestationPayload.goalId !== goalId ||
      attestationPayload.attestationId !== proof.attestation.id ||
      attestationPayload.approvalId !== proof.attestation.approvalId ||
      attestationPayload.handoff.id !== proof.handoff.id ||
      attestationPayload.handoff.digest !== proof.handoff.digest ||
      attestationPayload.definition.version !== proof.definition.version ||
      attestationPayload.definition.hash !== proof.definition.hash ||
      attestationPayload.definition.approvalId !== proof.definition.approvalId ||
      attestationPayload.review.finalReviewId !== proof.evaluation.finalReviewId ||
      attestationPayload.review.acceptanceApprovalId !== proof.evaluation.finalAcceptanceApprovalId ||
      attestationPayload.repository.projectId !== proof.repository.projectId ||
      attestationPayload.repository.identity !== proof.repository.identity ||
      attestationPayload.repository.scope !== proof.repository.scope ||
      attestationPayload.repository.objectFormat !== proof.repository.objectFormat ||
      attestationPayload.source.ref !== proof.source.ref ||
      attestationPayload.source.commit !== proof.source.commit ||
      attestationPayload.source.tree !== proof.source.tree ||
      attestationPayload.destination.ref !== proof.destination.ref ||
      attestationPayload.destination.expectedBaseCommit !== proof.destination.recordedBaseCommit ||
      attestationPayload.destination.expectedBaseTree !== proof.destination.recordedBaseTree ||
      attestationPayload.destination.observedCommit !== proof.destination.observedCommit ||
      attestationPayload.destination.observedTree !== proof.destination.observedTree ||
      attestationPayload.proof.mode !== proof.gitProof.mode ||
      attestationPayload.proof.sourceAncestor !== proof.gitProof.sourceAncestor ||
      attestationPayload.proof.baseAncestor !== proof.gitProof.baseAncestor ||
      attestationPayload.proof.verifierVersion !== proof.gitProof.verifierVersion ||
      attestationPayload.proof.evidenceDigest !== proof.gitProof.evidenceDigest
    )
      return { state: 'invalid', reason: 'attestation_payload_mismatch' };

    const attestationApproval = getGoalApproval(db, proof.attestation.approvalId);
    if (
      !attestationApproval ||
      attestationApproval.goalId !== goalId ||
      attestationApproval.gate !== 'final_apply' ||
      attestationApproval.risk !== 'high' ||
      attestationApproval.requestedBy !== 'user' ||
      attestationApproval.status !== 'approved' ||
      attestationApproval.decidedBy !== 'user' ||
      attestationApproval.externalIntegrationActionDigest !== proof.attestation.actionDigest ||
      attestationApproval.detail.action !== 'confirm_external_integration' ||
      attestationApproval.detail.actionDigest !== proof.attestation.actionDigest
    )
      return { state: 'invalid', reason: 'attestation_approval_mismatch' };

    const review = db
      .prepare(
        `SELECT goal_id, definition_version, review_kind, status, verdict, blocking, reviewed_to_commit,
                reviewed_to_tree FROM goal_reviews WHERE id = ?`,
      )
      .get(proof.evaluation.finalReviewId) as
      | {
          goal_id: string;
          definition_version: number;
          review_kind: string;
          status: string;
          verdict: string | null;
          blocking: number | null;
          reviewed_to_commit: string;
          reviewed_to_tree: string;
        }
      | undefined;
    if (
      !review ||
      review.goal_id !== goalId ||
      review.definition_version !== proof.definition.version ||
      review.review_kind !== 'final' ||
      review.status !== 'completed' ||
      review.verdict !== 'pass' ||
      review.blocking !== 0 ||
      review.reviewed_to_commit !== proof.source.commit ||
      review.reviewed_to_tree !== proof.source.tree
    )
      return { state: 'invalid', reason: 'final_review_mismatch' };

    const acceptanceApproval = getGoalApproval(db, proof.evaluation.finalAcceptanceApprovalId);
    if (
      !acceptanceApproval ||
      acceptanceApproval.goalId !== goalId ||
      acceptanceApproval.gate !== 'final_acceptance' ||
      acceptanceApproval.status !== 'approved' ||
      acceptanceApproval.decidedBy !== 'user' ||
      acceptanceApproval.detail.definitionVersion !== proof.definition.version ||
      acceptanceApproval.detail.definitionHash !== proof.definition.hash ||
      acceptanceApproval.detail.integrationHead !== proof.source.commit ||
      acceptanceApproval.detail.integrationTree !== proof.source.tree
    )
      return { state: 'invalid', reason: 'final_acceptance_mismatch' };

    const completionApproval = getGoalApproval(db, proof.decision.approvalId);
    const action = completionApproval ? parseExternalCompletionAction(completionApproval.detail) : null;
    if (
      !completionApproval ||
      completionApproval.goalId !== goalId ||
      completionApproval.gate !== 'user_confirmation' ||
      completionApproval.risk !== 'high' ||
      completionApproval.requestedBy !== 'user' ||
      completionApproval.status !== 'approved' ||
      completionApproval.decidedBy !== 'user' ||
      completionApproval.externalCompletionActionDigest !== proof.decision.actionDigest ||
      !action ||
      !action.valid ||
      action.digest !== proof.decision.actionDigest ||
      action.action.goalId !== goalId ||
      action.action.completionContractVersion !== proof.contractVersion ||
      action.action.definition.version !== proof.definition.version ||
      action.action.definition.hash !== proof.definition.hash ||
      action.action.definition.approvalId !== proof.definition.approvalId ||
      action.action.definition.lineageDigest !== proof.definition.lineageDigest ||
      action.action.integrationMode !== 'external_user_attested' ||
      action.action.handoff.id !== proof.handoff.id ||
      action.action.handoff.digest !== proof.handoff.digest ||
      action.action.attestation.id !== proof.attestation.id ||
      action.action.attestation.actionDigest !== proof.attestation.actionDigest ||
      action.action.attestation.recordDigest !== proof.attestation.recordDigest ||
      action.action.attestation.approvalId !== proof.attestation.approvalId ||
      action.action.review.finalReviewId !== proof.evaluation.finalReviewId ||
      action.action.review.acceptanceApprovalId !== proof.evaluation.finalAcceptanceApprovalId ||
      action.action.verificationEvidenceDigest !== proof.evaluation.verificationEvidenceDigest ||
      action.action.contentVerificationStatus !== proof.contentVerificationStatus ||
      (proof.contentVerificationDigest !== undefined && action.action.contentOutcomeAcknowledged !== true) ||
      action.action.milestoneIdentityDigest !== proof.evaluation.milestoneIdentityDigest ||
      action.action.findingIdentityDigest !== proof.evaluation.findingIdentityDigest ||
      action.action.repository.projectId !== proof.repository.projectId ||
      action.action.repository.identity !== proof.repository.identity ||
      action.action.repository.scope !== proof.repository.scope ||
      action.action.repository.objectFormat !== proof.repository.objectFormat ||
      action.action.source.ref !== proof.source.ref ||
      action.action.source.commit !== proof.source.commit ||
      action.action.source.tree !== proof.source.tree ||
      action.action.destination.ref !== proof.destination.ref ||
      action.action.destination.recordedBaseCommit !== proof.destination.recordedBaseCommit ||
      action.action.destination.recordedBaseTree !== proof.destination.recordedBaseTree ||
      action.action.destination.observedCommit !== proof.destination.observedCommit ||
      action.action.destination.observedTree !== proof.destination.observedTree ||
      action.action.proof.mode !== proof.gitProof.mode ||
      action.action.proof.sourceAncestor !== proof.gitProof.sourceAncestor ||
      action.action.proof.baseAncestor !== proof.gitProof.baseAncestor ||
      action.action.proof.verifierVersion !== proof.gitProof.verifierVersion ||
      action.action.proof.evidenceDigest !== proof.gitProof.evidenceDigest ||
      action.action.proofLimitations.contentPreservation !== proof.proofLimitations.contentPreservation ||
      action.action.userReviewedPreflightDigest !== proof.userReviewedPreflightDigest ||
      action.action.correctionChain.sequence !== proof.correctionChain.sequence ||
      action.action.correctionChain.digest !== proof.correctionChain.digest
    )
      return { state: 'invalid', reason: 'completion_approval_mismatch' };
    return { state: 'valid', id: row.id, goalId, proof };
  } catch {
    return { state: 'invalid', reason: 'integrity_check_failed' };
  }
}
