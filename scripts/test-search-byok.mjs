// Search BYOK (add-search-byok): request-scoped relay key override with
// shared-pool fallback, per-user key storage, and the settings-surface routes.
//
// Lanes:
//   1. relay — override precedence, fallback, dual-failure, hash-only logging,
//      auth/cap unaffected, source header (real relay on an ephemeral port,
//      upstream stubbed).
//   2. routes — userkey GET/PUT (own key only, mask, clear), pool endpoint
//      admin gate, test with userKey.
//   3. dsh-profile — SEARCH_USER_KEY rides the patch when set, absent (silent)
//      when not.
//
// Run: node scripts/test-search-byok.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const tmp = mkdtempSync(join(tmpdir(), "search-byok-test-"));
// Module-scope env BEFORE any app import: paths.js resolves PLATFORM_DATA_DIR
// once at import time, so a later assignment silently points db.js at the
// repo's own data/ dir (observed: lane-3 rows landed in the dev db).
process.env.PLATFORM_DATA_DIR = join(tmp, "data");
process.env.DSH_HOME = join(tmp, "dsh-home");
process.env.MCP_CONFIG_PATH = join(tmp, "mcp.json");
delete process.env.SEARCH_RELAY_URL;
delete process.env.SEARCH_RELAY_TOKEN;
delete process.env.SEARCH_USER_KEY;

// ── Lane 1: relay override chain ─────────────────────────────────────────────

const MASTER = "byok-master";
const STATIC = "byok-static-token";
const keysFile = join(tmp, "keys.json");
writeFileSync(keysFile, JSON.stringify({ serpapi: ["pool-key-1"], tokens: [STATIC], scoped_master: MASTER }));

