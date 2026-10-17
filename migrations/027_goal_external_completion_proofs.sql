-- Stage 7C.2B.5D.1: versioned user-completion identity and immutable proof storage.
-- This migration adds no completion endpoint/service. Existing production flows cannot request this action or insert
-- these records; the table is infrastructure for a later, independently reviewed completion stage.

ALTER TABLE goal_approvals ADD COLUMN external_completion_action_digest TEXT
  CHECK (external_completion_action_digest IS NULL OR
    (length(external_completion_action_digest) = 64
      AND external_completion_action_digest NOT GLOB '*[^0-9a-f]*'));

DROP TRIGGER trg_goal_approval_identity;
CREATE TRIGGER trg_goal_approval_identity BEFORE UPDATE ON goal_approvals
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.gate IS NOT OLD.gate OR NEW.risk IS NOT OLD.risk
  OR NEW.reason IS NOT OLD.reason OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.detail_json IS NOT OLD.detail_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.intent_digest IS NOT OLD.intent_digest
  OR NEW.external_integration_action_digest IS NOT OLD.external_integration_action_digest
  OR NEW.external_completion_action_digest IS NOT OLD.external_completion_action_digest
BEGIN SELECT RAISE(ABORT, 'goal approval identity is immutable'); END;

CREATE TRIGGER trg_goal_approval_external_completion_action_guard BEFORE INSERT ON goal_approvals
WHEN (NEW.external_completion_action_digest IS NOT NULL AND (
       NEW.gate <> 'user_confirmation'
    OR NEW.risk <> 'high'
    OR NEW.requested_by <> 'user'
    OR NEW.intent_digest IS NOT NULL
    OR json_type(NEW.detail_json, '$.schemaVersion') IS NOT 'integer'
    OR json_extract(NEW.detail_json, '$.schemaVersion') <> 1
    OR json_type(NEW.detail_json, '$.action') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.action') <> 'complete_goal_external_integration_v2'
    OR json_extract(NEW.detail_json, '$.completionContractVersion') IS NOT 2
    OR json_extract(NEW.detail_json, '$.goalId') IS NOT NEW.goal_id
    OR json_extract(NEW.detail_json, '$.actionDigest') IS NOT NEW.external_completion_action_digest
    OR json_extract(NEW.detail_json, '$.proofLimitations.contentPreservation') IS NOT 'not_proven'
    OR json_extract(NEW.detail_json, '$.correctionChain.standing') IS NOT 'active_uncontested'
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json)) <> 20
  )) OR (json_extract(NEW.detail_json, '$.action') = 'complete_goal_external_integration_v2'
    AND NEW.external_completion_action_digest IS NULL)
BEGIN SELECT RAISE(ABORT, 'external completion approval action digest is invalid'); END;

CREATE UNIQUE INDEX idx_goal_approval_external_completion_action
  ON goal_approvals (goal_id, external_completion_action_digest)
  WHERE external_completion_action_digest IS NOT NULL;

