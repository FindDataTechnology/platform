// Promotion proxy face (add-tier-promotion-candidates, task 5.1 server half).
//
// /api/memory/promotions is the thin owner seam between MemoryPage and
// fd-memory's proposal face. The thinness is the contract — pin exactly the
// things that must never drift:
//   · unauthenticated callers get 401 before any fd-memory call
//   · the owner's PERSON token rides the upstream request (not the platform
//     token — the face is the owner's own)
//   · a misconfigured/absent memory service degrades to 503 memory_unavailable
//   · accept/ignore require a path; upstream 409 (stale) passes through,
//     other upstream failures become 502
//
//   node --test scripts/test-memory-promotions-proxy.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerMemoryRoutes } from "../server/routes/memory.js";

const realFetch = globalThis.fetch;

// Minimal express-shaped fake app: routes land in a map, handlers get fake
// req/res objects with the two verbs our routes use (status/json).
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

function envFixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "paas-memo-promo-"));
  const env = {
    ...process.env,
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: "http://fdmem.test",
    CELL_MEMORY_PLATFORM_TOKEN: "platform-token",
    CELL_MEMORY_DATA: data,
  };
  // personTokenFor: a cached token file means no mint round-trip.
  const email = "owner@x.dev";
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
  fs.mkdirSync(path.join(data, "cell-memory-tokens"), { recursive: true });
  fs.writeFileSync(path.join(data, "cell-memory-tokens", `${safe}.json`), JSON.stringify({ token: "person-token", namespace: `u/${email}` }));
  return { data, env, email };
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_DATA"]) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
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

test.afterEach(() => { globalThis.fetch = realFetch; });

test("GET /api/memory/promotions: 401 without a session, ZERO upstream calls", async () => {
  const { env, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const { app, routes } = makeApp();
      registerMemoryRoutes({ app });
      const seen = upstreamStub(async () => ({ ok: true, status: 200, json: async () => ({ proposals: [] }) }));
      const res = makeRes();
      await routes.get("GET /api/memory/promotions")({ user: null, query: {} }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(seen.length, 0, "an unauthenticated hit must not knock on fd-memory");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("GET /api/memory/promotions: owner's PERSON token rides upstream; payload passthrough", async () => {
  const { env, email, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const { app, routes } = makeApp();
      registerMemoryRoutes({ app });
      const seen = upstreamStub(async () => ({
        ok: true, status: 200,
        json: async () => ({ proposals: [{ path: "default/facts/f1.md", title: "口径", current_tier: "draft", proposed_tier: "stable", reason: "r", proposed_by: "ai", proposed_at: "2026-10-30T00:00:00Z" }] }),
      }));
      const res = makeRes();
      await routes.get("GET /api/memory/promotions")({ user: { email }, query: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.proposals.length, 1);
      assert.equal(seen.length, 1);
      assert.match(seen[0].url, /^http:\/\/fdmem\.test\/memory\/promotions/);
      assert.equal(seen[0].init.headers.authorization, "Bearer person-token");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("memory service not configured: 503 memory_unavailable (degrade-open face)", async () => {
  const { env, email, data } = envFixture();
  try {
    await withEnv({ ...env, CELL_MEMORY_URL: "" }, async () => {
      const { app, routes } = makeApp();
      registerMemoryRoutes({ app });
      upstreamStub(async () => { throw new Error("must not be called"); });
      const res = makeRes();
      await routes.get("GET /api/memory/promotions")({ user: { email }, query: {} }, res);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, "memory_unavailable");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("POST accept: path required; upstream 409 stale passes through with its doc", async () => {
  const { env, email, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const { app, routes } = makeApp();
      registerMemoryRoutes({ app });
      const res0 = makeRes();
      await routes.get("POST /api/memory/promotions/accept")({ user: { email }, body: {} }, res0);
      assert.equal(res0.statusCode, 400);

      const seen = upstreamStub(async () => ({ ok: false, status: 409, json: async () => ({ error: "stale", tier: "stable" }) }));
      const res = makeRes();
      await routes.get("POST /api/memory/promotions/accept")({ user: { email }, body: { path: "default/facts/f1.md" } }, res);
      assert.equal(res.statusCode, 409, "stale must NOT be laundered into 502 — the UI drops the row on 409");
      assert.equal(res.body.error, "stale");
      assert.match(seen[0].url, /\/memory\/promotions\/accept$/);
      assert.equal(JSON.parse(seen[0].init.body).path, "default/facts/f1.md");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("POST ignore: generic upstream failure surfaces as 502 gesture_failed", async () => {
  const { env, email, data } = envFixture();
  try {
    await withEnv(env, async () => {
      const { app, routes } = makeApp();
      registerMemoryRoutes({ app });
      upstreamStub(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      const res = makeRes();
      await routes.get("POST /api/memory/promotions/ignore")({ user: { email }, body: { path: "default/facts/f9.md" } }, res);
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.code, "memory_gesture_failed");
    });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});
