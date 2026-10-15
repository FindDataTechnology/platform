#!/usr/bin/env node
// ── Paper-trading credentials (add-paper-trading-credentials) ────────────────
//
// Proves the fourth credential ref end-to-end at the unit + HTTP layer,
// mirroring test-connector-credentials.mjs:
//
//   1.1 — migration 29 creates user_paper_trading_credentials; re-run is a
//       no-op.
//   1.2 — store → status → disconnect round-trip; 401-invalidate flips stale
//       exactly once; re-paste recovers; auth-off machine ownership; the
//       projection never carries the token.
//   1.3 — the credential-refs table dispatches by name; resolveCredentials
//       injects/omits the paper-trading row independently of the others.
//   2.1 — pack-store dispatch: metadata.credential_ref picks the ref,
//       credentialConnected is ref-aware (paper-trading not connected yet
//       must be false — NOT the registry fallback), and the refusal reason
//       names the paper-trading connection.
//   3.2 — writeMcpPatch injects the paper-trading baseline row's Authorization
//       from the owner's token and omits it when absent/stale.
//   3.x — the routes: lifecycle without token echo, anonymous hosted 401,
//       auth-off allowed, fdt_ shape gate, and the probe's three verdicts
//       (401 rejects, 5xx stores, missing baseline row = shape check only).
//   2.5-analog — a 401 tool result from the paper-trading server flips stale
//       exactly once and broadcasts paper_trading_credential_stale.
//
//   node scripts/test-paper-trading-credentials.mjs

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import yaml from "js-yaml";

// ── Env before any module import (paths/env are resolved at module load) ────
// NOTE: every first-party module is imported dynamically below — a static
// import would be evaluated BEFORE this block runs (registry-bridge captures
// REGISTRY_URL at module load) and silently disable the registry source.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cred-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "service-token";
delete process.env.REGISTRY_URL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

// The paper-trading baseline row points at the local probe stub, so the paste
// route's liveness probe is fully controllable from this file.
let probeStatus = 200;
let probeSawToken = null;
let probePath = null;
const probeServer = createServer((req, res) => {
  probeSawToken = req.headers.authorization;
  probePath = req.url;
  res.statusCode = probeStatus;
  res.end(probeStatus === 401 ? "unauthorized" : "[]");
});
await new Promise((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
const PROBE_ORIGIN = `http://127.0.0.1:${probeServer.address().port}`;
function writeMcpJson(paperTradingRow = true) {
  const mcpServers = {
    "file-server": { url: "https://file.example/mcp" },
  };
  if (paperTradingRow) mcpServers["paper-trading"] = { url: `${PROBE_ORIGIN}/mcp/`, credentialRef: "paper-trading" };
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers }));
}
writeMcpJson();
process.chdir(TMP);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({ mcpServers: [] }));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));

test.after(() => {
  probeServer.closeAllConnections?.();
  probeServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { attachTurnStateModule } = await import("../server/context.js");
const db = await import("../db.js");
const paperTradingCredentials = await import("../paper-trading-credentials.js");
const registryCredentials = await import("../registry-credentials.js");
const credentialRefs = await import("../credential-refs.js");
const extensionStore = await import("../extension-store.js");
const packStore = await import("../pack-store.js");
const { writeMcpPatch } = await import("../dsh-profile.js");
const { registerAuth } = await import("../server/auth.js");
const { registerPaperTradingRoutes } = await import("../server/routes/paper-trading.js");
const { registerExtensionRoutes } = await import("../server/routes/extensions.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const bridge = await import("../registry-bridge.js");

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
                {
                  path: "/fd-paper-trading",
                  display_name: "Paper Trading",
                  description: "paper-only trading",
                  is_enabled: true,
                  metadata: { credential_ref: "paper-trading" },
                },
                { path: "/law-bench", display_name: "Law Bench", description: "registry-line", is_enabled: true },
              ],
            }),
          },
});
await bridge.refreshRegistry();
await db.initDb();

const TOKEN = `fdt_${"a".repeat(32)}`;

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

