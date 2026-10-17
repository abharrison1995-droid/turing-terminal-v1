-- Goal Engine core schema (Stage 0B). Schema and invariants only; no supervisor logic reads or writes these tables yet.

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('draft','ready','running','reviewing','needs_user','blocked','paused','completed','abandoned')),
  status_reason_code TEXT,
  status_detail_json TEXT,
  current_definition_version INTEGER,
  active_milestone_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  -- Deferred so a Goal and its first definition/milestones can be written in one transaction in any order.
  -- A composite foreign key is not enforced while any of its columns is NULL, so a draft Goal is valid.
  FOREIGN KEY (id, current_definition_version) REFERENCES goal_definition_versions (goal_id, version)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, active_milestone_id) REFERENCES goal_milestones (goal_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE goal_definition_versions (
  goal_id TEXT NOT NULL REFERENCES goals (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  parent_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','superseded','rejected')),
  contract_json TEXT NOT NULL,
  milestones_json TEXT NOT NULL,
  routing_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('user','authoring_run','amendment_assist')),
  approved_by TEXT CHECK (approved_by IS NULL OR approved_by = 'user'),
  approval_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  PRIMARY KEY (goal_id, version)
);

CREATE TABLE goal_milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  milestone_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','in_review','satisfied','blocked','skipped')),
  satisfied_at TEXT,
  UNIQUE (goal_id, milestone_key),
  UNIQUE (goal_id, id)
);

CREATE TABLE goal_runtime (
  goal_id TEXT PRIMARY KEY REFERENCES goals (id),
  cycles_executed INTEGER NOT NULL DEFAULT 0,
  consecutive_failed_cycles INTEGER NOT NULL DEFAULT 0,
  remediation_attempts_json TEXT NOT NULL DEFAULT '{}',
  active_ms INTEGER NOT NULL DEFAULT 0,
  base_branch TEXT,
  base_commit TEXT,
  goal_branch TEXT,
  integration_head TEXT,
  memory_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE goal_cycles (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  -- NULL only for authoring cycles, which exist before any definition does.
  definition_version INTEGER,
  milestone_id TEXT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('authoring','execution','remediation','review','verification')),
  trigger_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('planned','proposing','proposed','launching','running','collecting','integrating',
     'succeeded','failed','cancelled','rejected')),
  base_integration_commit TEXT,
  result_integration_commit TEXT,
  validated_task_json TEXT,
  route_resolution_json TEXT,
  outcome_json TEXT,
  next_action_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (goal_id, sequence),
  UNIQUE (goal_id, id),
  CHECK (kind = 'authoring' OR definition_version IS NOT NULL),
  FOREIGN KEY (goal_id, definition_version) REFERENCES goal_definition_versions (goal_id, version),
  FOREIGN KEY (goal_id, milestone_id) REFERENCES goal_milestones (goal_id, id)
);

CREATE TABLE goal_integration_ops (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals (id),
  cycle_id TEXT,
  run_id TEXT REFERENCES runs (id),
  op TEXT NOT NULL CHECK (op IN ('init_ref','advance','apply_to_base')),
  expected_old TEXT,
  new_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','applied','failed','aborted')),
  checks_json TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (goal_id, cycle_id) REFERENCES goal_cycles (goal_id, id)
);

-- Goal-origin run metadata. SQLite permits ADD COLUMN ... REFERENCES with a NULL default while foreign keys are on.
ALTER TABLE runs ADD COLUMN goal_cycle_id TEXT REFERENCES goal_cycles (id);
ALTER TABLE runs ADD COLUMN goal_run_purpose TEXT
  CHECK (goal_run_purpose IS NULL OR goal_run_purpose IN
    ('authoring','proposal','execution','review','remediation','verification'));
ALTER TABLE runs ADD COLUMN goal_base_commit TEXT
  CHECK (goal_base_commit IS NULL
    OR (length(goal_base_commit) IN (40, 64) AND goal_base_commit NOT GLOB '*[^0-9a-f]*'));

CREATE UNIQUE INDEX idx_runs_goal_cycle_purpose ON runs (goal_cycle_id, goal_run_purpose)
  WHERE goal_cycle_id IS NOT NULL;
CREATE INDEX idx_runs_goal_cycle ON runs (goal_cycle_id);
CREATE INDEX idx_goal_cycles_goal ON goal_cycles (goal_id, sequence);
CREATE UNIQUE INDEX idx_goal_one_approved_definition ON goal_definition_versions (goal_id)
  WHERE status = 'approved';
