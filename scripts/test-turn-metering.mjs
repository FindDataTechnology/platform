// Unit tests — turn metering (add-turn-metering).
//
// Pins the spec contracts:
//   - agent-turn-metering ADDED ①: metering columns ride the SAME event row;
//     absent dimension / unreported runtime field = NULL (never 0); usage
//     细分 semantics align the upstream TokenUsage (input = UNCACHED; billed
//     input = input + cached + write);
//   - ②: spin_up_ms semantics (parked = 0, legacy = measured, no-preset =
//     NULL) — covered here at the recordTurnEvent seam; the executor-side
//     sourcing is pinned in test-persona-park-lane.mjs;
//   - ③: daily rollup upserts at the same seam, survives the明细 prune,
//     sums accumulate, maxes never regress to NULL;
//   - degrade: a metering-column failure falls back to the legacy event
//     shape — the EVENT never regresses (design D6).
//
// Run: node --test scripts/test-turn-metering.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-metering-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { recordTurnEvent } = await import("../server/fleet-events.js");
import Database from "better-sqlite3";

const DB_FILE = path.join(tmpRoot, `fleets-${Date.now()}.db`);
const db = createFleetDatabase({ file: DB_FILE });
setFleetDatabase(db);

// A minimal fleet + persona member so attribution resolves.
db.createFleet({ id: "fleet_m1", name: "计量舰队", ownerEmail: "meter@test", state: "active", decisionPolicy: null, sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null, orchestration: { posts: [], edges: [], constraints: {} }, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_meter", fleetId: "fleet_m1", title: "计量岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 0, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_roll", fleetId: "fleet_m1", title: "汇总岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 1, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_deg", fleetId: "fleet_m1", title: "降级岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 2, createdAt: Date.now(), updatedAt: Date.now() });

const job = (over = {}) => ({
  id: "job_m1",
  sessionId: "cron-m1",
  prompt: "跑",
  preset: "pack-alpha-analyst",
  targetType: "persona",
  sourceTag: { fleetId: "fleet_m1", memberId: "m_meter" },
  ...over,
});

const outcomeWith = (metering, usage = null) => ({
  ok: true,
  text: "产出",
  usage: usage ?? { input: 10, output: 5, model: "deepseek-v4.1-flash", cacheReadTokens: 100, cacheWriteTokens: 20, reasoningTokens: 7 },
  metering,
});

const record = (over = {}, outcome = null) => recordTurnEvent(db, job(over), outcome ?? outcomeWith({}), {
  startedAt: Date.now(),
  endedAt: Date.now() + 1000,
  model: "deepseek-v4.1-flash",
});

const lastRow = () => {
  const d = new Database(DB_FILE, { readonly: true });
  try {
    return d.prepare("SELECT * FROM member_turn_events ORDER BY id DESC LIMIT 1").get();
  } finally { d.close(); }
};

test("metering columns ride the event row: usage 细分, identity dims, timing — billed input sums three columns", async () => {
  const ev = record({}, outcomeWith({
    carrier: "cell", carrierInstance: null,
    queueWaitMs: 1234, spinUpMs: 0,
    provider: "volces", effort: "high",
  }));
  assert.ok(ev, "attribution resolved");
  const row = lastRow();
  assert.equal(row.carrier, "cell");
  assert.equal(row.provider, "volces");
  assert.equal(row.effort, "high");
  assert.equal(row.queue_wait_ms, 1234);
  assert.equal(row.spin_up_ms, 0, "parked path = zero restart tax");
  assert.equal(row.usage_cached_input, 100);
  assert.equal(row.usage_cache_write, 20);
  assert.equal(row.usage_reasoning, 7);
  const billedInput = row.usage_input + row.usage_cached_input + row.usage_cache_write;
  assert.equal(billedInput, 10 + 100 + 20, "billed input = input + cached + write (D4)");
  assert.equal(row.preset_id, "pack-alpha-analyst");
});

test("unreported runtime fields read as NULL, never 0; skip rows carry only queue wait", async () => {
  const ev = record({ id: "job_m2" }, {
    ok: false, skipped: true, error: "lane open",
    metering: { carrier: "cell", queueWaitMs: 55 }, usage: null,
  });
  assert.ok(ev);
  const row = lastRow();
  assert.equal(row.usage_cached_input, null, "honest absence");
  assert.equal(row.usage_reasoning, null);
  assert.equal(row.spin_up_ms, null, "skipped before persona acquisition");
  assert.equal(row.queue_wait_ms, 55);
  assert.equal(row.ttft_ms, null);
});

