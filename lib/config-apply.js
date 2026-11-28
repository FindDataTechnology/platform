// Config-apply decision (openspec: runtime-config-apply, design D1).
//
// One pure function decides WHICH surface applies a configuration change to a
// running agent runtime, and WHY. The cell bridge (server/agent-session.js,
// server.js) and the runner harness (agent-runner/harness/dsh.js) both consult
// it so the same change is answered the same way on both hosts; each host still
// performs the chosen surface itself (this module has no I/O, no child handle,
// no timers).
//
// The ladder (design D2): a declared live surface wins; a change the runtime can
// only compose at session creation parks for the next blank session; otherwise
// restart. Some dimensions are structurally restart-only (workspace has no
// per-session cwd; an MCP *credential value* change is not delivered by HMR).
//
// Run tests: node --test lib/config-apply.test.js

// Closed surface vocabulary. `restart:<why>` carries the dimension so an
// operator reading one line knows what forced the respawn.
export const LIVE_SURFACES = Object.freeze({
  model: "live:model/set",
  preset: "live:preset/set-park", // park-to-next-session; applied at creation
  mcpHotswap: "live:mcp-hotswap", // cordis watches the mcp patch and swaps dsh-mcp-client
  tools: "live:tools/set",
  plugins: "live:plugins/set_enabled",
});

// Dimensions that always restart, with the reason token that names why.
const RESTART_ONLY = Object.freeze({
  workspace: "restart:cwd", // no per-session working directory exists
  skills: "restart:skills", // skills patch not verified hot-swappable; conservative
  "mcp-credential": "restart:mcp-credential", // HMR does not deliver header-value changes
});

// Live-capable dimensions → the capability that must be declared, the live
// surface, and the restart reason when that capability is absent.
const LIVE_LADDER = Object.freeze({
  model: { method: "model/set", surface: LIVE_SURFACES.model, restart: "restart:model" },
  effort: { method: "model/set", surface: LIVE_SURFACES.model, restart: "restart:effort" },
  // Persona park requires MORE than `preset/set` being declared: the runtime must
  // compose the target persona's FULL face (MCP tool face via `byPreset` AND the
  // skills face) at session creation. The cell shares one process-level skills
  // patch, so a parked persona there would inherit the boot persona's skills — a
  // capability leak — and it therefore does NOT declare `persona-parkable`. The
  // runner materializes a per-member home (own skills root), so it can. Same
  // ladder, different capability input (design D3; spec R5).
  preset: { method: "persona-parkable", surface: LIVE_SURFACES.preset, restart: "restart:preset" },
  // MCP server-SET changes hot-swap through cordis' watcher on the mcp patch
  // (server.js dshUpdateMcp, PLATFORM_MCP_HOTSWAP). A credential VALUE change
  // does not (see RESTART_ONLY above).
  "mcp-composition": { method: "mcp-hotswap", surface: LIVE_SURFACES.mcpHotswap, restart: "restart:mcp-composition" },
  "mcp-availability": { method: "tools/set", surface: LIVE_SURFACES.tools, restart: "restart:mcp-availability" },
  plugins: { method: "plugins/set_enabled", surface: LIVE_SURFACES.plugins, restart: "restart:plugins" },
});

// Reason tokens (stable; surfaced in the evidence line, design D6).
export const REASONS = Object.freeze({
  capabilityDeclared: "capability-declared",
  capabilityAbsent: "capability-absent",
  restartOnly: "structurally-restart-only",
  unknown: "unknown-dimension",
});

/** Normalize a capability declaration (array of names, or an object of
 *  name→truthy) into a membership test. Tolerant by design: a missing or odd
 *  capability document means "declares nothing", not an error. */
function capabilitySet(capabilities) {
  const set = new Set();
  if (Array.isArray(capabilities)) {
    for (const c of capabilities) if (typeof c === "string") set.add(c);
  } else if (capabilities && typeof capabilities === "object") {
    for (const [k, v] of Object.entries(capabilities)) if (v) set.add(k);
  }
  return set;
}

/**
 * Decide how a configuration change reaches a running runtime.
 * @param {object} opts
 * @param {string} opts.dimension  one of: model | effort | preset | mcp-composition |
 *                                 mcp-availability | mcp-credential | plugins | skills | workspace
 * @param {string[]|Record<string,boolean>} [opts.capabilities]  declared live surfaces
 * @param {object} [opts.current]  reserved (streaming/hasTurns guards are applied by
 *                                 the host BEFORE calling decide; not used here)
 * @returns {{ surface: string, reason: string, live: boolean }}
 */
export function decide({ dimension, capabilities = [], current = {} } = {}) {
  void current; // reserved; the host owns the pre-apply guards

  if (Object.prototype.hasOwnProperty.call(RESTART_ONLY, dimension)) {
    const surface = RESTART_ONLY[dimension];
    return { surface, reason: REASONS.restartOnly, live: false };
  }

  const rule = LIVE_LADDER[dimension];
  if (!rule) {
    // Graceful, never throw: an unrecognized dimension restarts, and says so.
    return { surface: `restart:${dimension || "unknown"}`, reason: REASONS.unknown, live: false };
  }

  if (capabilitySet(capabilities).has(rule.method)) {
    return { surface: rule.surface, reason: REASONS.capabilityDeclared, live: true };
  }
  return { surface: rule.restart, reason: REASONS.capabilityAbsent, live: false };
}

/** True when the chosen surface applies the change without respawning. */
export function isLive(surface) {
  return typeof surface === "string" && surface.startsWith("live:");
}

/** Assemble a host's declared capability set for `decide()` from its bridge.
 *  `personaParkable` is a HOST property, not a bridge method: true only where the
 *  runtime can compose a persona's full face (tools + skills) per session — the
 *  runner (per-member homes), not the cell (shared skills patch, design D3).
 *  `mcpHotswap` mirrors PLATFORM_MCP_HOTSWAP. Defaults are the safe values. */
export function capabilitiesFor(bridge, { personaParkable = false, mcpHotswap = false } = {}) {
  const caps = [];
  const has = (m) => bridge?.hasLiveMethod?.(m) === true;
  for (const m of ["model/set", "preset/set", "tools/set", "plugins/set_enabled"]) {
    if (has(m)) caps.push(m);
  }
  if (personaParkable) caps.push("persona-parkable");
  if (mcpHotswap) caps.push("mcp-hotswap");
  return caps;
}
