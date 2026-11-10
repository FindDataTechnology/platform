#!/usr/bin/env node
// ── Deploy harness gate (add-harness-adapter D5) ─────────────────────────────
//
// The runner-hostability gate, mirroring the model roster gate: a deployment
// whose effective harness (deploy override, else the serving declaration) is
// not in the PLACED runner's reported harness set is refused with
// HARNESS_NOT_HOSTED naming both; an unknowable set (older runner, board
// down) degrades open. Drives the REAL deploy route (gateway/packs.js)
// against the registry stub shape, with the fleet scheduler armed and the
// board stubbed at the global-fetch seam.
//
//   node --test scripts/test-deploy-harness-gate.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

process.env.FLEET_SCHEDULER_ENABLED = "1";
process.env.FLEET_BOARD_URL = "http://board.test";
process.env.AGENT_SERVING_RUNNER_URL = "http://runner:8790";
process.env.AGENT_SERVING_DEFAULT_RUNNER_ID = "runner-x";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "harness-gate-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function registryStub() {
  const agents = new Map();
  return {
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      if (url === "/api/agents/register" && init.method === "POST") {
        agents.set(body.path, body);
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      let m = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (m && init.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ message: "ok", path: m[1], is_enabled: true }) };
      }
      m = url.match(/^\/api\/agents\/(.+)$/);
      if (m && (init.method === "PUT" || init.method === "POST")) {
        agents.set(m[1], body);
        return { ok: true, status: 200, json: async () => ({ path: m[1], ...body }) };
      }
      if (m && !init.method) {
        if (agents.has(m[1])) return { ok: true, status: 200, json: async () => agents.get(m[1]) };
        return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      }
      if (url === "/api/agents" && !init.method) {
        return { ok: true, status: 200, json: async () => ({ agents: Array.from(agents.values()) }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: `no stub route ${init.method} ${url}` }) };
    },
  };
}

function billingStub() {
  return {
    baseUrl: "http://sub2api.test",
    adminKey: "admin-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/api/v1/admin/users?")) {
        return { ok: true, status: 200, json: async () => ({ data: { items: [{ id: 42, email: "author@x" }] } }) };
      }
      if (/\/api\/v1\/admin\/users\/\d+$/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 42, email: "author@x", balance: 5, status: "active" } }) };
      }
      if (u.includes("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-v4.1-flash" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
}

// One manifest per test: the serving declaration's harness is what the gate
// reads when no deploy-time override is present.
const manifestFor = (declaredHarness) => ({
  name: "harness-gate probe",
  skills: [],
  agents: [
    {
      id: "gate-agent",
      name: "G",
      persona: "p",
      serving: { protocol: "a2a", ...(declaredHarness ? { harness: declaredHarness } : {}) },
    },
  ],
});

function withGlobalFetch(board, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("http://board.test")) {
      if (board?.fail) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => board.doc };
    }
    if (u.startsWith("https://mcp.example.test/api/agents")) {
      return { ok: true, status: 200, json: async () => ({ agents: [] }) };
    }
    return original(url, init);
  };
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      globalThis.fetch = original;
    }
  };
}

