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
// Short ask window so the expiry case runs in about a second — but wide enough
// that the three-reply case cannot expire it while its own HTTP round trips are
// still in flight. The window is armed when the ask notification arrives, and
// every inbound reply costs a full POST + dispatch: measured 2026-11-14, a
// healthy run puts the third reply at ~90ms, and the failing one spent 124ms on
// the *second* — at 150ms that left ~55ms of slack, roughly one message of
// budget, so a loaded machine cancelled the ask mid-retry and the case reported
// `1 !== 0 re-prompts` (2/12 isolated runs). 900ms is ~10x the measured
// per-message cost without making the expiry case slow.
const ASK_WAIT_MS = 900;
process.env.BOTS_ASK_WAIT_MS = String(ASK_WAIT_MS);

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
      this.prompts.push({ sessionId, text: blocks.at(-1).text });
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

let fixtureMessageId = 1;
const update = (chatId, text) => ({
  update_id: Math.floor(Math.random() * 1e6),
  // A real platform never reuses a message id — the acceptance layer's
  // idempotency key (add-rollout-gap-durability) would correctly collapse a
  // fixed id into one message.
  message: { message_id: fixtureMessageId++, chat: { id: chatId }, from: { username: "u" }, date: 0, text },
});

const deliver = async (bot, chatId, text) => {
  await postJson(`/api/bots/webhook/${bot.id}/${bot.secret || bot.webhookUrl.split("/").pop()}`, update(chatId, text));
  await new Promise((r) => setTimeout(r, 25));
};

// Wait for a condition instead of sleeping a fixed amount. The expiry case has
// to observe the product's own window timer firing, and a hard-coded sleep
// turns every slowdown into a red that says nothing about the code.
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
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
  // No reply at all — the product's own window must expire it.
  await waitFor(() => answered.length === 1, "the wait window to expire", ASK_WAIT_MS + 2000);
  assert.equal(answered[0].cancelled, true);
  assert.ok(sent.some((s) => s.text.includes("等待超时")), "expiry noticed in the chat");
  await waitFor(() => ctx.sessionCollectors.size === 0, "the turn to conclude", 2000);
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

// ── §5: the unattended gate (fix-unattended-ask-parks-turn) ─────────────────
//
// An ask nobody can answer must be resolved BY THE PLATFORM after a grace
// window, not left to burn the turn's budget. Every case below drives the same
// `userQuestion/ask` path the runtime uses; only the viewer set and the grace
// window differ. Teardown removes the session's pending state so one case's
// timer can never leak into the next.

const withGrace = async (ms, fn) => {
  const prev = process.env.DSH_UNATTENDED_ASK_GRACE_MS;
  process.env.DSH_UNATTENDED_ASK_GRACE_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_UNATTENDED_ASK_GRACE_MS;
    else process.env.DSH_UNATTENDED_ASK_GRACE_MS = prev;
  }
};

// A session the WEB path drove. Without this the notification pump treats the
// session as unclaimed and drops the ask before it ever reaches the ask branch
// (see "an unclaimed session's ask is dropped silently") — the gate would then
// look inert for a reason that has nothing to do with the gate.
const webSession = (sid) => {
  ctx.webTurnSessions.add(sid);
  return sid;
};

const dropPending = (sid) => {
  const p = ctx.pendingQuestionBySession.get(sid);
  if (p?.unattendedTimer) clearTimeout(p.unattendedTimer);
  ctx.pendingQuestionBySession.delete(sid);
  ctx.webTurnSessions.delete(sid);
};

test("an ask with no viewer is resolved by the platform after the grace window", async () => {
  const sid = webSession("cron-unattended");
  const askId = "a-unattended";
  answered.length = 0;
  await withGrace(40, async () => {
    ctx.handleDshEvent(askNotif(sid, askId));
    assert.ok(ctx.pendingQuestionBySession.get(sid), "ask parked first");
    await waitFor(() => answered.length === 1, "the unattended resolution", 2000);
  });
  const sentAnswer = answered[0];
  assert.equal(sentAnswer.sessionId, sid);
  assert.equal(sentAnswer.askId, askId);
  assert.equal(sentAnswer.answers.length, 1, "one answer per question");
  assert.deepEqual(sentAnswer.answers[0].selected, [], "the platform never picks an option");
  assert.match(sentAnswer.answers[0].custom, /无人值守/);
  assert.match(sentAnswer.answers[0].custom, /ask_user_question/, "tells the model not to ask again");
  assert.equal(ctx.pendingQuestionBySession.get(sid), undefined, "pending cleared by the platform");
  dropPending(sid);
});

