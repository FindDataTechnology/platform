// Tests for the social-bot-channels inbound pipeline (tasks 6.1 + 6.3).
//
// Runs the real Express routes and the real bots module against an isolated
// DB_PATH and a STUB dsh bridge, so a full inbound turn — webhook → verify →
// parse → guards → prompt → collect → sendText — is exercised end to end with
// no LLM, no network, and no agent runtime.
//
// Covered contract scenarios:
//   - config CRUD, and that credential VALUES never appear in any response
//   - webhook 403 on a wrong secret / unknown bot / disabled bot
//   - a synthetic Telegram update drives a turn and records the sendText call
//   - oversized message rejected; per-chat rate limit trips
//   - BOTS_ALLOW_TOOLS unset ⇒ a tool-using turn's answer is withheld

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bots-test-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { registry: telegramRegistry } = await import("../server/bots/telegram.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

// Every sendText the telegram adapter would have made, captured instead of sent.
const sent = [];
// The next turn's scripted notification stream, replayed when prompt() is called.
let scriptedTurn = [];

let server;
let base;
let ctx;

before(async () => {
  await db.initDb();

  const app = express();
  // Same body-parser wiring as server.js: the webhook prefix must keep its raw
  // bytes, so the global JSON parser skips it. Getting this wrong silently
  // empties every webhook body.
  const jsonBodyParser = express.json();
  app.use((req, res, next) =>
    req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next),
  );
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);

  // Stub bridge: prompt() replays the scripted notifications for the target
  // session through the same collector the real pump feeds, then goes idle.
  ctx.dshBridge = {
    isReady: () => true,
    prompts: [],
    async prompt(sessionId, blocks) {
      this.prompts.push({ sessionId, text: blocks[0].text });
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(sessionId);
        if (!collector) return;
        for (const ev of scriptedTurn) collector({ method: "session.event", params: { sessionId, event: ev } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      });
      return "msg-1";
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

const assistantText = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
const toolCall = () => ({ type: "tool/call", data: { callId: "c1", name: "bash", arguments: "{}" } });

// Create a telegram bot whose sendText is captured rather than performed.
async function makeBot(name = "tg") {
  const res = await postJson("/api/bots", {
    type: "telegram",
    name,
    credentials: { token: "SECRET-BOT-TOKEN" },
  });
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

// Deliver a webhook and wait for the turn it kicks off (the route acks first).
async function deliver(bot, secret, body) {
  const res = await postJson(`/api/bots/webhook/${bot.id}/${secret}`, body);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

const secretOf = (bot) => bot.webhookUrl.split("/").pop();

test("config CRUD never leaks credential values", async () => {
  const bot = await makeBot("crud");
  assert.deepEqual(bot.configuredCredentials, ["token"]);
  assert.ok(!JSON.stringify(bot).includes("SECRET-BOT-TOKEN"));

  const list = await (await api("/api/bots")).json();
  assert.ok(!JSON.stringify(list).includes("SECRET-BOT-TOKEN"));
  assert.ok(list.types.some((t) => t.type === "telegram"));

  // A blank secret field on edit keeps the stored credential.
  await postJson(`/api/bots/${bot.id}`, { credentials: { token: "" } }, "PATCH");
  assert.equal(db.getBot(bot.id).credentials.token, "SECRET-BOT-TOKEN");

  assert.equal((await api(`/api/bots/${bot.id}`, { method: "DELETE" })).status, 200);
  assert.equal(db.getBot(bot.id), null);
});

test("webhook rejects a wrong secret, an unknown bot, and a disabled bot", async () => {
  const bot = await makeBot("auth");
  const secret = secretOf(bot);

  assert.equal((await postJson(`/api/bots/webhook/${bot.id}/wrong-secret`, {})).status, 403);
  assert.equal((await postJson(`/api/bots/webhook/does-not-exist/${secret}`, {})).status, 403);

  await postJson(`/api/bots/${bot.id}`, { enabled: false }, "PATCH");
  assert.equal((await postJson(`/api/bots/webhook/${bot.id}/${secret}`, {})).status, 403);
});

test("a verified update drives a full turn and delivers the reply", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("hello from the agent")];
  const bot = await makeBot("turn");

  const res = await deliver(bot, secretOf(bot), update(4242, "hi there"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "success");

  assert.deepEqual(sent, [{ chatKey: "4242", text: "hello from the agent" }]);

  // The turn ran on the derived per-(bot, chat) session, not the web session.
  const prompt = ctx.dshBridge.prompts.at(-1);
  assert.equal(prompt.sessionId, bots.sessionIdFor(bot.id, "4242"));
  assert.notEqual(prompt.sessionId, ctx.dshSessionId);
  assert.ok(prompt.text.endsWith("hi there"));
  // The collector is always unregistered, whatever the outcome.
  assert.equal(ctx.sessionCollectors.size, 0);
});

test("guard: an oversized message never reaches the agent", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("should not happen")];
  const bot = await makeBot("cap");
  const before = ctx.dshBridge.prompts.length;

  await deliver(bot, secretOf(bot), update(1, "x".repeat(4001)));

  assert.equal(ctx.dshBridge.prompts.length, before, "no prompt for an oversized message");
  assert.deepEqual(sent, []);
});

test("guard: the per-chat rate limit trips after the allowance", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("ok")];
  const bot = await makeBot("rate");
  const secret = secretOf(bot);

  // 10/min is the bucket; the 11th message in the same chat is dropped.
  for (let i = 0; i < 11; i++) await deliver(bot, secret, update(777, `m${i}`));
  assert.equal(sent.length, 10, "the 11th message must be dropped");

  // A different chat has its own bucket.
  await deliver(bot, secret, update(888, "other chat"));
  assert.equal(sent.length, 11);
});

