// Stub-turn settlement (fix-stub-turn-success).
//
// 2026-11-09, 24h: **67 of 248 rounds reported exactly 128 output tokens and
// every one settled `ok`** — 62 with model=null, several with a trace holding
// no events at all. The pre-existing hollow guard requires usage to be ABSENT,
// so it never fired: these rounds carry usage (128 tokens of it).
//
// Four facts must hold together — tiny output, no text, no tool call, no
// report — so a legitimately short round (one report_status call) never matches.
//
// Run: node --test scripts/test-stub-turn.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { shapeTurnOutcome, isStubTurn, STUB_OUTPUT_TOKENS } = await import("../server/fleet-events.js");

test("阈值是观测到的常量，不是猜的", () => {
  assert.equal(STUB_OUTPUT_TOKENS, 128, "生产行聚集在 128，改它要有新数据");
});

test("四项同时成立才判桩", () => {
  assert.equal(isStubTurn({ outputTokens: 128 }), true, "128 且什么都没有 = 桩");
  assert.equal(isStubTurn({ outputTokens: 40 }), true, "比阈值更少同样是桩");
  assert.equal(isStubTurn({ outputTokens: 128, hasText: true }), false, "有文本不算桩");
  assert.equal(isStubTurn({ outputTokens: 128, toolCalls: 1 }), false, "调过工具不算桩");
  assert.equal(isStubTurn({ outputTokens: 128, reported: true }), false, "报过数不算桩");
  assert.equal(isStubTurn({ outputTokens: 129 }), false, "超过阈值不算桩（边界）");
  assert.equal(isStubTurn({ outputTokens: null }), false, "没测到输出就不下结论");
});

test("结算：桩回合记 interrupted，不再抬高通过率", () => {
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 4200, output: 128 }, text: "", toolBlocks: [], reported: false });
  assert.equal(shaped.status, "interrupted", "一轮没干活不能叫成功");
  assert.equal(shaped.detail?.stubTurn, true);
  assert.equal(shaped.detail?.stubEvidence?.outputTokens, 128);
  assert.match(String(shaped.error || ""), /stub/i, "错误文案要说清是桩");
});

test("结算：只调一次 report_status 的短回合仍是 ok（不误伤）", () => {
  const shaped = shapeTurnOutcome({
    ok: true,
    usage: { input: 9000, output: 40 },
    text: "",
    toolBlocks: [{ kind: "tool", name: "mcp__fleet__report_status", result: "ok" }],
    reported: true,
  });
  assert.equal(shaped.status, "ok", "有工具调用、有报数 —— 这是干完活的短回合");
  assert.equal(shaped.detail?.stubTurn, undefined);
});

test("结算：有文本但输出不多仍是 ok", () => {
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 9000, output: 128 }, text: "结论：无异常", toolBlocks: [] });
  assert.equal(shaped.status, "ok");
});

test("窗口塞满只记观测，不参与结论", () => {
  const shaped = shapeTurnOutcome({
    ok: true,
    usage: { input: 150000, output: 600 },
    text: "有内容",
    toolBlocks: [{ kind: "tool", name: "x", result: "y" }],
    contextWindow: 128000,
    inputTokens: 163631,
  });
  assert.equal(shaped.status, "ok", "窗口挤满本身不是失败");
  assert.equal(shaped.detail?.windowFull, true, "但必须看得见");
  assert.equal(shaped.detail?.outputTokens, 600);
});

test("非桩路径逐字节不变：普通成功 / 失败 / 中断", () => {
  const ok = shapeTurnOutcome({ ok: true, usage: { input: 1000, output: 500 }, text: "答案", toolBlocks: [] });
  assert.equal(ok.status, "ok");
  assert.equal(ok.detail, null, "没有新事实就不该凭空造 detail");

  const failed = shapeTurnOutcome({ ok: false, error: "503 upstream" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.detail, null);

  const interrupted = shapeTurnOutcome({ ok: false, interrupted: true, error: "runtime restarted" });
  assert.equal(interrupted.status, "interrupted");
});
