-- Content-verified integration evidence, verifier `content-verified-v1` (verifier version 2).
-- This is an additive evidence table only. It adds no completion endpoint, no completion proof, no Goal transition and
-- no Git writer. The existing v1 attestation and completion-proof tables, their CHECK constraints and their triggers
-- are left exactly as they are; a verifier version 2 row is rejected there.

CREATE TABLE goal_content_verifications (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind = 'turing_goal_content_verification'),
  verifier TEXT NOT NULL CHECK (verifier = 'content-verified-v1'),
  verifier_version INTEGER NOT NULL CHECK (verifier_version = 2),
  status TEXT NOT NULL CHECK (status IN ('verified', 'content_not_preserved')),
  changed_path_count INTEGER NOT NULL CHECK (changed_path_count BETWEEN 0 AND 10000),
  mismatch_count INTEGER NOT NULL CHECK (mismatch_count BETWEEN 0 AND changed_path_count),
  mismatch_path_digest TEXT NOT NULL CHECK (
    length(mismatch_path_digest) = 64 AND mismatch_path_digest NOT GLOB '*[^0-9a-f]*'
  ),
  verification_digest TEXT NOT NULL CHECK (
    length(verification_digest) = 64 AND verification_digest NOT GLOB '*[^0-9a-f]*'
  ),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  expected_base_commit TEXT NOT NULL,
  accepted_source_commit TEXT NOT NULL,
  destination_ref TEXT NOT NULL CHECK (length(destination_ref) BETWEEN 1 AND 500),
  destination_tip_commit TEXT NOT NULL,
  comparison_commit TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  record_digest TEXT NOT NULL CHECK (
    length(record_digest) = 64 AND record_digest NOT GLOB '*[^0-9a-f]*'
  ),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 65536),
  UNIQUE (goal_id, id),
  UNIQUE (goal_id, verification_digest),
  CHECK ((status = 'verified' AND mismatch_count = 0)
    OR (status = 'content_not_preserved' AND mismatch_count > 0)),
  CHECK (json_extract(payload_json, '$.schemaVersion') IS schema_version),
  CHECK (json_extract(payload_json, '$.kind') IS kind),
  CHECK (json_extract(payload_json, '$.verificationId') IS id),
  CHECK (json_extract(payload_json, '$.goalId') IS goal_id),
  CHECK (json_extract(payload_json, '$.verifier') IS verifier),
  CHECK (json_extract(payload_json, '$.verifierVersion') IS verifier_version),
  CHECK (json_extract(payload_json, '$.status') IS status),
  CHECK (json_extract(payload_json, '$.changedPathCount') IS changed_path_count),
  CHECK (json_extract(payload_json, '$.mismatchCount') IS mismatch_count),
  CHECK (json_extract(payload_json, '$.mismatchPathDigest') IS mismatch_path_digest),
  CHECK (json_extract(payload_json, '$.verificationDigest') IS verification_digest),
  CHECK (json_extract(payload_json, '$.repository.objectFormat') IS object_format),
  CHECK (json_extract(payload_json, '$.source.commit') IS accepted_source_commit),
  CHECK (json_extract(payload_json, '$.destination.ref') IS destination_ref),
  CHECK (json_extract(payload_json, '$.destination.expectedBaseCommit') IS expected_base_commit),
  CHECK (json_extract(payload_json, '$.destination.tipCommit') IS destination_tip_commit),
  CHECK (json_extract(payload_json, '$.destination.comparisonCommit') IS comparison_commit),
  CHECK (json_extract(payload_json, '$.observedAt') IS observed_at),
  CHECK (json_extract(payload_json, '$.recordDigest') IS record_digest),
  CHECK (
    (object_format = 'sha1'
      AND length(expected_base_commit) = 40 AND length(accepted_source_commit) = 40
      AND length(destination_tip_commit) = 40 AND length(comparison_commit) = 40
      AND expected_base_commit NOT GLOB '*[^0-9a-f]*'
      AND accepted_source_commit NOT GLOB '*[^0-9a-f]*'
      AND destination_tip_commit NOT GLOB '*[^0-9a-f]*'
      AND comparison_commit NOT GLOB '*[^0-9a-f]*')
    OR
    (object_format = 'sha256'
      AND length(expected_base_commit) = 64 AND length(accepted_source_commit) = 64
      AND length(destination_tip_commit) = 64 AND length(comparison_commit) = 64
      AND expected_base_commit NOT GLOB '*[^0-9a-f]*'
      AND accepted_source_commit NOT GLOB '*[^0-9a-f]*'
      AND destination_tip_commit NOT GLOB '*[^0-9a-f]*'
      AND comparison_commit NOT GLOB '*[^0-9a-f]*')
  )
);

CREATE INDEX idx_goal_content_verification_goal
  ON goal_content_verifications (goal_id, observed_at);
CREATE INDEX idx_goal_content_verification_source
  ON goal_content_verifications (goal_id, accepted_source_commit, comparison_commit);

-- SQLite does not allow subqueries in CHECK constraints, so the exact payload shape is enforced on insert instead.
-- Every payload field, including nested fields, has a column CHECK above; this trigger also rejects an unbound field.
CREATE TRIGGER trg_goal_content_verification_payload_shape
BEFORE INSERT ON goal_content_verifications
WHEN json_valid(NEW.payload_json) AND (
  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) <> 16
    OR (SELECT COUNT(*) FROM json_each(NEW.payload_json, '$.repository')) <> 1
    OR (SELECT COUNT(*) FROM json_each(NEW.payload_json, '$.source')) <> 1
    OR (SELECT COUNT(*) FROM json_each(NEW.payload_json, '$.destination')) <> 4
)
BEGIN SELECT RAISE(ABORT, 'content verification payload shape is invalid'); END;

CREATE TRIGGER trg_goal_content_verification_immutable
BEFORE UPDATE ON goal_content_verifications
BEGIN SELECT RAISE(ABORT, 'content verifications are immutable'); END;

CREATE TRIGGER trg_goal_content_verification_no_delete
BEFORE DELETE ON goal_content_verifications
BEGIN SELECT RAISE(ABORT, 'content verifications cannot be deleted'); END;