function ptCtx(overrides = {}) {
  const ctx = baseCtx(overrides);
  registerAuth(ctx);
  ctx.dshUpdateMcpCalls = [];
  ctx.dshUpdateMcp = (overlay, groups, ownerEmail) => {
    ctx.dshUpdateMcpCalls.push({ overlay, groups, ownerEmail });
    return Promise.resolve();
  };
  ctx.runtimeMcpOverlay = {};
  registerPaperTradingRoutes({ ...ctx, db });
  return ctx;
}

const ADMIN = { "x-forwarded-email": "admin@x.test", "x-forwarded-groups": "admin" };

// ── 1.1 Migration ────────────────────────────────────────────────────────────

test("1.1 migration 29 creates user_paper_trading_credentials; re-run is idempotent", async () => {
  const cols = db.getDb().prepare("PRAGMA table_info(user_paper_trading_credentials)").all().map((c) => c.name);
  for (const c of ["email", "token", "stale", "updated_at"]) {
    assert.ok(cols.includes(c), `column ${c} present`);
  }
  assert.ok(
    db.getDb().prepare("SELECT 1 FROM schema_migrations WHERE version = 29").get(),
    "v29 recorded",
  );
  await db.initDb();
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) AS n FROM user_paper_trading_credentials").get().n,
    0,
    "re-running migrations leaves the table alone",
  );
});

// ── 1.2 Module ───────────────────────────────────────────────────────────────

test("1.2 unconnected identity has no row; store → status → disconnect round-trip", () => {
  assert.deepEqual(paperTradingCredentials.status("nobody@x.test"), {
    connected: false, stale: false, updatedAt: null,
  });

  const email = "round@x.test";
  const stored = paperTradingCredentials.store({ email, token: TOKEN });
  assert.equal(stored.connected, true);
  assert.equal(stored.stale, false);
  assert.ok(stored.updatedAt);
  assert.equal(paperTradingCredentials.liveToken(email), TOKEN);

  // 401 invalidation keeps the row (re-paste prompt) and kills injection…
  assert.equal(paperTradingCredentials.markInvalid(email), true);
  assert.equal(paperTradingCredentials.status(email).stale, true);
  assert.equal(paperTradingCredentials.status(email).connected, false);
  assert.equal(paperTradingCredentials.liveToken(email), null);
  // …exactly once; a second mark is a no-op…
  assert.equal(paperTradingCredentials.markInvalid(email), false);
  // …and re-pasting recovers without disconnect.
  const FRESH = `fdt_${"b".repeat(32)}`;
  paperTradingCredentials.store({ email, token: FRESH });
  assert.equal(paperTradingCredentials.status(email).connected, true);
  assert.equal(paperTradingCredentials.liveToken(email), FRESH);

  assert.equal(paperTradingCredentials.disconnect(email), true);
  assert.equal(db.getPaperTradingCredential(email), null, "row deleted");
  assert.equal(paperTradingCredentials.disconnect(email), false, "second disconnect is a no-op");
});

test("1.2 the projection never carries the token", () => {
  const email = "proj@x.test";
  paperTradingCredentials.store({ email, token: TOKEN });
  const proj = paperTradingCredentials.status(email);
  assert.deepEqual(Object.keys(proj).sort(), ["connected", "stale", "updatedAt"]);
  assert.equal(JSON.stringify(proj).includes(TOKEN), false);
  paperTradingCredentials.disconnect(email);
});

test("1.2 auth off degrades to the machine owner (shared keying with registry)", () => {
  paperTradingCredentials.store({ email: null, token: TOKEN });
  assert.equal(paperTradingCredentials.ownerKey(null), paperTradingCredentials.MACHINE_OWNER_KEY);
  assert.ok(db.getPaperTradingCredential(paperTradingCredentials.MACHINE_OWNER_KEY), "row keyed by the machine owner");
  assert.equal(paperTradingCredentials.status(null).connected, true);
  assert.equal(paperTradingCredentials.liveToken(null), TOKEN);
  paperTradingCredentials.disconnect(null);
});

// ── 1.3 / 2.1 Dispatch table + pack-store ────────────────────────────────────

