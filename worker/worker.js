// Cloudflare Worker: ATXP Manager
// Storage:  D1 database (binding: DB)
// Auth:     Google Identity Services (ID token in Authorization: Bearer <jwt>)
// Secrets:  GOOGLE_CLIENT_ID   - OAuth client id from Google Cloud
//           ALLOWED_EMAIL      - your google email (only this email gets in)
//
// Routes:
//   GET    /admin/keys          list accounts (connection token is NOT returned)
//   POST   /admin/keys          add  {label, connection, balance}
//   PATCH  /admin/keys/:id      update {label?, balance?, connection?, status?}
//   DELETE /admin/keys/:id      remove
//   POST   /admin/probe         ping every key, delete the dead ones
//   ANY    /v1/*                OpenAI-compatible passthrough to llm.atxp.ai
//                               with automatic rotation + delete on 402/401

const ATXP_BASE = "https://llm.atxp.ai";
const DEFAULT_BALANCE = 3;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (url.pathname === "/" || url.pathname === "")
        return json({ name: "ATXP Manager Worker", ok: true });

      const authed = await requireGoogle(request, env);
      if (!authed.ok) return json({ error: authed.error }, 401);

      if (url.pathname.startsWith("/admin")) return await handleAdmin(request, url, env);
      if (url.pathname.startsWith("/v1/"))  return await handleProxy(request, url, env);
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

// ---------- Google ID-token verification ----------
let JWKS_CACHE = { keys: null, at: 0 };
async function getJwks() {
  const now = Date.now();
  if (JWKS_CACHE.keys && now - JWKS_CACHE.at < 3600000) return JWKS_CACHE.keys;
  const r = await fetch(GOOGLE_JWKS_URL);
  const j = await r.json();
  JWKS_CACHE = { keys: j.keys, at: now };
  return j.keys;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s) { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }

async function verifyGoogleIdToken(jwt, clientId) {
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) throw new Error("malformed jwt");
  const header  = b64urlToJson(h);
  const payload = b64urlToJson(p);
  const jwk = (await getJwks()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig),
    new TextEncoder().encode(h + "." + p),
  );
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("expired");
  if (payload.aud !== clientId) throw new Error("bad aud");
  if (!["accounts.google.com","https://accounts.google.com"].includes(payload.iss))
    throw new Error("bad iss");
  return payload;
}

async function requireGoogle(request, env) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, error: "missing bearer" };
  if (!env.GOOGLE_CLIENT_ID || !env.ALLOWED_EMAIL)
    return { ok: false, error: "server not configured (GOOGLE_CLIENT_ID / ALLOWED_EMAIL)" };
  try {
    const p = await verifyGoogleIdToken(bearer, env.GOOGLE_CLIENT_ID);
    if (!p.email_verified) return { ok: false, error: "email not verified" };
    if (p.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase())
      return { ok: false, error: "forbidden" };
    return { ok: true, email: p.email };
  } catch (e) {
    return { ok: false, error: "invalid token: " + e.message };
  }
}

