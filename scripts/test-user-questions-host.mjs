// User-questions host wiring (add-user-questions, tasks 2.1 + 4.1-4.4):
//
//   §2 — the notification pump's `userQuestion/ask` routing: the web session's
//        ask lands in pendingQuestionBySession + reaches its viewers; a bot
//        session's ask goes to that session's collector and NEVER to the web;
//        an unclaimed session's ask is dropped. The ask's own tool/result
//        clears the pending state.
//   §4 — the full bot ask loop against a stub bridge: question rendered as
//        numbered text, the next inbound message intercepted as the answer
//        (number / exact label / free-text custom / cancel word), re-prompt
//        then auto-cancel after three unrecognized replies, wait-window
//        expiry cancels, and the no-tools posture does NOT withhold a turn
//        that only asked.
//
// No LLM, no network, no agent runtime: the telegram adapter's sendText is
// captured, and the dsh bridge is a scriptable stub that parks the turn on
// the ask and resumes it when the answer RPC arrives.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "user-questions-host-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
// Short ask window so the expiry test runs in milliseconds.
process.env.BOTS_ASK_WAIT_MS = "150";

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

// Every sendText the adapter would have made, captured instead of sent.
const sent = [];
// Everything the stub bridge answered (the runtime-bound answer/cancel RPCs).
const answered = [];

let server;
let base;
let ctx;
// A viewer watching the web session; its inbound WS messages.
const viewerMessages = [];

before(async () => {
  await db.initDb();

  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) =>
    req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next),
  );
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);
  attachDshEvents(ctx);

  // The web session this cell is currently running, plus one fake viewer.
  ctx.dshSessionId = "web-1";
  ctx.ready.dsh = true;
  ctx.clients.add({
    readyState: 1,
    OPEN: 1,
    viewedSession: "web-1",
    send: (raw) => viewerMessages.push(JSON.parse(raw)),
  });

  // Scriptable bridge: prompt() parks the turn on an ask and only resolves it
  // when answerUserQuestion arrives (mirroring the real child's provider).
  ctx.dshBridge = {
    isReady: () => true,
    prompts: [],
    async prompt(sessionId, blocks) {
      this.prompts.push({ sessionId, text: blocks[0].text });
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(sessionId);
        if (!collector) return;
        collector({
          method: "session.event",
          params: { sessionId, event: { type: "tool/call", data: { callId: "a1", name: "ask_user_question", arguments: "{}" } } },
        });
        collector({
          method: "userQuestion/ask",
          params: {
            sessionId,
            askId: `ask-${sessionId}`,
            questions: [{ id: "q1", question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] }],
          },
        });
      });
      return "msg-1";
    },
    async answerUserQuestion(payload) {
      answered.push(payload);
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(payload.sessionId);
        if (!collector) return;
        collector({
          method: "session.event",
          params: {
            sessionId: payload.sessionId,
            event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "收到，继续。" }] } } },
          },
        });
        collector({ method: "session.status", params: { sessionId: payload.sessionId, status: "idle" } });
      });
      return { accepted: true };
    },
  };

  bots.initBots(ctx);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  bots.stopAll();
  server?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const api = (p, init) => fetch(`${base}${p}`, init);
const postJson = (p, body, method = "POST") =>
  api(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function makeBot(name = "tg") {
  const res = await postJson("/api/bots", { type: "telegram", name, credentials: { token: "SECRET-BOT-TOKEN" } });
  const bot = await res.json();
  const entry = bots.getEntry(bot.id);
  entry.adapter = {
    ...entry.adapter,
    start: undefined,
    async sendText(_cred, chatKey, text) { sent.push({ chatKey, text }); },
  };
  return bot;
}

const update = (chatId, text) => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: { message_id: 1, chat: { id: chatId }, from: { username: "u" }, date: 0, text },
});

