#!/usr/bin/env node
// ── Deploy tenancy tests (add-deploy-tenancy) ────────────────────────────────
//
// A deployment is the deployer's asset: the second deployer of the same pack
// gets their own address, key binding, and matter queue without touching the
// first deployer's. The author's deploy keeps the legacy unsuffixed path,
// byte for byte. Lifecycle actions (pause) belong to the row's deployer.
//
//   node --test scripts/test-deploy-tenancy.mjs

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "deploy-tenancy-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// The tenancy journey runs under the OPEN gate (M5.2): non-creators deploy.
process.env.PACK_ACCESS_MODE = "open";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";

const MANIFEST = {
  name: "租户包",
  description: "tenancy 验证",
  visibility: "public",
  category: "company",
  tags: [],
  skills: [{ name: "corpus-t", description: "语料", content: "# 语料\n正文。" }],
  agents: [{ id: "reception", name: "接待", persona: "测试。", serving: { protocol: "a2a" } }],
};

async function harness() {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest: MANIFEST });
  const app = express();
  const wire = { calls: { agents: [] }, agents: new Map() };
  registerPackRoutes(app, {
    registry,
    resolveUser: (req) => {
      const email = req.headers["x-test-user"];
      return email ? { email, groups: email === "author@x" ? ["creators"] : email === "admin@x" ? ["admin"] : [] } : null;
    },
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: {
      registryUrl: "https://mcp.example.test", token: "runner-svc-token",
      runnerBaseUrl: "http://runner.tailnet", packsPublicBase: "https://packs.example.test",
      fetchImpl: async (rawUrl, init = {}) => {
        const url = String(rawUrl).split("?")[0];
        const body = init.body ? JSON.parse(init.body) : null;
        let m = url.match(/^\/api\/agents\/(.+)$/);
        if (m && !/toggle|well-known/.test(url)) {
          if (!init.method) {
            if (wire.agents.has(m[1])) return { ok: true, status: 200, json: async () => wire.agents.get(m[1]) };
            return { ok: false, status: 404, json: async () => ({}) };
          }
          wire.calls.agents.push({ path: m[1], body });
          wire.agents.set(m[1], body);
          return { ok: true, status: 200, json: async () => ({ path: m[1], ...body }) };
        }
        if (url === "/api/agents" && !init.method) return { ok: true, status: 200, json: async () => ({ agents: Array.from(wire.agents.values()) }) };
        if (url === "/api/skills" && init.method === "POST") return { ok: true, status: 201, json: async () => ({ path: body.path }) };
        m = url.match(/^\/api\/skills\/(.+)$/);
        if (m) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: false, status: 404, json: async () => ({}) };
      },
      sub2api: null,
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    registry, packId: id, wire, base,
    close: () => new Promise((r) => server.close(r)),
    deploy: (user, version = 1) =>
      fetch(`${base}/api/packs/${id}/versions/${version}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": user },
        body: "{}",
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
    pause: (user, agentId = "reception") =>
      fetch(`${base}/api/packs/${id}/deployments/${agentId}/pause`, {
        method: "POST", headers: { "x-test-user": user },
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
    rows: () => registry.deployments(id),
  };
}

test("tenancy: two deployers get independent addresses; the first is untouched", async () => {
  const h = await harness();
  try {
    const a = await h.deploy("alice@x");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const rowA = h.rows().find((d) => d.deployedBy === "alice@x");
    assert.ok(rowA, "A's deployment row exists");
    assert.match(rowA.agentPath, /\/d[0-9a-f]{8}$/, "A's address carries the deployer segment");

    const b = await h.deploy("bob@x");
    assert.equal(b.status, 200);
    const rowA2 = h.rows().find((d) => d.deployedBy === "alice@x");
    assert.equal(rowA2.agentPath, rowA.agentPath, "A's address unchanged by B's deploy");
    const rowB = h.rows().find((d) => d.deployedBy === "bob@x");
    assert.ok(rowB && rowB.agentPath !== rowA.agentPath, "B has a distinct address");

    // Same deployer again = in-place upgrade (same address, still 2 rows).
    await h.deploy("alice@x");
    const rowA3 = h.rows().find((d) => d.deployedBy === "alice@x");
    assert.equal(rowA3.agentPath, rowA.agentPath, "A's redeploy is in-place");
    assert.equal(h.rows().filter((d) => d.agentId === "reception").length, 2, "exactly two tenant rows");

    // The two addresses reached the registry as separate agent entries —
    // the upsert path carries the /packs prefix (API surface form).
    const paths = h.wire.calls.agents.map((c) => c.path);
    assert.ok(paths.includes(rowA.agentPath.slice(1)) && paths.includes(rowB.agentPath.slice(1)), JSON.stringify(paths));
  } finally {
    await h.close();
  }
});

test("tenancy: the author's deploy keeps the legacy unsuffixed path", async () => {
  const h = await harness();
  try {
    const r = await h.deploy("author@x");
    assert.equal(r.status, 200);
    const row = h.rows().find((d) => d.deployedBy === "author@x");
    assert.equal(row.agentPath, `/packs/${h.packId}/reception`, "author path byte-identical (no deployer segment)");
  } finally {
    await h.close();
  }
});

test("tenancy: pause belongs to the row's deployer — strangers and the author are same-shape refused", async () => {
  const h = await harness();
  try {
    await h.deploy("alice@x");
    // The deployer pauses their own deployment: serving-plane configured? No
    // fetch stub for setAgentPaused's registry GET — 503 = gate passed and
    // the serving-plane check tripped, which is the tenancy assertion here.
    const own = await h.pause("alice@x");
    assert.ok([200, 503].includes(own.status), `deployer pause passes the gate (${own.status})`);

    // A stranger (and the author, who never deployed) get the same 404.
    const stranger = await h.pause("bob@x");
    const author = await h.pause("author@x");
    assert.equal(stranger.status, 404);
    assert.equal(author.status, 404);
    assert.equal(stranger.body.error, author.body.error, "same shape — existence not disclosed");

    // Admin walks through the gate to the row (200: the stub serves the
    // registry GET for the pause write).
    const admin = await h.pause("admin@x");
    assert.ok([200, 503].includes(admin.status), "admin passes the ownership gate");
  } finally {
    await h.close();
  }
});
