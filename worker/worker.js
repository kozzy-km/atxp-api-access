// ATXP Key Manager - Worker v5
// - Password auth via DASHBOARD_PASSWORD
// - D1 pool with auto-rotation on 401/402
// - Usage tracking (tokens + $ estimate) per key + global
// - Request logs
// - Proxy /v1/* to https://llm.atxp.ai

const ATXP_BASE = "https://llm.atxp.ai";

// Cents per 1M tokens. Editable. Default = Claude Opus-ish estimate.
const PRICE = {
  "default":         { in: 1500, out: 7500 },
  "claude-opus-4-7": { in: 1500, out: 7500 },
  "claude-sonnet-4": { in: 300,  out: 1500 },
  "claude-haiku-4":  { in: 80,   out: 400  },
  "gpt-4o":          { in: 250,  out: 1000 },
  "gpt-4o-mini":     { in: 15,   out: 60   },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const j = (d, s=200) => new Response(JSON.stringify(d), {
  status: s, headers: { "Content-Type":"application/json", ...CORS }
});

function auth(req, env) {
  const t = (req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"").trim();
  return t && env.DASHBOARD_PASSWORD && t === env.DASHBOARD_PASSWORD;
}

function priceFor(model) {
  if (!model) return PRICE.default;
  const m = model.toLowerCase();
  for (const k of Object.keys(PRICE)) if (m.includes(k)) return PRICE[k];
  return PRICE.default;
}
function costCents(model, pin, pout) {
  const p = priceFor(model);
  return Math.ceil((pin * p.in + pout * p.out) / 1_000_000);
}

// ---------- D1 helpers ----------
async function pickKey(env) {
  return await env.DB.prepare(
    "SELECT id, api_key, credit_cents, used_cents FROM keys WHERE active=1 AND used_cents < credit_cents ORDER BY COALESCE(last_used,0) ASC LIMIT 1"
  ).first();
}
const markUsed = (env,id) => env.DB.prepare("UPDATE keys SET last_used=?1 WHERE id=?2").bind(Date.now(),id).run();
const markDead = (env,id) => env.DB.prepare("UPDATE keys SET active=0 WHERE id=?1").bind(id).run();

async function addUsage(env, id, pin, pout, cents) {
  await env.DB.prepare(
    "UPDATE keys SET prompt_tokens=prompt_tokens+?1, completion_tokens=completion_tokens+?2, used_cents=used_cents+?3 WHERE id=?4"
  ).bind(pin|0, pout|0, cents|0, id).run();
}

async function writeLog(env, row) {
  await env.DB.prepare(
    "INSERT INTO logs (ts,key_id,model,status,prompt_tokens,completion_tokens,cost_cents,duration_ms,stream,request_json,response_preview,error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
  ).bind(
    Date.now(), row.key_id||null, row.model||"", row.status|0,
    row.pin|0, row.pout|0, row.cost|0, row.dur|0, row.stream?1:0,
    row.req||"", row.preview||"", row.error||null
  ).run();
}

// ---------- Admin API ----------
async function listKeys(env) {
  const { results } = await env.DB.prepare(
    "SELECT id,label,active,credit_cents,used_cents,prompt_tokens,completion_tokens,last_used,created_at, substr(api_key,1,10)||'...'||substr(api_key,-6) AS preview FROM keys ORDER BY id DESC"
  ).all();
  return results||[];
}
async function stats(env) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(active) AS active_n, SUM(credit_cents) AS credit, SUM(used_cents) AS used, SUM(prompt_tokens) AS pin, SUM(completion_tokens) AS pout FROM keys"
  ).first();
  const r2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM logs").first();
  return {
    keys_total: r.total||0, keys_active: r.active_n||0,
    credit_cents: r.credit||0, used_cents: r.used||0, remaining_cents: (r.credit||0)-(r.used||0),
    prompt_tokens: r.pin||0, completion_tokens: r.pout||0, logs: r2.n||0,
  };
}
async function getLogs(env, limit=100) {
  const { results } = await env.DB.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?1").bind(limit).all();
  return results||[];
}

