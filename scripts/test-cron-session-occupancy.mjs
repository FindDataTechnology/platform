#!/usr/bin/env node
// ── 历史行带出运行时窗口、读面据此显示占比 ──────────────────────────────────
//
// 机制在役、数却在成功回合被丢掉：`cron-runner.js` 把本回合的 prompt 高水位
// （`lastInputTokens` = input + cacheRead 的最大值）与运行时解析的真窗口
// （`request/context` 的 `contextWindow`）一路带到 settle，而历史行只留 `tokens`。
// 于是「这个岗位的会话已经 83%」只有等它溢出/超时之后才第一次出现。
//
// **2026-11-16 合并时的收口**：这半边被另一条线（`fix-context-attribution-window`）先做完了——
// 它在 `task-engine.js` 里加了 `reportedContextWindow()`，把同一个量以 **`promptWindow`**
// 写到历史行（闸读它当分母），并据此算出 `contextUsage`。本分支原先自带一个
// `measuredContextWindow()` + 行键 `contextWindow`，是同一段逻辑的第二份拷贝、同一个量的
// 第二个名字；合并时整块取对方那份，本分支只保留**读面**与下面这组用例。
// 「同一行不许有两个写入方」是同一条纪律的另一面：**同一个量也不许有两个名字**。
//
// 这组用例钉住四件事：
//
//   1. 运行时窗口量到了就是那个数（成功回合也算），没量到就**null**——绝不会回落到
//      部署常量、也不会变成 0：`0%` 会被读成「空会话」，而常量在运行时解析出别的窗口的
//      模型上是错的；
//   2. `promptTokens` 那一半**不由这个函数写**（`promptHighWater()` 已落到同一行）；
//   3. 读面只认行上的 `promptWindow`——不拿 `contextUsage.contextWindow` 当分母，因为那个
//      会回落到常量，分不出「未知」与「拿常量除出来的假比例」；
//   4. 两数不齐时整段不出现（`null`），不打占位符。
//
//   node --test scripts/test-cron-session-occupancy.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { reportedContextWindow } = await import(path.join(here, "../task-engine.js"));
const { sessionOccupancy, sessionOccupancyLabel } = await import(path.join(here, "../server/cron-list-view.js"));

// 现场形状（2026-11-09 实测帧）：prompt 151,014、窗口 128,000。
const measured = { lastInputTokens: 106_240, contextWindow: 128_000 };

test("1. 量到了就写下来：reportedContextWindow", () => {
  assert.equal(reportedContextWindow(measured), 128_000);
});

test("1b. 只返回数字，不返回对象——promptTokens 有另一个写入方", () => {
  // 结构判据：这个函数一旦返回对象，就会有人再往里塞 promptTokens，于是同一行有两个
  // 写入方（`promptHighWater` 与这里），两个口径悄悄打架而没人看得见。
  assert.equal(typeof reportedContextWindow(measured), "number");
});

test("2. 运行时没解析出窗口 ⇒ null，不回落 128000", () => {
  assert.equal(reportedContextWindow({ lastInputTokens: 90_000, contextWindow: null }), null);
});

test("3. 没有窗口这个键时同样省略（undefined 不等于 0）", () => {
  assert.equal(reportedContextWindow({ lastInputTokens: 90_000 }), null);
});

test("4. prompt=0 不影响窗口——两件事独立", () => {
  // provider 没报 usage 只说明「prompt 没量到」，窗口是运行时给的另一个量。
  assert.equal(reportedContextWindow({ lastInputTokens: 0, contextWindow: 128_000 }), 128_000);
});

test("5. 都没有 ⇒ null（行上不出现这个键）", () => {
  assert.equal(reportedContextWindow({}), null);
  assert.equal(reportedContextWindow(null), null);
  assert.equal(reportedContextWindow(undefined), null);
  // 失败回合的 settle 走 timeoutError 路径，顶层没有这些字段
  assert.equal(reportedContextWindow({ ok: false, error: "502 upstream" }), null);
});

test("6. 0/负数/NaN/Infinity 一律不进；字符串按数字收（`tokenComponent` 的既有口径）", () => {
  // 注意与「读面」的差别：读面（sessionOccupancy）要求 `typeof === "number"`，字符串一律
  // 当未知；这里走共享的 `tokenComponent`，它会 `Number(...)` 一次。两条口径不一样是**有意**
  // 的：写入方收的是运行时对象的字段（可能被序列化过），读面收的是落盘后的历史行。
  assert.equal(reportedContextWindow({ contextWindow: "128000" }), 128_000);
  assert.equal(reportedContextWindow({ contextWindow: 0 }), null);
  assert.equal(reportedContextWindow({ contextWindow: -128_000 }), null);
  assert.equal(reportedContextWindow({ contextWindow: NaN }), null);
  assert.equal(reportedContextWindow({ contextWindow: Infinity }), null);
});

