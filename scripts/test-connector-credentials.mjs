#!/usr/bin/env node
// ── Connector credentials (add-connector-credentials) ────────────────────────
//
// Proves the connector PAT loop at the unit + HTTP layer, mirroring
// test-registry-credentials.mjs:
//
//   1.1/1.2 — migration creates user_connector_credentials; store → status →
//       disconnect round-trip; 401-invalidate → re-paste recovery; auth-off
//       machine-owner degradation.
//   2.1/2.2 — the credential-refs table dispatches by name, registry forwards
//       byte-for-byte, and the two refs never cross-resolve.
//   2.3/3.2 — writeMcpPatch injects the connector row's Authorization from the
//       owner's PAT, omits it (record intact) when absent/stale, and injects
//       registry and connector rows independently in one pass.
//   2.4     — the overlay addable universe filters ref-carrying rows (mcp.json
//       and DB) by per-ref liveness.
//   2.5     — a 401 tool result from the mcp.json connector row invalidates
//       the PAT exactly once per run; a registry DB row still goes stale the
//       same way; non-ref servers are untouched.
//   4.1     — routes: lifecycle without token echo, anonymous hosted 401,
//       auth-off allowed, oct_ shape gate, and the probe's three verdicts
//       (401 rejects, 5xx/network store, ok stores).
//   4.4     — a client-submitted credentialRef is rejected on POST and PUT.
//
//   node scripts/test-connector-credentials.mjs

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import yaml from "js-yaml";

// ── Env before any module import (paths/env are resolved at module load) ────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-cred-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "service-token";
delete process.env.REGISTRY_URL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
// The connector baseline row points at the local probe stub, so the paste
// route's liveness probe is fully controllable from this file.
let probeStatus = 200;
let probeSawToken = null;
const probeServer = createServer((req, res) => {
  probeSawToken = req.headers.authorization;
  res.statusCode = probeStatus;
  res.end(probeStatus === 401 ? "unauthorized" : "{}");
});
await new Promise((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
const PROBE_URL = `http://127.0.0.1:${probeServer.address().port}/mcp`;
function writeMcpJson(connectorRow = true) {
  const mcpServers = {
    "file-server": { url: "https://file.example/mcp" },
  };
  if (connectorRow) mcpServers.connector = { url: PROBE_URL, credentialRef: "connector" };
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers }));
}
writeMcpJson();
process.chdir(TMP);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({ mcpServers: [] }));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  probeServer.close();
});

const db = await import("../db.js");
const registryCredentials = await import("../registry-credentials.js");
const connectorCredentials = await import("../connector-credentials.js");
const credentialRefs = await import("../credential-refs.js");
const extensionStore = await import("../extension-store.js");
const { writeMcpPatch } = await import("../dsh-profile.js");
const { registerAuth } = await import("../server/auth.js");
const { registerConnectorRoutes } = await import("../server/routes/connector.js");
const { registerExtensionRoutes } = await import("../server/routes/extensions.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const { availableMcpNames } = await import("../server/routes/overlay.js");
const bridge = await import("../registry-bridge.js");

bridge.initRegistryBridge({
  broadcast: () => {},
  fetchImpl: async (url) =>
    url.includes("/api/skills")
      ? { ok: true, status: 200, json: async () => ({ skills: [] }) }
      : url.includes("/api/agents")
        ? { ok: true, status: 200, json: async () => ({ agents: [] }) }
        : { ok: true, status: 200, json: async () => ({ servers: [] }) },
});
await bridge.refreshRegistry();
await db.initDb();

const PAT = `oct_${"a".repeat(32)}`;
function jwtWithExp(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u", exp: expSeconds })}.signature`;
}
const REG_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 168 * 3600);

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

function connectorCtx(overrides = {}) {
  const ctx = baseCtx(overrides);
  registerAuth(ctx);
  ctx.dshUpdateMcpCalls = [];
  ctx.dshUpdateMcp = (overlay, groups, ownerEmail) => {
    ctx.dshUpdateMcpCalls.push({ overlay, groups, ownerEmail });
    return Promise.resolve();
  };
  ctx.runtimeMcpOverlay = {};
  registerConnectorRoutes({ ...ctx, db });
  return ctx;
}

const ADMIN = { "x-forwarded-email": "admin@x.test", "x-forwarded-groups": "admin" };

// ── 1.1 / 1.2 Migration + module ─────────────────────────────────────────────