async function deployOnce({ board, declaredHarness = null, harnesses = null }) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest: manifestFor(declaredHarness) });
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
      fetchImpl: registryStub().fetch,
      sub2api: billingStub(),
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = withGlobalFetch(board, async () => {
    const r = await fetch(`${base}/api/packs/${id}/versions/1/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billingKeys: { "gate-agent": "sk-testkey-00000000000000000000000001" },
        ...(harnesses ? { harnesses } : {}),
      }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  try {
    return await run();
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    registry.close();
  }
}

const boardWith = (harness) => ({
  doc: {
    runners: {
      "runner-x": {
        seen_at: Date.now(),
        children: 0,
        budget_mb: 0,
        budget_mb_limit: 3328,
        models: ["deepseek-v4.1-flash"],
        ...(harness ? { harness } : {}),
      },
    },
  },
});

test("a declared harness the runner does not host is refused naming both", async () => {
  const out = await deployOnce({ board: boardWith(["dsh"]), declaredHarness: "acp-claude-code" });
  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.equal(out.body.code, "HARNESS_NOT_HOSTED");
  assert.match(out.body.error, /harness 'acp-claude-code' is not hosted by runner 'runner-x'/);
  assert.match(out.body.error, /hosted: dsh/);
});

test("a hosted harness passes the gate", async () => {
  const out = await deployOnce({ board: boardWith(["dsh", "acp-claude-code"]), declaredHarness: "acp-claude-code" });
  assert.notEqual(out.body.code, "HARNESS_NOT_HOSTED", JSON.stringify(out.body));
  assert.ok(out.status < 400, `deploy should pass (got ${out.status}: ${JSON.stringify(out.body).slice(0, 200)})`);
});

test("a deploy-time harness override is what the gate checks", async () => {
  // Declaration says dsh (hosted); the override says otherwise → refused.
  const out = await deployOnce({ board: boardWith(["dsh"]), declaredHarness: null, harnesses: { "gate-agent": "acp-codex" } });
  assert.equal(out.body.code, "HARNESS_NOT_HOSTED", JSON.stringify(out.body));
  assert.match(out.body.error, /harnesses\.gate-agent/);
});

test("an unknown harness set degrades open (older runner / board down)", async () => {
  const noField = await deployOnce({ board: boardWith(null), declaredHarness: "acp-claude-code" });
  assert.notEqual(noField.body.code, "HARNESS_NOT_HOSTED", "a runner without the field must not block");
  const boardDown = await deployOnce({ board: { fail: true }, declaredHarness: "acp-claude-code" });
  assert.notEqual(boardDown.body.code, "HARNESS_NOT_HOSTED", "an unreachable board must not block");
});

test("no harness declared and none overridden: the gate is inert", async () => {
  const out = await deployOnce({ board: boardWith(["dsh"]), declaredHarness: null });
  assert.notEqual(out.body.code, "HARNESS_NOT_HOSTED");
  assert.ok(out.status < 400, JSON.stringify(out.body).slice(0, 200));
});

test("a malformed harnesses body is refused at the shape stage", async () => {
  const out = await deployOnce({ board: boardWith(["dsh"]), declaredHarness: null, harnesses: { "gate-agent": 42 } });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /harness must be a harness name/);
});

test("the declaration survives the REAL publish route (validator + gate agree)", async () => {
  // The first drill published via registry.publish(), which skips
  // validateManifest — so the gate read a serving.harness the writer refused
  // (live probe 2026-10-14: publish → 400 "serving has unknown key 'harness'").
  // This drives the real POST /api/packs with the declared harness, then the
  // real deploy route on the result.
  const file = path.join(tmpRoot, `packs-publish-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => ({ email: "author@x", groups: ["creators"] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: ["creators"],
    adminGroups: [],
    deployConfig: {
      registryUrl: "https://mcp.example.test",
      token: "t",
      runnerBaseUrl: "http://runner:8790",
      packsPublicBase: "https://packs.example.test",
      fetchImpl: registryStub().fetch,
      sub2api: billingStub(),
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pub = await fetch(`${base}/api/packs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: manifestFor("acp-claude-code") }),
    });
    const pubBody = await pub.json().catch(() => ({}));
    assert.equal(pub.status, 200, `a declared harness must publish (got ${pub.status}: ${JSON.stringify(pubBody).slice(0, 240)})`);
    const run = withGlobalFetch(boardWith(["dsh"]), async () => {
      const r = await fetch(`${base}/api/packs/${pubBody.id}/versions/${pubBody.version}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billingKeys: { "gate-agent": "sk-testkey-00000000000000000000000001" } }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    const out = await run();
    assert.equal(out.body.code, "HARNESS_NOT_HOSTED", JSON.stringify({ status: out.status, body: out.body }).slice(0, 400));
    assert.match(out.body.error, /harness 'acp-claude-code' is not hosted by runner 'runner-x'/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    registry.close();
  }
});
