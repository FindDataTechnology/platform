#!/usr/bin/env node
// 预算分账（openspec: harden-fleet-execution-economics 4.1）
//
// 钉五条语义，每条都对应一种"账会对不上"的方式：
//   1. 带 owner/fleet 的消费 → 落在对应分账行；
//   2. 缺归属 → 记 "unknown"，**不得**落进任何具体舰队；
//   3. 不同 owner 互不混账（这是分账的全部意义）；
//   4. **准入仍在全局行**：分账只记账，不改闸门行为（A 超了不影响 B）；
//   5. 旧库（只有 model_budget 表）开机不炸，且旧行原样保留。
//
//   node --test scripts/test-model-budget-scope.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

const { createBudgetEngine } = await import("../server/model-budget.js");

function freshDb(file) {
  const db = new Database(file);
  return db;
}

const CFG = { enabled: true, single: 8192, daily: 1000, monthly: 10000 };
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09T12:00Z

function engineOn(file, nowMs = NOW) {
  const db = freshDb(file);
  const engine = createBudgetEngine({ db, config: CFG, now: () => nowMs });
  return { db, engine };
}

// ── 1/2/3. 分账归属 ───────────────────────────────────────────────────
test("charges land on the owning scope, and missing attribution is unknown", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "budget-scope-")), "f.db");
  const { db, engine } = engineOn(file);

  engine.consumeBudget("m1", 100, { owner: "a@x.com", fleet: "fleet-a" });
  engine.consumeBudget("m1", 50, { owner: "b@x.com", fleet: "fleet-b" });
  engine.consumeBudget("m1", 30, {});                       // 无归属
  engine.consumeBudget("m1", 20, { owner: null, fleet: null });

  const rows = engine.scopeReport();
  const byKey = Object.fromEntries(rows.map((r) => [`${r.owner}|${r.fleet}`, r.used]));

  assert.equal(byKey["a@x.com|fleet-a"], 100, "owner A keeps its own usage");
  assert.equal(byKey["b@x.com|fleet-b"], 50, "owner B keeps its own usage");
  assert.equal(byKey["unknown|unknown"], 50, "unattributed usage must be unknown|unknown");
  assert.ok(!Object.keys(byKey).some((k) => k.startsWith("a@x.com|fleet-b")), "no cross-attribution");

  // 显式未知标记，供读面原样展示（不能伪装成某个真实舰队）
  const unknownRow = rows.find((r) => r.owner === "unknown");
  assert.equal(unknownRow.unattributed, true);
  const ownedRow = rows.find((r) => r.owner === "a@x.com");
  assert.equal(ownedRow.unattributed, false);
  db.close();
});

// ── 4. 准入仍在全局 ───────────────────────────────────────────────────
test("the gate still runs on the global row: one owner's spend is not another's cap", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "budget-scope-")), "f.db");
  const { db, engine } = engineOn(file);

  // 把全局 daily 打满（1000）
  engine.consumeBudget("m1", 1000, { owner: "a@x.com", fleet: "fleet-a" });
  assert.equal(engine.checkBudget("m1").allowed, false, "global daily is exhausted");

  // 分账上 A 用满、B 是 0——但闸门是全局的，B 也会被挡（行为未变，这是刻意的）
  engine.consumeBudget("m1", 0, { owner: "b@x.com", fleet: "fleet-b" });
  assert.equal(engine.checkBudget("m1").allowed, false,
    "enforcement stays global; per-owner caps are a separate decision");

  const rows = engine.scopeReport();
  const a = rows.find((r) => r.owner === "a@x.com" && r.tier === "daily");
  assert.equal(a.used, 1000, "the ledger still shows WHO spent it");
  db.close();
});

// ── 5. 旧库兼容 ───────────────────────────────────────────────────────
test("an existing budget database keeps its rows and gains the scope table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-legacy-"));
  const file = path.join(dir, "f.db");

  // 造一个"旧版"库：只有 model_budget，没有 model_budget_scope
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE model_budget (
      model TEXT NOT NULL, tier TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
      limit_tokens INTEGER NOT NULL, window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(model, tier));
  `);
  legacy.prepare(`INSERT INTO model_budget (model, tier, used, limit_tokens, window_start, window_end, updated_at)
                  VALUES (?,?,?,?,?,?,?)`).run("legacy-model", "daily", 777, 1000, NOW - 1000, NOW + 86400000, NOW);
  legacy.close();

  const { db, engine } = engineOn(file);

  // 旧行原样在，且没有被改归属（旧表本来就没有 owner 列——不能被"迁移"成默认舰队）
  const legacyRow = db.prepare(`SELECT used FROM model_budget WHERE model = ? AND tier = ?`).get("legacy-model", "daily");
  assert.equal(legacyRow.used, 777, "existing rows must survive untouched");

  // 新表可用；历史用量在分账里是"不存在"，读面不能把"没有行"当成"用了 0"
  assert.deepEqual(engine.scopeReport(), [], "no scoped rows exist for history");
  engine.consumeBudget("legacy-model", 5, { owner: "c@x.com", fleet: "fleet-c" });
  const rows = engine.scopeReport();
  // 一笔消费同时进 daily 与 monthly 两窗（与全局扣费同口径）——所以是两行。
  assert.equal(rows.length, 2, "one charge lands in the daily and the monthly window");
  assert.deepEqual(rows.map((r) => r.tier).sort(), ["daily", "monthly"]);
  for (const r of rows) {
    assert.equal(r.used, 5, "new usage is attributed from now on, not retroactively");
    assert.equal(r.owner, "c@x.com");
  }
  db.close();
});

// ── 窗口口径一致 ─────────────────────────────────────────────────────
test("scoped and global windows use the same boundaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-window-"));
  const file = path.join(dir, "f.db");
  const { db, engine } = engineOn(file);
  engine.consumeBudget("m1", 10, { owner: "a@x.com", fleet: "fleet-a" });

  const g = db.prepare(`SELECT window_start AS s, window_end AS e FROM model_budget WHERE tier = ?`).get("daily");
  const s = db.prepare(`SELECT window_start AS s, window_end AS e FROM model_budget_scope WHERE tier = ?`).get("daily");
  assert.equal(s.s, g.s, "day window start must match");
  assert.equal(s.e, g.e, "day window end must match");
  db.close();
});
