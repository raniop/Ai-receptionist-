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
import { GoogleGenAI } from "@google/genai";

const {
  CRM_BASE_URL,
  CRM_USERNAME,
  CRM_PASSWORD,
  CRM_PROXY_PORT = "5055",
  CRM_SESSION_SECRET,
  CRM_ALLOW_ORIGIN = "http://localhost:5173",
  GEMINI_API_KEY,
  GEMINI_LIVE_MODEL = "gemini-3.8-live",
} = process.env;

// Gemini Live: the browser gets a short-lived EPHEMERAL token from us and connects
// to Google directly — the real API key never leaves the server.
const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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

function isActive(endDate) {
  const t = Date.parse(endDate);
  return Number.isNaN(t) ? null : t >= Date.now();
}

function sanitizeLookup(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const customerName = list[0] ? pick(list[0], ["clientName"]) : null;
  const policies = list.map((p) => {
    const endDate = pick(p, ["endDate"]);
    return {
      policyNumber: pick(p, ["fullPolicyID", "policyDoc", "policyIndex"]),
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

    // Mint a short-lived ephemeral token so the browser can open the Gemini Live
    // WebSocket directly, without ever seeing the real API key.
    if (req.method === "POST" && url.pathname === "/api/gemini/token") {
      if (!genai) return send(res, 501, { error: "gemini_not_configured" });
      const t = await genai.authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
          newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
          liveConnectConstraints: { model: GEMINI_LIVE_MODEL },
          httpOptions: { apiVersion: "v1alpha" },
        },
      });
      return send(res, 200, { token: t.name, model: GEMINI_LIVE_MODEL });
    }

    if (url.pathname === "/api/crm/health") return send(res, 200, { ok: true });
    return send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[crm-proxy] error:", e?.message ?? e);
    return send(res, 500, { error: "server_error" });
  }
});

server.listen(Number(CRM_PROXY_PORT), () => {
  console.log(`[crm-proxy] listening on http://localhost:${CRM_PROXY_PORT} → ${CRM_BASE_URL}`);
});
