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

const {
  CRM_BASE_URL,
  CRM_USERNAME,
  CRM_PASSWORD,
  CRM_PROXY_PORT = "5055",
  CRM_SESSION_SECRET,
  CRM_ALLOW_ORIGIN = "http://localhost:5173",
} = process.env;

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

// ── policy sanitization: return only what a customer should hear read back ────
function sanitizePolicy(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pick = (o, keys) => {
    for (const k of keys) {
      const hit = Object.keys(o).find((kk) => kk.toLowerCase() === k.toLowerCase());
      if (hit != null && o[hit] != null && o[hit] !== "") return o[hit];
    }
    return null;
  };
  return list.map((o) => ({
    policyNumber: pick(o, ["policyNumber", "policyNo", "policyIndex", "polisaNumber", "mspolisa", "id"]),
    status: pick(o, ["status", "statusName", "polisaStatus", "matzav"]),
    insuranceType: pick(o, ["insuranceType", "productName", "product", "sugBituh", "type"]),
    startDate: pick(o, ["startDate", "fromDate", "startdate", "dateFrom", "tarichHatchala"]),
    endDate: pick(o, ["endDate", "toDate", "enddate", "dateTo", "tarichSium"]),
    premium: pick(o, ["premium", "totalPremium", "price", "amount", "premia"]),
    fullName: pick(o, ["fullName", "customerName", "name", "shem"]),
  }));
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
    // 1) send OTP to the customer's phone
    if (req.method === "POST" && url.pathname === "/api/crm/otp/send") {
      const { personId, phone } = await readJson(req);
      if (!personId || !phone) return send(res, 400, { error: "personId and phone are required" });
      const r = await crmFetch("/api/Auth/sendotp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: String(personId), phoneNumber: String(phone) }),
      });
      if (!r.ok) return send(res, 502, { error: "otp_send_failed" });
      return send(res, 200, { ok: true });
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
      const r = await crmFetch(`/api/Policy/GetByPersonId?personId=${encodeURIComponent(session.personId)}`);
      if (!r.ok) return send(res, 502, { error: "policy_lookup_failed" });
      const raw = await r.json();
      return send(res, 200, { policies: sanitizePolicy(raw) });
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
