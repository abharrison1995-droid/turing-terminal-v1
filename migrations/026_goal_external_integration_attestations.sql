-- Stage 7C.2B.5B: separate immutable authority for user-confirmed external integration.
-- This is historical evidence about a user Git operation; it is not a Turing Git operation or completion proof.

ALTER TABLE goal_approvals ADD COLUMN external_integration_action_digest TEXT
  CHECK (external_integration_action_digest IS NULL OR
    (length(external_integration_action_digest) = 64 AND external_integration_action_digest NOT GLOB '*[^0-9a-f]*'));

DROP TRIGGER trg_goal_approval_identity;
CREATE TRIGGER trg_goal_approval_identity BEFORE UPDATE ON goal_approvals
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.gate IS NOT OLD.gate OR NEW.risk IS NOT OLD.risk
  OR NEW.reason IS NOT OLD.reason OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.detail_json IS NOT OLD.detail_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.intent_digest IS NOT OLD.intent_digest
  OR NEW.external_integration_action_digest IS NOT OLD.external_integration_action_digest
BEGIN SELECT RAISE(ABORT, 'goal approval identity is immutable'); END;

CREATE TRIGGER trg_goal_approval_external_action_guard BEFORE INSERT ON goal_approvals
WHEN (NEW.external_integration_action_digest IS NOT NULL AND (
       NEW.gate <> 'final_apply'
    OR NEW.risk <> 'high'
    OR NEW.requested_by <> 'user'
    OR NEW.intent_digest IS NOT NULL
    OR json_type(NEW.detail_json, '$.schemaVersion') IS NOT 'integer'
    OR json_extract(NEW.detail_json, '$.schemaVersion') <> 2
    OR json_type(NEW.detail_json, '$.action') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.action') <> 'confirm_external_integration'
    OR json_type(NEW.detail_json, '$.actionDigest') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.actionDigest') IS NOT NEW.external_integration_action_digest
    OR json_extract(NEW.detail_json, '$.goalId') IS NOT NEW.goal_id
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json)) <> 27
  )) OR (json_extract(NEW.detail_json, '$.action') = 'confirm_external_integration'
    AND NEW.external_integration_action_digest IS NULL)
BEGIN SELECT RAISE(ABORT, 'external integration approval action digest is invalid'); END;

CREATE UNIQUE INDEX idx_goal_approval_external_action
  ON goal_approvals (goal_id, external_integration_action_digest)
  WHERE external_integration_action_digest IS NOT NULL;

