#!/usr/bin/env node
// 会话轮换/累积读数的用例（`scripts/lib/cron-session-metrics.mjs` 是纯函数，可离线全测）。
//
// 每条都钉一个**会改变结论**的口径，不是「函数能跑」：
//   1 分位数空样本 → null（不许把「没样本」读成 0）
//   2 `mx<=0` / 非数的行被丢弃（「没量到」≠「占用 0」）
//   3 会话按 `started_at` 升序，组内排序不受输入顺序影响
//   4 长度分布直方图的桶界（1 / 2-3 / 4-6 / 7-12 / >12）
//   5 累积斜率**允许为负**（一半会话是逐轮变小）
//   6 到线人口的分母只算多轮会话（单轮不该稀释占比）
//   7 阈值判定与 `shouldRotateSession` 同口径（含 used<=0 ⇒ false）
//   8 轮换归因三条路径分开数：lastFailed / overflow / threshold
//   9 归因把「解释不了」单列（不许并进 lastFailed 或 threshold）
//  10 轮换率的分母是**执行行**，missed/skipped 行不参与
//  11 `period` 之外：非 execution 行夹在中间不改变归因（对齐 task-engine 的 prev 取值）
//
//   node --test scripts/test-cron-session-metrics.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const m = await import(path.join(here, "lib/cron-session-metrics.mjs"));

test("1. 分位数：空样本返回 null，不返回 0", () => {
  assert.equal(m.quantile([], 0.5), null);
  assert.equal(m.quantile([undefined, null, Number.NaN], 0.5), null);
  // 单样本三档同值
  assert.equal(m.quantile([7], 0.1), 7);
  assert.equal(m.quantile([7], 0.9), 7);
  // p50 取 floor 索引（10 个样本的 p50 = 第 6 个，不是插值）
  assert.equal(m.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 6);
});

test("2. mx 非正/非数的行被丢弃（没量到 ≠ 占用 0）", () => {
  const s = m.sessionize([
    { sid: "a", at: 1, mx: 0 },
    { sid: "a", at: 2, mx: null },
    { sid: "a", at: 3, mx: "90000" },
    { sid: "a", at: 4, mx: 30_000 },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].rounds, 1);
  assert.equal(s[0].list[0].mx, 30_000);
});

test("3. 会话内按 started_at 升序，与输入顺序无关", () => {
  const s = m.sessionize([
    { sid: "b", at: 30, mx: 40_000 },
    { sid: "b", at: 10, mx: 20_000 },
    { sid: "b", at: 20, mx: 30_000 },
  ]);
  assert.deepEqual(
    s[0].list.map((r) => r.at),
    [10, 20, 30],
  );
  // 会话之间也按首个回合时间排
  const two = m.sessionize([
    { sid: "z", at: 100, mx: 1 },
    { sid: "y", at: 5, mx: 1 },
  ]);
  assert.deepEqual(
    two.map((x) => x.sid),
    ["y", "z"],
  );
});

test("4. 长度分布桶界：1 / 2-3 / 4-6 / 7-12 / >12", () => {
  const mk = (n) => ({ sid: `s${n}`, rounds: n, list: [] });
  const st = m.sessionLengthStats([mk(1), mk(2), mk(3), mk(4), mk(6), mk(7), mk(12), mk(13), mk(20)]);
  assert.deepEqual(st.histogram, { "1 轮": 1, "2-3 轮": 2, "4-6 轮": 2, "7-12 轮": 2, ">12 轮": 2 });
  assert.equal(st.sessions, 9);
  assert.equal(st.singleRound, 1);
  assert.equal(st.max, 20);
});

test("5. 累积斜率允许为负（逐轮变小不许抹成 0）", () => {
  const slope = m.accumulationSlopes([
    { sid: "down", rounds: 3, list: [{ mx: 90_000 }, { mx: 70_000 }, { mx: 50_000 }] },
    { sid: "flat", rounds: 2, list: [{ mx: 30_000 }, { mx: 30_000 }] },
    { sid: "one", rounds: 1, list: [{ mx: 10_000 }] },
  ]);
  assert.equal(slope.length, 2, "单轮会话不进斜率样本");
  const byId = Object.fromEntries(slope.map((s) => [s.sid, s.slope]));
  assert.equal(byId.down, -20_000);
  assert.equal(byId.flat, 0);
});