test("daily rollup accumulates at the same seam and survives the明细 prune", async () => {
  const read = () => {
    const d = new Database(DB_FILE, { readonly: true });
    try { return d.prepare("SELECT * FROM member_turn_daily WHERE member_id = 'm_roll'").all(); }
    finally { d.close(); }
  };
  const rollJob = (id) => job({ id, sourceTag: { fleetId: "fleet_m1", memberId: "m_roll" } });
  record(rollJob("job_m3"), outcomeWith({ carrier: "cell", provider: "volces", queueWaitMs: 100, spinUpMs: 0 }));
  record(rollJob("job_m4"), outcomeWith({ carrier: "cell", provider: "volces", queueWaitMs: 300, spinUpMs: 40 }));
  const rows = read();
  assert.equal(rows.length, 1, "same (fleet, member, carrier, provider, model, day) → one row");
  assert.equal(rows[0].turns, 2);
  assert.equal(rows[0].usage_cached_input, 200, "sums accumulate");
  assert.equal(rows[0].queue_wait_ms_max, 300, "max over turns");
  assert.equal(rows[0].spin_up_ms_max, 40);

  // A different carrier splits rows (the dimension is a KEY component).
  record(rollJob("job_m5"), outcomeWith({ carrier: "worker", carrierInstance: "worker-7", provider: "volces" }));
  const rows2 = read();
  assert.equal(rows2.length, 2);
  assert.equal(rows2.find((r) => r.carrier === "worker").turns, 1);

  // The明细 prune must never touch the daily rows (③: permanent retention).
  db.pruneTurnEventsForTest?.();
  // (the real prune is inside appendTurnEvent; simulate by direct delete)
  const d2 = new Database(DB_FILE);
  try { d2.prepare("DELETE FROM member_turn_events").run(); } finally { d2.close(); }
  const rows3 = read();
  assert.equal(rows3.length, 2, "daily rows survive the明细 wipe");
  assert.equal(rows3.find((r) => r.carrier === "cell").turns, 2);
});

test("metering degrade: an unusable metering shape falls back to the legacy event row", async () => {
  // Force the extended INSERT to fail: drop a metering column from a COPY of
  // the table the writer targets (SQLite DROP COLUMN needs no dependents).
  const d = new Database(DB_FILE);
  try { d.exec("ALTER TABLE member_turn_events DROP COLUMN ttft_ms"); } finally { d.close(); }

  const degJob = job({ id: "job_m6", sourceTag: { fleetId: "fleet_m1", memberId: "m_deg" } });
  const ev = record(degJob, outcomeWith({ carrier: "cell", queueWaitMs: 10 }));
  assert.ok(ev, "the event row still landed");
  assert.equal(ev.status, "ok");
  assert.equal(ev.metering?.queueWaitMs ?? null, null, "legacy shape reads honest NULL metering");

  const row = lastRow();
  assert.equal(row.member_id, "m_deg", "the newest row is this test's own");
  assert.equal(row.usage_input, 10, "base columns intact");
  assert.equal(row.queue_wait_ms, null, "metering column exists but the legacy insert never set it");
  assert.equal(row.ttft_ms, undefined, "the dropped column is absent from the legacy shape");

  // Restore the column so later tests (if any) see the migrated shape.
  try {
    const d2 = new Database(DB_FILE);
    try { d2.exec("ALTER TABLE member_turn_events ADD COLUMN ttft_ms INTEGER"); } finally { d2.close(); }
  } catch { /* already there */ }
});

// ── Derived-lane carrier marking (§15.115挂账 enrichment) ────────────────────
const { derivedLaneCarrier } = await import("../server/fleet-events.js");
const { resolveTaskCarrier } = await import("../server/cron-runner.js");

db.createMember({ id: "m_lane_runner", fleetId: "fleet_m1", title: "远端岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 3, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_lane_worker", fleetId: "fleet_m1", title: "工池岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 4, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_lane_cell", fleetId: "fleet_m1", title: "本胞岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 5, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_lane_a2a", fleetId: "fleet_m1", title: "市场岗", parentId: null, targetKind: "a2a", targetId: "some-market-agent", kpiSlots: [], cadence: null, sortKey: 6, createdAt: Date.now(), updatedAt: Date.now() });
db.updateMember("m_lane_runner", { carrier: "runner" });
db.updateMember("m_lane_worker", { carrier: "worker" });
db.updateMember("m_lane_cell", { carrier: "cell" });

