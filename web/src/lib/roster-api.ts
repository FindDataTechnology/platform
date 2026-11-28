// roster-api.ts — typed client for the agent roster management plane
// (add-agent-roster-management). Three calls, no more: the hidden-role
// preference (a complete-set overwrite), the requester's per-agent usage, and
// the merged catalog the roster rows are drawn from.
//
// The hidden set is deliberately NOT a delta. The server stores the complete
// desired list, so a retried or multi-tab write converges; sending "hide X"
// would need a second endpoint and a merge rule on the server for something the
// client already knows the full answer to.

export interface RosterHiddenEntry {
  id: string;
  name: string | null;
  source: "pack" | "custom" | "local" | "catalog" | null;
  packName?: string | null;
  /** false = the id no longer resolves to any catalog entry (departed pack). */
  known: boolean;
}

export interface HiddenDoc {
  hidden: string[];
  entries: RosterHiddenEntry[];
}

export interface AgentUsageRow {
  agentId: string;
  turns: number;
  lastUsedAt: number;
}

export interface AgentUsageDoc {
  windowDays: number;
  rows: AgentUsageRow[];
}

async function json(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error || `${res.status}`;
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

export function fetchHidden(): Promise<HiddenDoc> {
  return fetch("/api/agent/hidden").then(json);
}

/** Store the COMPLETE hidden list (idempotent). */
export function saveHidden(hidden: string[]): Promise<HiddenDoc> {
  return fetch("/api/agent/hidden", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden }),
  }).then(json);
}

export function fetchAgentUsage(days = 7): Promise<AgentUsageDoc> {
  return fetch(`/api/agent/usage?days=${encodeURIComponent(String(days))}`).then(json);
}