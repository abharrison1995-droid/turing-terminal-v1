-- Bind every new version-2 completion proof to an explicitly acknowledged content outcome.
-- Existing proof rows retain NULL and remain historical ancestry-only records.

ALTER TABLE goal_external_completion_proofs ADD COLUMN content_verification_digest TEXT
  CHECK (content_verification_digest IS NULL OR
    (length(content_verification_digest) = 64
      AND content_verification_digest NOT GLOB '*[^0-9a-f]*'))
  CHECK (json_extract(payload_json, '$.contentVerificationDigest') IS content_verification_digest);

ALTER TABLE goal_external_completion_proofs ADD COLUMN content_verification_status TEXT
  CHECK (content_verification_status IS NULL OR
    content_verification_status IN ('verified', 'content_not_preserved'))
  CHECK ((content_verification_digest IS NULL AND content_verification_status IS NULL) OR
    (content_verification_digest IS NOT NULL AND content_verification_status IS NOT NULL))
  CHECK (json_extract(payload_json, '$.contentVerificationStatus') IS content_verification_status);

DROP TRIGGER trg_goal_approval_external_completion_action_guard;
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
    OR json_type(NEW.detail_json, '$.contentVerificationDigest') IS NOT 'text'
    OR length(json_extract(NEW.detail_json, '$.contentVerificationDigest')) <> 64
    OR json_extract(NEW.detail_json, '$.contentVerificationDigest') GLOB '*[^0-9a-f]*'
    OR json_extract(NEW.detail_json, '$.contentVerificationStatus') IS NULL
    OR json_extract(NEW.detail_json, '$.contentVerificationStatus') NOT IN ('verified', 'content_not_preserved')
    OR json_extract(NEW.detail_json, '$.contentOutcomeAcknowledged') IS NOT 1
    OR json_extract(NEW.detail_json, '$.proofLimitations.contentPreservation') IS NOT 'not_proven'
    OR json_extract(NEW.detail_json, '$.correctionChain.standing') IS NOT 'active_uncontested'
    OR (SELECT COUNT(*) FROM json_each(NEW.detail_json)) <> 23
  )) OR (json_extract(NEW.detail_json, '$.action') = 'complete_goal_external_integration_v2'
    AND NEW.external_completion_action_digest IS NULL)
BEGIN SELECT RAISE(ABORT, 'external completion approval action digest is invalid'); END;

CREATE TRIGGER trg_goal_external_completion_content_verification_authority
BEFORE INSERT ON goal_external_completion_proofs
WHEN NEW.content_verification_digest IS NULL OR NOT EXISTS (
  SELECT 1
  FROM goal_content_verifications cv
  JOIN goal_approvals a ON a.id = NEW.completion_approval_id AND a.goal_id = NEW.goal_id
  WHERE cv.goal_id = NEW.goal_id
    AND cv.verification_digest = NEW.content_verification_digest
    AND cv.verifier = 'content-verified-v1'
    AND cv.verifier_version = 2
    AND cv.status = NEW.content_verification_status
    AND cv.object_format = NEW.object_format
    AND cv.expected_base_commit = NEW.recorded_base_commit
    AND cv.accepted_source_commit = NEW.source_commit
    AND cv.destination_ref = NEW.destination_ref
    AND cv.destination_tip_commit = NEW.observed_destination_commit
    AND json_extract(a.detail_json, '$.contentVerificationDigest') IS NEW.content_verification_digest
    AND json_extract(a.detail_json, '$.contentVerificationStatus') IS NEW.content_verification_status
    AND json_extract(a.detail_json, '$.contentOutcomeAcknowledged') IS 1
)
BEGIN
  SELECT RAISE(ABORT, 'external completion requires matching content verification evidence');
END;
