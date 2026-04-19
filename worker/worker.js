// Cloudflare Worker: ATXP Manager proxy + admin API
// Bindings required (see wrangler.toml):
//   - KV namespace: ATXP_KV
//   - Secret: ADMIN_TOKEN (the password you and only you know)
//
// Routes:
//   GET  /admin/keys           -> list stored accounts (no connection tokens leaked)
//   POST /admin/keys           -> add {label, connection, balance}
//   PATCH /admin/keys/:id      -> update {label?, balance?}
//   DELETE /admin/keys/:id     -> remove
//   POST /admin/probe          -> tiny request on each key to mark dead ones
//   ANY  /v1/*                 -> OpenAI-compatible passthrough to llm.atxp.ai with auto-rotation

const ATXP_BASE = "https://llm.atxp.ai";
const DEFAULT_BALANCE = 3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type,x-admin-token",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname.startsWith("/admin")) {
        const token = request.headers.get("x-admin-token") || "";
        if (!safeEq(token, env.ADMIN_TOKEN || "")) {
          return json({ error: "unauthorized" }, 401, cors);
        }
        return await handleAdmin(request, url, env, cors);
      }
      if (url.pathname.startsWith("/v1/")) {
        return await handleProxy(request, url, env, cors);
      }
      return json({ name: "ATXP Manager Worker", ok: true }, 200, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, cors);
    }
  }
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extra }
  });
}
function safeEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function uuid() { return crypto.randomUUID(); }

async function listKeys(env) {
  const list = await env.ATXP_KV.list({ prefix: "key:" });
  const out = [];
  for (const k of list.keys) {
    const v = await env.ATXP_KV.get(k.name, "json");
    if (v) out.push(v);
  }
  out.sort((a, b) => (a.created_at||0) - (b.created_at||0));
  return out;
}
async function putKey(env, k) { await env.ATXP_KV.put("key:" + k.id, JSON.stringify(k)); }
async function getKey(env, id) { return await env.ATXP_KV.get("key:" + id, "json"); }
async function delKey(env, id) { await env.ATXP_KV.delete("key:" + id); }

function parseConnection(connection) {
  try {
    const u = new URL(connection);
    return {
      connection_token: u.searchParams.get("connection_token") || "",
      account_id: u.searchParams.get("account_id") || "",
    };
  } catch { return { connection_token: "", account_id: "" }; }
}

function publicView(k) {
  return {
    id: k.id, label: k.label, account_id: k.account_id,
    balance: k.balance, status: k.status, last_used: k.last_used,
    created_at: k.created_at,
  };
}

async function handleAdmin(request, url, env, cors) {
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  if (parts[1] === "keys" && !id) {
    if (request.method === "GET") {
      const keys = await listKeys(env);
      return json({ keys: keys.map(publicView) }, 200, cors);
    }
    if (request.method === "POST") {
      const body = await request.json();
      if (!body.connection) return json({ error: "connection required" }, 400, cors);
      const parsed = parseConnection(body.connection);
      const rec = {
        id: uuid(),
        label: body.label || "",
        connection: body.connection,
        account_id: parsed.account_id,
        balance: typeof body.balance === "number" ? body.balance : DEFAULT_BALANCE,
        status: "ok",
        last_used: null,
        created_at: Date.now(),
      };
      await putKey(env, rec);
      return json({ key: publicView(rec) }, 201, cors);
    }
  }

  if (parts[1] === "keys" && id) {
    const existing = await getKey(env, id);
    if (!existing) return json({ error: "not found" }, 404, cors);
    if (request.method === "DELETE") { await delKey(env, id); return json({ ok: true }, 200, cors); }
    if (request.method === "PATCH") {
      const body = await request.json();
      if (typeof body.label === "string") existing.label = body.label;
      if (typeof body.balance === "number" && !Number.isNaN(body.balance)) existing.balance = body.balance;
      if (typeof body.connection === "string" && body.connection) {
        existing.connection = body.connection;
        const p = parseConnection(body.connection); existing.account_id = p.account_id;
      }
      if (typeof body.status === "string") existing.status = body.status;
      await putKey(env, existing);
      return json({ key: publicView(existing) }, 200, cors);
    }
  }

  if (parts[1] === "probe" && request.method === "POST") {
    const keys = await listKeys(env);
    for (const k of keys) {
      const ok = await probeKey(k.connection);
      if (!ok) { await delKey(env, k.id); }
    }
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "not found" }, 404, cors);
}

async function probeKey(connection) {
  try {
    const r = await fetch(ATXP_BASE + "/v1/models", {
      headers: { "Authorization": "Bearer " + connection }
    });
    return r.status !== 402 && r.status !== 401;
  } catch { return true; }
}

async function handleProxy(request, url, env, cors) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (!safeEq(bearer, env.ADMIN_TOKEN || "")) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  const bodyBuf = await request.arrayBuffer();
  const path = url.pathname + url.search;

  const keys = await listKeys(env);
  if (keys.length === 0) return json({ error: "no ATXP keys configured" }, 503, cors);

  const ordered = keys
    .filter(k => k.status !== "dead")
    .sort((a, b) => (a.last_used || 0) - (b.last_used || 0));

  let lastErr = null;
  for (const k of ordered) {
    const upstream = await fetch(ATXP_BASE + path, {
      method: request.method,
      headers: {
        "Authorization": "Bearer " + k.connection,
        "Content-Type": request.headers.get("content-type") || "application/json",
      },
      body: ["GET","HEAD"].includes(request.method) ? undefined : bodyBuf,
    });

    if (upstream.status === 402 || upstream.status === 401) {
      await delKey(env, k.id);
      lastErr = { status: upstream.status, id: k.id };
      continue;
    }

    k.last_used = Date.now();
    k.balance = Math.max(0, Number(k.balance || 0) - 0.01);
    await putKey(env, k);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...Object.fromEntries(upstream.headers), ...cors }
    });
  }
  return json({ error: "all keys exhausted", last: lastErr }, 402, cors);
}