test("1.3 paper-trading registers as its own ref; unknown names resolve to nothing", () => {
  const email = "ref@x.test";
  paperTradingCredentials.store({ email, token: TOKEN });
  const entry = credentialRefs.refFor({ credentialRef: "paper-trading" });
  assert.ok(entry);
  assert.equal(entry.refName, "paper-trading");
  assert.equal(entry.staleEvent, "paper_trading_credential_stale");
  assert.equal(entry.liveToken(email), TOKEN);
  assert.equal(credentialRefs.knownRef("paper-trading"), true);
  assert.equal(credentialRefs.knownRef("paper_tradin"), false, "typo is unknown");
  assert.equal(credentialRefs.refFor({ credentialRef: "paper_tradin" }), null);
  paperTradingCredentials.disconnect(email);
});

test("1.3 resolveCredentials injects/omits the paper-trading row independently", () => {
  const email = "mix@x.test";
  const servers = {
    "pt-row": { url: `${PROBE_ORIGIN}/mcp/`, credentialRef: "paper-trading" },
    "conn-row": { url: "https://c.example/mcp", credentialRef: "connector" },
    "plain": { url: "https://p.example/mcp" },
  };
  // Neither credential present: both ref rows omitted, plain untouched.
  let res = credentialRefs.resolveCredentials(servers, email);
  assert.ok(!res.servers["pt-row"] && !res.servers["conn-row"]);
  assert.ok(res.servers.plain);
  assert.deepEqual(res.omitted, [
    { ref: "connector", names: ["conn-row"] },
    { ref: "paper-trading", names: ["pt-row"] },
  ]);

  // Paper-trading token alone: its row injected, connector still omitted.
  paperTradingCredentials.store({ email, token: TOKEN });
  res = credentialRefs.resolveCredentials(servers, email);
  assert.equal(res.servers["pt-row"].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!res.servers["conn-row"], "connector not cross-resolved");
  assert.equal(servers["pt-row"].headers, undefined, "input map never mutated");

  // Stale flips it back to omitted.
  paperTradingCredentials.markInvalid(email);
  res = credentialRefs.resolveCredentials(servers, email);
  assert.ok(!res.servers["pt-row"]);
  paperTradingCredentials.disconnect(email);
});

test("2.1 credentialRefForEntry honors metadata.credential_ref=paper-trading", () => {
  assert.equal(packStore.credentialRefForEntry({ credentialRef: "paper-trading" }), "paper-trading");
  assert.equal(packStore.credentialRefForEntry({}), "registry");
});

test("2.1 credentialConnected is ref-aware — paper-trading never falls back to registry", () => {
  const email = "dispatch@x.test";
  // No paper-trading token, but a live REGISTRY credential: the old
  // two-branch dispatch would wrongly answer true here.
  const registryToken = `r.${Buffer.from(JSON.stringify({ sub: "u", exp: Math.floor(Date.now() / 1000) + 168 * 3600 })).toString("base64url")}.sig`;
  registryCredentials.store({ email, token: registryToken });
  assert.equal(packStore.credentialConnected("paper-trading", email), false, "registry liveness must not leak");
  assert.equal(packStore.credentialConnected("registry", email), true);

  // Paste the paper-trading token: only that ref flips.
  paperTradingCredentials.store({ email, token: TOKEN });
  assert.equal(packStore.credentialConnected("paper-trading", email), true);

  // Reason names the paper-trading connection.
  assert.match(packStore.credentialMissingReason("paper-trading"), /paper-trading/i);
  assert.equal(
    packStore.credentialMissingReason("registry").includes("paper-trading"),
    false,
    "registry reason unchanged",
  );
  paperTradingCredentials.disconnect(email);
  registryCredentials.disconnect(email);
});

// ── 3.2 Effective-profile injection ──────────────────────────────────────────

const PATCH_FILE = path.join(
  process.env.DSH_HOME, "profiles", process.env.DSH_PROFILE || "platform", "mcp.patch.yml",
);
async function writePatch(opts) {
  fs.rmSync(PATCH_FILE, { force: true });
  await writeMcpPatch(opts);
}
function patchEntry(name) {
  if (!fs.existsSync(PATCH_FILE)) return undefined;
  return yaml.load(fs.readFileSync(PATCH_FILE, "utf8"))[0].insert.find((e) => e.config.serverName === name);
}
function patchNames() {
  if (!fs.existsSync(PATCH_FILE)) return [];
  return yaml.load(fs.readFileSync(PATCH_FILE, "utf8"))[0].insert.map((e) => e.config.serverName);
}

