// Unit tests — turn pricing (add-turn-pricing).
//
// Pins the spec contracts:
//   - agent-turn-pricing ①: the admin door's three read shapes; the pricing
//     cache fills from 词元 and serves SYNCHRONOUSLY on the turn seam;
//     found:false caches honest absence (with the periodic retry escape);
//     degraded (no admin key) leaves the cache empty;
//   - ②: the estimate is the four-component sum at the TURN-TIME price; the
//     event row carries only the pricing_at stamp (never money); the DAILY
//     row accumulates cost ONLY for priced turns (priced-sample口径);
//   - unpriced models cost nothing and stamp nothing — never a 0 pretending.
//
// Run: node --test scripts/test-turn-pricing.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-pricing-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { recordTurnEvent } = await import("../server/fleet-events.js");
const {
  pricingFor,
  estimateTurnCost,
  refreshTurnPricing,
  setTurnPricingClientForTests,
} = await import("../server/turn-pricing.js");
import Database from "better-sqlite3";

// ── 1.1 admin door shapes ────────────────────────────────────────────────────
test("admin door: readModelPricing / listGroups / readUserUsageToday shapes", async () => {
  const calls = [];
  const client = {
    degraded: () => false,
    async readModelPricing(model) {
      calls.push(`pricing:${model}`);
      if (model === "unpriced-model") return { found: false };
      return { found: true, inputPrice: 0.000001, outputPrice: 0.000002, cacheWritePrice: 0.0000015, cacheReadPrice: 0.0000001, effortMultipliers: null };
    },
    async listGroups() { calls.push("groups"); return [{ id: 3, name: "g", rateMultiplier: 1.5 }]; },
    async readUserUsageToday(userId) { calls.push(`usage:${userId}`); return { todayActualCost: 1.23, totalActualCost: 9.9 }; },
  };
  const p1 = await client.readModelPricing("deepseek-v4.1-flash");
  assert.equal(p1.found, true);
  assert.equal(p1.inputPrice, 0.000001);
  assert.deepEqual(await client.readModelPricing("unpriced-model"), { found: false });
  assert.equal(await client.listGroups().then((g) => g[0].rateMultiplier), 1.5);
  assert.equal(await client.readUserUsageToday(42).then((u) => u.todayActualCost), 1.23);
});

// ── 1.2 cache fills and serves synchronously ─────────────────────────────────
test("pricing cache: refresh fills, pricingFor reads synchronously, unpriced stays null", async () => {
  setTurnPricingClientForTests({
    degraded: () => false,
    async readModelPricing(model) {
      if (model === "m-unpriced") return { found: false };
      return { found: true, inputPrice: 1e-6, outputPrice: 2e-6, cacheWritePrice: null, cacheReadPrice: 1e-7 };
    },
  });
  await refreshTurnPricing(["m-priced", "m-unpriced"]);
  const rates = pricingFor("m-priced");
  assert.ok(rates, "priced model served from cache");
  assert.equal(rates.input, 1e-6);
  assert.equal(rates.cacheWrite, null, "nullable component stays null");
  assert.ok(Number.isFinite(rates.pricingAt), "version stamp present");
  assert.equal(pricingFor("m-unpriced"), null, "upstream-unpriced reads as honest absence");

  // The estimate math (②): four components, missing pieces contribute zero.
  const est = estimateTurnCost({ input: 1000, output: 500, cacheReadTokens: 10000, cacheWriteTokens: 200 }, rates);
  assert.ok(Math.abs(est.inputUsd - 1000 * 1e-6) < 1e-12);
  assert.ok(Math.abs(est.outputUsd - 500 * 2e-6) < 1e-12);
  assert.ok(Math.abs(est.cacheReadUsd - 10000 * 1e-7) < 1e-12);
  assert.equal(est.cacheWriteUsd, 0, "no write price → no write cost (component absent, not a zero bill)");
  assert.equal(est.pricingAt, rates.pricingAt);

  // Refill respects the unpriced TTL: a refresh without retryUnpriced skips
  // the unpriced model (no fetch burst per turn), retryUnpriced re-probes.
  setTurnPricingClientForTests({
    degraded: () => false,
    async readModelPricing(model) {
      if (model === "m-unpriced") throw new Error("should not refetch unpriced without retry");
      return { found: true, inputPrice: 1e-6, outputPrice: 2e-6, cacheWritePrice: null, cacheReadPrice: 1e-7 };
    },
  });
  await refreshTurnPricing(["m-unpriced"]); // no retry → skipped
  await refreshTurnPricing(["m-unpriced"], { retryUnpriced: true }); // periodic window retries
  assert.equal(pricingFor("m-unpriced"), null);
});