CREATE TABLE goal_external_completion_proofs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind = 'turing_goal_external_completion_proof'),
  contract_version INTEGER NOT NULL CHECK (contract_version = 2),
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
  proof_digest TEXT NOT NULL CHECK (length(proof_digest) = 64 AND proof_digest NOT GLOB '*[^0-9a-f]*'),
  definition_version INTEGER NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
  definition_approval_id TEXT NOT NULL,
  definition_lineage_digest TEXT NOT NULL CHECK (length(definition_lineage_digest) = 64 AND definition_lineage_digest NOT GLOB '*[^0-9a-f]*'),
  handoff_id TEXT NOT NULL,
  handoff_digest TEXT NOT NULL CHECK (length(handoff_digest) = 64 AND handoff_digest NOT GLOB '*[^0-9a-f]*'),
  attestation_id TEXT NOT NULL,
  attestation_action_digest TEXT NOT NULL CHECK (length(attestation_action_digest) = 64 AND attestation_action_digest NOT GLOB '*[^0-9a-f]*'),
  attestation_record_digest TEXT NOT NULL CHECK (length(attestation_record_digest) = 64 AND attestation_record_digest NOT GLOB '*[^0-9a-f]*'),
  attestation_approval_id TEXT NOT NULL,
  completion_approval_id TEXT NOT NULL,
  final_review_id TEXT NOT NULL,
  final_acceptance_approval_id TEXT NOT NULL,
  verification_evidence_digest TEXT NOT NULL CHECK (length(verification_evidence_digest) = 64 AND verification_evidence_digest NOT GLOB '*[^0-9a-f]*'),
  milestone_identity_digest TEXT NOT NULL CHECK (length(milestone_identity_digest) = 64 AND milestone_identity_digest NOT GLOB '*[^0-9a-f]*'),
  finding_identity_digest TEXT NOT NULL CHECK (length(finding_identity_digest) = 64 AND finding_identity_digest NOT GLOB '*[^0-9a-f]*'),
  repository_project_id TEXT NOT NULL,
  repository_identity TEXT NOT NULL CHECK (length(repository_identity) = 64 AND repository_identity NOT GLOB '*[^0-9a-f]*'),
  repository_scope TEXT NOT NULL CHECK (length(repository_scope) <= 1000),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
  source_ref TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_tree TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  recorded_base_commit TEXT NOT NULL,
  recorded_base_tree TEXT NOT NULL,
  observed_destination_commit TEXT NOT NULL,
  observed_destination_tree TEXT NOT NULL,
  proof_mode TEXT NOT NULL CHECK (proof_mode = 'source_history_observed'),
  source_ancestor INTEGER NOT NULL CHECK (source_ancestor = 1),
  base_ancestor INTEGER NOT NULL CHECK (base_ancestor = 1),
  verifier_version INTEGER NOT NULL CHECK (verifier_version = 1),
  git_evidence_digest TEXT NOT NULL CHECK (length(git_evidence_digest) = 64 AND git_evidence_digest NOT GLOB '*[^0-9a-f]*'),
  preflight_digest TEXT NOT NULL CHECK (length(preflight_digest) = 64 AND preflight_digest NOT GLOB '*[^0-9a-f]*'),
  correction_chain_digest TEXT NOT NULL CHECK (length(correction_chain_digest) = 64 AND correction_chain_digest NOT GLOB '*[^0-9a-f]*'),
  correction_sequence INTEGER NOT NULL CHECK (correction_sequence >= 0),
  correction_standing TEXT NOT NULL CHECK (correction_standing = 'active_uncontested'),
  observed_at TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 262144),
  UNIQUE (goal_id, id),
  UNIQUE (goal_id, action_digest),
  UNIQUE (goal_id),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions (goal_id, version),
  FOREIGN KEY (goal_id, definition_approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, handoff_id) REFERENCES goal_result_handoffs (goal_id, id),
  FOREIGN KEY (goal_id, attestation_id) REFERENCES goal_external_integration_attestations (goal_id, id),
  FOREIGN KEY (goal_id, attestation_approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, completion_approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, final_review_id) REFERENCES goal_reviews (goal_id, id),
  FOREIGN KEY (goal_id, final_acceptance_approval_id) REFERENCES goal_approvals (goal_id, id),
  CHECK (json_extract(payload_json, '$.schemaVersion') IS schema_version),
  CHECK (json_extract(payload_json, '$.kind') IS kind),
  CHECK (json_extract(payload_json, '$.contractVersion') IS contract_version),
  CHECK (json_extract(payload_json, '$.goalId') IS goal_id),
  CHECK (json_extract(payload_json, '$.proofDigest') IS proof_digest),
  CHECK (json_extract(payload_json, '$.decision.actionDigest') IS action_digest),
  CHECK (json_extract(payload_json, '$.decision.classification') IS 'user_confirmed_historical_external_integration'),
  CHECK (json_extract(payload_json, '$.definition.version') IS definition_version),
  CHECK (json_extract(payload_json, '$.definition.hash') IS definition_hash),
  CHECK (json_extract(payload_json, '$.definition.approvalId') IS definition_approval_id),
  CHECK (json_extract(payload_json, '$.definition.lineageDigest') IS definition_lineage_digest),
  CHECK (json_extract(payload_json, '$.evaluation.integrationHead') IS source_commit),
  CHECK (json_extract(payload_json, '$.evaluation.integrationTree') IS source_tree),
  CHECK (json_extract(payload_json, '$.handoff.id') IS handoff_id),
  CHECK (json_extract(payload_json, '$.handoff.digest') IS handoff_digest),
  CHECK (json_extract(payload_json, '$.attestation.id') IS attestation_id),
  CHECK (json_extract(payload_json, '$.attestation.actionDigest') IS attestation_action_digest),
  CHECK (json_extract(payload_json, '$.attestation.recordDigest') IS attestation_record_digest),
  CHECK (json_extract(payload_json, '$.attestation.approvalId') IS attestation_approval_id),
  CHECK (json_extract(payload_json, '$.decision.approvalId') IS completion_approval_id),
  CHECK (json_extract(payload_json, '$.evaluation.finalReviewId') IS final_review_id),
  CHECK (json_extract(payload_json, '$.evaluation.finalAcceptanceApprovalId') IS final_acceptance_approval_id),
  CHECK (json_extract(payload_json, '$.evaluation.verificationEvidenceDigest') IS verification_evidence_digest),
  CHECK (json_extract(payload_json, '$.evaluation.milestoneIdentityDigest') IS milestone_identity_digest),
  CHECK (json_extract(payload_json, '$.evaluation.findingIdentityDigest') IS finding_identity_digest),
  CHECK (json_extract(payload_json, '$.repository.projectId') IS repository_project_id),
  CHECK (json_extract(payload_json, '$.repository.identity') IS repository_identity),
  CHECK (json_extract(payload_json, '$.repository.scope') IS repository_scope),
  CHECK (json_extract(payload_json, '$.repository.objectFormat') IS object_format),
  CHECK (json_extract(payload_json, '$.source.ref') IS source_ref),
  CHECK (json_extract(payload_json, '$.source.commit') IS source_commit),
  CHECK (json_extract(payload_json, '$.source.tree') IS source_tree),
  CHECK (json_extract(payload_json, '$.destination.ref') IS destination_ref),
  CHECK (json_extract(payload_json, '$.destination.recordedBaseCommit') IS recorded_base_commit),
  CHECK (json_extract(payload_json, '$.destination.recordedBaseTree') IS recorded_base_tree),
  CHECK (json_extract(payload_json, '$.destination.observedCommit') IS observed_destination_commit),
  CHECK (json_extract(payload_json, '$.destination.observedTree') IS observed_destination_tree),
  CHECK (json_extract(payload_json, '$.gitProof.mode') IS proof_mode),
  CHECK (json_extract(payload_json, '$.gitProof.sourceAncestor') IS source_ancestor),
  CHECK (json_extract(payload_json, '$.gitProof.baseAncestor') IS base_ancestor),
  CHECK (json_extract(payload_json, '$.gitProof.verifierVersion') IS verifier_version),
  CHECK (json_extract(payload_json, '$.gitProof.evidenceDigest') IS git_evidence_digest),
  CHECK (json_extract(payload_json, '$.userReviewedPreflightDigest') IS preflight_digest),
  CHECK (json_extract(payload_json, '$.correctionChain.digest') IS correction_chain_digest),
  CHECK (json_extract(payload_json, '$.correctionChain.sequence') IS correction_sequence),
  CHECK (json_extract(payload_json, '$.correctionChain.standing') IS correction_standing),
  CHECK (json_extract(payload_json, '$.correctionChain.attestationId') IS attestation_id),
  CHECK (json_extract(payload_json, '$.gitProof.observedAt') IS observed_at),
  CHECK (json_extract(payload_json, '$.decision.decidedAt') IS decided_at),
  CHECK (json_extract(payload_json, '$.proofLimitations.contentPreservation') IS 'not_proven'),
  CHECK (
    (object_format = 'sha1'
      AND length(source_commit) = 40 AND length(source_tree) = 40
      AND length(recorded_base_commit) = 40 AND length(recorded_base_tree) = 40
      AND length(observed_destination_commit) = 40 AND length(observed_destination_tree) = 40
      AND source_commit NOT GLOB '*[^0-9a-f]*' AND source_tree NOT GLOB '*[^0-9a-f]*'
      AND recorded_base_commit NOT GLOB '*[^0-9a-f]*' AND recorded_base_tree NOT GLOB '*[^0-9a-f]*'
      AND observed_destination_commit NOT GLOB '*[^0-9a-f]*' AND observed_destination_tree NOT GLOB '*[^0-9a-f]*')
    OR
    (object_format = 'sha256'
      AND length(source_commit) = 64 AND length(source_tree) = 64
      AND length(recorded_base_commit) = 64 AND length(recorded_base_tree) = 64
      AND length(observed_destination_commit) = 64 AND length(observed_destination_tree) = 64
      AND source_commit NOT GLOB '*[^0-9a-f]*' AND source_tree NOT GLOB '*[^0-9a-f]*'
      AND recorded_base_commit NOT GLOB '*[^0-9a-f]*' AND recorded_base_tree NOT GLOB '*[^0-9a-f]*'
      AND observed_destination_commit NOT GLOB '*[^0-9a-f]*' AND observed_destination_tree NOT GLOB '*[^0-9a-f]*')
  )
);

