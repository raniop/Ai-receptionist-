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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CRM_PROXY_PORT}`);
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
      const r = await crmFetch(
        `/api/Policy/GetPolicyCustomersDetailsByIndex?policyIndex=${encodeURIComponent(policyIndex)}`,
      );
      if (!r.ok) return send(res, 502, { error: "members_lookup_failed" });
      const j = await r.json().catch(() => null);
      const customers = Array.isArray(j?.customers) ? j.customers : [];
      if (customers[0]) console.error("[members] customer keys:", Object.keys(customers[0]).join(","));
      const me = customers.find((c) => String(c.personId) === String(session.personId));
      if (!me) return send(res, 403, { error: "not_your_policy" });
      const members = customers
        .map((c) => ({ name: personName(c), is_me: String(c.personId) === String(session.personId) }))
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

const LISTEN_PORT = Number(PORT || CRM_PROXY_PORT);
server.listen(LISTEN_PORT, () => {
  console.log(
    `[crm-proxy] listening on :${LISTEN_PORT} → ${CRM_BASE_URL}` +
      (hasDist ? " (also serving dist/)" : " (API only; run Vite for the SPA)"),
  );
});