// ---------- Proxy + usage capture ----------
async function proxyATXP(request, env, path) {
  const started = Date.now();
  let body = null;
  if (!["GET","HEAD"].includes(request.method)) body = await request.clone().arrayBuffer();
  let parsedReq = null;
  try { parsedReq = body ? JSON.parse(new TextDecoder().decode(body)) : null; } catch(e){}
  const isStream = !!(parsedReq && parsedReq.stream);
  const model = (parsedReq && parsedReq.model) || "";

  for (let i = 0; i < 5; i++) {
    const key = await pickKey(env);
    if (!key) {
      await writeLog(env, { model, status: 503, dur: Date.now()-started, stream: isStream,
        req: parsedReq?JSON.stringify(parsedReq).slice(0,4000):"", error: "no active keys" });
      return new Response("No active ATXP keys available", { status: 503, headers: CORS });
    }

    const url = ATXP_BASE + path + (new URL(request.url).search || "");
    const headers = new Headers(request.headers);
    headers.set("Authorization", "Bearer " + key.api_key);
    headers.delete("host");

    const upstream = await fetch(url, { method: request.method, headers, body });

    if (upstream.status === 401 || upstream.status === 402) {
      await markDead(env, key.id);
      const txt = await upstream.text();
      await writeLog(env, { key_id: key.id, model, status: upstream.status, dur: Date.now()-started,
        stream: isStream, req: parsedReq?JSON.stringify(parsedReq).slice(0,4000):"",
        error: "key dead: " + txt.slice(0,300) });
      continue;
    }

    await markUsed(env, key.id);

    if (!isStream) {
      const buf = await upstream.arrayBuffer();
      const txt = new TextDecoder().decode(buf);
      let pin=0, pout=0, preview="";
      try {
        const j = JSON.parse(txt);
        if (j.usage) { pin = j.usage.prompt_tokens||0; pout = j.usage.completion_tokens||0; }
        preview = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").slice(0,500);
      } catch(e){}
      const cost = costCents(model, pin, pout);
      if (pin||pout) await addUsage(env, key.id, pin, pout, cost);
      await writeLog(env, { key_id: key.id, model, status: upstream.status, pin, pout, cost,
        dur: Date.now()-started, stream: false,
        req: parsedReq?JSON.stringify(parsedReq).slice(0,4000):"", preview });
      const out = new Response(buf, { status: upstream.status, headers: upstream.headers });
      for (const [k,v] of Object.entries(CORS)) out.headers.set(k,v);
      return out;
    }

    // streaming: tee, pass one to client, parse the other for usage
    const [a, b] = upstream.body.tee();
    (async () => {
      let pin=0, pout=0, preview="", buf="";
      const reader = b.getReader(); const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          buf += chunk;
          for (const line of chunk.split("\n")) {
            const s = line.trim();
            if (!s.startsWith("data:")) continue;
            const payload = s.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const ev = JSON.parse(payload);
              if (ev.usage) { pin = ev.usage.prompt_tokens||pin; pout = ev.usage.completion_tokens||pout; }
              const d = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
              if (d && preview.length<500) preview += d;
            } catch(e){}
          }
        }
      } catch(e){}
      const cost = costCents(model, pin, pout);
      if (pin||pout) await addUsage(env, key.id, pin, pout, cost);
      await writeLog(env, { key_id: key.id, model, status: upstream.status, pin, pout, cost,
        dur: Date.now()-started, stream: true,
        req: parsedReq?JSON.stringify(parsedReq).slice(0,4000):"", preview: preview.slice(0,500) });
    })();

    const out = new Response(a, { status: upstream.status, headers: upstream.headers });
    for (const [k,v] of Object.entries(CORS)) out.headers.set(k,v);
    return out;
  }
  return new Response("All keys exhausted", { status: 402, headers: CORS });
}

