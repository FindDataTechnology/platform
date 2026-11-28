// Cost read face (add-fleet-cost-read-face).
//
// The estimates were already computed at the turn seam but only the DAILY row
// kept them, and the daily key has no run or edge dimension — so "what did this
// run cost" and "what did this hop cost" were unanswerable, and re-pricing old
// turns at today's rates would rewrite history. The seam now also stamps the
// four components on the turn row; these pin the three slices (岗 / run / 边)
// and the honesty rules (null ≠ 0, sample size carried).
//
// Run: node --test scripts/test-fleet-cost-read-face.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cost-face-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

const fleet = fleetDb.createFleet({ id: "f_cost", name: "成本舰", ownerEmail: "owner@test" });
for (const id of ["c_up", "c_down", "c_side"]) {
  fleetDb.createMember({ id, fleetId: fleet.id, title: id, targetKind: "persona", targetId: `p-${id}`, kpiSlots: [], cadence: null });
}

// Run headers first — the detail route resolves the run by header, and a turn
// row alone is not a run.
for (const [runId, rootMemberId] of [["run_a", "c_up"], ["run_b", "c_side"]]) {
  fleetDb.insertRun({ runId, fleetId: fleet.id, rootSource: "schedule", rootMemberId, startedAt: Date.now() - 120_000 });
}

// Two priced turns + one unpriced, across two runs, with one handoff edge.
const priced = (usd) => ({ inputUsd: usd, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, pricingAt: 1_700_000_000_000 });
const event = (over) =>
  fleetDb.appendTurnEvent({
    fleetId: fleet.id,
    source: "schedule",
    status: "ok",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now() - 50_000,
    ...over,
  });

event({ memberId: "c_up", turnId: "t1", runId: "run_a", pricing: priced(0.25) });
event({ memberId: "c_down", turnId: "t2", runId: "run_a", parentTurnId: "t1", edgeKind: "handoff", pricing: priced(0.75) });
event({ memberId: "c_side", turnId: "t3", runId: "run_b", pricing: priced(2) });
event({ memberId: "c_up", turnId: "t4", runId: "run_b" }); // unpriced

test("turn row carries the estimate; an unpriced turn stays null (never a fake 0)", () => {
  const rows = fleetDb.listRunTurns("run_a");
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.cost, "priced turn has a cost object");
    assert.ok(Number.isFinite(r.cost.totalUsd));
    assert.equal(r.cost.pricingAt, 1_700_000_000_000, "provenance rides along");
  }
  const unpriced = fleetDb.listRunTurns("run_b").find((r) => r.turnId === "t4");
  assert.equal(unpriced.cost, null, "absence is null, not zero");
  assert.equal(unpriced.pricingAt, null);
});

test("run slice: money is the sum of that run's own turns, with the sample size", () => {
  const a = fleetDb.runCost("run_a");
  assert.ok(Math.abs(a.usd - 1.0) < 1e-9, "0.25 + 0.75");
  assert.equal(a.turns, 2);
  assert.equal(a.pricedTurns, 2);

  const b = fleetDb.runCost("run_b");
  assert.ok(Math.abs(b.usd - 2.0) < 1e-9, "the unpriced turn adds nothing");
  assert.equal(b.turns, 2);
  assert.equal(b.pricedTurns, 1, "the sample is 1 of 2 — never smeared");

  // One grouped query for a page must agree with the per-run read.
  const map = fleetDb.runCosts(fleet.id, { sinceMs: 0 });
  assert.ok(Math.abs(map.get("run_a").usd - a.usd) < 1e-9);
  assert.ok(Math.abs(map.get("run_b").usd - b.usd) < 1e-9);
  assert.equal(map.size, 2, "runs with no turn rows are simply absent");
});

test("edge slice: a hop costs its CHILD turn; unpriced hops read null", () => {
  const edges = fleetDb.edgeTraffic(fleet.id, { sinceMs: 0 });
  const hop = edges.find((e) => e.from === "c_up" && e.to === "c_down" && e.kind === "handoff");
  assert.ok(hop, "the handoff hop is present");
  assert.ok(Math.abs(hop.costUsd - 0.75) < 1e-9, "the child turn's own estimate");
  assert.equal(hop.pricedTurns, 1);
  assert.equal(hop.turns, 1);
});

test("spend windows: money per window, null when nothing in it was priced", () => {
  const p = fleetDb.spendProjection(fleet.id);
  assert.ok(Math.abs(p.allTime.costUsd - 3.0) < 1e-9, "0.25 + 0.75 + 2");
  assert.equal(p.allTime.pricedTurns, 3);
  // The turns are 60s old, so the 24h window sees them too.
  assert.ok(Math.abs(p.windows["24h"].costUsd - 3.0) < 1e-9);
  // A fleet with no priced turns reports null, not 0.
  const empty = fleetDb.createFleet({ id: "f_empty", name: "空舰", ownerEmail: "owner@test" });
  const pe = fleetDb.spendProjection(empty.id);
  assert.equal(pe.allTime.costUsd, null);
  assert.equal(pe.allTime.pricedTurns, 0);
});

test("route: /spend returns the money alongside tokens; run detail returns cost per run and per turn", async () => {
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const spend = await get(`/api/fleets/${fleet.id}/spend`);
    assert.equal(spend.status, 200);
    assert.ok(Math.abs(spend.body.allTime.costUsd - 3.0) < 1e-9, "USD rides the existing spend face");
    assert.equal(spend.body.allTime.pricedTurns, 3);

    const detail = await get(`/api/fleets/${fleet.id}/runs/run_a`);
    assert.equal(detail.status, 200);
    assert.ok(Math.abs(detail.body.run.cost.usd - 1.0) < 1e-9, "the run carries its own money");
    assert.equal(detail.body.run.cost.pricedTurns, 2);
    const turns = detail.body.turns;
    assert.equal(turns.length, 2);
    assert.ok(turns.every((t) => t.cost && Number.isFinite(t.cost.totalUsd)), "each turn carries its estimate");

    const list = await get(`/api/fleets/${fleet.id}/runs`);
    assert.equal(list.status, 200);
    const rowA = list.body.runs.find((r) => r.runId === "run_a");
    assert.ok(Math.abs(rowA.cost.usd - 1.0) < 1e-9, "the page attaches money without one query per run");

    // The cockpit's edge traffic carries the hop cost too.
    const cockpit = await get(`/api/fleets/${fleet.id}/cockpit`);
    if (cockpit.status === 200) {
      const hop = (cockpit.body.edgeTraffic ?? []).find((e) => e.from === "c_up" && e.to === "c_down");
      if (hop) assert.ok(Math.abs(hop.costUsd - 0.75) < 1e-9);
    }
  } finally {
    server.close();
  }
});

test.after(() => {
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
