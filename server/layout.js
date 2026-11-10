// Cell-side layout resolution (openspec: layout-configuration, design D3).
//
// The server resolves a user's layout once and ships it in /api/config: the
// deployment layer (stored deployment_config → env), the role layer (the
// user's business role → preset map), and the user layer (their stored
// tweaks). Resolution itself is the shared core function, so the web and the
// server cannot drift.
//
// Facts the server owns: authOn / isAdmin (adminOnly sections),
// packMarketplace, documentsEnabled. `desktopOnly` is deliberately NOT
// resolved here — only the client knows whether it is the Electron shell, and
// it keeps applying that predicate at render (the pre-change behavior).

import { recipeFor } from "../packages/core/src/lib/recipes.ts";
import {
  factoryPreset,
  FACTORY_PRESET_SLUG,
  parseHiddenSource,
  parsePresetSource,
  presetBySlugOrFactory,
  resolveLayout,
  validatePreset,
} from "../packages/core/src/lib/surfaces.ts";

export const LAYOUT_CONFIG_KEY = "layout.config";
// The tweaks key is PER USER: the preference table is keyed by key alone
// (per-cell), and a cell may host several identities (the session-ownership
// topology), so the email rides the key. Without an identity (auth off) the
// machine owner's constant stands in.
export const LAYOUT_TWEAKS_KEY = "layout.tweaks";
export function tweaksKeyFor(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized ? `${LAYOUT_TWEAKS_KEY}:${normalized}` : LAYOUT_TWEAKS_KEY;
}
// The header the gateway stamps with the deployment layer (layout-configuration).
// Read at the same trust boundary as the identity headers (server/auth.js).
export const LAYOUT_HEADER = "x-forwarded-layout";

// The deployment layer from this cell's own store, falling back to env. Shape
// mirrors the gateway document's subset the resolver needs.
export function deploymentLayer({ db, env = process.env, gatewayLayout = null }) {
  // The gateway's stamped layer wins when present: assignments are deployment
  // data, and on hosted deployments the gateway is the plane that owns them.
  if (gatewayLayout && typeof gatewayLayout === "object") {
    return {
      defaultPreset: typeof gatewayLayout.defaultPreset === "string" ? gatewayLayout.defaultPreset : null,
      rolePresets: gatewayLayout.rolePresets && typeof gatewayLayout.rolePresets === "object" && !Array.isArray(gatewayLayout.rolePresets)
        ? gatewayLayout.rolePresets
        : {},
      hidden: parseHiddenSource(gatewayLayout.hidden) ?? [],
      presets: {},
    };
  }
  let stored = null;
  if (db?.isDbReady?.()) {
    try {
      const raw = db.getDeploymentConfig(LAYOUT_CONFIG_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      console.warn("[layout] stored layout config is not valid JSON; ignoring");
    }
  }
  const storedDefault = typeof stored?.defaultPreset === "string" ? stored.defaultPreset : null;
  const storedRolePresets =
    stored?.rolePresets && typeof stored.rolePresets === "object" && !Array.isArray(stored.rolePresets)
      ? stored.rolePresets
      : {};
  const storedHidden = parseHiddenSource(stored?.hidden) ?? [];

  const envDefault = (env.LAYOUT_DEFAULT_PRESET || "").trim() || null;
  const envRolePresets = parseEnvObject(env.LAYOUT_ROLE_PRESETS);
  const envHidden = parseHiddenSource(env.LAYOUT_HIDDEN) ?? [];

  return {
    defaultPreset: storedDefault ?? envDefault,
    rolePresets: { ...envRolePresets, ...storedRolePresets },
    hidden: storedHidden.length ? storedHidden : envHidden,
    presets: stored?.presets && typeof stored.presets === "object" && !Array.isArray(stored.presets) ? stored.presets : {},
  };
}

// The platform's curated preset for a role (the recipe's layoutPreset).
function recipePresetFor(role) {
  const recipe = recipeFor(role);
  return recipe?.layoutPreset ?? null;
}

function parseEnvObject(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    console.warn("[layout] LAYOUT_ROLE_PRESETS is not valid JSON; ignoring");
    return {};
  }
}

// The user's stored tweaks: per-container ordered slug lists (their own
// visible set, in their order). Absent = untouched.
export function userTweaks({ db, email = null }) {
  if (!db?.isDbReady?.()) return null;
  try {
    const raw = db.getPreference(tweaksKeyFor(email));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = {};
    const nav = parseHiddenSource(parsed.nav);
    if (nav) out.nav = nav;
    const settings = parseHiddenSource(parsed.settings);
    if (settings) out.settings = settings;
    const agentsTabs = parseHiddenSource(parsed.agentsTabs);
    if (agentsTabs) out.agentsTabs = agentsTabs;
    return Object.keys(out).length ? out : null;
  } catch {
    console.warn("[layout] stored layout tweaks are not valid JSON; ignoring");
    return null;
  }
}

