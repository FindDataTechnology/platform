// ── Curated plugin catalogue (unify-material-market) ────────────────────────
//
// The 插件 tab of the 素材市场 renders the operator's CATALOGUE, not the
// deployment's loaded bundle roster: a user must be able to see what exists
// before it is supplied, and then either flip an existing bundle or ask for
// supply. This module owns the catalogue read and the two pure derivations the
// route layer applies — NO express, NO I/O beyond reading the catalogue file.
//
// Spread policy (openspec: dsh-plugin-supply MODIFIED): catalogue membership
// says what MAY be offered. It is NOT a supply declaration — the profile
// template's manifest bundle list plus the dsh install matrix remain the only
// thing that puts a plugin on a deployment. A catalogued plugin absent from
// the live roster is reported as `未供应` and never presented as toggleable.
//
// Three supply states, exactly one per row:
//   enabled    the bundle exists in the live roster and is on
//   available  the bundle exists in the live roster and is off
//   unsupplied the roster does not carry it at all
//
// Request state is never stored here. The route derives it at read time from
// the request rows plus the CURRENT supply state (plugin-supply-request spec:
// "supplied" is derived, never written by hand).

import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../paths.js";
import { SUPPLY_SPECIES_VERSION } from "../facet/supply-catalog.js";
// Curation evidence (add-curation-evidence-gate): the shape/verdict rules live
// in one pure module; this reader only carries the DERIVED state through, the
// same way supply state is derived and never stored.
import { evidenceState } from "../lib/curation-evidence.js";

// The in-repo default catalogue. A deployment overrides it through
// PLUGIN_CATALOG_FILE (docs/ecosystem-curation.md is the authoring runbook).
export function defaultPluginCatalogFile() {
  return repoRoot("packs", "plugin-catalog.json");
}

// Missing / unreadable / invalid JSON is an honest empty catalogue, never a
// boot failure: the tab renders its empty state instead of erroring.
function readCatalogDoc(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The five-locale annotation track, reduced to the two fields the client
// renders. Extra locales an operator added are carried too — the client picks
// by i18n.language and falls back to `en`, so trimming the map would only
// remove reach; entries with nothing to say are dropped.
function normalizeHuman(human) {
  if (!human || typeof human !== "object") return null;
  const out = {};
  for (const [locale, value] of Object.entries(human)) {
    if (!value || typeof value !== "object") continue;
    const track = {};
    if (typeof value.name === "string" && value.name) track.name = value.name;
    if (typeof value.description === "string" && value.description) track.description = value.description;
    if (Object.keys(track).length > 0) out[locale] = track;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// One catalogue row, in the exact shape the client consumes. Optional fields
// are omitted when absent rather than serialized as null: the client's
// `entry.human?.[locale]` fallback chain relies on presence, not truthiness of
// a placeholder. A row without an id is not addressable and is dropped.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const entry = {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    description: typeof raw.description === "string" ? raw.description : "",
  };
  const human = normalizeHuman(raw.human);
  if (human) entry.human = human;
  if (typeof raw.whenToUse === "string" && raw.whenToUse) entry.whenToUse = raw.whenToUse;
  if (typeof raw.licence === "string" && raw.licence) entry.licence = raw.licence;
  if (typeof raw.reviewedAt === "string" && raw.reviewedAt) entry.reviewedAt = raw.reviewedAt;
  // Evidence is carried WHOLE (the gate needs every field to judge), and the
  // derived state rides alongside it. `species` defaults to plugin because this
  // catalogue is the plugin supply surface; an entry may override it.
  if (raw.evidence !== undefined) entry.evidence = raw.evidence;
  if (typeof raw.species === "string" && raw.species) entry.species = raw.species;
  return entry;
}

// The catalogue document: entries plus the version they were authored at (the
// request row records this version, so an operator can tell which catalogue a
// user was looking at when they asked). `version` defaults to the supply
// species version — the v2 bump that introduced the plugin species.
export function loadPluginCatalog({ env = process.env } = {}) {
  const configured = typeof env?.PLUGIN_CATALOG_FILE === "string" ? env.PLUGIN_CATALOG_FILE.trim() : "";
  const file = configured ? path.resolve(configured) : defaultPluginCatalogFile();
  const doc = readCatalogDoc(file);
  const rawPlugins = Array.isArray(doc) ? doc : Array.isArray(doc?.plugins) ? doc.plugins : [];
  const plugins = rawPlugins.map(normalizeEntry).filter(Boolean);
  const version = Number.isInteger(doc?.version) ? doc.version : SUPPLY_SPECIES_VERSION;
  return { version, plugins, file };
}

/**
 * The read face's THIRD dimension (design D2): evidence state, derived per read
 * from the entry's own fields. Kept separate from supply state so "this
 * deployment does not carry it" and "nobody finished reviewing it" can never
 * mask each other.
 *
 * @param {{evidence?: object, species?: string}} entry
 * @param {{today?: string|Date}} [opts]
 */
export function pluginEvidenceState(entry, opts = {}) {
  return evidenceState({ evidence: entry?.evidence, species: entry?.species ?? "plugin" }, opts);
}

export function listPluginCatalog({ env = process.env } = {}) {
  return loadPluginCatalog({ env }).plugins;
}

// Supply state against the roster the deployment ACTUALLY loaded. `entry` may
// be the catalogue row or just its id. The roster is the authority: a bundle
// the child reports is supplied even if the catalogue forgot it.
export function pluginSupplyState(entry, suppliedBundles = []) {
  const id = typeof entry === "string" ? entry : entry?.id;
  if (!id) return "unsupplied";
  const bundle = (suppliedBundles ?? []).find((b) => b && b.id === id);
  if (!bundle) return "unsupplied";
  return bundle.enabled ? "enabled" : "available";
}

// Derive the request state at read time — never a copy stored on the row.
//   no row                          → null (the client omits the field)
//   deployment now supplies it      → "supplied" (the ask landed; supply wins
//                                      even over an earlier decline)
//   otherwise                       → the row's recorded state
// A row can never report "supplied" while the serving deployment lacks the
// plugin, and a hand-edited "supplied" state on an unsupplied plugin is
// rewritten to `requested` rather than trusted.
export function deriveRequestState(row, supplyState) {
  if (!row) return null;
  if (supplyState !== "unsupplied") return "supplied";
  if (row.state === "queued" || row.state === "declined") return row.state;
  return "requested";
}
