#!/usr/bin/env node
// ── 会话占用：一个算式，两处读者 ─────────────────────────────────────────────
//
// rotate-cron-session-on-context-pressure 1.1 + 1.2。
//
// 1.1 要「回合结束时把 cacheReadTokens 与窗口占比写进 turn detail」，1.2 要
// 「监控读面按岗位暴露当前会话占比，判定阈值的岗位能被筛出」。这两件事之所以
// 必须一起验，是因为它们共用一个算式：写侧算错，读面只会把一个错的数排得整整齐齐。
// 所以本文件钉三件事：
//
//   A. `sessionPressure` 的算术与「不知道就不猜」——尤其 `inputTokens: null`
//      不能被 `Number(null) === 0` 读成「空会话」（4.1 的归因判据在这里栽过一次）。
//   B. `shouldRotateSession` 与 `sessionPressure` **同源**：闸的裁决必须就是读面
//      报的那个 `over`，否则「读面说该换了、闸没换」这种矛盾没有人能判。
//   C. 读面整形（排序 / 过滤 / 只取最新带读数的那一条）与取数（每岗位最新**带读数**
//      的回合，无读数的更新回合不得把它遮掉）。
//
//   node --test scripts/test-context-pressure-face.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));

const tmpRoot = mkdtempSync(path.join(tmpdir(), "ctx-pressure-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");

const engine = await import("../task-engine.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { contextPressureFace } = await import("../server/context-pressure.js");

const WINDOW = 128_000;
const RATIO = 0.7;
const opts = { window: WINDOW, ratio: RATIO };

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── A. 算式 ──────────────────────────────────────────────────────────────────

test("A1. 没有 usage（或不是对象）⇒ 没有读数，不是 0", () => {
  assert.equal(engine.sessionPressure(undefined, opts), null);
  assert.equal(engine.sessionPressure(null, opts), null);
  assert.equal(engine.sessionPressure("1000", opts), null);
  assert.equal(engine.contextUsedTokens(null), null);
});

test("A2. `inputTokens: null` ⇒ null —— `Number(null)` 是 0，不能被读成空会话", () => {
  // 这条是 4.1 归因判据踩过的坑的回归钉子：只报 cacheRead、没报 input 的帧
  // 不是「上下文 = cacheRead」，而是「这一帧的 input 不知道」。
  assert.equal(engine.sessionPressure({ cacheReadTokens: 90_000 }, opts), null);
  assert.equal(engine.sessionPressure({ inputTokens: null, cacheReadTokens: 90_000 }, opts), null);
  // 反向：input 在、cacheRead 缺 ⇒ 视为 0（provider 没报命中＝这轮没有缓存前缀）。
  const p = engine.sessionPressure({ inputTokens: 1_000 }, opts);
  assert.equal(p.cacheReadTokens, 0);
  assert.equal(p.usedTokens, 1_000);
});

test("A3. 口径 = input + cacheRead，窗口占比按四位小数", () => {
  const p = engine.sessionPressure({ inputTokens: 60_000, cacheReadTokens: 29_600 }, opts);
  assert.equal(p.usedTokens, 89_600);
  assert.equal(p.basis, "step_usage", "没有高水位时退回单步 usage，且必须自报口径");
  assert.equal(p.contextWindow, WINDOW);
  assert.equal(p.threshold, RATIO);
  assert.equal(p.ratio, 0.7);
  assert.equal(p.overThreshold, true, "89,600 = 0.7 × 128,000 —— 边界算「到了」");

  const justUnder = engine.sessionPressure({ inputTokens: 60_000, cacheReadTokens: 29_599 }, opts);
  assert.equal(justUnder.overThreshold, false);

  const third = engine.sessionPressure({ inputTokens: 1, cacheReadTokens: 0 }, { window: 3, ratio: 0.7 });
  assert.equal(third.ratio, 0.3333, "0.33333… 四舍五入到四位");
});

test("A5. 每请求高水位在场时以它为准，**不与 usage 相加**", () => {
  // 2026-11-10 的真形状：`tokens`（单步 usage）里 cacheRead 已 206,048，而那几轮
  // 确实跑完了。旧口径 206k/128k = 1.6 ⇒「每轮都轮换」。用单请求高水位才是与窗口
  // 可比的量（`fleet-events.js:272-277` 记过同一条教训）。
  const usage = { inputTokens: 5_145, cacheReadTokens: 206_048 };
  const p = engine.sessionPressure(usage, { ...opts, promptTokens: 40_000 });
  assert.equal(p.basis, "prompt_high_water");
  assert.equal(p.usedTokens, 40_000, "高水位不与 usage 相加——相加等于把同一段 prompt 数两遍");
  assert.equal(p.ratio, 0.3125);
  assert.equal(p.overThreshold, false);
  // usage 侧分量照报（计费/审计要它），只是不参与占比
  assert.equal(p.inputTokens, 5_145);
  assert.equal(p.cacheReadTokens, 206_048);

  // 高水位为 0/null ⇒ 视为缺席，退回 usage（而不是算成「空会话」）
  assert.equal(engine.sessionPressure(usage, { ...opts, promptTokens: 0 }).basis, "step_usage");
  assert.equal(engine.sessionPressure(usage, { ...opts, promptTokens: null }).basis, "step_usage");
  // 两样都没有 ⇒ 没有读数
  assert.equal(engine.sessionPressure(null, { ...opts, promptTokens: null }), null);
  // 只有高水位、没有 usage ⇒ 仍能报占比（占比不依赖 usage）
  const onlyHigh = engine.sessionPressure(null, { ...opts, promptTokens: 96_000 });
  assert.equal(onlyHigh.basis, "prompt_high_water");
  assert.equal(onlyHigh.usedTokens, 96_000);
  assert.equal(onlyHigh.inputTokens, null, "usage 侧缺席就是 null，不补 0");
});

test("A6. promptHighWater 认两条车道的两个名字", () => {
  assert.equal(engine.promptHighWater({ inputTokens: 42 }), 42);
  assert.equal(engine.promptHighWater({ lastInputTokens: 43 }), 43);
  assert.equal(engine.promptHighWater({ inputTokens: 42, lastInputTokens: 43 }), 42, "工人池那个名字优先");
  assert.equal(engine.promptHighWater({}), null);
  assert.equal(engine.promptHighWater(null), null);
  assert.equal(engine.promptHighWater({ inputTokens: null, lastInputTokens: 7 }), 7, "null 不当 0");
});

test("A4. 窗口无效时不产出读数（没有分母就没有占比）", () => {
  assert.equal(engine.sessionPressure({ inputTokens: 5_000 }, { window: 0, ratio: 0.7 }), null);
  assert.equal(engine.sessionPressure({ inputTokens: 5_000 }, { window: Number.NaN, ratio: 0.7 }), null);
  assert.equal(engine.sessionPressure({ inputTokens: 5_000 }, { window: -1, ratio: 0.7 }), null);
});

// ── B. 闸与读面同源 ──────────────────────────────────────────────────────────

test("B1. shouldRotateSession 的裁决 = sessionPressure().overThreshold", () => {
  const usage = { inputTokens: 50_000, cacheReadTokens: 40_000 }; // 90,000 / 128,000
  const pressure = engine.sessionPressure(usage, opts);
  assert.equal(
    engine.shouldRotateSession([{ tokens: usage }], opts),
    pressure.overThreshold,
    "同一个 usage 上，闸与读面必须同向",
  );

  const under = { inputTokens: 30_000, cacheReadTokens: 10_000 };
  assert.equal(engine.shouldRotateSession([{ tokens: under }], opts), false);
});

test("B2. 只由最新一条**有** tokens 的回合决定；used=0 不算压力", () => {
  const spike = { inputTokens: 90_000, cacheReadTokens: 30_000 };
  const calm = { inputTokens: 1_000, cacheReadTokens: 0 };
  assert.equal(engine.shouldRotateSession([{ tokens: spike }, { tokens: calm }], opts), false,
    "最新那条已经降到阈值下 ⇒ 不轮换（旧尖峰不得反复触发）");
  assert.equal(engine.shouldRotateSession([{ tokens: calm }, { tokens: spike }], opts), true);
  // 最新一条没有 tokens ⇒ 跳过它，回看上一条有计量的
  assert.equal(engine.shouldRotateSession([{ tokens: spike }, {}], opts), true);
  // 只报了 output（used=0）⇒ 不是压力（与旧口径一致）
  assert.equal(engine.shouldRotateSession([{ tokens: { outputTokens: 500 } }], opts), false);
});

test("B3. 历史行带 `promptTokens` 时，闸用它而不是 usage 之和", () => {
  // 2026-11-10 的真形状：usage 的 cacheRead 206,048（除窗口 = 1.6 ⇒ 旧口径必换），
  // 而当轮单请求高水位只有 40,000。历史行上记了高水位就应该按它判。
  const row = { tokens: { inputTokens: 5_145, cacheReadTokens: 206_048 }, promptTokens: 40_000 };
  assert.equal(engine.shouldRotateSession([row], opts), false,
    "按单请求高水位 40k/128k = 0.31 ⇒ 不轮换；旧口径的 1.6 会每轮都换");
  // 同一条行去掉高水位 ⇒ 退回旧口径（老数据的既有行为不变）
  assert.equal(engine.shouldRotateSession([{ tokens: row.tokens }], opts), true);
  // 高水位本身也过阈值时照样换
  assert.equal(engine.shouldRotateSession([{ tokens: row.tokens, promptTokens: 120_000 }], opts), true);
});

// ── C. 读面整形 ──────────────────────────────────────────────────────────────

const ev = (memberId, ratio, over, extra = {}) => ({
  memberId,
  sessionId: `s-${memberId}`,
  endedAt: 1_700_000_000_000 + Math.round(ratio * 1000),
  detail: { contextUsage: { ratio, overThreshold: over, usedTokens: Math.round(ratio * WINDOW), inputTokens: 1000, cacheReadTokens: Math.round(ratio * WINDOW) - 1000, contextWindow: WINDOW } },
  ...extra,
});

test("C1. 按占比降序；summary 用全部岗位做分母", () => {
  const face = contextPressureFace([ev("m-low", 0.2, false), ev("m-high", 0.9, true), ev("m-mid", 0.5, false)]);
  assert.deepEqual(face.posts.map((p) => p.memberId), ["m-high", "m-mid", "m-low"]);
  assert.deepEqual(face.summary, { posts: 3, over: 1 });
  assert.equal(face.posts[0].ratio, 0.9);
  assert.equal(face.posts[0].over, true);
  assert.equal(face.posts[0].measuredAt, ev("m-high", 0.9, true).endedAt);
});

test("C2. `over: true` 只留超阈值岗位，但 summary.over 仍是全部岗位里的数", () => {
  const events = [ev("a", 0.9, true), ev("b", 0.8, true), ev("c", 0.1, false)];
  const filtered = contextPressureFace(events, { over: true });
  assert.deepEqual(filtered.posts.map((p) => p.memberId), ["a", "b"]);
  assert.deepEqual(filtered.summary, { posts: 3, over: 2 },
    "筛完仍要能说「3 个岗位里 2 个超了」——分母不能被筛选结果改写");

  const none = contextPressureFace([ev("c", 0.1, false)], { over: true });
  assert.deepEqual(none.posts, [], "一个都没超时返回空列表，而不是省略字段");
  assert.deepEqual(none.summary, { posts: 1, over: 0 });
});

test("C3. 没有读数的事件被跳过；占比读不出（null）仍留在列表里但沉底", () => {
  const noUsage = { memberId: "m-skip", sessionId: "s", endedAt: 1, detail: null };
  const broken = { memberId: "m-broken", sessionId: "s", endedAt: 1, detail: { contextUsage: { ratio: "not-a-number" } } };
  const face = contextPressureFace([noUsage, ev("m-ok", 0.4, false), broken]);
  assert.deepEqual(face.posts.map((p) => p.memberId), ["m-ok", "m-broken"],
    "「本轮没测到」不进列表；「测到了但占比读不出」要留在列表里——排序不能把不知道静默丢掉");
  assert.equal(face.posts[1].ratio, null);
});

test("C4. 同一岗位重复出现时，先到的（更新的）赢", () => {
  const face = contextPressureFace([ev("dup", 0.9, true), ev("dup", 0.1, false)]);
  assert.equal(face.posts.length, 1);
  assert.equal(face.posts[0].ratio, 0.9);
});

// ── G. 分母：运行时上报的窗口（2026-11-16 生产实测 411/481 条回合报 1,000,000）──
//
// 这一段是「同一批读数、换个分母就换个结论」的回归网。修复前分母是常量 128_000，
// 而生产里主模型上报的是 1,000,000：同一个 90,000 会被算成 70.3%（换会话）而不是 9%（不动）。
// 三条臂各自钉一个方向：认得上报值 / 上报值真的改变裁决 / 坏分母不许算出 NaN。

const M_WINDOW = 1_000_000;

test("G1. reportedContextWindow 认两个位置（成功回合顶层、失败回合 detail），缺了返回 null", () => {
  assert.equal(engine.reportedContextWindow({ contextWindow: M_WINDOW }), M_WINDOW,
    "成功回合：结算对象顶层（cron-runner 的 `{ ok:true, ...out }`、worker 重建的结算对象）");
  assert.equal(engine.reportedContextWindow({ detail: { contextWindow: M_WINDOW } }), M_WINDOW,
    "失败回合：溢出归因把窗口写在 detail 里");
  // 顶层是坏值但 detail 里有好值 ⇒ 用 detail 那个（别因为顶层有个键就放弃回退）
  assert.equal(engine.reportedContextWindow({ contextWindow: 0, detail: { contextWindow: M_WINDOW } }), M_WINDOW);
  for (const bad of [0, -1, "x", null, undefined]) {
    assert.equal(engine.reportedContextWindow({ contextWindow: bad }), null,
      `坏窗口 ${JSON.stringify(bad)} 必须报「没有」，不许拿来算分母`);
  }
  assert.equal(engine.reportedContextWindow(null), null);
});

test("G2. 历史行带 `promptWindow` 时闸用它自己的分母（这就是修复本体）", () => {
  // 生产实测的形状：1M 窗口的模型用了 90,000（真实 9%），缺省分母会把它算成 70.3%。
  const row = { tokens: { inputTokens: 60_000, cacheReadTokens: 30_000 }, promptWindow: M_WINDOW };
  assert.equal(engine.shouldRotateSession([row], opts), false,
    "1M 分母下 90k ⇒ 9% ⇒ 不换会话（修复前这里必红：128k 分母 = 70.3% ⇒ 换）");
  // 同一条行去掉分母 ⇒ 退回调用方的窗口：老数据既有行为不变，且这正是修复前的读数
  assert.equal(engine.shouldRotateSession([{ tokens: row.tokens }], opts), true,
    "没有分母的老行仍按 128k 判（不许因为新增字段就把老行的结论改掉）");
  // 分母在场、真的用到 70% ⇒ 照样换（不是把闸关掉）
  assert.equal(
    engine.shouldRotateSession([{ tokens: { inputTokens: 700_000, cacheReadTokens: 0 }, promptWindow: M_WINDOW }], opts),
    true,
    "700k/1M = 0.70 ⇒ 抵线即换（`>=`，与阈值口径一致）",
  );
});

test("G3. 分母换了，读数与裁决必须一起变（只改一个字段就是假修）", () => {
  const usage = { inputTokens: 60_000, cacheReadTokens: 30_000 };
  const small = engine.sessionPressure(usage, { window: 128_000, ratio: 0.7 });
  const large = engine.sessionPressure(usage, { window: M_WINDOW, ratio: 0.7 });
  assert.equal(small.contextWindow, 128_000);
  assert.equal(large.contextWindow, M_WINDOW, "读数要把分母一起报出来，否则 0.09 与 0.70 无从分辨");
  assert.equal(small.ratio, 0.7031);
  assert.equal(large.ratio, 0.09);
  assert.equal(small.overThreshold, true);
  assert.equal(large.overThreshold, false);
});

test("G4. 坏分母不许算出 Infinity/NaN；换分母也不许改 `basis`", () => {
  for (const bad of [0, -1, "x", null]) {
    assert.equal(
      engine.shouldRotateSession([{ tokens: { inputTokens: 90_000, cacheReadTokens: 0 }, promptWindow: bad }], opts),
      true,
      `坏分母 ${JSON.stringify(bad)} 必须退回调用方的窗口（按缺省 128k 判 ⇒ 换），不许算出 NaN 后静默 false`,
    );
  }
  const p = engine.sessionPressure(
    { inputTokens: 10, cacheReadTokens: 20 },
    { window: M_WINDOW, ratio: 0.7, promptTokens: 90_000 },
  );
  assert.equal(p.basis, "prompt_high_water", "分母不参与分子选择");
  assert.equal(p.usedTokens, 90_000);
  assert.equal(p.contextWindow, M_WINDOW);
});

// ── D. 取数：每岗位最新**带读数**的回合 ──────────────────────────────────────

test("D1. 无读数的更新回合不得遮掉该岗位已知的占比；跨舰队不串", () => {
  const db = createFleetDatabase({ file: path.join(tmpRoot, "fleets-pressure.db") });
  const at = 1_700_000_000_000;
  const push = (fleetId, memberId, detail, endedAt = at) => db.appendTurnEvent({
    fleetId,
    memberId,
    source: "cron",
    status: "ok",
    startedAt: endedAt - 1000,
    endedAt,
    sessionId: `s-${memberId}`,
    detail,
  });

  const usage = (ratio, over) => ({ contextUsage: { ratio, overThreshold: over, usedTokens: 1, inputTokens: 1, cacheReadTokens: 0, contextWindow: WINDOW } });

  // m1：先一条带读数（0.9），再来一条更新的无读数（skipped/无 usage）。
  push("f1", "m1", usage(0.9, true), at);
  push("f1", "m1", null, at + 1000);
  // m2：带读数 0.2
  push("f1", "m2", usage(0.2, false), at);
  // 另一个舰队的同形行不得混进来
  push("f2", "m1", usage(0.99, true), at);

  const events = db.latestTurnContextByFleet("f1");
  assert.equal(events.length, 2, "两个岗位各一条（m1 的更新空回合不算一条读数）");

  const face = contextPressureFace(events);
  assert.deepEqual(face.posts.map((p) => p.memberId), ["m1", "m2"],
    "m1 仍是带读数的 0.9，不是被空回合抹掉、也不是拿到 f2 那份 0.99");
  assert.equal(face.posts[0].ratio, 0.9);
  assert.deepEqual(face.summary, { posts: 2, over: 1 });

  db.close();
});

// ── E. HTTP 读面（1.2 的验收原文：字段存在、超阈值岗位能被筛出）────────────────

test("E1. GET /api/fleets/:id/context-pressure 给出每岗占比，?over=1 筛出超阈值岗位", async () => {
  const { setFleetDatabase } = await import("../server/routes/fleets-db.js");
  const db = createFleetDatabase({ file: path.join(tmpRoot, "fleets-http.db") });
  setFleetDatabase(db);

  const fleet = db.createFleet({ id: "fleet_ctx", name: "上下文读面", ownerEmail: "owner@test" });
  const member = (id) => db.createMember({
    id,
    fleetId: fleet.id,
    title: id,
    parentId: null,
    targetKind: "persona",
    targetId: "persona-a",
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
  });
  const turn = (id, ratio, over) => {
    member(id);
    db.appendTurnEvent({
      fleetId: fleet.id,
      memberId: id,
      source: "cron",
      status: "ok",
      startedAt: Date.now() - 1_000,
      endedAt: Date.now(),
      sessionId: `s-${id}`,
      detail: { contextUsage: { ratio, overThreshold: over, usedTokens: Math.round(ratio * WINDOW), inputTokens: 1_000, cacheReadTokens: 0, contextWindow: WINDOW } },
    });
  };
  turn("m-hot", 0.92, true);
  turn("m-cold", 0.11, false);

  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: () => ({ alive: true, label: "x" }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const all = await (await fetch(`${base}/api/fleets/${fleet.id}/context-pressure`)).json();
    assert.equal(all.fleetId, fleet.id);
    assert.deepEqual(all.summary, { posts: 2, over: 1 });
    assert.deepEqual(all.posts.map((p) => p.memberId), ["m-hot", "m-cold"], "按占比降序");
    // 「读面字段存在」逐字段实测——少一个字段，下游就得自己拼。
    for (const key of ["memberId", "sessionId", "measuredAt", "ratio", "usedTokens", "inputTokens", "cacheReadTokens", "contextWindow", "over"]) {
      assert.ok(key in all.posts[0], `读面必须带 ${key}`);
    }

    const only = await (await fetch(`${base}/api/fleets/${fleet.id}/context-pressure?over=1`)).json();
    assert.deepEqual(only.posts.map((p) => p.memberId), ["m-hot"], "只剩判定超阈值的岗位");
    assert.deepEqual(only.summary, { posts: 2, over: 1 }, "筛选不改分母：仍能说「2 个岗位里 1 个超了」");
  } finally {
    server.close();
    db.close();
  }
});

// ── F. 结构：两处写入缝都走同一个算式，且分母同源 ────────────────────────────
//
// 这条是**结构性**判据，不是行为判据：`finishExecution`（cron history 行）与
// `recordFleetTurnEvent`（回合事件 detail）各自要接一次 `sessionPressure`，而两处
// 都在巨型模块的深处，没有能离线驱动的入口。行为面判据「任一 cron 回合的 detail
// 含两字段」必须等这次改动随镜像出片之后才能真跑（已在 tasks.md 记明）。
// 在拿到镜像之前，这条至少保证「有人删掉接线」不会静默通过。
test("F1. 两处写入缝都调用 sessionPressure，且分母都是运行时上报的那个", () => {
  const read = (rel) => readFileSync(path.join(here, "..", rel), "utf8");
  const engineSrc = read("task-engine.js");
  assert.match(engineSrc, /const contextUsage = sessionPressure\(result\?\.usage, \{\s*\n\s*promptTokens,/,
    "cron history 行必须由 result 派生 contextUsage，且带上每请求高水位");
  assert.match(engineSrc, /\.\.\.\(promptTokens !== null \? \{ promptTokens \} : \{\}\),/,
    "高水位必须落到历史行上，否则下一轮的闸仍然只能用单步 usage 那个错口径");
  // 分母（2026-11-16）：历史行与读面各要一个，且都必须来自运行时上报。
  assert.match(engineSrc, /const promptWindow = reportedContextWindow\(result\);/,
    "历史行的分母必须来自运行时上报，常量只是兜底");
  assert.match(engineSrc, /\.\.\.\(promptWindow !== null \? \{ promptWindow \} : \{\}\),/,
    "分母必须落到历史行上，否则下一轮的闸只能拿常量当分母");
  assert.match(engineSrc, /const effectiveWindow = rowWindow !== null && rowWindow > 0 \? rowWindow : window;/,
    "闸必须优先用那一行自己的分母");
  assert.match(read("server.js"), /engine\.sessionPressure\?\.\(outcome\?\.usage, \{\s*\n?\s*promptTokens: engine\.promptHighWater\?\.\(outcome\)/,
    "回合事件 detail 的 contextUsage 必须由 outcome 派生，且同样带高水位");
  assert.match(read("server.js"), /engine\.reportedContextWindow\?\.\(outcome\)/,
    "回合事件 detail 的分母必须与历史行同源（两处各解一次就会出现读面与历史行各报一个）");
});
