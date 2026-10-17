-- Stage 7C.2B.5D.2: append-only correction and withdrawal authority for external-integration attestations.
-- Corrections are historical user decisions about an immutable attestation. They never rewrite the original
-- attestation, its approval, any completion proof, any Goal event, or any terminal Goal row. This migration adds no
-- completion activation and no Git writer.

ALTER TABLE goal_approvals ADD COLUMN attestation_correction_action_digest TEXT
  CHECK (attestation_correction_action_digest IS NULL OR
    (length(attestation_correction_action_digest) = 64
      AND attestation_correction_action_digest NOT GLOB '*[^0-9a-f]*'));

DROP TRIGGER trg_goal_approval_identity;
CREATE TRIGGER trg_goal_approval_identity BEFORE UPDATE ON goal_approvals
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.gate IS NOT OLD.gate OR NEW.risk IS NOT OLD.risk
  OR NEW.reason IS NOT OLD.reason OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.detail_json IS NOT OLD.detail_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.intent_digest IS NOT OLD.intent_digest
  OR NEW.external_integration_action_digest IS NOT OLD.external_integration_action_digest
  OR NEW.external_completion_action_digest IS NOT OLD.external_completion_action_digest
  OR NEW.attestation_correction_action_digest IS NOT OLD.attestation_correction_action_digest
BEGIN SELECT RAISE(ABORT, 'goal approval identity is immutable'); END;

-- A correction approval is a distinct high-risk user_confirmation decision. It is never a final_apply, never an
-- external-integration confirmation, and never a completion approval. The detail must carry exactly 19 keys.
CREATE TRIGGER trg_goal_approval_attestation_correction_guard BEFORE INSERT ON goal_approvals
WHEN (NEW.attestation_correction_action_digest IS NOT NULL AND (
       NEW.gate <> 'user_confirmation'
    OR NEW.risk <> 'high'
    OR NEW.requested_by <> 'user'
    OR NEW.intent_digest IS NOT NULL
    OR json_type(NEW.detail_json, '$.schemaVersion') IS NOT 'integer'
    OR json_extract(NEW.detail_json, '$.schemaVersion') <> 1
    OR json_type(NEW.detail_json, '$.action') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.action') <> 'correct_external_integration_attestation_v1'
    OR json_type(NEW.detail_json, '$.actionDigest') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.actionDigest') IS NOT NEW.attestation_correction_action_digest
    OR json_extract(NEW.detail_json, '$.goalId') IS NOT NEW.goal_id
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json)) <> 19
  )) OR (json_extract(NEW.detail_json, '$.action') = 'correct_external_integration_attestation_v1'
    AND NEW.attestation_correction_action_digest IS NULL)
BEGIN SELECT RAISE(ABORT, 'attestation correction approval action digest is invalid'); END;

CREATE UNIQUE INDEX idx_goal_approval_attestation_correction_action
  ON goal_approvals (goal_id, attestation_correction_action_digest)
  WHERE attestation_correction_action_digest IS NOT NULL;

