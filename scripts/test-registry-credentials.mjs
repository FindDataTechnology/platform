#!/usr/bin/env node
// ── Registry SSO credentials (registry-sso-credentials, tasks 2–4) ───────────
//
// Proves the per-user market-credential loop at the unit + HTTP layer:
//
//   2.1 migration — user_registry_credentials exists after initDb (idempotent
//       re-run), and an absent row reads as "unconnected".
//   2.2 routes — connection/credential/disconnect cover connected/unconnected/
//       stale states, no response ever carries the token, anonymous hosted
//       writes 401, auth-off writes are allowed (machine owner).
//   2.3 staleness — a 401 tool/result from a registry-origin MCP server marks
//       the credential stale and GET connection reports it.
//   3.1 install — registry-origin entries install with credentialRef (no
//       embedded secret, headers dropped), refuse without a live credential,
//       and still enforce group admission.
//   3.2 injection — writeMcpPatch resolves Authorization from the owner's live
//       credential, omits (with the record intact) when missing/stale/expired,
//       and composes with role gating.
//   4.1 paste — a manually pasted token writes the same row, expiry parsed.
//
//   node scripts/test-registry-credentials.mjs

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import yaml from "js-yaml";

// ── Env before any module import (paths/env are resolved at module load) ────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cred-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "service-token";
delete process.env.REGISTRY_URL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
process.chdir(TMP);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({ mcpServers: [] }));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));
// One registry-origin entry, gated on a group, plus an ungated one.
fs.writeFileSync(path.join(TMP, "registry-groups.json"), JSON.stringify({
  servers: { "fd-report": ["mcp-fd-users"] },
}));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const db = await import("../db.js");
const registryCredentials = await import("../registry-credentials.js");
const extensionStore = await import("../extension-store.js");
const { writeMcpPatch } = await import("../dsh-profile.js");
const { registerAuth } = await import("../server/auth.js");
const { registerRegistryRoutes } = await import("../server/routes/registry.js");
const { registerExtensionRoutes } = await import("../server/routes/extensions.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const bridge = await import("../registry-bridge.js");

// Registry stub: two MCP servers, one group-gated (groups come from the
// registry-groups.json fixture above).
bridge.initRegistryBridge({
  broadcast: () => {},
  fetchImpl: async (url) =>
    url.includes("/api/skills")
      ? { ok: true, status: 200, json: async () => ({ skills: [] }) }
      : url.includes("/api/agents")
        ? { ok: true, status: 200, json: async () => ({ agents: [] }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({
              servers: [
                { path: "/fd-report", display_name: "FD Report", description: "gated", is_enabled: true },
                { path: "/law-bench", display_name: "Law Bench", description: "ungated", is_enabled: true },
              ],
            }),
          },
});
await bridge.refreshRegistry();

await db.initDb();

// A syntactically-valid JWT (the platform only decodes `exp`; nothing verifies
// the signature — the registry does that).
function jwtWithExp(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u", exp: expSeconds })}.signature`;
}
const HOUR = 3600;
const TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 168 * HOUR);
const EXPIRED = jwtWithExp(Math.floor(Date.now() / 1000) - HOUR);

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
        res.on("end", () => {
          // Raw text kept alongside the parse: "the token is never in the
          // response" must be checked against the BYTES, not a field list.
          server.close(() => resolve({ status: res.statusCode, raw: data, body: data ? JSON.parse(data) : null }));
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

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

// Registry-credential routes only need db + auth state.
function registryCtx(overrides = {}) {
  const ctx = baseCtx(overrides);
  registerAuth(ctx);
  ctx.dshUpdateMcpCalls = [];
  ctx.dshUpdateMcp = (overlay, groups, ownerEmail) => {
    ctx.dshUpdateMcpCalls.push({ overlay, groups, ownerEmail });
    return Promise.resolve();
  };
  ctx.runtimeMcpOverlay = {};
  registerRegistryRoutes({ ...ctx, db });
  return ctx;
}

const ADMIN = { "x-forwarded-email": "admin@x.test", "x-forwarded-groups": "admin" };

// ── 2.1 Migration + store ----------------------------------------------------

test("2.1 migration creates user_registry_credentials; re-run is idempotent", async () => {
  const cols = db.getDb().prepare("PRAGMA table_info(user_registry_credentials)").all().map((c) => c.name);
  for (const c of ["email", "token", "expires_at", "stale", "source", "updated_at"]) {
    assert.ok(cols.includes(c), `column ${c} present`);
  }
  const applied = db.getDb().prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  assert.ok(applied.includes(15), "v15 recorded");
  await db.initDb();
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) AS n FROM user_registry_credentials").get().n,
    0,
    "re-running migrations leaves the table alone",
  );
});

test("2.1 unconnected identity has no row and reads as unconnected", async () => {
  assert.equal(db.getRegistryCredential("nobody@x.test"), null);
  const status = registryCredentials.status("nobody@x.test");
  assert.deepEqual(status, {
    connected: false, expiresAt: null, expired: false, stale: false, source: null, updatedAt: null,
  });
});

test("2.1 tokenExpiry decodes a JWT exp and rejects opaque tokens", async () => {
  const exp = Math.floor(Date.now() / 1000) + 168 * HOUR;
  assert.equal(registryCredentials.tokenExpiry(jwtWithExp(exp)), new Date(exp * 1000).toISOString());
  assert.equal(registryCredentials.tokenExpiry("not-a-jwt"), null);
  assert.equal(registryCredentials.tokenExpiry("a.b"), null);
  assert.equal(registryCredentials.tokenExpiry(""), null);
  assert.equal(registryCredentials.tokenExpiry(null), null);
});

// ── 2.2 Routes ---------------------------------------------------------------

test("2.2 unconnected → connect → disconnect lifecycle, token never returned", async () => {
  const ctx = registryCtx();

  const before = await request(ctx.app, "GET", "/api/registry/connection", { headers: ADMIN });
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.equal(before.body.registryUrl, "https://registry.example.test");
  assert.equal(before.body.loginPath, "/login");
  assert.equal(before.body.mint.tokensPath, "/api/tokens/generate");

  // Manual paste (task 4.1) — the same route the mint handoff posts to.
  const posted = await request(ctx.app, "POST", "/api/registry/credential", {
    headers: ADMIN,
    body: { token: TOKEN, source: "paste" },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.connected, true);
  assert.equal(posted.body.source, "paste");
  assert.equal(posted.body.expiresAt, registryCredentials.tokenExpiry(TOKEN));
  assert.equal(posted.raw.includes(TOKEN), false, "token is not echoed back");

  const after = await request(ctx.app, "GET", "/api/registry/connection", { headers: ADMIN });
  assert.equal(after.body.connected, true);
  assert.equal(after.raw.includes(TOKEN), false, "status response carries no token");
  assert.equal(ctx.dshUpdateMcpCalls.length, 1, "storing a credential re-applies the profile");
  assert.equal(ctx.dshUpdateMcpCalls.at(-1).ownerEmail, "admin@x.test");

  const del = await request(ctx.app, "DELETE", "/api/registry/connection", { headers: ADMIN });
  assert.equal(del.status, 200);
  assert.equal(del.body.connected, false);
  assert.equal(ctx.dshUpdateMcpCalls.length, 2, "disconnecting re-applies the profile too");
  assert.equal(db.getRegistryCredential("admin@x.test"), null, "row deleted");
});

test("2.2 hosted mode rejects anonymous reads/writes; auth off uses the machine owner", async () => {
  const hosted = registryCtx();
  for (const [method, p] of [["GET", "/api/registry/connection"], ["POST", "/api/registry/credential"], ["DELETE", "/api/registry/connection"]]) {
    const res = await request(hosted.app, method, p, { body: method === "POST" ? { token: TOKEN } : undefined });
    assert.equal(res.status, 401, `${method} ${p} rejects anonymous`);
  }

  // Auth off (dev/desktop): the machine owner may connect — that is the V0
  // paste path this change must keep working.
  const off = registryCtx({ authEnabled: false });
  const res = await request(off.app, "POST", "/api/registry/credential", { body: { token: TOKEN } });
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  // Keyed by the machine-owner key, and resolved by every null-identity path
  // (status + the writeMcpPatch injection lookup).
  assert.equal(registryCredentials.ownerKey(null), registryCredentials.MACHINE_OWNER_KEY);
  assert.ok(db.getRegistryCredential(registryCredentials.MACHINE_OWNER_KEY), "row keyed by the machine owner");
  assert.equal(registryCredentials.status(null).connected, true);
  assert.equal(registryCredentials.liveToken(null), TOKEN);
  registryCredentials.disconnect(null);
});

test("2.2 rejects a missing/oversized token", async () => {
  const ctx = registryCtx();
  assert.equal((await request(ctx.app, "POST", "/api/registry/credential", { headers: ADMIN, body: {} })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/registry/credential", { headers: ADMIN, body: { token: "  " } })).status, 400);
  assert.equal(
    (await request(ctx.app, "POST", "/api/registry/credential", { headers: ADMIN, body: { token: "x".repeat(8193) } })).status,
    400,
  );
});

test("2.2 an expired token is stored but reported not connected", async () => {
  const ctx = registryCtx();
  const res = await request(ctx.app, "POST", "/api/registry/credential", {
    headers: { "x-forwarded-email": "exp@x.test", "x-forwarded-groups": "" },
    body: { token: EXPIRED },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.expired, true);
  assert.equal(registryCredentials.liveToken("exp@x.test"), null, "expired ⇒ no injection");
  db.deleteRegistryCredential("exp@x.test");
});

test("2.2 an opaque (non-JWT) token without expiry is connected and injectable", async () => {
  const ctx = registryCtx();
  await request(ctx.app, "POST", "/api/registry/credential", {
    headers: { "x-forwarded-email": "byo@x.test", "x-forwarded-groups": "" },
    body: { token: "opaque-personal-token" },
  });
  const status = registryCredentials.status("byo@x.test");
  assert.equal(status.connected, true);
  assert.equal(status.expiresAt, null, "unknown expiry, not expired");
  assert.equal(registryCredentials.liveToken("byo@x.test"), "opaque-personal-token");
  db.deleteRegistryCredential("byo@x.test");
});

// A dsh event layer needs the per-turn translation state createAppContext
// normally supplies (dshToolNames/dshTurnBlocks/sessionCollectors).
function eventsCtx(overrides = {}) {
  const ctx = baseCtx({ broadcast: () => {} , ...overrides });
  ctx.dshSessionId = "session-1";
  ctx.dshCurrentTurnId = null;
  ctx.dshToolNames = new Map();
  ctx.dshTurnBlocks = [];
  ctx.dshTurnError = null;
  ctx.isStreaming = false;
  ctx.ready = {};
  ctx.sessionVersion = 0;
  ctx.sessionCollectors = new Map();
  ctx.planBySession = new Map();
  ctx.runtimeMcpOverlay = {};
  ctx.runtimeOwnerEmail = null;
  ctx.runtimeOwnerGroups = null;
  ctx.dshUpdateMcp = () => Promise.resolve();
  // dsh-events fans tool_end out per-session and refreshes the session list
  // after a turn — no-ops for the staleness assertions here.
  ctx.sendToViewers = () => {};
  ctx.broadcastSessions = async () => {};
  attachDshEvents(ctx);
  return ctx;
}

// ── 2.3 Staleness via the dsh event path -------------------------------------

test("2.3 a 401 tool/result from a registry server marks the credential stale", async () => {
  const email = "stale@x.test";
  registryCredentials.store({ email, token: TOKEN, source: "sso" });
  extensionStore.addMcpServer({
    name: "fd-report",
    config: { url: "https://registry.example.test/fd-report/mcp", credentialRef: "registry" },
  });

  const broadcasts = [];
  const updateCalls = [];
  const ctx = eventsCtx({ broadcast: (m) => broadcasts.push(m) });
  ctx.runtimeOwnerEmail = email;
  ctx.dshUpdateMcp = (_overlay, groups, owner) => { updateCalls.push({ groups, owner }); return Promise.resolve(); };

  const toolEvent = (text) => ({
    method: "session.event",
    params: {
      sessionId: "session-1",
      event: {
        type: "tool/result",
        data: {
          error: true,
          message: { source: { callId: "c1" }, content: [{ toolCallId: "c1", isError: true, content: [{ type: "text", text }] }] },
        },
      },
    },
  });

  // A tool call whose name is NOT an MCP registry server must not touch state.
  ctx.dshToolNames.set("c1", "read_file");
  ctx.handleDshEvent(toolEvent("HTTP 401 Unauthorized"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registryCredentials.status(email).stale, false, "non-MCP tool ignored");
  assert.equal(updateCalls.length, 0);

  // The registry-backed MCP tool: 401 ⇒ stale + re-applied profile + ping.
  ctx.dshToolNames.set("c1", "mcp__fd-report__query");
  ctx.handleDshEvent(toolEvent("HTTP 401 Unauthorized"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registryCredentials.status(email).stale, true, "marked stale");
  assert.equal(registryCredentials.status(email).connected, false);
  assert.equal(registryCredentials.liveToken(email), null, "stale ⇒ no injection");
  assert.equal(broadcasts.some((m) => m.type === "registry_credential_stale"), true, "clients pinged");
  assert.equal(updateCalls.length, 1, "profile re-applied once");

  // A second 401 must not re-apply again (idempotent until re-connect).
  ctx.handleDshEvent(toolEvent("HTTP 401 Unauthorized"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updateCalls.length, 1, "already stale ⇒ no second re-apply");

  // The Store's GET reports the stale state (the re-connect prompt's source).
  const app = registryCtx({ runtimeOwnerEmail: email });
  const res = await request(app.app, "GET", "/api/registry/connection", {
    headers: { "x-forwarded-email": email, "x-forwarded-groups": "" },
  });
  assert.equal(res.body.stale, true);
  assert.equal(res.body.connected, false);
  assert.equal(res.raw.includes(TOKEN), false);

  // Re-connect clears it and the token flows again.
  registryCredentials.store({ email, token: TOKEN });
  assert.equal(registryCredentials.status(email).connected, true);
  assert.equal(registryCredentials.liveToken(email), TOKEN);
  db.deleteRegistryCredential(email);
  extensionStore.removeMcpServer("fd-report");
});

test("2.3 a 401 from a non-registry MCP server leaves credentials alone", async () => {
  const email = "keep@x.test";
  registryCredentials.store({ email, token: TOKEN });
  extensionStore.addMcpServer({ name: "plain-http", config: { url: "https://plain.example/mcp", headers: { Authorization: "Bearer pasted" } } });

  const ctx = eventsCtx();
  ctx.runtimeOwnerEmail = email;
  ctx.dshToolNames.set("c9", "mcp__plain-http__fetch");
  ctx.handleDshEvent({
    method: "session.event",
    params: {
      sessionId: "session-1",
      event: {
        type: "tool/result",
        data: { error: true, message: { source: { callId: "c9" }, content: [{ toolCallId: "c9", isError: true, content: [{ type: "text", text: "401 Unauthorized" }] }] } },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registryCredentials.status(email).stale, false, "pasted-header server is not credential-backed");
  db.deleteRegistryCredential(email);
  extensionStore.removeMcpServer("plain-http");
});

// ── 3.1 Install path ---------------------------------------------------------

function installCtx(overrides = {}) {
  const ctx = baseCtx(overrides);
  registerAuth(ctx);
  ctx.dshUpdateMcpCalls = [];
  ctx.dshUpdateMcp = (_overlay, groups, owner) => { ctx.dshUpdateMcpCalls.push({ groups, owner }); return Promise.resolve(); };
  registerExtensionRoutes({
    ...ctx,
    db,
    extensionStore,
    skillMaterialize: { writeSkill() {}, removeSkill() {} },
    broadcast: () => {},
    bundle: { skills: [], permissions: {} },
    splitPolicy: (raw) => ({ locked: false, permissions: raw ?? null }),
    runtimeMcpOverlay: {},
  });
  return ctx;
}

test("3.1 registry entry with a live credential installs as a credentialRef (no secret)", async () => {
  const ctx = installCtx();
  await request(registryCtx().app, "POST", "/api/registry/credential", { headers: ADMIN, body: { token: TOKEN } });

  const res = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "law-bench", config: { url: "https://registry.example.test/law-bench/mcp", headers: { Authorization: "Bearer <your_token>" } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.config.credentialRef, "registry");
  assert.equal(res.body.config.headers, undefined, "placeholder header dropped");
  const stored = extensionStore.getMcpServer("law-bench");
  assert.deepEqual(stored.config, { url: "https://registry.example.test/law-bench/mcp", credentialRef: "registry" });
  assert.equal(JSON.stringify(stored.config).includes("<your_token>"), false);

  extensionStore.removeMcpServer("law-bench");
  db.deleteRegistryCredential("admin@x.test");
});

test("3.1 registry entry without a live credential is refused with a mappable code", async () => {
  const ctx = installCtx();
  db.deleteRegistryCredential("admin@x.test");
  const res = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "law-bench", config: { url: "https://registry.example.test/law-bench/mcp", headers: { Authorization: "Bearer <your_token>" } } },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "credential-required");
  assert.equal(extensionStore.getMcpServer("law-bench"), null, "nothing installed");

  // A stale credential is not live either.
  registryCredentials.store({ email: "admin@x.test", token: TOKEN });
  registryCredentials.markStale("admin@x.test");
  const stale = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "law-bench", config: { url: "https://registry.example.test/law-bench/mcp" } },
  });
  assert.equal(stale.status, 409, "stale credential refuses the install");
  db.deleteRegistryCredential("admin@x.test");
});

test("3.1 non-registry installs and group admission are unchanged", async () => {
  const ctx = installCtx();
  // Hand-entered config (no catalog match): stored verbatim, headers intact.
  const manual = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "manual-http", config: { url: "https://manual.example/mcp", headers: { Authorization: "Bearer byo" } } },
  });
  assert.equal(manual.status, 200);
  assert.deepEqual(extensionStore.getMcpServer("manual-http").config.headers, { Authorization: "Bearer byo" });

  // Bundled entry (no origin=registry): same.
  const bundled = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "plain-fetch", config: { url: "https://plain.example/mcp" } },
  });
  assert.equal(bundled.status, 200);
  assert.equal(extensionStore.getMcpServer("plain-fetch").config.credentialRef, undefined);

  // Group admission still bites AND composes: a non-member is refused 403 for
  // the gated registry entry even while connected.
  registryCredentials.store({ email: "outsider@x.test", token: TOKEN });
  const outsider = { "x-forwarded-email": "outsider@x.test", "x-forwarded-groups": "admin,team-b" };
  const denied = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: outsider,
    body: { name: "fd-report", config: { url: "https://registry.example.test/fd-report/mcp" } },
  });
  assert.equal(denied.status, 403, "group admission precedes the credential check");

  // A member with a live credential installs it, stamped with requiredGroups.
  const member = { "x-forwarded-email": "member@x.test", "x-forwarded-groups": "admin,mcp-fd-users" };
  registryCredentials.store({ email: "member@x.test", token: TOKEN });
  const ok = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: member,
    body: { name: "fd-report", config: { url: "https://registry.example.test/fd-report/mcp" } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.credentialRef, "registry");
  assert.deepEqual(ok.body.requiredGroups, ["mcp-fd-users"], "both gates applied");

  for (const n of ["manual-http", "plain-fetch", "fd-report"]) extensionStore.removeMcpServer(n);
  db.deleteRegistryCredential("outsider@x.test");
  db.deleteRegistryCredential("member@x.test");
});

