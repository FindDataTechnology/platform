// Tests for the machine-caller bot relay (add-bot-relay-endpoint).
//
// Runs the real Express routes and the real bots module against an isolated
// DB_PATH and a stubbed telegram adapter, so the whole relay path — auth →
// channel resolution → guards → platform send → audit — is exercised with no
// network and no agent runtime. One test drives a genuine inbound webhook too,
// proving the chain webhook → recorded chat → binding → relay send.
//
// Covered contract scenarios (specs/bot-relay, specs/social-bot-channels):
//   - inert (404) with no token configured; 401 for a missing/wrong token,
//     decided before the body is parsed and without logging its content
//   - a valid token delivers through the bound channel, ignoring caller-supplied
//     destination fields
//   - unknown channel 404, disabled bot refused, oversize rejected — each with
//     no platform call
//   - per-channel rate limit; platform failure contained and redacted
//   - one audit row per attempt carrying the text LENGTH and never the text
//   - admin channel CRUD: bindable only from a recorded chat, no credentials,
//     403 without the admin group

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-test-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// A public base URL keeps every bot in webhook mode: with it unset, each
// created bot would start a real Telegram getUpdates poll loop against the
// network, which this suite must not do.
process.env.PUBLIC_BASE_URL = "http://relay.test";
delete process.env.BOTS_ALLOW_TOOLS;

const TOKEN = "relay-token-under-test";
process.env.BOTS_RELAY_TOKEN = TOKEN;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRelayRoutes, RELAY_PREFIX } = await import("../server/routes/bot-relay.js");
const { registerBotRoutes } = await import("../server/routes/bots.js");

// Every sendText the telegram adapter would have made, captured instead of sent.
const sent = [];
// The same calls, unprojected — so a test can assert the full
// (credentials, chatKey, text) triple the adapter received.
const calls = [];
// The next turn's scripted notification stream, replayed when prompt() is called.
let scriptedTurn = [];

let server;
let base;
let ctx;

