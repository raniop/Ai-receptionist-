// ── Ophir CRM proxy ──────────────────────────────────────────────────────────
// A tiny, dependency-free Node server that sits BETWEEN Dalit (the browser SPA)
// and the BituhOfir CRM API. It exists for one reason: security. The CRM
// credentials and service token live here on the server, NEVER in the browser,
// and a customer can only ever read THEIR OWN policy — and only after proving
// ownership with an SMS OTP.
//
// Flow the browser drives:
//   1. POST /api/crm/otp/send    { personId, phone }  → CRM sends an SMS code
//   2. POST /api/crm/otp/verify  { personId, code }   → on success we mint a
//      short-lived HMAC token scoped to that personId (10 min)
//   3. GET  /api/crm/policy      Authorization: Bearer <that token>
//      → we look the policy up by the personId INSIDE the token (the client
//        cannot ask for anyone else's) and return a sanitized view.
//
// Config comes from environment variables (see .env.example). Never commit .env.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// `ws` is CommonJS; its named exports aren't reachable via a default ESM import,
// so load it with require to get the WebSocketServer + WebSocket client classes.
const { WebSocketServer, WebSocket: WsClient } = require("ws");
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import nodemailer from "nodemailer";

const {
  CRM_BASE_URL,
  CRM_USERNAME,
  CRM_PASSWORD,
  CRM_PROXY_PORT = "5055",
  // Cloud hosts (Render/Railway/Fly…) inject the port to bind on as PORT.
  PORT,
  CRM_SESSION_SECRET,
  CRM_ALLOW_ORIGIN = "http://localhost:5173",
  GEMINI_API_KEY,
  GEMINI_LIVE_MODEL = "gemini-3.8-live",
} = process.env;

// Gemini Live: the browser gets a short-lived EPHEMERAL token from us and connects
// to Google directly — the real API key never leaves the server.
const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// "Brain" options: a fast TEXT LLM answers instead of Gemini Live, so Dalit can
// reply much quicker (Gemini Live spends seconds generating audio we discard).
const { XAI_API_KEY } = process.env;
// The published xAI Voice Agent to relay the browser to (its realtime WebSocket).
const XAI_AGENT_ID = process.env.XAI_AGENT_ID || "agent_05PtvAaUJRwLjJid";
const BRAIN_FLASH_MODEL = process.env.BRAIN_FLASH_MODEL || "gemini-flash-lite-latest";
const BRAIN_GROK_MODEL = process.env.BRAIN_GROK_MODEL || "grok-4.20-0309-non-reasoning";

// Gemini tool declarations use UPPERCASE types; OpenAI/xAI want lowercase JSON Schema.
function lowerSchema(s) {
  if (!s || typeof s !== "object") return s;
  const out = Array.isArray(s) ? [] : {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string") out[k] = v.toLowerCase();
    else if (v && typeof v === "object") out[k] = lowerSchema(v);
    else out[k] = v;
  }
  return out;
}

