-- Stage 7C.2A: typed metadata for immutable prospective final-apply authority.
-- This stores identity only; it does not authorize or perform a Git ref update.

ALTER TABLE goal_approvals ADD COLUMN intent_digest TEXT
  CHECK (intent_digest IS NULL OR (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'));

DROP TRIGGER trg_goal_approval_identity;
CREATE TRIGGER trg_goal_approval_identity BEFORE UPDATE ON goal_approvals
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.gate IS NOT OLD.gate OR NEW.risk IS NOT OLD.risk
  OR NEW.reason IS NOT OLD.reason OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.detail_json IS NOT OLD.detail_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.intent_digest IS NOT OLD.intent_digest
BEGIN SELECT RAISE(ABORT, 'goal approval identity is immutable'); END;

-- Prospective apply intents have one digest in both the typed index column and strict JSON detail.
-- Existing final_apply records (including applied_externally attestations) keep a NULL typed digest.
CREATE TRIGGER trg_goal_approval_intent_guard BEFORE INSERT ON goal_approvals
WHEN (NEW.intent_digest IS NOT NULL AND (
    NEW.gate <> 'final_apply'
    OR NEW.risk <> 'high'
    OR NEW.requested_by <> 'user'
    OR json_type(NEW.detail_json, '$.action') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.action') <> 'apply_to_base_intent'
    OR json_type(NEW.detail_json, '$.intentDigest') IS NOT 'text'
    OR json_extract(NEW.detail_json, '$.intentDigest') IS NOT NEW.intent_digest
  )) OR (NEW.gate = 'final_apply' AND json_extract(NEW.detail_json, '$.action') = 'apply_to_base_intent'
    AND (NEW.risk <> 'high' OR NEW.requested_by <> 'user' OR NEW.intent_digest IS NULL
      OR json_extract(NEW.detail_json, '$.intentDigest') IS NOT NEW.intent_digest))
BEGIN SELECT RAISE(ABORT, 'prospective final-apply intent digest is invalid'); END;

CREATE UNIQUE INDEX idx_goal_approval_live_final_apply_intent
  ON goal_approvals (goal_id, intent_digest)
  WHERE gate = 'final_apply' AND intent_digest IS NOT NULL AND status IN ('pending','approved');
