// ── Cell MCP budget (enable-constructor-skill-authoring / D8 ④ 容量面) ──────
//
// Why this exists: a cell's dsh child initialises its MCP servers SERIALLY and
// with a hard 60s budget. Nothing caps how many a cell may accumulate, and the
// only symptom when the budget is blown is:
//
//   /api/ready → {"ready":false,"dshInitError":"initialize timed out after 60000ms …"}
//   every fleet turn → error_kind "runtime_not_ready"
//
// Live evidence 2026-11-08: the owner cell had 41 packs installed → 32 MCP
// servers → init timed out → the WHOLE cell was unreachable and every fleet's
// rounds were skipped, with nothing anywhere pointing at "too many servers".
// The healthy comparison cell carried 15. Diagnosis took hours because the
// failure message names the timeout, not the cause.
//
// So the install face gets a budget: project the union of MCP server names the
// cell would carry after this install, and warn (soft) or refuse (hard) with a
// message that names the real cause.
//
// Pure arithmetic over manifests already in hand — no db, no IO, no caching, so
// it is trivially testable and cannot itself become a source of drift.

export const DEFAULT_MCP_SOFT_LIMIT = 22;
export const DEFAULT_MCP_HARD_LIMIT = 30;

/** Every distinct `registryName` a manifest declares. Shape-tolerant. */
export function mcpNamesOf(manifest) {
  const out = new Set();
  const servers = Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [];
  for (const s of servers) {
    if (typeof s?.registryName === "string" && s.registryName.trim()) out.add(s.registryName.trim());
  }
  return out;
}

/**
 * The union of MCP server names after installing `incoming` on top of
 * `existingManifests`. Overlapping references (the common case — fleet-architect
 * and facet-market are shared by many packs) count ONCE, because that is what
 * the profile patch materialises.
 */
export function projectedMcpNames(existingManifests, incomingManifest) {
  const union = new Set();
  for (const m of Array.isArray(existingManifests) ? existingManifests : []) {
    for (const n of mcpNamesOf(m)) union.add(n);
  }
  for (const n of mcpNamesOf(incomingManifest)) union.add(n);
  return union;
}

function limitsOf(env = {}) {
  const soft = Number(env.CELL_MCP_SOFT_LIMIT);
  const hard = Number(env.CELL_MCP_HARD_LIMIT);
  const softLimit = Number.isFinite(soft) && soft > 0 ? soft : DEFAULT_MCP_SOFT_LIMIT;
  const hardLimit = Number.isFinite(hard) && hard > 0 ? hard : DEFAULT_MCP_HARD_LIMIT;
  return { softLimit, hardLimit: Math.max(hardLimit, softLimit) };
}

/**
 * Decide what the install face should do.
 *
 * @returns {{level: "ok"|"soft"|"hard", ok: boolean, count: number,
 *            added: string[], softLimit: number, hardLimit: number,
 *            message: string|null}}
 *   `ok:false` only at "hard" — soft is advisory by design: a cell already past
 *   the soft limit must still be able to install the pack that would let its
 *   owner remove others (refusing everything would strand it).
 */
export function mcpBudgetCheck({ existingManifests = [], incomingManifest = null, env = {} } = {}) {
  const { softLimit, hardLimit } = limitsOf(env);
  const before = projectedMcpNames(existingManifests, null);
  const after = projectedMcpNames(existingManifests, incomingManifest);
  const added = [...after].filter((n) => !before.has(n));
  const count = after.size;

  const base = { count, added, softLimit, hardLimit };
  if (count > hardLimit) {
    return {
      ...base,
      level: "hard",
      ok: false,
      message:
        `installing this pack would leave the cell carrying ${count} MCP servers `
        + `(limit ${hardLimit}, adding ${added.length ? added.join(", ") : "none"}). `
        + `dsh initialises them serially inside a 60s budget — past this point the whole `
        + `cell fails to start and EVERY fleet on it stops running, reporting only `
        + `"initialize timed out". Uninstall unused packs first (each uninstall frees its references).`,
    };
  }
  if (count > softLimit) {
    return {
      ...base,
      level: "soft",
      ok: true,
      message:
        `this cell now carries ${count} MCP servers (soft limit ${softLimit}). `
        + `There is a hard ceiling near ${hardLimit}: past it dsh init exceeds 60s and the `
        + `cell stops starting entirely. Consider uninstalling packs you no longer use.`,
    };
  }
  return { ...base, level: "ok", ok: true, message: null };
}