test("guard: BOTS_ALLOW_TOOLS unset withholds a tool-derived answer", async () => {
  sent.length = 0;
  scriptedTurn = [toolCall(), assistantText("answer built from a tool")];
  const bot = await makeBot("tools");

  await deliver(bot, secretOf(bot), update(99, "run something"));

  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes("answer built from a tool"), "tool-derived text must not be delivered");
  // The prompt itself also carries the no-tools instruction.
  assert.ok(ctx.dshBridge.prompts.at(-1).text.startsWith("You are answering a message"));
});

// ── Seen chats (add-bot-relay-endpoint) ─────────────────────────────────────

test("a verified inbound message records its chat for later addressing", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("noted")];
  const bot = await makeBot("chats");
  const mine = () => db.listBotChats().filter((c) => c.botId === bot.id);
  const marker = "remember-me-please";

  await deliver(bot, secretOf(bot), update(777, marker));

  const first = mine();
  assert.equal(first.length, 1);
  assert.equal(first[0].chatKey, "777");
  assert.equal(first[0].senderName, "u");
  assert.equal(first[0].firstSeenAt, first[0].lastSeenAt);
  // Identity and timing only — the message text never reaches the table.
  assert.ok(!JSON.stringify(first).includes(marker));

  // A repeat message updates the same row instead of adding another.
  await new Promise((r) => setTimeout(r, 5));
  await deliver(bot, secretOf(bot), update(777, "again"));
  const second = mine();
  assert.equal(second.length, 1);
  assert.ok(second[0].lastSeenAt >= first[0].lastSeenAt);
  assert.equal(second[0].firstSeenAt, first[0].firstSeenAt);
});

test("an oversized message is not recorded as a chat", async () => {
  const bot = await makeBot("chatcap");
  await deliver(bot, secretOf(bot), update(1234, "x".repeat(4001)));
  assert.equal(db.listBotChats().filter((c) => c.botId === bot.id).length, 0);
});

test("a recording failure is logged and does not cost the reply", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("still answered")];
  const bot = await makeBot("chatfail");
  const realDb = ctx.db;
  ctx.db = { ...realDb, upsertBotChat() { throw new Error("store down"); } };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };

  try {
    await deliver(bot, secretOf(bot), update(888, "hello"));
  } finally {
    console.warn = realWarn;
    ctx.db = realDb;
  }

  assert.deepEqual(sent, [{ chatKey: "888", text: "still answered" }]);
  assert.ok(warnings.some((w) => w.includes("could not record the chat")));
});

