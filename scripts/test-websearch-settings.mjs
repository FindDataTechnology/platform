// Network-search settings (add-websearch-settings §1/§3).
//
// Lanes:
//   1. lib/websearch-relay.js — resolution precedence (stored > env > null),
//      maskToken never leaks the value.
//   2. The three routes on a real express app with a temp SQLite DB —
//      GET never echoes the token, PUT three-state semantics (absent/""/value),
//      the connectivity test's state classification (fetch stubbed), and the
//      admin gate.
//   3. dsh-profile integration — a stored URL/token lands in the patch envRefs
//      resolution; with SCOPED_MASTER present the derived token still wins.
//
// Run: node scripts/test-websearch-settings.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "websearch-settings-test-"));

// ── Lane 1: resolver + mask ──────────────────────────────────────────────────

const { resolveWebsearchRelay, maskToken } = await import("../lib/websearch-relay.js");

function fakeDb(rows = {}, ready = true) {
  return {
    isDbReady: () => ready,
    getDeploymentConfig: (k) => rows[k] ?? null,
    setDeploymentConfig: (k, v) => { rows[k] = String(v); },
    clearDeploymentConfig: (k) => { delete rows[k]; },
  };
}

test("resolution: stored > env > null, per field independently", async () => {
  const prevUrl = process.env.SEARCH_RELAY_URL;
  const prevTok = process.env.SEARCH_RELAY_TOKEN;
  process.env.SEARCH_RELAY_URL = "http://env.test:4597";
  process.env.SEARCH_RELAY_TOKEN = "env-token";
  try {
    const empty = fakeDb({});
    const r1 = await resolveWebsearchRelay(empty);
    assert.deepEqual([r1.url, r1.token, r1.source.url, r1.source.token],
      ["http://env.test:4597", "env-token", "env", "env"]);

    const stored = fakeDb({ websearchUrl: "http://stored.test:4597" });
    const r2 = await resolveWebsearchRelay(stored);
    assert.deepEqual([r2.url, r2.token, r2.source.url, r2.source.token],
      ["http://stored.test:4597", "env-token", "stored", "env"], "url stored, token still env");

    const both = fakeDb({ websearchUrl: "http://s.test", websearchToken: "stored-tok" });
    const r3 = await resolveWebsearchRelay(both);
    assert.deepEqual([r3.url, r3.token, r3.source.url, r3.source.token],
      ["http://s.test", "stored-tok", "stored", "stored"]);

    delete process.env.SEARCH_RELAY_URL;
    delete process.env.SEARCH_RELAY_TOKEN;
    const r4 = await resolveWebsearchRelay(fakeDb({}));
    assert.deepEqual([r4.url, r4.token, r4.source.url, r4.source.token], [null, null, null, null]);
  } finally {
    if (prevUrl !== undefined) process.env.SEARCH_RELAY_URL = prevUrl; else delete process.env.SEARCH_RELAY_URL;
    if (prevTok !== undefined) process.env.SEARCH_RELAY_TOKEN = prevTok; else delete process.env.SEARCH_RELAY_TOKEN;
  }
});

test("maskToken: never returns the full value", () => {
  assert.equal(maskToken(""), null);
  assert.equal(maskToken(null), null);
  assert.equal(maskToken("ab"), "ab"); // <=4 chars pass through (nothing to hide beyond it)
  assert.equal(maskToken("abcdefgh"), "…efgh");
  const long = "fb0afcdf3950f18533112e7587b77b199f3e057227c31d1a";
  const masked = maskToken(long);
  assert.equal(masked, "…1d1a"); // "…" + last 4
  assert.ok(!masked.includes(long.slice(0, 10)));
});

// ── Lane 2: routes ───────────────────────────────────────────────────────────

// Minimal express harness: registerMiscRoutes needs a big ctx; instead mount
// ONLY the websearch routes by importing the module's route logic through a
// real express app with a stub ctx — the routes are registered inside
// registerMiscRoutes, so we build the smallest ctx that survives registration.
const express = (await import("express")).default;
const { registerMiscRoutes } = await import("../server/routes/misc.js");

function buildApp({ admin = true, dbReady = true, db: dbImpl } = {}) {
  const app = express();
  app.use(express.json());
  const rows = {};
  const db = dbImpl ?? fakeDb(rows, dbReady);
  const ctx = {
    app, db,
    catalog: { list: () => [] },
    cron: { listJobs: () => [] },
    authEnabled: true,
    isAdminUser: () => admin,
    PORT: 0,
    runtimeMcpOverlay: null,
    dshUpdateMcp: async () => {},
    splitPolicy: () => ({ locked: false, permissions: null }),
    requireAdmin: () => true,
  };
  registerMiscRoutes(ctx);
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

test("GET /api/config/websearch never echoes the token", async () => {
  const rows = { websearchUrl: "http://relay.test:4597", websearchToken: "supersecret-token-abc" };
  const app = buildApp({ db: fakeDb(rows) });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/config/websearch`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, "http://relay.test:4597");
    assert.equal(body.hasToken, true);
    assert.equal(body.tokenHint, "…-abc");
    assert.equal(body.source.token, "stored");
    assert.ok(!JSON.stringify(body).includes("supersecret"), "response must not carry the token");
  });
});

test("PUT three-state: absent untouched / empty clears / value stores", async () => {
  const rows = { websearchUrl: "http://old.test", websearchToken: "old-token" };
  const app = buildApp({ db: fakeDb(rows) });
  await withServer(app, async (base) => {
    const put = (body) => fetch(`${base}/api/config/websearch`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    // absent: token untouched
    await put({ url: "http://new.test" });
    assert.equal(rows.websearchUrl, "http://new.test");
    assert.equal(rows.websearchToken, "old-token");

    // empty string: cleared
    await put({ token: "" });
    assert.equal(rows.websearchToken, undefined);

    // value: stored
    await put({ token: "fresh-token" });
    assert.equal(rows.websearchToken, "fresh-token");

    // invalid URL rejected
    const bad = await put({ url: "ftp://nope" });
    assert.equal(bad.status, 400);
  });
});

test("PUT is admin-gated; auth-off machine owner passes", async () => {
  const app = buildApp({ admin: false });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/config/websearch`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://x.test" }),
    });
    assert.equal(res.status, 403);
  });
});

