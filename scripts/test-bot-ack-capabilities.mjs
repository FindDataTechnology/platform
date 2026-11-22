// 中间态（waiting-ack）契约：平台差别 + 调度策略。
// Run: node --test scripts/test-bot-ack-capabilities.mjs
//
// 问题（2026-11-22 用户提出）：复杂问话要跑几分钟，而平台上一条消息都没有——
// 用户把「静默」读成「功能坏了」。但「怎么让用户知道在处理」各平台差别极大，
// 所以这里是**两张表**：
//
//   1. 每个平台声明自己的中间态形状（adapter.ack），覆盖从 BOT_TYPES 派生，
//      绝不手写子集——手写的豁免清单会静默漏掉后来加的平台（同
//      test-bot-outbound-capabilities 的教训）。
//   2. 调度层按能力执行：edit 编辑成答案、placeholder 先回执后答案、none 不发。
//
// 最要紧的一条是否定断言：**wecom-bot 必须是 none**。它的 response_code 一次性
// 消费，发了回执答案就再也发不出去（prod 实测 60140）。如果哪天有人「顺手」给
// 它加个回执，用户会看到一个永远等不到答案的「正在处理」。
import test from "node:test";
import assert from "node:assert/strict";

import { BOT_TYPES, ACK_MODES, ackCapabilityFor, ackCapabilityOfBot } from "../server/bots/adapter.js";

test("every platform declares a valid ack mode (coverage derived, not hand-written)", () => {
  for (const t of BOT_TYPES) {
    const { mode } = ackCapabilityFor(t);
    assert.ok(ACK_MODES.includes(mode), `${t}: ack mode "${mode}" must be one of ${ACK_MODES.join(", ")}`);
  }
});

test("editable platforms declare edit (one message becomes the answer)", () => {
  // Each of these exposes a message-update API and the adapter implements it.
  for (const t of ["telegram", "slack", "mattermost", "feishu", "chatwoot"]) {
    assert.equal(ackCapabilityFor(t).mode, "edit", `${t} can rewrite its own message`);
  }
});

test("send-only-but-uneditable platforms declare placeholder", () => {
  // Can send proactively, but there is no update endpoint: a receipt plus a
  // separate answer is the best available shape (two messages, not a black hole).
  for (const t of ["wecom", "wechat-oa"]) {
    assert.equal(ackCapabilityFor(t).mode, "placeholder", `${t} sends but cannot edit`);
  }
});

test("wecom-bot MUST be none: its response_code is single-use", () => {
  // Send a receipt first and the answer can never be delivered (60140). The one
  // send opportunity has to be spent on the answer itself. Any other value here
  // is a production incident waiting for a slow turn.
  assert.equal(ackCapabilityFor("wecom-bot").mode, "none");
});

test("outbound-only webhook bots declare none (no receive path ⇒ no ack)", () => {
  assert.equal(ackCapabilityFor("wecom-webhook").mode, "none");
});

test("unknown types answer none, never a fabricated capability", () => {
  assert.equal(ackCapabilityFor("no-such-platform").mode, "none");
  assert.equal(ackCapabilityFor(undefined).mode, "none");
});

test("a generic channel bot reads its bound platform's capability", () => {
  // A pack's channel bot defers the platform choice to its credential binding;
  // the ack shape must follow that binding, not the row's own type.
  assert.equal(ackCapabilityOfBot({ type: "channel", credentials: { platform: "telegram" } }).mode, "edit");
  assert.equal(ackCapabilityOfBot({ type: "channel", credentials: { platform: "wecom-bot" } }).mode, "none");
  // Unbound channel row: nothing to promise.
  assert.equal(ackCapabilityOfBot({ type: "channel", credentials: {} }).mode, "none");
});

// ── 调度策略（源码级）────────────────────────────────────────────────────────
//
// 分发发生在 bots.js 的 beginAck/settleAck，不是纯函数——所以这里钉住的是
// 「策略的骨架」：none 不发、edit 失败回落、占位有兜底收尾。行为面的真机验证
// 由 e2e 与上产观测承担。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bots = fs.readFileSync(path.join(here, "..", "server", "bots.js"), "utf8");

test("调度层只对 edit / placeholder 发中间态，none 一律不发", () => {
  assert.match(bots, /if \(cap\.mode !== "edit" && cap\.mode !== "placeholder"\) return null;/);
});

test("编辑失败回落到另发一条，答案不能因为编辑失败丢", () => {
  assert.match(bots, /if \(!\(await settleAck\([^)]*\)\)\) \{\s*\n\s*await deliverText\(/);
  assert.match(bots, /falling back to a separate answer message/);
});

test("占位消息有兜底收尾：异常路径不会永远停在「正在处理」", () => {
  // Without this, a gate-withheld or crashed turn leaves the placeholder sitting
  // at "processing…" forever — which promises a follow-up that never comes.
  assert.match(bots, /!ackBinding\.used && ackBinding\.messageId/);
  assert.match(bots, /没能给出回答/);
});

test("中间态文案来自可配置的车道文案，不是硬编码", () => {
  assert.match(bots, /const ACK_COPY_EVENT = "bot_ack";/);
  assert.match(bots, /copyForEvent\(laneCfg\.get\(\), ACK_COPY_EVENT/);
});