export function writeUserTweaks({ db, email = null }, tweaks) {
  // No preference-delete export exists; an empty document means "unset" on the
  // read path (userTweaks returns null for it), which is the reset semantic.
  const doc = tweaks === null ? {} : tweaks;
  db.setPreference(tweaksKeyFor(email), JSON.stringify(doc));
}

// The preset catalog for validation/registration: factory set plus the
// operator-registered custom presets from the deployment layer.
export function presetCatalog(deployment) {
  return { ...factoryCatalog(), ...(deployment.presets ?? {}) };
}

function factoryCatalog() {
  // The core module owns the factory set; re-export through one helper so the
  // catalog composition lives in one place.
  return Object.fromEntries(
    ["standard-snapshot", "simple"].map((slug) => [slug, factoryPreset(slug)]),
  );
}

// Resolve the layout for a request/connection user. `role` is the resolved
// business role (per role-system); the role layer picks its preset from the
// deployment's role→preset map (defaulting to the deployment default).
export function resolveForUser({ db, env = process.env, roles, facts = {}, gatewayLayout = null, email = null }) {
  const deployment = deploymentLayer({ db, env, gatewayLayout });
  const catalog = presetCatalog(deployment);
  const defaultSlug = deployment.defaultPreset ?? FACTORY_PRESET_SLUG;
  // The role layer's preset, in precedence order: the deployment's per-role map
  // (the admin's explicit choice) first, else the PLATFORM's recipe default for
  // that role (intent-onboarding ships one per business role). A recipe-less
  // role falls through to the deployment default — no role narrowing at all.
  const roleSlug =
    (roles?.primary ? deployment.rolePresets?.[roles.primary] : null) ?? recipePresetFor(roles?.primary);
  const rolePreset = roleSlug ? presetBySlugOrFactory(roleSlug, catalog) : null;
  const tweaks = userTweaks({ db, email });

  const layout = resolveLayout(
    {
      deployment: { preset: presetBySlugOrFactory(defaultSlug, catalog), hidden: deployment.hidden },
      role: rolePreset ? { preset: rolePreset } : undefined,
      user: tweaks ? { preset: { version: 1, ...tweaks } } : undefined,
    },
    // desktopOnly stays unknown here (client-owned fact).
    { authOn: facts.authOn, isAdmin: facts.isAdmin, packMarketplace: facts.packMarketplace, documentsEnabled: facts.documentsEnabled },
  );
  return { layout, deployment, catalog };
}

// Validate a whole deployment-layout document (local editor). Mirrors the
// gateway store's validation so both faces accept the same payload.
export function validateLayoutConfig(value) {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  if (body.defaultPreset !== undefined) {
    if (body.defaultPreset === null) out.defaultPreset = null;
    else if (typeof body.defaultPreset === "string") out.defaultPreset = body.defaultPreset;
    else return { error: "defaultPreset must be a string or null" };
  }
  if (body.rolePresets !== undefined) {
    const rp = body.rolePresets;
    if (rp === null) out.rolePresets = {};
    else if (rp && typeof rp === "object" && !Array.isArray(rp)) {
      for (const [role, slug] of Object.entries(rp)) {
        if (typeof slug !== "string") return { error: `rolePresets.${role} must be a string` };
      }
      out.rolePresets = { ...rp };
    } else return { error: "rolePresets must be an object or null" };
  }
  if (body.hidden !== undefined) {
    if (body.hidden === null) out.hidden = [];
    else {
      const hidden = parseHiddenSource(body.hidden);
      if (!hidden) return { error: "hidden must be an array of slugs" };
      out.hidden = hidden;
    }
  }
  if (body.presets !== undefined) {
    const presets = body.presets;
    if (presets === null) out.presets = {};
    else if (presets && typeof presets === "object" && !Array.isArray(presets)) {
      const validated = {};
      for (const [slug, preset] of Object.entries(presets)) {
        const result = validatePreset(preset);
        if (!result.ok) return { error: `presets.${slug}: ${result.error}` };
        validated[slug] = result.preset;
      }
      out.presets = validated;
    } else return { error: "presets must be an object or null" };
  }
  return { ok: true, config: out };
}

// Merge semantics for the local store: a partial document patches the stored
// one (the gateway store replaces wholesale; this keeps the two faces'
// contracts aligned at the field level the UI actually uses).
export function mergeLayoutConfig(current, patch) {
  return {
    defaultPreset: patch.defaultPreset !== undefined ? patch.defaultPreset : current.defaultPreset ?? null,
    rolePresets: patch.rolePresets !== undefined ? patch.rolePresets : current.rolePresets ?? {},
    hidden: patch.hidden !== undefined ? patch.hidden : current.hidden ?? [],
    presets: patch.presets !== undefined ? patch.presets : current.presets ?? {},
  };
}

export { parsePresetSource };
