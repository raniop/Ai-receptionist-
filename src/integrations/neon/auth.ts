// Local auth — a drop-in replacement for the old Neon Auth (better-auth) client.
//
// Self-contained, no backend: accounts and the current session live in localStorage.
// This is a single-tenant staff tool, so the FIRST account created becomes the admin
// (role "admin"); any later account is a plain "user". Passwords are stored as a
// SHA-256 hash (never plaintext). The public surface matches the old module exactly —
// signUp / signIn / signOut / refreshSession / getAccessToken / subscribe / currentUser
// — so useAuth, the admin route, the header and the auth form keep working untouched.

export type NeonUser = { id: string; email: string; name?: string | null; image?: string | null; role?: string | null };

type Account = NeonUser & { passHash: string };

const ACCOUNTS_KEY = "ophir:auth:accounts";
const SESSION_KEY = "ophir:auth:session";

// ── storage helpers ──────────────────────────────────────────────────────────
function loadAccounts(): Account[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as Account[]) : [];
  } catch {
    return [];
  }
}
function saveAccounts(list: Account[]): void {
  try {
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
function setSessionId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(SESSION_KEY, id);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
function getSessionId(): string | null {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

async function hash(password: string): Promise<string> {
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const bytes = new TextEncoder().encode(password);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* fall through */
  }
  // Non-crypto fallback (older/insecure contexts): a simple string hash.
  let h = 5381;
  for (let i = 0; i < password.length; i++) h = (h * 33) ^ password.charCodeAt(i);
  return "x" + (h >>> 0).toString(16);
}

function publicUser(a: Account | null): NeonUser | null {
  if (!a) return null;
  const { passHash: _ignored, ...rest } = a;
  return rest;
}

// ── in-memory session state (single source of truth, React subscribes) ──
let user: NeonUser | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function currentUser(): NeonUser | null {
  return user;
}

/** Read the current session from localStorage. Call on app start + after auth changes. */
export async function refreshSession(): Promise<NeonUser | null> {
  const id = getSessionId();
  const account = id ? loadAccounts().find((a) => a.id === id) ?? null : null;
  user = publicUser(account);
  emit();
  return user;
}

/** No JWT in local mode — the db layer is local and ignores this. Kept for API parity. */
export async function getAccessToken(): Promise<string | null> {
  return null;
}

export async function signUp(email: string, password: string, name?: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const accounts = loadAccounts();
  if (accounts.some((a) => a.email.toLowerCase() === normalized)) {
    throw new Error("כבר קיים חשבון עם הדוא״ל הזה. אפשר להתחבר.");
  }
  const account: Account = {
    id: "u-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    email: normalized,
    name: name || normalized.split("@")[0],
    // The first account to register owns this tool → admin. Later accounts are plain users.
    role: accounts.length === 0 ? "admin" : "user",
    passHash: await hash(password),
  };
  saveAccounts([...accounts, account]);
  setSessionId(account.id);
  user = publicUser(account);
  emit();
}

export async function signIn(email: string, password: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const account = loadAccounts().find((a) => a.email.toLowerCase() === normalized);
  if (!account || account.passHash !== (await hash(password))) {
    throw new Error("דוא״ל או סיסמה שגויים.");
  }
  setSessionId(account.id);
  user = publicUser(account);
  emit();
}

export async function signOut(): Promise<void> {
  setSessionId(null);
  user = null;
  emit();
}