test("1.1 migration creates user_connector_credentials; re-run is idempotent", async () => {
  const cols = db.getDb().prepare("PRAGMA table_info(user_connector_credentials)").all().map((c) => c.name);
  for (const c of ["email", "token", "stale", "updated_at"]) {
    assert.ok(cols.includes(c), `column ${c} present`);
  }
  await db.initDb();
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) AS n FROM user_connector_credentials").get().n,
    0,
    "re-running migrations leaves the table alone",
  );
});

test("1.2 unconnected identity has no row; store → status → disconnect round-trip", async () => {
  assert.deepEqual(connectorCredentials.status("nobody@x.test"), {
    connected: false, stale: false, updatedAt: null,
  });

  const email = "round@x.test";
  const stored = connectorCredentials.store({ email, token: PAT });
  assert.equal(stored.connected, true);
  assert.equal(stored.stale, false);
  assert.ok(stored.updatedAt);
  assert.equal(connectorCredentials.liveToken(email), PAT);

  // 401 invalidation keeps the row (re-paste prompt) and kills injection…
  assert.equal(connectorCredentials.markInvalid(email), true);
  assert.equal(connectorCredentials.status(email).stale, true);
  assert.equal(connectorCredentials.status(email).connected, false);
  assert.equal(connectorCredentials.liveToken(email), null);
  // …exactly once; a second mark is a no-op…
  assert.equal(connectorCredentials.markInvalid(email), false);
  // …and re-pasting recovers without disconnect.
  connectorCredentials.store({ email, token: `oct_${"b".repeat(32)}` });
  assert.equal(connectorCredentials.status(email).connected, true);

  assert.equal(connectorCredentials.disconnect(email), true);
  assert.equal(db.getConnectorCredential(email), null, "row deleted");
  assert.equal(connectorCredentials.disconnect(email), false, "second disconnect is a no-op");
});

test("1.2 auth off degrades to the machine owner (shared keying with registry)", async () => {
  connectorCredentials.store({ email: null, token: PAT });
  assert.equal(connectorCredentials.ownerKey(null), connectorCredentials.MACHINE_OWNER_KEY);
  assert.ok(db.getConnectorCredential(connectorCredentials.MACHINE_OWNER_KEY), "row keyed by the machine owner");
  assert.equal(connectorCredentials.status(null).connected, true);
  assert.equal(connectorCredentials.liveToken(null), PAT);
  connectorCredentials.disconnect(null);
});

test("1.2 the two credentials are independent rows", async () => {
  const email = "both@x.test";
  connectorCredentials.store({ email, token: PAT });
  registryCredentials.store({ email, token: REG_TOKEN });
  connectorCredentials.disconnect(email);
  assert.equal(connectorCredentials.status(email).connected, false);
  assert.equal(registryCredentials.status(email).connected, true, "registry row untouched");
  assert.ok(db.getRegistryCredential(email));
  registryCredentials.disconnect(email);
});

// ── 2.1 / 2.2 The dispatch table ─────────────────────────────────────────────

test("2.1 registry forwards byte-for-byte through the table", async () => {
  const email = "fwd@x.test";
  registryCredentials.store({ email, token: REG_TOKEN });
  const entry = credentialRefs.refFor({ credentialRef: "registry" });
  assert.ok(entry, "registry entry registered");
  assert.equal(entry.refName, "registry");
  assert.equal(entry.liveToken(email), registryCredentials.liveToken(email));
  assert.equal(entry.liveToken(email), REG_TOKEN);
  assert.equal(credentialRefs.knownRef("registry"), true);
  registryCredentials.disconnect(email);
});

test("2.2 connector registers as its own ref; unknown names resolve to nothing", async () => {
  const email = "ref@x.test";
  connectorCredentials.store({ email, token: PAT });
  const entry = credentialRefs.refFor({ credentialRef: "connector" });
  assert.ok(entry);
  assert.equal(entry.refName, "connector");
  assert.equal(entry.liveToken(email), PAT);
  assert.equal(credentialRefs.knownRef("connector"), true);
  assert.equal(credentialRefs.knownRef("conector"), false, "typo is unknown");
  assert.equal(credentialRefs.refFor({ credentialRef: "conector" }), null);
  assert.equal(credentialRefs.refFor({ url: "https://x" }), null, "no ref = no entry");
  connectorCredentials.disconnect(email);
});

