CREATE TABLE IF NOT EXISTS execution_operations (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  backend_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  role TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  action_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project_root TEXT NOT NULL,
  classification TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  approval_id TEXT REFERENCES approvals(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  result_json TEXT,
  stdout TEXT,
  stderr TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_operations_run_created
  ON execution_operations(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_operations_provider_session
  ON execution_operations(provider_session_id, status);
