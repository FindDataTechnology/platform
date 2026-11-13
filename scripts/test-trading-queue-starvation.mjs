#!/usr/bin/env node
// ── 队列饥饿判据进 CI（change3 task 5.4 的判据，不是观察）───────────────
//
// 为什么单独一个文件：`npm run test:unit` 只拾 `scripts/test-*.mjs`，
// 而 `check-trading-queue-starved.mjs` 是给人跑的 CLI（自带 --selftest）。
// 判据本身必须**阻合并**，所以这里用 node:test 把 `judge()` 的每种形态钉住。
//
// 五态必须分得开，否则判据会在两种情况下骗人：
//   · 把"全是被豁免的等待"报成饥饿（豁免的活不能当 stalled 的证据）；
//   · 公平调度没启用时仍给结论（那时 per-fleet 计数不是权威口径）。
//
//   node --test scripts/test-trading-queue-starvation.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { judge } from "./check-trading-queue-starved.mjs";

/** 造一个 /api/monitor 形状的最小快照。 */
function snap({ queued = 0, running = 0, exempt = 0, fleets = [], enabled = true } = {}) {
  return { queue: { queued, running, queuedExempt: exempt,
                    fairness: { enabled, fleets } } };
}

test("健康：排队的都被公平队列认领", () => {
  const out = judge(snap({ queued: 3, fleets: [{ fleetId: "f1", queued: 3 }] }));
  assert.equal(out.verdict, "ok");
  assert.equal(out.numbers.unaccounted, 0);
});

test("饥饿：有 queued 但公平队列没认领 → 必须报出来并给出差额", () => {
  const out = judge(snap({ queued: 5, fleets: [{ fleetId: "f1", queued: 2 }] }));
  assert.equal(out.verdict, "starved");
  assert.equal(out.numbers.unaccounted, 3);
});

test("豁免：按设计等待的轮次不算饥饿（11-09 的教训）", () => {
  // 删掉 queuedExempt 扣减就会把这条报成 starved —— 破坏实验见 commit message。
  const out = judge(snap({ queued: 4, exempt: 4 }));
  assert.equal(out.verdict, "ok", "豁免的等待被当成了饥饿");
});

test("正在跑：那一条不在'等'的集合里", () => {
  assert.equal(judge(snap({ queued: 1, running: 1 })).verdict, "ok");
});

test("判不了：公平调度未启用（per-fleet 计数不是权威口径）", () => {
  const out = judge(snap({ queued: 9, enabled: false }));
  assert.equal(out.verdict, "cannot_judge");
});

test("判不了：读面缺字段（读面变了不能当健康）", () => {
  assert.equal(judge({ queue: { fairness: { enabled: true, fleets: [] } } }).verdict,
               "cannot_judge");
  assert.equal(judge({}).verdict, "cannot_judge");
});

test("反向：同一判据下把数据补平，结论必须翻面", () => {
  const starved = snap({ queued: 5, fleets: [{ queued: 2 }] });
  const fixed = snap({ queued: 2, fleets: [{ queued: 2 }] });
  assert.equal(judge(starved).verdict, "starved");
  assert.equal(judge(fixed).verdict, "ok");
});

test("多舰队：合计认领数要对，不能只看第一个舰队", () => {
  const out = judge(snap({ queued: 7, fleets: [{ queued: 2 }, { queued: 5 }] }));
  assert.equal(out.verdict, "ok");
  assert.equal(out.numbers.pendingSum, 7);
});