test("2.2 resolveCredentials never cross-resolves the two refs", async () => {
  const email = "mix@x.test";
  connectorCredentials.store({ email, token: PAT });
  const servers = {
    "reg-row": { url: "https://r.example/mcp", credentialRef: "registry" },
    "conn-row": { url: "https://c.example/mcp", credentialRef: "connector" },
    "plain": { url: "https://p.example/mcp" },
  };
  // Only the connector credential exists: registry row omitted, connector
  // injected, plain untouched.
  const onlyConnector = credentialRefs.resolveCredentials(servers, email);
  assert.equal(onlyConnector.servers["conn-row"].headers.Authorization, `Bearer ${PAT}`);
  assert.ok(!onlyConnector.servers["reg-row"], "registry row omitted");
  assert.ok(onlyConnector.servers.plain, "plain row untouched");
  assert.deepEqual(onlyConnector.omitted, [{ ref: "registry", names: ["reg-row"] }]);
  assert.deepEqual(onlyConnector.injected, [{ ref: "connector", names: ["conn-row"] }]);
  // The input map is never mutated.
  assert.ok(servers["reg-row"] && !servers["reg-row"].headers);
  // Stale connector PAT ⇒ its row drops too, registry still omitted.
  connectorCredentials.markInvalid(email);
  const noneLive = credentialRefs.resolveCredentials(servers, email);
  assert.ok(!noneLive.servers["conn-row"] && !noneLive.servers["reg-row"]);
  assert.ok(noneLive.servers.plain);
  connectorCredentials.disconnect(email);
});

// ── 2.3 / 3.2 Effective-profile injection ────────────────────────────────────

const PATCH_FILE = path.join(
  process.env.DSH_HOME, "profiles", process.env.DSH_PROFILE || "platform", "mcp.patch.yml",
);
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

test("3.2 the mcp.json connector row injects/omits with the owner's PAT", async () => {
  const email = "inject@x.test";
  const row = JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH, "utf8")).mcpServers.connector;

  // No credential ⇒ omitted (warning path), the baseline row itself intact.
  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes("connector"), false, "no PAT ⇒ omitted");
  assert.equal(patchNames().includes("file-server"), true, "non-ref baseline kept");
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH, "utf8")).mcpServers.connector, row, "mcp.json untouched");

  // PAT present ⇒ injected with the Bearer header; refreshed PAT flows on the
  // next write; invalidation drops it again — no reinstall anywhere.
  connectorCredentials.store({ email, token: PAT });
  await writePatch({ ownerEmail: email });
  assert.equal(patchEntry("connector").config.headers.Authorization, `Bearer ${PAT}`);

  const FRESH = `oct_${"c".repeat(32)}`;
  connectorCredentials.store({ email, token: FRESH });
  await writePatch({ ownerEmail: email });
  assert.equal(patchEntry("connector").config.headers.Authorization, `Bearer ${FRESH}`);

  connectorCredentials.markInvalid(email);
  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes("connector"), false, "invalidated ⇒ omitted");

  // Auth off: the machine owner's PAT resolves the same baseline row.
  connectorCredentials.store({ email: null, token: PAT });
  await writePatch({ ownerEmail: null, userGroups: null });
  assert.equal(patchEntry("connector").config.headers.Authorization, `Bearer ${PAT}`);
  connectorCredentials.disconnect(null);
  connectorCredentials.disconnect(email);
});

test("2.3 registry and connector inject independently in one patch write", async () => {
  const email = "both-inject@x.test";
  connectorCredentials.store({ email, token: PAT });
  registryCredentials.store({ email, token: REG_TOKEN });
  extensionStore.addMcpServer({
    name: "reg-db",
    config: { url: "https://registry.example.test/x/mcp", credentialRef: "registry" },
  });
  try {
    // Both live.
    await writePatch({ ownerEmail: email });
    assert.equal(patchEntry("connector").config.headers.Authorization, `Bearer ${PAT}`);
    assert.equal(patchEntry("reg-db").config.headers.Authorization, `Bearer ${REG_TOKEN}`);
    // Registry goes stale: its row drops, connector keeps its header.
    registryCredentials.markStale(email);
    await writePatch({ ownerEmail: email });
    assert.equal(patchNames().includes("reg-db"), false);
    assert.equal(patchEntry("connector").config.headers.Authorization, `Bearer ${PAT}`);
    assert.ok(extensionStore.getMcpServer("reg-db"), "registry record survives the omission");
  } finally {
    extensionStore.removeMcpServer("reg-db");
    registryCredentials.disconnect(email);
    connectorCredentials.disconnect(email);
  }
});

