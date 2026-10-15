#!/usr/bin/env node
// ── Role-gated extensions (add-role-gated-extensions, tasks 1–5) ─────────────
//
// Proves the Logto-roles access-control loop for MCP/skills end to end at the
// unit + HTTP layer:
//
//   1.1/1.2 storage — a pre-v13 DB migrates losslessly (requiredGroups null);
//       gated installs round-trip requiredGroups through the REST listing.
//   2.1/2.2  auth-off semantics — no identity = machine owner = everything
//       visible (market + agent catalog), matching requireAdmin.
//   3.1–3.3  requireMcpManage — auth off / admin / cell owner pass, shared-mode
//       non-admin 403s; locked bundled servers stay immutable for the owner.
//   4.1/4.2  install admission — gated market entries stamp requiredGroups and
//       reject non-members (MCP + registry skills); auth off installs + stamps.
//   5.1/5.2  runtime filter — writeMcpPatch drops gated rows for group-less
//       users, keeps them for members and for no-identity (auth off) callers;
//       the owner-groups snapshot feeds the boot path.
//
//   node scripts/test-role-gated-extensions.mjs

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import Database from "better-sqlite3";
import yaml from "js-yaml";

// ── Env before any module import (paths/env are resolved at module load) ────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "role-gated-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP; // owner-groups.json lands in the sandbox
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
// Bundled market catalogs + registry groups file are CWD-resolved at import.
process.chdir(TMP);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({
  mcpServers: [
    { name: "plain-fetch", displayName: "Fetch", description: "ungated", category: "X", icon: "box",
      configTemplate: { url: "https://a.example/mcp" } },
  ],
}));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));
fs.writeFileSync(path.join(TMP, "registry-groups.json"), JSON.stringify({
  servers: { "gated-jira": ["mcp-jira-users"] },
  skills: { "pdf-processing": ["team-a"] },
}));
// Registry env so registry-bridge maps groups; fetch is injected below.
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "test-token";
delete process.env.REGISTRY_URL;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A pre-v13 database: migrations 1..12 applied, extension_configs without the
// required_groups column, one legacy row. Built BEFORE initDb — db.js opens
// the file only when initDb runs, so the legacy schema is what it migrates.
function makeLegacyDb() {
  const legacy = new Database(process.env.DB_PATH);
  legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const ins = legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (let v = 1; v <= 12; v++) ins.run(v, new Date().toISOString());
  legacy.exec(`CREATE TABLE extension_configs (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
    config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'user', origin TEXT NOT NULL DEFAULT 'user',
    locked INTEGER NOT NULL DEFAULT 0, permissions TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  legacy.prepare(`INSERT INTO extension_configs (id, name, type, config_json, enabled, created_at, updated_at)
    VALUES ('legacy-1', 'legacy-server', 'mcp', '{}', 1, ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  // v3's custom_skills — this test process reads it via getCustomSkill.
  legacy.exec(`CREATE TABLE custom_skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
    content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  // v1's chat_sessions with the columns v9/v10 (also "applied") added: v22
  // (session ownership) ALTERs and indexes this table, so a legacy DB that
  // claims v1..12 must physically carry it or the migration chain dies with
  // "no such table: chat_sessions" and initDb degrades the whole store.
  legacy.exec(`CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    path TEXT,
    agent_preset TEXT,
    workspace TEXT)`);
  legacy.close();
}

const db = await import("../db.js");
const extensionStore = await import("../extension-store.js");
const { writeMcpPatch } = await import("../dsh-profile.js");
const { registerAuth } = await import("../server/auth.js");
const { registerExtensionRoutes } = await import("../server/routes/extensions.js");
const ownerGroups = await import("../server/owner-groups.js");
const bridge = await import("../registry-bridge.js");
const registryCredentials = await import("../registry-credentials.js");

// Registry stub serving one gated MCP + one gated skill + one registry agent
// (groups come from the registry-groups.json fixture above).
function makeFetch() {
  return async (url) => {
    const body = url.includes("/api/skills")
      ? { skills: [{ id: "s1", name: "pdf-processing", path: "/skills/pdf-processing", description: "PDFs", skill_md_url: "https://x/SKILL.md", is_enabled: true, tags: ["docs"] }], total_count: 1 }
      : url.includes("/api/agents")
        ? { agents: [{ name: "Open Weather", path: "/agents/open-weather", url: "https://registry.example.test/agent/w", is_enabled: true, status: "active", supportedProtocol: "a2a" }] }
        : { servers: [{ path: "/gated-jira", display_name: "Gated Jira", description: "gated", is_enabled: true, health_status: "healthy", status: "active" },
                      { path: "/open-weather", display_name: "Open Weather", description: "ungated", is_enabled: true, health_status: "healthy", status: "active" }], total_count: 2 };
    return { ok: true, status: 200, json: async () => body };
  };
}
bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl: makeFetch() });
await bridge.refreshRegistry();

function request(app, method, p, { headers = {}, body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest({
        host: "127.0.0.1", port, path: p, method,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => { server.close(() => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })); });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

// ── 1.1 Migration ────────────────────────────────────────────────────────────

test("1.1 pre-v13 DB upgrades losslessly to required_groups", async () => {
  makeLegacyDb();
  await db.initDb();
  assert.equal(db.isDbReady(), true);
  const cols = db.getDb().prepare("PRAGMA table_info(extension_configs)").all().map((c) => c.name);
  assert.ok(cols.includes("required_groups"), "v13 column added");
  const legacy = db.getExtensionConfig("legacy-server");
  assert.ok(legacy, "legacy row survives");
  assert.equal(legacy.requiredGroups, null, "legacy row is ungated");
});

test("1.1 requiredGroups round-trips through the store", async () => {
  const row = extensionStore.addMcpServer({ name: "rt-gated", config: { url: "https://jira.example/mcp" }, requiredGroups: ["team-a"] });
  assert.deepEqual(row.requiredGroups, ["team-a"]);
  const plain = extensionStore.addMcpServer({ name: "rt-plain", config: { url: "https://plain.example/mcp" } });
  assert.equal(plain.requiredGroups, null, "default is ungated");
  const listed = extensionStore.listMcpServers();
  assert.deepEqual(listed.find((s) => s.name === "rt-gated").requiredGroups, ["team-a"]);
  assert.equal(listed.find((s) => s.name === "rt-plain").requiredGroups, null);
});

// ── 2.1/2.2 auth-off owner semantics ─────────────────────────────────────────

test("2.1 visibleToUser: member sees gated, non-member doesn't, no identity sees all", async () => {
  const entry = { name: "x", groups: ["team-a"] };
  assert.equal(extensionStore.visibleToUser(entry, { email: "a@b.c", groups: ["team-a"] }), true, "member");
  assert.equal(extensionStore.visibleToUser(entry, { email: "x@y.z", groups: ["team-b"] }), false, "non-member");
  assert.equal(extensionStore.visibleToUser(entry, null), true, "auth off = machine owner");
  assert.equal(extensionStore.visibleToUser({ name: "y" }, null), true, "ungated always visible");
});

test("2.1 integrated market filter honors the owner semantics", async () => {
  const anon = await extensionStore.getMarketCatalog(null);
  assert.ok(anon.mcpServers.some((s) => s.name === "gated-jira"), "auth off sees gated registry entry");
  const outsider = await extensionStore.getMarketCatalog({ email: "x@y.z", groups: ["team-b"] });
  assert.equal(outsider.mcpServers.some((s) => s.name === "gated-jira"), false, "non-member doesn't");
  const member = await extensionStore.getMarketCatalog({ email: "a@b.c", groups: ["mcp-jira-users"] });
  assert.ok(member.mcpServers.some((s) => s.name === "gated-jira"), "member does");
  assert.ok(anon.mcpServers.some((s) => s.name === "open-weather"), "ungated registry entry visible to all");
});

test("2.2 agent catalog: auth off sees role-gated entries", async () => {
  const catalogMod = await import("../catalog.js");
  fs.writeFileSync(path.join(TMP, "registry-groups.json"), JSON.stringify({
    agents: { "agents-open-weather": ["team-a"] },
    servers: { "gated-jira": ["mcp-jira-users"] },
    skills: { "pdf-processing": ["team-a"] },
  }));
  await bridge.refreshRegistry();
  await catalogMod.refresh(null);
  assert.ok(catalogMod.getCatalogFor(null).agents.some((a) => a.id === "registry-agents-open-weather"), "owner sees gated agent");
  assert.equal(catalogMod.getCatalogFor({ email: "x@y.z", groups: ["team-b"] }).agents.some((a) => a.id === "registry-agents-open-weather"), false, "non-member doesn't");
});

test("2.3 regression: auth-off HTTP path — GET /api/extensions/market includes gated registry entry", async () => {
  const app = extensionsCtx({ authEnabled: false });
  const res = await request(app.app, "GET", "/api/extensions/market");
  assert.equal(res.status, 200);
  assert.ok(res.body.mcpServers.some((s) => s.name === "gated-jira"), "auth off (dev/desktop) sees the gated entry");
});

// ── 3.x requireMcpManage ─────────────────────────────────────────────────────

function baseCtx(overrides = {}) {
  return {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: false,
    logtoAuth: null,
    ...overrides,
  };
}

test("3.1 requireMcpManage: four authorization branches", async () => {
  // Express-style chained fake response.
  const mkRes = () => {
    const r = { statusCode: 0 };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = () => r;
    return r;
  };

  // auth off: anyone
  process.env.CELL_USER_EMAIL = "";
  const ctxOff = baseCtx({ authEnabled: false });
  registerAuth(ctxOff);
  assert.equal(ctxOff.requireMcpManage({ user: null }, mkRes()), true, "auth off allows");

  // shared mode, admin
  const ctxShared = baseCtx();
  registerAuth(ctxShared);
  assert.equal(ctxShared.requireMcpManage({ user: { email: "a@x", groups: ["admin"] } }, mkRes()), true, "admin allowed");

  // shared mode, non-admin → 403
  const plainRes = mkRes();
  assert.equal(ctxShared.requireMcpManage({ user: { email: "b@x", groups: [] } }, plainRes), false, "shared non-admin rejected");
  assert.equal(plainRes.statusCode, 403);

  // cell mode, owner (no admin group)
  process.env.CELL_USER_EMAIL = "dave@cell.test";
  const ctxCell = baseCtx({ CLOUD_MODE: true });
  registerAuth(ctxCell);
  assert.equal(ctxCell.requireMcpManage({ user: { email: "dave@cell.test", groups: [] } }, mkRes()), true, "cell owner allowed");
  const otherRes = mkRes();
  assert.equal(ctxCell.requireMcpManage({ user: { email: "eve@cell.test", groups: [] } }, otherRes), false, "non-owner rejected in cell");
  assert.equal(otherRes.statusCode, 403);
  process.env.CELL_USER_EMAIL = "";
});

function extensionsCtx(overrides = {}) {
  const ctx = baseCtx(overrides);
  registerAuth(ctx);
  registerExtensionRoutes({
    ...ctx,
    db,
    extensionStore,
    skillMaterialize: { writeSkill() {}, removeSkill() {} },
    broadcast: () => {},
    bundle: { skills: [], permissions: {} },
    splitPolicy: (raw) => ({ locked: false, permissions: raw ?? null }),
    dshUpdateMcp: null,
    runtimeMcpOverlay: {},
  });
  return ctx;
}

test("3.2/3.3 cell owner manages MCP in their own cell; locked stays immutable", async () => {
  process.env.CELL_USER_EMAIL = "dave@cell.test";
  const ctx = extensionsCtx({ CLOUD_MODE: true });
  const owner = { "x-forwarded-email": "dave@cell.test", "x-forwarded-groups": "" };
  const add = await request(ctx.app, "POST", "/api/extensions/mcp", { headers: owner, body: { name: "owner-added", config: { url: "https://x.example/mcp" } } });
  assert.equal(add.status, 200, "owner (non-admin) can add in own cell");

  // Locked bundled server: seeded locked, owner cannot remove or disable it.
  extensionStore.seedMcpServer({ name: "locked-bundled", config: { url: "https://l.example/mcp" }, locked: true, origin: "bundled" });
  const del = await request(ctx.app, "DELETE", "/api/extensions/mcp/locked-bundled", { headers: owner });
  assert.equal(del.status, 400, "locked server not removable");
  const dis = await request(ctx.app, "PATCH", "/api/extensions/mcp/locked-bundled/enable", { headers: owner, body: { enabled: false } });
  assert.equal(dis.status, 400, "locked server not disable-able");

  // Shared mode: non-admin is still locked out.
  process.env.CELL_USER_EMAIL = "";
  const shared = extensionsCtx();
  const r = await request(shared.app, "POST", "/api/extensions/mcp", { headers: owner, body: { name: "nope", config: { url: "https://x.example/mcp" } } });
  assert.equal(r.status, 403, "shared-mode non-admin 403");
});

// ── 4.x install admission + stamping ─────────────────────────────────────────

test("4.1 gated market MCP: member installs + stamps, non-member 403, auth-off installs + stamps", async () => {
  // Admin headers so requireMcpManage passes in shared mode; admission has no
  // admin bypass by design, so the group checks below still bite.
  const memberHeaders = { "x-forwarded-email": "m@x.test", "x-forwarded-groups": "admin,mcp-jira-users" };
  const outsiderHeaders = { "x-forwarded-email": "o@x.test", "x-forwarded-groups": "admin,team-b" };

  // The fixture entries are registry-origin, so installing one needs a live
  // market credential (registry-sso-credentials) — admitted FIRST, credential
  // SECOND. The member below holds one; the outsider deliberately does not
  // (their 403 must come from admission, not from the credential check).
  registryCredentials.store({ email: "m@x.test", token: "member-token" });

  const memberApp = extensionsCtx();
  const ok = await request(memberApp.app, "POST", "/api/extensions/mcp", {
    headers: memberHeaders,
    body: { name: "gated-jira", config: { url: "https://jira.example/mcp", headers: { Authorization: "Bearer t" } } },
  });
  assert.equal(ok.status, 200, "member installs the gated entry");
  assert.deepEqual(ok.body.requiredGroups, ["mcp-jira-users"], "record carries the stamp");
  assert.equal(ok.body.config.credentialRef, "registry", "and references the market credential");

  // API-level bypass with the SAME name: free the name first, then the
  // outsider's direct POST must be rejected by admission, not by uniqueness.
  extensionStore.removeMcpServer("gated-jira");
  const denied = await request(memberApp.app, "POST", "/api/extensions/mcp", {
    headers: outsiderHeaders,
    body: { name: "gated-jira", config: { url: "https://jira.example/mcp", headers: { Authorization: "Bearer t" } } },
  });
  assert.equal(denied.status, 403, "API-level guess of a gated name is rejected");
  assert.equal(extensionStore.getMcpServer("gated-jira"), null, "no record created");

  // A RENAMED guess no longer matches the catalog entry — it is a
  // hand-entered config, ungated by design (design.md D3).
  const clone = await request(memberApp.app, "POST", "/api/extensions/mcp", {
    headers: outsiderHeaders,
    body: { name: "gated-jira-clone", config: { url: "https://jira.example/mcp", headers: { Authorization: "Bearer t" } } },
  });
  assert.equal(clone.status, 200, "renamed config installs (documented trade-off)");
  assert.equal(clone.body.requiredGroups, null, "hand-entered config carries no stamp");

  // The outsider now connects (still no matching group): an UNGATED registry
  // entry admits them, and the credential requirement is satisfied — the two
  // checks are independent, and only admission is group-sensitive.
  registryCredentials.store({ email: "o@x.test", token: "outsider-token" });
  const ungated = await request(memberApp.app, "POST", "/api/extensions/mcp", {
    headers: outsiderHeaders,
    body: { name: "open-weather", config: { url: "https://w.example/mcp" } },
  });
  assert.equal(ungated.status, 200, "ungated entry installs for anyone");
  assert.equal(ungated.body.requiredGroups, null, "ungated installs carry no stamp");

  const authOff = extensionsCtx({ authEnabled: false });
  // The machine owner pastes their own token (the auth-off credential path).
  registryCredentials.store({ email: null, token: "owner-token" });
  const off = await request(authOff.app, "POST", "/api/extensions/mcp", {
    body: { name: "gated-jira", config: { url: "https://jira2.example/mcp" } },
  });
  assert.equal(off.status, 200, "auth off = machine owner installs freely");
  assert.deepEqual(off.body.requiredGroups, ["mcp-jira-users"], "auth-off install still stamps");
  assert.equal(off.body.config.credentialRef, "registry", "auth-off install references the machine credential");
});

test("4.2 registry skill install enforces group admission", async () => {
  const memberApp = extensionsCtx();
  const denied = await request(memberApp.app, "POST", "/api/extensions/market/skills/pdf-processing/install", {
    headers: { "x-forwarded-email": "o@x.test", "x-forwarded-groups": "team-b" },
  });
  assert.equal(denied.status, 403, "non-member skill install rejected");
  assert.equal(extensionStore.getCustomSkill("pdf-processing"), null, "no skill created");

  // Registry content fetch is stubbed out of scope: the member path would need
  // the content endpoint; admission ordering is what this change guarantees.
});

// ── 5.x runtime filter ───────────────────────────────────────────────────────

async function patchNames(userGroups) {
  const p = await writeMcpPatch({ userGroups });
  const doc = yaml.load(fs.readFileSync(p, "utf8"));
  return doc[0].insert.map((e) => e.config.serverName);
}

test("5.1 writeMcpPatch drops gated rows for non-members only", async () => {
  extensionStore.addMcpServer({ name: "patch-gated", config: { url: "https://g.example/mcp" }, requiredGroups: ["team-a"] });
  extensionStore.addMcpServer({ name: "patch-plain", config: { url: "https://p.example/mcp" } });
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: { "file-server": { url: "https://f.example/mcp" } } }));

  assert.ok((await patchNames(["team-a"])).includes("patch-gated"), "member keeps gated");
  assert.ok((await patchNames(["team-b"])).includes("patch-plain"), "sanity: plain present");
  assert.equal((await patchNames(["team-b"])).includes("patch-gated"), false, "non-member drops gated");
  assert.ok((await patchNames(null)).includes("patch-gated"), "no identity (auth off) keeps gated");
  assert.ok((await patchNames([])).includes("patch-plain"), "empty-groups caller keeps ungated");
  assert.equal((await patchNames([])).includes("patch-gated"), false, "authenticated empty groups drops gated");
  assert.ok((await patchNames(["team-a"])).includes("file-server"), "mcp.json base layer unaffected");
});

test("5.2 revocation lands on the next patch application, record untouched", async () => {
  // Same stamped row, the user's groups changed (role revoked in Logto):
  const before = extensionStore.getMcpServer("patch-gated");
  const after = await patchNames([]); // authenticated, no matching group now
  assert.equal(after.includes("patch-gated"), false, "revoked role removes the server");
  assert.deepEqual(extensionStore.getMcpServer("patch-gated").requiredGroups, before.requiredGroups, "DB record untouched");
  assert.ok((await patchNames(["team-a"])).includes("patch-gated"), "re-granting restores it");
});

test("5.2 owner-groups snapshot feeds the boot path", () => {
  assert.equal(ownerGroups.noteOwnerGroups({ email: "dave@cell.test", groups: ["team-a"] }), true, "first note writes");
  assert.equal(ownerGroups.noteOwnerGroups({ email: "dave@cell.test", groups: ["team-a"] }), false, "unchanged note is a no-op");
  const snap = ownerGroups.readOwnerGroups();
  assert.equal(snap.email, "dave@cell.test");
  assert.deepEqual(snap.groups, ["team-a"]);
  ownerGroups.noteOwnerGroups({ email: "dave@cell.test", groups: [] });
  assert.deepEqual(ownerGroups.readOwnerGroups().groups, [], "revocation updates the snapshot");
});

// ── 1.2 REST exposure ────────────────────────────────────────────────────────

test("1.2 GET /api/extensions/mcp exposes requiredGroups", async () => {
  const app = extensionsCtx();
  const res = await request(app.app, "GET", "/api/extensions/mcp", {
    headers: { "x-forwarded-email": "m@x.test", "x-forwarded-groups": "mcp-jira-users" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.servers.find((s) => s.name === "gated-jira").requiredGroups,
    ["mcp-jira-users"],
    "REST listing carries the stamp (auth-off install)",
  );
  assert.equal(res.body.servers.find((s) => s.name === "gated-jira-clone").requiredGroups, null, "hand-entered row stays null");
});