test("a session with a viewer keeps the ask pending past the grace window", async () => {
  const sid = webSession("cron-watched");
  const askId = "a-watched";
  answered.length = 0;
  const viewer = {
    readyState: 1,
    OPEN: 1,
    viewedSession: sid,
    send: () => {},
  };
  ctx.clients.add(viewer);
  try {
    await withGrace(40, async () => {
      ctx.handleDshEvent(askNotif(sid, askId));
      await new Promise((r) => setTimeout(r, 160));
    });
    assert.equal(answered.length, 0, "a watched ask is never answered by the platform");
    assert.ok(ctx.pendingQuestionBySession.get(sid), "still pending for the viewer");
  } finally {
    ctx.clients.delete(viewer);
    dropPending(sid);
  }
});

test("a viewer arriving inside the grace window keeps the ask pending", async () => {
  const sid = webSession("cron-late-viewer");
  const askId = "a-late";
  answered.length = 0;
  const viewer = {
    readyState: 1,
    OPEN: 1,
    viewedSession: sid,
    send: () => {},
  };
  try {
    await withGrace(150, async () => {
      ctx.handleDshEvent(askNotif(sid, askId));
      await new Promise((r) => setTimeout(r, 40)); // still inside the window
      ctx.clients.add(viewer);
      await new Promise((r) => setTimeout(r, 260)); // window has passed
    });
    assert.equal(answered.length, 0, "the timer must re-check viewers at expiry");
    assert.ok(ctx.pendingQuestionBySession.get(sid), "still pending");
  } finally {
    ctx.clients.delete(viewer);
    dropPending(sid);
  }
});