CREATE TABLE goal_attestation_corrections (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind = 'turing_goal_attestation_correction'),
  handoff_id TEXT NOT NULL,
  handoff_digest TEXT NOT NULL CHECK (length(handoff_digest) = 64 AND handoff_digest NOT GLOB '*[^0-9a-f]*'),
  attestation_id TEXT NOT NULL,
  attestation_action_digest TEXT NOT NULL CHECK (length(attestation_action_digest) = 64 AND attestation_action_digest NOT GLOB '*[^0-9a-f]*'),
  attestation_record_digest TEXT NOT NULL CHECK (length(attestation_record_digest) = 64 AND attestation_record_digest NOT GLOB '*[^0-9a-f]*'),
  approval_id TEXT NOT NULL,
  correction_kind TEXT NOT NULL CHECK (correction_kind IN ('dispute', 'withdraw', 'supersede')),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  previous_correction_digest TEXT CHECK (previous_correction_digest IS NULL OR
    (length(previous_correction_digest) = 64 AND previous_correction_digest NOT GLOB '*[^0-9a-f]*')),
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
  correction_digest TEXT NOT NULL CHECK (length(correction_digest) = 64 AND correction_digest NOT GLOB '*[^0-9a-f]*'),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'integration_not_performed', 'wrong_source', 'wrong_destination', 'content_not_preserved',
    'observation_error', 'superseded_by_new_observation', 'other')),
  explanation TEXT CHECK (explanation IS NULL OR length(explanation) <= 1000),
  explanation_digest TEXT CHECK (explanation_digest IS NULL OR
    (length(explanation_digest) = 64 AND explanation_digest NOT GLOB '*[^0-9a-f]*')),
  replacement_attestation_id TEXT,
  replacement_record_digest TEXT CHECK (replacement_record_digest IS NULL OR
    (length(replacement_record_digest) = 64 AND replacement_record_digest NOT GLOB '*[^0-9a-f]*')),
  definition_version INTEGER NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
  decided_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  UNIQUE (goal_id, id),
  UNIQUE (goal_id, correction_digest),
  UNIQUE (goal_id, approval_id),
  UNIQUE (goal_id, attestation_id, sequence),
  UNIQUE (goal_id, attestation_id, previous_correction_digest),
  UNIQUE (goal_id, attestation_id, action_digest),
  FOREIGN KEY (goal_id, handoff_id) REFERENCES goal_result_handoffs (goal_id, id),
  FOREIGN KEY (goal_id, attestation_id) REFERENCES goal_external_integration_attestations (goal_id, id),
  FOREIGN KEY (goal_id, approval_id) REFERENCES goal_approvals (goal_id, id),
  FOREIGN KEY (goal_id, replacement_attestation_id) REFERENCES goal_external_integration_attestations (goal_id, id),
  CHECK ((correction_kind = 'supersede') = (replacement_attestation_id IS NOT NULL AND replacement_record_digest IS NOT NULL)),
  CHECK (replacement_attestation_id IS NULL OR replacement_attestation_id <> attestation_id),
  CHECK ((sequence = 1) = (previous_correction_digest IS NULL)),
  CHECK ((explanation IS NULL) = (explanation_digest IS NULL)),
  CHECK (json_extract(payload_json, '$.schemaVersion') IS schema_version),
  CHECK (json_extract(payload_json, '$.kind') IS kind),
  CHECK (json_extract(payload_json, '$.correctionId') IS id),
  CHECK (json_extract(payload_json, '$.goalId') IS goal_id),
  CHECK (json_extract(payload_json, '$.handoffId') IS handoff_id),
  CHECK (json_extract(payload_json, '$.handoffDigest') IS handoff_digest),
  CHECK (json_extract(payload_json, '$.attestationId') IS attestation_id),
  CHECK (json_extract(payload_json, '$.attestationActionDigest') IS attestation_action_digest),
  CHECK (json_extract(payload_json, '$.attestationRecordDigest') IS attestation_record_digest),
  CHECK (json_extract(payload_json, '$.approvalId') IS approval_id),
  CHECK (json_extract(payload_json, '$.correctionKind') IS correction_kind),
  CHECK (json_extract(payload_json, '$.sequence') IS sequence),
  CHECK (json_extract(payload_json, '$.previousCorrectionDigest') IS previous_correction_digest),
  CHECK (json_extract(payload_json, '$.actionDigest') IS action_digest),
  CHECK (json_extract(payload_json, '$.correctionDigest') IS correction_digest),
  CHECK (json_extract(payload_json, '$.reasonCode') IS reason_code),
  CHECK (json_extract(payload_json, '$.explanation') IS explanation),
  CHECK (json_extract(payload_json, '$.explanationDigest') IS explanation_digest),
  CHECK (json_extract(payload_json, '$.replacement.attestationId') IS replacement_attestation_id),
  CHECK (json_extract(payload_json, '$.replacement.recordDigest') IS replacement_record_digest),
  CHECK (json_extract(payload_json, '$.definition.version') IS definition_version),
  CHECK (json_extract(payload_json, '$.definition.hash') IS definition_hash),
  CHECK (json_extract(payload_json, '$.decision.value') IS 'correct_external_integration_attestation_v1'),
  CHECK (json_extract(payload_json, '$.decision.decidedBy') IS 'user'),
  CHECK (json_extract(payload_json, '$.decision.decidedAt') IS decided_at)
);

