-- Stage 2A.1: authority and ownership hardening. Additive: only triggers, no table changes. Rows that predate this
-- migration are not re-validated.

-- A Goal definition becomes approved only through a decided user approval that is bound to exactly this Goal, this
-- version and this content hash. The gate is 'definition' for a first version and 'amendment' for any later one.
CREATE TRIGGER trg_goal_definition_approval_binding BEFORE UPDATE OF status ON goal_definition_versions
WHEN NEW.status = 'approved' AND OLD.status <> 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM goal_approvals a
    WHERE a.id = NEW.approval_id AND a.goal_id = NEW.goal_id
      AND a.status = 'approved' AND a.decided_by = 'user'
      AND a.gate = CASE WHEN NEW.parent_version IS NULL THEN 'definition' ELSE 'amendment' END
      AND json_extract(a.detail_json, '$.version') = NEW.version
      AND json_extract(a.detail_json, '$.definitionHash') = NEW.definition_hash)
BEGIN
  SELECT RAISE(ABORT, 'a goal definition approval must be bound to this goal, version and hash');
END;

CREATE TRIGGER trg_goal_definition_insert_approval_binding BEFORE INSERT ON goal_definition_versions
WHEN NEW.status = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM goal_approvals a
    WHERE a.id = NEW.approval_id AND a.goal_id = NEW.goal_id
      AND a.status = 'approved' AND a.decided_by = 'user'
      AND a.gate = CASE WHEN NEW.parent_version IS NULL THEN 'definition' ELSE 'amendment' END
      AND json_extract(a.detail_json, '$.version') = NEW.version
      AND json_extract(a.detail_json, '$.definitionHash') = NEW.definition_hash)
BEGIN
  SELECT RAISE(ABORT, 'a goal definition approval must be bound to this goal, version and hash');
END;

-- An observation may cite a run finding only when it was produced by the very run that the Goal review recorded:
-- observation -> Goal review -> review run <- run finding.
CREATE TRIGGER trg_goal_observation_run_finding BEFORE INSERT ON goal_finding_observations
WHEN NEW.run_finding_id IS NOT NULL
  AND (SELECT run_id FROM goal_reviews WHERE id = NEW.review_id) IS NOT (SELECT run_id FROM review_findings WHERE id = NEW.run_finding_id)
BEGIN
  SELECT RAISE(ABORT, 'a run finding must belong to the Goal review''s run');
END;
CREATE TRIGGER trg_goal_observation_run_finding_has_run BEFORE INSERT ON goal_finding_observations
WHEN NEW.run_finding_id IS NOT NULL
  AND (SELECT run_id FROM goal_reviews WHERE id = NEW.review_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a run finding requires a Goal review with a run');
END;
