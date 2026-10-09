#!/usr/bin/env node
// ── Cross-agent delegation tests (add-agent-delegation-a2a, tasks 2.2/3.1/3.2)
//
//   a2a-client   — header contract (X-Authorization/Authorization/depth
//                  presence rules), SSE delta/message aggregation, JSON error
//                  mapping, local depth-bound refusal;
//   task-engine  — the a2a manual task (targetType/preset flow into the turn
//                  executor; both-flavors refusal);
//   route        — delegation bridge: unknown agent refused at creation,
//                  persona path intact, discovery endpoints shape.
//
//   node --test scripts/test-agent-delegation-a2a.mjs

import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "delegation-a2a-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.AGENT_SERVING_REGISTRY_TOKEN = "gw-token";
process.env.AGENT_SERVING_BACKEND_TOKEN = "agent-token";

const { runA2aTurn, a2aCredentials, DELEGATION_DEPTH_BOUND } = await import("../server/a2a-client.js");
const engine = await import("../task-engine.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── a2a-client ────────────────────────────────────────────────────────────────

function sseStub(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      handler(req, res, JSON.parse(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

test("a2a-client: credential headers; depth only on delegated calls", async () => {
  const { server, seen, port } = await sseStub((_q, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: delta\ndata: ${JSON.stringify({ parts: [{ kind: "text", text: "Hello " }] })}\n\n`);
    res.write(`event: delta\ndata: ${JSON.stringify({ parts: [{ kind: "text", text: "Hello world" }] })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify({ parts: [{ kind: "text", text: "Hello world" }] })}\n\n`);
    res.end();
  });
  try {
    const { gatewayToken, agentToken } = a2aCredentials();
    const deltas = [];
    const human = await runA2aTurn(`http://127.0.0.1:${port}/`, "hi", { contextId: "c1", gatewayToken, agentToken, onDelta: (d) => deltas.push(d) });
    assert.equal(human.text, "Hello world");
    assert.deepEqual(deltas, ["Hello ", "world"], "deltas carry only the new suffix");
    assert.equal(seen[0].headers["x-authorization"], "Bearer gw-token");
    assert.equal(seen[0].headers["authorization"], "Bearer agent-token");
    assert.equal(seen[0].headers["x-delegation-depth"], undefined, "human chats carry no depth");

    const delegated = await runA2aTurn(`http://127.0.0.1:${port}/`, "do it", { contextId: "c2", depth: 1, gatewayToken, agentToken });
    assert.equal(delegated.text, "Hello world");
    assert.equal(seen[1].headers["x-delegation-depth"], "1", "delegated calls carry depth");
  } finally {
    server.close();
  }
});

test("a2a-client: JSON error bodies map to thrown errors; local depth refusal sends nothing", async () => {
  const { server, seen, port } = await sseStub((_q, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "delegation depth bound (3) reached" } }));
  });
  try {
    const { gatewayToken, agentToken } = a2aCredentials();
    await assert.rejects(
      () => runA2aTurn(`http://127.0.0.1:${port}/`, "x", { gatewayToken, agentToken, depth: 2 }),
      /delegation depth bound/,
    );
    // The LOCAL bound fires before any request leaves.
    seen.length = 0;
    await assert.rejects(
      () => runA2aTurn(`http://127.0.0.1:${port}/`, "x", { depth: DELEGATION_DEPTH_BOUND, gatewayToken, agentToken }),
      /depth bound/,
    );
    assert.equal(seen.length, 0, "local refusal makes no network call");
    await assert.rejects(
      () => runA2aTurn(`http://127.0.0.1:${port}/`, "x", { gatewayToken: "", agentToken }),
      /service credential/,
    );
  } finally {
    server.close();
  }
});

// ── task-engine: a2a manual tasks ─────────────────────────────────────────────

test("engine: agent-targeted manual tasks carry targetType a2a into the executor", async () => {
  const turnCalls = [];
  await engine.initTaskEngine({
    broadcast: () => {},
    isBusy: () => false,
    runTurn: async (t) => {
      turnCalls.push({ targetType: t.targetType, preset: t.preset });
      return { ok: true };
    },
  });
  const created = engine.createManualTask({ prompt: "analyze", agent: "a2a-demo", sessionTitle: "远端" });
  assert.equal(created.target?.type, "a2a");
  const task = engine.listTasks().find((t) => t.target?.type === "a2a");
  assert.ok(task, "a2a task created");
  assert.equal(task.preset, "a2a-demo");
  assert.deepEqual(task.target, { type: "a2a", ref: "a2a-demo" });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(turnCalls.at(-1), { targetType: "a2a", preset: "a2a-demo" });

  assert.throws(() => engine.createManualTask({ prompt: "p", persona: "x", agent: "a2a-demo" }), /persona OR a market agent/);
});

test("engine: persisted reload keeps the a2a target type", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  engine.createManualTask({ prompt: "again", agent: "a2a-demo" });
  // The tasks file is written by a fire-and-forget atomic write chain
  // (enqueueExecution → void saveTasks()), so a fixed sleep IS the race:
  // under CI load the write can exceed it and the reload reads a stale file
  // (observed 2026-10-07, add-agent-service-config run). Poll the reload
  // instead — deterministic, still bounded.
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    await new Promise((r) => setTimeout(r, 25));
    await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
    t = engine.listTasks().find((x) => x.target?.type === "a2a");
  }
  assert.ok(t, "a2a task survives the engine reload");
});

// ── delegation route: unknown agent, persona intact, discovery ───────────────

import { registerDelegationRoutes } from "../server/routes/delegation.js";

function routeApp() {
  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    currentPreset: "standard",
    broadcast: () => {},
    sessionVersion: 0,
    sessionCollectors: new Map(),
  };
  registerDelegationRoutes(ctx);
  return app;
}

function request(app, { method = "GET", path: p = "/api/delegation/tasks", body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      import("node:http").then(({ request: httpRequest }) => {
        const r = httpRequest(
          {
            host: "127.0.0.1", port, path: p, method,
            headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
          },
          (res) => {
            let out = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (out += c));
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out || "{}") }));
          },
        );
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });
    });
  });
}

test("route: unknown agent refused at creation; persona path and discovery hold", async () => {
  const app = routeApp();
  const unknown = await request(app, { method: "POST", path: "/api/delegation/tasks", body: { agent: "ghost-agent", prompt: "x" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /unknown market agent 'ghost-agent'/);

  const both = await request(app, { method: "POST", path: "/api/delegation/tasks", body: { persona: "p", agent: "a", prompt: "x" } });
  assert.equal(both.status, 400);

  const persona = await request(app, { method: "POST", path: "/api/delegation/tasks", body: { persona: "other", prompt: "x" } });
  assert.equal(persona.status, 201);
  assert.equal(persona.body.task.target.type, "persona");

  const summary = await request(app, { path: "/api/delegation/agents?summary=1" });
  assert.equal(summary.status, 200);
  assert.equal(typeof summary.body.total, "number");

  const search = await request(app, { path: "/api/delegation/agents?search=fin" });
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body.agents));
});
