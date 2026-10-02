CREATE TABLE IF NOT EXISTS connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  billing_lane TEXT NOT NULL,
  credential_store_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connection_profiles_lane
  ON connection_profiles(backend_id, provider_id, billing_lane);

CREATE INDEX IF NOT EXISTS idx_model_presets_name
  ON model_presets(name COLLATE NOCASE);