test("3.2 the mcp.json paper-trading row injects/omits with the owner's token", async () => {
  const email = "inject@x.test";
  const row = JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH, "utf8")).mcpServers["paper-trading"];

  // No credential ⇒ omitted (warning path), the baseline row itself intact.
  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes("paper-trading"), false, "no token ⇒ omitted");
  assert.equal(patchNames().includes("file-server"), true, "non-ref baseline kept");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(process.env.MCP_CONFIG_PATH, "utf8")).mcpServers["paper-trading"],
    row,
    "mcp.json untouched",
  );

  // Token present ⇒ injected with the Bearer header; invalidation drops it
  // again — profile writes only, no reinstall anywhere.
  paperTradingCredentials.store({ email, token: TOKEN });
  await writePatch({ ownerEmail: email });
  assert.equal(patchEntry("paper-trading").config.headers.Authorization, `Bearer ${TOKEN}`);

  paperTradingCredentials.markInvalid(email);
  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes("paper-trading"), false, "invalidated ⇒ omitted");

  paperTradingCredentials.disconnect(email);
});

// ── 2.1 / 4.2 Install paths ──────────────────────────────────────────────────

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

test("4.2 market card install: paper-trading entry refused without its own credential", async () => {
  const ctx = installCtx();
  // A live REGISTRY credential exists — the pre-change code judged by it and
  // stamped credentialRef:"registry", wiring the market token into the
  // paper-trading service. The ref-aware gate must refuse instead.
  const registryToken = `r.${Buffer.from(JSON.stringify({ sub: "u", exp: Math.floor(Date.now() / 1000) + 168 * 3600 })).toString("base64url")}.sig`;
  registryCredentials.store({ email: "admin@x.test", token: registryToken });

  const refused = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "fd-paper-trading", config: { url: `${PROBE_ORIGIN}/mcp/` } },
  });
  assert.equal(refused.status, 409, "no paper-trading credential ⇒ refused");
  assert.equal(refused.body.code, "credential-required");
  assert.equal(refused.body.ref, "paper-trading", "the refusal names the ref to connect");
  assert.match(refused.body.error, /paper-trading/i);
  assert.equal(extensionStore.getMcpServer("fd-paper-trading"), null, "nothing installed");

  // Paste the paper-trading token: the same install now succeeds and stamps
  // its own ref, never registry's.
  paperTradingCredentials.store({ email: "admin@x.test", token: TOKEN });
  const installed = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "fd-paper-trading", config: { url: `${PROBE_ORIGIN}/mcp/` } },
  });
  assert.equal(installed.status, 200);
  assert.equal(installed.body.config.credentialRef, "paper-trading");
  assert.equal(JSON.stringify(installed.body.config).includes(TOKEN), false, "no secret in the record");

  // The registry-line entry still installs under registry's own credential.
  const law = await request(ctx.app, "POST", "/api/extensions/mcp", {
    headers: ADMIN,
    body: { name: "law-bench", config: { url: "https://registry.example.test/law-bench/mcp" } },
  });
  assert.equal(law.status, 200);
  assert.equal(law.body.config.credentialRef, "registry");

  extensionStore.removeMcpServer("fd-paper-trading");
  extensionStore.removeMcpServer("law-bench");
  paperTradingCredentials.disconnect("admin@x.test");
  registryCredentials.disconnect("admin@x.test");
});

