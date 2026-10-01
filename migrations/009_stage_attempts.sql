CREATE TABLE stage_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  reviewer_index INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'retrying', 'succeeded', 'failed')),
  category TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX stage_attempts_run_stage ON stage_attempts(run_id, stage_id, reviewer_index, attempt);
