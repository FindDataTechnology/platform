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

// Hermetic outbound: this suite claims "no network", but the telegram adapter
// still issues real calls (getMe on start, sendText on a turn). With no route
// out, those connects park forever and the FILE never exits — that pending
// socket is what hung the CI unit step for an hour and cancelled every rollout
// (2026-11-09). Answer them locally instead: a 401-shaped body exercises the
// adapter's own failure path without leaving anything open.
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.startsWith("https://api.telegram.org")) {
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return REAL_FETCH(input, init);
};

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
      // `text` stays the LAST block (the user-facing prompt every assertion
      // reads); `blocks` is the full ordered list, so the identity-block
      // requirement asserts order instead of guessing at an index.
      this.prompts.push({ sessionId, text: blocks.at(-1).text, blocks: blocks.map((b) => b.text) });
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

after(async () => {
  bots.stopAll();
  // `close()` only stops new connections; a keep-alive socket from the fetch
  // calls above keeps the event loop alive, and the file-level test then hangs
  // forever ("Promise resolution is still pending") — which is what stalled the
  // CI unit step for an hour and cancelled every rollout (2026-11-09). Close the
  // connections too, and await the close so teardown is done when it returns.
  await new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
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

let fixtureMessageId = 1;
const update = (chatId, text) => ({
  update_id: Math.floor(Math.random() * 1e6),
  // A REAL platform never reuses a message id — the acceptance layer's
  // idempotency key (add-rollout-gap-durability) would correctly collapse a
  // fixed id into one message.
  message: { message_id: fixtureMessageId++, chat: { id: chatId }, from: { username: "u" }, date: 0, text },
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

test("the streaming flag is held for the duration of a bot turn (mcp-delivery guard)", async () => {
  // Prod root cause: the bot lane bypasses ctx.session.prompt (which sets the
  // flag for web turns), so dsh-mcp-delivery's isStreaming() read "idle" and a
  // credential-change restart killed the runtime MID-TURN; the collector then
  // waited for a session.status idle that never came and died on the timeout.
  sent.length = 0;
  scriptedTurn = [assistantText("flag probe")];
  const bot = await makeBot("flag");

  // While the prompt is in flight (the stub resolves it in a microtask), the
  // flag must already be observable as streaming — that is the window the
  // mcp-delivery decision reads.
  let sawStreamingDuringPrompt = null;
  const origPrompt = ctx.dshBridge.prompt.bind(ctx.dshBridge);
  ctx.dshBridge.prompt = async (sessionId, blocks) => {
    sawStreamingDuringPrompt = ctx.isStreaming === true;
    const r = await origPrompt(sessionId, blocks);
    sawStreamingDuringPrompt = ctx.isStreaming === true;
    return r;
  };

  const res = await deliver(bot, secretOf(bot), update(5150, "flag check"));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ chatKey: "5150", text: "flag probe" }]);

  assert.equal(sawStreamingDuringPrompt, true, "isStreaming must be true while the bot turn is in flight");
  assert.equal(ctx.isStreaming, false, "the flag clears when the turn settles");
  assert.equal(ctx.sessionCollectors.size, 0);
  ctx.dshBridge.prompt = origPrompt;
});

test("a successful reply is logged (send-success must not be silent)", async () => {
  // fd-prod 2026-10-29: a successful sendText logs NOTHING, so "did the reply
  // land" was indistinguishable from "the turn never ran" — the WeCom loop
  // looked dead for an hour while it was answering fine. The reply path must
  // emit one line naming the bot, the chat and the reply head.
  sent.length = 0;
  scriptedTurn = [assistantText("echo probe")];
  const bot = await makeBot("echo");

  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const res = await deliver(bot, secretOf(bot), update(5151, "echo check"));
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [{ chatKey: "5151", text: "echo probe" }]);
  } finally {
    console.log = origLog;
  }

  const replied = logs.find((l) => l.includes('"echo" replied to 5151'));
  assert.ok(replied, `a replied-to line must be logged; got: ${JSON.stringify(logs)}`);
  assert.ok(replied.includes("echo probe"), "the logged line carries the reply head");
});

