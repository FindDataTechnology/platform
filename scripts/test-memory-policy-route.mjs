// Policy read face (add-pack-memory-declaration 3.3 / 4.x server half).
//
// /api/memory/policy is the thin seam between the console and fd-memory's
// `/policy`. The thinness IS the contract, so pin what must never drift:
//   · the root key is DERIVED from packId, never taken from the caller — a caller
//     that could name a root could name somebody else's store
//   · the response always says where the policy lives (`policy_root`, scope
//     "pack"), because a pack root is shared by every team landed from that pack,
//     including teams of other owners (design D8)
//   · platform lane token upstream, session required here (stricter than the
//     neighbouring deployer face, and deliberately so for a new surface)
//   · absent/invalid input and upstream failure degrade without throwing
//
//   node --test scripts/test-memory-policy-route.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";

import { registerMemoryRoutes } from "../server/routes/memory.js";

const realFetch = globalThis.fetch;

function makeApp() {
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  };
  return { app, routes };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined, sent: false };
  res.status = (n) => { res.statusCode = n; return res; };
  res.json = (doc) => { res.body = doc; res.sent = true; return res; };
  return res;
}

function envFixture(overrides = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "paas-memo-policy-"));
  const env = {
    ...process.env,
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: "http://fdmem.test",
    CELL_MEMORY_PLATFORM_TOKEN: "platform-token",
    CELL_MEMORY_DATA: data,
    ...overrides,
  };
  return { data, env };
}

function withEnv(env, fn) {
  const keys = ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_DATA"];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

function upstreamStub(handler) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return seen;
}

const POLICY_DOC = {
  rootKey: "d-legal-crew",
  project: "default",
  rows: {
    distill: { declared: "off", inherited_from: "project", effective: "off", executed: true },
    promote_after: { declared: null, inherited_from: "platform", effective: 3, executed: false },
    cold_after_days: { declared: null, inherited_from: "platform", effective: 0, executed: false },
  },
  not_executed: [],
  deployment_default: { distill: "on" },
};

const session = { user: { email: "deployer@x.dev" } };

async function call(query = {}, ctx = session) {
  const { app, routes } = makeApp();
  registerMemoryRoutes({ app });
  const res = makeRes();
  await routes.get("GET /api/memory/policy")({ ...ctx, query }, res);
  return res;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("the root key is derived from packId, and rides upstream as the scope", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const seen = upstreamStub(async () => ({ ok: true, status: 200, json: async () => POLICY_DOC }));
      const res = await call({ packId: "legal-crew" });
      assert.equal(res.statusCode, 200);
      assert.equal(seen.length, 1);
      const u = new URL(seen[0].url);
      assert.equal(u.pathname, "/policy");
      assert.equal(u.searchParams.get("rootKey"), "d-legal-crew");
      assert.equal(seen[0].init.headers.authorization, "Bearer platform-token");
      // The upstream document is passed through and annotated with the scope.
      assert.deepEqual(res.body.rows, POLICY_DOC.rows);
      assert.deepEqual(res.body.not_executed, []);
      assert.equal(res.body.policy_root, "d-legal-crew");
      assert.equal(res.body.scope, "pack");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("a caller cannot name a root: only packId is accepted", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const seen = upstreamStub(async () => ({ ok: true, status: 200, json: async () => POLICY_DOC }));
      // A rootKey parameter is simply not read — the derived root wins.
      const res = await call({ packId: "legal-crew", rootKey: "u/someone-else" });
      assert.equal(res.statusCode, 200);
      const u = new URL(seen[0].url);
      assert.equal(u.searchParams.get("rootKey"), "d-legal-crew");
      assert.ok(!seen[0].url.includes("someone-else"), "a caller-supplied root must not reach the service");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("an invalid or absent packId is refused before any upstream call", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const seen = upstreamStub(async () => { throw new Error("must not be called"); });
      for (const query of [{}, { packId: "" }, { packId: "a/b" }, { packId: "../escape" }, { packId: "x".repeat(65) }, { packId: "a.b" }]) {
        const res = await call(query);
        assert.equal(res.statusCode, 400, `${JSON.stringify(query)} must be refused`);
        assert.equal(res.body.code, "pack_id_invalid");
      }
      assert.equal(seen.length, 0, "no upstream call for a bad request");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("a session is required (a new face must not be wider than its neighbour)", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const seen = upstreamStub(async () => { throw new Error("must not be called"); });
      const res = await call({ packId: "legal-crew" }, { user: null });
      assert.equal(res.statusCode, 401);
      assert.equal(seen.length, 0);
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("unconfigured service and upstream failure degrade to their own codes", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv({ ...env, CELL_MEMORY_URL: "" }, async () => {
      upstreamStub(async () => { throw new Error("must not be called"); });
      const res = await call({ packId: "legal-crew" });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, "memory_unavailable");
    });
    await withEnv(env, async () => {
      upstreamStub(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      const res = await call({ packId: "legal-crew" });
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.code, "memory_read_failed");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("the four columns survive the proxy (declared / inherited_from / effective / executed)", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv(env, async () => {
      upstreamStub(async () => ({
        ok: true, status: 200,
        json: async () => ({
          ...POLICY_DOC,
          rows: {
            ...POLICY_DOC.rows,
            cold_after_days: { declared: 90, inherited_from: "project", effective: 90, executed: false },
          },
          not_executed: ["cold_after_days"],
        }),
      }));
      const res = await call({ packId: "legal-crew" });
      assert.deepEqual(res.body.not_executed, ["cold_after_days"]);
      const row = res.body.rows.cold_after_days;
      assert.deepEqual(Object.keys(row).sort(), ["declared", "effective", "executed", "inherited_from"]);
      assert.equal(row.executed, false, "a declared value with no consumer must arrive as unexecuted");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

// ── one case over real HTTP ────────────────────────────────────────────────
//
// Everything above stubs `globalThis.fetch` and the express app, which pins the
// handler's logic but not the wiring. This runs the route on a real express
// server against a real mock fd-memory on another port, so the query string, the
// Authorization header and the JSON body cross an actual socket. Cheap, and it is
// the only case that would catch a route registered at a path the app never
// serves.
test("over real HTTP the derived root and the platform token reach the service", async () => {
  const hits = [];
  const upstream = createServer((req, res) => {
    hits.push({ url: String(req.url), auth: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(POLICY_DOC));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const { env, data } = envFixture({ CELL_MEMORY_URL: upstreamUrl });

  const app = express();
  // The real app installs the session middleware before these routes; a bare
  // app has none, so stand in for it rather than editing the route's contract.
  app.use((req, _res, next) => { req.user = { email: "deployer@x.dev" }; next(); });
  registerMemoryRoutes({ app });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await withEnv(env, async () => {
      const r = await fetch(`${base}/api/memory/policy?packId=legal-crew`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.policy_root, "d-legal-crew");
      assert.equal(body.scope, "pack");
      assert.deepEqual(body.rows, POLICY_DOC.rows);

      assert.equal(hits.length, 1);
      const u = new URL(hits[0].url, upstreamUrl);
      assert.equal(u.pathname, "/policy");
      assert.equal(u.searchParams.get("rootKey"), "d-legal-crew");
      assert.equal(hits[0].auth, "Bearer platform-token");

      // And the refusal is a real 400 over the wire, not just a short-circuit.
      const bad = await fetch(`${base}/api/memory/policy?packId=a%2Fb`);
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, "pack_id_invalid");
      assert.equal(hits.length, 1, "a refused request must not reach the service");
    });
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(data, { recursive: true, force: true });
  }
});