before(async () => {
  await db.initDb();

  const app = express();
  // Same body-parser wiring as server.js: the webhook prefix keeps its raw
  // bytes and the relay prefix keeps its body unparsed until its token check —
  // getting this wrong would either empty webhook bodies or parse relay bodies
  // before authentication.
  const jsonBodyParser = express.json();
  app.use((req, res, next) =>
    req.path.startsWith("/api/bots/webhook/") || req.path.startsWith(RELAY_PREFIX)
      ? next()
      : jsonBodyParser(req, res, next),
  );
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  // Same order as server.js: the relay route must win over /api/bots/:id/send.
  registerBotRelayRoutes(ctx);
  registerBotRoutes(ctx);

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

const relay = (body, token = TOKEN) =>
  api(`${RELAY_PREFIX}send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// Create a telegram bot whose sendText is captured rather than performed. The
// capture lives on the runtime entry's adapter — the same object the reply path
// uses — so a relay send through it also proves no second adapter (and no
// second platform token cache) was created for the relay.
async function makeBot(name = "relaybot") {
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
    async sendText(cred, chatKey, text) {
      calls.push({ cred, chatKey, text });
      sent.push({ chatKey, text });
    },
  };
  return bot;
}

// A chat is bindable only after the inbound pipeline recorded it; seed that
// record the same way the pipeline does.
const seen = (botId, chatKey, senderName = "u") => db.upsertBotChat(botId, chatKey, senderName);

const bind = (name, botId, chatKey) => postJson("/api/bots/channels", { name, botId, chatKey });

const auditRows = (channel) => db.listRelayLog(200).filter((r) => r.channel === channel);

// ── Authentication ───────────────────────────────────────────────────────────

test("unconfigured relay is inert: 404 and no send path", async () => {
  const real = process.env.BOTS_RELAY_TOKEN;
  delete process.env.BOTS_RELAY_TOKEN;
  try {
    const bot = await makeBot("inert");
    seen(bot.id, "1");
    await bind("inert-chan", bot.id, "1");
    sent.length = 0;

    const res = await relay({ channel: "inert-chan", text: "hello" });
    assert.equal(res.status, 404);
    assert.deepEqual(sent, [], "an unconfigured relay must not reach a platform");
    // The valid-token case is a 404 here too: the route does not exist at all.
    assert.equal((await relay({ channel: "inert-chan", text: "hello" }, "anything")).status, 404);
  } finally {
    process.env.BOTS_RELAY_TOKEN = real;
  }
});

test("a forged request is rejected before the body is read and without logging it", async () => {
  const bot = await makeBot("forge");
  seen(bot.id, "2");
  await bind("forge-chan", bot.id, "2");
  sent.length = 0;

  assert.equal((await relay({ channel: "forge-chan", text: "nope" }, "wrong-token")).status, 401);
  assert.equal((await relay({ channel: "forge-chan", text: "nope" }, null)).status, 401);

  // The body is not parsed before authentication: a malformed JSON body with a
  // bad token is a 401, not a 400 from the parser.
  assert.equal((await relay("{not json", "wrong-token")).status, 401);

  // Nothing about the request reaches the logs.
  const logs = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;
  const capture = (...args) => { logs.push(args.join(" ")); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await relay({ channel: "forge-chan", text: "leak-me-not" }, "wrong-token");
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
  }
  assert.ok(!logs.join("\n").includes("leak-me-not"), "a rejected body must not be logged");

  assert.deepEqual(sent, []);
  assert.equal(auditRows("forge-chan").length, 0, "auth failures are not audited as attempts");
  assert.ok(!JSON.stringify(auditRows("forge-chan")).includes("relay-token-under-test"));
});

test("a malformed body with a valid token answers 400, not 500", async () => {
  const res = await relay("{not json");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Malformed/);
});

// ── Channel resolution and delivery ──────────────────────────────────────────

test("a bound channel delivers through the runtime adapter", async () => {
  sent.length = 0;
  calls.length = 0;
  const bot = await makeBot("deliver");
  seen(bot.id, "555", "Ada");
  await bind("ops-alerts", bot.id, "555");

  const res = await relay({ channel: "ops-alerts", text: "digest ready" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.deepEqual(sent, [{ chatKey: "555", text: "digest ready" }]);
  // The exact triple the adapter received: the bound bot's stored credentials,
  // the bound chat key, and the caller's text — nothing else reaches a platform.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    cred: { token: "SECRET-BOT-TOKEN" },
    chatKey: "555",
    text: "digest ready",
  });
  const rows = auditRows("ops-alerts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "sent");
  assert.equal(rows[0].botId, bot.id);
  assert.equal(rows[0].textChars, "digest ready".length);
  assert.ok(!JSON.stringify(rows).includes("digest ready"), "the audit row must not hold the text");
});

test("caller-supplied destination fields have no effect", async () => {
  sent.length = 0;
  const bound = await makeBot("bound");
  const other = await makeBot("other");
  seen(bound.id, "100");
  seen(other.id, "200");
  await bind("fixed-dest", bound.id, "100");

  const res = await relay({
    channel: "fixed-dest",
    text: "go where I say",
    botId: other.id,
    chatKey: "200",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ chatKey: "100", text: "go where I say" }]);
});

test("the full chain works: inbound webhook records the chat, then the relay delivers", async () => {
  sent.length = 0;
  scriptedTurn = [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "ack" }] } } }];
  const bot = await makeBot("chain");
  const secret = bot.webhookUrl.split("/").pop();

  const update = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 4242 }, from: { username: "ada" }, date: 0, text: "hi bot" },
  };
  const inbound = await postJson(`/api/bots/webhook/${bot.id}/${secret}`, update);
  assert.equal(inbound.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, "the agent's reply went back to the chat");

  const recorded = db.listBotChats().find((c) => c.botId === bot.id);
  assert.equal(recorded.chatKey, "4242");
  assert.equal(recorded.senderName, "ada");

  assert.equal((await bind("chain-chan", bot.id, "4242")).status, 200);
  sent.length = 0;
  assert.equal((await relay({ channel: "chain-chan", text: "from the cloud" })).status, 200);
  assert.deepEqual(sent, [{ chatKey: "4242", text: "from the cloud" }]);
});

// ── Guards ───────────────────────────────────────────────────────────────────

test("an unknown channel is 404 with no platform call, and is audited", async () => {
  sent.length = 0;
  const res = await relay({ channel: "never-bound", text: "hello" });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Unknown channel/);
  assert.deepEqual(sent, []);
  const rows = auditRows("never-bound");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "rejected");
  assert.equal(rows[0].botId, null);
});

test("a channel whose bot is disabled is refused without contacting the platform", async () => {
  sent.length = 0;
  const bot = await makeBot("disabled");
  seen(bot.id, "300");
  await bind("off-chan", bot.id, "300");
  await postJson(`/api/bots/${bot.id}`, { enabled: false }, "PATCH");
  // The PATCH rebuilds the runtime entry from the adapter registry, dropping
  // this suite's capture stub — restore it so the admin-path assertion below
  // cannot reach the network.
  const entry = bots.getEntry(bot.id);
  entry.adapter = {
    ...entry.adapter,
    start: undefined,
    async sendText(cred, chatKey, text) {
      calls.push({ cred, chatKey, text });
      sent.push({ chatKey, text });
    },
  };

  const res = await relay({ channel: "off-chan", text: "anyone there" });
  assert.equal(res.status, 409);
  assert.deepEqual(sent, []);
  assert.equal(auditRows("off-chan")[0].outcome, "rejected");

  // The existing admin endpoint keeps its behavior: a disabled bot is still
  // reachable there (deliberate difference, design D7).
  const admin = await postJson(`/api/bots/${bot.id}/send`, { chatKey: "300", text: "admin path" });
  assert.equal(admin.status, 200);
  assert.deepEqual(sent, [{ chatKey: "300", text: "admin path" }]);
});

test("oversize and empty text are rejected without sending", async () => {
  sent.length = 0;
  const bot = await makeBot("sizes");
  seen(bot.id, "400");
  await bind("size-chan", bot.id, "400");

  assert.equal((await relay({ channel: "size-chan", text: "x".repeat(bots.MAX_RELAY_CHARS + 1) })).status, 400);
  assert.equal((await relay({ channel: "size-chan", text: "" })).status, 400);
  assert.equal((await relay({ channel: "size-chan" })).status, 400);
  assert.deepEqual(sent, []);

  const rows = auditRows("size-chan");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.outcome === "rejected"));

  // The cap itself still delivers.
  assert.equal((await relay({ channel: "size-chan", text: "x".repeat(bots.MAX_RELAY_CHARS) })).status, 200);
  assert.equal(sent.length, 1);
});

test("the per-channel rate limit trips and is recorded, without a platform call", async () => {
  sent.length = 0;
  const bot = await makeBot("limits");
  seen(bot.id, "500");
  await bind("rate-chan", bot.id, "500");

  // 10/min is the bucket; the 11th send in the same minute is refused.
  for (let i = 0; i < 10; i++) {
    assert.equal((await relay({ channel: "rate-chan", text: `m${i}` })).status, 200);
  }
  const res = await relay({ channel: "rate-chan", text: "one too many" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(sent.length, 10, "the 11th send must not reach the platform");
  // listRelayLog is newest-first (ts DESC, rowid DESC), so [0] is the last
  // attempt — the rejected one.
  const rows = auditRows("rate-chan");
  assert.equal(rows.length, 11);
  assert.equal(rows[0].outcome, "rejected");

  // A second channel is unaffected by the first one's bucket.
  seen(bot.id, "501");
  await bind("rate-chan-2", bot.id, "501");
  assert.equal((await relay({ channel: "rate-chan-2", text: "elsewhere" })).status, 200);
});

test("a platform failure is reported, recorded, redacted, and contained", async () => {
  const bot = await makeBot("failure");
  seen(bot.id, "600");
  await bind("fail-chan", bot.id, "600");
  const entry = bots.getEntry(bot.id);
  const realSend = entry.adapter.sendText;

  entry.adapter.sendText = async () => {
    // The shape adapters actually produce: the URL carries the credential.
    throw new Error("https://api.telegram.org/botSECRET-BOT-TOKEN/sendMessage → HTTP 500: oops");
  };
  try {
    const res = await relay({ channel: "fail-chan", text: "will fail" });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /HTTP 500/, "the caller gets the platform's failure");
    assert.ok(!body.error.includes("SECRET-BOT-TOKEN"), "the bot credential must be redacted");

    const row = auditRows("fail-chan").at(-1);
    assert.equal(row.outcome, "failed");
    assert.match(row.error, /HTTP 500/);
    assert.ok(!row.error.includes("SECRET-BOT-TOKEN"), "the audit row must be redacted too");
  } finally {
    entry.adapter.sendText = realSend;
  }

  // The failure is contained: the same channel works on the next attempt.
  assert.equal((await relay({ channel: "fail-chan", text: "retry" })).status, 200);
});

// ── Containment: one poller, one token cache, one writer ─────────────────────

test("a relay send adds no poller and no second platform-token owner", async () => {
  const { registry: telegramRegistry } = await import("../server/bots/telegram.js");
  const realStart = telegramRegistry.start;
  const starts = [];
  telegramRegistry.start = (bot) => { starts.push(bot.id); return () => {}; };

  const realBase = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    const bot = await makeBot("polling");
    assert.deepEqual(starts, [bot.id], "the bot's own receiving path starts one poller");

    seen(bot.id, "900");
    await bind("poll-chan", bot.id, "900");
    sent.length = 0;
    assert.equal((await relay({ channel: "poll-chan", text: "while polling" })).status, 200);

    assert.deepEqual(starts, [bot.id], "a relay send must not start another poller");
    // The delivery went through the runtime entry's adapter — the same object
    // the reply path uses — so no second adapter (and no second platform token
    // cache) was constructed for the relay.
    assert.deepEqual(sent, [{ chatKey: "900", text: "while polling" }]);
  } finally {
    telegramRegistry.start = realStart;
    process.env.PUBLIC_BASE_URL = realBase;
  }
});

// ── Admin channel management ─────────────────────────────────────────────────

test("channels are bindable only from recorded chats, and expose no credentials", async () => {
  const bot = await makeBot("admin");
  seen(bot.id, "700", "Ada");

  // An unrecorded destination cannot be bound.
  const unrecorded = await bind("blind-chan", bot.id, "999");
  assert.equal(unrecorded.status, 400);
  assert.match((await unrecorded.json()).error, /never messaged/);

  // Nor can a bad name or an unknown bot.
  assert.equal((await bind("Bad Name", bot.id, "700")).status, 400);
  assert.equal((await bind("nope-nope", "no-such-bot", "700")).status, 404);

  // The recorded one can, and listing never carries credentials.
  assert.equal((await bind("ok-chan", bot.id, "700")).status, 200);
  const chats = await (await api("/api/bots/chats")).json();
  const channels = await (await api("/api/bots/channels")).json();
  const listing = JSON.stringify({ chats, channels });
  assert.ok(!listing.includes("SECRET-BOT-TOKEN"));
  assert.equal(chats.chats.find((c) => c.botId === bot.id && c.chatKey === "700").botName, "admin");
  const channel = channels.channels.find((c) => c.name === "ok-chan");
  assert.deepEqual(Object.keys(channel).sort(), ["botId", "chatKey", "createdAt", "name"]);
  assert.equal(channel.chatKey, "700");

  // Duplicate names are refused; deletion stops delivery immediately.
  assert.equal((await bind("ok-chan", bot.id, "700")).status, 409);
  assert.equal((await relay({ channel: "ok-chan", text: "before delete" })).status, 200);
  assert.equal((await api("/api/bots/channels/ok-chan", { method: "DELETE" })).status, 200);
  assert.equal((await api("/api/bots/channels/ok-chan", { method: "DELETE" })).status, 404);
  assert.equal((await relay({ channel: "ok-chan", text: "after delete" })).status, 404);
});

test("channel management is admin-gated behind the identity gate", async () => {
  const app = express();
  app.use(express.json());
  const faCtx = createAppContext({ AUTH_MODE: "forward_auth" });
  faCtx.app = app;
  registerAuth(faCtx);
  registerBotRoutes(faCtx);
  const faServer = app.listen(0);
  const faBase = `http://127.0.0.1:${faServer.address().port}`;
  const identity = (groups) => ({
    "x-forwarded-email": "user@example.com",
    "x-forwarded-groups": groups,
  });

  try {
    const asUser = await fetch(`${faBase}/api/bots/channels`, { headers: identity("users") });
    assert.equal(asUser.status, 403);

    const asAdmin = await fetch(`${faBase}/api/bots/channels`, { headers: identity("admin") });
    assert.equal(asAdmin.status, 200);

    // The relay route itself is NOT registered on this app (it is exempt, but
    // it is mounted by its own module) — an unauthenticated /api route here
    // still 401s, which is the point of the gate.
    const anonymous = await fetch(`${faBase}/api/bots/chats`);
    assert.equal(anonymous.status, 401);
  } finally {
    faServer.close();
  }
});
