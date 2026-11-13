// Unit tests — facet team-console proxy (change add-pack-console, task 6.2/6.3).
// Run: node --test scripts/test-facet-console-proxy.mjs
//
// The proxy's posture is what is pinned here, because each part of it is a
// promise to a visitor:
//   · no identity is forwarded (the share page holds no authority);
//   · an upstream 404 stays 404 ("not published" must not look retryable);
//   · an unreachable platform yields 503, never an empty console (an empty
//     console would claim the team has nothing to show);
//   · a missing configuration is a 503, not a crash at boot.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerTeamConsoleProxy } from "../facet/team-console-proxy.js";

async function startServer(opts) {
  const app = express();
  registerTeamConsoleProxy(app, opts);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    get: (p, headers = {}) =>
      fetch(`${base}${p}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
  };
}

test("unconfigured source is an honest 503", async () => {
  const { server, get } = await startServer({ baseUrl: "" });
  try {
    const res = await get("/api/team-console/ec-team");
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not configured/);
  } finally {
    server.close();
  }
});

test("an empty slug is 404 before any upstream call", async () => {
  let called = false;
  const { server, get } = await startServer({
    baseUrl: "http://platform.test",
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  try {
    const res = await get("/api/team-console/%20");
    assert.equal(res.status, 404);
    assert.equal(called, false);
  } finally {
    server.close();
  }
});

test("a successful upstream read passes through, with no visitor headers", async () => {
  let seenUrl = null;
  let seenHeaders = null;
  const view = { v: 1, fleet: { id: "f1", name: "电商团队", state: "active" }, surface: "share", headline: null, blocks: [], sampledAt: 1 };
  const { server, get } = await startServer({
    baseUrl: "http://platform.test/",
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init?.headers ?? {};
      return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const res = await get("/api/team-console/%E7%94%B5%E5%95%86%E5%9B%A2%E9%98%9F", {
      cookie: "session=secret",
      authorization: "Bearer visitor-token",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, view);
    // The slug is encoded on the way out and the target is the platform's
    // by-slug console endpoint.
    assert.match(seenUrl, /\/api\/fleets\/by-slug\/.+\/console\?surface=share&slug=/);
    assert.equal(seenHeaders.cookie, undefined, "a visitor cookie must not reach the platform");
    assert.equal(seenHeaders.authorization, undefined, "a visitor token must not reach the platform");
  } finally {
    server.close();
  }
});

test("an unpublished team stays a 404 (not a retryable 503)", async () => {
  const { server, get } = await startServer({
    baseUrl: "http://platform.test",
    fetchImpl: async () => new Response(JSON.stringify({ error: "Not published" }), { status: 404 }),
  });
  try {
    const res = await get("/api/team-console/secret-team");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Not published");
  } finally {
    server.close();
  }
});

test("an unreachable platform is 503, never an empty console", async () => {
  const { server, get } = await startServer({
    baseUrl: "http://platform.test",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3001");
    },
  });
  try {
    const res = await get("/api/team-console/ec-team");
    assert.equal(res.status, 503);
    assert.match(res.body.error, /unreachable/);
    // The decisive assertion: the response must NOT look like a console.
    assert.equal(res.body.blocks, undefined);
  } finally {
    server.close();
  }
});