// ---------- D1 helpers ----------
async function listKeys(env) {
  const { results } = await env.DB.prepare(
    "SELECT id,label,connection,account_id,balance,status,last_used,created_at FROM keys ORDER BY created_at ASC"
  ).all();
  return results || [];
}
async function getKey(env, id) {
  return await env.DB.prepare("SELECT * FROM keys WHERE id=?").bind(id).first();
}
async function delKey(env, id) {
  await env.DB.prepare("DELETE FROM keys WHERE id=?").bind(id).run();
}
async function insertKey(env, k) {
  await env.DB.prepare(
    "INSERT INTO keys(id,label,connection,account_id,balance,status,last_used,created_at) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(k.id, k.label, k.connection, k.account_id, k.balance, k.status, k.last_used, k.created_at).run();
}
async function updateKey(env, k) {
  await env.DB.prepare(
    "UPDATE keys SET label=?,connection=?,account_id=?,balance=?,status=?,last_used=? WHERE id=?"
  ).bind(k.label, k.connection, k.account_id, k.balance, k.status, k.last_used, k.id).run();
}

function publicView(k) {
  return {
    id: k.id, label: k.label, account_id: k.account_id,
    balance: k.balance, status: k.status, last_used: k.last_used,
    created_at: k.created_at,
  };
}
function parseConn(c) {
  try {
    const u = new URL(c);
    return { account_id: u.searchParams.get("account_id") || "" };
  } catch { return { account_id: "" }; }
}

// ---------- admin ----------
async function handleAdmin(request, url, env) {
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (parts[1] === "keys" && !id) {
    if (request.method === "GET") {
      const rows = await listKeys(env);
      return json({ keys: rows.map(publicView) });
    }
    if (request.method === "POST") {
      const body = await request.json();
      if (!body.connection) return json({ error: "connection required" }, 400);
      const rec = {
        id: crypto.randomUUID(),
        label: body.label || "",
        connection: body.connection,
        account_id: parseConn(body.connection).account_id,
        balance: typeof body.balance === "number" ? body.balance : DEFAULT_BALANCE,
        status: "ok",
        last_used: null,
        created_at: Date.now(),
      };
      await insertKey(env, rec);
      return json({ key: publicView(rec) }, 201);
    }
  }

  if (parts[1] === "keys" && id) {
    const existing = await getKey(env, id);
    if (!existing) return json({ error: "not found" }, 404);
    if (request.method === "DELETE") { await delKey(env, id); return json({ ok: true }); }
    if (request.method === "PATCH") {
      const body = await request.json();
      if (typeof body.label === "string") existing.label = body.label;
      if (typeof body.balance === "number" && !Number.isNaN(body.balance)) existing.balance = body.balance;
      if (typeof body.connection === "string" && body.connection) {
        existing.connection = body.connection;
        existing.account_id = parseConn(body.connection).account_id;
      }
      if (typeof body.status === "string") existing.status = body.status;
      await updateKey(env, existing);
      return json({ key: publicView(existing) });
    }
  }

  if (parts[1] === "probe" && request.method === "POST") {
    const rows = await listKeys(env);
    let removed = 0;
    for (const k of rows) {
      if (!(await probeKey(k.connection))) { await delKey(env, k.id); removed++; }
    }
    return json({ ok: true, removed });
  }

  return json({ error: "not found" }, 404);
}

async function probeKey(connection) {
  try {
    const r = await fetch(ATXP_BASE + "/v1/models", {
      headers: { "Authorization": "Bearer " + connection },
    });
    return r.status !== 402 && r.status !== 401;
  } catch { return true; }
}

// ---------- proxy with auto-rotation ----------
async function handleProxy(request, url, env) {
  const bodyBuf = ["GET","HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const path = url.pathname + url.search;

  const all = await listKeys(env);
  const pool = all.filter(k => k.status !== "dead")
                  .sort((a,b) => (a.last_used || 0) - (b.last_used || 0));
  if (!pool.length) return json({ error: "no ATXP keys configured" }, 503);

  let lastErr = null;
  for (const k of pool) {
    const upstream = await fetch(ATXP_BASE + path, {
      method: request.method,
      headers: {
        "Authorization": "Bearer " + k.connection,
        "Content-Type": request.headers.get("content-type") || "application/json",
      },
      body: bodyBuf,
    });

    if (upstream.status === 402 || upstream.status === 401) {
      await delKey(env, k.id);
      lastErr = { status: upstream.status, id: k.id };
      continue;
    }

    k.last_used = Date.now();
    k.balance = Math.max(0, Number(k.balance || 0) - 0.01);
    await updateKey(env, k);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...Object.fromEntries(upstream.headers), ...CORS },
    });
  }
  return json({ error: "all keys exhausted", last: lastErr }, 402);
}