/** One brain turn. `messages` is our neutral history; returns {calls} or {text}. */
async function runBrain({ provider, system, messages, tools }) {
  if (provider === "grok") {
    if (!XAI_API_KEY) throw new Error("xai_not_configured");
    const oaMsgs = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") oaMsgs.push({ role: "user", content: m.text || "" });
      else if (m.role === "tool")
        oaMsgs.push({ role: "tool", tool_call_id: m.id, content: JSON.stringify(m.result ?? {}) });
      else if (m.role === "assistant") {
        if (m.calls?.length)
          oaMsgs.push({
            role: "assistant",
            content: m.text || null,
            tool_calls: m.calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          });
        else oaMsgs.push({ role: "assistant", content: m.text || "" });
      }
    }
    const oaTools = (tools || []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: lowerSchema(t.parameters) },
    }));
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${XAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: BRAIN_GROK_MODEL, messages: oaMsgs, tools: oaTools.length ? oaTools : undefined }),
    });
    if (!r.ok) throw new Error(`grok ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const msg = j.choices?.[0]?.message ?? {};
    if (msg.tool_calls?.length) {
      return {
        calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          args: safeJson(tc.function?.arguments),
        })),
      };
    }
    return { text: msg.content || "" };
  }

  // default: Gemini flash-lite
  if (!genai) throw new Error("gemini_not_configured");
  const contents = [];
  for (const m of messages) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.text || "" }] });
    else if (m.role === "tool")
      contents.push({ role: "user", parts: [{ functionResponse: { name: m.name, response: m.result ?? {} } }] });
    else if (m.role === "assistant") {
      if (m.calls?.length)
        contents.push({
          role: "model",
          // Gemini requires its thought_signature echoed back with the functionCall.
          parts: m.calls.map((c) => ({
            functionCall: { name: c.name, args: c.args ?? {} },
            ...(c.sig ? { thoughtSignature: c.sig } : {}),
          })),
        });
      else contents.push({ role: "model", parts: [{ text: m.text || "" }] });
    }
  }
  const res = await genai.models.generateContent({
    model: BRAIN_FLASH_MODEL,
    config: { systemInstruction: system, ...(tools?.length ? { tools: [{ functionDeclarations: tools }] } : {}) },
    contents,
  });
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const calls = parts.filter((p) => p.functionCall).map((p) => ({
    id: p.functionCall.id || ref("call"),
    name: p.functionCall.name,
    args: p.functionCall.args ?? {},
    sig: p.thoughtSignature, // echoed back on the next turn (Gemini requirement)
  }));
  if (calls.length) return { calls };
  return { text: res.text || parts.map((p) => p.text || "").join("") };
}
function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
function ref(p) {
  return `${p}_${Math.random().toString(36).slice(2, 10)}`;
}

// SMTP (Office 365) — Dalit emails a team member when she takes a message for them.
const { SMTP_HOST, SMTP_PORT = "587", SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const mailer =
  SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: Number(SMTP_PORT) === 465,
        requireTLS: true,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;

// Microsoft Graph (OAuth2 client-credentials) — the modern way to send mail from an
// Office 365 mailbox, unaffected by the tenant's basic-auth/SMTP blocks. Preferred
// over SMTP when an Azure app registration is configured.
const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, GRAPH_SENDER } = process.env;
const graphConfigured = Boolean(AZURE_TENANT_ID && AZURE_CLIENT_ID && AZURE_CLIENT_SECRET);

// ElevenLabs — natural Hebrew TTS. The browser sends text, we speak it with the
// key held here, and stream the audio back. Key never reaches the browser.
const { ELEVENLABS_API_KEY, ELEVEN_MODEL = "eleven_flash_v2_5" } = process.env;
const elevenConfigured = Boolean(ELEVENLABS_API_KEY);

// Azure Neural TTS — native Hebrew voices (he-IL-HilaNeural / AvriNeural).
const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = process.env;
const azureConfigured = Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION);
const xmlEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Fix Hebrew abbreviations that TTS mispronounces. "חו״ל" (abroad) is otherwise
// read like "חוֹל" (sand); shuruk niqqud makes it "חוּל". Handles gershayim and
// plain quotes, with or without a prefix letter (ל/ב/מ/ה/ו/ש/כ).
function normalizeHebrewTts(text) {
  return String(text).replace(/([לבמהושכ]?)חו["'״″]ל/g, "$1חוּל");
}
let graphTok = null; // { token, expMs }
async function graphToken() {
  if (graphTok && graphTok.expMs - 60_000 > Date.now()) return graphTok.token;
  const body = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`graph token ${r.status}: ${j.error_description || JSON.stringify(j).slice(0, 200)}`);
  graphTok = { token: j.access_token, expMs: Date.now() + (j.expires_in || 3600) * 1000 };
  return graphTok.token;
}
async function sendMailGraph(to, subject, html) {
  const token = await graphToken();
  const sender = GRAPH_SENDER || SMTP_FROM || SMTP_USER;
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) throw new Error(`graph sendMail ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// Escape user-supplied values before dropping them into the HTML email.
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A clean, right-to-left HTML notification email in the Ophir Insurance style.
function agentEmailHtml({ agentName, callerName, callerPhone, reason }) {
  const firstName = String(agentName || "").trim().split(/\s+/)[0] || "";
  const greeting = firstName ? `שלום ${esc(firstName)},` : "שלום,";
  const phone = String(callerPhone || "").trim();
  const telHref = phone.replace(/[^\d+]/g, "");
  const now = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "long", timeStyle: "short" });
  const row = (label, value) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eef1f5;color:#6b7280;font-size:14px;white-space:nowrap;vertical-align:top;width:88px;">${label}</td>
          <td style="padding:10px 0;border-bottom:1px solid #eef1f5;color:#111827;font-size:15px;font-weight:600;">${value}</td>
        </tr>`;
  const phoneCell = phone
    ? `<a href="tel:${esc(telHref)}" style="color:#1d4ed8;text-decoration:none;direction:ltr;unicode-bidi:embed;display:inline-block;">${esc(phone)}</a>`
    : "—";
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:Arial,'Segoe UI',Helvetica,sans-serif;text-align:right;">
        <tr>
          <td bgcolor="#1e3a8a" style="background-color:#1e3a8a;background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:22px 28px;">
            <div style="color:#ffffff;font-size:19px;font-weight:700;">אופיר ביטוח</div>
            <div style="color:#bfdbfe;font-size:13px;margin-top:2px;">פנייה חדשה מדלית · הנציגה הקולית</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 28px 8px;">
            <p style="margin:0 0 6px;color:#111827;font-size:16px;font-weight:600;">${greeting}</p>
            <p style="margin:0 0 20px;color:#4b5563;font-size:14px;line-height:1.6;">התקבלה עבורך בקשת חזרה בשיחה קולית עם דלית. להלן הפרטים:</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${row("שם המתקשר", esc(callerName) || "—")}
              ${row("טלפון", phoneCell)}
              ${row("נושא", esc(reason) || "—")}
              ${row("התקבל", esc(now))}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 26px;">
            <div style="background:#eff6ff;border-radius:12px;padding:14px 16px;color:#1e40af;font-size:13px;line-height:1.6;">
              💡 נא לחזור ללקוח בהקדם. הפנייה נרשמה אוטומטית במערכת.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px;background:#f9fafb;border-top:1px solid #eef1f5;color:#9ca3af;font-size:12px;line-height:1.6;">
            הודעה זו נשלחה אוטומטית ממערכת המענה הקולי של אופיר ביטוח.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Team email directory (server-side allowlist, so the browser can't email arbitrary
// addresses). Names match src/content/site.ts.
const STAFF_EMAILS = {
  "אלי אופיר": "eli@ophirins.co.il",
  "הדר גלעד": "hadar@ophirins.co.il",
  "רני אופיר": "rani@ophirins.co.il",
  "גלעד כרמונה": "gilad@ophirins.co.il",
  שיראל: "ophir@ophirins.co.il",
};
function agentEmail(name) {
  const q = String(name || "").trim();
  if (!q) return null;
  const keys = Object.keys(STAFF_EMAILS);
  const hit = keys.find((k) => k.includes(q)) ?? keys.find((k) => q.includes(k.split(" ")[0]));
  return hit ? STAFF_EMAILS[hit] : null;
}

// Everything sensitive (the CRM host, the service account) lives in .env, which is
// gitignored — nothing here hardcodes it, so the public repo never leaks it.
if (!CRM_BASE_URL || !CRM_USERNAME || !CRM_PASSWORD) {
  console.error("[crm-proxy] Missing CRM_BASE_URL / CRM_USERNAME / CRM_PASSWORD. Copy .env.example to .env and fill them.");
  process.exit(1);
}
const SESSION_SECRET = CRM_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!CRM_SESSION_SECRET) {
  console.warn("[crm-proxy] CRM_SESSION_SECRET not set — using a random per-boot secret (sessions won't survive restart).");
}
const SESSION_TTL_MS = 10 * 60_000; // a verified customer session lasts 10 minutes

// ── CRM service auth (cached, refreshed on demand) ───────────────────────────
let crmToken = null; // { token, expMs }

async function crmLogin() {
  const res = await fetch(`${CRM_BASE_URL}/api/Auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: CRM_USERNAME, password: CRM_PASSWORD }),
  });
  if (!res.ok) throw new Error(`CRM login failed: ${res.status}`);
  const j = await res.json();
  if (!j?.accessToken) throw new Error("CRM login: no accessToken in response");
  const expMs = j.expiresAt ? Date.parse(j.expiresAt) : Date.now() + 30 * 60_000;
  crmToken = { token: j.accessToken, expMs };
  return crmToken.token;
}

