// ── Copilot focused-preset resolution (copilot-dock-focused-preset, design D1) ──
//
// Which installed pack is the focused assistant for a line? Resolved by SHAPE,
// never by pack id or name: the shape IS the gate's safety invariant (a
// read-only face on that line's servers), so any pack satisfying it is safe to
// run the copilot on, and one failing it must not be — whatever it is called.
//
//   1. every mcpServers reference declares a non-empty allowTools and no
//      fullSurface marker (an undeclared reference composes the server's whole
//      surface — deriveFullModeToolScope's safety valve — which can never be a
//      focused face);
//   2. the union of allowTools has no gated write tool: the action registry's
//      `tool` set (every line) plus the vendored wire tool_risk keys;
//   3. the referenced servers are a non-empty subset of the line's servers —
//      facet/wanxing from the registry entries' `server`, wire from the
//      tool_risk snapshot (the wire registry entries carry no `server`);
//   4. at least one agent materialized (install report status "installed",
//      the same truth catalog.js projects into the agent picker).
//
// Several candidates → the most recently installed wins; the rest are named
// in a warning so an unexpected pick is explainable. No candidate → null, and
// the dock/embed say "unfocused" instead of pretending (design D5).

import { listActions } from "./action-registry.js";
import { WIRE_TOOL_RISK, WIRE_WRITE_TOOLS } from "./wire-tool-risk.js";

// line id → Set of registry server names that line's tools live on.
export function lineServersFromRegistry() {
  const byLine = new Map();
  for (const action of listActions()) {
    if (!action.line || typeof action.server !== "string" || !action.server) continue;
    if (!byLine.has(action.line)) byLine.set(action.line, new Set());
    byLine.get(action.line).add(action.server);
  }
  const wire = byLine.get("wire") ?? new Set();
  for (const { server } of Object.values(WIRE_TOOL_RISK)) {
    if (typeof server === "string" && server) wire.add(server);
  }
  if (wire.size > 0) byLine.set("wire", wire);
  return byLine;
}

// Every tool name the gate stands in front of, across lines.
export function gatedWriteTools() {
  const out = new Set(WIRE_WRITE_TOOLS);
  for (const action of listActions()) {
    if (typeof action.tool === "string" && action.tool) out.add(action.tool);
  }
  return out;
}

export function resolveCopilotPreset(
  line,
  installedPacks,
  { lineServers = lineServersFromRegistry(), writeTools = gatedWriteTools(), warn = (m) => console.warn(m) } = {},
) {
  const servers = lineServers.get(line);
  if (!servers || servers.size === 0) return null;

  const candidates = [];
  for (const pack of Array.isArray(installedPacks) ? installedPacks : []) {
    const agent = focusedAssistantAgent(pack, servers, writeTools);
    if (agent) candidates.push({ pack, agent });
  }
  if (candidates.length === 0) return null;

  // listInstalledPacks already orders newest first; sort anyway so a caller
  // handing in its own list gets the same pick, with packId as the tiebreak.
  candidates.sort(
    (a, b) =>
      String(b.pack.installedAt ?? "").localeCompare(String(a.pack.installedAt ?? "")) ||
      String(a.pack.packId ?? "").localeCompare(String(b.pack.packId ?? "")),
  );
  const [pick, ...rest] = candidates;
  if (rest.length > 0) {
    const label = (c) => c.pack.name ?? c.pack.packId;
    warn(
      `[copilot-presets] line '${line}': ${candidates.length} focused assistant packs installed; using the most recent '${label(pick)}' (others: ${rest.map(label).join(", ")})`,
    );
  }
  return {
    line,
    agentId: pick.agent.id,
    agentName: pick.agent.name ?? pick.agent.id,
    packId: pick.pack.packId,
    packName: pick.pack.name ?? pick.pack.packId,
  };
}

// The pack's first installed agent when the pack is a focused read-only face
// on exactly this line's servers; null otherwise.
function focusedAssistantAgent(pack, lineServers, writeTools) {
  const refs = pack?.manifest?.mcpServers;
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const touched = new Set();
  for (const ref of refs) {
    const server = typeof ref?.registryName === "string" ? ref.registryName : "";
    if (!server || ref.fullSurface === true) return null;
    const declared = Array.isArray(ref.allowTools)
      ? ref.allowTools.filter((t) => typeof t === "string" && t)
      : [];
    if (declared.length === 0) return null;
    if (!lineServers.has(server)) return null;
    for (const tool of declared) {
      if (writeTools.has(tool)) return null;
    }
    touched.add(server);
  }
  if (touched.size === 0) return null;

  const installed = new Set(
    (pack.report?.agents ?? []).filter((r) => r?.status === "installed").map((r) => r.id),
  );
  for (const agent of pack.manifest?.agents ?? []) {
    if (agent?.id && agent.name && installed.has(agent.id)) return agent;
  }
  return null;
}

// DB-backed entry point for the route. Fail-closed to "no preset" (the dock
// then behaves as before the change) rather than throwing into the handler.
export async function copilotPresetForLine(line) {
  let installed = [];
  try {
    const db = await import("../db.js");
    if (!db.isDbReady()) return null;
    installed = db.listInstalledPacks();
  } catch (err) {
    console.warn(`[copilot-presets] installed packs unavailable: ${err?.message || err}`);
    return null;
  }
  return resolveCopilotPreset(line, installed);
}
