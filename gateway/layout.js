// Gateway-side layout store (openspec: layout-configuration, design D3). Same
// shape and rationale as gateway/roles.js: the hosting gateway owns the
// deployment-level layout document — the default preset, the per-role preset
// map, and the terminal hidden list — answers /api/layout/config itself before
// the cell-proxy catch-all, and ships the same layer to cells through the
// signed identity channel (x-forwarded-layout) so a cell can resolve the
// user's final layout locally alongside their own tweaks.
//
// The preset catalog in v1 is the factory set (standard-snapshot, simple):
// the operator CHOOSES among presets, it does not author them. An unknown slug
// (hand-edited file, a preset a later version removed) degrades to the factory
// default rather than erroring — a stale reference must not blank the UI.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJsonSync } from "../lib/persistence.js";
import {
  FACTORY_PRESET_SLUG,
  parseHiddenSource,
  presetBySlugOrFactory,
  validateLanding,
} from "../packages/core/src/lib/surfaces.ts";

// Read-side degradation for a hand-edited file: an invalid landing reads as
// "not configured" (warned) rather than erroring. Writing one is rejected at
// `set()`, so this only covers files edited behind the app's back.
function validLandingOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = validateLanding(value);
  if (!result.ok) {
    console.warn(`[layout] ignoring invalid landing (${result.error})`);
    return null;
  }
  return result.landing;
}

function parseLandingMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [role, value] of Object.entries(raw)) {
    const landing = validLandingOrNull(value);
    if (landing) out[role] = landing;
  }
  return out;
}

