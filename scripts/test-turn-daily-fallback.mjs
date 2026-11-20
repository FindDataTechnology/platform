// 回归测试：事件行降级成旧形状时，日汇总**仍然**必须累加。
//
// 背景（2026-11-14）：`recordTurnEvent` 的扩展插入（38 列）失败时，会降级用
// 18 列写入。旧代码在那条路径上 `return` 了，于是 `member_turn_daily` 整段被跳过：
// 事件在、永久汇总不在，运行期零信号。实测 cell 1da519d4c1c0bf89 的 2026-11-03
// 有 16 行「所有计量列全 NULL」（正是降级路径写进来的），日汇总恰好少 16 个回合。
//
// 这条测试用一张**旧形状**的 member_turn_events（没有计量列）强制走降级路径，
// 断言两件事：事件行写成功；日汇总也记上了。
//
// Run: node --test scripts/test-turn-daily-fallback.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-daily-fallback-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { recordTurnEvent } = await import("../server/fleet-events.js");

await initDb();
await chatHistory.initChatHistory();

function job(memberId = "m_fallback") {
  return {
    id: "job_fallback",
    origin: { fleet: { fleetId: "f_fb", memberId } },
    payload: { prompt: "x" },
  };
}

test("降级写事件行时日汇总依然累加", () => {
  const db = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}.db`),
  });

  // 模拟「混合版本窗口」：把事件表退化成旧形状，扩展插入必然失败。
  db.db.exec("DROP TABLE IF EXISTS member_turn_events");
  db.db.exec(`
    CREATE TABLE member_turn_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      error_kind TEXT, error TEXT, model TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      session_id TEXT, turn_id TEXT, run_id TEXT, parent_turn_id TEXT,
      edge_kind TEXT, usage_input INTEGER, usage_output INTEGER,
      trace_turn_id TEXT, detail TEXT
    )
  `);

  const out = recordTurnEvent(
    db,
    job(),
    {
      ok: true,
      text: "hi",
      // metering 挂在 outcome 上（meteringOf 读的是 outcome.metering），不是 meta
      metering: { provider: "p", carrier: "c", ttftMs: 500 },
      usage: { input: 10, output: 3 },
    },
    {
      startedAt: Date.parse("2026-11-03T10:00:00Z"),
      endedAt: Date.parse("2026-11-03T10:00:05Z"),
    },
  );

  assert.ok(out?.id, "事件行必须写进去（降级路径的核心承诺）");

  const events = db.db.prepare("SELECT count(*) n FROM member_turn_events").get().n;
  assert.equal(events, 1);

  const daily = db.db.prepare(
    "SELECT day, turns, ttft_ms_sum FROM member_turn_daily WHERE member_id = 'm_fallback'",
  ).all();
  assert.equal(daily.length, 1, "降级路径也必须写日汇总——旧代码在这里早返回，静默丢一条");
  assert.equal(daily[0].day, "2026-11-03", "日 = startedAt 的 UTC 日，与写入路径同源");
  assert.equal(daily[0].turns, 1);
  assert.equal(daily[0].ttft_ms_sum, 500, "日汇总用的是内存里的计量值，不读事件行");
});

test("正常路径与降级路径对同一天累加同一行", () => {
  const db = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-mix.db`),
  });
  const when = {
    startedAt: Date.parse("2026-11-04T01:00:00Z"),
    endedAt: Date.parse("2026-11-04T01:00:05Z"),
  };
  const outcome = { ok: true, metering: { provider: "p", carrier: "c" }, usage: { input: 5, output: 2 } };

  recordTurnEvent(db, job("m_mix"), outcome, when);   // 正常路径

  db.db.exec("DROP TABLE IF EXISTS member_turn_events");
  db.db.exec(`
    CREATE TABLE member_turn_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet_id TEXT NOT NULL, member_id TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL, error_kind TEXT, error TEXT, model TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      session_id TEXT, turn_id TEXT, run_id TEXT, parent_turn_id TEXT,
      edge_kind TEXT, usage_input INTEGER, usage_output INTEGER,
      trace_turn_id TEXT, detail TEXT
    )
  `);
  recordTurnEvent(db, job("m_mix"), outcome, when);   // 降级路径

  const rows = db.db.prepare(
    "SELECT turns FROM member_turn_daily WHERE member_id = 'm_mix' AND day = '2026-11-04'",
  ).all();
  assert.equal(rows.reduce((a, r) => a + r.turns, 0), 2, "两条路径必须累加到同一天");
});
