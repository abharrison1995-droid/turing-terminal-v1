-- Stage 7C.2B: bind durable apply operations to the exact approved prospective intent.
ALTER TABLE goal_integration_ops ADD COLUMN approval_id TEXT REFERENCES goal_approvals(id)
  CHECK (approval_id IS NULL OR op = 'apply_to_base');

CREATE TRIGGER trg_goal_integration_op_apply_approval_insert BEFORE INSERT ON goal_integration_ops
WHEN (NEW.op = 'apply_to_base' AND NEW.approval_id IS NULL)
  OR (NEW.op <> 'apply_to_base' AND NEW.approval_id IS NOT NULL)
  OR (NEW.op = 'apply_to_base' AND (
       json_valid(NEW.checks_json) IS NOT 1
    OR json_extract(NEW.checks_json, '$.schemaVersion') IS NOT 1
    OR json_extract(NEW.checks_json, '$.kind') IS NOT 'turing_goal_final_apply_operation'
    OR json_extract(NEW.checks_json, '$.operationId') IS NOT NEW.id
    OR json_extract(NEW.checks_json, '$.goalId') IS NOT NEW.goal_id
    OR json_extract(NEW.checks_json, '$.approvalId') IS NOT NEW.approval_id
    OR json_extract(NEW.checks_json, '$.intentDigest') IS NOT (
         SELECT a.intent_digest FROM goal_approvals a WHERE a.id = NEW.approval_id
       )
    OR json_extract(NEW.checks_json, '$.source.integrationHead') IS NOT NEW.new_commit
    OR json_extract(NEW.checks_json, '$.destination.expectedBaseCommit') IS NOT NEW.expected_old
    OR NOT EXISTS (
         SELECT 1 FROM goal_approvals a
         WHERE a.id = NEW.approval_id
           AND a.goal_id = NEW.goal_id
           AND a.gate = 'final_apply'
           AND a.risk = 'high'
           AND a.requested_by = 'user'
           AND a.status = 'approved'
           AND a.decided_by = 'user'
           AND a.intent_digest IS NOT NULL
           AND json_extract(a.detail_json, '$.action') = 'apply_to_base_intent'
           AND json_extract(a.detail_json, '$.intentDigest') = a.intent_digest
           AND json_extract(a.detail_json, '$.intent.intentDigest') = a.intent_digest
       )
  ))
BEGIN
  SELECT RAISE(ABORT, 'apply_to_base operation requires matching approved authority');
END;

DROP TRIGGER trg_goal_integration_op_identity;
CREATE TRIGGER trg_goal_integration_op_identity BEFORE UPDATE ON goal_integration_ops
WHEN NEW.id IS NOT OLD.id
  OR NEW.goal_id IS NOT OLD.goal_id
  OR NEW.cycle_id IS NOT OLD.cycle_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.op IS NOT OLD.op
  OR NEW.approval_id IS NOT OLD.approval_id
  OR NEW.expected_old IS NOT OLD.expected_old
  OR NEW.new_commit IS NOT OLD.new_commit
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.checks_json IS NOT OLD.checks_json
BEGIN
  SELECT RAISE(ABORT, 'goal integration op identity and checks are immutable');
END;

-- One planned operation per Goal is already enforced by migration 016. This also makes a successful approval
-- idempotent across process restarts; a proven-aborted attempt may be retried as a new historical row.
CREATE UNIQUE INDEX idx_goal_apply_op_one_live_per_approval
  ON goal_integration_ops (goal_id, approval_id)
  WHERE op = 'apply_to_base' AND status IN ('planned', 'applied');

-- Do not allow bookkeeping alone to manufacture an applied result. The writer/recovery also verifies the exact
-- source/destination/ref-log and checkout state before this transition.
CREATE TRIGGER trg_goal_apply_op_applied_evidence BEFORE UPDATE OF status ON goal_integration_ops
WHEN OLD.op = 'apply_to_base' AND OLD.status = 'planned' AND NEW.status = 'applied'
  AND (json_valid(NEW.recovery_json) IS NOT 1
    OR json_extract(NEW.recovery_json, '$.schemaVersion') IS NOT 1
    OR json_extract(NEW.recovery_json, '$.operationDigest') IS NOT json_extract(OLD.checks_json, '$.operationDigest')
    OR json_extract(NEW.recovery_json, '$.checkout.clean') IS NOT 1
    OR json_extract(NEW.recovery_json, '$.refLog.message') IS NOT json_extract(OLD.checks_json, '$.reflogMessage')
    OR json_extract(NEW.recovery_json, '$.refLog.oldCommit') IS NOT OLD.expected_old
    OR json_extract(NEW.recovery_json, '$.refLog.newCommit') IS NOT OLD.new_commit)
BEGIN
  SELECT RAISE(ABORT, 'apply_to_base cannot be applied without verified ref and checkout evidence');
END;