// ---------- Entry ----------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return j({ ok:true, version:"v5" });
    if (path === "/" || path === "/index.html") {
      return new Response(INDEX_HTML, { headers: { "Content-Type":"text/html; charset=utf-8" } });
    }

    if (!auth(request, env)) return j({ error:"unauthorized" }, 401);

    if (path === "/admin/stats") return j(await stats(env));
    if (path === "/admin/logs") {
      const lim = Number(url.searchParams.get("limit")||100);
      return j(await getLogs(env, Math.min(lim, 500)));
    }
    if (path === "/admin/keys" && request.method === "GET") return j(await listKeys(env));
    if (path === "/admin/keys" && request.method === "POST") {
      const b = await request.json();
      if (!b.api_key) return j({ error:"api_key required" }, 400);
      const credit = Number(b.credit_cents||300);
      await env.DB.prepare("INSERT INTO keys (label,api_key,active,credit_cents,used_cents,created_at) VALUES (?1,?2,1,?3,0,?4)")
        .bind(b.label||"key", b.api_key, credit, Date.now()).run();
      return j({ ok:true });
    }
    if (path.startsWith("/admin/keys/") && path.endsWith("/toggle") && request.method === "POST") {
      const id = Number(path.split("/")[3]);
      const b = await request.json();
      await env.DB.prepare("UPDATE keys SET active=?1 WHERE id=?2").bind(b.active?1:0, id).run();
      return j({ ok:true });
    }
    if (path.startsWith("/admin/keys/") && path.endsWith("/reset") && request.method === "POST") {
      const id = Number(path.split("/")[3]);
      await env.DB.prepare("UPDATE keys SET used_cents=0,prompt_tokens=0,completion_tokens=0,active=1 WHERE id=?1").bind(id).run();
      return j({ ok:true });
    }
    if (path.startsWith("/admin/keys/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      await env.DB.prepare("DELETE FROM keys WHERE id=?1").bind(id).run();
      return j({ ok:true });
    }

    if (path.startsWith("/v1/")) return proxyATXP(request, env, path);
    return j({ error:"not found" }, 404);
  },
};

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ATXP Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0b; --surface:#111113; --surface-2:#17171a; --border:#24242a;
  --text:#e7e7ea; --muted:#8a8a94; --accent:#3b82f6; --accent-2:#2563eb;
  --ok:#10b981; --warn:#f59e0b; --err:#ef4444; --radius:10px;
}
html,body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
body{min-height:100vh}
code,pre,.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
button{font:inherit;cursor:pointer;border:none;background:none;color:inherit}
input,textarea,select{font:inherit;color:inherit;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 11px;width:100%;outline:none;transition:border-color .15s}
input:focus,textarea:focus,select:focus{border-color:var(--accent)}
textarea{resize:vertical;min-height:80px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 14px;border-radius:8px;font-weight:500;font-size:13px;background:var(--surface-2);border:1px solid var(--border);transition:all .15s}
.btn:hover{background:#1e1e22;border-color:#2e2e35}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent-2)}
.btn.danger{color:var(--err);border-color:#3a1d1f}
.btn.danger:hover{background:#2a1214}
.btn.sm{padding:5px 10px;font-size:12px}
.btn:disabled{opacity:.5;cursor:not-allowed}

/* Layout */
.app{display:grid;grid-template-rows:auto 1fr;min-height:100vh}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);background:rgba(10,10,11,.85);backdrop-filter:blur(10px);position:sticky;top:0;z-index:10}
.logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;letter-spacing:-.01em}
.logo-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
.tabs{display:flex;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:3px}
.tab{padding:6px 12px;border-radius:7px;font-size:13px;color:var(--muted);font-weight:500;transition:all .15s}
.tab.active{background:var(--surface-2);color:var(--text)}
.logout{color:var(--muted);font-size:13px}
.logout:hover{color:var(--text)}

main{padding:20px;max-width:1200px;margin:0 auto;width:100%}
.view{animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* Login */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.login-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:32px;width:100%;max-width:380px}
.login-card h1{font-size:18px;margin-bottom:4px;letter-spacing:-.01em}
.login-card p{color:var(--muted);margin-bottom:20px;font-size:13px}

