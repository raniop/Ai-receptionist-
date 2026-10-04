// ── Dalit leads board ────────────────────────────────────────────────────────
// A tiny, dependency-free tracker for every callback/lead Dalit takes, so the
// office can see what is still open vs handled. Each lead is also emailed (that
// does not change); this just adds a shared status board.
//
// Storage: a JSON file. Set LEADS_FILE to a path on a PERSISTENT disk (e.g.
// /data/leads.json) so status survives redeploys; otherwise it falls back to a
// local file next to this module (which resets when the service redeploys).
//
// Access: a 6-digit PIN (LEADS_PIN, or derived from MCP_AUTH_TOKEN). Login sets a
// signed cookie. The board holds customer PII, so it is never public.
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SECRET = process.env.MCP_AUTH_TOKEN || "dev-secret";
const LEADS_FILE = process.env.LEADS_FILE
  || (fs.existsSync("/data") ? "/data/leads.json" : fileURLToPath(new URL("./leads.json", import.meta.url)));
const PIN = process.env.LEADS_PIN
  || (parseInt(crypto.createHmac("sha256", SECRET).update("leads-pin").digest("hex").slice(0, 8), 16) % 1000000).toString().padStart(6, "0");
const COOKIE = crypto.createHmac("sha256", SECRET).update("leads-auth").digest("hex").slice(0, 32);
const CALL_TOKEN = crypto.createHmac("sha256", SECRET).update("call").digest("hex").slice(0, 24);
const CALL_BASE = process.env.CALL_RELAY_BASE || "http://127.0.0.1:8790";

const STATUSES = ["new", "in_progress", "done"];

// ── storage ──────────────────────────────────────────────────────────────────
let leads = (() => {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8")); } catch { return []; }
})();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads)); }
    catch (e) { console.error("[leads] save failed:", e.message); }
  }, 200);
}

/** Record a lead from a tool. `call` = { ext, clid, to } for click-to-call, optional. */
export function recordLead({ caller_name, caller_phone, topic, sent_to, call }) {
  const lead = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    caller_name: String(caller_name || "").trim(),
    caller_phone: String(caller_phone || "").trim(),
    topic: String(topic || "").trim(),
    sent_to: Array.isArray(sent_to) ? sent_to : (sent_to ? [sent_to] : []),
    call: call && call.to ? { ext: String(call.ext || ""), clid: String(call.clid || ""), to: String(call.to) } : null,
    status: "new",
    assigned: "",
    notes: [],
  };
  leads.unshift(lead);
  if (leads.length > 5000) leads.length = 5000;
  save();
  console.log("[leads] recorded", lead.caller_name, lead.caller_phone, "->", lead.sent_to.join(","));
  return lead;
}

// ── auth ───────────────────────────────────────────────────────────────────
function authed(req) {
  const c = String(req.headers.cookie || "");
  return c.split(/;\s*/).some((p) => p === `ophir_leads=${COOKIE}`);
}
function cookieHeader() {
  // 30-day session cookie. HttpOnly so page JS can't leak it; SameSite=Lax.
  return `ophir_leads=${COOKIE}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax`;
}

// ── request router. Returns true when it handled the request. ────────────────
export async function handleLeadsRequest(req, res, url) {
  const p = url.pathname;
  if (p !== "/leads" && p !== "/leads/login" && p !== "/leads/logout" && !p.startsWith("/api/leads")) return false;

  const html = (code, body) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  const json = (code, body, extra = {}) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...extra }); res.end(JSON.stringify(body)); };

  // Login
  if (p === "/leads/login" && req.method === "POST") {
    const body = await readBody(req);
    const pin = (body.pin || "").toString().trim();
    if (pin === PIN) json(200, { ok: true }, { "set-cookie": cookieHeader() });
    else json(401, { ok: false });
    return true;
  }
  if (p === "/leads/logout") {
    res.writeHead(302, { "set-cookie": "ophir_leads=; Path=/; Max-Age=0", location: "/leads" }); res.end();
    return true;
  }

  // The page itself
  if (p === "/leads" && req.method === "GET") {
    html(200, authed(req) ? DASHBOARD_HTML : LOGIN_HTML);
    return true;
  }

  // API (all require auth)
  if (p.startsWith("/api/leads")) {
    if (!authed(req)) { json(401, { error: "unauthorized" }); return true; }
    if (p === "/api/leads" && req.method === "GET") {
      const status = url.searchParams.get("status");
      const rows = status ? leads.filter((l) => l.status === status) : leads;
      json(200, { leads: rows, call_token: CALL_TOKEN, call_base: CALL_BASE });
      return true;
    }
    const m = p.match(/^\/api\/leads\/([0-9a-f-]+)$/);
    if (m && req.method === "POST") {
      const lead = leads.find((l) => l.id === m[1]);
      if (!lead) { json(404, { error: "not found" }); return true; }
      const body = await readBody(req);
      if (body.status && STATUSES.includes(body.status)) lead.status = body.status;
      if (typeof body.assigned === "string") lead.assigned = body.assigned.trim();
      if (body.note && String(body.note).trim())
        lead.notes.push({ at: new Date().toISOString(), by: (body.by || "").toString().trim(), text: String(body.note).trim() });
      save();
      json(200, { ok: true, lead });
      return true;
    }
    json(405, { error: "method" });
    return true;
  }
  html(404, "not found");
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

