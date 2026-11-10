// Layout storage + REST (openspec: layout-configuration). The cell-side
// deployment store (stored → env resolution), the gateway-stamped header layer,
// the user's own tweaks, and the admin/self routes over a fake db: whole-write
// validation, 403 semantics, the restore control's DELETE, and the
// /api/config resolvedLayout payload.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerMiscRoutes } from "../server/routes/misc.js";
import {
  LAYOUT_CONFIG_KEY,
  LAYOUT_TWEAKS_KEY,
  deploymentLayer,
  mergeLayoutConfig,
  resolveForUser,
  userTweaks,
  validateLayoutConfig,
  writeUserTweaks,
} from "../server/layout.js";
import { NAV_SURFACES, SETTINGS_SURFACES, AGENTS_TAB_SURFACES } from "../packages/core/src/lib/surfaces.ts";

const ALL_NAV = NAV_SURFACES.map((s) => s.slug);
// add-agent-builder-workspace 3.1: `blueprints` stays in the registry (stored
// presets keep validating) but the factory presets no longer ship it in nav.
const FACTORY_NAV = ALL_NAV.filter((slug) => slug !== "blueprints");
const ALL_SETTINGS = SETTINGS_SURFACES.map((s) => s.slug);
const _ALL_TABS = AGENTS_TAB_SURFACES.map((s) => s.slug);

function fakeDb(initial = {}) {
  const deployment = new Map(Object.entries(initial.deployment ?? {}));
  const prefs = new Map(Object.entries(initial.prefs ?? {}));
  return {
    isDbReady: () => true,
    getDeploymentConfig: (k) => deployment.get(k) ?? null,
    setDeploymentConfig: (k, v) => deployment.set(k, String(v)),
    getPreference: (k) => prefs.get(k) ?? null,
    setPreference: (k, v) => prefs.set(k, String(v)),
    _deployment: deployment,
    _prefs: prefs,
  };
}

// ── Deployment layer resolution ─────────────────────────────────────────────

test("deployment layer: nothing stored resolves to the factory snapshot", () => {
  const layer = deploymentLayer({ db: fakeDb(), env: {} });
  assert.equal(layer.defaultPreset, null);
  assert.deepEqual(layer.hidden, []);
});

test("deployment layer: stored values win over env", () => {
  const db = fakeDb({
    deployment: {
      [LAYOUT_CONFIG_KEY]: JSON.stringify({ defaultPreset: "simple", rolePresets: { legal: "simple" }, hidden: ["tasks"] }),
    },
  });
  const layer = deploymentLayer({ db, env: { LAYOUT_DEFAULT_PRESET: "standard-snapshot", LAYOUT_HIDDEN: '["apps"]' } });
  assert.equal(layer.defaultPreset, "simple");
  assert.deepEqual(layer.rolePresets, { legal: "simple" });
  assert.deepEqual(layer.hidden, ["tasks"]);
});

test("deployment layer: env seeds when nothing is stored", () => {
  const layer = deploymentLayer({
    db: fakeDb(),
    env: { LAYOUT_DEFAULT_PRESET: "simple", LAYOUT_ROLE_PRESETS: '{"legal":"simple"}', LAYOUT_HIDDEN: '["tasks"]' },
  });
  assert.equal(layer.defaultPreset, "simple");
  assert.deepEqual(layer.rolePresets, { legal: "simple" });
  assert.deepEqual(layer.hidden, ["tasks"]);
});

test("gateway-stamped layer wins over the cell's own store", () => {
  const db = fakeDb({ deployment: { [LAYOUT_CONFIG_KEY]: JSON.stringify({ defaultPreset: "simple" }) } });
  const layer = deploymentLayer({
    db,
    env: {},
    gatewayLayout: { defaultPreset: "standard-snapshot", rolePresets: { legal: "simple" }, hidden: [] },
  });
  assert.equal(layer.defaultPreset, "standard-snapshot");
  assert.deepEqual(layer.rolePresets, { legal: "simple" });
});

test("resolveForUser composes deployment + role + user layers", () => {
  const db = fakeDb({
    deployment: {
      [LAYOUT_CONFIG_KEY]: JSON.stringify({ defaultPreset: "standard-snapshot", rolePresets: { legal: "simple" } }),
    },
  });
  const { layout } = resolveForUser({ db, env: {}, roles: { primary: "legal", secondary: [] } });
  assert.deepEqual(layout.nav, ["chat", "knowledge", "resources", "memory", "agents", "apps"]);
  // `connections` is part of the simple skeleton — business-role users need
  // it to make tools/search work (2026-10-18).
  assert.deepEqual(layout.settings, ["general", "account", "pairing", "connections"]);
});

