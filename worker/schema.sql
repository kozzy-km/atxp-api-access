-- Run:  npx wrangler d1 execute atxp_manager --file=worker/schema.sql --remote
CREATE TABLE IF NOT EXISTS keys (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  connection  TEXT NOT NULL,
  account_id  TEXT,
  balance     REAL NOT NULL DEFAULT 3,
  status      TEXT NOT NULL DEFAULT 'ok',
  last_used   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_last_used ON keys(last_used);
