#!/usr/bin/env node
// ── Server-side pack install fetch (pack-install-server-side-manifest) ───────
//
// The install endpoint takes {packId, version} and retrieves the manifest
// server-side over the facet channel the /api/packs proxy uses (same request
// function + forwarded-identity headers), or — when no facet is configured —
// through the market plane mounted in the same process. Covered here:
//
//   1.1 short form installs: the stub facet is called with the internal
//       credential + the caller's forwarded identity, the manifest is
//       validated and materialized exactly as before;
//   1.2 private-pack identity: the retrieval is evaluated as the caller
//       (owner 200, stranger 404, indistinguishable from absent);
//   1.3 retrieval failure (404 / 5xx / no manifest / unreachable) → clear
//       error and ZERO writes;
//   1.4 dual-form equivalence: a body manifest rides the identical pipeline;
//   1.5 single-process local-market source (no FACET_BASE_URL), same
//       visibility rules.
//
//   node --test scripts/test-pack-install-fetch.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";

// Isolation env BEFORE importing anything that resolves paths/db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-install-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const FACET_TOKEN = "test-facet-token";
process.env.FACET_BASE_URL = "";
process.env.FACET_INTERNAL_TOKEN = FACET_TOKEN;

const db = await import("../db.js");
await db.initDb();
const { createPackRegistry } = await import("../gateway/packs.js");
const { registerPackRoutes } = await import("../server/routes/packs.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const MANIFEST = (over = {}) => ({
  name: "自助分析",
  description: "数据自助分析工作流",
  tags: ["数据"],
  skills: [
    {
      name: "self-serve-analysis",
      description: "自助分析",
      // The body that trips edge WAF content rules — this never crosses the
      // browser boundary in the new flow, and the fetch must round-trip it
      // byte-for-byte.
      content: "# 自助分析\nSELECT * FROM t WHERE name='x';\n<script>alert(1)</script>",
    },
  ],
  mcpServers: [],
  agents: [],
  ...over,
});

// ── A stub facet: serves the version route, enforces the proxy channel ──────

