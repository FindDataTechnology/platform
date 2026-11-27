// Layout resolution (openspec: layout-configuration). The four-layer narrowing
// chain is the load-bearing contract: factory → deployment → role → user, each
// layer only hiding or reordering what the layer above left, deployment hiding
// terminal, platform predicates absolute. Plus preset validation and the
// dirty-data degradation paths (a stale slug must never blank a container or
// throw).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACTORY_PRESETS,
  FACTORY_PRESET_SLUG,
  NAV_SURFACES,
  SETTINGS_SURFACES,
  AGENTS_TAB_SURFACES,
  factoryPreset,
  parseHiddenSource,
  parsePresetSource,
  predicateAllows,
  registryFor,
  resolveContainer,
  resolveLayout,
  validatePreset,
} from "../packages/core/src/lib/surfaces.ts";

const ALL_NAV = NAV_SURFACES.map((s) => s.slug);
const ALL_SETTINGS = SETTINGS_SURFACES.map((s) => s.slug);
const ALL_TABS = AGENTS_TAB_SURFACES.map((s) => s.slug);

// add-agent-builder-workspace 3.1: the factory nav retires `blueprints` (the
// workspace owns the authoring surface; /blueprints redirects). The registry
// slug STAYS (stored presets + deep links keep validating) — so the factory
// baseline is the registry list minus that one entry, not the raw registry.
const FACTORY_NAV = ALL_NAV.filter((slug) => slug !== "blueprints");

// ── Factory baseline ────────────────────────────────────────────────────────

test("factory preset baseline: nav/settings full; agentsTabs are the five material tabs", () => {
  const p = FACTORY_PRESETS[FACTORY_PRESET_SLUG];
  assert.deepEqual(p.nav, FACTORY_NAV);
  assert.deepEqual(p.settings, ALL_SETTINGS);
  // restructure-yizuo-ia: `/agents` is the single pack doorway with exactly
  // 市场/我的. The retired hub slugs (build/supply/creations/tuning/apps) stay
  // resolvable via SURFACE_SLUG_ALIASES but render no tab.
  assert.deepEqual(p.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]);
  assert.equal(ALL_TABS.includes("apps"), false);
});

test("stored presets referencing legacy agentsTabs slugs degrade safely", () => {
  // Validation still accepts the retired slugs (registry compat)…
  const v = validatePreset({ version: 1, agentsTabs: ["agents", "market", "apps"] });
  assert.equal(v.ok, true);
  // …they canonicalize to their successors (agents→mine, market→market,
  // apps→market), and the user preset's order governs the survivors.
  const r = resolveLayout({
    deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
    user: { preset: { version: 1, agentsTabs: ["agents", "market", "apps"] } },
  });
  // unify-material-market: `agents` is the canonical pack tab again (a real
  // registry slug beats a same-named alias), and `market`/`apps` normalize onto
  // it. The user's list therefore narrows to that single survivor.
  assert.deepEqual(r.agentsTabs, ["agents"]);
});

test("no layers resolves to the registry order", () => {
  const r = resolveLayout({});
  assert.deepEqual(r.nav, ALL_NAV);
  assert.deepEqual(r.settings, ALL_SETTINGS);
  assert.deepEqual(r.agentsTabs, ALL_TABS);
});

test("unknown preset slug falls back to the factory snapshot", () => {
  assert.deepEqual(factoryPreset("nope"), FACTORY_PRESETS[FACTORY_PRESET_SLUG]);
  assert.deepEqual(factoryPreset(undefined), FACTORY_PRESETS[FACTORY_PRESET_SLUG]);
  assert.deepEqual(factoryPreset("simple"), FACTORY_PRESETS.simple);
});

// ── Predicates ──────────────────────────────────────────────────────────────

test("desktop-only surface is dropped when the fact says browser", () => {
  const fleet = NAV_SURFACES.find((s) => s.slug === "fleet");
  assert.equal(predicateAllows(fleet, { isDesktop: false }), false);
  assert.equal(predicateAllows(fleet, { isDesktop: true }), true);
  // Unknown fact leaves it in place (a client that cannot answer keeps it).
  assert.equal(predicateAllows(fleet, {}), true);
  const r = resolveLayout({}, { isDesktop: false });
  assert.equal(r.nav.includes("fleet"), false);
});

