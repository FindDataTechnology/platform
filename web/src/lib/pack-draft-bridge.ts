// pack-draft-bridge.ts — the one-shot handoff from a preset conversion to the
// pack editor (add-preset-to-pack-bridge, design D6). The conversion report
// rides this module-level slot across the settings-section navigation; it is
// never stored on the draft, shown exactly once, and cleared on take.

export interface BridgePendingSkill {
  name: string;
  reason: "pack" | "unavailable" | string;
  pack?: string;
}

export interface BridgePendingServer {
  name: string;
  reason: "operator" | "local" | "market-gone" | "unavailable" | string;
}

export interface BridgeReport {
  inlinedSkills: string[];
  mcpServers: string[];
  pendingSkills: BridgePendingSkill[];
  pendingServers: BridgePendingServer[];
}

let handoff: { draftId: string; report: BridgeReport } | null = null;

export function stashBridgeHandoff(draftId: string, report: BridgeReport) {
  handoff = { draftId, report };
}

// Peek (tab activation) — does not consume.
export function hasBridgeHandoff() {
  return handoff !== null;
}

// Take (editor open + banner) — consumes; a second mount shows nothing.
export function takeBridgeHandoff() {
  const taken = handoff;
  handoff = null;
  return taken;
}
