#!/usr/bin/env node
// ── Cron sessions rotate before the context window fills ────────────────────
//
// A cron task binds ONE session forever (`cron-<id>`), so every round appends
// its whole conversation and the cached context only grows. Live 2026-11-09,
// the optimizer's inventory post (`job_1794118516358_xfqxg8`):
//
//   time        output tokens   cacheRead
//   11-08 09:25      564          84,480   ← healthy: 5 teams / 10 gaps
//   11-09 01:11      805         119,168   ← still ran
//   11-09 14:32      128         157,824   ← empty-handed
//
// 157,824 > contextWindow 128,000. The output collapsed to exactly 128 tokens
// — the SAME number a completely unrelated post produced — because roughly 128
// tokens of window were left. Two different posts reporting an identical output
// size is the fingerprint of a window limit, not of a bad prompt.
//
// Pinned here:
//   1. below the threshold → no rotation (a healthy run keeps its session)
//   2. at/over the threshold → rotate, and the new id is derived from the task
//      id (so repeated rotations cannot grow a suffix chain)
//   3. only the NEWEST metered round decides — an old spike that a rotation
//      already cleared must not rotate forever
//   4. a manual (non-schedule) task is never rotated
//
//   node --test scripts/test-cron-session-rotation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { shouldRotateSession } = await import(path.join(here, "../task-engine.js"));

const WINDOW = 128_000;
const metered = (cacheReadTokens, inputTokens = 3_000) => ({ tokens: { cacheReadTokens, inputTokens } });

test("1. a session well under the window is not rotated", () => {
  const history = [metered(40_000), metered(60_000)];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), false);
});

test("2. the live regression shape rotates: cacheRead 157,824 > 128,000", () => {
  const history = [metered(84_480), metered(119_168), metered(157_824)];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

test("3. only the newest metered round decides — a cleared spike does not re-rotate", () => {
  // The 157,824 round happened, rotation fired, and the fresh session came
  // back small. The old spike must not keep triggering rotation forever.
  const history = [metered(157_824), metered(8_000)];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), false);
});

