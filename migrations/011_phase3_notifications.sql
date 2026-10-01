ALTER TABLE pairing_requests ADD COLUMN denied_at TEXT;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  device_session_id TEXT REFERENCES device_sessions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE push_delivery_keys (
  delivery_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE push_notification_state (
  state_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
