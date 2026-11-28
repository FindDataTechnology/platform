#!/usr/bin/env node
// 判据 6（整预算超时）的离线自证 —— observe-full-budget-timeouts 1.1 / 1.2
//
// 为什么需要它：这条判据的口径有三个「写成另一条也会绿」的陷阱，而它们各自会
// 把结论读反：
//   1. 把早停（`turn stopped early`）算进来 ⇒ 修复生效被读成故障；
//   2. 判定落整个窗口而不是「最近一个完整 UTC 日」⇒ 窗口一滑就常年绿，
//      而这条判据的全部意义是「那天出过事」（11-12 那 66 条就是这样被漏掉的）；
//   3. 窗口没完整覆盖那一天却照数 ⇒ 半天当一天，66 被读成个位数。
//
// 所以夹具成对：同一份底（让另外五条判据全绿，RC 只由本判据驱动）+ 只改
// 「整预算超时的条数 / 那种错误长什么样」。
//
// 跑法：node scripts/test-queue-observation-full-budget.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "queue-observation-check.mjs");

const DAY = 24 * 3600 * 1000;
const utcDayStart = (ms) => Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString();

/** 最近一个完整 UTC 日的正午：判据判的就是这一天。 */
function lastCompleteNoon() {
  const todayStart = utcDayStart(Date.now());
  return todayStart - DAY + 12 * 3600 * 1000;
}

/** 让另外五条判据全绿的行：60 个执行回合 + 1 早停 + 1 短 ctx 失败 + 1 missed。 */
function greenBase(atMs) {
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push({ kind: "execution", time: iso(atMs), state: "done", success: true });
  }
  // 早停：修好之后达到阈值的回合应当这么收口（不进整预算计数）。
  rows.push({
    kind: "execution",
    time: iso(atMs),
    state: "failed",
    success: false,
    duration: 180000,
    error: "turn stopped early — context pressure (6 compactions)",
  });
  // 短 ctx 失败：把 ctx 耗时 p50 拉低（这条要「更短」才是修复生效）。
  rows.push({
    kind: "execution",
    time: iso(atMs),
    state: "failed",
    success: false,
    duration: 60000,
    error: "context overflow",
  });
  // 可信 missed：镜像已上产的标记。
  rows.push({ kind: "missed", time: iso(atMs), missed: 1, state: "queued" });
  return rows;
}

/** 一条「真跑满预算、且没早停」的失败行。 */
function fullBudgetRow(atMs) {
  return {
    kind: "execution",
    time: iso(atMs),
    state: "failed",
    success: false,
    duration: 600000,
    error: "turn timed out",
  };
}

function writeCells(name, tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `obs-fixture-${name}-`));
  const file = path.join(dir, "jobs.json");
  fs.writeFileSync(file, JSON.stringify({ tasks }));
  return file;
}

/** 一个 task 承载全部 history（脚本按 task × history 摊平，task 数不影响口径）。 */
function asTasks(rows) {
  return [{ id: "fixture-task", history: rows }];
}

function run(files, hours = 48) {
  const args = [CHECK, "--hours", String(hours), "--json", "--cells", ...files];
  const p = spawnSync(process.execPath, args, { encoding: "utf8" });
  let parsed = null;
  try {
    parsed = JSON.parse(p.stdout);
  } catch {
    /* 保留原始输出给断言用 */
  }
  return { rc: p.status, stdout: p.stdout, stderr: p.stderr, json: parsed };
}

const fb = (r) => r.json?.checks?.find((c) => c.id === "fullBudgetTimeouts");

test("只有早停 ⇒ 计数 0、✓、RC 不变（0）", () => {
  const at = lastCompleteNoon();
  const r = run([writeCells("early-only", asTasks(greenBase(at)))]);
  assert.equal(r.rc, 0, r.stdout + r.stderr);
  const c = fb(r);
  assert.equal(c.measured, "0");
  assert.equal(c.pass, true);
  assert.equal(c.warn, false, "0 条时不该打 ⚠");
});

test("1 条真 turn timed out ⇒ 计数 1、⚠ 且 RC 仍为 0", () => {
  const at = lastCompleteNoon();
  const r = run([writeCells("one", asTasks([...greenBase(at), fullBudgetRow(at)]))]);
  assert.equal(r.rc, 0, "⚠ 是事实行，不许动退出码：" + r.stdout + r.stderr);
  const c = fb(r);
  assert.equal(c.measured, "1");
  assert.equal(c.pass, true);
  assert.equal(c.warn, true);
});

test("4 条（低于阈值）⇒ ⚠ 且 RC 仍为 0", () => {
  const at = lastCompleteNoon();
  const rows = [...greenBase(at)];
  for (let i = 0; i < 4; i += 1) rows.push(fullBudgetRow(at + i * 60000));
  const r = run([writeCells("four", asTasks(rows))]);
  assert.equal(r.rc, 0, r.stdout + r.stderr);
  assert.equal(fb(r).measured, "4");
  assert.equal(fb(r).warn, true);
});

test("11 条（过阈值）⇒ ✗ 且 RC=1", () => {
  const at = lastCompleteNoon();
  const rows = [...greenBase(at)];
  for (let i = 0; i < 11; i += 1) rows.push(fullBudgetRow(at + i * 60000));
  const r = run([writeCells("eleven", asTasks(rows))]);
  assert.equal(r.rc, 1, "过阈值必须判失败：" + r.stdout + r.stderr);
  assert.equal(fb(r).measured, "11");
  assert.equal(fb(r).pass, false);
});

test("早停不算整预算超时（同一句里带 turn stopped early 也排除）", () => {
  const at = lastCompleteNoon();
  const base = greenBase(at);
  base.push({
    kind: "execution",
    time: iso(at),
    state: "failed",
    success: false,
    duration: 480000,
    // 现实中这句两个短语会同时出现：超时了，但闸门在 80% 处主动收了口。
    error: "turn stopped early after turn timed out budget guard",
  });
  const r = run([writeCells("mixed", asTasks(base))]);
  assert.equal(fb(r).measured, "0", "含早停的行必须不计：" + r.stdout);
});

test("逐日计数：两条不同 UTC 日的超时各归各的日期", () => {
  const at = lastCompleteNoon();
  const prevDay = at - DAY;
  const rows = [...greenBase(at),
    fullBudgetRow(at), fullBudgetRow(at + 60000),   // 最近完整日：2 条
    fullBudgetRow(prevDay)];                         // 前一天：1 条
  const r = run([writeCells("byday", asTasks(rows))], 96);
  const day = r.json.fullBudget.day;
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  assert.equal(r.json.fullBudget.byDay[day], 2, JSON.stringify(r.json.fullBudget));
  assert.equal(r.json.fullBudget.byDay[prev], 1, JSON.stringify(r.json.fullBudget));
  assert.equal(r.json.fullBudget.countOnDay, 2);
});

test("窗口没完整覆盖判定日 ⇒ n/a，不许拿半天当一天", () => {
  const at = lastCompleteNoon();
  // 窗口 6h：起点落在判定日之内 ⇒ 这一天在窗口里是残缺的。
  const r = run([writeCells("partial", asTasks([...greenBase(Date.now() - 3600 * 1000),
    fullBudgetRow(at)]))], 6);
  const c = fb(r);
  assert.equal(c.informational, true, "残缺日只能出 n/a：" + r.stdout);
  assert.match(c.measured, /^n\/a（窗口未完整覆盖 /);
  assert.equal(c.pass, true);
});
