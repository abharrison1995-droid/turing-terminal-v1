ALTER TABLE runs ADD COLUMN rules_snapshot_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  mandatory INTEGER NOT NULL DEFAULT 0,
  stage_kinds_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_rules_scope_project ON rules(scope, project_id, enabled, priority DESC);