CREATE TABLE goal_external_integration_attestations (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind = 'turing_goal_external_integration_attestation'),
  approval_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  handoff_digest TEXT NOT NULL CHECK (length(handoff_digest) = 64 AND handoff_digest NOT GLOB '*[^0-9a-f]*'),
  completion_contract_version INTEGER NOT NULL CHECK (completion_contract_version = 2),
  definition_version INTEGER NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
  definition_approval_id TEXT NOT NULL,
  final_review_id TEXT NOT NULL,
  acceptance_approval_id TEXT NOT NULL,
  repository_project_id TEXT NOT NULL,
  repository_identity TEXT NOT NULL CHECK (length(repository_identity) = 64 AND repository_identity NOT GLOB '*[^0-9a-f]*'),
  repository_scope TEXT NOT NULL CHECK (length(repository_scope) <= 1000),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
  source_ref TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_tree TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  expected_base_commit TEXT NOT NULL,
  expected_base_tree TEXT NOT NULL,
  observed_destination_commit TEXT NOT NULL,
  observed_destination_tree TEXT NOT NULL,
  proof_mode TEXT NOT NULL CHECK (proof_mode = 'source_history_observed'),
  verifier_version INTEGER NOT NULL CHECK (verifier_version = 1),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64 AND record_digest NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 131072),
  UNIQUE (goal_id, id),
  UNIQUE (goal_id, action_digest),
  FOREIGN KEY (goal_id, approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, handoff_id) REFERENCES goal_result_handoffs (goal_id, id),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions (goal_id, version),
  FOREIGN KEY (goal_id, final_review_id) REFERENCES goal_reviews (goal_id, id),
  FOREIGN KEY (goal_id, acceptance_approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, definition_approval_id) REFERENCES goal_approvals (goal_id, id),
  CHECK (json_extract(payload_json, '$.schemaVersion') IS schema_version),
  CHECK (json_extract(payload_json, '$.kind') IS kind),
  CHECK (json_extract(payload_json, '$.attestationId') IS id),
  CHECK (json_extract(payload_json, '$.goalId') IS goal_id),
  CHECK (json_extract(payload_json, '$.approvalId') IS approval_id),
  CHECK (json_extract(payload_json, '$.handoff.id') IS handoff_id),
  CHECK (json_extract(payload_json, '$.handoff.digest') IS handoff_digest),
  CHECK (json_extract(payload_json, '$.completionContractVersion') IS completion_contract_version),
  CHECK (json_extract(payload_json, '$.definition.version') IS definition_version),
  CHECK (json_extract(payload_json, '$.definition.hash') IS definition_hash),
  CHECK (json_extract(payload_json, '$.definition.approvalId') IS definition_approval_id),
  CHECK (json_extract(payload_json, '$.review.finalReviewId') IS final_review_id),
  CHECK (json_extract(payload_json, '$.review.acceptanceApprovalId') IS acceptance_approval_id),
  CHECK (json_extract(payload_json, '$.repository.projectId') IS repository_project_id),
  CHECK (json_extract(payload_json, '$.repository.identity') IS repository_identity),
  CHECK (json_extract(payload_json, '$.repository.scope') IS repository_scope),
  CHECK (json_extract(payload_json, '$.repository.objectFormat') IS object_format),
  CHECK (json_extract(payload_json, '$.source.ref') IS source_ref),
  CHECK (json_extract(payload_json, '$.source.commit') IS source_commit),
  CHECK (json_extract(payload_json, '$.source.tree') IS source_tree),
  CHECK (json_extract(payload_json, '$.destination.ref') IS destination_ref),
  CHECK (json_extract(payload_json, '$.destination.expectedBaseCommit') IS expected_base_commit),
  CHECK (json_extract(payload_json, '$.destination.expectedBaseTree') IS expected_base_tree),
  CHECK (json_extract(payload_json, '$.destination.observedCommit') IS observed_destination_commit),
  CHECK (json_extract(payload_json, '$.destination.observedTree') IS observed_destination_tree),
  CHECK (json_extract(payload_json, '$.proof.mode') IS proof_mode),
  CHECK (json_extract(payload_json, '$.proof.sourceAncestor') IS 1),
  CHECK (json_extract(payload_json, '$.proof.baseAncestor') IS 1),
  CHECK (json_extract(payload_json, '$.proof.verifierVersion') IS verifier_version),
  CHECK (json_extract(payload_json, '$.proof.evidenceDigest') IS evidence_digest),
  CHECK (json_extract(payload_json, '$.actionDigest') IS action_digest),
  CHECK (json_extract(payload_json, '$.recordDigest') IS record_digest),
  CHECK (json_extract(payload_json, '$.observedAt') IS observed_at),
  CHECK (json_extract(payload_json, '$.decision.value') IS 'confirm_external_integration'),
  CHECK (json_extract(payload_json, '$.decision.decidedBy') IS 'user'),
  CHECK (json_extract(payload_json, '$.decision.decidedAt') IS decided_at),
  CHECK (
    (object_format = 'sha1'
      AND length(source_commit) = 40 AND length(source_tree) = 40
      AND length(expected_base_commit) = 40 AND length(expected_base_tree) = 40
      AND length(observed_destination_commit) = 40 AND length(observed_destination_tree) = 40
      AND source_commit NOT GLOB '*[^0-9a-f]*' AND source_tree NOT GLOB '*[^0-9a-f]*'
      AND expected_base_commit NOT GLOB '*[^0-9a-f]*' AND expected_base_tree NOT GLOB '*[^0-9a-f]*'
      AND observed_destination_commit NOT GLOB '*[^0-9a-f]*' AND observed_destination_tree NOT GLOB '*[^0-9a-f]*')
    OR
    (object_format = 'sha256'
      AND length(source_commit) = 64 AND length(source_tree) = 64
      AND length(expected_base_commit) = 64 AND length(expected_base_tree) = 64
      AND length(observed_destination_commit) = 64 AND length(observed_destination_tree) = 64
      AND source_commit NOT GLOB '*[^0-9a-f]*' AND source_tree NOT GLOB '*[^0-9a-f]*'
      AND expected_base_commit NOT GLOB '*[^0-9a-f]*' AND expected_base_tree NOT GLOB '*[^0-9a-f]*'
      AND observed_destination_commit NOT GLOB '*[^0-9a-f]*' AND observed_destination_tree NOT GLOB '*[^0-9a-f]*')
  )
);

