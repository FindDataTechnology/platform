// Context pressure + report salvage (fix-fleet-turn-budget, explore P0′-1).
//
// Production, 2026-11-08: 143 fleet rounds in one day, 82 ok. Of the 28 that
// died on the turn budget, **22 landed no report at all** — the round burned
// 600s compacting and produced nothing. One trace: 240 events over 535s with
// every 15–49s gap inside compaction/start|summary|end.
//
// Two things are pinned here:
//   1. the failure NAMES its cause (`contextPressure` + the compaction count)
//      instead of a bare "timed out";
//   2. an empty, pressure-killed fleet round gets ONE bounded, tool-free
//      follow-up asking for the report — the round stays failed (it did not
//      finish), but the fleet stops losing the data.
//
// Run: node --test scripts/test-fleet-context-pressure.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-pressure-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

const { collectTurn, timeoutError, runWrapUpReport, shouldSalvageReport } = await import("../server/cron-runner.js");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A ctx with no bridge: the collector is driven by hand, exactly as the child
// would drive it.
const makeCtx = () => ({ sessionCollectors: new Map(), taskTurnRegistry: new Map() });

test("collector counts compaction/start and reports it on idle", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  const p = collectTurn(ctx, "s1", 5000, new Map(), collectors, "s1");
  const push = collectors.get("s1");
  assert.ok(push, "collector registered");
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  push({ method: "session.event", params: { event: { type: "compaction/summary" } } });
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "部分结论" }] } } } } });
  // The report must land BEFORE the idle that settles the turn — the collector
  // is deregistered on settlement, so anything after it is dropped (this is
  // exactly the ordering mistake a real turn cannot make).
  push({ method: "session.event", params: { event: { type: "tool/call", data: { callId: "c9", name: "mcp__fleet__report_status", arguments: "{}" } } } });
  push({ method: "session.event", params: { event: { type: "tool/result", data: { message: { source: { callId: "c9" }, content: [{ type: "text", text: "ok" }] } } } } });
  push({ method: "session.status", params: { status: "idle" } });
  const out = await p;
  assert.equal(out.compactions, 2, "two starts counted; summaries are not");
  assert.equal(out.text, "部分结论");
  assert.equal(out.reported, true, "a completed report_status call is observed as filed");
});

test("timeout attribution names context pressure only past the threshold", () => {
  const tools = [{ name: "bash", at: Date.now() - 1000, result: "ok" }];
  const plain = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 1, hasOutput: false });
  assert.equal(plain.message, "turn timed out", "one compaction is not a storm");
  assert.equal(plain.detail.contextPressure, undefined);
  assert.equal(plain.detail.compactions, 1, "the count still rides for diagnosis");

  const storm = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 3, hasOutput: false, reported: false });
  assert.equal(storm.detail.contextPressure, true);
  assert.match(storm.message, /context pressure \(3 compactions\)/);
  assert.equal(storm.detail.hasOutput, false);
  assert.equal(storm.detail.reported, false, "the report fact rides the attribution");

  const filed = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 3, hasOutput: true, reported: true });
  assert.equal(filed.detail.reported, true);
  assert.equal(shouldSalvageReport(filed.detail, { isFleet: true }), false, "a timeout after filing needs no salvage");
});

test("wrap-up asks the same session for the report, tool-free and bounded", async () => {
  const ctx = makeCtx();
  const prompts = [];
  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      prompts.push({ sessionId, text: blocks[0].text });
      const push = ctx.sessionCollectors.get(sessionId);
      push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "已交报数" }] } } } } });
      push({ method: "session.status", params: { status: "idle" } });
    },
  };
  const out = await runWrapUpReport(ctx, { childSessionId: "child-1", mirrorSessionId: "mirror-1" });
  assert.equal(prompts.length, 1, "exactly one follow-up");
  assert.equal(prompts[0].sessionId, "child-1", "same child session — it still has the work in context");
  assert.match(prompts[0].text, /report_status/);
  assert.match(prompts[0].text, /不要调用其他工具/, "the follow-up refuses other tools");
  assert.match(prompts[0].text, /不要解释|不要继续分析/, "and refuses prose — one call, then done");
  assert.equal(out.text, "已交报数");
});

test("wrap-up never becomes the outcome: a failing follow-up returns null", async () => {
  const ctx = makeCtx();
  ctx.dshBridge = { prompt: async () => { throw new Error("runtime gone"); } };
  // Bounded: the follow-up must not wait out its full ceiling after the
  // prompt already threw (a 90s wait in a unit test is not a test).
  assert.equal(await runWrapUpReport(ctx, { childSessionId: "child-2", timeoutMs: 100 }), null);
});

