// ── Fleet binding health (enable-constructor-skill-authoring / D8 ③ 观测面) ──
//
// Why this exists: a pack whose MCP reference binds to nothing still installs
// and still reports `installed`, and the only trace of the dead reference is a
// line inside the install report (`pack-store.js` → `awaiting-local-binding`).
// Live evidence 2026-11-08: the optimizer team installed clean, its proposal
// post's `actions-mcp` reference never bound, and the fleet still looked green
// everywhere — the failure only appeared when the post's turn ran.
//
// So the install report is promoted to a fleet-health projection: a fleet whose
// template pack carries unbound references is degraded, and the health face can
// say WHICH reference is dead instead of waiting for a turn to fail.
//
// Deliberately a pure function over the already-loaded install record: no db
// access, no second source of truth, no caching. Callers pass what they already
// read (`dbModule.getInstalledPack(fleet.sourceTemplate.packId)`).

export const UNBOUND_STATUS = "awaiting-local-binding";

/**
 * Summarise the MCP binding state of one installed pack.
 *
 * @param {{report?: object|null}|null} installed  the installed-pack record
 *   (`getInstalledPack(...)`), whose `report` is the install-time snapshot.
 * @returns {{ok: boolean, unbound: string[], bound: string[], awaiting: boolean}}
 *   `ok` is false only when at least one reference is unbound; a pack that was
 *   never installed (null record) reports ok:true with empty lists — absence of
 *   an install record is not evidence of a broken binding.
 */
export function bindingHealth(installed) {
  const servers = Array.isArray(installed?.report?.mcpServers) ? installed.report.mcpServers : [];
  const unbound = [];
  const bound = [];
  for (const entry of servers) {
    const name = typeof entry?.name === "string" ? entry.name : null;
    if (!name) continue;
    if (entry.status === UNBOUND_STATUS) unbound.push(name);
    else bound.push(name);
  }
  return { ok: unbound.length === 0, unbound, bound, awaiting: unbound.length > 0 };
}

/**
 * Fleet-level projection: the unbound references of the fleet's source template
 * pack, or an all-clear. Kept separate from `bindingHealth` so a caller that
 * already holds the report (the overview walk) does not pay for two passes.
 */
export function fleetBindingHealth(fleet, installed) {
  if (!fleet?.sourceTemplate?.packId) {
    // A hand-built fleet has no template pack to bind against; nothing to say.
    return { ok: true, unbound: [], bound: [], awaiting: false, packId: null };
  }
  return { ...bindingHealth(installed), packId: fleet.sourceTemplate.packId };
}
