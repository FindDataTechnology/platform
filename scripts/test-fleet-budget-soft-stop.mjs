// Budget soft stop (fix-turn-budget-soft-stop).
//
// Measured on production (2026-11-13, 7 days, per-cell `member_turn_events`):
//   cell 3fdc7b8e8ac03b68 — 263 `failed/timeout "turn timed out"` avg 605s
//     (range mostly 600-622s) against 760 ok rounds averaging 191s;
//   cell 6db2b1b4b490223b — 32 such timeouts avg 603s against 108 ok at 163s.
// The detail breakdown says the dominant shape is `kind=turn_budget_exceeded`
// with 10-28 tool steps and NO compactions: the round was working, and simply
// ran out of wall clock. Their MINIMUM elapsed is the budget itself — nobody is
// "two seconds short", so raising the wall rescues almost none of them (two
// rounds raised to 14 minutes still died at 840s).
//
// What is lost is the last stretch: by the time the wall lands the round holds
// a dozen-plus steps of evidence and files nothing, because the existing
// salvage lane only answered to `contextPressure`.
//
// Two properties are pinned here:
//   1. a fleet round soft-stops at a fraction of its budget (default 0.8) and
//      says so in its detail — instead of burning the whole budget;
//   2. the salvage lane accepts that shape too, so the report comes back.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "budget-soft-stop-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
delete process.env.FLEET_BUDGET_SOFT_STOP; // the policy under test must be ON by default

const {
  collectTurn,
  shouldSalvageReport,
  softStopEnabled,
  resolveSoftStopRatio,
  resolveSoftStopMs,
  runWrapUpReport,
  attributeFailureAndSalvage,
  cancelAndWait,
  awaitCancelSettled,
  CANCEL_SETTLE_MAX_MS,
} = await import("../server/cron-runner.js");

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const makeCtx = () => ({ sessionCollectors: new Map(), taskTurnRegistry: new Map() });

// ── 1. The policy (pure) ────────────────────────────────────────────────────

test("the soft-stop ratio is bounded and a bad value falls back to the default", () => {
  assert.equal(resolveSoftStopRatio(undefined), 0.8, "default");
  assert.equal(resolveSoftStopRatio(0.6), 0.6, "a declared value inside the band is honoured");
  assert.equal(resolveSoftStopRatio("0.7"), 0.7, "a string from a JSON config is accepted");
  for (const bad of [0, 0.1, 0.49, 0.96, 1, -1, NaN, "", "abc", null]) {
    assert.equal(resolveSoftStopRatio(bad), 0.8, `out-of-band/invalid ${String(bad)} must fall back`);
  }
});

test("the soft stop lands at budget x ratio, and a non-positive budget means no stop", () => {
  assert.equal(resolveSoftStopMs(600_000, 0.8), 480_000);
  assert.equal(resolveSoftStopMs(600_000, 0.6), 360_000);
  assert.equal(resolveSoftStopMs(120_000), 96_000, "default ratio applies");
  assert.equal(resolveSoftStopMs(0), null);
  assert.equal(resolveSoftStopMs(-5), null);
  assert.equal(resolveSoftStopMs(NaN), null);
});

test("the policy is on by default and can be switched off", () => {
  assert.equal(softStopEnabled(), true);
  process.env.FLEET_BUDGET_SOFT_STOP = "0";
  try {
    assert.equal(softStopEnabled(), false, "FLEET_BUDGET_SOFT_STOP=0 turns it off");
  } finally {
    delete process.env.FLEET_BUDGET_SOFT_STOP;
  }
});

// ── 2. The turn settles EARLY, with the new attribution ─────────────────────

test("a fleet round soft-stops at the ratio instead of burning the whole budget", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  const budgetMs = 400;
  const softStopRatio = 0.5; // → 200ms, well before the 400ms wall
  const startedAt = Date.now();
  const p = collectTurn(ctx, "soft-1", budgetMs, new Map(), collectors, "soft-1", {
    earlyStop: true,
    softStopRatio,
  });
  const push = collectors.get("soft-1");
  // Ten steps of real work: the production shape (10-28 steps, no compactions).
  for (let i = 0; i < 10; i++) push({ method: "session.event", params: { event: { type: "tool/call", data: { callId: `c${i}`, name: "bash", arguments: "{}" } } } });
  const err = await p.then(() => null, (e) => e);
  const elapsed = Date.now() - startedAt;
  assert.ok(err, "the round did not complete");
  assert.equal(err.earlyStop, true, "it is an early stop, not a wall timeout");
  assert.equal(err.detail.budgetSoftStop, true, "the cause is nameable in the ledger");
  assert.equal(err.detail.steps, 10, "the evidence the round had gathered rides the detail");
  assert.equal(err.detail.budgetMs, budgetMs);
  assert.equal(err.detail.softStopAtMs, 200);
  assert.ok(err.detail.elapsedMs >= 180, `elapsedMs should be near the soft stop, got ${err.detail.elapsedMs}`);
  assert.match(err.message, /budget soft stop/);
  // The whole point: it gave back the remaining budget.
  assert.ok(elapsed < budgetMs - 40, `must settle before the wall (settled at ${elapsed}ms of ${budgetMs}ms)`);
});

