// ── Fleet plugin plan (openspec: add-fleet-plugin-declaration, task 2.1) ─────
//
// The materialization is RECOMPUTED, never appended (design D3): every landing
// derives the whole set of plugin rows the declaring teams need, so a team that
// drops a plugin loses its row and a team that keeps one keeps it.
//
// Two facts drive the shape:
//
//   · one baked plugin = ONE row. Two teams declaring the same plugin share the
//     row (no duplicate load, no double cost) — so removal is per-plugin and
//     depends on "does anyone still declare it", not on which team archived.
//   · declarations are per team, rows are per profile. A cell's profile is
//     shared, so a row is visible to every team in that cell; the ledger says
//     WHICH teams asked for it, which is what the read face shows and what
//     keeps an archive from removing a row a neighbour still needs.
//
// Pure: no filesystem, no runtime. The writer (`dsh-profile.js`) and the read
// face (`server/fleet-plugins.js`) both take their plan from here, so the two
// can never disagree about what a declaration set means.

/**
 * @param {{fleets: {id: string, plugins?: {id: string, version?: string}[]}[]}} input
 * @returns {{
 *   rows: {id: string, name: string, fleets: string[]}[],
 *   blockers: {fleetId: string, pluginId: string|null, reason: string}[],
 *   declaredBy: Map<string, string[]>
 * }}
 */
export function computeFleetPluginPlan({ fleets = [] } = {}) {
  const blockers = [];
  const declaredBy = new Map();

  for (const fleet of fleets) {
    const fleetId = typeof fleet?.id === "string" ? fleet.id.trim() : "";
    if (!fleetId) {
      blockers.push({ fleetId: "", pluginId: null, reason: "fleet without an id cannot declare plugins" });
      continue;
    }
    const declared = Array.isArray(fleet?.plugins) ? fleet.plugins : [];
    for (const entry of declared) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id) {
        blockers.push({ fleetId, pluginId: null, reason: "plugin reference without a valid id" });
        continue;
      }
      const list = declaredBy.get(id) ?? [];
      list.push(fleetId);
      declaredBy.set(id, list);
    }
  }

  // One row per plugin id, fleet list de-duplicated and sorted so the written
  // file is byte-stable for a given declaration set (idempotency is a diff, not
  // a hope).
  const rows = [...declaredBy.keys()].sort().map((id) => ({
    id,
    // A loader entry names the package it loads; for a baked plugin the id IS
    // the package name.
    name: id,
    fleets: [...new Set(declaredBy.get(id))].sort(),
  }));

  return { rows, blockers, declaredBy };
}

/**
 * Which previously-managed rows must go: everything the ledger knows about that
 * the new plan does not contain. `null` (unknown ledger) removes nothing, so a
 * first run on an existing profile never guesses.
 *
 * @param {{managedIds: string[]|null, rows: {id: string}[]}} input
 * @returns {string[]}
 */
export function rowsToRemove({ managedIds = null, rows = [] } = {}) {
  if (!Array.isArray(managedIds)) return [];
  const keep = new Set(rows.map((row) => row.id));
  return managedIds.filter((id) => !keep.has(id)).sort();
}

/** The ledger doc this plan implies (id → declaring fleets, stable order). */
export function ledgerFromPlan({ rows = [] } = {}) {
  const plugins = {};
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    plugins[row.id] = { name: row.name, fleets: [...row.fleets] };
  }
  return { version: 1, plugins };
}

/**
 * Rows this plan would leave in the profile, for the read face: only rows the
 * ledger still accounts for count as "effective", so a hand-edited patch row
 * that no team declared is not reported as a team plugin.
 */
export function effectiveRows({ patchRows = [], ledger = null } = {}) {
  const known = ledger?.plugins && typeof ledger.plugins === "object" ? ledger.plugins : {};
  const present = new Set();
  for (const row of patchRows) {
    if (row && typeof row === "object") present.add(row.id ?? row.name);
  }
  const out = [];
  for (const [id, entry] of Object.entries(known)) {
    if (!present.has(id)) continue;
    out.push({ id, name: entry?.name ?? id, fleets: Array.isArray(entry?.fleets) ? [...entry.fleets] : [] });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
