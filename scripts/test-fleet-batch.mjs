// Unit tests for POST /api/fleets/batch (add-agent-teams-management D3).
//
// The batch endpoint executes the PATCH /:id state semantics per fleet,
// serially, and answers 200 with per-item results — partial failure is a
// business result. This file pins:
//   - shape gates: invalid action / ids shape → 400 whole batch, nothing runs
//   - the limit gate: over FLEET_BATCH_MAX unique ids → 400 whole batch
//   - happy path: pause/resume across fleets, dedupe (repeated id runs once)
//   - terminal semantics: an archived fleet fails its own item, others run
//   - ownership: a foreign id answers "not found" and leaks nothing
//   - 401 with auth-on and no identity
//
// Run: node --test scripts/test-fleet-batch.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-batch-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const {
  createFleetDatabase,
  setFleetDatabase,
} = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true }),
  isBusy: () => false,
});

test.after(() => {
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let fleetDb;
function freshFleetDb() {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
  return fleetDb;
}
freshFleetDb();

function makeFleet(name, ownerEmail = "owner@test") {
  return fleetDb.createFleet({
    id: `fleet_${Math.random().toString(36).slice(2, 8)}`,
    name,
    ownerEmail,
  });
}

function makeResolver() {
  return () => ({ alive: false, label: "" });
}

async function startServer({ userHeader = true } = {}) {
  const app = express();
  app.use(express.json());
  if (userHeader) {
    app.use((req, _res, next) => {
      const u = req.headers["x-test-user"];
      if (u) req.user = { email: u, groups: [] };
      next();
    });
  }
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: makeResolver(),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": "owner@test", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

const stateOf = (id) => fleetDb.getFleet(id).state;

test("batch: shape gates answer 400 and execute nothing", async () => {
  const a = makeFleet("甲");
  const { server, call } = await startServer();
  try {
    assert.equal((await call("POST", "/api/fleets/batch", { action: "reboot", ids: [a.id] })).status, 400);
    assert.equal((await call("POST", "/api/fleets/batch", { action: "pause", ids: "nope" })).status, 400);
    assert.equal((await call("POST", "/api/fleets/batch", { action: "pause", ids: [] })).status, 400);
    assert.equal((await call("POST", "/api/fleets/batch", { action: "pause" })).status, 400);
    assert.equal((await call("POST", "/api/fleets/batch", { action: "pause", ids: [42] })).status, 400);
    assert.equal(stateOf(a.id), "active", "no shape-gated request touched any fleet");
  } finally {
    server.close();
  }
});

test("batch: over-limit ids reject the whole batch (nothing runs)", async () => {
  const a = makeFleet("限额");
  const { server, call } = await startServer();
  try {
    const tooMany = Array.from({ length: 51 }, (_, i) => `fleet_x${i}`);
    const r = await call("POST", "/api/fleets/batch", { action: "pause", ids: tooMany });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "batch_limit_exceeded");
    assert.equal(stateOf(a.id), "active", "an over-limit batch executes none of its items");
  } finally {
    server.close();
  }
});

test("batch: pause/resume happy path + dedupe + per-item state echo", async () => {
  const a = makeFleet("甲");
  const b = makeFleet("乙");
  const { server, call } = await startServer();
  try {
    const r = await call("POST", "/api/fleets/batch", { action: "pause", ids: [a.id, b.id, a.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.summary, { ok: 2, failed: 0 }, "repeated id runs once (dedupe)");
    assert.equal(r.body.results.length, 2);
    assert.ok(r.body.results.every((x) => x.ok && x.state === "paused"));
    assert.equal(stateOf(a.id), "paused");
    assert.equal(stateOf(b.id), "paused");

    const up = await call("POST", "/api/fleets/batch", { action: "resume", ids: [a.id, b.id] });
    assert.equal(up.body.summary.ok, 2);
    assert.equal(stateOf(a.id), "active");
    assert.equal(stateOf(b.id), "active");
  } finally {
    server.close();
  }
});

test("batch: archived fleet fails its own item, the rest still run", async () => {
  const gone = makeFleet("已归档");
  const live1 = makeFleet("甲");
  const live2 = makeFleet("乙");
  fleetDb.updateFleet(gone.id, { state: "archived" }, { actor: "test", via: "fixture" });
  const { server, call } = await startServer();
  try {
    const r = await call("POST", "/api/fleets/batch", { action: "resume", ids: [gone.id, live1.id, live2.id] });
    assert.equal(r.status, 200, "partial failure is a business result, not a request error");
    assert.deepEqual(r.body.summary, { ok: 2, failed: 1 });
    const failed = r.body.results.find((x) => x.id === gone.id);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /archived is terminal/i);
    assert.ok(r.body.results.filter((x) => x.ok).every((x) => x.state === "active"));
    assert.equal(stateOf(live1.id), "active", "the archived item did not stop the others");
  } finally {
    server.close();
  }
});

test("batch: foreign/unknown ids answer not-found and leak nothing", async () => {
  const mine = makeFleet("我的");
  const foreign = makeFleet("别人的", "someone-else@test");
  const { server, call } = await startServer();
  try {
    const r = await call("POST", "/api/fleets/batch", {
      action: "pause",
      ids: [foreign.id, "fleet_missing", mine.id],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.summary, { ok: 1, failed: 2 });
    const foreignResult = r.body.results.find((x) => x.id === foreign.id);
    assert.equal(foreignResult.ok, false);
    assert.equal(foreignResult.error, "not found", "same answer for foreign and missing");
    assert.equal(JSON.stringify(r.body).includes("别人的"), false, "no foreign fleet content leaks");
    assert.equal(stateOf(mine.id), "paused");
    assert.equal(stateOf(foreign.id), "active", "the foreign fleet is untouched");
  } finally {
    server.close();
  }
});

test("batch: 401 with auth-on and no identity", async () => {
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: true,
    fleetTargetResolver: makeResolver(),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/fleets/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause", ids: ["fleet_x"] }),
    });
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});
