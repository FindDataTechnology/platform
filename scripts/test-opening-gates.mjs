#!/usr/bin/env node
// ── Opening gates (add-opening-gates) ────────────────────────────────────────
//
// Two pre-opening engineering pieces, both defaulting to the current contract:
//   1. PACK_ACCESS_MODE (closed default): publish/deploy identity gate. closed
//      = byte-identical creator-group refusals; open = any authenticated user.
//   2. FLEET_CAPACITY_WATERLINE_MB (512 default): a deploy bringing NEW
//      children is refused when the best target runner's headroom is below
//      the line; redeploys/upgrades skip; unknowable capacity degrades open.
//
//   node --test scripts/test-opening-gates.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

// Armed scheduler + a seeded fleet row, BEFORE the packs module loads (both
// are read at registration / registry-creation time).
process.env.FLEET_SCHEDULER_ENABLED = "1";
process.env.FLEET_BOARD_URL = "http://board.test";
process.env.AGENT_SERVING_RUNNER_URL = "http://runner:8790";
process.env.AGENT_SERVING_DEFAULT_RUNNER_ID = "runner-x";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "opening-gates-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

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

function billingStub() {
  return {
    baseUrl: "http://sub2api.test",
    adminKey: "admin-test",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/api/v1/admin/users?")) {
        // Echo the searched email back — every identity resolves an account
        // (the billing plane is orthogonal to the opening gates under test).
        const email = decodeURIComponent(new URL(u, "http://x").searchParams.get("search") || "author@x");
        return { ok: true, status: 200, json: async () => ({ data: { items: [{ id: 42, email }] } }) };
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

const manifest = {
  name: "opening-gates probe",
  skills: [],
  agents: [{ id: "gate-agent", name: "G", persona: "p", serving: { protocol: "a2a" } }],
};

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

// One server: registry + routes, with a per-test identity seam and the SAME
// registry row across calls (deploy twice = the redeploy/upgrade case).
async function boot({ board, user, deployFirst = false }) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest });
  const stub = registryStub();
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
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
  const call = (p, init = {}) =>
    withGlobalFetch(board, async () => {
      const r = await fetch(`${base}${p}`, init);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    })();
  const deployBody = JSON.stringify({
    billingKeys: { "gate-agent": "sk-testkey-00000000000000000000000001" },
    models: { "gate-agent": "deepseek-v4.1-flash" },
  });
  const deploy = () => call(`/api/packs/${id}/versions/1/deploy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: deployBody });
  const publish = (m) => call("/api/packs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: m }) });
  if (deployFirst) await deploy(); // seed an in-service agent for the upgrade case
  return {
    id, stub, registry, deploy, publish,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      registry.close();
    },
  };
}

const boardWith = ({ headroom = 3328, models = ["deepseek-v4.1-flash"] } = {}) => ({
  doc: { runners: { "runner-x": { seen_at: Date.now(), children: 0, budget_mb: 3328 - headroom, budget_mb_limit: 3328, models } } },
});

// ── 1. access mode ──────────────────────────────────────────────────────────

test("closed (default): non-creator publish and deploy refusals are byte-identical", async () => {
  delete process.env.PACK_ACCESS_MODE;
  const h = await boot({ board: boardWith(), user: { email: "stranger@x", groups: [] } });
  try {
    const pub = await h.publish(manifest);
    assert.equal(pub.status, 403);
    assert.equal(pub.body.error, "Creator group required");
    const dep = await h.deploy();
    assert.equal(dep.status, 403);
    assert.equal(dep.body.error, "Pack author or creator group required");
    assert.equal(h.stub.writes.length, 0);
  } finally {
    await h.close();
  }
});

test("open: a non-creator publishes and deploys under their own identity", async () => {
  process.env.PACK_ACCESS_MODE = "open";
  try {
    const h = await boot({ board: boardWith(), user: { email: "stranger@x", groups: [] } });
    try {
      const pub = await h.publish(manifest);
      assert.equal(pub.status, 200, JSON.stringify(pub.body));
      assert.ok(pub.body.id, "pack stored");
      // The stranger's own pack now deploys (author path) with every
      // downstream gate intact (billing key + model lane + roster here).
      const dep = await h.deploy();
      assert.equal(dep.status, 200, JSON.stringify(dep.body));
      assert.equal(h.stub.writes.length, 1);
    } finally {
      await h.close();
    }
  } finally {
    delete process.env.PACK_ACCESS_MODE;
  }
});

test("open: the identity gate opens; ownership and visibility rules stay untouched", async () => {
  process.env.PACK_ACCESS_MODE = "open";
  try {
    // Pack authored by author@x; deployer is a stranger. Open mode admits the
    // identity (the same latitude creators already had); the deployment still
    // bills against the stranger's own key and records them as its deployer —
    // the facet-side IN_SERVICE rule governs foreign takeovers, not this gate.
    const h = await boot({ board: boardWith(), user: { email: "stranger@x", groups: [] } });
    try {
      const dep = await h.deploy();
      assert.equal(dep.status, 200, JSON.stringify(dep.body));
    } finally {
      await h.close();
    }
  } finally {
    delete process.env.PACK_ACCESS_MODE;
  }
});

// ── 2. capacity waterline ───────────────────────────────────────────────────

test("waterline: a new-child deploy below the line is refused with FLEET_AT_CAPACITY", async () => {
  delete process.env.PACK_ACCESS_MODE;
  const h = await boot({ board: boardWith({ headroom: 100 }), user: { email: "author@x", groups: [] } });
  try {
    const dep = await h.deploy();
    assert.equal(dep.status, 503, JSON.stringify(dep.body));
    assert.equal(dep.body.code, "FLEET_AT_CAPACITY");
    assert.match(dep.body.error, /best runner 'runner-x' has 100MB headroom, below the 512MB waterline/);
    assert.equal(h.stub.writes.length, 0, "nothing was written to the registry");
  } finally {
    await h.close();
  }
});

test("waterline: at or above the line admits the deploy", async () => {
  const h = await boot({ board: boardWith({ headroom: 512 }), user: { email: "author@x", groups: [] } });
  try {
    const dep = await h.deploy();
    assert.equal(dep.status, 200, JSON.stringify(dep.body));
  } finally {
    await h.close();
  }
});

test("waterline: an in-service pack's redeploy skips the gate (capacity never wedges a live service)", async () => {
  // Seed in service with a healthy board, then starve the board and the
  // redeploy must still pass (the pack's agent is already in service).
  const board = boardWith();
  const h = await boot({ board, user: { email: "author@x", groups: [] }, deployFirst: true });
  try {
    h.stub.writes.length = 0;
    board.doc = boardWith({ headroom: 10 }).doc; // the fleet starves
    await new Promise((r) => setTimeout(r, 10_300)); // boardNow cache TTL
    const again = await h.deploy();
    assert.equal(again.status, 200, JSON.stringify(again.body));
  } finally {
    await h.close();
  }
});

test("waterline: unknowable capacity (board down) degrades open", async () => {
  const h = await boot({ board: { fail: true }, user: { email: "author@x", groups: [] } });
  try {
    const dep = await h.deploy();
    assert.equal(dep.status, 200, JSON.stringify(dep.body));
  } finally {
    await h.close();
  }
});

test("waterline: a custom threshold is honored", async () => {
  process.env.FLEET_CAPACITY_WATERLINE_MB = "4096";
  try {
    const h = await boot({ board: boardWith({ headroom: 3328 }), user: { email: "author@x", groups: [] } });
    try {
      const dep = await h.deploy();
      assert.equal(dep.status, 503, JSON.stringify(dep.body));
      assert.equal(dep.body.code, "FLEET_AT_CAPACITY");
      assert.match(dep.body.error, /below the 4096MB waterline/);
    } finally {
      await h.close();
    }
  } finally {
    delete process.env.FLEET_CAPACITY_WATERLINE_MB;
  }
});