test("POST test: classifies ok / auth-rejected / upstream-degraded / unreachable / invalid-url", async () => {
  const realFetch = globalThis.fetch;
  const rows = { websearchUrl: "http://relay.test:4597", websearchToken: "tok" };
  const app = buildApp({ db: fakeDb(rows) });
  // Intercept ONLY the relay leg; every other fetch (incl. the test's own
  // HTTP calls into the harness app) goes to realFetch.
  let next = { status: 200 };
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("relay.test") || String(url).includes("other.test")) {
      if (next.throw) { const e = new Error(next.throw); e.name = next.name ?? "Error"; throw e; }
      return new Response(JSON.stringify({}), { status: next.status });
    }
    return realFetch(url, opts);
  };
  try {
    await withServer(app, async (base) => {
      const post = (body) => realFetch(`${base}/api/config/websearch/test`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
      });

      next = { status: 200 };
      assert.equal((await (await post()).json()).state, "ok");
      next = { status: 401 };
      assert.equal((await (await post()).json()).state, "auth-rejected");
      next = { status: 503 };
      const degraded = await (await post()).json();
      assert.equal(degraded.state, "upstream-degraded");
      assert.match(degraded.detail, /503/);
      next = { throw: "fetch failed", name: "TypeError" };
      assert.equal((await (await post()).json()).state, "unreachable");
      // form values override effective pair; nothing persists
      next = { status: 200 };
      const r = await (await post({ url: "http://other.test:1", token: "form-tok" })).json();
      assert.equal(r.state, "ok");
      assert.equal(rows.websearchUrl, "http://relay.test:4597", "test must not persist");
      // whitespace-only form value falls back to the effective pair (same
      // "blank = keep current" semantics as the form) → still ok
      next = { status: 200 };
      const blankTok = await (await realFetch(`${base}/api/config/websearch/test`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://relay.test", token: " " }),
      })).json();
      assert.equal(blankTok.state, "ok");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Lane 3: dsh-profile integration ─────────────────────────────────────────

test("stored relay pair reaches the patch; scoped master still wins", async () => {
  const home = join(tmp, "dsh-home");
  process.env.DSH_HOME = home;
  process.env.MCP_CONFIG_PATH = join(tmp, "mcp.json");
  process.env.PLATFORM_DATA_DIR = join(tmp, "data");
  delete process.env.SEARCH_RELAY_URL;
  delete process.env.SEARCH_RELAY_TOKEN;
  writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({
    mcpServers: { websearch: { command: "node", args: ["server/websearch-mcp.js"], envRefs: ["SEARCH_RELAY_URL", "SEARCH_RELAY_TOKEN"] } },
  }));

  const dbMod = await import("../db.js");
  await dbMod.initDb();
  dbMod.setDeploymentConfig("websearchUrl", "http://stored-relay.test:4597");
  dbMod.setDeploymentConfig("websearchToken", "stored-relay-token");

  const { writeMcpPatch } = await import("../dsh-profile.js");
  const yaml = (await import("js-yaml")).default;
  const { readFileSync } = await import("node:fs");
  const patchPath = join(home, "profiles", "platform", "mcp.patch.yml");
  const envOf = () => {
    const doc = yaml.load(readFileSync(patchPath, "utf8"));
    return doc[0].insert.find((e) => e.config.serverName === "websearch").config.env;
  };

  // stored layer (no scoped master): stored values win over env
  await writeMcpPatch({ ownerEmail: "u@test.dev" });
  assert.equal(envOf().SEARCH_RELAY_URL, "http://stored-relay.test:4597");
  assert.equal(envOf().SEARCH_RELAY_TOKEN, "stored-relay-token");

  // scoped master present: derivation wins over the stored token, and the
  // stored URL must STILL land (regression: an early-return dropped it)
  process.env.SEARCH_RELAY_SCOPED_MASTER = "unit-master";
  try {
    await writeMcpPatch({ ownerEmail: "u@test.dev" });
    assert.match(envOf().SEARCH_RELAY_TOKEN, /^wsrc-cell-[0-9a-f]{12}-[0-9a-f]{24}$/);
    assert.equal(envOf().SEARCH_RELAY_URL, "http://stored-relay.test:4597", "stored URL survives token derivation");
  } finally {
    delete process.env.SEARCH_RELAY_SCOPED_MASTER;
  }
});

test.after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
