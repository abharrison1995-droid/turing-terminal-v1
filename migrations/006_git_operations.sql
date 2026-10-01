ALTER TABLE runs ADD COLUMN base_branch TEXT;

CREATE TABLE IF NOT EXISTS git_operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  branch TEXT,
  target TEXT,
  approval_id TEXT REFERENCES approvals(id),
  approval_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  before_commit TEXT,
  after_commit TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_git_operations_run_created
  ON git_operations(run_id, created_at);
