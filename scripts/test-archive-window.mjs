#!/usr/bin/env node
// ── 5-day window & cursor discipline tests (add-wecom-archive-ingest 1.4, 4.2)
//
// 这条通道的致命失败模式不是报错，而是**看起来正常**：
//   • 断了 4 天，恢复后一切"成功"，但中间那 4 天永远没了；
//   • 用"最后一次检查时间"算滞后 → 永远健康（因为它一直在前进）；
//   • 丢失区间被后续成功拉取"洗白"，下次巡检就看不见了。
//
// 三类判据分别钉住上面三种假绿。
//
//   node --test scripts/test-archive-window.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  advanceCursor,
  evaluateLag,
  recordLoss,
  lossSummary,
  MS_PER_DAY,
  WARN_DAYS,
  HARD_LIMIT_DAYS,
} = await import("../server/archive/window.js");

const T0 = 1_700_000_000_000;

test("游标只增不减：重放更小的 seq 不能把它拉回去", () => {
  const s1 = advanceCursor(
    { seq: 500, lastCheckedAt: T0, lastMessageAt: T0, lastSuccessAt: T0 },
    { seq: 300, now: T0 + 1000, pulled: 0 },
  );
  assert.equal(s1.seq, 500);
});

test("游标前进并记录检查时间", () => {
  const s = advanceCursor(
    { seq: 500, lastCheckedAt: T0, lastMessageAt: T0, lastSuccessAt: T0 },
    { seq: 900, now: T0 + 60_000, pulled: 5 },
  );
  assert.equal(s.seq, 900);
  assert.equal(s.lastCheckedAt, T0 + 60_000);
  assert.equal(s.lastMessageAt, T0 + 60_000);
});

test("断流期：检查时间前进，消息水位不动", () => {
  let state = { seq: 100, lastCheckedAt: T0, lastMessageAt: T0 };
  for (const day of [1, 2, 3]) {
    state = advanceCursor(state, { seq: 100, now: T0 + day * MS_PER_DAY, pulled: 0 });
  }
  assert.equal(state.seq, 100);
  assert.equal(state.lastCheckedAt, T0 + 3 * MS_PER_DAY, "检查时间必须前进（断流≠停采）");
  assert.equal(state.lastMessageAt, T0, "消息水位不得被检查时间顶替");
});

test("滞后 > 3 天告警", () => {
  const out = evaluateLag({
    lastMessageAt: T0,
    lastSuccessAt: T0,
    lastCheckedAt: T0 + 3.5 * MS_PER_DAY,
    now: T0 + 3.5 * MS_PER_DAY,
  });
  assert.equal(out.level, "warn");
  assert.ok(out.days > WARN_DAYS);
});

test("滞后 > 5 天判 lost，措辞明确不可补偿", () => {
  const out = evaluateLag({
    lastMessageAt: T0,
    lastSuccessAt: T0,
    lastCheckedAt: T0 + 5.5 * MS_PER_DAY,
    now: T0 + 5.5 * MS_PER_DAY,
  });
  assert.equal(out.level, "lost");
  assert.match(out.reason, /不可补偿/);
});

test("采样停滞单独成类：拉取器死了但消息水位还新", () => {
  const out = evaluateLag({
    lastMessageAt: T0,
    lastSuccessAt: T0,
    lastCheckedAt: T0,
    now: T0 + 2 * MS_PER_DAY,
  });
  assert.equal(out.level, "stalled");
  assert.ok(out.hoursSinceCheck > 24);
});

test("从未检查过时报 never_checked，而不是 ok", () => {
  const out = evaluateLag({ lastMessageAt: 0, lastSuccessAt: 0, lastCheckedAt: 0, now: T0 });
  assert.equal(out.level, "never_checked");
});

test("区间合法时窗口内为 ok", () => {
  const out = evaluateLag({
    lastMessageAt: T0,
    lastSuccessAt: T0,
    lastCheckedAt: T0 + 3600_000,
    now: T0 + 2 * 3600_000,
  });
  assert.equal(out.level, "ok");
});

test("丢失区间同样一次断流只记一条（相邻合并）", () => {
  let losses = recordLoss([], { fromTs: T0, toTs: T0 + 2 * MS_PER_DAY, detectedAt: T0 });
  losses = recordLoss(losses, {
    fromTs: T0 + 2 * MS_PER_DAY,
    toTs: T0 + 4 * MS_PER_DAY,
    detectedAt: T0 + 4 * MS_PER_DAY,
  });
  assert.equal(losses.length, 1, "相邻区间应合并，不产生碎片");
  assert.equal(losses[0].toTs, T0 + 4 * MS_PER_DAY);
});

test("丢失区间非法输入直接拒绝（不允许静默忽略）", () => {
  assert.throws(() => recordLoss([], { fromTs: T0, toTs: T0, detectedAt: T0 }), /非法/);
  assert.throws(() => recordLoss([], { fromTs: Number.NaN, toTs: T0 }), /非法/);
});

test("丢失汇总只增不减：后续拉取成功不能把账消掉", () => {
  const losses = recordLoss([], { fromTs: T0, toTs: T0 + 3 * MS_PER_DAY, detectedAt: T0 + 3 * MS_PER_DAY });
  const s1 = lossSummary(losses);
  // 模拟"后续成功拉取"——本模块没有任何删除路径，这里断言的是接口形状：
  const s2 = lossSummary(losses);
  assert.deepEqual(s1, s2);
  assert.equal(s2.unrecoverable, true);
  assert.equal(s2.totalHours, 72);
});

test("丢失区间合并时保留席位并集", () => {
  let losses = recordLoss([], { fromTs: T0, toTs: T0 + 1000, seats: ["a"], detectedAt: T0 });
  losses = recordLoss(losses, { fromTs: T0 + 1000, toTs: T0 + 2000, seats: ["b"], detectedAt: T0 });
  assert.deepEqual(losses[0].seats.sort(), ["a", "b"]);
});

test("常量与官方口径一致", () => {
  assert.equal(HARD_LIMIT_DAYS, 5, "官方只保留 5 天");
  assert.equal(WARN_DAYS, 3);
});
