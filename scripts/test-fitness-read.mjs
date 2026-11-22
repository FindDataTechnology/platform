// 判定读数器（establish-agent-role-and-fitness-plane 1.2 / 1.3）。
//
// 这些用例钉的是三件事，每一件都在别处有过「看起来绿、其实是假绿」的先例：
//   1. 判不出（undet）与判红（red）、判绿（green）三态可区分，且退出码 0/1/2
//      分别对应——读数作业的退出码就是判词（fleet-acceptance-readings）。
//   2. 未定价回合的成本是「不知道」不是 0：有价样本数单独给出，缺省值不得冒充事实。
//   3. 只数岗位自报（source='self'）：派生报数是平台写的，不能算岗位交了差。
//
// Run: node --test scripts/test-fitness-read.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { computeReadings, readFleet, exitCodeFor, THRESHOLDS, EXIT, selfTest } = await import("./fitness-read.mjs");

const W0 = 1_700_000_000_000;
const W1 = W0 + 24 * 3_600_000;
const turn = (over) => ({ member_id: "m1", source: "cron", status: "ok", started_at: W0 + 1000, queue_wait_ms: null, ...over });

test("判不出：窗口内没有回合时是 undet，不是绿", () => {
  const r = computeReadings({ turns: [], reports: [], daily: [], windowStart: W0, windowEnd: W1 });
  assert.equal(r.verdict, "undet");
  assert.equal(r.reason, "no-turns-in-window");
  assert.equal(exitCodeFor({ ok: true, readings: r }), EXIT.UNDET);
});

test("判不出：回合数低于下限时如实报样本不足，不按比例判绿", () => {
  const turns = Array.from({ length: THRESHOLDS.minTurns - 1 }, () => turn({}));
  const r = computeReadings({ turns, reports: [], daily: [], windowStart: W0, windowEnd: W1 });
  assert.equal(r.verdict, "undet");
  assert.equal(r.reason, "below-min-turns");
});

test("判红：失败率越线，退出码为 1", () => {
  const turns = [
    ...Array.from({ length: 4 }, () => turn({ status: "ok" })),
    ...Array.from({ length: 4 }, (_, i) => turn({ status: "failed", started_at: W0 + 2000 + i })),
  ];
  const r = computeReadings({ turns, reports: [], daily: [], windowStart: W0, windowEnd: W1 });
  assert.equal(r.verdict, "red");
  assert.ok(r.reds.some((x) => x.criterion === "failure-rate"));
  assert.equal(exitCodeFor({ ok: true, readings: r }), EXIT.RED);
});

test("判绿：全成功且报数齐，退出码为 0", () => {
  const turns = Array.from({ length: 6 }, (_, i) => turn({ started_at: W0 + 1000 + i }));
  const reports = turns.map((t) => ({ member_id: "m1", source: "self", created_at: t.started_at + 10 }));
  const r = computeReadings({ turns, reports, daily: [], windowStart: W0, windowEnd: W1 });
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.reds, []);
  assert.equal(exitCodeFor({ ok: true, readings: r }), EXIT.GREEN);
});

test("缺报只数岗位自报：派生报数不算交了差", () => {
  const turns = Array.from({ length: 6 }, (_, i) => turn({ started_at: W0 + 1000 + i }));
  const reports = turns.map((t) => ({ member_id: "m1", source: "derived", created_at: t.started_at + 10 }));
  const r = computeReadings({ turns, reports, daily: [], windowStart: W0, windowEnd: W1 });
  const m = r.members[0];
  assert.equal(m.reportsFiled, 0);
  assert.equal(m.reportGap, 6);
  assert.equal(r.verdict, "red");
});

test("未定价回合的成本不是 0：有价样本数单独给出", () => {
  const turns = Array.from({ length: 6 }, () => turn({}));
  const daily = [
    { day: "2023-11-14", turns: 4, usage_input: 100, usage_output: 20, cost_input_usd: 0.5, cost_output_usd: 0.25, cost_cache_write_usd: 0, cost_cache_read_usd: 0, pricing_at: W0 },
    { day: "2023-11-14", turns: 2, usage_input: 0, usage_output: 0, cost_input_usd: 0, cost_output_usd: 0, cost_cache_write_usd: 0, cost_cache_read_usd: 0, pricing_at: null },
  ];
  const r = computeReadings({ turns, reports: [], daily, windowStart: W0, windowEnd: W1 });
  assert.equal(r.cost.usd, 0.75);
  assert.equal(r.cost.pricedTurns, 4);
  assert.equal(r.cost.turns, 6);
});

test("队列等待不是每轮都有：样本数为 0 时 p50/max 为 null，不补 0", () => {
  const turns = Array.from({ length: 6 }, () => turn({ queue_wait_ms: null }));
  const r = computeReadings({ turns, reports: [], daily: [], windowStart: W0, windowEnd: W1 });
  assert.equal(r.members[0].queueWaitMsP50, null);
  assert.equal(r.members[0].queueWaitMsMax, null);
  assert.equal(r.members[0].queueWaitSamples, 0);
});

test("cells 扫描：面板级自证六臂全过（绿/红×2/判不出×2/引导前）", () => {
  assert.equal(selfTest(), 0);
});

test("端到端：读一份真 fleets.db，缺表时是 undet 而不是绿", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-read-"));
  process.env.PLATFORM_DATA_DIR = tmp;
  process.env.CRON_STORAGE_PATH = tmp;
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.DSH_HOME = path.join(tmp, "dsh");
  fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

  const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
  const dbPath = path.join(tmp, "fleets.db");
  const fleetDb = createFleetDatabase({ file: dbPath });
  setFleetDatabase(fleetDb);
  const fleet = fleetDb.createFleet({ id: "f_fit", name: "判定舰", ownerEmail: "o@test" });
  fleetDb.createMember({ id: "m_fit", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p-fit", kpiSlots: [] });
  for (let i = 0; i < 6; i += 1) {
    fleetDb.appendTurnEvent({ fleetId: fleet.id, memberId: "m_fit", source: "cron", status: "ok", startedAt: W0 + 1000 + i, endedAt: W0 + 1500 + i, turnId: `t${i}` });
    fleetDb.appendReport({ id: `r${i}`, fleetId: fleet.id, memberId: "m_fit", summary: "ok", metrics: {}, source: "self", createdAt: W0 + 1200 + i });
  }

  const ok = readFleet({ dbPath, fleetId: fleet.id, windowStart: W0, windowEnd: W1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.readings.totals.turns, 6);
  assert.ok(ok.readings.members[0].reportsFiled >= 1);

  // 缺表 / 缺库：undet，且原因点名——两条都不是绿。
  const missing = readFleet({ dbPath: path.join(tmp, "nope.db"), fleetId: fleet.id, windowStart: W0, windowEnd: W1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "db-missing");
  assert.equal(exitCodeFor(missing), EXIT.UNDET);

  fleetDb.close();
});