test("4.2 pack install: metadata.credential_ref=paper-trading routes the refusal and the stamp", async () => {
  const email = "installer@x.test";
  const hooks = {};
  const manifest = {
    name: "柏讯套件",
    description: "paper trading pack",
    tags: ["trading"],
    skills: [],
    mcpServers: [{ registryName: "fd-paper-trading" }],
    agents: [],
  };

  const refused = await packStore.installPack({
    packId: "pack-pt",
    version: 1,
    manifest,
    user: { email, groups: [] },
    hooks,
  });
  const item = refused.report.mcpServers[0];
  assert.equal(item.status, "unavailable");
  assert.equal(item.code, "credential-required");
  assert.match(item.reason, /paper-trading/i);
  assert.equal(extensionStore.getMcpServer("fd-paper-trading"), null, "nothing installed");

  paperTradingCredentials.store({ email, token: TOKEN });
  const installed = await packStore.installPack({
    packId: "pack-pt",
    version: 2,
    manifest,
    user: { email, groups: [] },
    hooks,
  });
  assert.equal(installed.report.mcpServers[0].status, "installed");
  assert.equal(extensionStore.getMcpServer("fd-paper-trading").config.credentialRef, "paper-trading");

  packStore.uninstallPack({ packId: "pack-pt", force: true, hooks });
  extensionStore.removeMcpServer("fd-paper-trading");
  paperTradingCredentials.disconnect(email);
});

// ── 3.x Routes ───────────────────────────────────────────────────────────────

test("3.1 lifecycle: GET → paste → GET → disconnect, token never returned", async () => {
  const ctx = ptCtx();
  probeStatus = 200;

  const before = await request(ctx.app, "GET", "/api/paper-trading/connection", { headers: ADMIN });
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.equal(before.body.serviceUrl, PROBE_ORIGIN);

  const posted = await request(ctx.app, "POST", "/api/paper-trading/connection", {
    headers: ADMIN,
    body: { token: TOKEN },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.connected, true);
  assert.ok(posted.body.updatedAt);
  assert.equal(posted.raw.includes(TOKEN), false, "token is not echoed back");
  assert.equal(probeSawToken, `Bearer ${TOKEN}`, "the probe saw the candidate token");
  assert.equal(probePath, "/api/v1/accounts", "probe hits the service REST, not the MCP endpoint");

  const after = await request(ctx.app, "GET", "/api/paper-trading/connection", { headers: ADMIN });
  assert.equal(after.body.connected, true);
  assert.equal(after.raw.includes(TOKEN), false, "status response carries no token");
  assert.equal(ctx.dshUpdateMcpCalls.length, 1, "storing a credential re-applies the profile");
  assert.equal(ctx.dshUpdateMcpCalls.at(-1).ownerEmail, "admin@x.test");

  const del = await request(ctx.app, "DELETE", "/api/paper-trading/connection", { headers: ADMIN });
  assert.equal(del.status, 200);
  assert.equal(del.body.connected, false);
  assert.equal(ctx.dshUpdateMcpCalls.length, 2, "disconnecting re-applies the profile too");
  assert.equal(db.getPaperTradingCredential("admin@x.test"), null, "row deleted");
});

test("3.1 hosted mode rejects anonymous requests; auth off uses the machine owner", async () => {
  const hosted = ptCtx();
  probeStatus = 200;
  for (const [method, p] of [["GET", "/api/paper-trading/connection"], ["POST", "/api/paper-trading/connection"], ["DELETE", "/api/paper-trading/connection"]]) {
    const res = await request(hosted.app, method, p, { body: method === "POST" ? { token: TOKEN } : undefined });
    assert.equal(res.status, 401, `${method} ${p} rejects anonymous`);
  }

  const off = ptCtx({ authEnabled: false });
  const res = await request(off.app, "POST", "/api/paper-trading/connection", { body: { token: TOKEN } });
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.ok(db.getPaperTradingCredential("machine-owner"), "row keyed by the machine owner");
  paperTradingCredentials.disconnect(null);
});

test("3.1 shape gate: missing / oversized / non-fdt_ tokens are rejected", async () => {
  const ctx = ptCtx();
  assert.equal((await request(ctx.app, "POST", "/api/paper-trading/connection", { headers: ADMIN, body: {} })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/paper-trading/connection", { headers: ADMIN, body: { token: "  " } })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/paper-trading/connection", { headers: ADMIN, body: { token: `fdt_${"x".repeat(9000)}` } })).status, 400);
  const wrongKind = await request(ctx.app, "POST", "/api/paper-trading/connection", {
    headers: { "x-forwarded-email": "shape@x.test", "x-forwarded-groups": "" },
    body: { token: `oct_${"x".repeat(32)}` },
  });
  assert.equal(wrongKind.status, 400);
  assert.match(wrongKind.body.error, /fdt_/);
  assert.equal(db.getPaperTradingCredential("shape@x.test"), null, "no row created");
});