const deliver = async (bot, chatId, text) => {
  await postJson(`/api/bots/webhook/${bot.id}/${bot.secret || bot.webhookUrl.split("/").pop()}`, update(chatId, text));
  await new Promise((r) => setTimeout(r, 25));
};

const askNotif = (sessionId, askId = "a-1") => ({
  method: "userQuestion/ask",
  params: { sessionId, askId, questions: [{ id: "q1", question: "Q?" }] },
});

// ── §2.1: notification routing ──────────────────────────────────────────────

test("a web-session ask reaches viewers and is held for reconnect syncs", async () => {
  viewerMessages.length = 0;
  // The turn's ask tool call must be on the name map for card anchoring.
  ctx.handleDshEvent({
    method: "session.event",
    params: { sessionId: "web-1", event: { type: "tool/call", data: { callId: "call-9", name: "ask_user_question", arguments: "{}" } } },
  });
  ctx.handleDshEvent(askNotif("web-1", "a-1"));

  const pending = ctx.pendingQuestionBySession.get("web-1");
  assert.ok(pending, "pending ask recorded");
  assert.equal(pending.askId, "a-1");
  assert.equal(pending.toolCallId, "call-9");
  const msg = viewerMessages.find((m) => m.type === "agent_question");
  assert.ok(msg, "viewer got agent_question");
  assert.equal(msg.askId, "a-1");
  assert.equal(msg.toolCallId, "call-9");
  assert.equal(msg.sessionId, "web-1");
  // questionMessage rehydrates exactly this ask.
  assert.equal(ctx.questionMessage("web-1")?.askId, "a-1");
  assert.equal(ctx.questionMessage("web-1")?.type, "agent_question");
});

test("the ask's own tool/result clears the pending state", async () => {
  assert.ok(ctx.pendingQuestionBySession.get("web-1"), "precondition: ask pending");
  ctx.handleDshEvent({
    method: "session.event",
    params: {
      sessionId: "web-1",
      event: {
        type: "tool/result",
        data: {
          message: {
            source: { callId: "call-9" },
            content: [{ toolCallId: "call-9", content: [{ type: "text", text: '{"answers":[]}' }] }],
          },
        },
      },
    },
  });
  assert.equal(ctx.pendingQuestionBySession.get("web-1"), undefined, "pending cleared");
  assert.equal(ctx.questionMessage("web-1"), null, "syncs push nothing after resolution");
});

test("a bot-session ask goes to its collector, never the web transcript", async () => {
  viewerMessages.length = 0;
  const botNotifs = [];
  ctx.sessionCollectors.set("bot-1-abc", (notif) => botNotifs.push(notif));
  ctx.handleDshEvent(askNotif("bot-1-abc", "a-b1"));
  assert.equal(botNotifs.length, 1, "collector received the raw ask");
  assert.equal(botNotifs[0].params.askId, "a-b1");
  assert.equal(viewerMessages.filter((m) => m.type === "agent_question").length, 0, "no web message");
  assert.equal(ctx.pendingQuestionBySession.get("bot-1-abc"), undefined, "no web pending state");
  ctx.sessionCollectors.delete("bot-1-abc");
});

test("an unclaimed session's ask is dropped silently", async () => {
  viewerMessages.length = 0;
  ctx.handleDshEvent(askNotif("nobody-1", "a-x"));
  assert.equal(viewerMessages.filter((m) => m.type === "agent_question").length, 0);
  assert.equal(ctx.pendingQuestionBySession.get("nobody-1"), undefined);
});

// ── §4: the bot ask loop ────────────────────────────────────────────────────