test("6. 到线人口的分母只算多轮会话", () => {
  const mk = (n, mx) => ({ sid: `s${n}-${mx}`, rounds: n, list: Array.from({ length: n }, () => ({ mx })) });
  const r = m.peakReach([mk(1, 500_000), mk(3, 90_000), mk(2, 40_000)], {
    threshold: 89_600,
    window: 128_000,
  });
  assert.equal(r.considered, 2, "单轮会话不进分母");
  assert.equal(r.reachedThreshold, 1);
  assert.equal(r.reachedWindow, 0);
});

test("7. 阈值判定与 shouldRotateSession 同口径", () => {
  const hit = [{ tokens: { inputTokens: 700, cacheReadTokens: 89_000 } }];
  assert.equal(m.thresholdWouldRotate(hit, 89_600), true);
  // used<=0 ⇒ false（不是「小于阈值」那么宽——它连比例都不成立）
  assert.equal(m.thresholdWouldRotate([{ tokens: { inputTokens: 0, cacheReadTokens: 0 } }], 0), false);
  // 末尾无 tokens 的行跳过，继续往前找
  assert.equal(m.thresholdWouldRotate([{ tokens: { inputTokens: 90_000 } }, { time: "x" }], 89_600), true);
  assert.equal(m.thresholdWouldRotate([], 89_600), false);
});

test("8. 轮换归因：三条路径分开数", () => {
  const tasks = [
    {
      id: "t1",
      history: [
        { kind: "execution", success: false, error: "turn timed out" }, // 失败但不是溢出
        { kind: "execution", success: true, sessionRotated: true },
        { kind: "execution", success: false, error: "pi-ai detected context overflow" },
        { kind: "execution", success: true, sessionRotated: true },
        { kind: "execution", success: true, tokens: { inputTokens: 90_000 } },
        { kind: "execution", success: true, sessionRotated: true },
      ],
    },
  ];
  const a = m.rotationAttribution(tasks, 89_600);
  assert.equal(a.counts.lastFailed, 1);
  assert.equal(a.counts.overflow, 1);
  assert.equal(a.counts.threshold, 1);
  assert.equal(a.counts.residue, 0);
  assert.equal(a.executedRows, 6);
  assert.equal(a.rotatedRows, 3);
});

test("9. 解释不了的轮换单列，不并进 lastFailed/threshold", () => {
  const tasks = [
    {
      id: "job_x",
      history: [
        { kind: "execution", success: true, tokens: { inputTokens: 10_000 } },
        { kind: "execution", success: true, sessionRotated: true }, // 上一轮成功、闸说不换
      ],
    },
  ];
  const a = m.rotationAttribution(tasks, 89_600);
  assert.equal(a.counts.residue, 1);
  assert.equal(a.counts.lastFailed, 0);
  assert.equal(a.counts.threshold, 0);
  assert.deepEqual(a.examples.residue, ["job_x"]);
});

test("10. 轮换率的分母是执行行，missed/skipped 不参与", () => {
  const tasks = [
    {
      history: [
        { kind: "missed", missed: 2 },
        { kind: "execution", success: true },
        { kind: "skipped" },
        { kind: "execution", sessionRotated: true },
      ],
    },
  ];
  const r = m.rotationRate(tasks);
  assert.equal(r.executed, 2);
  assert.equal(r.rotated, 1);
  assert.equal(r.rate, 0.5);
  assert.equal(m.rotationRate([]).rate, null, "分母 0 ⇒ null，不是 0%");
});

test("11. 非 execution 行夹在中间不改变归因（对齐 prev 的取法）", () => {
  const tasks = [
    {
      id: "t2",
      history: [
        { kind: "execution", success: false, error: "502 upstream" },
        { kind: "missed", missed: 1 }, // 夹在中间的降载记账行
        { kind: "execution", success: true, sessionRotated: true },
      ],
    },
  ];
  const a = m.rotationAttribution(tasks, 89_600);
  assert.equal(a.counts.lastFailed, 1, "prev 应取最近一条 execution，而不是那行 missed");
  assert.equal(a.counts.residue, 0);
});

test("12. 单轮高水位分布：空样本全 null", () => {
  const s = m.roundHighWaterStats([]);
  assert.deepEqual(s, { rounds: 0, p50: null, p90: null, p99: null, max: null });
  const one = m.roundHighWaterStats([{ mx: 42_000 }]);
  assert.equal(one.rounds, 1);
  assert.equal(one.max, 42_000);
});