test("判据：压力 + 空产出 + 舰队任务，三者同时成立才补收尾", () => {
  const pressure = { kind: "turn_budget_exceeded", compactions: 3, contextPressure: true, reported: false, hasOutput: false };
  assert.equal(shouldSalvageReport(pressure, { isFleet: true }), true, "the round this lane exists for");
  assert.equal(shouldSalvageReport({ ...pressure, reported: true }, { isFleet: true }), false, "a round that already filed its report needs nothing");
  // The live correction: five pressure-killed rounds HAD text and still filed
  // nothing. Output is not the test — the report is.
  assert.equal(shouldSalvageReport({ ...pressure, hasOutput: true, reported: false }, { isFleet: true }), true, "text without a report still needs the lane");
  assert.equal(shouldSalvageReport(pressure, { isFleet: false }), false, "fleet-only");
  assert.equal(shouldSalvageReport(pressure, { isFleet: true, interrupted: true }), false, "a runtime abort is not the round's fault");
  assert.equal(shouldSalvageReport({ kind: "turn_budget_exceeded", compactions: 1, reported: false }, { isFleet: true }), false, "one compaction is not a storm");
  assert.equal(shouldSalvageReport(null, { isFleet: true }), false);
});

test("端到端（缝级）：真超时产生 pressure 归因，随后收尾把报数补回来", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  // A real collector that times out after two compactions and no output.
  const p = collectTurn(ctx, "child-e2e", 120, new Map(), collectors, "mirror-e2e");
  const push = collectors.get("child-e2e");
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, "the turn timed out");
  assert.equal(err.detail.contextPressure, true);
  assert.equal(err.detail.hasOutput, false);
  assert.equal(shouldSalvageReport(err.detail, { isFleet: true }), true, "the seam reaches the salvage branch");

  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      assert.match(blocks[0].text, /report_status/);
      const c = ctx.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交：本周 3 篇" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const salvaged = await runWrapUpReport(ctx, { childSessionId: "child-e2e", mirrorSessionId: "mirror-e2e" });
  assert.equal(salvaged.text, "补交：本周 3 篇");
});

// ── the overflow shape (fix-fleet-output-salvage D3) ────────────────────────
const { contextPressureDetail, OVERFLOW_RE, attributeFailureAndSalvage } = await import("../server/cron-runner.js");

test("overflow 也归压力类，且与超时共用判据", () => {
  // The live error the runtime emits when the working set stops fitting.
  const err = 'pi-ai detected context overflow for model "deepseek-v4.1-flash"';
  const d = contextPressureDetail(err, { compactions: 0, reported: false });
  assert.equal(d.contextPressure, true, "an overflow is pressure, not an unknown failure");
  assert.equal(d.kind, "context_overflow");
  assert.equal(d.overflow, true);
  assert.equal(shouldSalvageReport(d, { isFleet: true }), true, "and it earns the salvage lane");
  assert.equal(shouldSalvageReport({ ...d, reported: true }, { isFleet: true }), false, "unless it already reported");

  // Not every failure is pressure.
  assert.equal(contextPressureDetail("502: upstream service temporarily unavailable"), null);
  assert.equal(contextPressureDetail("budget_exhausted: all candidate models over daily budget"), null);
  assert.equal(contextPressureDetail("turn timed out", { compactions: 1 }), null, "one compaction is not a storm");
  assert.equal(contextPressureDetail("turn timed out", { compactions: 3 }).kind, "turn_budget_exceeded");

  assert.ok(OVERFLOW_RE.test(err));
});

test("接线：overflow 失败走收尾补数（与超时同一条组合）", async () => {
  const ctx = makeCtx();
  let wrapUps = 0;
  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      assert.match(blocks[0].text, /report_status/);
      wrapUps += 1;
      const push = ctx.sessionCollectors.get(sessionId);
      push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交" }] } } } } });
      push({ method: "session.status", params: { status: "idle" } });
    },
  };
  const detail = await attributeFailureAndSalvage(ctx, {
    error: 'pi-ai detected context overflow for model "m"',
    childSessionId: "child-ovf",
    mirrorSessionId: "mirror-ovf",
    isFleet: true,
  });
  assert.equal(detail.contextPressure, true);
  assert.equal(detail.kind, "context_overflow");
  assert.equal(wrapUps, 1, "the salvage lane ran on the overflow path");
  assert.deepEqual(detail.wrapUp, { ok: true, chars: 2 });

  // Non-pressure failures are left exactly as they were.
  assert.equal(await attributeFailureAndSalvage(ctx, { error: "502 upstream unavailable", isFleet: true }), null);
  // A fleet round that already reported needs nothing.
  const quiet = await attributeFailureAndSalvage(ctx, {
    error: 'context overflow', reported: true, childSessionId: "child-x", isFleet: true,
  });
  assert.equal(quiet.wrapUp, undefined);
});