// ── 2.1/2.2 the seam: event stamp + daily money ──────────────────────────────
const DB_FILE = path.join(tmpRoot, `fleets-${Date.now()}.db`);
const db = createFleetDatabase({ file: DB_FILE });
setFleetDatabase(db);
db.createFleet({ id: "fleet_p1", name: "价舰队", ownerEmail: "price@test", state: "active", decisionPolicy: null, sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null, orchestration: { posts: [], edges: [], constraints: {} }, createdAt: Date.now(), updatedAt: Date.now() });
db.createMember({ id: "m_price", fleetId: "fleet_p1", title: "价岗", parentId: null, targetKind: "persona", targetId: "pack-a", kpiSlots: [], cadence: null, sortKey: 0, createdAt: Date.now(), updatedAt: Date.now() });

const record = (id, model, usage) => recordTurnEvent(
  db,
  { id, sessionId: `cron-${id}`, prompt: "跑", preset: "pack-a", targetType: "persona", sourceTag: { fleetId: "fleet_p1", memberId: "m_price" } },
  { ok: true, text: "产出", usage },
  { startedAt: Date.now(), endedAt: Date.now() + 1000, model },
);

test("priced turn: event row carries the estimate AND the stamp; the daily row accumulates the same numbers", async () => {
  const ev = record("job_p1", "m-priced", { input: 1000, output: 500, cacheReadTokens: 10000, cacheWriteTokens: 200 });
  assert.ok(ev);
  assert.ok(Number.isFinite(ev.pricingAt), "the version stamp rides the event row");

  const d = new Database(DB_FILE, { readonly: true });
  try {
    const t = d.prepare("SELECT * FROM member_turn_events ORDER BY id DESC LIMIT 1").get();
    assert.equal(t.pricing_at, ev.pricingAt, "stamp on the turn row");
    // SUPERSEDES add-turn-pricing D4a (add-fleet-cost-read-face): money used to
    // live on the daily row alone, which made per-run and per-edge attribution
    // impossible — the daily key has no run/edge dimension, and re-pricing old
    // turns at today's rates would rewrite history. The same estimate now lands
    // on the turn row as well. It is still an ESTIMATE with `pricing_at`
    // provenance, never a bill; the duplication is cross-checked below so the
    // two copies cannot silently diverge.
    const eventCols = d.prepare("PRAGMA table_info(member_turn_events)").all().map((c) => c.name);
    for (const c of ["cost_input_usd", "cost_output_usd", "cost_cache_write_usd", "cost_cache_read_usd"]) {
      assert.ok(eventCols.includes(c), c);
    }
    assert.ok(Math.abs(t.cost_input_usd - 1000 * 1e-6) < 1e-12, "turn row carries the input component");
    assert.ok(Math.abs(t.cost_output_usd - 500 * 2e-6) < 1e-12, "turn row carries the output component");
    const daily = d.prepare("SELECT * FROM member_turn_daily WHERE member_id = 'm_price' AND model = 'm-priced'").get();
    assert.ok(daily, "the priced model's daily row");
    assert.ok(Math.abs(daily.cost_input_usd - 1000 * 1e-6) < 1e-12);
    assert.ok(Math.abs(daily.cost_output_usd - 500 * 2e-6) < 1e-12);
    assert.ok(Math.abs(daily.cost_cache_read_usd - 10000 * 1e-7) < 1e-12);
    assert.equal(daily.cost_cache_write_usd, 0);
    // The two copies must agree (one turn in this member's priced row so far).
    assert.ok(Math.abs(t.cost_cache_read_usd - daily.cost_cache_read_usd) < 1e-12, "turn row and daily row agree");
  } finally { d.close(); }
});