export function createLayoutStore({ file, env = process.env }) {
  let doc = { defaultPreset: null, rolePresets: {}, hidden: [], defaultLanding: null, roleLandings: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.defaultPreset === "string") doc.defaultPreset = parsed.defaultPreset;
      if (parsed.rolePresets && typeof parsed.rolePresets === "object" && !Array.isArray(parsed.rolePresets)) {
        doc.rolePresets = { ...parsed.rolePresets };
      }
      const hidden = parseHiddenSource(parsed.hidden);
      if (hidden) doc.hidden = hidden;
      doc.defaultLanding = validLandingOrNull(parsed.defaultLanding);
      doc.roleLandings = parseLandingMap(parsed.roleLandings);
    }
  } catch {
    // Missing or unreadable file = empty store, not an error.
  }

  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* dir may exist */
    }
    atomicWriteJsonSync(file, {
      defaultPreset: doc.defaultPreset,
      rolePresets: doc.rolePresets,
      hidden: doc.hidden,
      defaultLanding: doc.defaultLanding,
      roleLandings: doc.roleLandings,
    });
  };

  return {
    file,
    // The deployment layer as the resolver consumes it.
    layer() {
      return {
        preset: presetBySlugOrFactory(doc.defaultPreset),
        hidden: doc.hidden,
        landing: doc.defaultLanding,
      };
    },
    // The stored document, plus env seeding filled in where nothing is stored
    // (stored values win, matching the branding resolution order).
    config() {
      const envDefaults = this.envDefaults();
      return {
        defaultPreset: doc.defaultPreset ?? envDefaults.defaultPreset ?? FACTORY_PRESET_SLUG,
        rolePresets: Object.keys(doc.rolePresets).length ? { ...doc.rolePresets } : envDefaults.rolePresets,
        hidden: doc.hidden.length ? [...doc.hidden] : envDefaults.hidden,
        defaultLanding: doc.defaultLanding ?? envDefaults.defaultLanding,
        roleLandings: Object.keys(doc.roleLandings).length ? { ...doc.roleLandings } : envDefaults.roleLandings,
      };
    },
    // Partial patch merged onto the stored document. Validates every field;
    // returns { ok } or { error } — the route maps errors to 4xx and nothing is
    // persisted on error.
    set(value) {
      const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const next = {
        defaultPreset: doc.defaultPreset,
        rolePresets: { ...doc.rolePresets },
        hidden: [...doc.hidden],
        defaultLanding: doc.defaultLanding,
        roleLandings: { ...doc.roleLandings },
      };

      if (body.defaultPreset !== undefined) {
        if (body.defaultPreset === null) next.defaultPreset = null;
        else if (typeof body.defaultPreset === "string") next.defaultPreset = body.defaultPreset;
        else return { error: "defaultPreset must be a string or null" };
      }

      if (body.rolePresets !== undefined) {
        const rp = body.rolePresets;
        if (rp === null) next.rolePresets = {};
        else if (rp && typeof rp === "object" && !Array.isArray(rp)) {
          for (const [role, slug] of Object.entries(rp)) {
            if (typeof slug !== "string") return { error: `rolePresets.${role} must be a string` };
          }
          next.rolePresets = { ...rp };
        } else {
          return { error: "rolePresets must be an object or null" };
        }
      }

      if (body.hidden !== undefined) {
        if (body.hidden === null) next.hidden = [];
        else {
          const hidden = parseHiddenSource(body.hidden);
          if (!hidden) return { error: "hidden must be an array of slugs" };
          next.hidden = hidden;
        }
      }

      if (body.defaultLanding !== undefined) {
        if (body.defaultLanding === null) next.defaultLanding = null;
        else {
          const result = validateLanding(body.defaultLanding);
          if (!result.ok) return { error: `defaultLanding: ${result.error}` };
          next.defaultLanding = result.landing;
        }
      }

      if (body.roleLandings !== undefined) {
        if (body.roleLandings === null) next.roleLandings = {};
        else if (body.roleLandings && typeof body.roleLandings === "object" && !Array.isArray(body.roleLandings)) {
          const landings = {};
          for (const [role, value] of Object.entries(body.roleLandings)) {
            const result = validateLanding(value);
            if (!result.ok) return { error: `roleLandings.${role}: ${result.error}` };
            landings[role] = result.landing;
          }
          next.roleLandings = landings;
        } else return { error: "roleLandings must be an object or null" };
      }

      doc = next;
      persist();
      return { ok: true, config: this.config() };
    },
    // Env seeding: LAYOUT_DEFAULT_PRESET / LAYOUT_ROLE_PRESETS (JSON object) /
    // LAYOUT_HIDDEN (JSON array).
    envDefaults() {
      return {
        defaultPreset: (env.LAYOUT_DEFAULT_PRESET || "").trim() || null,
        rolePresets: parseJsonObject(env.LAYOUT_ROLE_PRESETS),
        hidden: parseHiddenSource(env.LAYOUT_HIDDEN) ?? [],
        defaultLanding: validLandingOrNull(env.LAYOUT_DEFAULT_LANDING),
        roleLandings: parseLandingMap(parseJsonObject(env.LAYOUT_ROLE_LANDINGS)),
      };
    },
    // The compact wire shape for the signed header a cell reads. Empty
    // document = no header, and the cell falls through to its own copy.
    headerValue() {
      const config = this.config();
      const isFactoryDefault = config.defaultPreset === FACTORY_PRESET_SLUG;
      // The "nothing configured" test MUST include the landings
      // (add-role-landing-board D4). A deployment that configures ONLY a landing
      // — the first, most common way to use this feature — would otherwise be
      // judged empty, not stamped, and the cell would silently read its own
      // store and land everyone on /chat, with no error anywhere.
      const hasLanding = Boolean(config.defaultLanding) || Object.keys(config.roleLandings).length > 0;
      if (isFactoryDefault && !Object.keys(config.rolePresets).length && !config.hidden.length && !hasLanding) return null;
      return JSON.stringify({
        defaultPreset: config.defaultPreset,
        rolePresets: config.rolePresets,
        hidden: config.hidden,
        defaultLanding: config.defaultLanding,
        roleLandings: config.roleLandings,
      });
    },
  };
}

function parseJsonObject(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    console.warn("[layout] LAYOUT_ROLE_PRESETS is not valid JSON; ignoring");
    return {};
  }
}