test("3.1 probe verdicts: 401 rejects, 5xx stores, no baseline row = shape check only", async () => {
  // 401 from the service: the paste is rejected outright.
  probeStatus = 401;
  const ctx1 = ptCtx();
  const rejected = await request(ctx1.app, "POST", "/api/paper-trading/connection", {
    headers: { "x-forwarded-email": "probe401@x.test", "x-forwarded-groups": "" },
    body: { token: TOKEN },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /revoked|invalid/i);
  assert.equal(db.getPaperTradingCredential("probe401@x.test"), null, "no row for a dead token");
  assert.equal(ctx1.dshUpdateMcpCalls.length, 0, "no profile re-apply for a rejected paste");

  // 5xx from the service: store anyway (outage must not block saving).
  probeStatus = 503;
  const ctx2 = ptCtx();
  const stored = await request(ctx2.app, "POST", "/api/paper-trading/connection", {
    headers: { "x-forwarded-email": "probe5xx@x.test", "x-forwarded-groups": "" },
    body: { token: TOKEN },
  });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.connected, true);
  paperTradingCredentials.disconnect("probe5xx@x.test");

  // No baseline row: the probe is skipped, the shape check alone decides.
  probeSawToken = null;
  writeMcpJson(false);
  const ctx3 = ptCtx();
  const noProbe = await request(ctx3.app, "POST", "/api/paper-trading/connection", {
    headers: { "x-forwarded-email": "norow@x.test", "x-forwarded-groups": "" },
    body: { token: TOKEN },
  });
  assert.equal(noProbe.status, 200);
  assert.equal(noProbe.body.connected, true);
  assert.equal(probeSawToken, null, "no probe fired without a baseline row");
  // GET still answers, with no service URL to point at.
  const getNoRow = await request(ctx3.app, "GET", "/api/paper-trading/connection", {
    headers: { "x-forwarded-email": "norow@x.test", "x-forwarded-groups": "" },
  });
  assert.equal(getNoRow.body.serviceUrl, null);
  paperTradingCredentials.disconnect("norow@x.test");
  writeMcpJson();
  probeStatus = 200;
});

// ── The 401 invalidation chain (dsh-events) ──────────────────────────────────

function eventsCtx(overrides = {}) {
  const ctx = baseCtx({ broadcast: () => {}, ...overrides });
  attachTurnStateModule(ctx);
  ctx.dshSessionId = "session-1";
  ctx.webTurnSessions = new Set(["session-1"]);
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

let ctx0;
function toolEvent(callId, toolName, text) {
  ctx0.turnStateFor("session-1").toolNames.set(callId, toolName);
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

test("401 from the paper-trading server flips stale exactly once and broadcasts", async () => {
  const email = "pt401@x.test";
  paperTradingCredentials.store({ email, token: TOKEN });
  // The 401 handler resolves the failing server's config from mcp.json — make
  // sure the baseline row is present regardless of test order.
  writeMcpJson();

  const broadcasts = [];
  const updateCalls = [];
  const ctx = eventsCtx({ broadcast: (m) => broadcasts.push(m) });
  ctx0 = ctx;
  ctx.runtimeOwnerEmail = email;
  ctx.dshUpdateMcp = (_o, groups, owner) => { updateCalls.push({ groups, owner }); return Promise.resolve(); };

  const fire = () => ctx.handleDshEvent(toolEvent("c1", "mcp__paper-trading__list_accounts", "HTTP 401 Unauthorized"));

  fire();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(paperTradingCredentials.status(email).stale, true, "token invalidated");
  assert.equal(paperTradingCredentials.liveToken(email), null);
  assert.equal(broadcasts.some((m) => m.type === "paper_trading_credential_stale"), true, "clients pinged");
  assert.equal(updateCalls.length, 1, "profile re-applied once");

  fire();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updateCalls.length, 1, "already invalid ⇒ no second re-apply");

  // Re-paste recovers.
  paperTradingCredentials.store({ email, token: TOKEN });
  assert.equal(paperTradingCredentials.status(email).connected, true);
  paperTradingCredentials.disconnect(email);
});
