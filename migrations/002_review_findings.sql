CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT NOT NULL,
  affected_files_json TEXT NOT NULL DEFAULT '[]',
  recommended_remediation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_findings_run ON review_findings(run_id, status);
