# ATXP Manager

A private dashboard + Cloudflare Worker that stores a pool of ATXP connection URLs
and exposes a single OpenAI-compatible endpoint (`/v1/*`) that **auto-rotates** the next
key when the current one returns `402` (out of balance) or `401` (invalid).
Dead keys are deleted from KV automatically.

## Architecture

```
 Your script  -->  https://atxp-api.<you>.workers.dev/v1/chat/completions
                         |  (Authorization: Bearer <ADMIN_TOKEN>)
                         v
                  Cloudflare Worker --KV--> pool of ATXP connection URLs
                         |
                         v
                  https://llm.atxp.ai/v1/*
```

The dashboard (`index.html`, GitHub Pages) talks to the Worker over `/admin/*`
with the `X-Admin-Token` header. Only someone who knows `ADMIN_TOKEN` can
list/add/edit/delete keys or use the proxy.

## One-time setup

### 1. Cloudflare Worker

```bash
npm i -g wrangler
git clone https://github.com/kozzy-km/atxp-api-access
cd atxp-api-access/worker

npx wrangler kv namespace create ATXP_KV
# paste the returned id into wrangler.toml

npx wrangler secret put ADMIN_TOKEN
# paste a long random token

npx wrangler deploy
```

You get a URL like `https://atxp-api.<your-subdomain>.workers.dev`.

### 2. GitHub Pages

In repo Settings -> Pages -> Source = `main` / root.
Your URL will be `https://kozzy-km.github.io/atxp-api-access/`.
Open it, paste Worker URL + `ADMIN_TOKEN`, you're in.

## Using the proxy from Python

```python
from openai import OpenAI
client = OpenAI(
    api_key="<ADMIN_TOKEN>",
    base_url="https://atxp-api.<you>.workers.dev/v1",
)
```

If a key returns 402/401 the Worker deletes it from KV and retries with the
next one - transparent to your script.

## Balance / total value

ATXP does not expose a public per-account balance HTTP endpoint
(`npx atxp balance` uses a signed CLI session), so the Worker:

* defaults each new account to $3.00 (common free credit),
* decrements a small amount per successful call,
* lets you edit balances manually in the UI,
* has a Probe button that pings `/v1/models` per key and deletes dead ones.

The dashboard totals the stored balances to show the pool estimated value.

## Security

* Every `/admin/*` route requires `X-Admin-Token`.
* Every `/v1/*` proxy call requires `Authorization: Bearer <ADMIN_TOKEN>`.
* Connection URLs never leave the Worker - only masked views reach the UI.
* The admin token lives only in Cloudflare secrets + your browser localStorage.

## Files

* `index.html` - static dashboard (GitHub Pages)
* `worker/worker.js` - Cloudflare Worker source
* `worker/wrangler.toml` - deploy config