test("unpriced turn: NULL stamp, no cost contribution, turns still counted", async () => {
  const ev = record("job_p2", "m-unpriced", { input: 999, output: 999 });
  assert.ok(ev);
  assert.equal(ev.pricingAt, null, "honest absence");
  const d = new Database(DB_FILE, { readonly: true });
  try {
    // The daily KEY includes model — the unpriced model forms its OWN row with
    // zero cost and the priced row is untouched.
    const priced = d.prepare("SELECT * FROM member_turn_daily WHERE member_id = 'm_price' AND model = 'm-priced'").get();
    const unpriced = d.prepare("SELECT * FROM member_turn_daily WHERE member_id = 'm_price' AND model = 'm-unpriced'").get();
    assert.equal(priced.turns, 1);
    assert.equal(unpriced.turns, 1, "unpriced turns still count");
    assert.equal(unpriced.pricing_at, null, "no stamp");
    assert.equal(unpriced.cost_output_usd, 0, "no cost");
    assert.ok(Math.abs(priced.cost_output_usd - 500 * 2e-6) < 1e-12, "priced row untouched");
  } finally { d.close(); }
});

// ── Reconcile subject v1.1 (§15.116挂账): the billed account owns the lane key ─
const { resolveSubject } = await import("../scripts/reconcile-turn-pricing.mjs");