async function crmAuthHeader() {
  if (!crmToken || crmToken.expMs - 60_000 < Date.now()) await crmLogin();
  return `Bearer ${crmToken.token}`;
}

/** Call the CRM, retrying once through a fresh login on 401. */
async function crmFetch(path, init = {}, retry = true) {
  const auth = await crmAuthHeader();
  const res = await fetch(`${CRM_BASE_URL}${path}`, {
    ...init,
    headers: { authorization: auth, accept: "application/json", ...(init.headers || {}) },
  });
  if (res.status === 401 && retry) {
    crmToken = null;
    return crmFetch(path, init, false);
  }
  return res;
}

// ── our short-lived customer session token (HMAC, scoped to one personId) ─────
function signSession(personId) {
  const payload = Buffer.from(JSON.stringify({ personId, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  // timingSafeEqual throws on unequal lengths — a forged token must just fail.
  if (!sig || sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.personId || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ── lookup sanitization ──────────────────────────────────────────────────────
// GetByPersonId returns the PERSON (identity) with their policies nested under
// `riders`. We read back the person's name to confirm identity, plus a slim view
// of each policy — never the raw record.
const pick = (o, keys) => {
  for (const k of keys) {
    const hit = Object.keys(o).find((kk) => kk.toLowerCase() === k.toLowerCase());
    if (hit != null && o[hit] != null && o[hit] !== "") return o[hit];
  }
  return null;
};

/** Last 4 digits, for a spoken hint like "…4244" — never the full number. */
function maskPhone(p) {
  const d = String(p).replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}

/** Normalize a stored phone to a plain local IL mobile (05XXXXXXXX). */
function normalizePhone(p) {
  let d = String(p).replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (d.length === 9 && d.startsWith("5")) d = "0" + d; // "52…" → "052…"
  return d;
}

// ── agent availability (manual for now; swap for real PBX presence later) ─────
// Shared across all clients: the admin sets it, Dalit reads it. Persisted to a file
// so it survives restarts. Values: "available" | "busy" | "away".
const STATUS_FILE = new URL("./agent-status.json", import.meta.url);
function loadStatuses() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveStatuses(s) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2));
  } catch {
    /* ignore */
  }
}
const VALID_STATUS = new Set(["available", "busy", "away"]);
/** Best-match an agent name to a stored key (fuzzy: first name / contains). */
function statusFor(name) {
  const s = loadStatuses();
  const q = String(name || "").trim();
  if (!q) return "available";
  const keys = Object.keys(s);
  const hit =
    keys.find((k) => k === q) ??
    keys.find((k) => k.includes(q) || q.includes(k.split(" ")[0])) ??
    null;
  return hit ? s[hit] : "available"; // default available when unset/unknown
}

function isActive(endDate) {
  const t = Date.parse(endDate);
  return Number.isNaN(t) ? null : t >= Date.now();
}

/** Build a person's display name from whatever fields the CRM returns. */
function personName(c) {
  const full = pick(c, ["clientName", "fullName", "name", "customerName", "displayName"]);
  if (full) return String(full).trim();
  const first = pick(c, ["firstName", "privateName", "hebFirstName", "givenName", "first_name"]);
  const last = pick(c, ["lastName", "familyName", "hebLastName", "surname", "last_name"]);
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return combined || null;
}

function sanitizeLookup(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const customerName = list[0] ? pick(list[0], ["clientName"]) : null;
  const policies = list.map((p) => {
    const endDate = pick(p, ["endDate"]);
    return {
      policyNumber: pick(p, ["fullPolicyID", "policyDoc"]),
      policyIndex: pick(p, ["policyIndex"]),
      insuranceType: pick(p, ["areaName"]),
      startDate: pick(p, ["startDate"]),
      endDate,
      premium: pick(p, ["total"]),
      agentName: pick(p, ["agentName"]),
      active: isActive(endDate),
    };
  });
  return { customerName, count: policies.length, policies };
}

// ── http plumbing ────────────────────────────────────────────────────────────
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": CRM_ALLOW_ORIGIN,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(data);
}

