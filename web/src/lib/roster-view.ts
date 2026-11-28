// roster-view.ts — the pure derivations behind AgentRosterView
// (add-agent-roster-management). Kept out of the .tsx so the three states the
// task calls out can be tested without a DOM runner (this package has none;
// the repo's precedent is pure node --test modules under web/src/lib).
//
// The load-bearing distinction is design D7: "usage unavailable" and "zero
// turns" are different facts, and collapsing them into one is the bug this
// file exists to prevent.

export type RosterSource = "pack" | "custom" | "local" | "catalog";

export interface CatalogAgentLike {
  id: string;
  type?: string;
  name?: string;
  packId?: string;
  packName?: string;
  customPreset?: boolean;
  resourceSummary?: { skillCount: number; mcpCount: number; declared: boolean };
}

export interface RosterRow {
  id: string;
  name: string;
  source: RosterSource;
  packName: string | null;
  skillCount: number | null;
  mcpCount: number | null;
}

export const sourceOf = (a: CatalogAgentLike): RosterSource => {
  if (a.type === "agent-local") return "local";
  if (a.customPreset) return "custom";
  if (a.packId) return "pack";
  return "catalog";
};

export function toRow(a: CatalogAgentLike): RosterRow {
  return {
    id: a.id,
    name: a.name || a.id,
    source: sourceOf(a),
    packName: a.packName ?? null,
    skillCount: a.resourceSummary?.skillCount ?? null,
    mcpCount: a.resourceSummary?.mcpCount ?? null,
  };
}

/** Roles the copy action applies to: only a role whose persona this cell owns. */
export const canCopy = (row: RosterRow): boolean => row.source === "pack" || row.source === "custom";

/** Roles the resource-adjust panel applies to: focused roles only. */
export const canAdjust = (row: RosterRow): boolean => row.source === "pack" || row.source === "custom";

/** The built-in local agent is the runtime itself — never hideable. */
export const canHide = (row: RosterRow): boolean => row.source !== "local";

// Three usage states, each a distinct answer (D7):
//   "loading" → not read yet        (render …)
//   "unknown" → the read FAILED     (render 未知 — never 0)
//   "zero"    → read, role unused   (render 未用过)
//   "some"    → read, n turns
export type UsageState =
  | { state: "loading" }
  | { state: "unknown" }
  | { state: "zero" }
  | { state: "some"; turns: number; lastUsedAt: number };

export function usageFor(
  id: string,
  usage: { rows: { agentId: string; turns: number; lastUsedAt: number }[] } | null,
  failed: boolean,
): UsageState {
  if (failed) return { state: "unknown" };
  if (usage == null) return { state: "loading" };
  const row = usage.rows.find((r) => r.agentId === id);
  if (!row || row.turns === 0) return { state: "zero" };
  return { state: "some", turns: row.turns, lastUsedAt: row.lastUsedAt };
}

// ── The hidden list's write algebra ──────────────────────────────────────────
//
// The server stores the COMPLETE set (design D3), so the client's only job is to
// compute the next complete set from the current one. Two operations, both
// pure, both idempotent — which is exactly what makes a retried or multi-tab
// write converge instead of oscillating.

export function addHidden(current: string[], id: string): string[] {
  return current.includes(id) ? current : [...current, id];
}

export function removeHidden(current: string[], id: string): string[] {
  return current.filter((x) => x !== id);
}