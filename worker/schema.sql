CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  api_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_used INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_active_lastused ON keys(active, last_used);