/* Cards */
.grid{display:grid;gap:14px}
.grid.cols-4{grid-template-columns:repeat(4,1fr)}
.grid.cols-2{grid-template-columns:repeat(2,1fr)}
@media(max-width:780px){.grid.cols-4{grid-template-columns:repeat(2,1fr)}.grid.cols-2{grid-template-columns:1fr}.tabs{overflow-x:auto}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
.card h2{font-size:13px;font-weight:500;color:var(--muted);letter-spacing:.02em;text-transform:uppercase;margin-bottom:10px}
.stat{font-size:24px;font-weight:600;letter-spacing:-.02em}
.stat-sub{color:var(--muted);font-size:12px;margin-top:4px}

/* Keys table */
.section-title{display:flex;justify-content:space-between;align-items:center;margin:24px 0 12px}
.section-title h2{font-size:16px;font-weight:600;letter-spacing:-.01em}
.key-row{display:grid;grid-template-columns:1fr auto;gap:12px;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:8px;align-items:center}
.key-label{font-weight:500}
.key-preview{color:var(--muted);font-size:12px;margin-top:2px}
.key-meta{display:flex;gap:14px;margin-top:8px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;border:1px solid}
.pill.on{color:var(--ok);border-color:#0f3a2d;background:#07201a}
.pill.off{color:var(--muted);border-color:var(--border)}
.progress{height:3px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:8px}
.progress>div{height:100%;background:var(--accent);transition:width .3s}
.progress.warn>div{background:var(--warn)}
.progress.err>div{background:var(--err)}
.key-actions{display:flex;gap:6px;align-items:flex-start}

/* Playground */
.pg{display:grid;grid-template-columns:1fr 320px;gap:16px}
@media(max-width:980px){.pg{grid-template-columns:1fr}}
.pg-output{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;min-height:300px;white-space:pre-wrap;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;overflow:auto;max-height:60vh}
.pg-side .card{margin-bottom:12px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:500}
.field .row{display:flex;gap:8px;align-items:center}
.field .row input[type=range]{flex:1}
.field .row .val{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;min-width:40px;text-align:right;color:var(--muted)}
.msg-item{border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;background:var(--surface-2)}
.msg-item .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.msg-item select{width:auto;padding:4px 8px;font-size:12px}

/* Logs */
.log-row{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--surface);margin-bottom:6px;cursor:pointer;transition:border-color .15s}
.log-row:hover{border-color:#333}
.log-head{display:flex;gap:12px;align-items:center;font-size:13px;flex-wrap:wrap}
.log-status{padding:1px 7px;border-radius:5px;font-size:11px;font-weight:600;font-family:'JetBrains Mono',ui-monospace,monospace}
.log-status.ok{background:#07201a;color:var(--ok)}
.log-status.err{background:#2a1214;color:var(--err)}
.log-time{color:var(--muted);font-size:12px;margin-left:auto}
.log-detail{display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.log-row.open .log-detail{display:block}
.log-detail pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11.5px;overflow:auto;max-height:240px;margin-top:6px}

/* Modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100;padding:20px;backdrop-filter:blur(4px)}
.modal-bg.show{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;width:100%;max-width:480px}
.modal h3{font-size:15px;margin-bottom:14px;letter-spacing:-.01em}

.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);padding:10px 16px;border-radius:10px;font-size:13px;z-index:1000;animation:fade .2s ease}
.empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:13px}
hr{border:none;border-top:1px solid var(--border);margin:12px 0}
</style>
</head>
<body>

<div id="login" class="login-wrap">
  <div class="login-card">
    <h1>ATXP Console</h1>
    <p>Enter dashboard password to continue.</p>
    <input id="pw" type="password" placeholder="Password" autofocus>
    <div style="height:10px"></div>
    <button class="btn primary" style="width:100%" onclick="doLogin()">Sign in</button>
    <div id="login-err" style="color:var(--err);margin-top:10px;font-size:12px;display:none">Incorrect password.</div>
  </div>
</div>

<div id="app" class="app" style="display:none">
  <header>
    <div class="logo"><span class="logo-dot"></span>ATXP Console</div>
    <div class="tabs">
      <button class="tab active" data-view="dashboard">Dashboard</button>
      <button class="tab" data-view="keys">Keys</button>
      <button class="tab" data-view="playground">Playground</button>
      <button class="tab" data-view="logs">Logs</button>
    </div>
    <button class="logout" onclick="logout()">Sign out</button>
  </header>

  <main>
    <div id="view-dashboard" class="view">
      <div class="grid cols-4">
        <div class="card"><h2>Total credit</h2><div class="stat" id="s-credit">—</div><div class="stat-sub" id="s-credit-sub"></div></div>
        <div class="card"><h2>Remaining</h2><div class="stat" id="s-remaining">—</div><div class="stat-sub" id="s-remaining-sub"></div></div>
        <div class="card"><h2>Active keys</h2><div class="stat" id="s-active">—</div><div class="stat-sub" id="s-active-sub"></div></div>
        <div class="card"><h2>Requests</h2><div class="stat" id="s-reqs">—</div><div class="stat-sub" id="s-reqs-sub"></div></div>
      </div>
      <div class="section-title"><h2>Recent activity</h2><button class="btn sm" onclick="go('logs')">View all</button></div>
      <div id="recent-logs"></div>
    </div>

    <div id="view-keys" class="view" style="display:none">
      <div class="section-title"><h2>API Keys</h2><button class="btn primary" onclick="openAddKey()">Add key</button></div>
      <div id="keys-list"></div>
    </div>

    <div id="view-playground" class="view" style="display:none">
      <div class="pg">
        <div>
          <div class="card">
            <h2 style="margin-bottom:10px">Messages</h2>
            <div id="msgs"></div>
            <button class="btn sm" onclick="addMsg('user','')">+ Add message</button>
          </div>
          <div style="height:12px"></div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn primary" onclick="runPG()" id="run-btn">Run</button>
            <button class="btn" onclick="exportCode('python')">Export Python</button>
            <button class="btn" onclick="exportCode('curl')">Export cURL</button>
            <button class="btn" onclick="clearOutput()">Clear</button>
          </div>
          <div style="height:12px"></div>
          <div class="pg-output" id="pg-out">Output will appear here.</div>
        </div>
        <div class="pg-side">
          <div class="card">
            <h2>Model & Sampling</h2>
            <div class="field"><label>Model</label><input id="p-model" value="claude-opus-4-7"></div>
            <div class="field"><label>Temperature <span class="val" id="p-temp-v">1.0</span></label>
              <input type="range" id="p-temp" min="0" max="2" step="0.05" value="1" oninput="document.getElementById('p-temp-v').textContent=this.value">
            </div>
            <div class="field"><label>Top P <span class="val" id="p-topp-v">1.0</span></label>
              <input type="range" id="p-topp" min="0" max="1" step="0.01" value="1" oninput="document.getElementById('p-topp-v').textContent=this.value">
            </div>
            <div class="field"><label>Max tokens</label><input type="number" id="p-max" value="1024" min="1"></div>
            <div class="field"><label>Stop sequences (comma-sep)</label><input id="p-stop" placeholder="e.g. \\nUser:,END"></div>
            <div class="field"><label>Presence penalty <span class="val" id="p-pp-v">0</span></label>
              <input type="range" id="p-pp" min="-2" max="2" step="0.1" value="0" oninput="document.getElementById('p-pp-v').textContent=this.value">
            </div>
            <div class="field"><label>Frequency penalty <span class="val" id="p-fp-v">0</span></label>
              <input type="range" id="p-fp" min="-2" max="2" step="0.1" value="0" oninput="document.getElementById('p-fp-v').textContent=this.value">
            </div>
            <div class="field"><label>Seed (optional)</label><input type="number" id="p-seed" placeholder="deterministic"></div>
            <div class="field"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="p-stream" checked style="width:auto"> Stream</label></div>
            <div class="field"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="p-json" style="width:auto"> JSON mode</label></div>
          </div>
          <div class="card">
            <h2>Extra (raw JSON)</h2>
            <textarea id="p-extra" placeholder='{"thinking":{"type":"enabled","budget_tokens":2000}}'></textarea>
            <div style="color:var(--muted);font-size:11px;margin-top:6px">Merged into request body. Use for provider-specific fields.</div>
          </div>
        </div>
      </div>
    </div>

    <div id="view-logs" class="view" style="display:none">
      <div class="section-title"><h2>Request logs</h2><button class="btn sm" onclick="loadLogs()">Refresh</button></div>
      <div id="logs-list"></div>
    </div>
  </main>
</div>

<div class="modal-bg" id="modal-add">
  <div class="modal">
    <h3>Add API key</h3>
    <div class="field"><label>Label</label><input id="k-label" placeholder="e.g. main-01"></div>
    <div class="field"><label>ATXP connection URL</label><textarea id="k-value" placeholder="https://accounts.atxp.ai?connection_token=..."></textarea></div>
    <div class="field"><label>Credit (USD)</label><input id="k-credit" type="number" value="3" step="0.01" min="0"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn" onclick="closeModal('modal-add')">Cancel</button>
      <button class="btn primary" onclick="saveKey()">Save</button>
    </div>
  </div>
</div>

<script>
const LS = 'atxp_pw';
let PW = localStorage.getItem(LS) || '';
let MSGS = [{role:'system',content:'You are a helpful assistant.'},{role:'user',content:'Hello!'}];

const h = (p,o={}) => fetch(p, {...o, headers:{'Content-Type':'application/json','Authorization':'Bearer '+PW,...(o.headers||{})}});
const $ = id => document.getElementById(id);
const fmt$ = c => '$'+(c/100).toFixed(2);
const toast = m => { const t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),2200); };

async function doLogin(){
  PW = $('pw').value.trim(); if(!PW) return;
  const r = await h('/admin/stats');
  if (r.status === 200){ localStorage.setItem(LS,PW); $('login').style.display='none'; $('app').style.display='grid'; init(); }
  else { $('login-err').style.display='block'; }
}
function logout(){ localStorage.removeItem(LS); location.reload(); }

document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>go(t.dataset.view));
function go(v){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===v));
  document.querySelectorAll('.view').forEach(el=>el.style.display='none');
  const el = $('view-'+v); el.style.display='block';
  el.style.animation='none'; void el.offsetHeight; el.style.animation='';
  if(v==='dashboard') loadDash();
  if(v==='keys') loadKeys();
  if(v==='logs') loadLogs();
  if(v==='playground') renderMsgs();
}

async function init(){ loadDash(); }

async function loadDash(){
  const s = await (await h('/admin/stats')).json();
  $('s-credit').textContent = fmt$(s.credit_cents);
  $('s-credit-sub').textContent = s.keys_total+' keys total';
  $('s-remaining').textContent = fmt$(s.remaining_cents);
  $('s-remaining-sub').textContent = fmt$(s.used_cents)+' used';
  $('s-active').textContent = s.keys_active;
  $('s-active-sub').textContent = (s.keys_total-s.keys_active)+' inactive';
  $('s-reqs').textContent = s.logs;
  $('s-reqs-sub').textContent = (s.prompt_tokens+s.completion_tokens).toLocaleString()+' tokens';
  const logs = await (await h('/admin/logs?limit=8')).json();
  $('recent-logs').innerHTML = logs.length ? logs.map(logCard).join('') : '<div class="empty">No requests yet.</div>';
}

async function loadKeys(){
  const keys = await (await h('/admin/keys')).json();
  if(!keys.length){ $('keys-list').innerHTML='<div class="empty">No keys yet. Add one to get started.</div>'; return; }
  $('keys-list').innerHTML = keys.map(k=>{
    const used = k.used_cents||0, credit = k.credit_cents||300;
    const pct = Math.min(100, credit ? used*100/credit : 0);
    const cls = pct>90?'err':pct>70?'warn':'';
    return '<div class="key-row"><div>'+
      '<div class="key-label">'+escape(k.label||'key')+' <span class="pill '+(k.active?'on':'off')+'">'+(k.active?'active':'disabled')+'</span></div>'+
      '<div class="key-preview mono">'+escape(k.preview||'')+'</div>'+
      '<div class="key-meta">'+
        '<span>'+fmt$(used)+' / '+fmt$(credit)+'</span>'+
        '<span>'+(k.prompt_tokens||0).toLocaleString()+' in · '+(k.completion_tokens||0).toLocaleString()+' out</span>'+
        '<span>'+(k.last_used?'used '+rel(k.last_used):'unused')+'</span>'+
      '</div>'+
      '<div class="progress '+cls+'"><div style="width:'+pct+'%"></div></div>'+
    '</div>'+
    '<div class="key-actions">'+
      '<button class="btn sm" onclick="toggleKey('+k.id+','+(k.active?0:1)+')">'+(k.active?'Disable':'Enable')+'</button>'+
      '<button class="btn sm" onclick="resetKey('+k.id+')">Reset</button>'+
      '<button class="btn sm danger" onclick="delKey('+k.id+')">Delete</button>'+
    '</div></div>';
  }).join('');
}

async function toggleKey(id,a){ await h('/admin/keys/'+id+'/toggle',{method:'POST',body:JSON.stringify({active:!!a})}); loadKeys(); }
async function resetKey(id){ if(!confirm('Reset usage counter to 0 and re-enable?'))return; await h('/admin/keys/'+id+'/reset',{method:'POST',body:'{}'}); loadKeys(); }
async function delKey(id){ if(!confirm('Delete this key?'))return; await h('/admin/keys/'+id,{method:'DELETE'}); loadKeys(); }
function openAddKey(){ $('k-label').value=''; $('k-value').value=''; $('k-credit').value='3'; $('modal-add').classList.add('show'); }
function closeModal(id){ $(id).classList.remove('show'); }
async function saveKey(){
  const label = $('k-label').value.trim();
  const value = $('k-value').value.trim();
  const credit_cents = Math.round(Number($('k-credit').value||3)*100);
  if(!value){ toast('Key value required'); return; }
  const r = await h('/admin/keys',{method:'POST',body:JSON.stringify({label,api_key:value,credit_cents})});
  if(r.status===200){ closeModal('modal-add'); toast('Key added'); loadKeys(); } else toast('Error');
}

// Playground
function renderMsgs(){
  $('msgs').innerHTML = MSGS.map((m,i)=>
    '<div class="msg-item"><div class="head"><select onchange="MSGS['+i+'].role=this.value">'+
      ['system','user','assistant'].map(r=>'<option'+(m.role===r?' selected':'')+'>'+r+'</option>').join('')+
    '</select><button class="btn sm danger" onclick="MSGS.splice('+i+',1);renderMsgs()">Remove</button></div>'+
    '<textarea oninput="MSGS['+i+'].content=this.value">'+escape(m.content)+'</textarea></div>'
  ).join('');
}
function addMsg(r,c){ MSGS.push({role:r,content:c}); renderMsgs(); }
function clearOutput(){ $('pg-out').textContent=''; }

function buildBody(){
  const body = {
    model: $('p-model').value,
    messages: MSGS.filter(m=>m.content!==null),
    temperature: parseFloat($('p-temp').value),
    top_p: parseFloat($('p-topp').value),
    max_tokens: parseInt($('p-max').value||1024),
    presence_penalty: parseFloat($('p-pp').value),
    frequency_penalty: parseFloat($('p-fp').value),
    stream: $('p-stream').checked,
  };
  const stop = $('p-stop').value.trim();
  if(stop) body.stop = stop.split(',').map(s=>s.replace(/\\\\n/g,'\\n'));
  const seed = $('p-seed').value; if(seed) body.seed = parseInt(seed);
  if($('p-json').checked) body.response_format = {type:'json_object'};
  const ex = $('p-extra').value.trim();
  if(ex){ try{ Object.assign(body, JSON.parse(ex)); }catch(e){ toast('Invalid Extra JSON'); throw e; } }
  return body;
}

async function runPG(){
  let body; try{ body=buildBody(); }catch(e){ return; }
  $('run-btn').disabled = true; $('pg-out').textContent = '';
  try {
    const r = await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+PW},body:JSON.stringify(body)});
    if (!body.stream) {
      const j = await r.json();
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || JSON.stringify(j,null,2);
      $('pg-out').textContent = content;
      if(j.usage) $('pg-out').textContent += '\\n\\n---\\nUsage: '+JSON.stringify(j.usage);
    } else {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf='';
      while(true){
        const {value,done} = await reader.read(); if(done) break;
        buf += dec.decode(value,{stream:true});
        const lines = buf.split('\\n'); buf = lines.pop();
        for(const line of lines){
          const s = line.trim(); if(!s.startsWith('data:')) continue;
          const p = s.slice(5).trim(); if(p==='[DONE]') continue;
          try { const ev = JSON.parse(p); const d = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content; if(d){ $('pg-out').textContent += d; $('pg-out').scrollTop = $('pg-out').scrollHeight; } } catch(e){}
        }
      }
    }
  } catch(e){ $('pg-out').textContent = 'Error: '+e.message; }
  $('run-btn').disabled = false;
  if(['dashboard','logs'].includes(currentView())) loadDash();
}
function currentView(){ return document.querySelector('.tab.active').dataset.view; }

function exportCode(kind){
  const body = buildBody();
  const host = location.origin;
  let txt;
  if(kind==='curl'){
    txt = 'curl -X POST '+host+'/v1/chat/completions \\\\\\n  -H "Authorization: Bearer '+PW+'" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d '+"'"+JSON.stringify(body)+"'";
  } else {
    txt = 'from openai import OpenAI\\n\\nclient = OpenAI(\\n    api_key="'+PW+'",\\n    base_url="'+host+'/v1",\\n)\\n\\nresp = client.chat.completions.create(\\n    '+JSON.stringify(body,null,4).slice(1,-1).replace(/"([^"]+)":/g,'$1=').replace(/\\n/g,'\\n    ')+'\\n)\\n\\nprint(resp)';
  }
  navigator.clipboard.writeText(txt).then(()=>toast('Copied to clipboard'));
  $('pg-out').textContent = txt;
}

// Logs
async function loadLogs(){
  const logs = await (await h('/admin/logs?limit=200')).json();
  $('logs-list').innerHTML = logs.length ? logs.map(logCard).join('') : '<div class="empty">No logs yet.</div>';
}
function logCard(l){
  const ok = l.status>=200 && l.status<300;
  return '<div class="log-row" onclick="this.classList.toggle(\\\\'open\\\\')">'+
    '<div class="log-head">'+
      '<span class="log-status '+(ok?'ok':'err')+'">'+l.status+'</span>'+
      '<span class="mono">'+escape(l.model||'')+'</span>'+
      '<span style="color:var(--muted);font-size:12px">'+(l.prompt_tokens||0)+'→'+(l.completion_tokens||0)+' tok · '+fmt$(l.cost_cents||0)+' · '+(l.duration_ms||0)+'ms'+(l.stream?' · stream':'')+'</span>'+
      '<span class="log-time">'+rel(l.ts)+'</span>'+
    '</div>'+
    '<div class="log-detail">'+
      (l.error?'<div style="color:var(--err);font-size:12px;margin-bottom:6px">'+escape(l.error)+'</div>':'')+
      '<div style="font-size:12px;color:var(--muted)">Request</div><pre>'+escape(prettyJSON(l.request_json))+'</pre>'+
      (l.response_preview?'<div style="font-size:12px;color:var(--muted);margin-top:8px">Response preview</div><pre>'+escape(l.response_preview)+'</pre>':'')+
    '</div>'+
  '</div>';
}
function prettyJSON(s){ try{ return JSON.stringify(JSON.parse(s),null,2);}catch(e){return s||'';} }
function escape(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function rel(t){ if(!t)return'';const d=(Date.now()-t)/1000;if(d<60)return Math.floor(d)+'s ago';if(d<3600)return Math.floor(d/60)+'m ago';if(d<86400)return Math.floor(d/3600)+'h ago';return Math.floor(d/86400)+'d ago'; }

if(PW){ h('/admin/stats').then(r=>{ if(r.status===200){ $('login').style.display='none'; $('app').style.display='grid'; init(); } else { PW=''; localStorage.removeItem(LS); } }); }
$('pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
</script>
</body>
</html>
`;