// ── 3.2 Effective-profile injection ─────────────────────────────────────────

// The effective MCP profile dsh actually loads: dsh-profile writes
// $DSH_HOME/profiles/<profile>/mcp.patch.yml (DSH_PROFILE defaults to platform).
const PATCH_FILE = path.join(
  process.env.DSH_HOME,
  "profiles",
  process.env.DSH_PROFILE || "platform",
  "mcp.patch.yml",
);

// Every case starts from "no patch on disk": with zero servers writeMcpPatch
// writes no file at all (dsh boots without --patch), so a leftover file from an
// earlier case would read as a server that is not actually there.
async function writePatch(opts) {
  fs.rmSync(PATCH_FILE, { force: true });
  await writeMcpPatch(opts);
}

function patchEntries() {
  if (!fs.existsSync(PATCH_FILE)) return [];
  return yaml.load(fs.readFileSync(PATCH_FILE, "utf8"))[0].insert;
}

function patchEntry(name) {
  return patchEntries().find((e) => e.config.serverName === name);
}

function patchNames() {
  return patchEntries().map((e) => e.config.serverName);
}

test("3.2 injection: live credential → Authorization header, record carries no secret", async () => {
  const email = "inject@x.test";
  registryCredentials.store({ email, token: TOKEN });
  extensionStore.addMcpServer({
    name: "registry-a",
    config: { url: "https://registry.example.test/a/mcp", credentialRef: "registry" },
  });

  await writePatch({ ownerEmail: email });
  assert.ok(patchEntry("registry-a"), "registry server present in the effective profile");
  assert.equal(patchEntry("registry-a").config.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(extensionStore.getMcpServer("registry-a").config, {
    url: "https://registry.example.test/a/mcp", credentialRef: "registry",
  }, "installed record untouched");

  // Refreshed token (re-connect) flows on the next application, no reinstall.
  const FRESH = jwtWithExp(Math.floor(Date.now() / 1000) + 300 * HOUR);
  registryCredentials.store({ email, token: FRESH });
  await writePatch({ ownerEmail: email });
  assert.equal(patchEntry("registry-a").config.headers.Authorization, `Bearer ${FRESH}`);
  assert.ok(extensionStore.getMcpServer("registry-a"), "no reinstall needed");

  extensionStore.removeMcpServer("registry-a");
  db.deleteRegistryCredential(email);
});

test("3.2 missing / stale / expired credential omits the server and keeps the record", async () => {
  const email = "omit@x.test";
  extensionStore.addMcpServer({
    name: "registry-b",
    config: { url: "https://registry.example.test/b/mcp", credentialRef: "registry" },
  });
  // A non-registry server beside it must be unaffected by the omission.
  extensionStore.addMcpServer({ name: "plain-b", config: { url: "https://plain.example/mcp" } });

  const cases = [
    ["absent", () => {}],
    ["stale", () => { registryCredentials.store({ email, token: TOKEN }); registryCredentials.markStale(email); }],
    ["expired", () => { registryCredentials.store({ email, token: EXPIRED }); }],
  ];
  for (const [label, setup] of cases) {
    db.deleteRegistryCredential(email);
    setup();
    await writePatch({ ownerEmail: email });
    assert.equal(patchNames().includes("registry-b"), false, `${label}: omitted`);
    assert.equal(patchNames().includes("plain-b"), true, `${label}: other servers kept`);
    assert.ok(extensionStore.getMcpServer("registry-b"), `${label}: record survives`);
  }

  // Restoring a credential brings it back — same record, no reinstall.
  registryCredentials.store({ email, token: TOKEN });
  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes("registry-b"), true, "returns once a credential is stored");

  for (const n of ["registry-b", "plain-b"]) extensionStore.removeMcpServer(n);
  db.deleteRegistryCredential(email);
});

