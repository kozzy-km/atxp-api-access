# ATXP Manager

A small private dashboard + Cloudflare Worker that stores a pool of ATXP connection URLs in **Cloudflare D1** and exposes a single OpenAI-compatible endpoint (`/v1/*`) that **auto-rotates** to the next key as soon as the current one returns `402` / `401`. The dead key is deleted from D1 automatically.

Access is gated by **Google Sign-In**: only the email you whitelist on the Worker (`ALLOWED_EMAIL`) can log in or use the proxy.

## Architecture

```
  Browser (GitHub Pages UI)
      |  google.accounts.id -> ID token (JWT)
      v
  Cloudflare Worker  -- verifies JWT (signature + aud + email) --
      |
      +--> /admin/*   CRUD against D1 table `keys`
      |
      +--> /v1/*      rotates keys from D1, calls llm.atxp.ai,
                      deletes the row on 402/401 and retries.
```

## 1. Google Cloud - OAuth client id

1. https://console.cloud.google.com/ -> APIs & Services -> **Credentials**.
2. **Create credentials -> OAuth client ID** -> Application type: **Web application**.
3. Authorized JavaScript origins:
   - `https://kozzy-km.github.io`
4. Copy the **Client ID** (looks like `...apps.googleusercontent.com`).
5. Note the Google email you want to allow in.

## 2. Cloudflare - Worker + D1

```bash
git clone https://github.com/kozzy-km/atxp-api-access
cd atxp-api-access/worker
npm i -g wrangler
npx wrangler login

# Create the D1 database and copy the returned database_id into wrangler.toml
npx wrangler d1 create atxp_manager

# Create the table in the remote DB
npx wrangler d1 execute atxp_manager --file=schema.sql --remote

# Put your Google client id into wrangler.toml (under [vars]).
# Put your allow-listed Google email as a Worker secret:
npx wrangler secret put ALLOWED_EMAIL
# (paste: your-email@gmail.com)

# Deploy
npx wrangler deploy
```

You get a URL like `https://atxp-api.<you>.workers.dev`.

## 3. GitHub Pages - the UI

Pages is already enabled from `main` / root. Open:
**https://kozzy-km.github.io/atxp-api-access/**

- Paste the Worker URL + the Google Client ID.
- Click **Sign in with Google**. Only the whitelisted email gets past the Worker.

## 4. Using the proxy from Python

The Worker verifies a Google **ID token** in `Authorization: Bearer`.

For interactive use, open the dashboard once and copy the token from DevTools.
For scripts, generate a fresh ID token with `gcloud auth print-identity-token` or a service-account/OIDC flow and feed it as `api_key`:

```python
from openai import OpenAI
client = OpenAI(
    api_key=GOOGLE_ID_TOKEN,                       # fresh per run
    base_url="https://atxp-api.<you>.workers.dev/v1",
)
```

## How key rotation works (backend, Cloudflare side)

On every request to `/v1/*`:

1. **Auth check** - the Worker verifies the ID token (signature against Google's JWKS, `aud == GOOGLE_CLIENT_ID`, `exp > now`, `email == ALLOWED_EMAIL`).
2. **Pool load** - `SELECT ... FROM keys WHERE status!='dead' ORDER BY last_used ASC`. Least-recently-used key first.
3. **Attempt** - forward the request to `https://llm.atxp.ai<path>` with `Authorization: Bearer <connection_url>` taken from the row.
4. **If upstream returns 401 or 402** -> `DELETE FROM keys WHERE id=?` and **continue** to step 3 with the next row. Your client never sees the 402.
5. **Otherwise** return the upstream response verbatim. Set `last_used = now()` and decrement a small balance estimate.
6. If every row in the pool has been tried and all failed, return `402 {"error":"all keys exhausted"}` so the caller knows the pool is empty.

Constant switching: because the pool is ordered by `last_used` ASC, sequential calls naturally round-robin across healthy keys, and the instant one goes bad it's removed from D1 and skipped in future requests.

## Balances

ATXP has no public per-account balance HTTP endpoint today (`npx atxp balance` uses a signed CLI session), so we approximate:

- new key defaults to `$3.00` (common free credit),
- each successful call decrements `$0.01`,
- you can edit balances in the UI any time,
- the **Probe** button hits `/v1/models` with each stored key and drops the ones that return 401/402.

If ATXP publishes a balance endpoint, only `probeKey()` in `worker/worker.js` needs updating.

## Files

- `index.html`          - GitHub Pages dashboard (Google Sign-In + CRUD UI)
- `worker/worker.js`    - Cloudflare Worker (JWT verify + D1 + rotation proxy)
- `worker/wrangler.toml`- Worker config (D1 binding, Google client id)
- `worker/schema.sql`   - D1 table definition
