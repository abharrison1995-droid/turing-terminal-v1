-- Stage 7C.2B.3: immutable, read-only manual integration handoffs.
-- A handoff is a prepared result identity, not a Git operation or completion proof.
CREATE TABLE goal_result_handoffs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind = 'turing_goal_manual_integration_handoff'),
  handoff_digest TEXT NOT NULL CHECK (length(handoff_digest) = 64 AND handoff_digest NOT GLOB '*[^0-9a-f]*'),
  definition_version INTEGER NOT NULL,
  final_acceptance_approval_id TEXT NOT NULL,
  final_review_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_tree TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  observed_base_commit TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 262144),
  created_at TEXT NOT NULL,
  UNIQUE (goal_id, id),
  UNIQUE (goal_id, handoff_digest),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions (goal_id, version),
  FOREIGN KEY (goal_id, final_acceptance_approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, final_review_id) REFERENCES goal_reviews (goal_id, id),
  CHECK (json_extract(payload_json, '$.schemaVersion') = schema_version),
  CHECK (json_extract(payload_json, '$.kind') = kind),
  CHECK (json_extract(payload_json, '$.handoffId') = id),
  CHECK (json_extract(payload_json, '$.goalId') = goal_id),
  CHECK (json_extract(payload_json, '$.handoffDigest') = handoff_digest),
  CHECK (json_extract(payload_json, '$.definition.version') = definition_version),
  CHECK (json_extract(payload_json, '$.finalAcceptance.approvalId') = final_acceptance_approval_id),
  CHECK (json_extract(payload_json, '$.review.finalReviewId') = final_review_id),
  CHECK (json_extract(payload_json, '$.source.commit') = source_commit),
  CHECK (json_extract(payload_json, '$.source.tree') = source_tree),
  CHECK (json_extract(payload_json, '$.target.baseRef') = base_ref),
  CHECK (json_extract(payload_json, '$.target.observedBaseCommit') = observed_base_commit),
  CHECK (
    (json_extract(payload_json, '$.repository.objectFormat') = 'sha1'
      AND length(source_commit) = 40 AND length(source_tree) = 40 AND length(observed_base_commit) = 40
      AND length(json_extract(payload_json, '$.target.observedBaseTree')) = 40
      AND source_commit NOT GLOB '*[^0-9a-f]*' AND source_tree NOT GLOB '*[^0-9a-f]*'
      AND observed_base_commit NOT GLOB '*[^0-9a-f]*'
      AND json_extract(payload_json, '$.target.observedBaseTree') NOT GLOB '*[^0-9a-f]*')
    OR
    (json_extract(payload_json, '$.repository.objectFormat') = 'sha256'
      AND length(source_commit) = 64 AND length(source_tree) = 64 AND length(observed_base_commit) = 64
      AND length(json_extract(payload_json, '$.target.observedBaseTree')) = 64
      AND source_commit NOT GLOB '*[^0-9a-f]*' AND source_tree NOT GLOB '*[^0-9a-f]*'
      AND observed_base_commit NOT GLOB '*[^0-9a-f]*'
      AND json_extract(payload_json, '$.target.observedBaseTree') NOT GLOB '*[^0-9a-f]*')
  )
);

CREATE INDEX idx_goal_result_handoffs_goal_created
  ON goal_result_handoffs (goal_id, created_at, id);
CREATE INDEX idx_goal_result_handoffs_source
  ON goal_result_handoffs (goal_id, source_commit, source_tree);

CREATE TRIGGER trg_goal_result_handoff_insert_authority
BEFORE INSERT ON goal_result_handoffs
WHEN NOT EXISTS (
  SELECT 1 FROM goal_definition_versions d
  JOIN goal_approvals da ON da.id = d.approval_id AND da.goal_id = d.goal_id
  WHERE d.goal_id = NEW.goal_id
    AND d.version = NEW.definition_version
    AND d.status = 'approved'
    AND d.definition_hash = json_extract(NEW.payload_json, '$.definition.hash')
    AND d.approval_id = json_extract(NEW.payload_json, '$.definition.approvalId')
    AND da.gate IN ('definition','amendment')
    AND da.status = 'approved'
    AND da.decided_by = 'user'
    AND json_extract(da.detail_json, '$.version') = d.version
    AND json_extract(da.detail_json, '$.definitionHash') = d.definition_hash
) OR NOT EXISTS (
  SELECT 1 FROM goal_approvals a
  WHERE a.id = NEW.final_acceptance_approval_id
    AND a.goal_id = NEW.goal_id
    AND a.gate = 'final_acceptance'
    AND a.status = 'approved'
    AND a.decided_by = 'user'
    AND json_extract(a.detail_json, '$.definitionVersion') = NEW.definition_version
    AND json_extract(a.detail_json, '$.definitionHash') = (
      SELECT d.definition_hash FROM goal_definition_versions d
      WHERE d.goal_id = NEW.goal_id AND d.version = NEW.definition_version AND d.status = 'approved'
    )
    AND json_extract(a.detail_json, '$.integrationHead') = NEW.source_commit
    AND json_extract(a.detail_json, '$.integrationTree') = NEW.source_tree
) OR NOT EXISTS (
  SELECT 1 FROM goal_reviews r
  WHERE r.id = NEW.final_review_id
    AND r.goal_id = NEW.goal_id
    AND r.review_kind = 'final'
    AND r.status = 'completed'
    AND r.verdict = 'pass'
    AND r.blocking = 0
    AND r.definition_version = NEW.definition_version
    AND r.reviewed_to_commit = NEW.source_commit
    AND r.reviewed_to_tree = NEW.source_tree
)
BEGIN
  SELECT RAISE(ABORT, 'manual handoff must bind current user acceptance and passing final review');
END;

CREATE TRIGGER trg_goal_result_handoff_immutable BEFORE UPDATE ON goal_result_handoffs
BEGIN SELECT RAISE(ABORT, 'manual handoffs are immutable'); END;
CREATE TRIGGER trg_goal_result_handoff_no_delete BEFORE DELETE ON goal_result_handoffs
BEGIN SELECT RAISE(ABORT, 'manual handoffs cannot be deleted'); END;
