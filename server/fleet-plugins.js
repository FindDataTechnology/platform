// ── Team plugin materialization (openspec: add-fleet-plugin-declaration) ─────
//
// The bridge between a team's declaration and the profile's patch layer. Three
// rules, all of them the change's own decisions:
//
//   · the declaration lives on the SOURCE TEMPLATE's installed pack manifest —
//     the fleet row keeps `sourceTemplate.packId`, so a later re-bake or pack
//     upgrade is picked up on the next landing instead of being copied;
//   · landing is a RECOMPUTE over every live team (D3): the plan's row set is
//     the whole truth, so a team that drops a plugin loses its row, and a plugin
//     two teams share disappears only when the last one stops declaring it;
//   · archived teams declare nothing — that is how the archive path removes
//     rows without needing its own removal logic.
//
// The file format belongs to `dsh-profile.js` (single author of the patch); this
// module only decides WHAT should be there.

import { computeFleetPluginPlan } from "../lib/fleet-plugin-rows.js";
import { writeFleetPluginRows } from "../dsh-profile.js";

/** One fleet's declaration, read from its template's installed manifest. */
export function declaredPluginsForFleet({ fleet, getInstalledPack }) {
  const fleetId = typeof fleet?.id === "string" ? fleet.id : "";
  const source = fleet?.sourceTemplate;
  const packId = typeof source?.packId === "string" ? source.packId : "";
  // Field name is `id` on purpose: the plan's input shape IS a fleet-like row,
  // and a second name for the same thing is how "computed zero rows" happens
  // silently (caught by the materialization test).
  if (!fleetId) return { id: "", plugins: [] };
  if (!packId) return { id: fleetId, plugins: [] };
  let installed = null;
  try {
    installed = getInstalledPack(packId);
  } catch {
    installed = null;
  }
  // An uninstalled pack leaves the fleet declaring nothing: its team cannot run
  // that pack's skills either, so keeping plugin rows would be the only surviving
  // half of an uninstalled pack.
  const plugins = Array.isArray(installed?.manifest?.plugins) ? installed.manifest.plugins : [];
  return { id: fleetId, plugins };
}

/**
 * Recompute and write the profile's team plugin rows.
 *
 * @param {{
 *   fleets: {id: string, state?: string, sourceTemplate?: {packId?: string}}[],
 *   getInstalledPack: (packId: string) => any,
 *   dirs?: object,
 *   log?: Pick<Console, "warn">
 * }} input
 */
export function materializeFleetPlugins({ fleets = [], getInstalledPack, dirs, log = console } = {}) {
  const live = (Array.isArray(fleets) ? fleets : []).filter((fleet) => fleet && fleet.state !== "archived");
  const declared = live.map((fleet) => declaredPluginsForFleet({ fleet, getInstalledPack }));
  const plan = computeFleetPluginPlan({ fleets: declared });
  for (const blocker of plan.blockers) {
    log.warn(`[fleet-plugins] ${blocker.fleetId || "(no fleet)"}: ${blocker.reason}`);
  }
  const written = writeFleetPluginRows({ dirs, rows: plan.rows });
  return { rows: plan.rows, blockers: plan.blockers, written };
}

/**
 * What the read face shows for one team: the plugins it declares that are also
 * effective in the profile. `fleets` on each row is the full declaring set, so a
 * shared plugin is visible to both teams without pretending there are two copies.
 */
export function fleetPluginView({ fleet, effective = [] }) {
  const declared = new Set((Array.isArray(fleet?.plugins) ? fleet.plugins : []).map((p) => p?.id).filter(Boolean));
  return (Array.isArray(effective) ? effective : [])
    .filter((row) => declared.has(row.id))
    .map((row) => ({ id: row.id, name: row.name, sharedWith: row.fleets.filter((id) => id !== fleet?.id) }));
}

/**
 * The composed read view for one team (3.1): team-declared rows that are also
 * effective, plus the deployment-enabled bundles nobody declared. Pure — the
 * caller supplies the roster and the effective set, so the route stays a
 * three-line composition and the rules stay testable.
 *
 * @param {{
 *   fleetId: string,
 *   declaredPlugins?: {id: string}[],
 *   effective?: {id: string, name: string, fleets: string[]}[],
 *   roster?: {id: string, enabled?: boolean}[]
 * }} input
 */
export function composeFleetPluginView({ fleetId = "", declaredPlugins = [], effective = [], roster = [] } = {}) {
  const team = fleetPluginView({ fleet: { id: fleetId, plugins: declaredPlugins }, effective });
  const teamIds = new Set(team.map((row) => row.id));
  const deployment = (Array.isArray(roster) ? roster : [])
    .filter((bundle) => bundle?.enabled && bundle?.id && !teamIds.has(bundle.id))
    .map((bundle) => ({ id: bundle.id, name: bundle.id, source: "deployment" }));
  return [...team.map((row) => ({ ...row, source: "team" })), ...deployment];
}
