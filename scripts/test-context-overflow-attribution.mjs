#!/usr/bin/env node
// ── Overflow must say WHY, not just that it happened ────────────────────────
//
// rotate-cron-session-on-context-pressure 4.1. Two different diseases produced
// the same symptom on 2026-11-09/10:
//
//   HISTORY ACCUMULATION — a cron session reused for months, cacheRead climbing
//     84,480 → 119,168 → 157,824 against a 128,000 window (cure: rotate);
//   ONE HUGE ROUND — a big tool reply or prompt in a single turn
//     (cure: do less per round).
//
// The cures are opposites, so `detail` has to say which one this was. The
// judgement uses the PREVIOUS round's cacheRead — once a round has failed, its
// own number is polluted by the failure path.
//
// Pinned here: the threshold, the honest-silence rule (no inputs ⇒ no claim),
// and that the failure classification itself is unchanged.
//
//   node --test scripts/test-context-overflow-attribution.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// cron-runner.js pulls the whole runtime (better-sqlite3 etc.), so a bare
// worktree without node_modules cannot import it. Skip-with-a-reason beats a
// fake red that hides real regressions.
let attributionFor = null;
let contextPressureDetail = null;
try {
  ({ attributionFor, contextPressureDetail } = await import(path.join(here, "../server/cron-runner.js")));
} catch (e) {
  console.warn(`[test] cron-runner unavailable (${e.code || e.message}); attribution cases skipped`);
}
const needsRunner = { skip: !attributionFor };

const WINDOW = 128_000;

test("1. the live regression shape is history accumulation", needsRunner, () => {
  // 157,824 / 128,000 = 1.23 — the session was already over the window.
  const a = attributionFor({ priorCacheRead: 157_824, contextWindow: WINDOW });
  assert.equal(a.cause, "history_accumulation");
  assert.equal(a.priorCacheRatio, 1.23);
});

test("2. a small prior round means this round itself was too big", needsRunner, () => {
  const a = attributionFor({ priorCacheRead: 16_768, contextWindow: WINDOW });
  assert.equal(a.cause, "single_round_too_large");
  assert.equal(a.priorCacheRatio, 0.13);
});

test("3. the 70% boundary counts as accumulation (>=, matching the rotate threshold)", needsRunner, () => {
  const at = attributionFor({ priorCacheRead: 89_600, contextWindow: WINDOW }); // exactly 0.7
  assert.equal(at.cause, "history_accumulation");
  const under = attributionFor({ priorCacheRead: 89_599, contextWindow: WINDOW });
  assert.equal(under.cause, "single_round_too_large");
});

test("4. no inputs ⇒ no claim (a guess is worse than silence)", needsRunner, () => {
  assert.deepEqual(attributionFor({}), {});
  assert.deepEqual(attributionFor({ priorCacheRead: 100_000 }), {}, "window unknown");
  assert.deepEqual(attributionFor({ contextWindow: WINDOW }), {}, "prior unknown");
  assert.deepEqual(attributionFor({ priorCacheRead: null, contextWindow: null }), {});
  assert.deepEqual(attributionFor({ priorCacheRead: "x", contextWindow: WINDOW }), {});
  assert.deepEqual(attributionFor({ priorCacheRead: -1, contextWindow: WINDOW }), {});
  assert.deepEqual(attributionFor({ priorCacheRead: 1000, contextWindow: 0 }), {});
});

test("5. the classification of the failure itself is unchanged", needsRunner, () => {
  const d = contextPressureDetail("pi-ai detected context overflow for model x", {
    priorCacheRead: 157_824,
    contextWindow: WINDOW,
  });
  assert.equal(d.kind, "context_overflow");
  assert.equal(d.overflow, true);
  assert.equal(d.contextPressure, true);
  assert.equal(d.cause, "history_accumulation", "attribution rides alongside, never replaces");
});

test("6. a non-pressure failure keeps returning null (no detail, no attribution)", needsRunner, () => {
  assert.equal(contextPressureDetail("upstream 502", { priorCacheRead: 157_824, contextWindow: WINDOW }), null);
});

test("7. compaction-storm shape is attributed too (budget kind, same cause field)", needsRunner, () => {
  const d = contextPressureDetail("turn timed out — context pressure", {
    compactions: 4,
    priorCacheRead: 16_768,
    contextWindow: WINDOW,
  });
  assert.equal(d.kind, "turn_budget_exceeded");
  assert.equal(d.cause, "single_round_too_large");
});

test("8. attribution is absent when inputs are missing, and nothing else changes", needsRunner, () => {
  const d = contextPressureDetail("context overflow", { compactions: 1 });
  assert.equal(d.cause, undefined);
  assert.equal(d.priorCacheRatio, undefined);
  assert.equal(d.kind, "context_overflow");
});