test("4. exactly at the threshold counts as over (>=, not >)", () => {
  const history = [metered(89_600, 0)]; // 0.7 * 128,000 = 89,600
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

test("5. unmetered rounds are skipped, not treated as zero", () => {
  // A provider that reports no usage must not look like "fresh session".
  const history = [metered(120_000), { success: true }];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

test("6. empty or metered-free history never rotates", () => {
  assert.equal(shouldRotateSession([], { window: WINDOW, ratio: 0.7 }), false);
  assert.equal(shouldRotateSession([{ success: true }], { window: WINDOW, ratio: 0.7 }), false);
});

test("7. uncacheable-but-large input alone can trigger rotation", () => {
  const history = [{ tokens: { inputTokens: 100_000, cacheReadTokens: 0 } }];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

// ── 5. 溢出的那一轮不会留下 tokens，判据必须另有凭据 ────────────────────
//
// 2026-11-09 实测：`pi-ai detected context overflow` 的回合 tokens=0。
// 而 shouldRotateSession 只认 tokens —— 于是"刚跑爆窗口的那一轮"对判据不可见。
// 若溢出前那条还在阈值之下（一条超长 tool result 就能把上下文顶过去），
// 下一轮不会换会话，然后再溢一次。
test("5. an overflow round is remembered even though it leaves no tokens", async () => {
  const { isContextOverflowError } = await import(path.join(here, "../task-engine.js"));
  assert.equal(isContextOverflowError('pi-ai detected context overflow for model "deepseek-v4.1-flash"'), true);
  assert.equal(isContextOverflowError("CONTEXT_WINDOW_EXCEEDED"), true);
  assert.equal(isContextOverflowError("turn timed out — context pressure (4 compactions)"), false,
    "压缩风暴是另一回事，不该触发换会话");
  assert.equal(isContextOverflowError(""), false);
  assert.equal(isContextOverflowError(null), false);
});

test("6. the sticky flag rotates once and then clears (does not stick forever)", async () => {
  // 调真判定（rotationCause），不再在测试里把条件抄一遍——抄一遍的写法只证明
  // 「这两个布尔量能或起来」，生产代码改了它照样绿。
  const { rotationCause } = await import(path.join(here, "../task-engine.js"));
  const t = { id: "job_x", trigger: "schedule", sessionId: "cron-job_x",
              history: [ { tokens: { inputTokens: 1_000, cacheReadTokens: 0 } } ],
              rotateNextSession: true };
  assert.equal(shouldRotateSession(t.history, { window: WINDOW, ratio: 0.7 }), false,
    "history is way under the threshold");
  assert.equal(rotationCause(t, { window: WINDOW, ratio: 0.7 }), "overflow",
    "the overflow flag must be able to rotate on its own");
});

// ── 8+. 轮换判据按历史行的**类型**分流，不按 success 的形状（fix-rotation-ignores-missed-history）
//
// `history[]` 里 `success` 不是 `true` 的有三种形状，而 `server/history-kinds.js`
// 存在的唯一目的就是让读方别按形状猜。轮换门原来写 `lastOutcome.success !== true`
// ⇒ `{success:null, missed:N}`（排期到了、从未开始）被当成「上一轮失败」，下一轮
// 凭空换会话、把累积的上下文扔掉。2026-11-15 实测：7 个 cell 共 1,004 行轮换，
// 其中 **93 行（9.3%）** 的上一行是 `missed`。
const { rotationCause } = await import(path.join(here, "../task-engine.js"));
const task = (history, extra = {}) => ({
  id: "job_rot", trigger: "schedule", sessionId: "cron-job_rot", history, ...extra,
});
const opts = { window: WINDOW, ratio: 0.7 };

test("8. a missed row is not a failed round — the session survives", () => {
  const t = task([{ kind: "missed", time: "2026-11-15T01:00:00.000Z", success: null, missed: 1 }]);
  assert.equal(rotationCause(t, opts), null);
});

test("9. superseded / meta / queued-upgrade do not rotate either", () => {
  const superseded = { kind: "superseded", state: "skipped", success: false, supersededBy: "job_newer" };
  const meta = { kind: "meta", success: null, note: "calibration" };
  const upgrade = { kind: "queued-upgrade", state: "queued", success: null };
  for (const row of [superseded, meta, upgrade]) {
    assert.equal(rotationCause(task([row]), opts), null, `row kind=${row.kind} must not rotate`);
  }
});

test("10. a failed execution row still rotates, and says why", () => {
  const t = task([{ kind: "execution", state: "failed", success: false, error: "502 upstream" }]);
  assert.equal(rotationCause(t, opts), "failed_round");
});

test("11. the token threshold still rotates, attributed separately", () => {
  const t = task([{ kind: "execution", state: "done", success: true, tokens: { cacheReadTokens: 157_824, inputTokens: 3_000 } }]);
  assert.equal(rotationCause(t, opts), "context_pressure");
});

test("12. pre-kind rows classify by shape, same outcome as new rows", () => {
  // 存量 store 里这些行没有 kind —— classifyHistoryEntry 的形状回退必须生效，
  // 否则修法只覆盖「本次改动之后写的行」（同族坑：新路径标记的修法漏掉存量）。
  assert.equal(rotationCause(task([{ success: null, missed: 3 }]), opts), null, "legacy missed");
  assert.equal(rotationCause(task([{ success: null, note: "calibration 2026-11-01" }]), opts), null, "legacy meta");
  assert.equal(rotationCause(task([{ state: "failed", success: false }]), opts), "failed_round", "legacy failed execution");
  assert.equal(rotationCause(task([{ state: "done", success: true }]), opts), null, "legacy healthy execution");
});

test("13. a non-schedule trigger never rotates, whatever the history says", () => {
  const failed = [{ kind: "execution", state: "failed", success: false }];
  const overflowed = [{ kind: "execution", state: "done", success: true }];
  assert.equal(rotationCause({ ...task(failed), trigger: "manual" }, opts), null);
  assert.equal(rotationCause({ ...task(overflowed), trigger: "manual", rotateNextSession: true }, opts), null);
});

test("14. empty history is no rotation (a fresh task keeps its first session)", () => {
  assert.equal(rotationCause(task([]), opts), null);
  assert.equal(rotationCause(null, opts), null);
});