test("derivedLaneCarrier: a2a → remote; persona maps the config vocabulary; tool carries no lane", () => {
  const fleet = db.getFleet("fleet_m1");
  const m = (id) => db.getMember(id);
  assert.equal(derivedLaneCarrier({ member: m("m_lane_a2a"), fleet, targetKind: "a2a" }), "remote", "a2a always rides the remote lane");
  assert.equal(derivedLaneCarrier({ member: m("m_lane_runner"), fleet, targetKind: "persona" }), "remote", "config runner → remote lane");
  assert.equal(derivedLaneCarrier({ member: m("m_lane_worker"), fleet, targetKind: "persona" }), "worker");
  assert.equal(derivedLaneCarrier({ member: m("m_lane_cell"), fleet, targetKind: "persona" }), "cell");
  assert.equal(derivedLaneCarrier({ member: m("m_meter"), fleet, targetKind: "persona" }), "cell", "auto collapses to the primary chain (cell)");
  assert.equal(derivedLaneCarrier({ member: m("m_deg"), fleet, targetKind: "tool" }), null, "tool targets carry no lane");
});

test("derivedLaneCarrier: layer order pinned against resolveTaskCarrier (member → fleet constraint → env default)", () => {
  const map = (rc) => (rc === "runner" ? "remote" : rc === "worker" ? "worker" : "cell");
  const fleet = db.getFleet("fleet_m1");
  // member layer wins
  for (const id of ["m_lane_runner", "m_lane_worker", "m_lane_cell", "m_meter"]) {
    const member = db.getMember(id);
    const rc = resolveTaskCarrier({ sourceTag: { fleetId: "fleet_m1", memberId: id } });
    assert.equal(derivedLaneCarrier({ member, fleet, targetKind: "persona" }), map(rc), `${id}: derived marking agrees with the dispatch resolution`);
  }
  // fleet constraint layer (member carrier unset → the fleet's wish)
  db.createFleet({
    id: "fleet_lane_fc", name: "约束舰队", ownerEmail: "meter@test", state: "active", decisionPolicy: null,
    sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null,
    orchestration: { posts: [], edges: [], constraints: { carrier: "runner" } },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  db.createMember({ id: "m_fc", fleetId: "fleet_lane_fc", title: "约束岗", parentId: null, targetKind: "persona", targetId: "pack-alpha-analyst", kpiSlots: [], cadence: null, sortKey: 0, createdAt: Date.now(), updatedAt: Date.now() });
  const fcFleet = db.getFleet("fleet_lane_fc");
  assert.equal(derivedLaneCarrier({ member: db.getMember("m_fc"), fleet: fcFleet, targetKind: "persona" }), "remote");
  assert.equal(resolveTaskCarrier({ sourceTag: { fleetId: "fleet_lane_fc", memberId: "m_fc" } }), "runner");
  // env default layer (neither member nor fleet declares)
  const prev = process.env.CELL_CARRIER_DEFAULT;
  process.env.CELL_CARRIER_DEFAULT = "worker";
  try {
    assert.equal(derivedLaneCarrier({ member: db.getMember("m_meter"), fleet, targetKind: "persona" }), "worker");
    assert.equal(resolveTaskCarrier({ sourceTag: { fleetId: "fleet_m1", memberId: "m_meter" } }), "worker");
  } finally {
    if (prev === undefined) delete process.env.CELL_CARRIER_DEFAULT; else process.env.CELL_CARRIER_DEFAULT = prev;
  }
});

test("synthetic derived row: the metering block lands on the event row and the daily rollup keys the lane", () => {
  const now = Date.now();
  const target = db.getMember("m_lane_a2a");
  const fleet = db.getFleet("fleet_m1");
  const stored = db.appendTurnEvent({
    fleetId: "fleet_m1",
    memberId: "m_lane_a2a",
    source: "manual",
    status: "failed",
    errorKind: "other",
    error: "handoff depth bound reached (3 > 2) — chain stopped before this hop",
    startedAt: now,
    endedAt: now,
    sessionId: null,
    metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
  });
  assert.ok(stored, "synthetic row stored");
  const row = lastRow();
  assert.equal(row.member_id, "m_lane_a2a");
  assert.equal(row.carrier, "remote", "the derived row carries its lane, not an honest NULL");
  assert.equal(row.carrier_instance, null, "nothing claimed a body");
  assert.equal(row.queue_wait_ms, null, "runtime fields stay honestly absent");
  assert.equal(row.usage_input, null);

  const d = new Database(DB_FILE, { readonly: true });
  try {
    const daily = d.prepare("SELECT * FROM member_turn_daily WHERE member_id = 'm_lane_a2a' AND carrier = 'remote'").all();
    assert.equal(daily.length, 1, "the daily rollup keys the lane");
    assert.equal(daily[0].failed_count, 1);
    assert.equal(daily[0].turns, 1);
  } finally { d.close(); }
});