test("失败回合留下收尾判据的四项事实（下次不用从外面猜）", () => {
  const { shouldSalvageReport: judge } = { shouldSalvageReport };
  const facts = { isFleet: true, interrupted: false, pressure: true, reported: false };
  assert.equal(judge({ contextPressure: facts.pressure, reported: facts.reported }, { isFleet: facts.isFleet, interrupted: facts.interrupted }), true);
  // And the shape the runner writes is the one a reader can act on.
  assert.deepEqual(Object.keys(facts).sort(), ["interrupted", "isFleet", "pressure", "reported"]);
});

// ── early stop (fix-fleet-output-salvage D5) ────────────────────────────────
const { earlyStopEnabled } = await import("../server/cron-runner.js");

test("arm：舰队回合在压缩风暴超过阈值时原生取消并结算为压力", async () => {
  const ctx = makeCtx();
  let cancelled = [];
  ctx.dshBridge = { cancelSession: async (sid) => { cancelled.push(sid); } };
  const collectors = new Map();
  // The floor is injectable so the POLICY is under test, not a 60s wait.
  const p = collectTurn(ctx, "child-es", 30000, new Map(), collectors, "mirror-es", { earlyStop: true, earlyStopAfterMs: 0 });
  const push = collectors.get("child-es");
  // Four compactions — the hard line (EARLY_STOP_COMPACTIONS). The doc comment
  // said "six" when the threshold was still 6; the value was lowered after a
  // FIVE-compaction round also burned the full 600s and landed nothing.
  for (let i = 0; i < 4; i++) push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, "the turn settles without waiting out the budget");
  assert.equal(err.detail.contextPressure, true);
  assert.equal(err.detail.compactions, 4);
  assert.equal(err.earlyStop, true);
  assert.match(err.message, /stopped early — context pressure/);
  assert.deepEqual(cancelled, ["child-es"], "the runtime is cancelled natively, not left running");
  assert.equal(shouldSalvageReport(err.detail, { isFleet: true }), true, "and the salvage lane still applies");
});

test("首 60 秒内的压缩风暴不会绕过闸门（线上 8 例的形状）", async () => {
  // 原实现的判定只在 compaction/start 里做，且要求「计数到阈值」与「已跑够下限」
  // 在**同一个事件**上同时成立。于是开场风暴（阈值内的压缩全发生在下限之前，
  // 之后再没有压缩事件）永远判不中，回合一路跑到预算耗尽。
  // 线上 2026-11-09：48 次压力超时里 44 次压缩数已过阈值却没早停，n=4 的全是这个形状。
  const ctx = makeCtx();
  let cancelled = [];
  ctx.dshBridge = { cancelSession: async (sid) => { cancelled.push(sid); } };
  const collectors = new Map();
  // 下限非 0 —— 上一版测试全部注入 0，正好把这个缺陷遮住了。
  // 预算给 2s：闸门坏了就用"跑满预算"失败，2 秒内见红，而不是等 30s。
  const p = collectTurn(ctx, "child-burst", 2000, new Map(), collectors, "mirror-burst",
    { earlyStop: true, earlyStopAfterMs: 120 });
  const push = collectors.get("child-burst");
  // 4 次压缩立刻发生（全部早于 120ms 的下限），之后**没有任何事件**。
  for (let i = 0; i < 4; i++) push({ method: "session.event", params: { event: { type: "compaction/start" } } });

  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(settled, false, "还没到时间下限，不许提前判死");

  const err = await p.then(() => null, (e) => e);
  assert.ok(err, "下限到点后必须复判并结算");
  assert.equal(err.earlyStop, true);
  assert.equal(err.detail.compactions, 4);
  assert.match(err.message, /stopped early — context pressure \(4 compactions\)/);
  assert.deepEqual(cancelled, ["child-burst"]);
});