test("3.2 injection composes with role gating and auth-off owner semantics", async () => {
  const email = "gated@x.test";
  registryCredentials.store({ email, token: TOKEN });
  extensionStore.addMcpServer({
    name: "registry-c",
    config: { url: "https://registry.example.test/c/mcp", credentialRef: "registry" },
    requiredGroups: ["mcp-fd-users"],
  });

  // Live credential but no matching group ⇒ omitted (role filter wins).
  await writePatch({ ownerEmail: email, userGroups: ["team-b"] });
  assert.equal(patchNames().includes("registry-c"), false, "role-gated out");

  // Matching group ⇒ included with the injected header.
  await writePatch({ ownerEmail: email, userGroups: ["mcp-fd-users"] });
  assert.equal(patchEntry("registry-c").config.headers.Authorization, `Bearer ${TOKEN}`);

  // Auth off (no identity): the machine owner's credential cannot resolve a
  // per-user row, so the server is omitted rather than sent unauthenticated.
  await writePatch({ ownerEmail: null, userGroups: null });
  assert.equal(patchNames().includes("registry-c"), false, "no machine credential");

  // …and the machine owner's own pasted credential resolves it.
  registryCredentials.store({ email: null, token: TOKEN });
  await writePatch({ ownerEmail: null, userGroups: null });
  assert.equal(patchNames().includes("registry-c"), true, "machine owner injects");

  extensionStore.removeMcpServer("registry-c");
  db.deleteRegistryCredential(email);
  registryCredentials.disconnect(null);
});

test("3.2 mcp.json servers and non-registry DB rows are untouched by the resolver", async () => {
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({
    mcpServers: { "file-server": { url: "https://file.example/mcp", headers: { Authorization: "Bearer file" } } },
  }));
  await writePatch({ ownerEmail: "nobody@x.test" });
  assert.deepEqual(patchEntry("file-server").config.headers, { Authorization: "Bearer file" });
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
});
