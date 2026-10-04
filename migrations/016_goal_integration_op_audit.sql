-- Hardens goal_integration_ops (additive; migration 015 is never edited once applied).
-- Rows are the crash-recovery record for Goal ref movement: the authorised identity and checks never change,
-- status only moves forward from 'planned', and recovery observations go in their own column.

ALTER TABLE goal_integration_ops ADD COLUMN recovery_json TEXT;

-- At most one unresolved operation per Goal: ref movement is serialised and recovery is unambiguous.
CREATE UNIQUE INDEX idx_goal_integration_ops_one_planned ON goal_integration_ops (goal_id)
  WHERE status = 'planned';

-- Operations are always recorded as planned first.
CREATE TRIGGER trg_goal_integration_op_planned BEFORE INSERT ON goal_integration_ops
WHEN NEW.status <> 'planned'
BEGIN
  SELECT RAISE(ABORT, 'an integration op must be inserted as planned');
END;

-- Identity and the authorised checks never change.
CREATE TRIGGER trg_goal_integration_op_identity BEFORE UPDATE ON goal_integration_ops
WHEN NEW.id IS NOT OLD.id
  OR NEW.goal_id IS NOT OLD.goal_id
  OR NEW.cycle_id IS NOT OLD.cycle_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.op IS NOT OLD.op
  OR NEW.expected_old IS NOT OLD.expected_old
  OR NEW.new_commit IS NOT OLD.new_commit
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.checks_json IS NOT OLD.checks_json
BEGIN
  SELECT RAISE(ABORT, 'goal integration op identity and checks are immutable');
END;

-- planned -> applied | aborted | failed; those three are terminal and fully immutable.
CREATE TRIGGER trg_goal_integration_op_status BEFORE UPDATE ON goal_integration_ops
WHEN OLD.status <> 'planned'
  AND (NEW.status IS NOT OLD.status
    OR NEW.error_code IS NOT OLD.error_code
    OR NEW.finished_at IS NOT OLD.finished_at
    OR NEW.recovery_json IS NOT OLD.recovery_json)
BEGIN
  SELECT RAISE(ABORT, 'a resolved goal integration op is immutable');
END;

CREATE TRIGGER trg_goal_integration_op_progress BEFORE UPDATE OF status ON goal_integration_ops
WHEN OLD.status = 'planned' AND NEW.status NOT IN ('planned','applied','aborted','failed')
BEGIN
  SELECT RAISE(ABORT, 'illegal goal integration op status transition');
END;

-- The audit trail is never deleted.
CREATE TRIGGER trg_goal_integration_op_no_delete BEFORE DELETE ON goal_integration_ops
BEGIN
  SELECT RAISE(ABORT, 'goal integration ops cannot be deleted');
END;
