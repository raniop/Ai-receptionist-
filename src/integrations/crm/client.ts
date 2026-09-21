// Browser-side client for the CRM proxy (server/crm-proxy.mjs). The browser NEVER
// talks to the CRM directly and never sees its credentials — it only calls our
// proxy at /api/crm/*, which enforces OTP verification and scopes every lookup to
// the verified person. The short-lived session token lives in memory only (not
// localStorage) so it disappears when the tab closes.

const BASE = import.meta.env.VITE_CRM_BASE_URL || ""; // same-origin by default (Vite dev-proxies /api/crm)

export type PolicyView = {
  policyNumber: string | null;
  insuranceType: string | null;
  startDate: string | null;
  endDate: string | null;
  premium: string | number | null;
  agentName: string | null;
  active: boolean | null;
};

export type LookupResult = { customerName: string | null; count: number; policies: PolicyView[] };

let sessionToken: string | null = null;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Step 1 — the proxy looks up the phone on file by ID and texts the OTP there.
 *  Returns a masked hint (last 4 digits) for the spoken confirmation. Never throws. */
export async function sendOtp(personId: string): Promise<{ ok: boolean; phoneHint?: string }> {
  try {
    const r = await post("/api/crm/otp/send", { personId });
    if (!r.ok) return { ok: false };
    const j = (await r.json().catch(() => ({}))) as { phoneHint?: string };
    return { ok: true, phoneHint: j.phoneHint };
  } catch {
    return { ok: false };
  }
}

/** Step 2 — verify the code. On success a scoped session is held in memory. Never throws. */
export async function verifyOtp(personId: string, code: string): Promise<boolean> {
  try {
    const r = await post("/api/crm/otp/verify", { personId, code });
    if (!r.ok) return false;
    const j = (await r.json()) as { token?: string };
    if (!j.token) return false;
    sessionToken = j.token;
    return true;
  } catch {
    return false;
  }
}

/** Step 3 — read the verified customer's own policies. Requires a live session. */
export async function getMyPolicy(): Promise<LookupResult> {
  if (!sessionToken) throw new Error("not_verified");
  const r = await fetch(`${BASE}/api/crm/policy`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!r.ok) {
    if (r.status === 401) sessionToken = null;
    throw new Error("policy_lookup_failed");
  }
  const j = (await r.json()) as LookupResult;
  return { customerName: j.customerName ?? null, count: j.count ?? 0, policies: j.policies ?? [] };
}

/** Forget the current verified session (call when a lookup conversation ends). */
export function clearCrmSession(): void {
  sessionToken = null;
}