test("a round that is not a fleet round keeps its full budget", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  const budgetMs = 150;
  const startedAt = Date.now();
  const p = collectTurn(ctx, "human-1", budgetMs, new Map(), collectors, "human-1", { earlyStop: false });
  await p.then(() => null, () => null);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= budgetMs - 25, `a human turn must not soft-stop early (settled at ${elapsed}ms)`);
});

// ── 3. The salvage lane accepts the new shape ───────────────────────────────

test("salvage answers 'no report filed', not only 'context pressure'", () => {
  const soft = { kind: "turn_budget_exceeded", budgetSoftStop: true, reported: false, hasOutput: true };
  assert.equal(shouldSalvageReport(soft, { isFleet: true }), true, "a soft-stopped round with no report needs the lane");
  assert.equal(shouldSalvageReport({ ...soft, reported: true }, { isFleet: true }), false, "a filed report needs nothing");
  assert.equal(shouldSalvageReport(soft, { isFleet: false }), false, "fleet-only");
  assert.equal(shouldSalvageReport(soft, { isFleet: true, interrupted: true }), false, "an abort is not the round's fault");
  assert.equal(
    shouldSalvageReport({ kind: "turn_budget_exceeded", reported: false }, { isFleet: true }),
    false,
    "neither pressure nor soft stop is NOT the lane's business (unchanged)",
  );
  // The pressure shape must keep working exactly as before.
  assert.equal(shouldSalvageReport({ kind: "turn_budget_exceeded", contextPressure: true, reported: false }, { isFleet: true }), true);
});

// ── 4. End to end: soft stop → the report comes back ────────────────────────

test("端到端：软停之后收尾把报数补回来，结论仍是失败", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  const p = collectTurn(ctx, "soft-e2e", 300, new Map(), collectors, "soft-e2e", { earlyStop: true, softStopRatio: 0.5 });
  const push = collectors.get("soft-e2e");
  push({ method: "session.event", params: { event: { type: "tool/call", data: { callId: "a", name: "bash", arguments: "{}" } } } });
  push({ method: "session.event", params: { event: { type: "tool/result", data: { message: { source: { callId: "a" }, content: [{ type: "text", text: "ok" }] } } } } });
  const err = await p.then(() => null, (e) => e);
  assert.ok(err?.detail?.budgetSoftStop, "the seam produced a soft stop");
  assert.equal(shouldSalvageReport(err.detail, { isFleet: true }), true, "and it reaches the salvage branch");

  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      assert.match(blocks[0].text, /report_status/);
      const c = ctx.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交：本轮 3 条结论" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const wrap = await runWrapUpReport(ctx, { childSessionId: "soft-e2e", mirrorSessionId: "soft-e2e", timeoutMs: 2000 });
  assert.match(wrap?.text ?? "", /补交：本轮 3 条结论/, "the report is recovered from the same child session");
});

test("the seam keeps a self-attributed soft stop and still salvages", async () => {
  // Regression this pins (found while wiring it): `attributeFailureAndSalvage`
  // re-derived the detail from the error TEXT, and `contextPressureDetail`
  // returns null for a soft stop (no compactions, no overflow). The feature
  // would then have existed and done nothing: no marker in the ledger, no
  // wrap-up. The turn's own attribution must win.
  const ctx = makeCtx();
  const soft = new Error("turn stopped early — budget soft stop (480s of 600s)");
  soft.earlyStop = true;
  soft.detail = { kind: "turn_budget_exceeded", steps: 16, budgetSoftStop: true, elapsedMs: 480_000, reported: false };

  const prompts = [];
  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      prompts.push(blocks[0].text);
      const c = ctx.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交：16 步的结论" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const out = await attributeFailureAndSalvage(ctx, {
    error: soft,
    childSessionId: "seam-1",
    mirrorSessionId: "seam-1",
    isFleet: true,
    reported: false,
    text: "",
  });
  assert.ok(out, "the seam must not discard a soft stop (it used to return null here)");
  assert.equal(out.budgetSoftStop, true, "the marker reaches the ledger");
  assert.equal(out.steps, 16, "and the step evidence with it");
  assert.equal(prompts.length, 1, "exactly one bounded follow-up");
  assert.equal(out.wrapUp?.ok, true, "and the report came back");
});

