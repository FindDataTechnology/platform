// 中间态的真回合行为（waiting-ack 3.x）：走真实 handleMessage，不是纯函数。
// Run: node --test scripts/test-bot-ack-turn.mjs
//
// 纯能力表由 test-bot-ack-capabilities 钉住；这里要证明的是**回合里的实际次序**：
// 入站 → 先出中间态 → 回合跑完 → 答案取代它。三条形态各验一次：
//
//   edit         一条消息：先「正在处理」，跑完编辑成答案，全程只有一条
//   placeholder  两条：先回执，答案另发
//   none         只有答案（wecom-bot：回执会把唯一发送机会用掉）
//
// 以及两条副作用保证：编辑失败要回落另发（答案不能丢）；回合异常时占位消息
// 要被改成诚实的一句话，不能永远停在「正在处理」。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bot-ack-turn-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PUBLIC_BASE_URL = "http://ack.test";
delete process.env.BOTS_ALLOW_TOOLS;

const db = await import("../db.js");
await db.initDb();
const bots = await import("../server/bots.js");
const { createAppContext } = await import("../server/context.js");
const adapterMod = await import("../server/bots/adapter.js");

let ctx;
let sent; // 每一次真正到达平台的调用，按发生顺序
let answerText;
let turnFails;

before(() => {
  sent = [];
  answerText = "这是答案。";
  turnFails = false;
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.sessionCollectors = new Map();
  ctx.setStreaming = () => {};
  ctx.dshBridge = {
    isReady: () => true,
    // collectTurn is driven by session events (that is the real seam): emit the
    // assistant message then the idle, exactly as the bridge would.
    async prompt(sessionId) {
      if (turnFails) throw new Error("stub turn failure");
      const notify = ctx.sessionCollectors.get(sessionId);
      if (notify) {
        notify({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: answerText }] } } } } });
        notify({ method: "session.status", params: { status: "idle" } });
      }
      return "msg-1";
    },
  };
  bots.initBots(ctx);
});

after(() => {
  bots.stopAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 把某个平台的 adapter 临时替换成记录型桩：能力位仍来自真实声明，只接管
// 网络调用。这样测到的是「调度层按声明做了什么」，不是「adapter 怎么发」。
function stubAdapter(platform, { editFails = false } = {}) {
  const registry = adapterMod.__setAdapterForTest;
  assert.ok(registry, "adapter module must expose __setAdapterForTest");
  const real = adapterMod.getAdapter(platform);
  registry(platform, {
    ...real,
    async sendText(_cred, chatKey, text) {
      sent.push({ op: "send", chatKey, text });
      return "sent-1";
    },
    ack: real?.ack
      ? {
          ...real.ack,
          async placeholder(_cred, chatKey, text) {
            sent.push({ op: "placeholder", chatKey, text });
            return "ph-1";
          },
          async edit(_cred, chatKey, messageId, text) {
            sent.push({ op: "edit", chatKey, messageId, text });
            return editFails ? false : true;
          },
        }
      : real?.ack,
  });
  return () => registry(platform, real);
}

function makeBot(type, platform) {
  const bot = db.addBot({
    id: `bot-${Math.random().toString(36).slice(2)}`,
    type,
    name: "ack-bot",
    credentials: platform ? { platform } : { botToken: "xoxb-test" },
    secret: "s3cret",
    enabled: true,
    ownerEmail: "owner@ack.local",
  });
  // initBots already ran; register this row the same way the registry does at
  // boot (reload reads the adapter and installs the runtime entry).
  bots.reload(bot);
  return bot;
}

test("edit lane: placeholder first, then the answer replaces it (one message)", async () => {
  const restore = stubAdapter("telegram");
  sent = [];
  const bot = makeBot("telegram"); // reload AFTER the stub so the entry holds it
  await bots.handleMessage(bot.id, { chatKey: "chat-edit", senderName: "u", text: "复杂问题" });
  restore();

  const ops = sent.map((s) => s.op);
  assert.deepEqual(ops, ["placeholder", "edit"], `expected placeholder→edit, got ${ops.join(",")} [texts: ${JSON.stringify(sent.map(x=>x.text))}]`);
  assert.match(sent[0].text, /正在处理/, "the placeholder says it is working");
  assert.equal(sent[1].text, answerText, "the edit carries the real answer");
});

test("placeholder lane: receipt and answer are two separate messages", async () => {
  const restore = stubAdapter("wecom");
  sent = [];
  const bot = makeBot("wecom");
  await bots.handleMessage(bot.id, { chatKey: "chat-ph", senderName: "u", text: "复杂问题" });
  restore();

  const ops = sent.map((s) => s.op);
  assert.deepEqual(ops, ["placeholder", "send"], `expected placeholder→send, got ${ops.join(",")}`);
  assert.match(sent[0].text, /正在处理/);
  assert.equal(sent[1].text, answerText);
});

test("none lane (wecom-bot): no receipt at all — the one send is the answer", async () => {
  const restore = stubAdapter("wecom-bot");
  sent = [];
  const bot = makeBot("wecom-bot");
  await bots.handleMessage(bot.id, { chatKey: "chat-none", senderName: "u", text: "复杂问题" });
  restore();

  const ops = sent.map((s) => s.op);
  assert.deepEqual(ops, ["send"], `expected only the answer, got ${ops.join(",")}`);
  assert.equal(sent[0].text, answerText, "the sole send is the answer, never a receipt");
});

test("edit failure falls back to a separate answer message (never loses it)", async () => {
  const restore = stubAdapter("slack", { editFails: true });
  sent = [];
  const bot = makeBot("slack");
  await bots.handleMessage(bot.id, { chatKey: "chat-fb", senderName: "u", text: "复杂问题" });
  restore();

  const ops = sent.map((s) => s.op);
  assert.deepEqual(ops, ["placeholder", "edit", "send"], `expected fallback send, got ${ops.join(",")}`);
  assert.equal(sent[2].text, answerText, "the fallback send carries the answer");
});

test("a failed turn rewrites the placeholder instead of leaving it spinning", async () => {
  const restore = stubAdapter("telegram");
  sent = [];
  const bot = makeBot("telegram"); // reload AFTER the stub so the entry holds it
  turnFails = true;
  try {
    await bots.handleMessage(bot.id, { chatKey: "chat-err", senderName: "u", text: "复杂问题" });
  } finally {
    turnFails = false;
    restore();
  }

  // The placeholder was sent, and SOMETHING replaced it — either the turn's own
  // error reply or the finally-block cleanup. Either way it must not still say
  // "正在处理" with no answer after it.
  const placeholders = sent.filter((s) => s.op === "placeholder");
  assert.equal(placeholders.length, 1, "the placeholder went out");
  const after = sent.filter((s) => s.op !== "placeholder");
  assert.ok(after.length >= 1, "an edit or send followed the placeholder");
  assert.notEqual(after[after.length - 1].text, placeholders[0].text, "the placeholder was replaced, not left as-is");
});