// ── Onboarding QR endpoint (redesign-bots-surface) ───────────────────────────

test("GET /api/bots advertises the per-type qr capability", async () => {
  const list = await (await api("/api/bots")).json();
  const byType = Object.fromEntries(list.types.map((t) => [t.type, t.qr]));
  assert.equal(byType.telegram.strategy, "telegram-me");
  assert.equal(byType["wechat-oa"].strategy, "wechat-qrcode");
  assert.equal(byType.feishu.strategy, "manual");
  assert.equal(byType.wecom.strategy, "manual");
  assert.equal(byType.feishu.field, "qrUrl");
  // The server-side resolver function never crosses to the browser.
  assert.deepEqual(Object.keys(byType.telegram).sort(), ["hintKey", "strategy"]);
  assert.deepEqual(Object.keys(byType.feishu).sort(), ["field", "hintKey", "strategy"]);
});

test("qr endpoint: unknown bot 404s; a manual platform without a link prompts", async () => {
  assert.equal((await api("/api/bots/does-not-exist/qr")).status, 404);

  // feishu is strategy "manual": with no link stored, the endpoint prompts
  // instead of calling any upstream (hermetic by construction).
  const res = await postJson("/api/bots", {
    type: "feishu",
    name: "fs",
    credentials: { appId: "cli-x", appSecret: "SECRET-FS-SECRET" },
  });
  const bot = await res.json();
  try {
    const j = await (await api(`/api/bots/${bot.id}/qr`)).json();
    assert.equal(j.strategy, "manual");
    assert.equal(j.url, null);
    assert.equal(j.qr, null);
    assert.equal(j.error, undefined);
    assert.ok(!JSON.stringify(j).includes("SECRET-FS-SECRET"), "no secret may appear in a qr response");
  } finally {
    await api(`/api/bots/${bot.id}`, { method: "DELETE" });
  }
});

test("qr endpoint: telegram resolves server-side, failures fall back to manual, a stored link wins", async () => {
  const bot = await makeBot("qr");
  const realResolve = telegramRegistry.qr.resolve;

  try {
    // Resolved: username lookup stubbed, so no network and no token leaves.
    telegramRegistry.qr.resolve = async () => ({ url: "https://t.me/acme_bot" });
    let j = await (await api(`/api/bots/${bot.id}/qr`)).json();
    assert.equal(j.strategy, "telegram-me");
    assert.equal(j.url, "https://t.me/acme_bot");
    assert.ok(j.qr.startsWith("<svg"), "the QR image is a server-generated SVG");
    assert.ok(!JSON.stringify(j).includes("SECRET-BOT-TOKEN"));

    // Upstream failure → 200 manual fallback carrying the reason.
    telegramRegistry.qr.resolve = async () => {
      throw new Error("telegram getMe failed: 401 Unauthorized");
    };
    j = await (await api(`/api/bots/${bot.id}/qr`)).json();
    assert.equal(j.strategy, "manual");
    assert.equal(j.url, null);
    assert.match(j.error, /401 Unauthorized/);

    // The manual fallback's save target becomes the QR on the next open.
    await postJson(`/api/bots/${bot.id}`, { credentials: { qrUrl: "https://example.com/entry" } }, "PATCH");
    j = await (await api(`/api/bots/${bot.id}/qr`)).json();
    assert.equal(j.strategy, "manual");
    assert.equal(j.url, "https://example.com/entry");
    assert.ok(j.qr.startsWith("<svg"));

    // A disabled bot still resolves, with no side effects.
    await postJson(`/api/bots/${bot.id}`, { enabled: false }, "PATCH");
    j = await (await api(`/api/bots/${bot.id}/qr`)).json();
    assert.equal(j.url, "https://example.com/entry");
    assert.equal(db.getBot(bot.id).enabled, false);
  } finally {
    telegramRegistry.qr.resolve = realResolve;
    await api(`/api/bots/${bot.id}`, { method: "DELETE" });
  }
});