// ── 2.4 The overlay addable universe ─────────────────────────────────────────

test("2.4 availableMcpNames filters ref-carrying rows by per-ref liveness", async () => {
  const email = "universe@x.test";
  const mkCtx = () => ({
    db,
    extensionStore,
    runtimeOwnerEmail: email,
    runtimeOwnerGroups: null,
  });

  // No credentials: the connector mcp.json row and the registry DB row are
  // both unaddable; the plain mcp.json row and plain DB row stay addable.
  extensionStore.addMcpServer({ name: "reg-u", config: { url: "https://r.example/mcp", credentialRef: "registry" } });
  extensionStore.addMcpServer({ name: "plain-u", config: { url: "https://p.example/mcp" } });
  try {
    let names = availableMcpNames(mkCtx());
    assert.equal(names.has("connector"), false, "no PAT ⇒ connector not addable");
    assert.equal(names.has("reg-u"), false, "no registry credential ⇒ not addable");
    assert.equal(names.has("file-server"), true);
    assert.equal(names.has("plain-u"), true);

    // Connector PAT alone flips only the connector row.
    connectorCredentials.store({ email, token: PAT });
    names = availableMcpNames(mkCtx());
    assert.equal(names.has("connector"), true);
    assert.equal(names.has("reg-u"), false, "registry still not addable");
    connectorCredentials.disconnect(email);

    // An unknown ref name (typo in mcp.json) is never offered.
    writeMcpJson(); // restore
    const saved = JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH, "utf8"));
    saved.mcpServers.typo = { url: "https://t.example/mcp", credentialRef: "conector" };
    fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify(saved));
    names = availableMcpNames(mkCtx());
    assert.equal(names.has("typo"), false, "unknown ref not addable");
    writeMcpJson();
  } finally {
    extensionStore.removeMcpServer("reg-u");
    extensionStore.removeMcpServer("plain-u");
  }
});

// ── 2.5 The 401 invalidation chain ───────────────────────────────────────────

function eventsCtx(overrides = {}) {
  const ctx = baseCtx({ broadcast: () => {}, ...overrides });
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
  ctx.sendToViewers = () => {};
  ctx.broadcastSessions = async () => {};
  attachDshEvents(ctx);
  return ctx;
}

function toolEvent(callId, toolName, text) {
  ctx0.dshToolNames.set(callId, toolName);
  return {
    method: "session.event",
    params: {
      sessionId: "session-1",
      event: {
        type: "tool/result",
        data: {
          error: true,
          message: { source: { callId }, content: [{ toolCallId: callId, isError: true, content: [{ type: "text", text }] }] },
        },
      },
    },
  };
}
// The dshToolNames map is per-ctx but toolEvent builds through this alias for
// brevity; each test sets it to its own ctx before firing.
let ctx0;

test("2.5 a 401 from the mcp.json connector row invalidates the PAT exactly once", async () => {
  const email = "stale401@x.test";
  connectorCredentials.store({ email, token: PAT });

  const broadcasts = [];
  const updateCalls = [];
  const ctx = eventsCtx({ broadcast: (m) => broadcasts.push(m) });
  ctx0 = ctx;
  ctx.runtimeOwnerEmail = email;
  ctx.dshUpdateMcp = (_o, groups, owner) => { updateCalls.push({ groups, owner }); return Promise.resolve(); };

  const fire = () => ctx.handleDshEvent(toolEvent("c1", "mcp__connector__list_connections", "HTTP 401 Unauthorized"));

  fire();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connectorCredentials.status(email).stale, true, "PAT invalidated");
  assert.equal(connectorCredentials.liveToken(email), null);
  assert.equal(broadcasts.some((m) => m.type === "connector_credential_stale"), true, "clients pinged");
  assert.equal(updateCalls.length, 1, "profile re-applied once");

  fire();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updateCalls.length, 1, "already invalid ⇒ no second re-apply");

  // Re-paste recovers.
  connectorCredentials.store({ email, token: PAT });
  assert.equal(connectorCredentials.status(email).connected, true);
  connectorCredentials.disconnect(email);
});