test("an ask resolved by its own tool/result sends no unattended answer", async () => {
  const sid = webSession("cron-answered");
  const askId = "a-answered";
  answered.length = 0;
  await withGrace(80, async () => {
    ctx.handleDshEvent({
      method: "session.event",
      params: { sessionId: sid, event: { type: "tool/call", data: { callId: "c-1", name: "ask_user_question", arguments: "{}" } } },
    });
    ctx.handleDshEvent(askNotif(sid, askId));
    // Someone (another surface / the bot lane) answered: the tool result lands.
    ctx.handleDshEvent({
      method: "session.event",
      params: {
        sessionId: sid,
        event: {
          type: "tool/result",
          data: {
            message: {
              source: { callId: "c-1" },
              content: [{ toolCallId: "c-1", content: [{ type: "text", text: '{"answers":[]}' }] }],
            },
          },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 200));
  });
  assert.equal(answered.length, 0, "the resolved ask must not be answered twice");
  dropPending(sid);
});

test("grace 0 disables the gate (today's behaviour, opt-out preserved)", async () => {
  const sid = webSession("cron-gate-off");
  const askId = "a-off";
  answered.length = 0;
  await withGrace(0, async () => {
    ctx.handleDshEvent(askNotif(sid, askId));
    await new Promise((r) => setTimeout(r, 160));
  });
  assert.equal(answered.length, 0, "DSH_UNATTENDED_ASK_GRACE_MS=0 sends nothing");
  assert.ok(ctx.pendingQuestionBySession.get(sid), "the ask is left alone");
  dropPending(sid);
});

// Observability arms (fix-unattended-ask-receipt): the 2026-11-15 live ask
// parked the full 900 s child fallback and NEITHER delivery path left a trace
// — the pod was gone by the time anyone looked, so "viewer suppressed" and
// "delivery rejected" were indistinguishable and unrepairable. Both silent
// branches must name themselves.
const captureConsole = (fn, lines = []) => {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(["log", a.join(" ")]);
  console.warn = (...a) => lines.push(["warn", a.join(" ")]);
  const restore = () => {
    console.log = origLog;
    console.warn = origWarn;
  };
  // Return the array synchronously so in-test waiters can watch it while fn
  // is still running; restore always happens when fn settles.
  const task = Promise.resolve()
    .then(fn)
    .finally(restore);
  return { lines, task };
};

test("a viewer-suppressed ask leaves a skip trace naming the session and ask", async () => {
  const sid = webSession("cron-viewer-suppressed");
  const askId = "a-suppressed";
  const viewer = { readyState: 1, OPEN: 1, viewedSession: sid, send: () => {} };
  ctx.clients.add(viewer);
  try {
    const { lines, task } = captureConsole(async () => {
      await withGrace(40, async () => {
        ctx.handleDshEvent(askNotif(sid, askId));
        await new Promise((r) => setTimeout(r, 120));
      });
    });
    await task;
    const skip = lines.find(([, t]) => t.includes("unattended-ask skipped"));
    assert.ok(skip, "the suppression must be logged");
    assert.match(skip[1], new RegExp(askId), "the skip line names the askId");
    assert.ok(skip[1].includes(sid), "the skip line names the session");
  } finally {
    ctx.clients.delete(viewer);
    dropPending(sid);
  }
});

test("a rejected resolution receipt is named instead of vanishing", async () => {
  const sid = webSession("cron-rejected");
  const askId = "a-rejected";
  const origAnswer = ctx.dshBridge.answerUserQuestion.bind(ctx.dshBridge);
  ctx.dshBridge.answerUserQuestion = async () => ({ accepted: false, reason: "unknown or already-resolved ask" });
  try {
    const { lines, task } = captureConsole(async () => {
      await withGrace(40, async () => {
        ctx.handleDshEvent(askNotif(sid, askId));
        await waitFor(() => lines.some(([, t]) => t.includes("unattended-ask")), "the resolution attempt", 2000);
        await new Promise((r) => setTimeout(r, 20));
      });
    });
    await task;
    const warn = lines.find(([, t]) => t.includes("unattended-ask NOT accepted"));
    assert.ok(warn, "the rejection must be logged");
    assert.match(warn[1], new RegExp(askId), "the rejection names the askId");
    assert.match(warn[1], /unknown or already-resolved ask/, "the child's reason rides the line");
    assert.equal(ctx.pendingQuestionBySession.get(sid), undefined, "pending still cleared (delivery failed, state dropped)");
  } finally {
    ctx.dshBridge.answerUserQuestion = origAnswer;
    dropPending(sid);
  }
});

// The THIRD silent shape (added with the 24 h measurement): a non-web ask whose
// session has no registered collector. Nothing on this host can answer it — the
// ask is dropped and the child parks on its own fallback — and until now only
// DSH_DEBUG said so, so "dropped, nobody claimed it" and "delivered, rejected"
// left the same evidence (none). One line makes them distinguishable.
test("a non-web ask with no collector names the drop instead of vanishing", async () => {
  const sid = "cron-unclaimed-session";
  const askId = "a-unclaimed";
  assert.notEqual(sid, ctx.dshSessionId, "precondition: not the web session");
  assert.equal(ctx.webTurnSessions.has(sid), false, "precondition: not web-scoped");
  assert.equal(ctx.sessionCollectors.get(sid), undefined, "precondition: no collector claims it");

  const { lines, task } = captureConsole(async () => {
    ctx.handleDshEvent(askNotif(sid, askId));
    await new Promise((r) => setTimeout(r, 20));
  });
  await task;

  const warn = lines.find(([, t]) => t.includes("unattended-ask unclaimed"));
  assert.ok(warn, "the drop must be logged");
  assert.ok(warn[1].includes(sid), "the line names the session");
  assert.ok(warn[1].includes(askId), "the line names the askId");
  assert.equal(ctx.pendingQuestionBySession.get(sid), undefined, "no pending card is held for a session nobody owns");
});