CREATE TRIGGER trg_goal_attestation_correction_insert_authority BEFORE INSERT ON goal_attestation_corrections
WHEN NOT EXISTS (
  SELECT 1 FROM goal_approvals a
  WHERE a.id = NEW.approval_id AND a.goal_id = NEW.goal_id
    AND a.gate = 'user_confirmation' AND a.risk = 'high' AND a.requested_by = 'user'
    AND a.status = 'approved' AND a.decided_by = 'user' AND a.intent_digest IS NULL
    AND a.attestation_correction_action_digest = NEW.action_digest
    AND json_extract(a.detail_json, '$.schemaVersion') = 1
    AND json_extract(a.detail_json, '$.action') = 'correct_external_integration_attestation_v1'
    AND json_extract(a.detail_json, '$.actionDigest') = NEW.action_digest
    AND json_extract(a.detail_json, '$.goalId') = NEW.goal_id
    AND json_extract(a.detail_json, '$.handoffId') = NEW.handoff_id
    AND json_extract(a.detail_json, '$.handoffDigest') = NEW.handoff_digest
    AND json_extract(a.detail_json, '$.attestationId') = NEW.attestation_id
    AND json_extract(a.detail_json, '$.attestationActionDigest') = NEW.attestation_action_digest
    AND json_extract(a.detail_json, '$.attestationRecordDigest') = NEW.attestation_record_digest
    AND json_extract(a.detail_json, '$.correctionKind') = NEW.correction_kind
    AND json_extract(a.detail_json, '$.sequence') = NEW.sequence
    AND json_extract(a.detail_json, '$.previousCorrectionDigest') IS NEW.previous_correction_digest
    AND json_extract(a.detail_json, '$.reasonCode') = NEW.reason_code
    AND json_extract(a.detail_json, '$.explanationDigest') IS NEW.explanation_digest
    AND json_extract(a.detail_json, '$.replacementAttestationId') IS NEW.replacement_attestation_id
    AND json_extract(a.detail_json, '$.replacementRecordDigest') IS NEW.replacement_record_digest
    AND json_extract(a.detail_json, '$.definitionVersion') = NEW.definition_version
    AND json_extract(a.detail_json, '$.definitionHash') = NEW.definition_hash
    AND json_extract(a.detail_json, '$.attestationApprovalId') IS NOT NULL
    AND (SELECT COUNT(*) FROM json_each(a.detail_json)) = 19
)
OR NOT EXISTS (
  SELECT 1 FROM goal_external_integration_attestations e
  JOIN goal_approvals ea ON ea.goal_id = e.goal_id AND ea.id = e.approval_id
  WHERE e.goal_id = NEW.goal_id AND e.id = NEW.attestation_id AND e.handoff_id = NEW.handoff_id
    AND e.handoff_digest = NEW.handoff_digest
    AND e.action_digest = NEW.attestation_action_digest
    AND e.record_digest = NEW.attestation_record_digest
    AND e.definition_version = NEW.definition_version
    AND e.definition_hash = NEW.definition_hash
    AND ea.id = (SELECT json_extract(a.detail_json, '$.attestationApprovalId') FROM goal_approvals a WHERE a.id = NEW.approval_id)
)
OR (NEW.replacement_attestation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM goal_external_integration_attestations r
  JOIN goal_external_integration_attestations e ON e.goal_id = NEW.goal_id AND e.id = NEW.attestation_id
  WHERE r.goal_id = NEW.goal_id AND r.id = NEW.replacement_attestation_id
    AND r.record_digest = NEW.replacement_record_digest
    AND r.definition_hash = e.definition_hash
    AND r.repository_identity = e.repository_identity
    AND r.repository_project_id = e.repository_project_id
    AND NOT EXISTS (SELECT 1 FROM goal_attestation_corrections c
      WHERE c.goal_id = NEW.goal_id AND c.attestation_id = r.id)
))
OR NOT (
  (NEW.sequence = 1 AND NEW.previous_correction_digest IS NULL
    AND NOT EXISTS (SELECT 1 FROM goal_attestation_corrections c
      WHERE c.goal_id = NEW.goal_id AND c.attestation_id = NEW.attestation_id))
  OR
  (NEW.sequence > 1 AND NEW.previous_correction_digest IS NOT NULL
    AND EXISTS (SELECT 1 FROM goal_attestation_corrections p
      WHERE p.goal_id = NEW.goal_id AND p.attestation_id = NEW.attestation_id
        AND p.sequence = NEW.sequence - 1 AND p.correction_digest = NEW.previous_correction_digest
        AND p.correction_kind = 'dispute')
    AND NEW.correction_kind IN ('withdraw', 'supersede'))
)
BEGIN SELECT RAISE(ABORT, 'attestation correction lacks exact approved authority or chain position'); END;

CREATE TRIGGER trg_goal_attestation_correction_immutable BEFORE UPDATE ON goal_attestation_corrections
BEGIN SELECT RAISE(ABORT, 'attestation corrections are append-only'); END;
CREATE TRIGGER trg_goal_attestation_correction_no_delete BEFORE DELETE ON goal_attestation_corrections
BEGIN SELECT RAISE(ABORT, 'attestation corrections cannot be deleted'); END;
