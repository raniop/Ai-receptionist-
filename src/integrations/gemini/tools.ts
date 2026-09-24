// Executes the tools Dalit (Gemini Live) calls, by reusing the app's existing
// integrations: the OTP-gated CRM proxy and the local leads store. Each returns a
// plain object that we hand straight back to the model as the function response.
import { sendOtp, verifyOtp, getMyPolicy, getPolicyCoverage } from "@/integrations/crm/client";
import { db } from "@/integrations/neon/client";
import { staff, secretariat } from "@/content/site";
import { getAgentStatus, STATUS_LABEL } from "@/integrations/agents/status";

function ref(prefix: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

export type ToolResult = Record<string, unknown>;

export async function runTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  try {
    switch (name) {
      case "send_policy_otp": {
        const res = await sendOtp(String(args.person_id ?? "").trim());
        return res.ok
          ? { ok: true, phone_hint: res.phoneHint ?? null }
          : { ok: false, error: "לא הצלחתי לשלוח קוד. ייתכן שאין טלפון רשום על תעודת הזהות הזו." };
      }
      case "verify_policy_otp": {
        const ok = await verifyOtp(String(args.person_id ?? "").trim(), String(args.code ?? "").trim());
        return { ok, error: ok ? undefined : "הקוד שגוי או פג תוקף." };
      }
      case "get_my_policy": {
        const r = await getMyPolicy();
        const now = Date.now();
        const rank: Record<string, number> = { פעילה: 0, עתידית: 1, הסתיימה: 2 };
        // A policy can be modified by additions (תוספות) — e.g. an April trip changed
        // to October. GetById returns a row per addition, so collapse each policy
        // number to its LATEST version (the one ending last) to reflect the current dates.
        const latest = new Map<string, (typeof r.policies)[number]>();
        r.policies.forEach((p, i) => {
          const key = String(p.policyNumber ?? `#${i}`);
          const prev = latest.get(key);
          const end = Date.parse(p.endDate || "") || 0;
          if (!prev || end > (Date.parse(prev.endDate || "") || 0)) latest.set(key, p);
        });
        const deduped = [...latest.values()];
        const withStatus = deduped.map((p) => {
          const s = Date.parse(p.startDate || "");
          const e = Date.parse(p.endDate || "");
          const status =
            !Number.isNaN(s) && s > now
              ? "עתידית"
              : !Number.isNaN(e) && e >= now
                ? "פעילה"
                : "הסתיימה";
          return {
            insurance_type: p.insuranceType,
            policy_number: p.policyNumber,
            policy_index: p.policyIndex,
            start_date: p.startDate,
            end_date: p.endDate,
            status,
          };
        });
        // Active/upcoming first, then newest — so the relevant policy is never buried.
        withStatus.sort(
          (a, b) =>
            (rank[a.status] - rank[b.status]) ||
            (Date.parse(b.start_date || "") || 0) - (Date.parse(a.start_date || "") || 0),
        );
        const relevant = withStatus.filter((p) => p.status !== "הסתיימה");
        return {
          customer_name: r.customerName,
          total_policies: deduped.length,
          active_or_upcoming_count: relevant.length,
          policies: withStatus.slice(0, 6),
        };
      }
      case "get_policy_coverage": {
        const coverages = await getPolicyCoverage(String(args.policy_index ?? ""));
        return coverages.length
          ? { coverages }
          : { coverages: [], note: "לא נמצאו כיסויים רשומים על הפוליסה הזו." };
      }
      case "save_lead": {
        const reference = ref("OPH-L");
        const { error } = await db.from("leads").insert({
          reference,
          full_name: String(args.full_name ?? "").trim(),
          phone: String(args.phone ?? "").trim(),
          email: "voice@ophirins.co.il",
          insurance_type:
            args.topic === "נסיעות" ? "ביטוח נסיעות לחו״ל" : String(args.topic ?? "אחר"),
          message: `פנייה שנרשמה בשיחה קולית עם דלית (Gemini). נושא: ${args.topic ?? "כללי"}.`,
          source: "gemini-voice",
        });
        return error ? { ok: false, error: error.message } : { ok: true, reference };
      }
      case "check_agent_status": {
        const status = await getAgentStatus(String(args.agent_name ?? "").trim());
        return { status, status_label: STATUS_LABEL[status] };
      }
      case "contact_agent": {
        // The caller asked for a specific team member. Record a call-back request
        // routed to that person (who's assumed busy) so the team acts on it.
        const asked = String(args.agent_name ?? "").trim();
        const all = [...staff, { name: secretariat.name, role: secretariat.role, email: secretariat.email }];
        const match =
          all.find((m) => m.name.includes(asked)) ??
          all.find((m) => asked && asked.includes(m.name.split(" ")[0])) ??
          null;
        const targetName = match?.name ?? (asked || "הנציג המבוקש");
        const reference = ref("OPH-A");
        const { error } = await db.from("leads").insert({
          reference,
          full_name: String(args.caller_name ?? "").trim(),
          phone: String(args.caller_phone ?? "").trim(),
          email: "voice@ophirins.co.il",
          insurance_type: "פנייה לנציג",
          message: `המתקשר ביקש לדבר עם ${targetName}. סיבה: ${args.reason ?? "—"}. להעברה ל${targetName}${match?.email ? ` (${match.email})` : ""}.`,
          source: "voice-agent-request",
        });
        if (error) return { ok: false, error: error.message };
        // Email the team member the caller's details.
        let emailed = false;
        try {
          const nr = await fetch("/api/notify/agent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent_name: targetName,
              caller_name: args.caller_name,
              caller_phone: args.caller_phone,
              reason: args.reason,
            }),
          });
          emailed = nr.ok ? Boolean((await nr.json())?.emailed) : false;
        } catch {
          emailed = false;
        }
        return { ok: true, agent: targetName, reference, emailed };
      }
      case "transfer_to_agent": {
        return { ok: true, message: "השיחה מועברת לנציג. בשעות הפעילות זה מיידי, אחרת נחזור בהקדם." };
      }
      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
