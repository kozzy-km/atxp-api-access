// ATXP API Key Manager - Cloudflare Worker
// Auth: simple password (DASHBOARD_PASSWORD secret)
// Storage: D1 database (binding: DB)
// Proxy: forwards /v1/* to ATXP with auto-rotation on 401/402

const ATXP_BASE = "https://llm.atxp.ai";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function checkAuth(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.replace(/^Bearer\s+/i, "").trim();
  if (!token || !env.DASHBOARD_PASSWORD) return false;
  return token === env.DASHBOARD_PASSWORD;
}

async function pickKey(env) {
  const row = await env.DB.prepare(
    "SELECT id, api_key FROM keys WHERE active = 1 ORDER BY COALESCE(last_used, 0) ASC LIMIT 1"
  ).first();
  return row || null;
}

async function markUsed(env, id) {
  await env.DB.prepare("UPDATE keys SET last_used = ?1 WHERE id = ?2")
    .bind(Date.now(), id).run();
}

async function markDead(env, id) {
  await env.DB.prepare("UPDATE keys SET active = 0 WHERE id = ?1").bind(id).run();
}

async function listKeys(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, active, last_used, created_at, substr(api_key,1,6)||'...'||substr(api_key,-4) AS preview FROM keys ORDER BY id DESC"
  ).all();
  return results || [];
}

async function addKey(env, label, apiKey) {
  await env.DB.prepare(
    "INSERT INTO keys (label, api_key, active, created_at) VALUES (?1, ?2, 1, ?3)"
  ).bind(label || "key", apiKey, Date.now()).run();
}

async function deleteKey(env, id) {
  await env.DB.prepare("DELETE FROM keys WHERE id = ?1").bind(id).run();
}

async function toggleKey(env, id, active) {
  await env.DB.prepare("UPDATE keys SET active = ?1 WHERE id = ?2")
    .bind(active ? 1 : 0, id).run();
}

async function proxyATXP(request, env, path) {
  const maxTries = 5;
  let lastStatus = 500, lastBody = "no active keys";

  for (let i = 0; i < maxTries; i++) {
    const key = await pickKey(env);
    if (!key) return new Response("No active ATXP keys in pool", { status: 503, headers: CORS });

    const url = ATXP_BASE + path + (new URL(request.url).search || "");
    const headers = new Headers(request.headers);
    headers.set("Authorization", "Bearer " + key.api_key);
    headers.delete("host");

    const init = {
      method: request.method,
      headers,
      body: ["GET","HEAD"].includes(request.method) ? undefined : await request.clone().arrayBuffer(),
    };

    const resp = await fetch(url, init);

    if (resp.status === 401 || resp.status === 402) {
      await markDead(env, key.id);
      lastStatus = resp.status;
      lastBody = await resp.text();
      continue;
    }
    await markUsed(env, key.id);
    const out = new Response(resp.body, { status: resp.status, headers: resp.headers });
    for (const [k,v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  }
  return new Response("All keys exhausted. Last: " + lastBody, { status: lastStatus, headers: CORS });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true });

    if (!checkAuth(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (path === "/admin/keys" && request.method === "GET") {
      return json(await listKeys(env));
    }
    if (path === "/admin/keys" && request.method === "POST") {
      const body = await request.json();
      if (!body.api_key) return json({ error: "api_key required" }, 400);
      await addKey(env, body.label, body.api_key);
      return json({ ok: true });
    }
    if (path.startsWith("/admin/keys/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      await deleteKey(env, id);
      return json({ ok: true });
    }
    if (path.startsWith("/admin/keys/") && path.endsWith("/toggle") && request.method === "POST") {
      const id = Number(path.split("/")[3]);
      const body = await request.json();
      await toggleKey(env, id, !!body.active);
      return json({ ok: true });
    }

    if (path.startsWith("/v1/")) {
      return proxyATXP(request, env, path);
    }

    return json({ error: "not found" }, 404);
  },
};