test("a preset cannot conjure the fleet into a browser", () => {
  const allWithFleet = { version: 1, nav: ALL_NAV };
  const r = resolveLayout({ deployment: { preset: allWithFleet } }, { isDesktop: false });
  assert.equal(r.nav.includes("fleet"), false);
});

test("no tab is marketplace-gated any more: the front page degrades honestly", () => {
  // unify-material-market: the 智能体 tab is the market's FRONT PAGE, so it must
  // exist even where no marketplace is wired — the panel renders the honest
  // "this deployment carries no marketplace" state instead of vanishing (a
  // vanished first tab opened the surface on 工具 and read as a removed market).
  const front = AGENTS_TAB_SURFACES.find((s) => s.slug === "agents");
  assert.equal(predicateAllows(front, { packMarketplace: false }), true);
  const r = resolveLayout({}, { packMarketplace: false });
  assert.deepEqual(r.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]);
});

test("admin-only section needs an affirmative admin answer when auth is on", () => {
  const branding = SETTINGS_SURFACES.find((s) => s.slug === "branding");
  assert.equal(predicateAllows(branding, { authOn: true, isAdmin: false }), false);
  assert.equal(predicateAllows(branding, { authOn: true, isAdmin: true }), true);
  // Auth off = machine owner sees everything (existing gate semantics).
  assert.equal(predicateAllows(branding, { authOn: false }), true);
  const r = resolveLayout({}, { authOn: true, isAdmin: false });
  assert.equal(r.settings.includes("branding"), false);
  assert.equal(r.settings.includes("roles"), false);
  assert.equal(r.settings.includes("layout"), false);
});

// ── Narrowing chain ─────────────────────────────────────────────────────────

test("role preset narrows within the deployment default", () => {
  const r = resolveLayout({
    deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
    role: { preset: factoryPreset("simple") },
  });
  assert.deepEqual(r.nav, ["chat", "knowledge", "resources", "memory", "agents", "apps"]);
  // `connections` rides in the simple skeleton (2026-10-18); `memory` since
  // add-unified-memory-and-outputs (the panel is a work surface for the same
  // non-technical users the skeleton serves). restructure-yizuo-ia merged the
  // two pairing sections into `pairing`, so the Basics set names it once.
  assert.deepEqual(r.settings, ["general", "account", "pairing", "connections"]);
});

test("no layer can re-reveal what a more general layer hid", () => {
  const r = resolveLayout({
    deployment: { preset: { version: 1, nav: ["chat", "knowledge", "resources", "agents"] } },
    role: { preset: { version: 1, nav: ALL_NAV } }, // tries to bring apps/tasks back
  });
  assert.deepEqual(r.nav, ["chat", "knowledge", "resources", "agents"]);
});

test("deployment hidden list is terminal: no later layer re-reveals", () => {
  const r = resolveLayout({
    deployment: { hidden: ["tasks"] },
    role: { preset: { version: 1, nav: ALL_NAV } },
    user: { preset: { version: 1, nav: ALL_NAV } },
  });
  assert.equal(r.nav.includes("tasks"), false);
});

test("role narrowing composes with a deployment hidden list", () => {
  const r = resolveLayout({
    deployment: { hidden: ["apps"] },
    role: { preset: { version: 1, nav: ["chat", "agents", "tasks"] } },
  });
  assert.deepEqual(r.nav, ["chat", "agents", "tasks"]);
});

// ── Administrators are exempt from role narrowing (admin-layout-exempt) ─────

test("an admin with a business role resolves to the deployment default", () => {
  const layers = {
    deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
    role: { preset: factoryPreset("simple") },
  };
  const admin = resolveLayout(layers, { authOn: true, isAdmin: true });
  assert.deepEqual(admin.nav, FACTORY_NAV); // desktopOnly unknown here → fleet kept (client-owned fact)
  assert.deepEqual(admin.settings, ALL_SETTINGS);
  assert.deepEqual(admin.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]);
  // The same input for a non-admin still narrows to the simple skeleton.
  const user = resolveLayout(layers, { authOn: true, isAdmin: false });
  assert.deepEqual(user.nav, ["chat", "knowledge", "resources", "memory", "agents", "apps"]);
  assert.equal(user.settings.includes("models"), false);
});

test("deployment hiding stays terminal for an exempt admin", () => {
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG), hidden: ["tasks"] },
      role: { preset: factoryPreset("simple") },
    },
    { authOn: true, isAdmin: true },
  );
  assert.equal(r.nav.includes("tasks"), false);
  assert.equal(r.nav.includes("apps"), true);
  assert.equal(r.settings.includes("models"), true);
});

