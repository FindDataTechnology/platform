#!/usr/bin/env node
// 预算阈值预警（openspec: harden-fleet-execution-economics 4.2）
//
// 钉四条，每条对应一种"预警会变成噪音或瞎报"的方式：
//   1. 到比例才报——没到一条不报；
//   2. **按窗口幂等**——同一 (model,tier,window) 反复 checkBudget 只记一条；
//   3. 撞墙（>= 上限）由 exhausted 日志负责，预警不重复报同一件事；
//   4. 新窗口重新计——重置后到比例要能再报一次。
//
//   node --test scripts/test-model-budget-warn.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

const { createBudgetEngine } = await import("../server/model-budget.js");

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const CFG = { enabled: true, single: 8192, daily: 1000, monthly: 10000, warnRatio: 0.9 };

function built(file, { nowMs = NOW, cfg = CFG } = {}) {
  const db = new Database(file);
  return { db, engine: createBudgetEngine({ db, config: cfg, now: () => nowMs }) };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "budget-warn-")), "f.db");

test("below the ratio: no warning", () => {
  const { db, engine } = built(tmpFile());
  engine.consumeBudget("m1", 800);            // 80%
  engine.checkBudget("m1");
  assert.equal(engine.warningLog().length, 0, "80% must not warn at a 90% ratio");
  db.close();
});

test("at or above the ratio: exactly one warning, and repeated checks do not duplicate", () => {
  const { db, engine } = built(tmpFile());
  engine.consumeBudget("m1", 950);            // 95%
  for (let i = 0; i < 5; i += 1) engine.checkBudget("m1");
  const rows = engine.warningLog();
  assert.equal(rows.length, 1, `one row per window, got ${rows.length}`);
  assert.equal(rows[0].tier, "daily");
  assert.ok(rows[0].used >= 900);
  db.close();
});

test("exhaustion is the exhausted log's job, not the warning's", () => {
  const { db, engine } = built(tmpFile());
  engine.consumeBudget("m1", 1000);           // 恰好打满
  engine.checkBudget("m1");
  assert.equal(engine.warningLog().length, 0, "at the cap the exhaustion log owns the signal");
  db.close();
});

test("a new window warns again", () => {
  const file = tmpFile();
  const first = built(file);
  first.engine.consumeBudget("m1", 950);
  first.engine.checkBudget("m1");
  assert.equal(first.engine.warningLog().length, 1);
  first.db.close();

  // 次日（新 daily 窗口）：用量归零后再次到比例，应产生第二条
  const nextDay = Date.UTC(2026, 10, 10, 12, 0, 0);
  const second = built(file, { nowMs: nextDay });
  second.engine.consumeBudget("m1", 950);
  second.engine.checkBudget("m1");
  assert.equal(second.engine.warningLog().length, 2, "each window gets its own warning");
  second.db.close();
});

test("warnRatio 0 disables the warning entirely", () => {
  const { db, engine } = built(tmpFile(), { cfg: { ...CFG, warnRatio: 0 } });
  engine.consumeBudget("m1", 950);
  engine.checkBudget("m1");
  assert.equal(engine.warningLog().length, 0);
  db.close();
});

test("a broken warning path never blocks the turn (degrade open)", () => {
  const { db, engine } = built(tmpFile());
  db.exec("DROP TABLE budget_warning_log");   // 让它必炸
  engine.consumeBudget("m1", 950);
  const verdict = engine.checkBudget("m1");   // 不许抛
  assert.equal(verdict.allowed, true, "warning failure must not block the turn");
  db.close();
});

// ── 日报必须看得见趋势（4.2 附）──────────────────────────────────────
//
// 上限抬到 200 亿后，"利用率≥80%" 那条 hot 判据永远够不到，日报会退化成
// "模型数 + 空数组"。所以日报必须**无条件**给出当日用量 Top，不依赖阈值。
test("the daily report carries the usage leaders even when nothing is near the cap", async () => {
  const { db, engine } = built(tmpFile());
  engine.consumeBudget("heavy", 500);
  engine.consumeBudget("light", 10);
  const r = engine.report({ sinceDays: 1 });

  const top = [...r.models].filter((x) => x.used > 0).sort((a, b) => b.used - a.used).slice(0, 3);
  assert.equal(top[0].model, "heavy", "the leader must be the model that actually spent tokens");
  assert.ok(top[0].used >= 500);
  assert.ok(top.every((x) => (x.utilization ?? 0) < 0.9), "leaders here are nowhere near the cap");
  db.close();
});