test("风暴之下（未达阈值）不会因为定时器而提前停", async () => {
  // 反向守卫：到点复判只在计数已达阈值时才存在，3 次压缩照旧跑满预算。
  const ctx = makeCtx();
  let cancelled = 0;
  ctx.dshBridge = { cancelSession: async () => { cancelled++; } };
  const collectors = new Map();
  const p = collectTurn(ctx, "child-under", 30000, new Map(), collectors, "mirror-under",
    { earlyStop: true, earlyStopAfterMs: 30 });
  const push = collectors.get("child-under");
  for (let i = 0; i < 3; i++) push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  await new Promise((r) => setTimeout(r, 90));
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "below the hard line the round keeps its budget");
  assert.equal(cancelled, 0);
  push({ method: "session.status", params: { status: "idle" } });
  const out = await p;
  assert.equal(out.compactions, 3);
});

test("非舰队回合不提前停（人类/普通定时保留完整预算）", async () => {
  const ctx = makeCtx();
  let cancelled = 0;
  ctx.dshBridge = { cancelSession: async () => { cancelled++; } };
  const collectors = new Map();
  const p = collectTurn(ctx, "child-web", 30000, new Map(), collectors, "child-web");
  const push = collectors.get("child-web");
  for (let i = 0; i < 8; i++) push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, "no early stop without the flag");
  assert.equal(cancelled, 0);
  push({ method: "session.status", params: { status: "idle" } });
  const out = await p;
  assert.equal(out.compactions, 8, "the count is still reported");
});

test("FLEET_EARLY_STOP=0 可整条关掉", () => {
  const saved = process.env.FLEET_EARLY_STOP;
  process.env.FLEET_EARLY_STOP = "0";
  assert.equal(earlyStopEnabled(), false);
  delete process.env.FLEET_EARLY_STOP;
  assert.equal(earlyStopEnabled(), true);
  if (saved !== undefined) process.env.FLEET_EARLY_STOP = saved;
});

// ── 溢出证据（fix-overflow-attribution）──────────────────────────────────
//
// 2026-11-10：12h 内 28/215 回合以 context overflow 失败，而失败行 usage_input
// 恒 null、detail 里没有撞墙时的输入量与解析窗口——为分清「真到顶」与「窗口被
// 声明错」，当晚写了三个临时探针去 trace 里捞。这三条钉住「行数据自己说得清」。

test("collector 记录运行时解析的窗口与撞墙时的最大输入", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  const p = collectTurn(ctx, "s-ov", 5000, new Map(), collectors, "s-ov");
  const push = collectors.get("s-ov");
  push({ method: "session.event", params: { event: { type: "request/context", data: { provider: "volces", model: "m", contextWindow: 128000 } } } });
  push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [] }, usage: { input: 60000, output: 10, cacheReadTokens: 20000 } } } } });
  // 后一步更小（压缩之后）——高水位不能被它覆盖
  push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [] }, usage: { input: 1000, output: 10 } } } } });
  push({ method: "session.status", params: { status: "idle" } });
  const out = await p;
  assert.equal(out.contextWindow, 128000);
  assert.equal(out.lastInputTokens, 80000, "billed input = input + cacheRead，取高水位");
  assert.equal(out.usageSteps, 2);
});

test("溢出 detail 带四字段；窗口缺失时为 null，不回落声明值", async () => {
  const { contextPressureDetail } = await import("../server/cron-runner.js");
  const withWin = contextPressureDetail('pi-ai detected context overflow for model "m"', {
    facts: { contextWindow: 128000, lastInputTokens: 118034, usageSteps: 6 },
    steps: 7,
    toolResults: 6,
  });
  assert.equal(withWin.kind, "context_overflow");
  assert.equal(withWin.lastInputTokens, 118034);
  assert.equal(withWin.contextWindow, 128000);
  assert.equal(withWin.usageSteps, 6);
  assert.equal(withWin.steps, 7);
  assert.equal(withWin.toolResults, 6);

  // 运行时没报窗口 → 字段缺席（不是 0、不是 128000）
  const noWin = contextPressureDetail("context overflow", { facts: { contextWindow: null, lastInputTokens: 4631, usageSteps: 3 } });
  assert.equal(noWin.lastInputTokens, 4631);
  assert.ok(!("contextWindow" in noWin), "an unresolved window must be absent, never the catalog's declaration");

  // 非压力失败：detail 仍为 null（逐字节不变）
  assert.equal(contextPressureDetail("turn timed out", { compactions: 0 }), null);
});