test("resolveForUser: a role with no preset entry keeps the deployment default", () => {
  const db = fakeDb({ deployment: { [LAYOUT_CONFIG_KEY]: JSON.stringify({ defaultPreset: "standard-snapshot", rolePresets: {} }) } });
  const { layout } = resolveForUser({ db, env: {}, roles: { primary: "screenplay", secondary: [] } });
  assert.deepEqual(layout.nav, FACTORY_NAV);
  assert.deepEqual(layout.settings, ALL_SETTINGS);
  assert.deepEqual(layout.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]); // the five material tabs
});

test("resolveForUser: user tweaks apply on top of the role layer", () => {
  const db = fakeDb({
    prefs: { [`${LAYOUT_TWEAKS_KEY}:u@e.c`]: JSON.stringify({ nav: ["chat", "agents"] }) },
  });
  const { layout } = resolveForUser({ db, env: {}, email: "u@e.c", roles: { primary: "standard", secondary: [] } });
  assert.deepEqual(layout.nav, ["chat", "agents"]);
  // Containers the user did not speak to keep their full set (the factory
  // default — 市场 + 我的, the retired hub slugs stay alias-only).
  assert.deepEqual(layout.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]);
});

test("facts filter admin sections and marketplace tabs server-side", () => {
  const db = fakeDb();
  const { layout } = resolveForUser({
    db,
    env: {},
    roles: { primary: "standard", secondary: [] },
    facts: { authOn: true, isAdmin: false, packMarketplace: false },
  });
  assert.equal(layout.settings.includes("roles"), false);
  assert.equal(layout.settings.includes("branding"), false);
  // unify-material-market: no tab is marketplace-gated; the 智能体 front page
  // degrades in place when a deployment has no market.
  assert.deepEqual(layout.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]);
});

// ── User tweaks ─────────────────────────────────────────────────────────────

test("user tweaks round-trip and reset", () => {
  const db = fakeDb();
  assert.equal(userTweaks({ db }), null);
  writeUserTweaks({ db }, { nav: ["chat"] });
  assert.deepEqual(userTweaks({ db }), { nav: ["chat"] });
  writeUserTweaks({ db }, null);
  assert.equal(userTweaks({ db }), null);
});

test("user tweaks are scoped per identity (one cell, several users)", () => {
  const db = fakeDb();
  writeUserTweaks({ db, email: "alice@example.com" }, { nav: ["chat"] });
  // Bob's read is untouched by Alice's write — the regression the e2e caught.
  assert.equal(userTweaks({ db, email: "bob@example.com" }), null);
  assert.deepEqual(userTweaks({ db, email: "ALICE@example.com" }), { nav: ["chat"] });
  // Bob writes his own; Alice's survives.
  writeUserTweaks({ db, email: "bob@example.com" }, { nav: ["agents"] });
  assert.deepEqual(userTweaks({ db, email: "alice@example.com" }), { nav: ["chat"] });
  assert.deepEqual(userTweaks({ db, email: "bob@example.com" }), { nav: ["agents"] });
});

test("resolveForUser scopes tweaks to the requesting identity", () => {
  const db = fakeDb();
  writeUserTweaks({ db, email: "alice@example.com" }, { nav: ["chat"] });
  const alice = resolveForUser({ db, env: {}, email: "alice@example.com", roles: { primary: "standard", secondary: [] } });
  const bob = resolveForUser({ db, env: {}, email: "bob@example.com", roles: { primary: "standard", secondary: [] } });
  assert.deepEqual(alice.layout.nav, ["chat"]);
  assert.deepEqual(bob.layout.nav, FACTORY_NAV);
});

test("user tweaks degrade bad JSON to null", () => {
  const db = fakeDb({ prefs: { [`${LAYOUT_TWEAKS_KEY}:u@e.c`]: "{not json" } });
  assert.equal(userTweaks({ db, email: "u@e.c" }), null);
});

// ── Config validation ───────────────────────────────────────────────────────

test("validateLayoutConfig accepts a partial patch and rejects bad shapes", () => {
  assert.deepEqual(validateLayoutConfig({ defaultPreset: "simple" }), { ok: true, config: { defaultPreset: "simple" } });
  assert.equal(validateLayoutConfig({ defaultPreset: 5 }).error !== undefined, true);
  assert.equal(validateLayoutConfig({ hidden: "tasks" }).error !== undefined, true);
  assert.equal(validateLayoutConfig({ rolePresets: { legal: 7 } }).error !== undefined, true);
  assert.deepEqual(validateLayoutConfig({ hidden: null }), { ok: true, config: { hidden: [] } });
  assert.deepEqual(validateLayoutConfig({ rolePresets: null }), { ok: true, config: { rolePresets: {} } });
});

test("mergeLayoutConfig patches only the supplied fields", () => {
  const current = { defaultPreset: "simple", rolePresets: { legal: "simple" }, hidden: ["tasks"] };
  const merged = mergeLayoutConfig(current, { hidden: ["apps"] });
  assert.equal(merged.defaultPreset, "simple");
  assert.deepEqual(merged.rolePresets, { legal: "simple" });
  assert.deepEqual(merged.hidden, ["apps"]);
});

