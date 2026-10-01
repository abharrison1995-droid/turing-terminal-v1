CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  git_root TEXT,
  branch TEXT,
  dirty INTEGER,
  package_manager TEXT,
  languages_json TEXT NOT NULL DEFAULT '[]',
  frameworks_json TEXT NOT NULL DEFAULT '[]',
  build_command_json TEXT,
  test_command_json TEXT,
  lint_command_json TEXT,
  readme_path TEXT,
  instruction_files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  template TEXT NOT NULL,
  config_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_snapshot_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  refined_specification TEXT,
  profile TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT,
  starting_commit TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  logs TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  backend TEXT,
  project_id TEXT REFERENCES projects(id),
  run_id TEXT REFERENCES runs(id),
  stage_id TEXT REFERENCES stages(id),
  role TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 1,
  provenance TEXT NOT NULL,
  equivalent_cost_usd REAL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES stages(id),
  operation TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  responded_at TEXT
);

CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  affected_stages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_requests (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_stages_run_sequence ON stages(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_usage_occurred ON usage_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_run_created ON run_events(run_id, created_at);
