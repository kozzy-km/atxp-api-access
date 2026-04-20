-- v5 schema: keys + usage logs
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  api_key TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  credit_cents INTEGER DEFAULT 300,
  used_cents INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  last_used INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  key_id INTEGER,
  model TEXT,
  status INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,
  duration_ms INTEGER,
  stream INTEGER DEFAULT 0,
  request_json TEXT,
  response_preview TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