test("reasoning markup folded into a text block never reaches the chat", async () => {
  // fd-prod 2026-10-29: a WeCom reply began literally with
  // "<thinking>The user is asking me to respond with a single wor…" — the model
  // folded its trace into the text block, and chat platforms have no collapsible
  // reasoning UI, so the user saw raw chain-of-thought.
  sent.length = 0;
  scriptedTurn = [assistantText("<thinking>The user wants one word.\n</thinking>pong")];
  const bot = await makeBot("think");
  const res = await deliver(bot, secretOf(bot), update(5152, "one word please"));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ chatKey: "5152", text: "pong" }], "the trace is stripped, the answer survives");
});

test("a reasoning-only reply is replaced with an honest fallback, not a trace wall", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("<thinking>Hmm, still thinking</thinking>")];
  const bot = await makeBot("thinkonly");
  const res = await deliver(bot, secretOf(bot), update(5153, "answer please"));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.ok(!/<thinking>/i.test(sent[0].text), "no trace may reach the chat");
  assert.match(sent[0].text, /Please ask again/);
});

// ── Per-bot tool posture (harden-bot-reply-lane, design D3) ──────────────────
//
// The deployment env is a CEILING; the bot's own flag is the switch. Both
// checks (prompt prefix + reply-side withhold) read one function, so each case
// asserts the OBSERVABLE outcome: does the tool-derived text reach the chat?

const withCeiling = async (on, fn) => {
  const prev = process.env.BOTS_ALLOW_TOOLS;
  if (on) process.env.BOTS_ALLOW_TOOLS = "1";
  else delete process.env.BOTS_ALLOW_TOOLS;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.BOTS_ALLOW_TOOLS;
    else process.env.BOTS_ALLOW_TOOLS = prev;
  }
};

test("tool posture: bot flag off withholds even when the ceiling is open", async () => {
  await withCeiling(true, async () => {
    sent.length = 0;
    scriptedTurn = [toolCall(), assistantText("answer built from a tool")];
    const bot = await makeBot("tools-off");

    await deliver(bot, secretOf(bot), update(9001, "run something"));

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].text.includes("answer built from a tool"), "flag off wins over the ceiling");
    assert.ok(ctx.dshBridge.prompts.at(-1).text.startsWith("You are answering a message"));
  });
});

test("tool posture: bot flag on under an open ceiling runs tools and forwards the answer", async () => {
  await withCeiling(true, async () => {
    sent.length = 0;
    scriptedTurn = [toolCall(), assistantText("answer built from a tool")];
    const created = await (await postJson("/api/bots", {
      type: "telegram",
      name: "tools-on",
      credentials: { token: "SECRET-BOT-TOKEN" },
      allowTools: true,
    })).json();
    assert.equal(created.allowTools, true, "the API round-trips the flag");
    const entry = bots.getEntry(created.id);
    entry.adapter = { ...entry.adapter, start: undefined, async sendText(_c, chatKey, text) { sent.push({ chatKey, text }); } };

    await deliver(created, secretOf(created), update(9002, "run something"));

    assert.deepEqual(sent, [{ chatKey: "9002", text: "answer built from a tool" }]);
    assert.ok(!ctx.dshBridge.prompts.at(-1).text.startsWith("You are answering a message"), "no no-tools prefix");
  });
});

test("tool posture: the deployment ceiling wins over a bot that has the flag on", async () => {
  await withCeiling(false, async () => {
    sent.length = 0;
    scriptedTurn = [toolCall(), assistantText("answer built from a tool")];
    const created = await (await postJson("/api/bots", {
      type: "telegram",
      name: "tools-ceiling",
      credentials: { token: "SECRET-BOT-TOKEN" },
      allowTools: true,
    })).json();
    const entry = bots.getEntry(created.id);
    entry.adapter = { ...entry.adapter, start: undefined, async sendText(_c, chatKey, text) { sent.push({ chatKey, text }); } };

    await deliver(created, secretOf(created), update(9003, "run something"));

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].text.includes("answer built from a tool"), "the ceiling cannot be lifted per bot");
  });
});

// ── Runtime readiness (design D1) ───────────────────────────────────────────
//
// The old code answered "starting up" the instant isReady() was false, which
// every rollout turned into a user-visible non-answer.

