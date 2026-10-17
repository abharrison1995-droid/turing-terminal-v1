-- Stage 2B.1: user authority over finding decisions. A finding becomes accepted_by_user / dismissed_by_user only
-- through a user-decided finding_decision approval bound to exactly this finding, this decision and the Goal's current
-- approved definition (version and hash). The finding row carries an explicit pointer to that approval, and a user
-- decision is sticky: it cannot be reopened, resolved, reversed or re-pointed afterwards. Rows that predate this
-- migration are not re-validated; a pre-existing user-decided finding keeps a NULL approval pointer and stays sticky.

ALTER TABLE goal_findings ADD COLUMN decision_approval_id TEXT REFERENCES goal_approvals (id);

-- A finding is created open: it cannot be born already decided, and cannot be born pointing at an approval.
CREATE TRIGGER trg_goal_finding_insert_open BEFORE INSERT ON goal_findings
WHEN NEW.status IN ('accepted_by_user', 'dismissed_by_user') OR NEW.decision_approval_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a goal finding is created without a user decision');
END;

-- open -> accepted_by_user | dismissed_by_user needs the bound user approval.
CREATE TRIGGER trg_goal_finding_user_decision BEFORE UPDATE ON goal_findings
WHEN NEW.status IN ('accepted_by_user', 'dismissed_by_user') AND NEW.status IS NOT OLD.status
  AND (OLD.status <> 'open' OR NOT EXISTS (
    SELECT 1
    FROM goal_approvals a
    JOIN goals g ON g.id = NEW.goal_id
    JOIN goal_definition_versions d
      ON d.goal_id = g.id AND d.version = g.current_definition_version AND d.status = 'approved'
    WHERE a.id = NEW.decision_approval_id
      AND a.goal_id = NEW.goal_id
      AND a.gate = 'finding_decision'
      AND a.status = 'approved' AND a.decided_by = 'user'
      AND json_extract(a.detail_json, '$.findingId') = NEW.id
      AND json_extract(a.detail_json, '$.decision') = NEW.status
      AND json_extract(a.detail_json, '$.definitionVersion') = g.current_definition_version
      AND json_extract(a.detail_json, '$.definitionHash') = d.definition_hash))
BEGIN
  SELECT RAISE(ABORT, 'a finding decision needs a user approval bound to this finding, decision and current definition');
END;

-- A user decision is sticky, and its approval pointer is immutable once set.
CREATE TRIGGER trg_goal_finding_decision_sticky BEFORE UPDATE ON goal_findings
WHEN OLD.status IN ('accepted_by_user', 'dismissed_by_user')
  AND (NEW.status IS NOT OLD.status OR NEW.decision_approval_id IS NOT OLD.decision_approval_id)
BEGIN
  SELECT RAISE(ABORT, 'a user finding decision cannot be changed');
END;

-- The approval pointer exists only on a user-decided finding.
CREATE TRIGGER trg_goal_finding_approval_pointer BEFORE UPDATE OF decision_approval_id ON goal_findings
WHEN NEW.decision_approval_id IS NOT OLD.decision_approval_id
  AND (OLD.decision_approval_id IS NOT NULL OR NEW.status NOT IN ('accepted_by_user', 'dismissed_by_user'))
BEGIN
  SELECT RAISE(ABORT, 'the finding decision approval is set only with a user decision and never changed');
END;
