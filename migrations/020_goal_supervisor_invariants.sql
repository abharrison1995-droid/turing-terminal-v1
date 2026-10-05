-- Goal supervisor invariants (Stage 3). Additive: no earlier migration is edited.

-- At most one non-terminal cycle per Goal. Two supervisors, two ticks or a retry racing each other can therefore
-- never both hold an active cycle; the loser's INSERT fails and creation is idempotent in the application layer.
CREATE UNIQUE INDEX idx_goal_one_active_cycle ON goal_cycles (goal_id)
  WHERE status NOT IN ('succeeded','failed','cancelled','rejected');

-- Cycle identity is fixed at creation.
CREATE TRIGGER trg_goal_cycle_identity BEFORE UPDATE ON goal_cycles
WHEN NEW.id IS NOT OLD.id OR NEW.goal_id IS NOT OLD.goal_id
  OR NEW.definition_version IS NOT OLD.definition_version OR NEW.milestone_id IS NOT OLD.milestone_id
  OR NEW.sequence IS NOT OLD.sequence OR NEW.kind IS NOT OLD.kind OR NEW.trigger_code IS NOT OLD.trigger_code
  OR NEW.base_integration_commit IS NOT OLD.base_integration_commit OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'goal cycle identity is immutable'); END;

-- A finished cycle is history: it never changes again.
CREATE TRIGGER trg_goal_cycle_terminal BEFORE UPDATE ON goal_cycles
WHEN OLD.status IN ('succeeded','failed','cancelled','rejected')
BEGIN SELECT RAISE(ABORT, 'a finished goal cycle is immutable'); END;

-- A cycle only moves forward. The per-kind legal edges live in src/server/goals/cycles.ts; this is the backstop that
-- rejects any backwards or sideways write that bypasses it.
CREATE TRIGGER trg_goal_cycle_forward BEFORE UPDATE OF status ON goal_cycles
WHEN NEW.status IS NOT OLD.status AND (CASE NEW.status
    WHEN 'planned' THEN 0 WHEN 'proposing' THEN 1 WHEN 'proposed' THEN 2 WHEN 'launching' THEN 3
    WHEN 'running' THEN 4 WHEN 'collecting' THEN 5 WHEN 'integrating' THEN 6 ELSE 7 END)
  <= (CASE OLD.status
    WHEN 'planned' THEN 0 WHEN 'proposing' THEN 1 WHEN 'proposed' THEN 2 WHEN 'launching' THEN 3
    WHEN 'running' THEN 4 WHEN 'collecting' THEN 5 WHEN 'integrating' THEN 6 ELSE 7 END)
BEGIN SELECT RAISE(ABORT, 'a goal cycle can only move forward'); END;

-- The proposal a cycle validated is fixed once recorded.
CREATE TRIGGER trg_goal_cycle_task_fixed BEFORE UPDATE OF validated_task_json ON goal_cycles
WHEN OLD.validated_task_json IS NOT NULL AND NEW.validated_task_json IS NOT OLD.validated_task_json
BEGIN SELECT RAISE(ABORT, 'the validated task of a goal cycle is immutable'); END;