test("reconcile subject: lane key wins (flag labelled), owner email is the labelled v1 fallback", async () => {
  const prev = process.env.LLM_API_KEY;
  const fake = {
    findUserByKey: async (key) => (key === "sk-lane-1" ? { userId: 77, email: "lane-owner@vendor" } : null),
    findUserByEmail: async (email) => (email === "owner@test" ? { userId: 12, email: "owner@test" } : null),
  };
  try {
    delete process.env.LLM_API_KEY;
    const viaFlag = await resolveSubject({ client: fake, ownerEmail: "owner@test", explicitKey: "sk-lane-1" });
    assert.deepEqual(viaFlag, { userId: 77, email: "lane-owner@vendor", via: "--lane-key" }, "explicit key subject");

    process.env.LLM_API_KEY = "sk-lane-1";
    const viaEnv = await resolveSubject({ client: fake, ownerEmail: "owner@test" });
    assert.equal(viaEnv.userId, 77, "env lane key subject");
    assert.equal(viaEnv.via, "env LLM_API_KEY");

    // Stale/ambiguous key → labelled owner-email fallback (the v1口径 that
    // read $0 in production — kept, never silent).
    process.env.LLM_API_KEY = "sk-stale";
    const fallback = await resolveSubject({ client: fake, ownerEmail: "owner@test" });
    assert.deepEqual(fallback, { userId: 12, email: "owner@test", via: "owner-email" });

    // No key at all → same fallback.
    delete process.env.LLM_API_KEY;
    const noKey = await resolveSubject({ client: fake, ownerEmail: "owner@test" });
    assert.equal(noKey.via, "owner-email");

    // Neither lane key nor email resolves → null (the CLI exits 1).
    assert.equal(await resolveSubject({ client: fake, ownerEmail: "nobody@test" }), null);
  } finally {
    if (prev === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = prev;
  }
});

// ── v1.2 lane-view口径 (§15.116挂账 v1.2): the estimate side aligns with the
// lane-key account's scope — every cell's member_turn_daily, not one owner's.
const { allCellDbs, estimateCellDb, ownerCellDb } = await import("../scripts/reconcile-turn-pricing.mjs");

test("reconcile v1.2: allCellDbs scans the registry; estimateCellDb aggregates per cell and owner-filtered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-v12-"));
  process.env.CELL_DATA_ROOT = root;
  const reg = new Database(path.join(root, "cells-registry.db"));
  reg.exec("CREATE TABLE cell_registry (cell_id TEXT, owner_email TEXT)");
  const mkCell = (cellId, owner, fleetId, cost) => {
    reg.prepare("INSERT INTO cell_registry VALUES (?,?)").run(cellId, owner);
    const dir = path.join(root, cellId, "data", "data");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "fleets.db"));
    db.exec("CREATE TABLE fleets (id TEXT, owner_email TEXT); CREATE TABLE member_turn_daily (fleet_id TEXT, member_id TEXT, carrier TEXT, provider TEXT, model TEXT, day TEXT, turns INT, ok_count INT, failed_count INT, skipped_count INT, usage_input INT, usage_cached_input INT, usage_cache_write INT, usage_reasoning INT, usage_output INT, queue_wait_ms_sum INT, queue_wait_ms_max INT, ttft_ms_sum INT, ttft_ms_max INT, spin_up_ms_sum INT, spin_up_ms_max INT, cost_input_usd REAL, cost_output_usd REAL, cost_cache_write_usd REAL, cost_cache_read_usd REAL, pricing_at INT, updated_at INT)");
    db.prepare("INSERT INTO fleets VALUES (?,?)").run(fleetId, owner);
    db.prepare("INSERT INTO member_turn_daily VALUES (?,?,?,?,?,? ,1,1,0,0, 10,0,0,0,5, 0,0,0,0,0,0, ?,?,0,0, ?, 0)")
      .run(fleetId, "m1", "cell", "volces", "deepseek-v4.1-flash", "2026-11-01", cost * 0.25, cost * 0.75, Date.now());
    db.close();
  };
  mkCell("cell_aaaa", "owner@test", "f1", 0.0100);
  mkCell("cell_bbbb", "other@test", "f2", 0.0600);
  reg.close();

  const cells = allCellDbs();
  assert.equal(cells.length, 2, "both registered cells scanned");
  const lane = cells.map((c) => estimateCellDb(c.dbFile, "2026-11-01", null));
  const laneEst = lane.reduce((a, e) => a + e.est, 0);
  assert.ok(Math.abs(laneEst - 0.07) < 1e-9, `lane view sums every cell (got ${laneEst})`);
  assert.equal(lane.reduce((a, e) => a + e.turns, 0), 2);

  const ownerDb = ownerCellDb("owner@test");
  const owner = estimateCellDb(ownerDb, "2026-11-01", "owner@test");
  assert.ok(Math.abs(owner.est - 0.01) < 1e-9, "owner view filters to the owner's fleets");
  const share = owner.est / laneEst;
  assert.ok(Math.abs(share - 1 / 7) < 1e-6, "owner share of the lane estimate");
  delete process.env.CELL_DATA_ROOT;
});

test("reconcile v1.2: a cell without the daily table contributes honestly zero", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-v12b-"));
  process.env.CELL_DATA_ROOT = root;
  const reg = new Database(path.join(root, "cells-registry.db"));
  reg.exec("CREATE TABLE cell_registry (cell_id TEXT, owner_email TEXT)");
  reg.prepare("INSERT INTO cell_registry VALUES (?,?)").run("cell_cccc", "x@test");
  reg.close();
  const dir = path.join(root, "cell_cccc", "data", "data");
  fs.mkdirSync(dir, { recursive: true });
  new Database(path.join(dir, "fleets.db")).close(); // empty db, no member_turn_daily
  const cells = allCellDbs();
  const e = estimateCellDb(cells[0].dbFile, "2026-11-01", null);
  assert.deepEqual(e, { rows: [], est: 0, turns: 0, priced: 0 }, "honest zero, no throw");
  delete process.env.CELL_DATA_ROOT;
});