// ── 9-12. The WIRING (2026-11-10) ───────────────────────────────────────────
//
// Cases 1-8 above prove `attributionFor` is correct. They also let the bug hide:
// production showed 110 wall hits with `cause` on ZERO of them, because no caller
// ever passed the two inputs. The judgement was right and unreachable.
//
// The inputs live in different places — the runtime's window rides the turn's own
// detail, the previous round's occupancy rides an earlier row — so the fill
// belongs in the DB layer, where one transaction sees both. These cases drive the
// real recorder: append rows, read back, assert on `cause`.

// The fleet recorder needs its own sqlite file. It also needs db.js migrated
// first (action_audit lives there) — and a missing `initDb` used to make these
// cases SKIP, which is the same silence this whole change is about. So a broken
// setup now fails loudly instead of quietly reporting "skipped".
const wireDir = fs.mkdtempSync(path.join(os.tmpdir(), "cause-wiring-"));
process.env.CRON_STORAGE_PATH = wireDir;
process.env.PLATFORM_DATA_DIR = wireDir;
const { initDb } = await import(path.join(here, "../db.js"));
await initDb();
const { createFleetDatabase, setFleetDatabase } = await import(
  path.join(here, "../server/routes/fleets-db.js")
);
const fleetDb = createFleetDatabase();
setFleetDatabase(fleetDb);
const appendTurnEvent = fleetDb.appendTurnEvent;
assert.equal(typeof appendTurnEvent, "function", "fleet db must expose appendTurnEvent");
const needsDb = {};

const F = "f_cause";
// One member PER CASE. Sharing a member made case 10 read case 9's row as "the
// previous round" — a test that only passes in one execution order is not a test.
function member(tag) {
  const id = `m_${tag}`;
  try { fleetDb.createFleet({ id: F, name: "cause", ownerEmail: "o@t" }); } catch { /* exists */ }
  try {
    fleetDb.createMember({ id, fleetId: F, title: tag, targetKind: "persona", targetId: `user.preset-${tag}`,
      cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true } });
  } catch { /* exists */ }
  return id;
}
const pressure = (memberId, over = {}) => ({
  fleetId: F, memberId, source: "cron", status: "failed",
  startedAt: Date.now(), endedAt: Date.now(),
  error: "turn stopped early — context pressure",
  detail: { kind: "turn_budget_exceeded", contextPressure: true, compactions: 5, reported: true, contextWindow: WINDOW },
  ...over,
});

test("9. a big previous round settles as history_accumulation", needsDb, () => {
  const m = member("big");
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "s1", usage: { input: 90_000, output: 1_000 }, metering: { usageCachedInput: 110_000 } });
  const ev = appendTurnEvent(pressure(m, { sessionId: "s2" }));
  assert.equal(ev.detail.cause, "history_accumulation");
  assert.equal(ev.detail.priorCacheRatio, 0.86);
  assert.equal(ev.detail.priorBasis, "cache");
});

test("10. a small previous round settles as single_round_too_large (the bucket that never appeared)", needsDb, () => {
  const m = member("small");
  // Previous round reported input but NO cacheRead — the nullable-ALTER shape that
  // is half of production. Falling back to input is what makes this bucket reachable.
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "t1", usage: { input: 2_000, output: 100 } });
  const ev = appendTurnEvent(pressure(m, { sessionId: "t2" }));
  assert.equal(ev.detail.cause, "single_round_too_large");
  assert.equal(ev.detail.priorBasis, "input");
});

test("11. no contextWindow means no cause, and the rest of the detail is untouched", needsDb, () => {
  const m = member("nowin");
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "u1", usage: { input: 50_000, output: 100 } });
  const ev = appendTurnEvent(pressure(m, {
    sessionId: "u2",
    detail: { kind: "context_overflow", contextPressure: true, compactions: 0, reported: false },
  }));
  assert.equal(ev.detail.cause, undefined);
  assert.equal(ev.detail.priorBasis, undefined);
  assert.equal(ev.detail.kind, "context_overflow");
});

test("12. a non-pressure row is never inspected", needsDb, () => {
  const m = member("plain");
  const ev = appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok",
    startedAt: 1, endedAt: 2, sessionId: "v1", usage: { input: 10, output: 1 }, detail: { foo: 1 } });
  assert.deepEqual(ev.detail, { foo: 1 });
});

test("14. the timeout/early-stop error carries the window, so the consumer can judge", async () => {
  const { timeoutError } = await import(path.join(here, "../server/cron-runner.js"));
  // 2026-11-11 measured 105 context-pressure failures in 24h and 0 with a cause:
  // the producer never put `contextWindow` on the failure detail, so the whole
  // attribution path was unreachable by construction. With the window present
  // the consumer (fillContextCause) can finally answer.
  const withWin = timeoutError([], 0, 60_000, { compactions: 4, reported: true, contextWindow: 128_000 });
  assert.equal(withWin.detail.contextPressure, true);
  assert.equal(withWin.detail.contextWindow, 128_000, "runtime-reported window must ride the detail");
  const noWin = timeoutError([], 0, 60_000, { compactions: 4, reported: true });
  assert.equal(noWin.detail.contextPressure, true);
  assert.equal(noWin.detail.contextWindow, undefined, "an unreported window stays absent, never defaulted");
  const bogus = timeoutError([], 0, 60_000, { compactions: 4, contextWindow: 0 });
  assert.equal(bogus.detail.contextWindow, undefined, "a non-positive window is not a window");
});