-- Project lease: at most one active Goal per project. needs_user is included so an amended Goal keeps its lease.
CREATE UNIQUE INDEX idx_goal_one_active_per_project ON goals (project_id)
  WHERE status IN ('running','reviewing','needs_user','blocked','paused');

-- Run origin: all-or-none, and immutable once the run row exists.
CREATE TRIGGER trg_runs_goal_origin_insert BEFORE INSERT ON runs
WHEN (NEW.goal_cycle_id IS NULL AND (NEW.goal_run_purpose IS NOT NULL OR NEW.goal_base_commit IS NOT NULL))
  OR (NEW.goal_cycle_id IS NOT NULL AND NEW.goal_run_purpose IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'goal run origin columns are inconsistent');
END;

CREATE TRIGGER trg_runs_goal_origin_update BEFORE UPDATE OF goal_cycle_id, goal_run_purpose, goal_base_commit ON runs
WHEN NEW.goal_cycle_id IS NOT OLD.goal_cycle_id
  OR NEW.goal_run_purpose IS NOT OLD.goal_run_purpose
  OR NEW.goal_base_commit IS NOT OLD.goal_base_commit
BEGIN
  SELECT RAISE(ABORT, 'goal run origin is immutable');
END;

-- Definition versions: immutable once decided; strict status transitions; approval only by the user.
CREATE TRIGGER trg_goal_definition_immutable BEFORE UPDATE ON goal_definition_versions
WHEN OLD.status IN ('approved','superseded','rejected') AND (
     NEW.goal_id IS NOT OLD.goal_id OR NEW.version IS NOT OLD.version
  OR NEW.parent_version IS NOT OLD.parent_version
  OR NEW.contract_json IS NOT OLD.contract_json OR NEW.milestones_json IS NOT OLD.milestones_json
  OR NEW.routing_json IS NOT OLD.routing_json OR NEW.review_json IS NOT OLD.review_json
  OR NEW.limits_json IS NOT OLD.limits_json OR NEW.definition_hash IS NOT OLD.definition_hash
  OR NEW.change_summary IS NOT OLD.change_summary OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.approved_by IS NOT OLD.approved_by
  OR NEW.approved_at IS NOT OLD.approved_at OR NEW.approval_id IS NOT OLD.approval_id)
BEGIN
  SELECT RAISE(ABORT, 'a decided goal definition version is immutable');
END;

CREATE TRIGGER trg_goal_definition_status BEFORE UPDATE OF status ON goal_definition_versions
WHEN NEW.status IS NOT OLD.status AND NOT (
     (OLD.status = 'proposed' AND NEW.status IN ('approved','rejected'))
  OR (OLD.status = 'approved' AND NEW.status = 'superseded'))
BEGIN
  SELECT RAISE(ABORT, 'illegal goal definition status transition');
END;

CREATE TRIGGER trg_goal_definition_approval BEFORE UPDATE OF status ON goal_definition_versions
WHEN NEW.status = 'approved' AND OLD.status <> 'approved'
  AND (NEW.approved_by IS NOT 'user' OR NEW.approved_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a goal definition can only be approved by the user');
END;

CREATE TRIGGER trg_goal_definition_insert_approved BEFORE INSERT ON goal_definition_versions
WHEN NEW.status = 'approved' AND (NEW.approved_by IS NOT 'user' OR NEW.approved_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a goal definition can only be approved by the user');
END;

CREATE TRIGGER trg_goal_definition_no_delete BEFORE DELETE ON goal_definition_versions
WHEN OLD.status IN ('approved','superseded')
BEGIN
  SELECT RAISE(ABORT, 'a decided goal definition version cannot be deleted');
END;

-- An integration op that cites a run must cite that run's own cycle.
CREATE TRIGGER trg_goal_integration_op_run BEFORE INSERT ON goal_integration_ops
WHEN NEW.run_id IS NOT NULL
  AND (NEW.cycle_id IS NULL OR (SELECT goal_cycle_id FROM runs WHERE id = NEW.run_id) IS NOT NEW.cycle_id)
BEGIN
  SELECT RAISE(ABORT, 'integration op run does not belong to its cycle');
END;

CREATE VIEW goal_runs AS
  SELECT r.id AS run_id, c.goal_id AS goal_id, r.goal_cycle_id AS cycle_id, r.goal_run_purpose AS purpose
  FROM runs r JOIN goal_cycles c ON c.id = r.goal_cycle_id;
