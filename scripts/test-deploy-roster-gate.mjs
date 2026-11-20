#!/usr/bin/env node
// ── Deploy roster gate (add-deploy-roster-gate) ──────────────────────────────
//
// The third model gate: whitelist ∩ lanes authorize a CHOICE, the roster is
// what the PLACED runner's dsh tree can resolve. A lane-passing,
// roster-absent model fails silently in the child (UNKNOWN_MODEL → empty
// answer → a billed turn that returned nothing — the F3.3 incident shape).
//
// Drives the real deploy route (gateway/packs.js) against the test-agent-
// serving registry stub shape, with the fleet scheduler armed and the board
// stubbed at the global-fetch seam (boardFetch/doRegFetch use global fetch).
//
//   node --test scripts/test-deploy-roster-gate.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

// Armed scheduler + a seeded fleet row, BEFORE any registerPackRoutes call in
// this file (both are read at registration / registry-creation time).
process.env.FLEET_SCHEDULER_ENABLED = "1";
process.env.FLEET_BOARD_URL = "http://board.test";
process.env.AGENT_SERVING_RUNNER_URL = "http://runner:8790";
process.env.AGENT_SERVING_DEFAULT_RUNNER_ID = "runner-x";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "roster-gate-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// The registry stub from test-deploy-lock (unchanged write/read semantics).
function registryStub() {
  const agents = new Map();
  const writes = [];
  return {
    writes,
    agents,
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      if (url === "/api/agents/register" && init.method === "POST") {
        writes.push(body.path);
        agents.set(body.path, body);
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      let m = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (m && init.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ message: "ok", path: m[1], is_enabled: true }) };
      }
      m = url.match(/^\/api\/agents\/(.+)$/);
      if (m && (init.method === "PUT" || init.method === "POST")) {
        writes.push(m[1]);
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

// Billing stub with BOTH models lane-authorized — the roster is the only gate
// that can refuse ling-3.1-flash (exactly the F3.3 shape).
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
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-v4.1-flash" }, { id: "inclusionai/ling-3.1-flash" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
}

const manifest = {
  name: "roster-gate probe",
  skills: [],
  agents: [{ id: "gate-agent", name: "G", persona: "p", serving: { protocol: "a2a" } }],
};

// Board/registry routing at the GLOBAL fetch seam (the scheduler's boardFetch
// and doRegFetch both use global fetch; deployConfig carries its own
// fetchImpl for the deploy's registry writes).
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
    };
  };
}

async function deployOnce({ stub, board, model }) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest });
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
        models: { "gate-agent": model },
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

const boardWith = (models) => ({ doc: { runners: { "runner-x": { seen_at: Date.now(), children: 0, budget_mb: 0, budget_mb_limit: 3328, ...(models ? { models } : {}) } } } });

test("a lane-passing but roster-absent model is refused naming the roster", async () => {
  const stub = registryStub();
  const out = await deployOnce({ stub, board: boardWith(["deepseek-v4.1-flash"]), model: "inclusionai/ling-3.1-flash" });
  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.equal(out.body.code, "MODEL_NOT_IN_ROSTER");
  assert.match(out.body.error, /model roster \(available: deepseek-v4\.1-flash\)/);
  assert.equal(stub.writes.length, 0, "no registry entry was written for the refused deploy");
});

test("a rostered model deploys through the gate", async () => {
  const stub = registryStub();
  const out = await deployOnce({ stub, board: boardWith(["deepseek-v4.1-flash"]), model: "deepseek-v4.1-flash" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(stub.writes.length, 1, "the deploy registered its agent entry");
});

test("degrade open: board unreachable, or a runner heartbeat without models", async () => {
  const stub = registryStub();
  const down = await deployOnce({ stub, board: { fail: true }, model: "inclusionai/ling-3.1-flash" });
  assert.equal(down.status, 200, JSON.stringify(down.body));
  const stub2 = registryStub();
  const oldImage = await deployOnce({ stub: stub2, board: boardWith(null), model: "inclusionai/ling-3.1-flash" });
  assert.equal(oldImage.status, 200, JSON.stringify(oldImage.body));
  assert.equal(oldImage.body.deployed?.length ?? 1, 1, "old-image runner: gate skipped, deploy proceeds");
});
