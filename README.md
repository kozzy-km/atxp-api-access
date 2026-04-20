# ATXP API Key Manager

Private mobile-friendly dashboard + Cloudflare Worker that stores a pool of ATXP API keys in D1 and auto-rotates them.

**Dashboard:** https://kozzy-km.github.io/atxp-api-access/
**Auth:** single password (you set it as a Worker secret).

## Files
- `index.html` — dashboard (GitHub Pages)
- `worker/worker.js` — Cloudflare Worker (D1 + proxy + password auth)
- `worker/wrangler.toml` — Worker config
- `worker/schema.sql` — D1 table

## How rotation works

**UI (visual):** a list of keys with active/dead pills, last-used timestamps.

**CF backend (what happens on every /v1/* call):**
1. Worker picks the active key with oldest last_used.
2. Forwards to api.atxp.ai with that key.
3. On 401/402 → marks key dead in D1, retries with next (up to 5).
4. On success → updates last_used.