test("2.5 a 401 from a registry DB row still goes stale (regression)", async () => {
  const email = "reg401@x.test";
  registryCredentials.store({ email, token: REG_TOKEN });
  extensionStore.addMcpServer({
    name: "reg-401",
    config: { url: "https://registry.example.test/y/mcp", credentialRef: "registry" },
  });

  const broadcasts = [];
  const updateCalls = [];
  const ctx = eventsCtx({ broadcast: (m) => broadcasts.push(m) });
  ctx0 = ctx;
  ctx.runtimeOwnerEmail = email;
  ctx.dshUpdateMcp = () => { updateCalls.push(1); return Promise.resolve(); };

  ctx.dshToolNames.set("c2", "mcp__reg-401__query");
  ctx.handleDshEvent({
    method: "session.event",
    params: {
      sessionId: "session-1",
      event: {
        type: "tool/result",
        data: {
          error: true,
          message: { source: { callId: "c2" }, content: [{ toolCallId: "c2", isError: true, content: [{ type: "text", text: "401 Unauthorized" }] }] },
        },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registryCredentials.status(email).stale, true);
  assert.equal(broadcasts.some((m) => m.type === "registry_credential_stale"), true, "registry event name preserved");
  assert.equal(updateCalls.length, 1);

  registryCredentials.disconnect(email);
  extensionStore.removeMcpServer("reg-401");
});

test("2.5 a 401 from a non-ref server leaves credentials alone", async () => {
  const email = "plain401@x.test";
  connectorCredentials.store({ email, token: PAT });

  const ctx = eventsCtx();
  ctx0 = ctx;
  ctx.runtimeOwnerEmail = email;
  ctx.dshToolNames.set("c3", "mcp__file-server__fetch");
  ctx.handleDshEvent({
    method: "session.event",
    params: {
      sessionId: "session-1",
      event: {
        type: "tool/result",
        data: {
          error: true,
          message: { source: { callId: "c3" }, content: [{ toolCallId: "c3", isError: true, content: [{ type: "text", text: "401 Unauthorized" }] }] },
        },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connectorCredentials.status(email).stale, false, "plain-header server is not credential-backed");
  connectorCredentials.disconnect(email);
});

// ── 4.1 Routes ───────────────────────────────────────────────────────────────

test("4.1 lifecycle: GET → paste → GET → disconnect, token never returned", async () => {
  const ctx = connectorCtx();
  probeStatus = 200;

  const before = await request(ctx.app, "GET", "/api/connector/connection", { headers: ADMIN });
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.equal(before.body.connectorUrl, `http://127.0.0.1:${probeServer.address().port}`);
  assert.equal(before.body.mePath, "/me");

  const posted = await request(ctx.app, "POST", "/api/connector/credential", {
    headers: ADMIN,
    body: { token: PAT },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.connected, true);
  assert.ok(posted.body.updatedAt);
  assert.equal(posted.raw.includes(PAT), false, "token is not echoed back");
  assert.equal(probeSawToken, `Bearer ${PAT}`, "the probe saw the candidate PAT");

  const after = await request(ctx.app, "GET", "/api/connector/connection", { headers: ADMIN });
  assert.equal(after.body.connected, true);
  assert.equal(after.raw.includes(PAT), false, "status response carries no token");
  assert.equal(ctx.dshUpdateMcpCalls.length, 1, "storing a credential re-applies the profile");
  assert.equal(ctx.dshUpdateMcpCalls.at(-1).ownerEmail, "admin@x.test");

  const del = await request(ctx.app, "DELETE", "/api/connector/connection", { headers: ADMIN });
  assert.equal(del.status, 200);
  assert.equal(del.body.connected, false);
  assert.equal(ctx.dshUpdateMcpCalls.length, 2, "disconnecting re-applies the profile too");
  assert.equal(db.getConnectorCredential("admin@x.test"), null, "row deleted");
});

test("4.1 hosted mode rejects anonymous requests; auth off uses the machine owner", async () => {
  const hosted = connectorCtx();
  probeStatus = 200;
  for (const [method, p] of [["GET", "/api/connector/connection"], ["POST", "/api/connector/credential"], ["DELETE", "/api/connector/connection"]]) {
    const res = await request(hosted.app, method, p, { body: method === "POST" ? { token: PAT } : undefined });
    assert.equal(res.status, 401, `${method} ${p} rejects anonymous`);
  }

  const off = connectorCtx({ authEnabled: false });
  const res = await request(off.app, "POST", "/api/connector/credential", { body: { token: PAT } });
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.ok(db.getConnectorCredential("machine-owner"), "row keyed by the machine owner");
  connectorCredentials.disconnect(null);
});

test("4.1 shape gate: missing / oversized / non-oct_ tokens are rejected", async () => {
  const ctx = connectorCtx();
  assert.equal((await request(ctx.app, "POST", "/api/connector/credential", { headers: ADMIN, body: {} })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/connector/credential", { headers: ADMIN, body: { token: "  " } })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/connector/credential", { headers: ADMIN, body: { token: `oct_${"x".repeat(9000)}` } })).status, 400);
  const wrongKind = await request(ctx.app, "POST", "/api/connector/credential", {
    headers: { "x-forwarded-email": "shape@x.test", "x-forwarded-groups": "" },
    body: { token: "sk-live-not-a-connector-token" },
  });
  assert.equal(wrongKind.status, 400);
  assert.match(wrongKind.body.error, /oct_/);
  assert.equal(db.getConnectorCredential("shape@x.test"), null, "no row created");
});

test("4.1 probe verdicts: 401 rejects, 5xx stores, no baseline row = shape check only", async () => {
  // 401 from the connector: the paste is rejected outright.
  probeStatus = 401;
  const ctx1 = connectorCtx();
  const rejected = await request(ctx1.app, "POST", "/api/connector/credential", {
    headers: { "x-forwarded-email": "probe401@x.test", "x-forwarded-groups": "" },
    body: { token: PAT },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /revoked|invalid/i);
  assert.equal(db.getConnectorCredential("probe401@x.test"), null, "no row for a dead PAT");
  assert.equal(ctx1.dshUpdateMcpCalls.length, 0, "no profile re-apply for a rejected paste");

  // 5xx from the connector: store anyway (outage must not block saving).
  probeStatus = 503;
  const ctx2 = connectorCtx();
  const stored = await request(ctx2.app, "POST", "/api/connector/credential", {
    headers: { "x-forwarded-email": "probe5xx@x.test", "x-forwarded-groups": "" },
    body: { token: PAT },
  });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.connected, true);
  connectorCredentials.disconnect("probe5xx@x.test");

  // No connector row in the baseline: the probe is skipped, the shape check
  // alone decides.
  writeMcpJson(false);
  const ctx3 = connectorCtx();
  const noProbe = await request(ctx3.app, "POST", "/api/connector/credential", {
    headers: { "x-forwarded-email": "norow@x.test", "x-forwarded-groups": "" },
    body: { token: PAT },
  });
  assert.equal(noProbe.status, 200);
  assert.equal(noProbe.body.connected, true);
  assert.equal(probeSawToken, `Bearer ${PAT}`, "no further probe fired since the 5xx case");
  connectorCredentials.disconnect("norow@x.test");
  writeMcpJson();
  probeStatus = 200;
});

// ── 4.4 Admission ────────────────────────────────────────────────────────────

function installCtx(overrides = {}) {
  const ctx = baseCtx(overrides);
  registerAuth(ctx);
  ctx.dshUpdateMcpCalls = [];
  ctx.dshUpdateMcp = () => Promise.resolve();
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

test("4.4 a client-submitted credentialRef is rejected on POST and PUT", async () => {
  const ctx = installCtx();

  const post = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "hand-stamped", config: { url: "https://evil.example/mcp", credentialRef: "connector" } },
  });
  assert.equal(post.status, 400);
  assert.match(post.body.error, /credentialRef/);
  assert.equal(extensionStore.getMcpServer("hand-stamped"), null, "nothing persisted");

  // Clean hand entry still works, and a PUT carrying the field is refused too.
  const ok = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "hand-ok", config: { url: "https://manual.example/mcp", headers: { Authorization: "Bearer byo" } } },
  });
  assert.equal(ok.status, 200, "hand entry without the field is unchanged");
  const put = await request(ctx.app, "PUT", "/api/extensions/mcp/hand-ok", {
    headers: ADMIN,
    body: { config: { url: "https://manual.example/mcp", credentialRef: "registry" } },
  });
  assert.equal(put.status, 400);
  assert.match(put.body.error, /credentialRef/);
  assert.equal(extensionStore.getMcpServer("hand-ok").config.credentialRef, undefined, "row not rewritten");

  extensionStore.removeMcpServer("hand-ok");
});
