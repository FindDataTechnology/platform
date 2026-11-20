#!/usr/bin/env node
// ── CLI publish tests (add-facet-publish-bridge, F3.2) ────────────────────────
//
// The real CLI as a subprocess against a REAL-shape market (pairing.js +
// registerPackRoutes, only Logto substituted) and a bare source instance.
// Covers the three user paths: local manifest publish (pair on demand, code
// fed on stdin), cross-instance pull+push with the id mapping (silent
// re-login on the second run appends a version), and the creator-gate 403
// surfaced with guidance. Asserts from the market's store and the files on
// disk — stdout is corroboration, not proof.
//
//   node --test scripts/test-facet-cli-publish.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test, after } from "node:test";
import { spawn } from "node:child_process";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { createFacetPairing, registerPairingRoutes, withAppBearer } from "../facet/pairing.js";

const tmp = mkdtempSync(path.join(tmpdir(), "facet-cli-pub-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const CLI = path.resolve("facet/cli/facet.js");
const pairing = createFacetPairing({ dataRoot: path.join(tmp, "data"), tokenSecret: "cli-pub-secret", ttlHours: 1 });
const registry = createPackRegistry({ file: path.join(tmp, "data", "packs.db") });

const baseResolve = (req) => {
  const raw = req.headers["x-test-session"];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    if (typeof doc?.email !== "string") return null;
    return { email: doc.email, groups: Array.isArray(doc.groups) ? doc.groups : [] };
  } catch {
    return null;
  }
};
const rejectUnauthenticated = (_req, res) => res.status(401).json({ error: "Authentication required" });
const resolveUser = withAppBearer(baseResolve, pairing.appAuth);

const app = express();
app.use(express.json({ limit: "1mb" }));
registerPairingRoutes(app, { appAuth: pairing.appAuth, mpBindings: pairing.bindings, resolveUser, rejectUnauthenticated });
registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: ["creators"],
  adminGroups: [],
  anonymousRead: true,
});
const server = http.createServer(app);
const market = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

// The "self-hosted instance": just the public detail face a pull reads.
const srcManifest = {
  name: "自部署双子",
  description: "authored on a self-hosted facet",
  skills: [{ name: "gemini-skill", description: "twin skill", content: "# 双子\nself-hosted body" }],
};
const srcApp = express();
srcApp.get("/api/packs/:id", (_req, res) => {
  res.json({ id: "pack-src-gemini", name: srcManifest.name, version: 1, visibility: "public", manifest: srcManifest });
});
const srcServer = http.createServer(srcApp);
const srcBase = await new Promise((r) => srcServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srcServer.address().port}`)));

after(() => {
  for (const s of [server, srcServer]) {
    s.closeAllConnections?.();
    s.close();
  }
  registry.close();
});

const CREATOR = "cli-author@findmail.com";
const OUTSIDER = "cli-outsider@findmail.com";

async function mintCode(email, groups) {
  const r = await fetch(`${market}/api/mp/bindcode`, {
    headers: { "x-test-session": JSON.stringify({ email, groups }), Accept: "application/json" },
  }).then((x) => x.json());
  return String(r.code);
}

function facetRun(args, { home, stdin = "" } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FACET_HOME: home, FACET_PUBLISH_KEY_PATH: undefined },
      cwd: path.resolve("."),
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (stdin) p.stdin.write(stdin);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const home = path.join(tmp, "home");
const localManifest = path.join(tmp, "local.json");
writeFileSync(localManifest, JSON.stringify({ name: "本地清单包", skills: [{ name: "local-skill", description: "from a file", content: "# local" }] }));

test("local manifest publish pairs on demand (stdin code) and lands on the market", async () => {
  const code = await mintCode(CREATOR, ["creators"]);
  const r = await facetRun(["publish", localManifest, "--market", market, "--no-open"], { home, stdin: `${code}\n` });
  assert.equal(r.code, 0, `stdout: ${r.out}\nstderr: ${r.err}`);
  assert.match(r.out, /已配对为/);
  assert.match(r.out, /已发布到官方市场：[\w-]+ v1/);

  const detail = await fetch(`${market}/api/packs?pageSize=100`).then((x) => x.json());
  const mine = detail.packs.find((p) => p.name === "本地清单包");
  assert.ok(mine, "pack listed on the market");
  assert.equal(mine.authorEmail, CREATOR);

  const key = JSON.parse(readFileSync(path.join(home, ".facet", "publish-key.json"), "utf8"));
  assert.match(key.deviceId, /^[A-Za-z0-9._-]+$/);
  const identity = JSON.parse(readFileSync(path.join(home, ".facet", "publish-identity.json"), "utf8"));
  assert.equal(identity.markets[market].email, CREATOR);
});

test("cross-instance pull+push maps ids; the second run silently logs in and appends a version", async () => {
  const first = await facetRun(["publish", "pack-src-gemini", "--from", srcBase, "--market", market, "--no-open"], { home });
  assert.equal(first.code, 0, `stdout: ${first.out}\nstderr: ${first.err}`);
  assert.match(first.out, /载荷：.*自部署双子 v1/);
  assert.match(first.out, /已记 id 映射 pack-src-gemini → [\w-]+/);

  const list = await fetch(`${market}/api/packs?pageSize=100`).then((x) => x.json());
  const landed = list.packs.find((p) => p.name === "自部署双子");
  assert.ok(landed, "cross-instance pack landed on the market");
  assert.equal(landed.authorEmail, CREATOR);

  const mapFile = path.join(home, ".facet", "publish-map.json");
  assert.ok(existsSync(mapFile));
  assert.equal(JSON.parse(readFileSync(mapFile, "utf8")).maps[`${market}|pack-src-gemini`], landed.id);

  // No pair prompt this time — silent login, and the mapping routes it to a v2.
  const second = await facetRun(["publish", "pack-src-gemini", "--from", srcBase, "--market", market, "--no-open"], { home });
  assert.equal(second.code, 0, `stdout: ${second.out}\nstderr: ${second.err}`);
  assert.doesNotMatch(second.out, /配对/);
  assert.match(second.out, /沿用 id 映射/);
  const after = await fetch(`${market}/api/packs/${landed.id}`).then((x) => x.json());
  assert.equal(after.version, 2);
});

test("non-creator pairing publishes nothing and surfaces the gate with guidance", async () => {
  const outsiderHome = path.join(tmp, "home-outsider");
  const code = await mintCode(OUTSIDER, ["everyone"]);
  const r = await facetRun(["publish", localManifest, "--market", market, "--no-open"], { home: outsiderHome, stdin: `${code}\n` });
  assert.equal(r.code, 1);
  assert.match(r.err, /不在创作者组/);
  const list = await fetch(`${market}/api/packs?pageSize=100`).then((x) => x.json());
  assert.equal(list.packs.filter((p) => p.authorEmail === OUTSIDER).length, 0);
});
