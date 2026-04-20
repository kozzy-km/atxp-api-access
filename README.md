# ATXP Key Manager — v5

Self-hosted Cloudflare Worker that proxies OpenAI-compatible requests to ATXP with:
- Multi-key pool + automatic rotation on 401/402
- Per-key credit tracking ($) and token counters
- Full request logs
- Playground with all sampling params + code export (Python / cURL)
- Single password auth (DASHBOARD_PASSWORD)

## Endpoints
- `GET  /`                     — web console (HTML)
- `GET  /health`               — public health check
- `POST /v1/chat/completions`  — OpenAI-compatible proxy (auth: Bearer DASHBOARD_PASSWORD)
- `GET  /admin/stats`
- `GET  /admin/logs?limit=N`
- `GET|POST /admin/keys`
- `POST /admin/keys/:id/toggle` `{active: bool}`
- `POST /admin/keys/:id/reset`
- `DELETE /admin/keys/:id`

## Upgrade from v4
Run these in your D1 console (Cloudflare dashboard → D1 → your DB → Console) once:
```sql
ALTER TABLE keys ADD COLUMN credit_cents INTEGER DEFAULT 300;
ALTER TABLE keys ADD COLUMN used_cents INTEGER DEFAULT 0;
ALTER TABLE keys ADD COLUMN prompt_tokens INTEGER DEFAULT 0;
ALTER TABLE keys ADD COLUMN completion_tokens INTEGER DEFAULT 0;
```
Then create the logs table:
```sql
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, key_id INTEGER, model TEXT, status INTEGER,
  prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0, duration_ms INTEGER, stream INTEGER DEFAULT 0,
  request_json TEXT, response_preview TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
```

## Deploy
```
cd worker
wrangler deploy
```

## Using from code
```python
from openai import OpenAI
client = OpenAI(api_key="YOUR_DASHBOARD_PASSWORD", base_url="https://your-worker.workers.dev/v1")
```

## Pricing
Edit the `PRICE` table at the top of `worker.js` to match ATXP's real rates. Defaults are Claude-family estimates.
