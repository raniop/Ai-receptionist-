// Agent availability, served by the proxy (shared across everyone). Manual for now;
// the same interface will later be backed by real phone-system presence.
export type AgentStatus = "available" | "busy" | "away";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  available: "זמין",
  busy: "בשיחה אחרת",
  away: "לא נמצא",
};

export async function getAgentStatus(agent: string): Promise<AgentStatus> {
  try {
    const r = await fetch(`/api/agents/status?agent=${encodeURIComponent(agent)}`);
    if (!r.ok) return "available";
    const j = (await r.json()) as { status?: AgentStatus };
    return j.status ?? "available";
  } catch {
    return "available";
  }
}

export async function getAllStatuses(): Promise<Record<string, AgentStatus>> {
  try {
    const r = await fetch("/api/agents/status");
    if (!r.ok) return {};
    const j = (await r.json()) as { statuses?: Record<string, AgentStatus> };
    return j.statuses ?? {};
  } catch {
    return {};
  }
}

export async function setAgentStatus(agent: string, status: AgentStatus): Promise<boolean> {
  try {
    const r = await fetch("/api/agents/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, status }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
