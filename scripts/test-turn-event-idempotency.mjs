#!/usr/bin/env node
// ── 记账幂等：同一回合结算两次，只落一行、只算一次 ────────────────────────────
//
// fix-fleet-replay-dispatch-and-turn-accounting 2.3。
//
// 为什么要这条：worker 与串行链是两条结算缝，而「一次重放」也会再结算一遍同一轮。
// 修复前 `member_turn_events` 上虽有 `UNIQUE(turn_id)`，但重复写是**抛约束错误**——
// 写侧看到一次失败、读侧的明细行数却刚好也对，两种读数互相矛盾，排查时无法归因。
// 而且日汇总（`member_turn_daily`）是**累加** upsert：如果只做「插入去重」而让流程
// 继续走到汇总，同一轮的钱与回合数会被数两遍 —— 「只落一行」与「只算一次」是同一件
// 事的两半，这条用例两半都钉。
//
// 量词也钉住：`turn_id` 为 NULL 的回合（生产实测 773/11,574 ≈ 6.7%）没有身份，
// SQLite 的唯一约束把 NULL 视为互不相等 ⇒ 它们**不受**这条保护。用例里明说这一档，
// 免得后来人把「没重复」读成「全覆盖」。
//
//   node --test scripts/test-turn-event-idempotency.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-idem-"));
process.env.CRON_STORAGE_PATH = dir;
process.env.PLATFORM_DATA_DIR = dir;

// The recorder needs db.js migrated first (action_audit lives there).
const { initDb } = await import(path.join(here, "../db.js"));
await initDb();
const { createFleetDatabase } = await import(path.join(here, "../server/routes/fleets-db.js"));
const fleet = createFleetDatabase();
const appendTurnEvent = fleet.appendTurnEvent;
assert.equal(typeof appendTurnEvent, "function", "fleet db must expose appendTurnEvent");

// Read side is the table itself, not a helper: the claim is about ROWS and DAILY SUMS.
// A connection per read, deliberately: a connection opened once at module load keeps
// its snapshot and reads 1 forever (measured: the second assertion got 1 instead of 3),
// which would make this test agree with a broken writer.
const Database = (await import("better-sqlite3")).default;
const dbFile = path.join(dir, "data", "fleets.db");
const q = (sql, ...args) => {
  const h = new Database(dbFile, { readonly: true });
  try { return h.prepare(sql).all(...args); } finally { try { h.close(); } catch { /* gone */ } }
};

const F = "f_idem";
try { fleet.createFleet({ id: F, name: "idem", ownerEmail: "o@t" }); } catch { /* exists */ }
const M = "m_idem";
try {
  fleet.createMember({
    id: M, fleetId: F, title: "idem", targetKind: "persona", targetId: "user.preset-idem",
    cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
  });
} catch { /* exists */ }

const AT = 1_760_000_000_000; // fixed: the daily key is the UTC day of startedAt
const event = (turnId) => ({
  fleetId: F,
  memberId: M,
  source: "cron",
  status: "ok",
  startedAt: AT,
  endedAt: AT + 60_000,
  sessionId: "cron-idem",
  turnId,
  usage: { input: 1_000, output: 100 },
  metering: { carrier: "worker", usageCachedInput: 500 },
  pricing: { inputUsd: 0.1, outputUsd: 0.2, pricingAt: AT },
});

const rowsFor = (turnId) => q("SELECT count(*) c FROM member_turn_events WHERE turn_id = ?", turnId)[0].c;
const dailyFor = () => q("SELECT turns, cost_input_usd FROM member_turn_daily WHERE member_id = ?", M);
// 日汇总的 conflict 键含 provider/model，而这两个字段为 NULL 时 SQLite 的
// `ON CONFLICT(...)` **不会触发**（NULL 在唯一索引里互不相等）⇒ 同一成员不同回合
// 会得到多行日汇总，每行 turns 各 1。所以「这一轮被算了几次」只能按**求和**读，
// 不能按「第一行」读——探针实测三次 append 得到三行 turns=1。
const totalTurns = () => q("SELECT COALESCE(SUM(turns),0) t FROM member_turn_daily WHERE member_id = ?", M)[0].t;

test("A. 同一个 turn_id 结算两次：一行、日汇总只计一次、第二次幂等返回已有行", () => {
  const first = appendTurnEvent(event("t-dup-1"));
  assert.ok(first?.id, "第一次必须真落一行");
  const second = appendTurnEvent(event("t-dup-1"));
  assert.ok(second?.id, "第二次必须**返回已有行**而不是抛错——写侧看到异常与行数正确互相矛盾正是这条要消灭的");
  assert.equal(second.id, first.id, "返回的必须是同一行（幂等），不是新行");
  assert.equal(rowsFor("t-dup-1"), 1, "明细只能有一行");

  const d = dailyFor();
  assert.equal(d.length, 1, "日汇总同一 (fleet,member,carrier,provider,model,day) 只有一行");
  assert.equal(totalTurns(), 1, "回合数只计一次（重复结算若走到汇总就会被数两遍）");
  assert.equal(d[0].cost_input_usd, 0.1, "金额只计一次");
});

test("B. 不同 turn_id 照常各落一行（守卫不是「谁都不许写」）", () => {
  appendTurnEvent(event("t-other-1"));
  appendTurnEvent(event("t-other-2"));
  assert.equal(rowsFor("t-other-1"), 1);
  assert.equal(rowsFor("t-other-2"), 1);
  assert.equal(totalTurns(), 3, "三次不同的回合 ⇒ 日汇总合计 3（每轮恰好计一次，不多不少）");
});

test("C. turn_id 为 NULL 的回合不受保护——如实钉住这一档，不假装覆盖", () => {
  // 生产实测 773/11,574 ≈ 6.7% 的回合没有 turn_id。SQLite 的唯一约束把 NULL 当作
  // 互不相等，`ON CONFLICT(turn_id)` 不会命中 ⇒ 这类重复仍然会落两行。用例写成
  // 断言（而不是沉默）：把「没重复」读成「已覆盖」正是这份账本最怕的读法。
  const before = q("SELECT count(*) c FROM member_turn_events WHERE member_id = ? AND turn_id IS NULL", M)[0].c;
  appendTurnEvent(event(null));
  appendTurnEvent(event(null));
  const after = q("SELECT count(*) c FROM member_turn_events WHERE member_id = ? AND turn_id IS NULL", M)[0].c;
  assert.equal(after - before, 2, "没有身份的回合只能靠 prune/对账去看，本条不作承诺");
});