// ── pages (self-contained, RTL Hebrew) ───────────────────────────────────────
const LOGIN_HTML = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>לוח פניות — אופיר ביטוח</title>
<style>body{margin:0;font-family:Arial,'Segoe UI',sans-serif;background:#f3f4f6;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;box-shadow:0 1px 4px rgba(0,0,0,.1);padding:32px;width:320px;text-align:center}
h1{font-size:20px;margin:0 0 4px;color:#1e3a8a}p{color:#6b7280;font-size:14px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;font-size:22px;letter-spacing:6px;text-align:center;padding:12px;border:1px solid #d1d5db;border-radius:10px;margin-bottom:12px}
button{width:100%;background:#1e3a8a;color:#fff;border:0;border-radius:10px;padding:12px;font-size:16px;font-weight:700;cursor:pointer}
.err{color:#b91c1c;font-size:13px;height:18px}</style></head>
<body><form class="card" onsubmit="login(event)"><h1>אופיר ביטוח</h1><p>לוח מעקב פניות — הזן קוד כניסה</p>
<input id="pin" inputmode="numeric" maxlength="6" placeholder="••••••" autofocus><div class="err" id="err"></div>
<button>כניסה</button></form>
<script>async function login(e){e.preventDefault();const pin=document.getElementById('pin').value;
const r=await fetch('/leads/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin})});
if(r.ok){location.href='/leads'}else{document.getElementById('err').textContent='קוד שגוי';}}</script></body></html>`;

const DASHBOARD_HTML = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>לוח פניות — אופיר ביטוח</title>
<style>
:root{--blue:#1e3a8a}
*{box-sizing:border-box}body{margin:0;font-family:Arial,'Segoe UI',sans-serif;background:#f3f4f6;color:#111827}
header{background:var(--blue);color:#fff;padding:14px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:18px;margin:0;font-weight:700}header .sp{flex:1}
header a{color:#bfdbfe;font-size:13px;text-decoration:none}
.bar{padding:12px 20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#fff;border-bottom:1px solid #eef1f5}
.bar input{flex:1;min-width:160px;padding:9px 12px;border:1px solid #d1d5db;border-radius:9px;font-size:14px}
.chip{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:7px 14px;font-size:13px;cursor:pointer;font-weight:600}
.chip.on{background:var(--blue);color:#fff;border-color:var(--blue)}
.wrap{padding:16px 20px;display:flex;flex-direction:column;gap:10px}
.lead{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px 16px;border-right:5px solid #9ca3af}
.lead.new{border-right-color:#dc2626}.lead.in_progress{border-right-color:#d97706}.lead.done{border-right-color:#16a34a;opacity:.72}
.lead .top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.name{font-weight:700;font-size:16px}.time{color:#9ca3af;font-size:12px}
.tel{direction:ltr;unicode-bidi:embed;color:#1d4ed8;text-decoration:none;font-weight:700}
.badge{font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px}
.badge.new{background:#fee2e2;color:#b91c1c}.badge.in_progress{background:#fef3c7;color:#92400e}.badge.done{background:#dcfce7;color:#166534}
.topic{margin:8px 0 4px;color:#374151;font-size:14px;line-height:1.5}
.meta{color:#6b7280;font-size:12px}
.actions{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{border:1px solid #d1d5db;background:#fff;border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer;font-weight:600}
.btn.p{background:#16a34a;color:#fff;border-color:#16a34a}.btn.call{background:#16a34a;color:#fff;border-color:#16a34a}
.btn.w{background:#d97706;color:#fff;border-color:#d97706}
.notes{margin-top:8px;font-size:12px;color:#4b5563;background:#f9fafb;border-radius:8px;padding:6px 10px}
.empty{text-align:center;color:#9ca3af;padding:40px}
@media(max-width:560px){.wrap{padding:12px}}
</style></head><body>
<header><h1>📋 לוח פניות — אופיר ביטוח</h1><div class="sp"></div><span id="count"></span><a href="/leads/logout">יציאה</a></header>
<div class="bar">
  <span class="chip on" data-f="open">פתוחות</span>
  <span class="chip" data-f="new">חדשות</span>
  <span class="chip" data-f="in_progress">בטיפול</span>
  <span class="chip" data-f="done">טופלו</span>
  <span class="chip" data-f="all">הכול</span>
  <input id="q" placeholder="חיפוש שם / טלפון / נושא...">
</div>
<div class="wrap" id="list"></div>
<script>
let LEADS=[],TOKEN="",BASE="",filter="open",q="";
const HE={new:"חדש",in_progress:"בטיפול",done:"טופל"};
async function load(){const r=await fetch('/api/leads');if(r.status===401){location.href='/leads';return;}const d=await r.json();LEADS=d.leads;TOKEN=d.call_token;BASE=d.call_base;render();}
function fmt(iso){const d=new Date(iso);return d.toLocaleString('he-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function callUrl(l){if(!l.call)return null;const p=new URLSearchParams({ext:l.call.ext||'205',clid:l.call.clid||'',to:l.call.to,token:TOKEN});return BASE+'/call?'+p.toString();}
function match(l){const s=(l.caller_name+' '+l.caller_phone+' '+l.topic+' '+l.sent_to.join(' ')).toLowerCase();return s.includes(q.toLowerCase());}
function visible(){return LEADS.filter(l=>{if(filter==='open')return l.status!=='done';if(filter==='all')return true;return l.status===filter;}).filter(match);}
function render(){const rows=visible();document.getElementById('count').textContent=rows.length+' פניות';
const L=document.getElementById('list');if(!rows.length){L.innerHTML='<div class="empty">אין פניות להצגה</div>';return;}
L.innerHTML=rows.map(l=>{const cu=callUrl(l);
return '<div class="lead '+l.status+'"><div class="top"><span class="name">'+esc(l.caller_name||'—')+'</span>'+
'<a class="tel" href="'+(cu||('tel:'+l.caller_phone))+'">'+esc(l.caller_phone||'')+'</a>'+
'<span class="badge '+l.status+'">'+HE[l.status]+'</span><span class="time">'+fmt(l.at)+'</span></div>'+
'<div class="topic">'+esc(l.topic||'—')+'</div>'+
'<div class="meta">נשלח אל: '+esc(l.sent_to.join(', ')||'—')+(l.assigned?(' · מטפל/ת: '+esc(l.assigned)):'')+'</div>'+
(l.notes.length?('<div class="notes">'+l.notes.map(n=>'• '+esc(n.text)+(n.by?(' ('+esc(n.by)+')'):'')).join('<br>')+'</div>'):'')+
'<div class="actions">'+
(cu?('<a class="btn call" href="'+cu+'" target="_blank">📞 חייג</a>'):'')+
(l.status!=='in_progress'?('<button class="btn w" onclick="upd(\\''+l.id+'\\',{status:\\'in_progress\\'})">בטיפול</button>'):'')+
(l.status!=='done'?('<button class="btn p" onclick="upd(\\''+l.id+'\\',{status:\\'done\\'})">✓ טופל</button>'):('<button class="btn" onclick="upd(\\''+l.id+'\\',{status:\\'new\\'})">↩ פתח מחדש</button>'))+
'<button class="btn" onclick="note(\\''+l.id+'\\')">+ הערה</button>'+
'</div></div>';}).join('');}
async function upd(id,patch){await fetch('/api/leads/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});load();}
function note(id){const t=prompt('הערה:');if(t)upd(id,{note:t});}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');filter=c.dataset.f;render();});
document.getElementById('q').oninput=e=>{q=e.target.value;render();};
load();setInterval(load,20000);
</script></body></html>`;
