-- Phase 3.6: canonical usage events, metered budget reservations, Decision Layer, catalog cache.

ALTER TABLE usage_events ADD COLUMN request_id TEXT;
ALTER TABLE usage_events ADD COLUMN provider_request_id TEXT;
ALTER TABLE usage_events ADD COLUMN machine_id TEXT;
ALTER TABLE usage_events ADD COLUMN workflow_id TEXT;
ALTER TABLE usage_events ADD COLUMN workload_type TEXT NOT NULL DEFAULT 'generative';
ALTER TABLE usage_events ADD COLUMN upstream_provider TEXT;
ALTER TABLE usage_events ADD COLUMN resolved_model_id TEXT;
ALTER TABLE usage_events ADD COLUMN model_display_name TEXT;
ALTER TABLE usage_events ADD COLUMN reasoning TEXT;
ALTER TABLE usage_events ADD COLUMN context_strategy TEXT;
ALTER TABLE usage_events ADD COLUMN decision_engine TEXT;
ALTER TABLE usage_events ADD COLUMN decision_type TEXT;
ALTER TABLE usage_events ADD COLUMN decision_outcome TEXT;
ALTER TABLE usage_events ADD COLUMN batch_id TEXT;
ALTER TABLE usage_events ADD COLUMN cached_input_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN total_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN latency_ms INTEGER;
ALTER TABLE usage_events ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded';
ALTER TABLE usage_events ADD COLUMN finish_reason TEXT;
ALTER TABLE usage_events ADD COLUMN actual_cost_usd REAL;
ALTER TABLE usage_events ADD COLUMN actual_cost_provenance TEXT NOT NULL DEFAULT 'unavailable';
ALTER TABLE usage_events ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'final';
ALTER TABLE usage_events ADD COLUMN estimated_input_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN estimated_output_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN estimated_cost_usd REAL;
ALTER TABLE usage_events ADD COLUMN observations_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE usage_events ADD COLUMN updated_at TEXT;

UPDATE usage_events SET provenance = 'provider_measured' WHERE provenance = 'provider_reported';
UPDATE usage_events SET workload_type = 'deterministic' WHERE provider_id IS NULL AND model_id IS NULL;
UPDATE usage_events SET
  machine_id = (SELECT machine_id FROM runs WHERE runs.id = usage_events.run_id),
  workflow_id = (SELECT workflow_id FROM runs WHERE runs.id = usage_events.run_id)
WHERE run_id IS NOT NULL;
UPDATE usage_events SET total_tokens = input_tokens + output_tokens
WHERE input_tokens IS NOT NULL AND output_tokens IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request_id ON usage_events(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_workload ON usage_events(workload_type, occurred_at DESC);

-- One row per metered request. Status moves reserved -> reconciled | released. Hard caps are checked
-- inside a BEGIN IMMEDIATE transaction against active reservations plus reconciled actual spend.
CREATE TABLE IF NOT EXISTS metered_reservations (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  stage_id TEXT,
  usage_event_id TEXT,
  billing_lane TEXT NOT NULL,
  connection_profile_id TEXT,
  workload_type TEXT NOT NULL,
  reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
  actual_usd REAL,
  actual_provenance TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'reconciled', 'released')),
  cost_bound TEXT NOT NULL CHECK (cost_bound IN ('bounded', 'unbounded')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_run ON metered_reservations(run_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_created ON metered_reservations(created_at, status);

CREATE TABLE IF NOT EXISTS decision_results (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  stage_id TEXT,
  batch_id TEXT,
  usage_event_id TEXT,
  engine TEXT NOT NULL,
  provider_id TEXT,
  billing_lane TEXT,
  configured_model_id TEXT,
  resolved_model_id TEXT,
  upstream_provider TEXT,
  question_id TEXT NOT NULL,
  question_type TEXT NOT NULL CHECK (question_type IN ('boolean', 'choice', 'score')),
  question TEXT NOT NULL,
  answer_json TEXT,
  probability REAL,
  distribution_json TEXT,
  confidence REAL,
  confidence_kind TEXT,
  score REAL,
  legend_json TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'uncertain', 'choice')),
  route_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  cost_provenance TEXT NOT NULL DEFAULT 'unavailable',
  escalated_from_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_run ON decision_results(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_batch ON decision_results(batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS model_catalog_cache (
  backend_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  model_json TEXT NOT NULL,
  adapter_version TEXT,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, model_id)
);

CREATE TABLE IF NOT EXISTS external_data_consents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  approval_id TEXT,
  granted_at TEXT NOT NULL,
  UNIQUE (project_id, engine)
);