// ── Routes ──────────────────────────────────────────────────────────────────

function request(app, path, { method = "GET", body, user } = {}) {
  const server = createServer((req, res) => {
    req.user = user ?? null;
    app(req, res);
  });
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  });
}

function makeApp({ db, authEnabled = true, isAdmin = false }) {
  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    catalog: { getCatalogFor: () => ({ agents: [], apps: [] }) },
    db,
    cron: null,
    authEnabled,
    authMode: authEnabled ? "forward_auth" : "none",
    adminGroups: ["admin"],
    isAdminUser: () => isAdmin,
    requireAdmin: (_req, res) => {
      if (authEnabled && !isAdmin) {
        res.status(403).json({ error: "Admin group required" });
        return false;
      }
      return true;
    },
    ssoEnabled: false,
    AUTH_LOGIN_PATH: "/oauth2/start",
    AUTH_LOGOUT_PATH: "/oauth2/sign_out",
  };
  registerMiscRoutes(ctx);
  return app;
}

test("layout config GET/PUT is admin-gated; non-admin is 403", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: false });
  const get = await request(app, "/api/layout/config", { user: { email: "u@e.c" } });
  assert.equal(get.status, 403);
  const put = await request(app, "/api/layout/config", {
    method: "PUT",
    body: { defaultPreset: "simple" },
    user: { email: "u@e.c" },
  });
  assert.equal(put.status, 403);
  assert.equal(db.getDeploymentConfig(LAYOUT_CONFIG_KEY), null);
});

test("layout config PUT round-trips for an admin and rejects unknown slugs", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: true });
  const put = await request(app, "/api/layout/config", {
    method: "PUT",
    body: { defaultPreset: "simple", hidden: ["tasks"] },
    user: { email: "admin@e.c" },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.defaultPreset, "simple");
  assert.deepEqual(put.json.hidden, ["tasks"]);

  const get = await request(app, "/api/layout/config", { user: { email: "admin@e.c" } });
  assert.equal(get.json.defaultPreset, "simple");

  // An invalid preset document persists nothing.
  const bad = await request(app, "/api/layout/config", {
    method: "PUT",
    body: { presets: { custom: { version: 1, nav: ["not-a-surface"] } } },
    user: { email: "admin@e.c" },
  });
  assert.equal(bad.status, 400);
  const after = await request(app, "/api/layout/config", { user: { email: "admin@e.c" } });
  assert.equal(after.json.defaultPreset, "simple");
});

test("layout preferences are self-service and the DELETE restores the inherited layout", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: false });
  const get = await request(app, "/api/layout/preferences", { user: { email: "u@e.c" } });
  assert.deepEqual(get.json, { tweaks: null });

  const put = await request(app, "/api/layout/preferences", {
    method: "PUT",
    body: { tweaks: { nav: ["chat", "agents"] } },
    user: { email: "u@e.c" },
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.tweaks, { nav: ["chat", "agents"] });

  const del = await request(app, "/api/layout/preferences", { method: "DELETE", user: { email: "u@e.c" } });
  assert.equal(del.status, 200);
  assert.equal(del.json.tweaks, null);
});

test("layout preferences reject a non-object payload", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: false });
  const res = await request(app, "/api/layout/preferences", {
    method: "PUT",
    body: { tweaks: ["chat"] },
    user: { email: "u@e.c" },
  });
  assert.equal(res.status, 400);
});

test("/api/config ships the resolved layout for the requesting user", async () => {
  const db = fakeDb({
    deployment: {
      [LAYOUT_CONFIG_KEY]: JSON.stringify({ defaultPreset: "simple", rolePresets: {} }),
    },
    prefs: { [`${LAYOUT_TWEAKS_KEY}:u@e.c`]: JSON.stringify({ nav: ["chat", "agents"] }) },
  });
  const app = makeApp({ db, isAdmin: false });
  const res = await request(app, "/api/config", { user: { email: "u@e.c" } });
  assert.equal(res.status, 200);
  // Role layer = deployment default (simple), then the user's own narrowing.
  assert.deepEqual(res.json.resolvedLayout.nav, ["chat", "agents"]);
  // `connections` is part of the non-technical skeleton (2026-10-18): the
  // role recipes resolve to `simple`, and those users need the section.
  assert.deepEqual(res.json.resolvedLayout.settings, [
    "general",
    "account",
    "pairing",
    "connections",
  ]);
  // PACK_MARKETPLACE is off in this harness and the tab set is unchanged — the
  // front page carries the degraded state instead of disappearing.
  assert.deepEqual(res.json.resolvedLayout.agentsTabs, ["agents", "tools", "skills", "plugins", "mine"]);
});
