ALTER TABLE stages ADD COLUMN connection_profile_id TEXT;
ALTER TABLE stages ADD COLUMN billing_lane TEXT;
ALTER TABLE stages ADD COLUMN variant_id TEXT;
ALTER TABLE stages ADD COLUMN model_snapshot_json TEXT;

ALTER TABLE usage_events ADD COLUMN connection_profile_id TEXT;
ALTER TABLE usage_events ADD COLUMN billing_lane TEXT;
ALTER TABLE usage_events ADD COLUMN variant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_billing_lane ON usage_events(billing_lane, occurred_at DESC);
