import { useEffect, useState } from "react";
import { staff, secretariat } from "@/content/site";
import {
  getAllStatuses,
  setAgentStatus,
  STATUS_LABEL,
  type AgentStatus,
} from "@/integrations/agents/status";

const TEAM = [
  ...staff.map((s) => ({ name: s.name, role: s.role })),
  { name: secretariat.name, role: secretariat.role },
];

const DOT: Record<AgentStatus, string> = {
  available: "bg-emerald-400",
  busy: "bg-amber-400",
  away: "bg-muted-foreground",
};
const ORDER: AgentStatus[] = ["available", "busy", "away"];

export function AgentsPanel() {
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    getAllStatuses().then(setStatuses);
  }, []);

  async function change(name: string, status: AgentStatus) {
    setStatuses((prev) => ({ ...prev, [name]: status }));
    setSaving(name);
    await setAgentStatus(name, status);
    setSaving(null);
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground">
        זמינות הצוות — דלית בודקת את הסטטוס לפני שהיא מפנה שיחה לעובד. (זמני; בהמשך יתחבר
        למרכזייה אוטומטית.)
      </p>
      <div className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {TEAM.map((m) => {
          const status = statuses[m.name] ?? "available";
          return (
            <div key={m.name} className="flex flex-wrap items-center gap-3 bg-card px-4 py-3">
              <span className={`h-2.5 w-2.5 rounded-full ${DOT[status]}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.role}</p>
              </div>
              {saving === m.name ? (
                <span className="text-xs text-muted-foreground">שומר…</span>
              ) : null}
              <select
                value={status}
                onChange={(e) => change(m.name, e.target.value as AgentStatus)}
                className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              >
                {ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