test("15. a failure row without usage does not hide the previous round that had it", needsDb, () => {
  // The literal-latest-row lookup broke in a failure storm: consecutive pressure
  // failures carry usage_input/cached/output all NULL (measured 2026-11-11), so
  // every new failure read another anonymous row and no cause ever appeared.
  const m = member("storm");
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "x1", usage: { input: 100_000, output: 100 } });
  // Two anonymous failures sit between that round and the one being written.
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "failed", startedAt: 3, endedAt: 4,
    sessionId: "x2", error: "turn timed out — context pressure (4 compactions)",
    detail: { kind: "turn_budget_exceeded", contextPressure: true, compactions: 4 } });
  const ev = appendTurnEvent(pressure(m, { sessionId: "x3" }));
  assert.equal(ev.detail.cause, "history_accumulation");
  assert.equal(ev.detail.priorBasis, "input");
  assert.ok(ev.detail.priorCacheRatio >= 0.7);
});

test("13. a caller that already knows the cause keeps it (no overwrite)", needsDb, () => {
  const m = member("known");
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "w1", usage: { input: 100_000, output: 100 } });
  const ev = appendTurnEvent(pressure(m, {
    sessionId: "w2",
    detail: { kind: "turn_budget_exceeded", contextPressure: true, compactions: 5,
      reported: true, contextWindow: WINDOW, cause: "history_accumulation", priorCacheRatio: 1.23 },
  }));
  assert.equal(ev.detail.cause, "history_accumulation");
  assert.equal(ev.detail.priorCacheRatio, 1.23);
});

test("16. the per-request high-watermark wins over the turn-wide sums", needsDb, () => {
  // `usage_input` and `usage_cached_input` are TURN SUMS across steps; the
  // window is per-request. Dividing a sum by a window produced ratios above
  // 1.0 in production (measured 2026-11-11: 1.54 and 1.06) that looked like
  // occupancy and are not. `usage_input_max` is the same dimension as the
  // window, so it must win — the answer here is "this round was 0.47 of the
  // window", not "1.56 windows were read".
  const m = member("highwater");
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "hw1", usage: { input: 200_000, output: 100 },
    metering: { usageCachedInput: 200_000 }, inputTokensMax: 60_000 });
  const ev = appendTurnEvent(pressure(m, { sessionId: "hw2" }));
  assert.equal(ev.detail.priorBasis, "inputMax");
  assert.equal(ev.detail.priorCacheRatio, 0.47);
  assert.ok(ev.detail.priorCacheRatio <= 1, "a per-request ratio cannot exceed the window it is divided by by much");
  assert.equal(ev.detail.cause, "single_round_too_large");
});

test("17. rows written before the column existed still attribute, from the sums", needsDb, () => {
  // Backwards compatibility: a prior row with no high-watermark must still
  // answer, and `priorBasis` must say the figure came from an aggregate so the
  // ratio is never mistaken for occupancy.
  const m = member("nosum");
  appendTurnEvent({ fleetId: F, memberId: m, source: "cron", status: "ok", startedAt: 1, endedAt: 2,
    sessionId: "ns1", usage: { input: 100_000, output: 100 } });
  const ev = appendTurnEvent(pressure(m, { sessionId: "ns2" }));
  assert.equal(ev.detail.priorBasis, "input");
  assert.equal(ev.detail.cause, "history_accumulation");
});

test("18. 明细里同时有「起点」与「顶点」，才能区分基线过大与工具撑爆", async () => {
  const { contextPressureDetail } = await import(path.join(here, "../server/cron-runner.js"));
  const withFirst = contextPressureDetail("pi-ai detected context overflow for model \"m\"", {
    facts: { contextWindow: 128000, lastInputTokens: 172611, usageSteps: 3, firstInputTokens: 168000 },
  });
  assert.equal(withFirst.firstInputTokens, 168000, "起点必须落库：否则分不清是基线大还是一步撑爆");
  assert.equal(withFirst.lastInputTokens, 172611);
  // 起点与顶点接近 ⇒ 基线本来就装不下（hotel-watch-scout 的形状）
  assert.ok(withFirst.firstInputTokens > 128000 * 1.2);
  // 没报过用量就不写这个键（absent stays absent）
  const noFirst = contextPressureDetail("pi-ai detected context overflow for model \"m\"", {
    facts: { contextWindow: 128000, lastInputTokens: 140000, usageSteps: 2 },
  });
  assert.equal(noFirst.firstInputTokens, undefined);
  // 反例形状：起点很小、顶点很高 ⇒ 单个工具返回撑爆
  const toolBlewUp = contextPressureDetail("pi-ai detected context overflow for model \"m\"", {
    facts: { contextWindow: 128000, lastInputTokens: 170000, usageSteps: 2, firstInputTokens: 4000 },
  });
  assert.equal(toolBlewUp.firstInputTokens, 4000);
});