CREATE INDEX idx_goal_external_attestation_source
  ON goal_external_integration_attestations (goal_id, source_commit, source_tree);
CREATE INDEX idx_goal_external_attestation_destination
  ON goal_external_integration_attestations (goal_id, destination_ref, observed_destination_commit);
CREATE INDEX idx_goal_external_attestation_repository
  ON goal_external_integration_attestations (repository_project_id, repository_identity);

CREATE TRIGGER trg_goal_external_attestation_insert_authority
BEFORE INSERT ON goal_external_integration_attestations
WHEN NOT EXISTS (
  SELECT 1 FROM goal_approvals a
  WHERE a.id = NEW.approval_id AND a.goal_id = NEW.goal_id
    AND a.gate = 'final_apply' AND a.risk = 'high' AND a.requested_by = 'user'
    AND a.status = 'approved' AND a.decided_by = 'user'
    AND a.intent_digest IS NULL
    AND a.external_integration_action_digest = NEW.action_digest
    AND json_extract(a.detail_json, '$.schemaVersion') = 2
    AND json_extract(a.detail_json, '$.action') = 'confirm_external_integration'
    AND json_extract(a.detail_json, '$.actionDigest') = NEW.action_digest
    AND json_extract(a.detail_json, '$.goalId') = NEW.goal_id
    AND json_extract(a.detail_json, '$.handoffId') = NEW.handoff_id
    AND json_extract(a.detail_json, '$.handoffDigest') = NEW.handoff_digest
    AND json_extract(a.detail_json, '$.completionContractVersion') = NEW.completion_contract_version
    AND json_extract(a.detail_json, '$.definitionVersion') = NEW.definition_version
    AND json_extract(a.detail_json, '$.definitionHash') = NEW.definition_hash
    AND json_extract(a.detail_json, '$.definitionApprovalId') = NEW.definition_approval_id
    AND json_extract(a.detail_json, '$.finalReviewId') = NEW.final_review_id
    AND json_extract(a.detail_json, '$.acceptanceApprovalId') = NEW.acceptance_approval_id
    AND json_extract(a.detail_json, '$.repositoryProjectId') = NEW.repository_project_id
    AND json_extract(a.detail_json, '$.repositoryIdentity') = NEW.repository_identity
    AND json_extract(a.detail_json, '$.repositoryScope') = NEW.repository_scope
    AND json_extract(a.detail_json, '$.objectFormat') = NEW.object_format
    AND json_extract(a.detail_json, '$.sourceRef') = NEW.source_ref
    AND json_extract(a.detail_json, '$.sourceCommit') = NEW.source_commit
    AND json_extract(a.detail_json, '$.sourceTree') = NEW.source_tree
    AND json_extract(a.detail_json, '$.destinationRef') = NEW.destination_ref
    AND json_extract(a.detail_json, '$.expectedBaseCommit') = NEW.expected_base_commit
    AND json_extract(a.detail_json, '$.expectedBaseTree') = NEW.expected_base_tree
    AND json_extract(a.detail_json, '$.observedDestinationCommit') = NEW.observed_destination_commit
    AND json_extract(a.detail_json, '$.observedDestinationTree') = NEW.observed_destination_tree
    AND json_extract(a.detail_json, '$.proofMode') = NEW.proof_mode
    AND json_extract(a.detail_json, '$.verifierVersion') = NEW.verifier_version
    AND json_extract(a.detail_json, '$.evidenceDigest') = NEW.evidence_digest
) OR NOT EXISTS (
  SELECT 1 FROM goal_result_handoffs h
  WHERE h.id = NEW.handoff_id AND h.goal_id = NEW.goal_id AND h.handoff_digest = NEW.handoff_digest
    AND h.definition_version = NEW.definition_version
    AND h.final_acceptance_approval_id = NEW.acceptance_approval_id
    AND h.final_review_id = NEW.final_review_id
    AND h.source_commit = NEW.source_commit AND h.source_tree = NEW.source_tree
    AND h.base_ref = NEW.destination_ref
    AND h.observed_base_commit = NEW.expected_base_commit
    AND json_extract(h.payload_json, '$.definition.hash') = NEW.definition_hash
    AND json_extract(h.payload_json, '$.definition.approvalId') = NEW.definition_approval_id
    AND json_extract(h.payload_json, '$.repository.projectId') = NEW.repository_project_id
    AND json_extract(h.payload_json, '$.repository.identity') = NEW.repository_identity
    AND json_extract(h.payload_json, '$.repository.scope') = NEW.repository_scope
    AND json_extract(h.payload_json, '$.repository.objectFormat') = NEW.object_format
    AND json_extract(h.payload_json, '$.source.goalRef') = NEW.source_ref
    AND json_extract(h.payload_json, '$.target.observedBaseTree') = NEW.expected_base_tree
) OR NOT EXISTS (
  SELECT 1 FROM goals g
  JOIN goal_definition_versions d ON d.goal_id = g.id AND d.version = NEW.definition_version
  JOIN goal_approvals da ON da.goal_id = d.goal_id AND da.id = d.approval_id
  WHERE g.id = NEW.goal_id AND g.current_definition_version = NEW.definition_version
    AND d.status = 'approved' AND d.approved_by = 'user' AND d.definition_hash = NEW.definition_hash
    AND d.approval_id = NEW.definition_approval_id AND da.status = 'approved' AND da.decided_by = 'user'
    AND da.gate IN ('definition','amendment')
) OR NOT EXISTS (
  SELECT 1 FROM goal_reviews r
  WHERE r.id = NEW.final_review_id AND r.goal_id = NEW.goal_id
    AND r.review_kind = 'final' AND r.status = 'completed' AND r.verdict = 'pass' AND r.blocking = 0
    AND r.definition_version = NEW.definition_version
    AND r.reviewed_to_commit = NEW.source_commit AND r.reviewed_to_tree = NEW.source_tree
) OR NOT EXISTS (
  SELECT 1 FROM goal_approvals a
  WHERE a.id = NEW.acceptance_approval_id AND a.goal_id = NEW.goal_id
    AND a.gate = 'final_acceptance' AND a.status = 'approved' AND a.decided_by = 'user'
    AND json_extract(a.detail_json, '$.definitionVersion') = NEW.definition_version
    AND json_extract(a.detail_json, '$.definitionHash') = NEW.definition_hash
    AND json_extract(a.detail_json, '$.integrationHead') = NEW.source_commit
    AND json_extract(a.detail_json, '$.integrationTree') = NEW.source_tree
)
BEGIN SELECT RAISE(ABORT, 'external integration attestation lacks exact approved authority'); END;

CREATE TRIGGER trg_goal_external_attestation_immutable BEFORE UPDATE ON goal_external_integration_attestations
BEGIN SELECT RAISE(ABORT, 'external integration attestations are immutable'); END;
CREATE TRIGGER trg_goal_external_attestation_no_delete BEFORE DELETE ON goal_external_integration_attestations
BEGIN SELECT RAISE(ABORT, 'external integration attestations cannot be deleted'); END;
