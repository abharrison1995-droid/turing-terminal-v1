ALTER TABLE device_sessions ADD COLUMN tailscale_login TEXT;
ALTER TABLE device_sessions ADD COLUMN last_seen_at TEXT;

ALTER TABLE pairing_requests ADD COLUMN tailscale_login TEXT;
ALTER TABLE pairing_requests ADD COLUMN claimed_at TEXT;
ALTER TABLE pairing_requests ADD COLUMN completed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_token_hash ON device_sessions(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_requests_code_hash ON pairing_requests(code_hash);
CREATE INDEX IF NOT EXISTS idx_pairing_requests_expires ON pairing_requests(expires_at);
