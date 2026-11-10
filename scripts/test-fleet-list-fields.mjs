// Unit tests for the GET /api/fleets row contract (add-agent-teams-first-class
// 3.1 / agent-teams-management). The list rows gained the three inline-editable
// config fields (defaultModel/effort/contextBudget — only-additive) and the
// spend projection (same source of truth as owner/board). This file pins:
//   - rows carry the three fields, absent = null
//   - PATCH /:id values show up in the list row (the quick-edit round-trip)
//   - spend shape matches spendProjection (windows + baseline)
//   - owner scoping unchanged
//
// Run: node --test scripts/test-fleet-list-fields.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-list-"));
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

function makeResolver() {
  return () => ({ alive: false, label: "" });
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const u = req.headers["x-test-user"];
    if (u) req.user = { email: u, groups: [] };
    next();
  });
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: makeResolver(),
    dshModels: [{ id: "glm-4.6", reasoningEfforts: ["high"] }],
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

const rowOf = (body, id) => body.fleets.find((f) => f.id === id);

test("list rows carry the three quick-edit fields, absent = null", async () => {
  const fleet = fleetDb.createFleet({ id: "fleet_l1", name: "空配置", ownerEmail: "owner@test" });
  const { server, call } = await startServer();
  try {
    const r = await call("GET", "/api/fleets");
    assert.equal(r.status, 200);
    const row = rowOf(r.body, fleet.id);
    assert.equal(row.defaultModel, null);
    assert.equal(row.effort, null);
    assert.equal(row.contextBudget, null);
    assert.ok(typeof row.memberCount === "number" && typeof row.openDecisions === "number",
      "pre-existing row contract fields unchanged");
  } finally {
    server.close();
  }
});

test("PATCH values round-trip into the list row", async () => {
  const fleet = fleetDb.createFleet({ id: "fleet_l2", name: "已配置", ownerEmail: "owner@test" });
  const { server, call } = await startServer();
  try {
    const patched = await call("PATCH", `/api/fleets/${fleet.id}`, {
      defaultModel: "glm-4.6",
      effort: "high",
      contextBudget: 120000,
    });
    assert.equal(patched.status, 200);
    const r = await call("GET", "/api/fleets");
    const row = rowOf(r.body, fleet.id);
    assert.equal(row.defaultModel, "glm-4.6");
    assert.equal(row.effort, "high");
    assert.equal(row.contextBudget, 120000);
  } finally {
    server.close();
  }
});

test("row spend matches the spendProjection shape (same source of truth)", async () => {
  const fleet = fleetDb.createFleet({ id: "fleet_l3", name: "花销", ownerEmail: "owner@test" });
  const { server, call } = await startServer();
  try {
    const r = await call("GET", "/api/fleets");
    const row = rowOf(r.body, fleet.id);
    assert.equal(row.spend.baseline, "fleet_runs projection (usage 缺失如实记 null)");
    assert.deepEqual(Object.keys(row.spend.windows).sort(), ["24h", "30d", "7d"]);
    for (const w of Object.values(row.spend.windows)) {
      assert.ok(typeof w.runs === "number" && typeof w.turns === "number");
    }
    assert.equal(row.spend.allTime.runs, 0);
  } finally {
    server.close();
  }
});

test("owner scoping unchanged: each owner sees only their rows", async () => {
  fleetDb.createFleet({ id: "fleet_l4", name: "我的", ownerEmail: "owner@test" });
  fleetDb.createFleet({ id: "fleet_l5", name: "别人的", ownerEmail: "other@test" });
  const { server, call } = await startServer();
  try {
    const mine = await call("GET", "/api/fleets");
    assert.equal(mine.body.fleets.some((f) => f.id === "fleet_l4"), true);
    assert.equal(mine.body.fleets.some((f) => f.id === "fleet_l5"), false);

    const theirs = await call("GET", "/api/fleets", undefined, { "x-test-user": "other@test" });
    assert.equal(theirs.body.fleets.some((f) => f.id === "fleet_l5"), true);
    assert.equal(theirs.body.fleets.some((f) => f.id === "fleet_l4"), false);
  } finally {
    server.close();
  }
});