CREATE INDEX idx_goal_external_completion_definition
  ON goal_external_completion_proofs (goal_id, definition_version, definition_hash);
CREATE INDEX idx_goal_external_completion_handoff
  ON goal_external_completion_proofs (goal_id, handoff_id, handoff_digest);
CREATE INDEX idx_goal_external_completion_attestation
  ON goal_external_completion_proofs (goal_id, attestation_id, attestation_record_digest);
CREATE INDEX idx_goal_external_completion_repository
  ON goal_external_completion_proofs (repository_project_id, repository_identity);

CREATE TRIGGER trg_goal_external_completion_proof_insert_authority
BEFORE INSERT ON goal_external_completion_proofs
WHEN NOT EXISTS (
  SELECT 1 FROM goal_approvals a
  WHERE a.id = NEW.completion_approval_id AND a.goal_id = NEW.goal_id
    AND a.gate = 'user_confirmation' AND a.risk = 'high' AND a.requested_by = 'user'
    AND a.status = 'approved' AND a.decided_by = 'user'
    AND a.external_completion_action_digest = NEW.action_digest
    AND json_extract(a.detail_json, '$.action') = 'complete_goal_external_integration_v2'
    AND json_extract(a.detail_json, '$.actionDigest') = NEW.action_digest
    AND json_extract(a.detail_json, '$.goalId') = NEW.goal_id
    AND json_extract(a.detail_json, '$.definition.version') = NEW.definition_version
    AND json_extract(a.detail_json, '$.definition.hash') = NEW.definition_hash
    AND json_extract(a.detail_json, '$.definition.approvalId') = NEW.definition_approval_id
    AND json_extract(a.detail_json, '$.definition.lineageDigest') = NEW.definition_lineage_digest
    AND json_extract(a.detail_json, '$.completionContractVersion') = 2
    AND json_extract(a.detail_json, '$.integrationMode') = 'external_user_attested'
    AND json_extract(a.detail_json, '$.handoff.id') = NEW.handoff_id
    AND json_extract(a.detail_json, '$.handoff.digest') = NEW.handoff_digest
    AND json_extract(a.detail_json, '$.attestation.id') = NEW.attestation_id
    AND json_extract(a.detail_json, '$.attestation.actionDigest') = NEW.attestation_action_digest
    AND json_extract(a.detail_json, '$.attestation.recordDigest') = NEW.attestation_record_digest
    AND json_extract(a.detail_json, '$.attestation.approvalId') = NEW.attestation_approval_id
    AND json_extract(a.detail_json, '$.review.finalReviewId') = NEW.final_review_id
    AND json_extract(a.detail_json, '$.review.acceptanceApprovalId') = NEW.final_acceptance_approval_id
    AND json_extract(a.detail_json, '$.verificationEvidenceDigest') = NEW.verification_evidence_digest
    AND json_extract(a.detail_json, '$.milestoneIdentityDigest') = NEW.milestone_identity_digest
    AND json_extract(a.detail_json, '$.findingIdentityDigest') = NEW.finding_identity_digest
    AND json_extract(a.detail_json, '$.repository.projectId') = NEW.repository_project_id
    AND json_extract(a.detail_json, '$.repository.identity') = NEW.repository_identity
    AND json_extract(a.detail_json, '$.repository.scope') = NEW.repository_scope
    AND json_extract(a.detail_json, '$.repository.objectFormat') = NEW.object_format
    AND json_extract(a.detail_json, '$.source.ref') = NEW.source_ref
    AND json_extract(a.detail_json, '$.source.commit') = NEW.source_commit
    AND json_extract(a.detail_json, '$.source.tree') = NEW.source_tree
    AND json_extract(a.detail_json, '$.destination.ref') = NEW.destination_ref
    AND json_extract(a.detail_json, '$.destination.recordedBaseCommit') = NEW.recorded_base_commit
    AND json_extract(a.detail_json, '$.destination.recordedBaseTree') = NEW.recorded_base_tree
    AND json_extract(a.detail_json, '$.destination.observedCommit') = NEW.observed_destination_commit
    AND json_extract(a.detail_json, '$.destination.observedTree') = NEW.observed_destination_tree
    AND json_extract(a.detail_json, '$.proof.mode') = NEW.proof_mode
    AND json_extract(a.detail_json, '$.proof.sourceAncestor') = NEW.source_ancestor
    AND json_extract(a.detail_json, '$.proof.baseAncestor') = NEW.base_ancestor
    AND json_extract(a.detail_json, '$.proof.verifierVersion') = NEW.verifier_version
    AND json_extract(a.detail_json, '$.proof.evidenceDigest') = NEW.git_evidence_digest
    AND json_extract(a.detail_json, '$.proofLimitations.contentPreservation') = 'not_proven'
    AND json_extract(a.detail_json, '$.userReviewedPreflightDigest') = NEW.preflight_digest
    AND json_extract(a.detail_json, '$.correctionChain.digest') = NEW.correction_chain_digest
    AND json_extract(a.detail_json, '$.correctionChain.attestationId') = NEW.attestation_id
    AND json_extract(a.detail_json, '$.correctionChain.sequence') = NEW.correction_sequence
    AND json_extract(a.detail_json, '$.correctionChain.standing') = NEW.correction_standing
) OR NOT EXISTS (
  SELECT 1 FROM goals g
  JOIN goal_definition_versions d ON d.goal_id = g.id AND d.version = NEW.definition_version
  JOIN goal_approvals da ON da.id = d.approval_id AND da.goal_id = d.goal_id
  WHERE g.id = NEW.goal_id AND g.project_id = NEW.repository_project_id
    AND g.current_definition_version = NEW.definition_version
    AND d.status = 'approved' AND d.approved_by = 'user' AND d.definition_hash = NEW.definition_hash
    AND d.approval_id = NEW.definition_approval_id
    AND json_extract(d.contract_json, '$.completionPolicy.completionContractVersion') = 2
    AND json_extract(d.contract_json, '$.completionPolicy.integrationMode') = 'external_user_attested'
    AND json_extract(d.contract_json, '$.completionPolicy.applyToBase') = 'required'
    AND json_extract(d.contract_json, '$.completionPolicy.requireFinalReview') = 1
    AND json_extract(d.contract_json, '$.completionPolicy.requireUserAcceptance') = 1
    AND da.gate IN ('definition','amendment') AND da.status = 'approved' AND da.decided_by = 'user'
    AND json_extract(da.detail_json, '$.version') = d.version
    AND json_extract(da.detail_json, '$.definitionHash') = d.definition_hash
) OR NOT EXISTS (
  SELECT 1 FROM goal_result_handoffs h
  WHERE h.id = NEW.handoff_id AND h.goal_id = NEW.goal_id AND h.handoff_digest = NEW.handoff_digest
    AND h.definition_version = NEW.definition_version
    AND h.final_review_id = NEW.final_review_id
    AND h.final_acceptance_approval_id = NEW.final_acceptance_approval_id
    AND h.source_commit = NEW.source_commit AND h.source_tree = NEW.source_tree
    AND h.base_ref = NEW.destination_ref AND h.observed_base_commit = NEW.recorded_base_commit
    AND json_extract(h.payload_json, '$.definition.hash') = NEW.definition_hash
    AND json_extract(h.payload_json, '$.repository.projectId') = NEW.repository_project_id
    AND json_extract(h.payload_json, '$.repository.identity') = NEW.repository_identity
    AND json_extract(h.payload_json, '$.repository.scope') = NEW.repository_scope
    AND json_extract(h.payload_json, '$.repository.objectFormat') = NEW.object_format
    AND json_extract(h.payload_json, '$.target.observedBaseTree') = NEW.recorded_base_tree
) OR NOT EXISTS (
  SELECT 1 FROM goal_external_integration_attestations a
  WHERE a.id = NEW.attestation_id AND a.goal_id = NEW.goal_id
    AND a.action_digest = NEW.attestation_action_digest AND a.record_digest = NEW.attestation_record_digest
    AND a.approval_id = NEW.attestation_approval_id AND a.handoff_id = NEW.handoff_id
    AND a.handoff_digest = NEW.handoff_digest AND a.definition_version = NEW.definition_version
    AND a.definition_hash = NEW.definition_hash AND a.definition_approval_id = NEW.definition_approval_id
    AND a.final_review_id = NEW.final_review_id AND a.acceptance_approval_id = NEW.final_acceptance_approval_id
    AND a.repository_project_id = NEW.repository_project_id AND a.repository_identity = NEW.repository_identity
    AND a.repository_scope = NEW.repository_scope AND a.object_format = NEW.object_format
    AND a.source_ref = NEW.source_ref AND a.source_commit = NEW.source_commit AND a.source_tree = NEW.source_tree
    AND a.destination_ref = NEW.destination_ref AND a.expected_base_commit = NEW.recorded_base_commit
    AND a.expected_base_tree = NEW.recorded_base_tree
    AND a.observed_destination_commit = NEW.observed_destination_commit
    AND a.observed_destination_tree = NEW.observed_destination_tree
) OR NOT EXISTS (
  SELECT 1 FROM goal_reviews r
  WHERE r.id = NEW.final_review_id AND r.goal_id = NEW.goal_id AND r.definition_version = NEW.definition_version
    AND r.review_kind = 'final' AND r.status = 'completed' AND r.verdict = 'pass' AND r.blocking = 0
    AND r.reviewed_to_commit = NEW.source_commit AND r.reviewed_to_tree = NEW.source_tree
) OR NOT EXISTS (
  SELECT 1 FROM goal_approvals a
  WHERE a.id = NEW.final_acceptance_approval_id AND a.goal_id = NEW.goal_id
    AND a.gate = 'final_acceptance' AND a.status = 'approved' AND a.decided_by = 'user'
    AND json_extract(a.detail_json, '$.definitionVersion') = NEW.definition_version
    AND json_extract(a.detail_json, '$.definitionHash') = NEW.definition_hash
    AND json_extract(a.detail_json, '$.integrationHead') = NEW.source_commit
    AND json_extract(a.detail_json, '$.integrationTree') = NEW.source_tree
)
BEGIN SELECT RAISE(ABORT, 'external completion proof lacks exact v2 user authority'); END;

CREATE TRIGGER trg_goal_external_completion_proof_immutable BEFORE UPDATE ON goal_external_completion_proofs
BEGIN SELECT RAISE(ABORT, 'external completion proofs are immutable'); END;
CREATE TRIGGER trg_goal_external_completion_proof_no_delete BEFORE DELETE ON goal_external_completion_proofs
BEGIN SELECT RAISE(ABORT, 'external completion proofs cannot be deleted'); END;