test("a bot ask renders numbered text and the next reply answers it by number", async () => {
  sent.length = 0;
  answered.length = 0;
  const bot = await makeBot("ask-number");
  await deliver(bot, 7001, "帮我看下");
  await new Promise((r) => setTimeout(r, 30));

  const question = sent.find((s) => s.text.includes("继续吗？"));
  assert.ok(question, "question rendered into the chat");
  assert.match(question.text, /1\. 继续/);
  assert.match(question.text, /回复数字/);

  await deliver(bot, 7001, "1");
  assert.equal(answered.length, 1, "no new turn — the reply was intercepted as the answer");
  assert.equal(answered[0].cancelled, undefined);
  assert.deepEqual(answered[0].answers, [{ id: "q1", selected: ["继续"] }]);
  assert.equal(ctx.dshBridge.prompts.length, 1, "the intercepted reply did not queue a new prompt");
  assert.ok(sent.some((s) => s.text.includes("收到，继续。")), "final reply delivered");
  assert.equal(ctx.sessionCollectors.size, 0, "collector unregistered");
});

test("a copied render line matches its label; free text becomes custom on free-text questions", async () => {
  sent.length = 0;
  answered.length = 0;
  const bot = await makeBot("ask-label");
  await deliver(bot, 7002, "帮我看下");
  await new Promise((r) => setTimeout(r, 30));
  await deliver(bot, 7002, "1. 停止");
  assert.deepEqual(answered[0].answers, [{ id: "q1", selected: ["停止"] }]);

  // Free-text question: the next plain reply IS the custom answer. The stub
  // always asks the options question, so drive parseAnswer directly for the
  // free-text shape.
  const out = bots.parseAnswer("随便写点什么", [{ id: "q9", question: "备注？" }]);
  assert.deepEqual(out, { kind: "answers", answers: [{ id: "q9", selected: [], custom: "随便写点什么" }] });
});

test("the cancel word cancels the pending ask", async () => {
  sent.length = 0;
  answered.length = 0;
  const bot = await makeBot("ask-cancel");
  await deliver(bot, 7003, "帮我看下");
  await new Promise((r) => setTimeout(r, 30));
  await deliver(bot, 7003, "取消");
  assert.equal(answered.length, 1);
  assert.equal(answered[0].cancelled, true);
  assert.ok(sent.some((s) => s.text.includes("已取消本次问询")), "cancellation acknowledged");
});

test("three unrecognized replies auto-cancel the ask", async () => {
  sent.length = 0;
  answered.length = 0;
  const bot = await makeBot("ask-retry");
  await deliver(bot, 7004, "帮我看下");
  await new Promise((r) => setTimeout(r, 30));
  await deliver(bot, 7004, "嗯嗯嗯");
  await deliver(bot, 7004, "啊这");
  assert.equal(answered.length, 0, "re-prompts, no submission yet");
  assert.ok(sent.some((s) => s.text.includes("还可尝试 2 次")), "remaining attempts surfaced");
  await deliver(bot, 7004, "还是不会");
  assert.equal(answered.length, 1);
  assert.equal(answered[0].cancelled, true, "auto-cancelled after the third failure");
  assert.ok(sent.some((s) => s.text.includes("已取消本次问询")));
});

test("wait-window expiry cancels the ask and the turn concludes normally", async () => {
  sent.length = 0;
  answered.length = 0;
  const bot = await makeBot("ask-expiry");
  await deliver(bot, 7005, "帮我看下");
  // No reply at all — the window (BOTS_ASK_WAIT_MS=150) expires.
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(answered.length, 1);
  assert.equal(answered[0].cancelled, true);
  assert.ok(sent.some((s) => s.text.includes("等待超时")), "expiry noticed in the chat");
  assert.equal(ctx.sessionCollectors.size, 0, "turn concluded");
});

test("the no-tools posture does not withhold an ask turn's reply", async () => {
  // The stub turn calls ask_user_question (a tool call) yet its final text
  // must still be delivered — the answer is the user's own words (4.4).
  sent.length = 0;
  const bot = await makeBot("ask-posture");
  await deliver(bot, 7006, "帮我看下");
  await new Promise((r) => setTimeout(r, 30));
  await deliver(bot, 7006, "2");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sent.some((s) => s.text.includes("收到，继续。")), "reply delivered despite the tool call");
});
