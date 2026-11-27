// The fleet roster read's cost shape (2026-10-28, measured on production).
//
// Why this is pinned: `merged()` re-reads the registry snapshot, the installed
// pack manifests and the user presets (~30ms in a production cell). The roster
// resolves ONE target per member, so resolving against the live catalog made a
// 60-member account cost ~1.8s of synchronous work on the cell's event loop —
// the same loop that serves the chat WebSocket. Measured on production: the
// same transcript switch took 1204ms idle but 3911ms while that roster read
// was in flight, because the sidebar polls `/api/fleets` at every page load
// and every 60s.
//
// The contract under test:
//   - one catalog merge per roster request, regardless of member count
//   - the roster response carries `openDecisions` (the nav badge's only
//     source; it was missing, so the badge could never appear)
//   - `catalog.mergedView()` answers exactly what the live accessors answer
//
// Run: node --test scripts/test-fleet-roster-cost.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-roster-cost-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const catalog = await import("../catalog.js");
const { initDb } = await import("../db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");

await initDb();
const fleetDb = createFleetDatabase({});
setFleetDatabase(fleetDb);

const ctx = { authEnabled: false, cellUserEmail: "owner@test" };

async function startServer() {
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    get: (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
  };
}

const FLEET_ID = "fleet-cost-1";
const MEMBERS = 24;

fleetDb.createFleet({ id: FLEET_ID, name: "成本舰队", ownerEmail: "owner@test" });
for (let i = 0; i < MEMBERS; i += 1) {
  fleetDb.createMember({
    id: `m-cost-${i}`,
    fleetId: FLEET_ID,
    title: `岗位${i}`,
    targetKind: "persona",
    targetId: `persona-${i}`,
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
}
// One open decision: the badge count must ride the roster read.
fleetDb.appendDecision({
  id: "dec-cost-1",
  fleetId: FLEET_ID,
  memberId: "m-cost-0",
  question: "要不要继续？",
  options: ["要", "不要"],
});

test("the roster read merges the catalog once, not once per member", async () => {
  const { server, get } = await startServer();
  try {
    const before = catalog.catalogMergeCount();
    const r = await get("/api/fleets");
    const merges = catalog.catalogMergeCount() - before;

    assert.equal(r.status, 200);
    const fleet = (r.body.fleets ?? []).find((f) => f.id === FLEET_ID);
    assert.ok(fleet, "the fleet is in the roster");
    assert.equal(fleet.memberCount, MEMBERS);
    assert.equal(typeof fleet.statusCounts, "object");
    assert.equal(
      merges,
      1,
      `one merge per roster request regardless of member count (got ${merges} for ${MEMBERS} members)`,
    );
  } finally {
    server.close();
  }
});

test("the roster read carries the pending-decision count the nav badge reads", async () => {
  const { server, get } = await startServer();
  try {
    const r = await get("/api/fleets");
    const fleet = (r.body.fleets ?? []).find((f) => f.id === FLEET_ID);
    assert.equal(fleet.openDecisions, 1, "openDecisions rides the list row");
  } finally {
    server.close();
  }
});

test("mergedView answers exactly what the live catalog accessors answer", () => {
  const view = catalog.mergedView();
  const live = catalog.getChatAgentEntries();
  assert.equal(view.chatAgentEntries.length, live.length);
  assert.deepEqual(
    view.chatAgentEntries.map((e) => e.id),
    live.map((e) => e.id),
  );
  const sampleId = live[0]?.id ?? "definitely-not-an-agent";
  assert.deepEqual(view.agentEntry(sampleId), catalog.getAgentEntry(sampleId));
  assert.equal(view.agentEntry("definitely-not-an-agent"), null);
});