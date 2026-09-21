// Local data layer — a drop-in replacement for the old Neon Data API client.
//
// We dropped Vincen/Neon and now run fully self-contained: no backend, no env vars,
// no network. Reads for `knowledge_base` and `site_info` come from the bundled seed
// (src/data/seed.ts); `leads` and `appointments` are read/written to localStorage so
// submissions actually persist in the browser. `booked_slots` is a derived view over
// appointments. The public surface is unchanged — `db.from("table").select()/.insert()
// /.update()/.eq()/.order()…` and an awaitable `{ data, error }` — so every consumer
// keeps working untouched.
import { knowledgeBaseSeed, siteInfoSeed } from "@/data/seed";

export type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

// ── storage ────────────────────────────────────────────────────────────────
const PREFIX = "ophir:db:";
type Row = Record<string, any>;

/** Tables that live in localStorage (everything the visitor creates). */
const PERSISTED = new Set(["leads", "appointments"]);

function load(table: string): Row[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PREFIX + table);
    return raw ? (JSON.parse(raw) as Row[]) : [];
  } catch {
    return [];
  }
}

function save(table: string, rows: Row[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + table, JSON.stringify(rows));
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** Read-only source rows for a table (seed, derived views, or the persisted store). */
function sourceRows(table: string): Row[] {
  switch (table) {
    case "knowledge_base":
      return knowledgeBaseSeed.map((r) => ({ ...r }));
    case "site_info":
      return siteInfoSeed.map((r) => ({ ...r }));
    case "booked_slots":
      // Derived: the taken slots per date (cancelled appointments free their slot up).
      return load("appointments")
        .filter((a) => a.status !== "Cancelled")
        .map((a) => ({ appointment_date: a.appointment_date, time_slot: a.time_slot }));
    case "leads":
    case "appointments":
      return load(table);
    default:
      // Unknown tables (template leftovers: items/posts/assets) resolve to empty.
      return [];
  }
}

/** Defaults stamped onto a freshly inserted row so the admin panels have what they read. */
function withInsertDefaults(table: string, row: Row): Row {
  const base: Row = {
    id: row.id ?? uuid(),
    created_at: row.created_at ?? new Date().toISOString(),
    ...row,
  };
  if (table === "leads" && base.status == null) base.status = "New";
  if (table === "appointments" && base.status == null) base.status = "Pending";
  if (base.notes === undefined) base.notes = null;
  return base;
}

type Filter = { col: string; op: string; val: unknown };

// Chainable query with the same shape the old PostgREST client exposed. `await` runs it.
class Query<T = any> implements PromiseLike<Result<T>> {
  private _filters: Filter[] = [];
  private _order?: { col: string; ascending: boolean };
  private _limit?: number;
  private _single = false;
  private _method: "GET" | "INSERT" | "UPDATE" | "DELETE" = "GET";
  private _body?: Row | Row[];

  constructor(private table: string) {}

  private f(col: string, op: string, val: unknown) {
    this._filters.push({ col, op, val });
    return this;
  }
  eq(col: string, val: unknown) { return this.f(col, "eq", val); }
  neq(col: string, val: unknown) { return this.f(col, "neq", val); }
  gt(col: string, val: unknown) { return this.f(col, "gt", val); }
  gte(col: string, val: unknown) { return this.f(col, "gte", val); }
  lt(col: string, val: unknown) { return this.f(col, "lt", val); }
  lte(col: string, val: unknown) { return this.f(col, "lte", val); }
  like(col: string, val: string) { return this.f(col, "like", val); }
  ilike(col: string, val: string) { return this.f(col, "ilike", val); }
  is(col: string, val: "null" | "true" | "false") { return this.f(col, "is", val); }
  in(col: string, vals: unknown[]) { return this.f(col, "in", vals); }

  select(_cols = "*") { return this; } // projection is a no-op; extra fields are harmless
  order(col: string, opts?: { ascending?: boolean }) {
    this._order = { col, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  single() { this._single = true; return this; }

  insert(values: Row | Row[]) { this._method = "INSERT"; this._body = values; return this; }
  update(values: Row) { this._method = "UPDATE"; this._body = values; return this; }
  upsert(values: Row | Row[]) { this._method = "INSERT"; this._body = values; return this; }
  delete() { this._method = "DELETE"; return this; }

  private matches(row: Row): boolean {
    return this._filters.every(({ col, op, val }) => {
      const cell = row[col];
      switch (op) {
        case "eq": return cell === val || String(cell) === String(val);
        case "neq": return String(cell) !== String(val);
        case "gt": return cell > (val as any);
        case "gte": return cell >= (val as any);
        case "lt": return cell < (val as any);
        case "lte": return cell <= (val as any);
        case "like":
        case "ilike": {
          const rx = new RegExp("^" + String(val).replace(/%/g, ".*") + "$", op === "ilike" ? "i" : "");
          return rx.test(String(cell ?? ""));
        }
        case "is": return val === "null" ? cell == null : String(cell) === val;
        case "in": return (val as unknown[]).map(String).includes(String(cell));
        default: return true;
      }
    });
  }

  private run(): Result<T> {
    try {
      // ── writes ──
      if (this._method === "INSERT") {
        if (!PERSISTED.has(this.table)) {
          // Unknown/read-only table: accept silently so callers don't error.
          return { data: null, error: null };
        }
        const incoming = Array.isArray(this._body) ? this._body : [this._body as Row];
        const created = incoming.map((r) => withInsertDefaults(this.table, r));
        save(this.table, [...load(this.table), ...created]);
        const out = this._single ? created[0] : created;
        return { data: out as T, error: null };
      }
      if (this._method === "UPDATE") {
        if (!PERSISTED.has(this.table)) return { data: null, error: null };
        const rows = load(this.table);
        const patch = this._body as Row;
        const next = rows.map((r) => (this.matches(r) ? { ...r, ...patch } : r));
        save(this.table, next);
        return { data: null, error: null };
      }
      if (this._method === "DELETE") {
        if (!PERSISTED.has(this.table)) return { data: null, error: null };
        save(this.table, load(this.table).filter((r) => !this.matches(r)));
        return { data: null, error: null };
      }

      // ── reads ──
      let rows = sourceRows(this.table).filter((r) => this.matches(r));
      if (this._order) {
        const { col, ascending } = this._order;
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return ascending ? cmp : -cmp;
        });
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      if (this._single) {
        return { data: (rows[0] ?? null) as T, error: rows[0] ? null : { message: "No rows found" } };
      }
      return { data: rows as T, error: null };
    } catch (e: any) {
      return { data: null, error: { message: String(e?.message ?? e) } };
    }
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((v: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

export const db = {
  /** Start a query against a table/view, e.g. `db.from("leads")`. */
  from<T = any>(table: string) { return new Query<T>(table); },
};
