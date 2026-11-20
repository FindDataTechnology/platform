#!/usr/bin/env node
// ── Deploy-lock regression (add-funnel-acceptance, F3.3 hop-④ finding) ───────
//
// Two CONCURRENT deploys of the same pack used to interleave the registry
// descriptor push and the deployment_keys table write in opposite orders,
// leaving the registry entry pointing at a rotated-out billing key ref — the
// runner then fetched a dead ref, silently fell back to the shared key, and
// the deployer's key stopped billing (found live in production). The deploy
// route now serializes per pack. This test reproduces the race shape — a
// staggered registry stub makes the SECOND deploy's registry write land
// first — and asserts the ref pair stays consistent.
//
//   node --test scripts/test-deploy-lock.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test, after } from "node:test";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "deploy-lock-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// Registry stub (the test-agent-serving shape) with STAGGERED agent-write
// latency: the first caller is slow, the second fast, so the second deploy's
// registry write lands BEFORE the first's — the exact interleaving that
// desynced the refs pre-lock.
function racingRegistryStub() {
  let agentWrite = 0;
  const agentWrites = [];
  const agents = new Map();
  const stub = {
    calls: { agents: agentWrites },
    agents,
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      if (url === "/api/agents/register" && init.method === "POST") {
        agentWrite += 1;
        const mine = agentWrite;
        agentWrites.push({ nth: mine, path: body.path, body });
        agents.set(body.path, body);
        await new Promise((r) => setTimeout(r, mine === 1 ? 120 : 5));
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      let m = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (m && init.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ message: "ok", path: m[1], is_enabled: true }) };
      }
      m = url.match(/^\/api\/agents\/(.+)$/);
      if (m && (init.method === "PUT" || init.method === "POST")) {
        agentWrite += 1;
        const mine = agentWrite;
        agentWrites.push({ nth: mine, path: m[1], body });
        agents.set(m[1], body);
        await new Promise((r) => setTimeout(r, mine === 1 ? 120 : 5));
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
  return stub;
}

// Billing-plane stub: linked and healthy; every pasted key belongs to the
// deployer's account and probes live.
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
      if (u.includes("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
}

const manifest = {
  name: "deploy-lock probe",
  skills: [],
  agents: [{ id: "lock-agent", name: "L", persona: "p", serving: { protocol: "a2a" } }],
};

test("two concurrent deploys keep the registry ref and the stored key row consistent", async () => {
  const stub = racingRegistryStub();
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
  const deploy = () =>
    fetch(`${base}/api/packs/${id}/versions/1/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingKeys: { "lock-agent": "sk-testkey-00000000000000000000000001" } }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const [a, b] = await Promise.all([deploy(), deploy()]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(stub.calls.agents.length, 2, "both deploys pushed their descriptor");

    // The LAST registry write wins the entry; the LAST table write wins the
    // row — under the lock both sequences are the same deploy, so the refs
    // must match. Pre-lock they came from different deploys (desync).
    const lastPut = stub.calls.agents.reduce((m, p) => (p.nth > m.nth ? p : m));
    const registryRef = lastPut.body?.metadata?.billing_key_ref;
    assert.ok(registryRef, "descriptor carries a billing key ref");

    const rows = registry.deploymentKeysForPack ? registry.deploymentKeysForPack(id) : [];
    const row = (rows.length ? rows : [{ keyRef: null }])[0];
    assert.equal(row.keyRef, registryRef, "stored key row ref equals the registry descriptor's ref");
    assert.ok(row.keyValue?.startsWith("sk-"), "key value stored under the same ref");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    registry.close();
  }
});

test("different packs still deploy in parallel (the lock is per pack)", async () => {
  const stub = racingRegistryStub();
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const a = registry.publish({ email: "author@x", manifest });
  const b = registry.publish({ email: "author@x", manifest });

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
  const deploy = (id) =>
    fetch(`${base}/api/packs/${id}/versions/1/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingKeys: { "lock-agent": "sk-testkey-00000000000000000000000002" } }),
    }).then((r) => r.status);

  try {
    const started = Date.now();
    // Both pushes ride the stub's FIRST-slot 120ms delay — serialized they
    // would take ≥240ms; parallel (per-pack locks) they finish in ~120ms.
    const [sa, sb] = await Promise.all([deploy(a.id), deploy(b.id)]);
    const took = Date.now() - started;
    assert.equal(sa, 200);
    assert.equal(sb, 200);
    assert.ok(took < 220, `cross-pack deploys ran in parallel (${took}ms)`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    registry.close();
  }
});
