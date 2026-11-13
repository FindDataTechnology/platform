#!/usr/bin/env node
// ── A deploy must ANSWER, even when a step after the registry write throws ────
//
// Regression for the 2026-11-12/13 hang: `let deploymentBindings` was declared
// inside the deploy handler's `try` block and referenced after it, so EVERY
// successful deploy threw a ReferenceError while assembling the response —
// after the registry rows were already written. The route was
// `void withDeployLock(id, () => deployHandler(req, res))`, so the rejection was
// swallowed and no response was ever sent: the caller waited out its own
// timeout (60s in e2e, 30s in the unit lane) and three deploy suites turned red.
//
// The bug class is "throw after the write", not that one name, so this test
// forces the throw at the first post-write step (recording the deployment row)
// and asserts the route answers 500 with `mayHaveLanded: true`. A hang fails the
// test on its own deadline instead of blocking the suite.
//
//   node --test scripts/test-deploy-answers-on-throw.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test, after } from "node:test";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "deploy-throw-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Registry stub that accepts the descriptor writes and lists an empty fleet. */
function registryStub() {
  const written = [];
  return {
    written,
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      if (url === "/api/agents" && !init.method) {
        return { ok: true, status: 200, json: async () => ({ agents: [], total_count: 0 }) };
      }
      if (url === "/api/agents/register" && init.method === "POST") {
        written.push({ path: body.path, body });
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      const toggle = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (toggle && init.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ path: toggle[1], is_enabled: true }) };
      }
      const entry = url.match(/^\/api\/agents\/(.+)$/);
      if (entry && (init.method === "PUT" || init.method === "POST")) {
        written.push({ path: entry[1], body });
        return { ok: true, status: 200, json: async () => ({ path: entry[1], ...body }) };
      }
      if (entry && !init.method) {
        return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: `no stub route ${init.method} ${url}` }) };
    },
  };
}

const manifest = {
  name: "deploy-throw probe",
  skills: [],
  agents: [{ id: "throw-agent", name: "T", persona: "p", serving: { protocol: "a2a" } }],
};

test("a throw AFTER the registry write answers 500 with mayHaveLanded, never hangs", async () => {
  const stub = registryStub();
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest });

  // The first post-write step blows up — the shape that used to hang the route.
  const realRecord = registry.recordDeployment.bind(registry);
  registry.recordDeployment = () => {
    throw new Error("ledger write exploded after the registry push");
  };

  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => ({ email: "author@x", groups: [] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: ["creators"],
    adminGroups: [],
    deployConfig: {
      registryUrl: "https://mcp.example.test",
      token: "t",
      runnerBaseUrl: "http://runner:8790",
      packsPublicBase: "https://packs.example.test",
      fetchImpl: stub.fetch,
      sub2api: null,
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // 10s: a hang used to burn 30-60s. If the route stops answering, this aborts
  // and the assertion below fails loudly instead of stalling the lane.
  const res = await fetch(`${base}/api/packs/${id}/versions/1/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  assert.equal(res.status, 500, "a failed deploy must answer, not hang");
  // Contract after the merge with the main line: the body carries a stable
  // `error`/`code` pair and puts the thrown text in `detail`; `mayHaveLanded`
  // is ours (the registry rows are written before this catch runs).
  assert.equal(res.body.error, "deploy failed");
  assert.equal(res.body.code, "DEPLOY_INTERNAL");
  assert.match(String(res.body.detail), /ledger write exploded/, "the detail names the failure");
  assert.equal(res.body.mayHaveLanded, true, "the registry rows are already written — say so");

  // The write really did land before the throw, so "may have landed" is honest
  // rather than a blanket hedge.
  assert.ok(stub.written.length > 0, "the descriptor reached the registry before the throw");
  assert.ok(
    stub.written.some((w) => String(w.path).includes("throw-agent")),
    "the deployed agent's path is among the written descriptors",
  );

  // The deployment row itself never landed — the caller can retry without
  // guessing, which is why the flag is "may have", not "did".
  assert.equal(realRecord && registry.deployments(id).length, 0, "no deployment row was recorded");
});