// ── 5. The stop and the ask are one sequence ────────────────────────────────
// (fix-salvage-report-after-soft-stop) Measured 2026-11-15: of 32 salvage
// attempts after a soft stop, 25 came back empty and every empty one returned in
// 0–2 s — refused instantly, never timed out. The stop cancelled the session and
// the lane immediately asked that same session for its report.

test("cancelAndWait hands back the stop request instead of dropping it", async () => {
  let waited = false;
  const settled = await cancelAndWait("s1", {
    cancelSession: () => new Promise((resolve) => setTimeout(() => { waited = true; resolve({ ok: true }); }, 10)),
  });
  assert.equal(settled.ok, true, "a cancel that lands is reported as landed");
  assert.equal(waited, true, "and the caller waited for it");

  assert.deepEqual(
    await cancelAndWait("s1", { cancelSession: () => undefined }),
    { ok: false, reason: "no_cancel_entry" },
    "a bridge with no canceller must SAY so — 'nobody was asked to stop' is not 'the stop landed'",
  );
  assert.equal((await cancelAndWait("s1", { cancelSession: () => { throw new Error("boom"); } })).reason, "cancel_threw");
  assert.equal(
    (await cancelAndWait("s1", { cancelSession: () => Promise.reject(new Error("nope")) })).reason,
    "cancel_failed",
  );
});

test("the wait for a cancel is bounded — a cancel that never answers cannot hold the slot", async () => {
  const never = new Promise(() => {});
  const t0 = Date.now();
  const out = await awaitCancelSettled(never, 30);
  const elapsed = Date.now() - t0;
  assert.deepEqual(out, { settled: false, reason: "cancel_wait_timeout" }, "the bound is reported, not silently swallowed");
  assert.ok(elapsed >= 25 && elapsed < CANCEL_SETTLE_MAX_MS, `bounded (took ${elapsed}ms)`);

  const landed = await awaitCancelSettled(Promise.resolve({ ok: true }), 1_000);
  assert.equal(landed.settled, true, "a cancel that lands is observed, not timed out");
});

test("the salvage asks only after the stop has landed", async () => {
  const ctx = makeCtx();
  const order = [];
  const soft = new Error("turn stopped early — budget soft stop (480s of 600s)");
  soft.earlyStop = true;
  soft.detail = { kind: "turn_budget_exceeded", steps: 9, budgetSoftStop: true, elapsedMs: 480_000, budgetMs: 600_000, reported: false };
  soft.cancelSettled = new Promise((resolve) => setTimeout(() => { order.push("cancel"); resolve({ ok: true }); }, 20));

  ctx.dshBridge = {
    prompt: async (sessionId) => {
      order.push("prompt");
      const c = ctx.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交：9 步" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const out = await attributeFailureAndSalvage(ctx, {
    error: soft, childSessionId: "seq-1", mirrorSessionId: "seq-1", isFleet: true, reported: false, text: "",
  });
  assert.deepEqual(order, ["cancel", "prompt"], "the ask must not race its own cancellation");
  assert.equal(out.wrapUp?.ok, true, "and the report still comes back");
  assert.equal(out.wrapUp?.reason, undefined, "a successful wrap-up carries no reason key");
});