test("提前收口默认关；开了才在 95% 处停", async () => {
  const { collectTurn: ct, overflowPreemptEnabled, OVERFLOW_PREEMPT_RATIO } = await import("../server/cron-runner.js");
  assert.equal(OVERFLOW_PREEMPT_RATIO, 0.95);
  assert.equal(overflowPreemptEnabled(), false, "默认关");

  const drive = async (preempt) => {
    const prev = process.env.FLEET_OVERFLOW_PREEMPT;
    if (preempt) process.env.FLEET_OVERFLOW_PREEMPT = "1";
    else delete process.env.FLEET_OVERFLOW_PREEMPT;
    const ctx = makeCtx();
    ctx.dshBridge = { cancelSession: () => Promise.resolve() };
    const collectors = new Map();
    const p = ct(ctx, `s-p-${preempt}`, 5000, new Map(), collectors, `s-p-${preempt}`);
    const push = collectors.get(`s-p-${preempt}`);
    push({ method: "session.event", params: { event: { type: "request/context", data: { contextWindow: 100000 } } } });
    push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [] }, usage: { input: 96000 } } } } });
    const settled = await Promise.race([
      p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 120)),
    ]);
    if (prev === undefined) delete process.env.FLEET_OVERFLOW_PREEMPT;
    else process.env.FLEET_OVERFLOW_PREEMPT = prev;
    return settled;
  };

  const off = await drive(false);
  assert.equal(off.timeout, true, "开关关：不提前收口，回合照常继续");
  const on = await drive(true);
  assert.equal(on.ok, false, "开关开：达 95% 即收口");
  assert.match(String(on.e.message), /context overflow/);
  assert.equal(on.e.detail.kind, "context_overflow");
  assert.equal(on.e.detail.lastInputTokens, 96000);
  assert.equal(on.e.detail.contextWindow, 100000);
});

test("markPartialUsage：有 usage 才盖章，无 detail 不造", async () => {
  const { markPartialUsage } = await import("../server/cron-runner.js");
  assert.equal(markPartialUsage(null, { input: 1 }), null, "没有 detail 就不造一个");
  const same = markPartialUsage({ kind: "x" }, null);
  assert.equal(same.kind, "x", "无 usage 原样返回");
  assert.ok(!("usagePartial" in same), "没测到用量就不许说它是半截");
  const marked = markPartialUsage({ kind: "context_overflow" }, { input: 100 });
  assert.equal(marked.usagePartial, true);
  assert.equal(marked.kind, "context_overflow", "原有字段必须保留");
});

test("失败行的 usage 与 usagePartial 一路落到行形状", async () => {
  const { shapeTurnOutcome } = await import("../server/fleet-events.js");
  const detail = {
    kind: "context_overflow",
    contextPressure: true,
    overflow: true,
    lastInputTokens: 118034,
    contextWindow: 128000,
    usagePartial: true,
  };
  const shaped = shapeTurnOutcome({ ok: false, error: "pi-ai detected context overflow", detail, usage: { input: 118034, output: 900 } });
  assert.equal(shaped.status, "failed");
  assert.equal(shaped.detail.usagePartial, true, "半截用量必须自证是半截");
  assert.equal(shaped.detail.lastInputTokens, 118034);
  assert.equal(shaped.detail.contextWindow, 128000);
  // 用量本身也保留（否则这一行看起来像「从没跑过」）
  assert.ok(shaped.usage == null || shaped.usage.input === 118034, "usage 必须随失败行落下");
});

test("成本窗口把半截用量计入花费，但单独报出 partialTurns", async () => {
  const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-cost-"));
  const db = createFleetDatabase({ file: path.join(dir, "c.db") });
  const fleet = db.createFleet({ id: "f_cost", name: "成本舰", ownerEmail: "o@t" });
  db.createMember({ id: "m1", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p1", parentId: null, kpiSlots: [], cadence: null });
  const now = Date.now();
  // 一个整轮（有 usage）+ 一个 overflow 半截（也带 usage）
  const priced = (usd) => ({ inputUsd: usd, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, pricingAt: 1_700_000_000_000 });
  db.appendTurnEvent({ fleetId: fleet.id, memberId: "m1", source: "cron", status: "ok", startedAt: now, endedAt: now, usage: { input: 1000, output: 100 }, model: "m", pricing: priced(0.25), metering: {} });
  db.appendTurnEvent({ fleetId: fleet.id, memberId: "m1", source: "cron", status: "failed", error: "pi-ai detected context overflow", startedAt: now, endedAt: now, usage: { input: 118034, output: 900 }, model: "m", pricing: priced(0.5), detail: { kind: "context_overflow", usagePartial: true }, metering: {} });
  const spend = db.spendProjection(fleet.id);
  assert.ok(spend.allTime.costUsd > 0, "半截用量也要进花费——那 token 真扣了钱");
  assert.equal(spend.allTime.partialTurns, 1, "但读面必须知道其中 1 条是半截");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