test("6b. 失败回合从 detail 取（`{ok:false}` 只回 detail，数在那儿）", () => {
  // runPersonaTurn 的失败分支不展开 out，只回 { ok:false, error, detail, ... }；
  // 「死在 97%」正是最该记下来的一类，所以顶层没有就看 detail。
  const failed = {
    ok: false,
    error: "turn stopped early — context overflow (124000/128000 input tokens)",
    detail: { lastInputTokens: 124_000, contextWindow: 128_000, windowFull: true },
  };
  assert.equal(reportedContextWindow(failed), 128_000);
});

test("6c. detail 里那个 `?? 0` 的占位不算数", () => {
  // markPartialUsage 写的是 `lastInputTokens: out.lastInputTokens ?? 0` —— 0 是占位，不是测量。
  // 窗口若也是占位（0），同样不许当成「窗口是 0」写下来。
  assert.equal(reportedContextWindow({ ok: false, detail: { contextWindow: 0 } }), null);
});

test("6d. 顶层可用时以顶层为准（两处不一致不混着取）", () => {
  const both = { contextWindow: 128_000, detail: { contextWindow: 64_000 } };
  assert.equal(reportedContextWindow(both), 128_000);
});

test("7. 比例：两数齐才算", () => {
  const occ = sessionOccupancy({ promptTokens: 106_240, promptWindow: 128_000 });
  assert.equal(occ.ratio, 0.83);
  assert.equal(occ.promptTokens, 106_240);
  assert.equal(occ.contextWindow, 128_000);
});

test("8. 缺一返回 null——`Number(null) === 0` 那条坑", () => {
  // 若这里写 `Number(row?.promptWindow)`，null 会变成 0，然后 window <= 0 挡住；
  // 但 `promptTokens: null` 会算出 0% —— 这正是「没量到」被读成「空会话」的入口。
  assert.equal(sessionOccupancy({ promptTokens: null, promptWindow: 128_000 }), null);
  assert.equal(sessionOccupancy({ promptWindow: 128_000 }), null);
  assert.equal(sessionOccupancy({ promptTokens: 90_000 }), null);
  assert.equal(sessionOccupancy({ promptTokens: 90_000, promptWindow: 0 }), null);
  assert.equal(sessionOccupancy({ promptTokens: 0, promptWindow: 128_000 }), null);
  assert.equal(sessionOccupancy({}), null);
  assert.equal(sessionOccupancy(null), null);
  // 字符串化过的数（有的 store/JSON 读面会这样）不许被隐式转成数字再评一个比例出来：
  // 读面要「不知道」，不要一个看起来精确的假读数。
  assert.equal(sessionOccupancy({ promptTokens: "90000", promptWindow: "128000" }), null);
});

test("9. 标签取整向下：99.6% 不许显示成 100%", () => {
  assert.equal(sessionOccupancyLabel({ promptTokens: 106_240, promptWindow: 128_000 }), "session 83% of 128000");
  assert.equal(sessionOccupancyLabel({ promptTokens: 99_999, promptWindow: 100_000 }), "session 99% of 100000");
  // 实测里真的会超过 100%（同一回合既有 ~170k 的成功轮，窗口 128k）；如实显示。
  assert.equal(sessionOccupancyLabel({ promptTokens: 140_000, promptWindow: 128_000 }), "session 109% of 128000");
});

test("10. 算不出比例 ⇒ 标签为 null（调用方整段不出现，不打 0%）", () => {
  assert.equal(sessionOccupancyLabel({ promptTokens: 90_000 }), null);
  assert.equal(sessionOccupancyLabel({}), null);
  assert.equal(sessionOccupancyLabel(null), null);
});

test("11. 非 128k 窗口按该行自己的窗口算（窗口不是常量）", () => {
  // 自由模型车道的窗口实测有 200k 档；拿常量当分母会把 45% 算成 70%。
  assert.equal(sessionOccupancyLabel({ promptTokens: 90_000, promptWindow: 200_000 }), "session 45% of 200000");
});

test("12. 读面不拿 `contextUsage.contextWindow` 当分母", () => {
  // `contextUsage.contextWindow` 是**闸的口径**（可回落到部署常量），而这个标签要的是
  // 「运行时解析出的窗口」。混用会让「session 70% of 128000」显示得像是事实，而那个 128000
  // 是常量——本 change 的验收原文：不得以部署常量推算出比例。
  const row = { promptTokens: 90_000, contextUsage: { contextWindow: 128_000, ratio: 0.7, overThreshold: true } };
  assert.equal(sessionOccupancy(row), null);
  assert.equal(sessionOccupancyLabel(row), null);
});

test("13. 行上只认 `promptWindow`：旧的 `contextWindow` 键不再被读", () => {
  // 同一个量不许两个名字。这条钉住合并时的决定：键名统一到 `promptWindow`，
  // 历史行上不再有 `contextWindow`（`request/context.contextWindow` 是运行时来源，
  // 落盘时叫 `promptWindow`）。
  assert.equal(sessionOccupancy({ promptTokens: 90_000, contextWindow: 128_000 }), null);
  assert.equal(sessionOccupancy({ promptTokens: 90_000, promptWindow: 128_000 })?.ratio, 0.703125);
});