test("auth off keeps role narrowing (local preview / hermetic runs)", () => {
  const r = resolveLayout(
    { deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) }, role: { preset: factoryPreset("simple") } },
    { authOn: false },
  );
  assert.deepEqual(r.nav, ["chat", "knowledge", "resources", "memory", "agents", "apps"]);
});

test("user adjustments still apply on top for an exempt admin", () => {
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
      role: { preset: factoryPreset("simple") },
      user: { preset: { version: 1, nav: ["agents", "chat"] } },
    },
    { authOn: true, isAdmin: true },
  );
  assert.deepEqual(r.nav, ["agents", "chat"]);
});

test("user layer supplies the final relative order (reorder support)", () => {
  const r = resolveLayout({
    user: { preset: { version: 1, nav: ["tasks", "chat", "knowledge", "resources", "agents", "apps"] } },
  });
  assert.deepEqual(r.nav, ["tasks", "chat", "knowledge", "resources", "agents", "apps"]);
  // Everything the user did not list is hidden (their list is the full set).
  assert.equal(r.nav.includes("fleet"), false);
});

test("a preset that would blank a container is ignored", () => {
  const r = resolveLayout({
    deployment: { preset: { version: 1, nav: [] } },
  });
  assert.deepEqual(r.nav, ALL_NAV);
});

test("stale slugs in a layer are ignored, never fatal", () => {
  const r = resolveLayout({
    user: { preset: { version: 1, nav: ["chat", "retired-surface", "agents"] } },
  });
  assert.deepEqual(r.nav, ["chat", "agents"]);
});

test("containers the layer omits are left untouched", () => {
  const r = resolveLayout({ user: { preset: { version: 1, nav: ["chat"] } } });
  assert.deepEqual(r.nav, ["chat"]);
  assert.deepEqual(r.settings, ALL_SETTINGS);
  assert.deepEqual(r.agentsTabs, ALL_TABS);
});

test("resolveContainer applies layers in the documented order", () => {
  const slugs = resolveContainer("nav", {
    deployment: { preset: { version: 1, nav: ["chat", "knowledge", "resources", "agents", "apps"] } },
    role: { preset: { version: 1, nav: ["chat", "knowledge", "resources", "agents"] } },
    user: { preset: { version: 1, nav: ["agents", "chat", "knowledge", "resources"] } },
  });
  assert.deepEqual(slugs, ["agents", "chat", "knowledge", "resources"]);
});

// ── Validation & degradation ────────────────────────────────────────────────

test("validatePreset accepts a partial preset and rejects unknown slugs", () => {
  assert.deepEqual(validatePreset({ version: 1, nav: ["chat"] }), { ok: true, preset: { version: 1, nav: ["chat"] } });
  const bad = validatePreset({ version: 1, settings: ["not-a-section"] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown settings surface/);
  assert.equal(validatePreset(null).ok, false);
  assert.equal(validatePreset([]).ok, false);
  assert.equal(validatePreset({ version: 1, nav: "chat" }).ok, false);
  // A settings slug placed in the nav container is rejected (container mismatch).
  assert.equal(validatePreset({ version: 1, nav: ["general"] }).ok, false);
});

test("parsePresetSource degrades bad input to null", () => {
  assert.equal(parsePresetSource(null), null);
  assert.equal(parsePresetSource(""), null);
  assert.equal(parsePresetSource("{not json"), null);
  assert.equal(parsePresetSource(JSON.stringify({ version: 1, nav: ["bogus"] })), null);
  assert.deepEqual(parsePresetSource(JSON.stringify({ version: 1, nav: ["chat"] })), { version: 1, nav: ["chat"] });
});

test("parseHiddenSource accepts arrays and JSON strings, rejects the rest", () => {
  assert.deepEqual(parseHiddenSource(["tasks"]), ["tasks"]);
  assert.deepEqual(parseHiddenSource('["tasks","apps"]'), ["tasks", "apps"]);
  assert.equal(parseHiddenSource("nope"), null);
  assert.equal(parseHiddenSource("{}"), null);
});

test("registryFor returns the canonical list per container", () => {
  assert.deepEqual(registryFor("nav").map((s) => s.slug), ALL_NAV);
  assert.deepEqual(registryFor("settings").map((s) => s.slug), ALL_SETTINGS);
  assert.deepEqual(registryFor("agentsTabs").map((s) => s.slug), ALL_TABS);
});