// ── static SPA hosting ───────────────────────────────────────────────────────
// In production ONE service serves both the API and the built site (dist/), so
// the browser talks to a single HTTPS origin and /api/* is same-origin. In dev
// this folder doesn't exist and Vite serves the SPA instead — we just 404.
const DIST_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../dist");
const hasDist = fs.existsSync(path.join(DIST_DIR, "index.html"));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
function serveStatic(res, pathname) {
  // Map the URL to a file inside dist/, blocking path traversal.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  let filePath = path.resolve(DIST_DIR, rel);
  const isAsset = filePath.startsWith(DIST_DIR) && rel !== "" && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  // Anything that isn't a real file is an SPA route → serve index.html.
  if (!isAsset) filePath = path.join(DIST_DIR, "index.html");
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    // Fingerprinted assets can cache hard; index.html must always revalidate.
    "cache-control": isAsset && /\/assets\//.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ── MCP server ───────────────────────────────────────────────────────────────
// Exposes the CRM as MCP tools so an xAI Voice Agent (Custom MCP server) can check
// policies, take messages, etc. Each tool just calls our own HTTP endpoints, so
// all the tested logic (OTP session, sanitization, email) is reused as-is.
const { MCP_AUTH_TOKEN } = process.env;
const mcpConfigured = Boolean(MCP_AUTH_TOKEN);

async function mcpInternal(pathname, { method = "GET", body, session } = {}) {
  const headers = { "content-type": "application/json" };
  if (session) headers.authorization = `Bearer ${session}`;
  const r = await fetch(`http://127.0.0.1:${LISTEN_PORT}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

const MCP_TOOLS = [
  { name: "send_policy_otp", description: "שולח קוד אימות ב-SMS ללקוח לפי תעודת הזהות, לפני חשיפת פרטי פוליסה.",
    inputSchema: { type: "object", properties: { person_id: { type: "string", description: "מספר תעודת הזהות" } }, required: ["person_id"] } },
  { name: "verify_policy_otp", description: "מאמת את קוד ה-SMS. בהצלחה מחזיר מיד את כל פרטי הלקוח: שם, הפוליסות, ולפוליסות הפעילות/האחרונות גם כיסויים (coverages) ושמות המבוטחים (members). אין צורך לקרוא לכלים נוספים אחרי זה — עני מתוך התוצאה.",
    inputSchema: { type: "object", properties: { person_id: { type: "string" }, code: { type: "string", description: "הקוד בן 4-6 ספרות" } }, required: ["person_id", "code"] } },
  { name: "get_my_policy", description: "מחזיר שוב את פוליסות הלקוח המאומת עם כיסויים ומבוטחים. בדרך כלל לא נחוץ — verify_policy_otp כבר מחזיר הכל. דורש session.",
    inputSchema: { type: "object", properties: { session: { type: "string" } }, required: ["session"] } },
  { name: "get_policy_coverage", description: "כיסויים/ריידרים של פוליסה ישנה שלא הגיעה עם פרטים מלאים. דורש session ו-policy_index.",
    inputSchema: { type: "object", properties: { session: { type: "string" }, policy_index: { type: "string" } }, required: ["session", "policy_index"] } },
  { name: "get_policy_members", description: "שמות המבוטחים על פוליסה ישנה שלא הגיעה עם פרטים מלאים. דורש session ו-policy_index.",
    inputSchema: { type: "object", properties: { session: { type: "string" }, policy_index: { type: "string" } }, required: ["session", "policy_index"] } },
  { name: "save_lead", description: "רושם פנייה של לקוח (שולח מייל למשרד) — להצעת מחיר או לביטוח רכב/דירה/עסקים.",
    inputSchema: { type: "object", properties: { full_name: { type: "string" }, phone: { type: "string" }, topic: { type: "string" } }, required: ["full_name", "phone"] } },
  { name: "check_agent_status", description: "בודק זמינות עובד: available (זמין) / busy (בשיחה) / away (לא נמצא).",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] } },
  { name: "contact_agent", description: "שולח מייל לעובד עם פרטי המתקשר (בקשת חזרה) כשהעובד לא זמין.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, caller_name: { type: "string" }, caller_phone: { type: "string" }, reason: { type: "string" } }, required: ["agent_name", "caller_name", "caller_phone"] } },
];

// Every tool call makes the voice model stop, wait and think again (~1s each on
// xAI's side), so the policy flow returns everything in ONE result: the most
// relevant policies (active first, then latest) with their coverages and insured
// names, plus a short list of older ones. The heavy GetById runs once (members
// come from its rows) and the result stays small — the model reads all of it.
// The CRM's per-policy riders call is slow (~0.5s each, and it serializes), so the
// bundle is PREFETCHED the moment the OTP SMS goes out — built while the caller
// reads the code aloud. It stays server-side and is only handed out after the OTP
// verifies (policyBundle checks the session first).
const BUNDLE_DETAILED = 3;
const BUNDLE_OLDER = 10;
const BUNDLE_TTL_MS = 2 * 60_000;
const bundleCache = new Map(); // personId → { at, promise }
const day = (s) => (s ? String(s).slice(0, 10) : s);

function prefetchBundle(personId) {
  const id = String(personId);
  for (const [k, v] of bundleCache) if (Date.now() - v.at >= BUNDLE_TTL_MS) bundleCache.delete(k);
  const hit = bundleCache.get(id);
  if (hit && Date.now() - hit.at < BUNDLE_TTL_MS) return hit.promise;
  const promise = buildBundle(id).catch(() => null);
  bundleCache.set(id, { at: Date.now(), promise });
  promise.then((b) => { if (!b) bundleCache.delete(id); });
  return promise;
}

async function policyBundle(token) {
  const session = verifySession(token);
  if (!session) return null;
  return prefetchBundle(session.personId);
}

async function buildBundle(me) {
  const r = await crmFetch(`/api/Policy/GetById?id=${encodeURIComponent(me)}`);
  if (!r.ok) return null;
  const raw = await r.json().catch(() => null);
  const rawList = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const { customerName, policies } = sanitizeLookup(rawList);
  const endT = (x) => Date.parse(x.endDate) || 0;
  const ranked = [...policies].sort((x, y) => (y.active === true) - (x.active === true) || endT(y) - endT(x));
  const detailed = await Promise.all(
    ranked.slice(0, BUNDLE_DETAILED).map(async (pol) => {
      const row = rawList.find((p) => String(pick(p, ["policyIndex"])) === String(pol.policyIndex));
      const customers = Array.isArray(row?.customers) ? row.customers : [];
      // Security: only list the insured when the caller is on this policy.
      const members = customers.some((c) => String(c.personId) === me)
        ? customers
            .map((c) => ({ name: personName(c), is_me: String(c.personId) === me }))
            .filter((m) => m.name)
        : [];
      let coverages = [];
      const cr = await crmFetch(`/api/Policy/GetPolicyCustomersDetailsByIndex?policyIndex=${encodeURIComponent(pol.policyIndex)}`);
      if (cr.ok) {
        const cj = await cr.json().catch(() => null);
        const mine = (Array.isArray(cj?.customers) ? cj.customers : []).find((c) => String(c.personId) === me);
        coverages = (Array.isArray(mine?.riders) ? mine.riders : []).map((rd) => pick(rd, ["riderName"])).filter(Boolean);
      }
      return { ...pol, startDate: day(pol.startDate), endDate: day(pol.endDate), coverages, members };
    }),
  );
  const older = ranked.slice(BUNDLE_DETAILED);
  return {
    customer_name: customerName,
    total_policies: policies.length,
    policies: detailed,
    older_policies: older.slice(0, BUNDLE_OLDER).map((p) => ({
      policyIndex: p.policyIndex,
      insuranceType: p.insuranceType,
      startDate: day(p.startDate),
      endDate: day(p.endDate),
    })),
    ...(older.length > BUNDLE_OLDER ? { note: `ועוד ${older.length - BUNDLE_OLDER} פוליסות ישנות יותר שלא פורטו` } : {}),
  };
}

async function runMcpTool(name, a = {}) {
  switch (name) {
    case "send_policy_otp": {
      const r = await mcpInternal("/api/crm/otp/send", { method: "POST", body: { personId: a.person_id } });
      if (r.status === 200) prefetchBundle(a.person_id); // warm it while the caller reads the SMS
      return r.status === 200
        ? { ok: true, phone_hint: r.phoneHint ?? null }
        : { ok: false, error: 'לא הצלחתי לשלוח קוד. ייתכן שאין טלפון רשום על תעודת הזהות הזו.' };
    }
    case "verify_policy_otp": {
      const r = await mcpInternal("/api/crm/otp/verify", { method: "POST", body: { personId: a.person_id, code: a.code } });
      if (!r.token) return { ok: false, error: "הקוד שגוי או פג תוקף." };
      const bundle = await policyBundle(r.token);
      return bundle
        ? { ok: true, session: r.token, ...bundle }
        : { ok: true, session: r.token, error: "האימות הצליח אך שליפת הפוליסה נכשלה." };
    }
    case "get_my_policy": {
      const bundle = await policyBundle(a.session);
      return bundle ?? { ok: false, error: "נדרש אימות תקף." };
    }
    case "get_policy_coverage": {
      const r = await mcpInternal(`/api/crm/policy/coverage?policyIndex=${encodeURIComponent(a.policy_index)}`, { session: a.session });
      return { coverages: r.coverages ?? [] };
    }
    case "get_policy_members": {
      const r = await mcpInternal(`/api/crm/policy/members?policyIndex=${encodeURIComponent(a.policy_index)}`, { session: a.session });
      return { members: r.members ?? [] };
    }
    case "check_agent_status": {
      const r = await mcpInternal(`/api/agents/status?agent=${encodeURIComponent(a.agent_name)}`);
      return { status: r.status ?? "available" };
    }
    case "contact_agent": {
      const r = await mcpInternal("/api/notify/agent", { method: "POST", body: { agent_name: a.agent_name, caller_name: a.caller_name, caller_phone: a.caller_phone, reason: a.reason } });
      return { ok: true, emailed: Boolean(r.emailed) };
    }
    case "save_lead": {
      const r = await mcpInternal("/api/notify/lead", { method: "POST", body: { full_name: a.full_name, phone: a.phone, topic: a.topic } });
      return { ok: true, emailed: Boolean(r.emailed) };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

function makeMcpServer() {
  const s = new McpServer({ name: "ophir-crm", version: "1.0.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await runMcpTool(req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  return s;
}
const mcpTransports = new Map(); // sessionId → SSEServerTransport

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CRM_PROXY_PORT}`);

  // ── MCP over SSE (for the xAI Voice Agent's Custom MCP server) ──
  if (url.pathname === "/mcp/sse" && req.method === "GET") {
    if (mcpConfigured && req.headers["x-mcp-token"] !== MCP_AUTH_TOKEN) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const transport = new SSEServerTransport("/mcp/messages", res);
    mcpTransports.set(transport.sessionId, transport);
    res.on("close", () => mcpTransports.delete(transport.sessionId));
    await makeMcpServer().connect(transport);
    return;
  }
  if (url.pathname === "/mcp/messages" && req.method === "POST") {
    const transport = mcpTransports.get(url.searchParams.get("sessionId"));
    if (!transport) {
      res.writeHead(404).end("no such mcp session");
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }
  if (req.method === "OPTIONS") return send(res, 204, {});

  try {
    // 1) send OTP — the caller gives ONLY their ID; we look up the phone on file and
    //    text the code there. The caller can never redirect the OTP to another number.
    if (req.method === "POST" && url.pathname === "/api/crm/otp/send") {
      const { personId } = await readJson(req);
      if (!personId) return send(res, 400, { error: "personId is required" });
      // Resolve the registered mobile by ID.
      const pr = await crmFetch(`/api/Policy/GetByPersonId?personId=${encodeURIComponent(String(personId))}`);
      if (!pr.ok) return send(res, 502, { error: "lookup_failed" });
      const rec = await pr.json().catch(() => null);
      const person = Array.isArray(rec) ? rec[0] : rec;
      const raw = person ? pick(person, ["mobile", "phone"]) : null;
      if (!raw) return send(res, 404, { error: "no_phone_on_file" });
      const phone = normalizePhone(raw);
      const r = await crmFetch("/api/Auth/sendotp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: String(personId), phoneNumber: phone }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        console.error("[crm-proxy] sendotp failed:", r.status, detail.slice(0, 200));
        return send(res, 502, {
          error: "otp_send_failed",
          ...(process.env.CRM_DEBUG_FIELDS === "1" ? { crmStatus: r.status, crmBody: detail.slice(0, 200), triedPhone: phone } : {}),
        });
      }
      return send(res, 200, { ok: true, phoneHint: maskPhone(phone) });
    }

    // 2) verify OTP → mint a session scoped to this personId
    if (req.method === "POST" && url.pathname === "/api/crm/otp/verify") {
      const { personId, code } = await readJson(req);
      if (!personId || !code) return send(res, 400, { error: "personId and code are required" });
      const r = await crmFetch("/api/Auth/verifyotp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: String(personId), otpCode: String(code) }),
      });
      if (!r.ok) return send(res, 401, { error: "otp_invalid" });
      return send(res, 200, { token: signSession(String(personId)) });
    }

    // 3) read the verified customer's OWN policy
    if (req.method === "GET" && url.pathname === "/api/crm/policy") {
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const session = verifySession(auth);
      if (!session) return send(res, 401, { error: "session_invalid_or_expired" });
      const r = await crmFetch(`/api/Policy/GetById?id=${encodeURIComponent(session.personId)}`);
      if (!r.ok) return send(res, 502, { error: "policy_lookup_failed" });
      const raw = await r.json();
      return send(res, 200, sanitizeLookup(raw));
    }

    // 3b) the coverages (riders) on ONE of the verified customer's policies. We look
    //     the policy up by index, then return the riders for THIS person only — and
    //     only if they're actually a customer on that policy.
    if (req.method === "GET" && url.pathname === "/api/crm/policy/coverage") {
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const session = verifySession(auth);
      if (!session) return send(res, 401, { error: "session_invalid_or_expired" });
      const policyIndex = url.searchParams.get("policyIndex");
      if (!policyIndex) return send(res, 400, { error: "policyIndex required" });
      const r = await crmFetch(
        `/api/Policy/GetPolicyCustomersDetailsByIndex?policyIndex=${encodeURIComponent(policyIndex)}`,
      );
      if (!r.ok) return send(res, 502, { error: "coverage_lookup_failed" });
      const j = await r.json().catch(() => null);
      const customers = Array.isArray(j?.customers) ? j.customers : [];
      const me = customers.find((c) => String(c.personId) === String(session.personId));
      if (!me) return send(res, 403, { error: "not_your_policy" });
      const coverages = (Array.isArray(me.riders) ? me.riders : [])
        .map((rd) => pick(rd, ["riderName"]))
        .filter(Boolean);
      return send(res, 200, { coverages });
    }

    // Who else is insured on the verified caller's policy (names only, no IDs).
    // Only served when the session's own personId is on that policy.
    if (req.method === "GET" && url.pathname === "/api/crm/policy/members") {
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const session = verifySession(auth);
      if (!session) return send(res, 401, { error: "session_invalid_or_expired" });
      const policyIndex = url.searchParams.get("policyIndex");
      if (!policyIndex) return send(res, 400, { error: "policyIndex required" });
      // The policy row from GetById carries the full insured list WITH names
      // (unlike GetPolicyCustomersDetailsByIndex). Scope it to the caller's own id.
      const r = await crmFetch(`/api/Policy/GetById?id=${encodeURIComponent(session.personId)}`);
      if (!r.ok) return send(res, 502, { error: "members_lookup_failed" });
      const list = await r.json().catch(() => null);
      const policies = Array.isArray(list) ? list : list ? [list] : [];
      const policy = policies.find((p) => String(pick(p, ["policyIndex"])) === String(policyIndex));
      const customers = Array.isArray(policy?.customers) ? policy.customers : [];
      // Security: the caller must actually be one of the insured on this policy.
      if (!customers.some((c) => String(c.personId) === String(session.personId)))
        return send(res, 403, { error: "not_your_policy" });
      const members = customers
        .map((c) => ({
          name: personName(c),
          is_me: String(c.personId) === String(session.personId),
        }))
        .filter((m) => m.name);
      return send(res, 200, { members });
    }

    // Mint a short-lived ephemeral token so the browser can open the Gemini Live
    // WebSocket directly, without ever seeing the real API key.
    if (req.method === "POST" && url.pathname === "/api/gemini/token") {
      if (!genai) return send(res, 501, { error: "gemini_not_configured" });
      // A "basic" token (no liveConnectConstraints) — so the full session config
      // (system instruction, tools, voice) sent at connect time is honored. A
      // constrained token drops connect-time config and Dalit loses her persona.
      const t = await genai.authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
          newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
          httpOptions: { apiVersion: "v1alpha" },
        },
      });
      return send(res, 200, { token: t.name, model: GEMINI_LIVE_MODEL });
    }

    // Brain — a fast text LLM (Gemini Flash-Lite or Grok) answers a turn. The
    // browser drives the tool loop (tools run there, against the OTP session).
    if (req.method === "POST" && url.pathname === "/api/brain") {
      const { provider, system, messages, tools } = await readJson(req);
      if (!system || !Array.isArray(messages)) return send(res, 400, { error: "system + messages required" });
      try {
        const out = await runBrain({ provider: provider === "grok" ? "grok" : "flash", system, messages, tools });
        return send(res, 200, out);
      } catch (e) {
        console.error("[brain] failed:", e?.message ?? e);
        return send(res, 502, { error: "brain_failed", detail: String(e?.message ?? e).slice(0, 160) });
      }
    }

    // ElevenLabs TTS — the browser sends text, we speak it and stream MP3 back.
    if (req.method === "POST" && url.pathname === "/api/tts/elevenlabs") {
      if (!elevenConfigured) return send(res, 501, { error: "eleven_not_configured" });
      const { text, voiceId } = await readJson(req);
      const t = normalizeHebrewTts(String(text || "").trim());
      const vid = String(voiceId || "").trim();
      if (!t || !vid) return send(res, 400, { error: "text + voiceId required" });
      const er = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "content-type": "application/json",
            accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: t,
            model_id: ELEVEN_MODEL,
            voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
          }),
        },
      );
      if (!er.ok) {
        console.error("[tts] elevenlabs failed:", er.status, (await er.text()).slice(0, 200));
        return send(res, 502, { error: "tts_failed", status: er.status });
      }
      const audio = Buffer.from(await er.arrayBuffer());
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": audio.length,
        "access-control-allow-origin": CRM_ALLOW_ORIGIN,
        "cache-control": "no-store",
      });
      return res.end(audio);
    }

    // Azure Neural TTS — native Hebrew voice, returns MP3.
    if (req.method === "POST" && url.pathname === "/api/tts/azure") {
      if (!azureConfigured) return send(res, 501, { error: "azure_tts_not_configured" });
      const { text, voiceName } = await readJson(req);
      const t = normalizeHebrewTts(String(text || "").trim());
      const voice = String(voiceName || "he-IL-HilaNeural").trim();
      if (!t) return send(res, 400, { error: "text required" });
      // Speak a touch faster than the default (tunable via AZURE_TTS_RATE).
      const rate = process.env.AZURE_TTS_RATE || "+8%";
      const ssml =
        `<speak version='1.0' xml:lang='he-IL'>` +
        `<voice name='${xmlEscape(voice)}'><prosody rate='${xmlEscape(rate)}'>${xmlEscape(t)}</prosody></voice></speak>`;
      const ar = await fetch(
        `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
            "content-type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
            "User-Agent": "ophir-dalit",
          },
          body: ssml,
        },
      );
      if (!ar.ok) {
        console.error("[tts] azure failed:", ar.status, (await ar.text()).slice(0, 200));
        return send(res, 502, { error: "azure_tts_failed", status: ar.status });
      }
      const audio = Buffer.from(await ar.arrayBuffer());
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": audio.length,
        "access-control-allow-origin": CRM_ALLOW_ORIGIN,
        "cache-control": "no-store",
      });
      return res.end(audio);
    }

    // Agent availability — read (Dalit's tool, and the admin panel) …
    if (req.method === "GET" && url.pathname === "/api/agents/status") {
      const agent = url.searchParams.get("agent");
      if (agent) return send(res, 200, { agent, status: statusFor(agent) });
      return send(res, 200, { statuses: loadStatuses() });
    }
    // … and set (the admin toggle).
    if (req.method === "POST" && url.pathname === "/api/agents/status") {
      const { agent, status } = await readJson(req);
      if (!agent || !VALID_STATUS.has(status))
        return send(res, 400, { error: "agent + status (available|busy|away) required" });
      const all = loadStatuses();
      all[String(agent)] = status;
      saveStatuses(all);
      return send(res, 200, { ok: true, statuses: all });
    }

    // Email a team member the details of a caller who asked for them.
    if (req.method === "POST" && url.pathname === "/api/notify/agent") {
      const { agent_name, caller_name, caller_phone, reason } = await readJson(req);
      const to = agentEmail(agent_name);
      if (!to) return send(res, 400, { error: "unknown_agent" });
      if (!graphConfigured && !mailer)
        return send(res, 200, { ok: false, emailed: false, reason: "email_not_configured" });
      const subject = `בקשת חזרה — ${caller_name || "מתקשר"}`;
      const html = agentEmailHtml({ agentName: agent_name, callerName: caller_name, callerPhone: caller_phone, reason });
      const text =
        `דלית, הנציגה הקולית, קיבלה עבורך פנייה:\n\n` +
        `שם: ${caller_name || "—"}\n` +
        `טלפון: ${caller_phone || "—"}\n` +
        `נושא: ${reason || "—"}\n\n` +
        `נרשם אוטומטית בשיחה קולית. נא לחזור ללקוח.`;
      try {
        if (graphConfigured) await sendMailGraph(to, subject, html);
        else await mailer.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html });
        return send(res, 200, { ok: true, emailed: true, via: graphConfigured ? "graph" : "smtp" });
      } catch (e) {
        console.error("[mail] send failed:", e?.message ?? e);
        return send(res, 200, { ok: false, emailed: false, error: String(e?.message ?? e) });
      }
    }

    // Save a lead — emails it to the office inbox (used by the MCP save_lead tool).
    if (req.method === "POST" && url.pathname === "/api/notify/lead") {
      const { full_name, phone, topic } = await readJson(req);
      const to = GRAPH_SENDER || SMTP_FROM || SMTP_USER;
      if ((!graphConfigured && !mailer) || !to)
        return send(res, 200, { ok: false, emailed: false, reason: "email_not_configured" });
      const subject = `פנייה חדשה — ${full_name || "לקוח"}`;
      const html = agentEmailHtml({ agentName: "צוות אופיר", callerName: full_name, callerPhone: phone, reason: topic || "פנייה כללית" });
      const text = `פנייה חדשה שנרשמה בשיחה קולית:\n\nשם: ${full_name || "—"}\nטלפון: ${phone || "—"}\nנושא: ${topic || "—"}`;
      try {
        if (graphConfigured) await sendMailGraph(to, subject, html);
        else await mailer.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html });
        return send(res, 200, { ok: true, emailed: true });
      } catch (e) {
        console.error("[mail] lead send failed:", e?.message ?? e);
        return send(res, 200, { ok: false, emailed: false, error: String(e?.message ?? e) });
      }
    }

    if (url.pathname === "/api/crm/health") return send(res, 200, { ok: true });

    // Unknown /api path → JSON 404. Anything else → the built SPA (prod only).
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not_found" });
    if (req.method === "GET" && hasDist) return serveStatic(res, url.pathname);
    return send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[crm-proxy] error:", e?.message ?? e);
    return send(res, 500, { error: "server_error" });
  }
});

// ── Grok Voice relay ─────────────────────────────────────────────────────────
// The browser can't put our xAI key on a WebSocket, so it connects here and we
// relay it to the xAI Voice Agent realtime API with the key held server-side.
const grokWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname !== "/api/grok/realtime") return socket.destroy();
  if (!XAI_API_KEY) return socket.destroy();
  grokWss.handleUpgrade(req, socket, head, (browserWs) => {
    const upstream = new WsClient(`wss://api.x.ai/v1/realtime?agent_id=${encodeURIComponent(XAI_AGENT_ID)}`, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });
    const queue = [];
    upstream.on("open", () => {
      for (const m of queue) upstream.send(m);
      queue.length = 0;
    });
    browserWs.on("message", (m) => {
      const s = m.toString();
      if (upstream.readyState === WsClient.OPEN) upstream.send(s);
      else queue.push(s);
    });
    upstream.on("message", (m) => {
      if (browserWs.readyState === browserWs.OPEN) browserWs.send(m.toString());
    });
    const closeBoth = () => {
      try { browserWs.close(); } catch {}
      try { upstream.close(); } catch {}
    };
    browserWs.on("close", closeBoth);
    upstream.on("close", closeBoth);
    browserWs.on("error", closeBoth);
    upstream.on("error", (e) => {
      console.error("[grok relay] upstream error:", String(e?.message ?? e).slice(0, 140));
      closeBoth();
    });
  });
});

const LISTEN_PORT = Number(PORT || CRM_PROXY_PORT);
server.listen(LISTEN_PORT, () => {
  console.log(
    `[crm-proxy] listening on :${LISTEN_PORT} → ${CRM_BASE_URL}` +
      (hasDist ? " (also serving dist/)" : " (API only; run Vite for the SPA)"),
  );
});
