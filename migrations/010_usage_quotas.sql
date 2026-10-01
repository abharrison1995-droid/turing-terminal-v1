CREATE TABLE quota_envelopes (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
  quota_name TEXT NOT NULL,
  window_label TEXT NOT NULL,
  reset_at TEXT NOT NULL,
  allowance REAL NOT NULL CHECK (allowance > 0),
  unit TEXT NOT NULL CHECK (unit IN ('input_tokens', 'output_tokens', 'total_tokens', 'requests', 'minutes')),
  notes TEXT NOT NULL DEFAULT '',
  effective_at TEXT NOT NULL,
  subscription_cost_usd REAL CHECK (subscription_cost_usd IS NULL OR subscription_cost_usd >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