function startFacetStub() {
  const packs = new Map(); // "id@version" → { manifest, visibility, authorEmail, mode }
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    seen.push({ path: url.pathname, headers: req.headers });
    if (url.pathname === "/__seen") return json(200, { seen });
    const m = url.pathname.match(/^\/api\/packs\/([^/]+)\/versions\/([^/]+)$/);
    if (!m) return json(404, { error: "not found" });
    // The proxy channel: identity is only honored under the internal token,
    // exactly like facet/identity.js.
    const armed = req.headers["x-facet-token"] === FACET_TOKEN;
    let viewer = null;
    if (armed && req.headers["x-facet-user"]) {
      viewer = JSON.parse(Buffer.from(String(req.headers["x-facet-user"]), "base64url").toString("utf8"));
    }
    const key = `${decodeURIComponent(m[1])}@${decodeURIComponent(m[2])}`;
    const pack = packs.get(key);
    if (!pack || pack.mode === "500") return json(pack?.mode === "500" ? 500 : 404, { error: "Pack version not found" });
    if (pack.visibility === "private" && viewer?.email !== pack.authorEmail) {
      return json(404, { error: "Pack version not found" });
    }
    if (pack.mode === "no-manifest") return json(200, { id: m[1], version: Number(m[2]) });
    return json(200, { id: m[1], version: Number(m[2]), manifest: pack.manifest });
  });
  server.listen(0, "127.0.0.1");
  return new Promise((resolve) => {
    server.once("listening", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        put(id, version, pack) {
          packs.set(`${id}@${version}`, pack);
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── The cell app: the real route, a test identity injector ──────────────────
//
// requireMcpManage passes (the auth-off/dev posture); authEnabled stays false
// so the route's viewer fallback is the machine owner, and the injector lets a
// test name a caller the way a forward-auth cell would.

function mountCell({ localMarket = null } = {}) {
  const ctx = {
    db,
    broadcast: () => {},
    authEnabled: false,
    cellUserEmail: "owner@local",
    requireMcpManage: () => true,
    localPackMarket: localMarket,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    if (email) req.user = { email: String(email), groups: [] };
    next();
  });
  ctx.app = app;
  registerPackRoutes(ctx);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  return new Promise((resolve) => {
    server.once("listening", () => {
      resolve({
        post: (p, body) => jsonRequest(server.address().port, "POST", p, body),
        get: (p) => jsonRequest(server.address().port, "GET", p),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function jsonRequest(port, method, p, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(body.__actor ? { "x-test-user": body.__actor } : {}) }
          : {},
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const skillOf = (name) => db.getCustomSkill(name);

test("1.2 private visibility: owner succeeds, stranger gets the market's not-found", async () => {
  const stub = await startFacetStub();
  process.env.FACET_BASE_URL = stub.url;
  const cell = await mountCell();
  try {
    stub.put("pack-priv", 1, { manifest: { ...MANIFEST({ name: "私有包" }), skills: [{ name: "priv-skill", description: "d", content: "# p" }] }, visibility: "private", authorEmail: "author@x" });

    // Stranger: the same not-found the market listing gives — nothing written.
    const denied = await cell.post("/api/mypacks/install", { packId: "pack-priv", version: 1, __actor: "stranger@x" });
    assert.equal(denied.status, 404);
    assert.match(denied.body.error, /not found/i);
    assert.equal(db.getInstalledPack("pack-priv"), null);
    assert.equal(skillOf("priv-skill"), null);

    // Owner: retrieval is evaluated under the caller's identity.
    const ok = await cell.post("/api/mypacks/install", { packId: "pack-priv", version: 1, __actor: "author@x" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.report.skills.map((s) => [s.name, s.status]), [["priv-skill", "installed"]]);
    assert.ok(db.getInstalledPack("pack-priv"));

    // The stub saw the internal credential + the forwarded identity header;
    // the LAST call is the owner's (the stranger's was refused server-side).
    const { seen } = await fetch(`${stub.url}/__seen`).then((r) => r.json());
    const calls = seen.filter((s) => s.path === "/api/packs/pack-priv/versions/1");
    assert.equal(calls.length, 2, "both installs reached the market");
    assert.equal(calls[0].headers["x-facet-token"], FACET_TOKEN);
    assert.equal(calls[1].headers["x-facet-token"], FACET_TOKEN);
    const asStranger = JSON.parse(Buffer.from(calls[0].headers["x-facet-user"], "base64url").toString("utf8"));
    const asOwner = JSON.parse(Buffer.from(calls[1].headers["x-facet-user"], "base64url").toString("utf8"));
    assert.equal(asStranger.email, "stranger@x");
    assert.equal(asOwner.email, "author@x");
  } finally {
    await cell.close();
    await stub.close();
    process.env.FACET_BASE_URL = "";
  }
});

test("1.1/1.4 short form installs the fetched manifest; a body manifest rides the same pipeline", async () => {
  const stub = await startFacetStub();
  process.env.FACET_BASE_URL = stub.url;
  const cell = await mountCell();
  try {
    const fetched = MANIFEST({
      name: "自助分析-fetched",
      skills: [{ name: "fetch-skill", description: "自助分析", content: "# f\nSELECT 1 WHERE name='x';" }],
    });
    stub.put("pack-fetch", 1, { manifest: fetched, visibility: "public", authorEmail: "creator@x" });

    const short = await cell.post("/api/mypacks/install", { packId: "pack-fetch", version: 1 });
    assert.equal(short.status, 200);
    assert.deepEqual(short.body.report.skills.map((s) => [s.name, s.status]), [["fetch-skill", "installed"]]);
    // The fetched content is materialized verbatim (code/SQL intact).
    assert.match(skillOf("fetch-skill").content, /SELECT 1 WHERE name='x';/);

    // Identity the route stamps for the auth-off machine owner.
    const { seen } = await fetch(`${stub.url}/__seen`).then((r) => r.json());
    const forwarded = JSON.parse(
      Buffer.from(seen.find((s) => s.path === "/api/packs/pack-fetch/versions/1").headers["x-facet-user"], "base64url").toString("utf8"),
    );
    assert.equal(forwarded.email, "owner@local");

    // Dual form: an identical manifest supplied in the body materializes
    // through the same pipeline (no fetch involved).
    const body = MANIFEST({
      name: "自助分析-body",
      skills: [{ name: "body-skill", description: "自助分析", content: "# b\nSELECT 2;" }],
    });
    const viaBody = await cell.post("/api/mypacks/install", { packId: "pack-body", version: 1, manifest: body });
    assert.equal(viaBody.status, 200);
    assert.deepEqual(viaBody.body.report.skills.map((s) => [s.name, s.status]), [["body-skill", "installed"]]);

    // Equivalence in both directions: re-installing the FETCHED pack through
    // the body form replaces its skills exactly like any reinstall, and the
    // stored snapshot matches the market manifest byte-for-byte.
    const reinstall = await cell.post("/api/mypacks/install", { packId: "pack-fetch", version: 1, manifest: fetched });
    assert.equal(reinstall.status, 200);
    assert.deepEqual(reinstall.body.report.skills.map((s) => [s.name, s.status]), [["fetch-skill", "replaced"]]);
    assert.deepEqual(db.getInstalledPack("pack-fetch").manifest, fetched);

    // A body with an invalid manifest still fails validation (one rule set).
    const bad = await cell.post("/api/mypacks/install", { packId: "pack-bad", version: 1, manifest: { name: "" } });
    assert.equal(bad.status, 400);
    assert.equal(db.getInstalledPack("pack-bad"), null);
  } finally {
    await cell.close();
    await stub.close();
    process.env.FACET_BASE_URL = "";
  }
});

test("1.3 retrieval failure writes nothing: 404, 5xx, no manifest, unreachable", async () => {
  const stub = await startFacetStub();
  process.env.FACET_BASE_URL = stub.url;
  const cell = await mountCell();
  try {
    stub.put("pack-boom", 1, { manifest: MANIFEST(), visibility: "public", authorEmail: "creator@x", mode: "500" });
    stub.put("pack-empty", 1, { manifest: MANIFEST(), visibility: "public", authorEmail: "creator@x", mode: "no-manifest" });

    const missing = await cell.post("/api/mypacks/install", { packId: "pack-nope", version: 9 });
    assert.equal(missing.status, 404);

    const boom = await cell.post("/api/mypacks/install", { packId: "pack-boom", version: 1 });
    assert.equal(boom.status, 502);
    assert.match(boom.body.error, /pack marketplace/i);

    const empty = await cell.post("/api/mypacks/install", { packId: "pack-empty", version: 1 });
    assert.equal(empty.status, 502);
    assert.match(empty.body.error, /no manifest/i);

    // The short form requires both fields before any lookup happens.
    const noVersion = await cell.post("/api/mypacks/install", { packId: "pack-boom" });
    assert.equal(noVersion.status, 400);

    // Zero writes across all four failures: no pack snapshot, and the
    // manifests those packs would have materialized are nowhere to be found.
    assert.equal(db.getInstalledPack("pack-boom"), null);
    assert.equal(db.getInstalledPack("pack-empty"), null);
    assert.equal(db.getInstalledPack("pack-nope"), null);
    assert.equal(skillOf("self-serve-analysis"), null);
    assert.equal((await cell.get("/api/mypacks")).body.packs.some((p) => ["pack-boom", "pack-empty", "pack-nope"].includes(p.packId)), false);
  } finally {
    // Unreachable facet: the stub goes away, the fetch must answer 502.
    await stub.close();
    const down = await cell.post("/api/mypacks/install", { packId: "pack-boom", version: 1 });
    assert.equal(down.status, 502);
    assert.match(down.body.error, /unreachable/i);
    assert.equal(db.getInstalledPack("pack-boom"), null);
    await cell.close();
    process.env.FACET_BASE_URL = "";
  }
});

test("1.5 no facet: the in-process market is the source; visibility rules unchanged", async () => {
  const registry = createPackRegistry({ file: path.join(mkdtempSync(path.join(tmpRoot, "reg-")), "packs.db") });
  const pub = registry.publish({ email: "creator@x", manifest: MANIFEST({ skills: [{ name: "local-skill", description: "d", content: "# l" }] }) });
  const priv = registry.publish({
    email: "creator@x",
    manifest: MANIFEST({ name: "本地私有", visibility: "private", skills: [{ name: "local-priv-skill", description: "d", content: "# lp" }] }),
  });
  const cell = await mountCell({
    localMarket: { getVersion: (id, version, viewer) => registry.getVersionVisible(id, version, viewer, { admin: false }) },
  });
  try {
    assert.equal(process.env.FACET_BASE_URL, "");
    const ok = await cell.post("/api/mypacks/install", { packId: pub.id, version: pub.version, __actor: "reader@x" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.report.skills.map((s) => [s.name, s.status]), [["local-skill", "installed"]]);

    const denied = await cell.post("/api/mypacks/install", { packId: priv.id, version: priv.version, __actor: "reader@x" });
    assert.equal(denied.status, 404);
    assert.equal(skillOf("local-priv-skill"), null);

    const owner = await cell.post("/api/mypacks/install", { packId: priv.id, version: priv.version, __actor: "creator@x" });
    assert.equal(owner.status, 200);
    assert.ok(skillOf("local-priv-skill"));

    // No market configured at all → an explicit error, nothing written.
    const bare = await mountCell();
    try {
      const none = await bare.post("/api/mypacks/install", { packId: "whatever", version: 1 });
      assert.equal(none.status, 503);
      assert.match(none.body.error, /not configured/i);
    } finally {
      await bare.close();
    }
  } finally {
    await cell.close();
  }
});