// Upstream stub: scripted per-key behavior. Key values arrive as api_key=…
// query params, so the stub can distinguish pool vs user keys.
const realFetch = globalThis.fetch;
let upstream = { mode: "ok" }; // "ok" | "fail-user" | "fail-all"
let seenKeys = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("serpapi.com")) {
    const key = new URL(u).searchParams.get("api_key");
    seenKeys.push(key);
    const fail = upstream.mode === "fail-all" || (upstream.mode === "fail-user" && key === "user-key-good" === false && key !== "pool-key-1");
    if (fail) {
      return new Response(JSON.stringify({ error: "account has run out of searches" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ organic_results: [{ title: "t", link: "https://unit.test", snippet: "s" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(url, opts);
};

process.env.RELAY_KEYS_FILE = keysFile;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
const relay = await import("../services/search-relay/index.js");
if (!relay.relayServer.listening) await once(relay.relayServer, "listening");
const base = `http://127.0.0.1:${relay.relayServer.address().port}`;

let qn = 0;
function search(headers = {}) {
  qn += 1;
  return realFetch(`${base}/v1/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${STATIC}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ query: `byok-${qn}`, num: 1 }),
  });
}

test("relay: no override header → byte-identical pool behavior, source=pool", async () => {
  upstream = { mode: "ok" };
  const res = await search();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-search-source"), "pool");
  const body = await res.json();
  assert.equal(body.results.length, 1);
});

test("relay: user key preferred when it works, source=user, pool untouched", async () => {
  upstream = { mode: "ok" };
  seenKeys = [];
  const res = await search({ "x-serpapi-key": "user-key-good" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-search-source"), "user");
  assert.deepEqual(seenKeys, ["user-key-good"], "only the user key was tried");
});

test("relay: user key failure falls back to the pool, source says so", async () => {
  upstream = { mode: "fail-user" };
  seenKeys = [];
  const res = await search({ "x-serpapi-key": "user-key-bad" });
  assert.equal(res.status, 200, "pool covers the failed user key");
  assert.equal(res.headers.get("x-search-source"), "pool-after-user-failure");
  assert.ok(seenKeys.includes("user-key-bad"), "user key was tried first");
  assert.ok(seenKeys.includes("pool-key-1"), "pool key served the request");
});

test("relay: both sources dry → 503 with a distinguishing message", async () => {
  upstream = { mode: "fail-all" };
  const res = await search({ "x-serpapi-key": "user-key-also-bad" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /user key also failed/);
  upstream = { mode: "ok" };
});

test("relay: auth and daily cap are not bypassed by an override key", async () => {
  const noAuth = await realFetch(`${base}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-serpapi-key": "user-key-good" },
    body: JSON.stringify({ query: "no-auth", num: 1 }),
  });
  assert.equal(noAuth.status, 401, "override must not bypass relay auth");
});

test("relay: stats counts overrides, never values", async () => {
  const res = await realFetch(`${base}/v1/stats`, { headers: { authorization: `Bearer ${STATIC}` } });
  const stats = await res.json();
  assert.ok(stats.overrides.used >= 1, "successful user-key search counted");
  assert.ok(stats.overrides.failed >= 1, "failed user key counted");
  assert.ok(stats.overrides.fallback >= 1, "fallback counted");
  assert.ok(!JSON.stringify(stats).includes("user-key"), "no key values in stats");
});

test("relay: user key never appears in logs (hash prefix only)", async () => {
  // The relay logs to stderr via console.error; capture by wrapping it for one
  // failing call.
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    upstream = { mode: "fail-user" };
    await search({ "x-serpapi-key": "super-secret-user-key-xyz" });
  } finally {
    console.error = orig;
    upstream = { mode: "ok" };
  }
  const joined = logs.join("\n");
  assert.ok(!joined.includes("super-secret-user-key-xyz"), "raw key must never be logged");
  assert.match(joined, /user key [0-9a-f]{8}… failed/, "attribution is a hash prefix");
});

// ── Lane 2: routes ───────────────────────────────────────────────────────────

const express = (await import("express")).default;
const { registerMiscRoutes } = await import("../server/routes/misc.js");

function fakeDb(rows = {}) {
  const kv = { ...rows };
  return {
    isDbReady: () => true,
    getDeploymentConfig: (k) => kv[k] ?? null,
    setDeploymentConfig: (k, v) => { kv[k] = String(v); },
    clearDeploymentConfig: (k) => { delete kv[k]; },
    // per-user search key rows: email -> token
    getSearchCredential: (e) => (kv[`uk:${e}`] ? { token: kv[`uk:${e}`] } : null),
    setSearchCredential: (e, t) => { kv[`uk:${e}`] = t; },
    deleteSearchCredential: (e) => { delete kv[`uk:${e}`]; return true; },
  };
}

function buildApp({ db, user = { email: "u@test.dev", groups: [] }, admin = false } = {}) {
  const app = express();
  app.use(express.json());
  const ctx = {
    app, db: db ?? fakeDb(),
    catalog: { list: () => [] },
    cron: { listJobs: () => [] },
    authEnabled: true,
    isAdminUser: () => admin,
    PORT: 0,
    runtimeMcpOverlay: null,
    dshUpdateMcp: async () => {},
    splitPolicy: () => ({ locked: false, permissions: null }),
  };
  // Simulate the auth layer's req.user stamp.
  app.use((req, _res, next) => { req.user = user; next(); });
  registerMiscRoutes(ctx);
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("userkey: PUT stores for the session user; GET masks; clear removes", async () => {
  const db = fakeDb();
  const app = buildApp({ db });
  await withServer(app, async (b) => {
    const put = (body) => realFetch(`${b}/api/config/websearch/userkey`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    let r = await (await put({ key: "my-own-serpapi-key" })).json();
    assert.equal(r.hasKey, true);
    assert.equal(r.keyHint, "…-key");
    assert.ok(!JSON.stringify(r).includes("my-own-serpapi-key"), "value never echoed");

    r = await (await realFetch(`${b}/api/config/websearch/userkey`)).json();
    assert.equal(r.hasKey, true);
    assert.equal(r.keyHint, "…-key");

    r = await (await put({ key: "" })).json();
    assert.equal(r.hasKey, false);
    assert.equal(r.keyHint, null);
  });
});

test("userkey: identity comes from the session (no cross-user writes)", async () => {
  const db = fakeDb({ "uk:other@test.dev": "other-key" });
  const app = buildApp({ db, user: { email: "me@test.dev", groups: [] } });
  await withServer(app, async (b) => {
    await realFetch(`${b}/api/config/websearch/userkey`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "mine", email: "other@test.dev" }), // client tries to aim elsewhere
    });
    const read = async (email) => {
      const app2 = buildApp({ db, user: { email, groups: [] } });
      return withServer(app2, async (b2) => (await realFetch(`${b2}/api/config/websearch/userkey`)).json());
    };
    assert.equal((await read("me@test.dev")).hasKey, true, "written under the session identity");
    assert.equal((await read("other@test.dev")).keyHint, "…-key", "other user's row untouched");
  });
});

test("pool endpoint: admin gate, and proxies relay stats when allowed", async () => {
  const db = fakeDb({ websearchUrl: base, websearchToken: STATIC });
  const denied = buildApp({ db, admin: false });
  await withServer(denied, async (b) => {
    const res = await realFetch(`${b}/api/config/websearch/pool`);
    assert.equal(res.status, 403);
  });
  const allowed = buildApp({ db, admin: true });
  await withServer(allowed, async (b) => {
    const res = await realFetch(`${b}/api/config/websearch/pool`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, true);
    assert.equal(body.reachable, true);
    assert.ok(Array.isArray(body.keys));
    // Upstream routing is proxied through (search-relay-via-ciyuan): this
    // relay runs direct-only (no keys.json `ciyuan`), so the panel row
    // reports mode=direct. Field absent on pre-migration relays.
    assert.equal(body.upstream?.mode, "direct");
    assert.equal(body.upstream?.laneConfigured, false);
    assert.ok(!JSON.stringify(body).includes("pool-key-1"), "no upstream key values");
  });
});

// ── Lane 3: dsh-profile injection ────────────────────────────────────────────

test("SEARCH_USER_KEY rides the patch when set; absent and silent when not", async () => {
  const home = process.env.DSH_HOME;
  writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({
    mcpServers: {
      websearch: {
        command: "node", args: ["server/websearch-mcp.js"],
        envRefs: ["SEARCH_RELAY_URL", "SEARCH_RELAY_TOKEN"],
        envRefsOptional: ["SEARCH_USER_KEY"],
      },
    },
  }));

  const dbMod = await import("../db.js");
  await dbMod.initDb();
  dbMod.setDeploymentConfig("websearchUrl", "http://stored.test:4597");
  dbMod.setDeploymentConfig("websearchToken", "stored-relay-token");

  const { writeMcpPatch } = await import("../dsh-profile.js");
  const yaml = (await import("js-yaml")).default;
  const patchPath = join(home, "profiles", "platform", "mcp.patch.yml");
  const envOf = () => {
    const doc = yaml.load(readFileSync(patchPath, "utf8"));
    return doc[0].insert.find((e) => e.config.serverName === "websearch").config.env;
  };

  await writeMcpPatch({ ownerEmail: "no-key@test.dev" });
  assert.equal(envOf().SEARCH_USER_KEY, undefined, "no key → no env entry, no warning path");

  dbMod.setSearchCredential("with-key@test.dev", "user-own-key-123");
  await writeMcpPatch({ ownerEmail: "with-key@test.dev" });
  assert.equal(envOf().SEARCH_USER_KEY, "user-own-key-123");

  // another user's patch must NOT carry the first user's key
  await writeMcpPatch({ ownerEmail: "no-key@test.dev" });
  assert.equal(envOf().SEARCH_USER_KEY, undefined);
});

test.after(() => {
  relay.relayServer.close();
  globalThis.fetch = realFetch;
  delete process.env.RELAY_KEYS_FILE;
  rmSync(tmp, { recursive: true, force: true });
});