test("an unconfirmed stop is only stamped when a stop was actually in flight", async () => {
  // (a) the bound expires with the cancel still in flight — that IS the fact
  // that explains a `send_failed`, so it must be recorded. Costs the real 5s
  // bound: no test hook in production code, and a shortened bound would test a
  // path the cell never runs.
  const stuck = makeCtx();
  const soft = new Error("turn stopped early — budget soft stop (480s of 600s)");
  soft.earlyStop = true;
  soft.detail = { kind: "turn_budget_exceeded", steps: 9, budgetSoftStop: true, elapsedMs: 480_000, budgetMs: 600_000, reported: false };
  soft.cancelSettled = new Promise(() => {}); // never answers
  stuck.dshBridge = {
    prompt: async (sessionId) => {
      const c = stuck.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const out = await attributeFailureAndSalvage(stuck, {
    error: soft, childSessionId: "stuck-1", mirrorSessionId: "stuck-1", isFleet: true, reported: false, text: "",
  });
  assert.equal(out.wrapUp?.ok, true, "the ask still goes out — the bound does not eat the salvage");
  assert.equal(out.wrapUp?.cancelUnconfirmed, "cancel_wait_timeout", "and the unconfirmed stop is on the record");

  // (b) nothing was cancelled at all — the common case. Stamping
  // `no_pending_cancel` here would put the field on almost every row and make
  // it unreadable, so the key must be absent.
  const plain = makeCtx();
  plain.dshBridge = {
    prompt: async (sessionId) => {
      const c = plain.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const noCancel = await attributeFailureAndSalvage(plain, {
    error: "pi-ai detected context overflow for model \"m\"",
    childSessionId: "plain-1", mirrorSessionId: "plain-1", isFleet: true,
  });
  assert.equal(noCancel.wrapUp?.ok, true);
  assert.equal("cancelUnconfirmed" in (noCancel.wrapUp ?? {}), false, "no cancel to wait for is not an unconfirmed stop");
});

test("an empty wrap-up says WHY — three causes, three different fixes", async () => {
  // (a) the lane is not addressable at all
  const bare = makeCtx();
  assert.deepEqual(
    await runWrapUpReport(bare, { childSessionId: "x", timeoutMs: 50 }),
    { text: "", reason: "no_send_entry" },
  );

  // (b) the session refuses the prompt (cancelled / foreign / busy)
  const refusing = makeCtx();
  refusing.dshBridge = { prompt: async () => { throw new Error("session is cancelled"); } };
  const refused = await runWrapUpReport(refusing, { childSessionId: "x", timeoutMs: 50 });
  assert.equal(refused.text, "");
  assert.equal(refused.reason, "send_failed", "a refused send is not the same thing as a silent child");

  // (c) delivered, answered nothing
  const silent = makeCtx();
  silent.dshBridge = {
    prompt: async (sessionId) => {
      const c = silent.sessionCollectors.get(sessionId);
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const empty = await runWrapUpReport(silent, { childSessionId: "x", timeoutMs: 500 });
  assert.equal(empty.text, "");
  assert.equal(empty.reason, "empty_reply", "delivered-but-empty is distinguishable from refused");

  // (d) the reply never came inside the bound
  const quiet = makeCtx();
  quiet.dshBridge = { prompt: async () => {} };
  const timedOut = await runWrapUpReport(quiet, { childSessionId: "x", timeoutMs: 60 });
  assert.equal(timedOut.text, "");
  assert.equal(timedOut.reason, "collect_timeout", "a deadline is its own cause");
});

test("every salvage seam goes through one entry — no seam asks without waiting", () => {
  // The history of this module is one seam getting a fix the others did not:
  // the worker pool was fixed, then the chain stayed silent, then the chain
  // waited while the serial/cell chain (runPersonaTurn) still asked before its
  // own early-stop cancel landed. A behavioural test cannot see the third seam
  // (it needs a live runtime), so pin the STRUCTURE: runWrapUpReport is reached
  // through salvageReportAfterStop and nowhere else.
  const chain = fs.readFileSync(new URL("../server/cron-runner.js", import.meta.url), "utf8");
  const pool = fs.readFileSync(new URL("../server/worker-slots.js", import.meta.url), "utf8");
  const calls = [...`${chain}\n${pool}`.matchAll(/runWrapUpReport\(/g)].length;
  assert.equal(
    calls,
    2,
    "exactly one definition + ONE call site (inside the shared entry); found " + calls,
  );
  // 1 definition + 2 chain seams (attributeFailureAndSalvage, runPersonaTurn).
  assert.equal([...chain.matchAll(/salvageReportAfterStop\(/g)].length, 3);
  // The pool seam goes through it too.
  assert.equal([...pool.matchAll(/salvageReportAfterStop\(/g)].length, 1);
});

test("a round that already reported is not asked again", async () => {
  const ctx = makeCtx();
  const prompts = [];
  ctx.dshBridge = { prompt: async () => { prompts.push(1); } };
  const out = await attributeFailureAndSalvage(ctx, {
    error: Object.assign(new Error("turn stopped early — budget soft stop (480s of 600s)"), {
      earlyStop: true,
      detail: { kind: "turn_budget_exceeded", budgetSoftStop: true, elapsedMs: 480_000, budgetMs: 600_000, reported: true, hasOutput: true },
    }),
    childSessionId: "reported-1", mirrorSessionId: "reported-1", isFleet: true, reported: true, text: "已经报过了",
  });
  assert.equal(prompts.length, 0, "no second ask");
  assert.equal(out.wrapUp, undefined, "and no wrapUp marker pretending one happened");
  assert.deepEqual(
    { ...out.salvageSkipped },
    { isFleet: true, interrupted: false, pressure: false, softStop: true, reported: true },
    "the row says 'already reported', which is NOT the same as 'salvage failed'",
  );
  assert.equal(out.budgetSoftStop, true, "the failure itself is untouched");
});