const withReadyBudget = async (ms, fn) => {
  const prev = process.env.BOTS_READY_WAIT_MS;
  process.env.BOTS_READY_WAIT_MS = String(ms);
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.BOTS_READY_WAIT_MS;
    else process.env.BOTS_READY_WAIT_MS = prev;
  }
};

test("readiness: a message arriving before the runtime is up waits, then answers", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("real answer after boot")];
  const bot = await makeBot("boot-wait");

  // Not ready for the first few polls, ready afterwards.
  const readyAt = Date.now() + 600;
  ctx.dshBridge.isReady = () => Date.now() >= readyAt;
  const before = ctx.dshBridge.prompts.length;

  await withReadyBudget(3000, async () => {
    await deliver(bot, secretOf(bot), update(9101, "hello?"));
    // The route acks first and the turn (including the wait) runs async.
    await new Promise((r) => setTimeout(r, 1200));
  });

  assert.deepEqual(sent, [{ chatKey: "9101", text: "real answer after boot" }]);
  assert.ok(!sent.some((s) => /starting up/i.test(s.text)), "no startup notice once the wait succeeds");
  assert.equal(ctx.dshBridge.prompts.length, before + 1, "the turn really ran");
  ctx.dshBridge.isReady = () => true;
});

test("readiness: budget exhaustion replies with the startup notice and logs it as a wait timeout", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("never reached")];
  const bot = await makeBot("boot-timeout");
  ctx.dshBridge.isReady = () => false;
  const before = ctx.dshBridge.prompts.length;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };

  try {
    await withReadyBudget(600, async () => {
      await deliver(bot, secretOf(bot), update(9102, "hello?"));
      await new Promise((r) => setTimeout(r, 900));
    });
  } finally {
    console.warn = realWarn;
    ctx.dshBridge.isReady = () => true;
  }

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /starting up/i);
  assert.equal(ctx.dshBridge.prompts.length, before, "no turn is started while the runtime is down");
  assert.ok(
    warns.some((w) => /still not ready after 600ms wait/.test(w)),
    "the log says it was a WAIT timeout, not a turn failure",
  );
});

test("readiness: messages queued during the wait stay serial", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("first"), assistantText("second")];
  const bot = await makeBot("boot-queue");
  let readyAt = Date.now() + 600;
  ctx.dshBridge.isReady = () => Date.now() >= readyAt;

  try {
    await withReadyBudget(3000, async () => {
      await deliver(bot, secretOf(bot), update(9103, "one"));
      await deliver(bot, secretOf(bot), update(9103, "two"));
      await new Promise((r) => setTimeout(r, 2000));
    });
  } finally {
    ctx.dshBridge.isReady = () => true;
  }

  assert.equal(sent.length, 2, "both messages got a reply — nothing dropped");
  assert.ok(
    !sent.some((s) => /starting up/i.test(s.text)),
    "queued messages wait for readiness instead of taking the canned notice",
  );
});

// ── Identity block (design D2) ──────────────────────────────────────────────

test("identity: a configured persona leads the prompt blocks", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("as configured")];
  const created = await (await postJson("/api/bots", {
    type: "telegram",
    name: "persona-bot",
    credentials: { token: "SECRET-BOT-TOKEN" },
    persona: "你是智语，壹座的对外助手。",
  })).json();
  assert.equal(created.persona, "你是智语，壹座的对外助手。", "the API round-trips the persona");
  const entry = bots.getEntry(created.id);
  entry.adapter = { ...entry.adapter, start: undefined, async sendText(_c, chatKey, text) { sent.push({ chatKey, text }); } };

  await deliver(created, secretOf(created), update(9201, "你是谁"));

  const turn = ctx.dshBridge.prompts.at(-1);
  assert.equal(turn.blocks[0], "你是智语，壹座的对外助手。", "the persona is the leading block");
  assert.equal(turn.blocks.length, 2);
});

test("identity: an unconfigured bot gets a neutral default naming itself", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("as default")];
  const bot = await makeBot("无名助手");

  await deliver(bot, secretOf(bot), update(9202, "你能做什么"));

  const turn = ctx.dshBridge.prompts.at(-1);
  assert.match(turn.blocks[0], /无名助手/, "the neutral block names the bot");
  assert.match(turn.blocks[0], /不要冒充运营者/, "and forbids impersonating internal roles");
});
