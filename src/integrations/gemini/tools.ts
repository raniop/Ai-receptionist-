// Executes the tools Dalit (Gemini Live) calls, by reusing the app's existing
// integrations: the OTP-gated CRM proxy and the local leads store. Each returns a
// plain object that we hand straight back to the model as the function response.
import { sendOtp, verifyOtp, getMyPolicy } from "@/integrations/crm/client";
import { db } from "@/integrations/neon/client";

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
        return {
          customer_name: r.customerName,
          policy_count: r.count,
          policies: r.policies.slice(0, 5).map((p) => ({
            insurance_type: p.insuranceType,
            policy_number: p.policyNumber,
            start_date: p.startDate,
            end_date: p.endDate,
            active: p.active,
          })),
        };
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
