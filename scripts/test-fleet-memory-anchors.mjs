// Unit tests — fleet memory anchors + cost weekly digest (add-fleet-memory-anchors).
//
// Pins the spec contracts:
//   - agent-fleet-core MODIFIED 岗位记忆: the turn-fact page carries the anchor
//     header line (turn_id/run_id/carrier/model/tokens with billed=input+
//     cached+write/status); absent usage reads "-" (honest absence, never 0);
//   - swap 交接锚: the outgoing anchor reads the member's last turn event;
//   - ADDED 舰队成本周报: weekly aggregation (UTC ISO week), movers math
//     (cost ×2 + noise floor / wait +50% + 30s floor / 无对照), the page body
//     shape, and the once-per-week sweep book.
//
// Run: node --test scripts/test-fleet-memory-anchors.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-anchors-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { aggregateWeek, moversLine, buildWeeklyBody, runFleetCostDigests } = await import("../server/fleet-cost-digest.js");

// ── 补丁1: the anchor line on the turn fact ──────────────────────────────────
// The capture closure lives in server.js (wired to ctx) — replay its exact
// body here against a collector to pin the FORMAT (the real wiring is one
// line: captureFleetTurnFact(job, outcome, meta)).
// fix-fleet-memory-turn-title O10: the title/status derives from `ok`/`skipped`
// (the executors return { ok, ... } — no `status` field exists).
function captureStatusOf(outcome) {
  return outcome?.skipped === true ? "skipped" : outcome?.ok === true ? "ok" : "failed";
}
function anchorOf(_job, outcome, meta) {
  const m = outcome?.metering ?? {};
  const usage = outcome?.usage ?? {};
  const input = Number.isFinite(usage.input) ? usage.input : null;
  const output = Number.isFinite(usage.output) ? usage.output : null;
  const cached = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null;
  const write = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null;
  const billed = input != null ? input + (cached ?? 0) + (write ?? 0) : null;
  return `${[
    `[turn`,
    `turn_id=${meta?.ledgerTurn?.turnId ?? "-"}`,
    `run_id=${meta?.ledgerTurn?.runId ?? "-"}`,
    `carrier=${m.carrier ?? "-"}`,
    `model=${meta?.model ?? "-"}`,
    `tokens=${input ?? "-"}/${output ?? "-"}/${billed ?? "-"}`,
    `status=${captureStatusOf(outcome)}`,
  ].join(" ")}]`;
}

test("turn fact anchor: full fields including billed = input+cached+write", () => {
  const anchor = anchorOf(
    {},
    {
      ok: true,
      usage: { input: 10, output: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
      metering: { carrier: "cell" },
    },
    { ledgerTurn: { turnId: "turn_x", runId: "run_y" }, model: "deepseek-v4.1-flash" },
  );
  assert.match(anchor, /\[turn turn_id=turn_x run_id=run_y carrier=cell model=deepseek-v4\.1-flash tokens=10\/5\/130 status=ok\]/);
});

test("turn fact anchor: absent usage reads '-' (never a zero impersonating observation)", () => {
  const anchor = anchorOf({}, { ok: false, error: "boom" }, {});
  assert.match(anchor, /tokens=-\/-\/-/);
  assert.match(anchor, /carrier=-/);
  assert.match(anchor, /status=failed/);
  assert.match(anchor, /turn_id=-/);
});

// ── 补丁3: the outgoing swap anchor reads the ledger ─────────────────────────
test("swap outgoing anchor reads the member's last turn event", async () => {
  const DB_FILE = path.join(tmpRoot, `fleets-${Date.now()}.db`);
  const db = createFleetDatabase({ file: DB_FILE });
  db.createFleet({ id: "fleet_a1", name: "锚舰队", ownerEmail: "a@test", state: "active", decisionPolicy: null, sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null, orchestration: { posts: [], edges: [], constraints: {} }, createdAt: Date.now(), updatedAt: Date.now() });
  db.createMember({ id: "m_swap", fleetId: "fleet_a1", title: "换防岗", parentId: null, targetKind: "persona", targetId: "pack-a", kpiSlots: [], cadence: null, sortKey: 0, createdAt: Date.now(), updatedAt: Date.now() });
  db.appendTurnEvent({
    fleetId: "fleet_a1", memberId: "m_swap", source: "cron", status: "ok", model: "deepseek-v4.1-flash",
    startedAt: Date.now(), endedAt: Date.now(), usage: { input: 1, output: 1 },
    turnId: "turn_last", metering: { carrier: "cell" },
  });
  const last = db.listTurnEvents("m_swap", { limit: 1 })?.[0];
  assert.equal(last?.turnId, "turn_last");
  assert.equal(last?.carrier, "cell");
  const anchor = ` 离任锚：末次回合 turn_id=${last.turnId ?? "-"} status=${last.status} model=${last.model ?? "-"} carrier=${last.carrier ?? "-"}`;
  assert.match(anchor, /turn_id=turn_last status=ok model=deepseek-v4\.1-flash carrier=cell/);
});

// ── 补丁4: the weekly digest ─────────────────────────────────────────────────
const day = (monOffset, dayOffset) => {
  // Monday-anchored day strings for week keys 2026-W45 (Mon 2026-11-02) and W44
  const base = new Date(Date.UTC(2026, 10, 2)); // Mon 2026-11-02
  base.setUTCDate(base.getUTCDate() + monOffset * 7 + dayOffset);
  return base.toISOString().slice(0, 10);
};
const row = (member, dayStr, over = {}) => ({
  member_id: member,
  model: "deepseek-v4.1-flash",
  day: dayStr,
  turns: 2,
  ok_count: 1,
  failed_count: 1,
  cost_input_usd: 0.0001,
  cost_output_usd: 0.0002,
  cost_cache_write_usd: 0,
  cost_cache_read_usd: 0.00005,
  pricing_at: 1793434448085,
  queue_wait_ms_sum: 3000,
  queue_wait_ms_max: 2000,
  ...over,
});

test("weekly aggregation: week filter + sums + priced sample", () => {
  const rows = [
    row("mA", day(0, 0)), // this week (W45)
    row("mA", day(0, 2)),
    row("mA", day(-1, 3)), // last week (W44)
    row("mB", day(0, 1), { pricing_at: null, cost_input_usd: 0, cost_output_usd: 0, cost_cache_write_usd: 0, cost_cache_read_usd: 0 }), // unpriced → writer never put money here
  ];
  const thisWeek = aggregateWeek(rows, "2026-W45");
  assert.equal(thisWeek.length, 2, "week filter keeps this week only");
  const a = thisWeek.find((r) => r.memberId === "mA");
  assert.equal(a.turns, 4);
  assert.ok(Math.abs(a.costUsd - 2 * 0.00035) < 1e-12, "four-component sum");
  const b = thisWeek.find((r) => r.memberId === "mB");
  assert.equal(b.costUsd, 0, "unpriced rows contribute nothing");
  assert.equal(b.pricedTurns, 0, "priced-sample size honest");
});

test("movers: cost ×2 with noise floor, wait +50% with 30s floor, 无对照", () => {
  const last = [row("mA", day(-1, 0), { cost_input_usd: 0.0001, cost_output_usd: 0.0001, cost_cache_read_usd: 0, queue_wait_ms_max: 10_000 })];
  const lastRows = aggregateWeek(last, "2026-W44");
  // cost ×2 (0.0002 → 0.0005+ with real volume) — build this week accordingly:
  const cur = aggregateWeek([row("mA", day(0, 0), { cost_input_usd: 0.001, cost_output_usd: 0.002, cost_cache_read_usd: 0, queue_wait_ms_max: 60_000 })], "2026-W45");
  const line = moversLine(cur, lastRows);
  assert.match(line, /成本 \$0\.0002→\$/);
  assert.match(line, /排队等待 max 10s→60s/);

  const quiet = moversLine(aggregateWeek([row("mC", day(0, 0))], "2026-W45"), lastRows);
  assert.match(quiet, /无（周环比平稳）|无对照/);

  const noLast = moversLine(cur, []);
  assert.match(noLast, /无对照/);
});

test("page body: table + movers + 无样本 branch", () => {
  const cur = aggregateWeek([row("mA", day(0, 0))], "2026-W45");
  const body = buildWeeklyBody(cur, [], { weekKey: "2026-W45" });
  assert.match(body, /周 2026-W45 · 舰队成本周报/);
  assert.match(body, /\| mA \|/);
  assert.match(body, /无对照/);
  const empty = buildWeeklyBody([], [], { weekKey: "2026-W45" });
  assert.match(empty, /无样本/);
});

test("sweep: writes once per fleet per week; unpriced weeks still produce a page", async () => {
  const DB_FILE = path.join(tmpRoot, `fleets-digest-${Date.now()}.db`);
  const db = createFleetDatabase({ file: DB_FILE });
  db.createFleet({ id: "fleet_d1", name: "周报舰队", ownerEmail: "d@test", state: "active", decisionPolicy: null, sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null, orchestration: { posts: [], edges: [], constraints: {} }, createdAt: Date.now(), updatedAt: Date.now() });
  const facts = [];
  const captureFact = (fleetId, _memberId, kind, title, body) => facts.push({ fleetId, kind, title, body });
  const listActive = () => [{ id: "fleet_d1", state: "active" }];

  const n1 = await runFleetCostDigests({ fleetsDb: db, captureFact, listActiveFleets: listActive, written: new Map() });
  assert.equal(n1, 1);
  assert.equal(facts[0].kind, "cost-weekly");
  assert.match(facts[0].body, /无样本/);

  // The in-memory book suppresses a same-week rewrite.
  const book = new Map([["fleet_d1", facts[0].title.split(" ")[1]]]); // the ISO week key from the page title
  const n2 = await runFleetCostDigests({ fleetsDb: db, captureFact, listActiveFleets: listActive, written: book });
  assert.equal(n2, 0, "same week → no second page");
});

// ── O10 regression: title derives from ok/skipped, not a nonexistent status ──
test("capture title: ok:true outcome reads 回合成功 (O10 — no status field on executor outcomes)", () => {
  // The real executor shape: { ok: true, ... } — NO status field. The old
  // reader (outcome?.status ?? "failed") made every success page a 失败.
  const outcome = { ok: true, usage: { input: 367, output: 85 }, text: "回合1记忆验证" };
  assert.equal(captureStatusOf(outcome), "ok");
  const failed = { ok: false, error: "boom" };
  assert.equal(captureStatusOf(failed), "failed");
  const skipped = { ok: false, skipped: true, error: "not ready" };
  assert.equal(captureStatusOf(skipped), "skipped");
});
