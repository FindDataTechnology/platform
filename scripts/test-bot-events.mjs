// Tests for the fd-bot subscriber endpoint (adopt-fd-bot-transport 6.1-6.3).
//
// Runs the real Express route against an isolated DB_PATH, with the agent turn
// stubbed at the bots module's own seam. The point of these tests is the
// TRANSPORT seam, not the turn: which token is accepted, which bot an envelope
// is routed to, and what happens when the route is not configured.
//
// Covered contract scenarios (specs/im-transport-service):
//   - no token configured → 404 (inert, never a weaker form)
//   - wrong token → 401 before the body is used
//   - a binding id no bot owns → 410 (retrying cannot help)
//   - an enabled bot's envelope runs one turn on the legacy path
//   - a disabled bot's envelope is accepted and does nothing
//   - a bot bound to a room goes to the bridge, not to a per-chat session

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bot-events-test-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PUBLIC_BASE_URL = "http://events.test";
delete process.env.BOTS_ALLOW_TOOLS;

const TOKEN = "events-token-under-test";
process.env.BOTS_EVENTS_TOKEN = TOKEN;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotEventRoutes, EVENTS_PREFIX } = await import("../server/routes/bot-events.js");
const { registerBotRoutes } = await import("../server/routes/bots.js");

let server;
let base;
let ctx;
let turnCalls = [];

before(async () => {
  await db.initDb();

  const app = express();
  const jsonBodyParser = express.json();
  // Same wiring rule as server.js: the events prefix keeps its body unparsed
  // until the route's own token check runs.
  app.use((req, res, next) => (req.path === EVENTS_PREFIX ? next() : jsonBodyParser(req, res, next)));
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);
  registerBotEventRoutes(ctx);

  ctx.dshBridge = {
    isReady: () => true,
    async prompt() {
      return "msg-1";
    },
  };

  // The route's turn seam (registerBotEventRoutes reads ctx.botTurnRunner).
  turnCalls = [];
  ctx.botTurnRunner = async (botId, args) => {
    turnCalls.push({ botId, ...args });
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

const post = (body, token = TOKEN) =>
  fetch(`${base}${EVENTS_PREFIX}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

function makeBot({ name = "test-bot", enabled = true, transport = "fd-bot", bindingId = "b_test1" } = {}) {
  const bot = db.addBot({
    id: `bot-${Math.random().toString(36).slice(2)}`,
    type: "slack",
    name,
    credentials: { botToken: "xoxb-test" },
    secret: "s3cret",
    enabled,
    ownerEmail: "owner@test.local",
  });
  return db.setBotTransport(bot.id, transport, bindingId);
}

test("no token configured answers 404, not a weaker form", async () => {
  const saved = process.env.BOTS_EVENTS_TOKEN;
  delete process.env.BOTS_EVENTS_TOKEN;
  try {
    const res = await post({ bindingId: "b_x", text: "hi" }, "anything");
    assert.equal(res.status, 404);
  } finally {
    process.env.BOTS_EVENTS_TOKEN = saved;
  }
});

test("a wrong or missing token is refused before the body is used", async () => {
  const bot = makeBot({ bindingId: "b_auth" });
  turnCalls = [];
  const wrong = await post({ bindingId: "b_auth", text: "hi" }, "nope");
  assert.equal(wrong.status, 401);
  const missing = await post({ bindingId: "b_auth", text: "hi" }, null);
  assert.equal(missing.status, 401);
  assert.equal(turnCalls.length, 0, "no turn may run for a refused request");
  assert.ok(bot);
});

test("a binding no bot owns answers 410, not 404", async () => {
  const res = await post({ bindingId: "b_nobody", chatKey: "c1", text: "hi" });
  assert.equal(res.status, 410, "retrying cannot fix an unknown binding");
});

test("an envelope for an enabled bot runs exactly one turn", async () => {
  makeBot({ name: "live", bindingId: "b_live" });
  turnCalls = [];
  const res = await post({
    bindingId: "b_live",
    chatKey: "chan-1",
    senderId: "u1",
    senderName: "Alice",
    text: "hello",
    platformMessageId: "m-1",
  });
  assert.equal(res.status, 200);
  assert.equal(turnCalls.length, 1);
  assert.deepEqual(turnCalls[0].chatKey, "chan-1");
  assert.equal(turnCalls[0].text, "hello");
  assert.equal(turnCalls[0].senderName, "Alice");
});

test("a disabled bot's envelope is accepted and starts nothing", async () => {
  makeBot({ name: "off", enabled: false, bindingId: "b_off" });
  turnCalls = [];
  const res = await post({ bindingId: "b_off", chatKey: "c", text: "hi" });
  assert.equal(res.status, 200, "2xx so fd-bot does not redeliver a message we chose not to act on");
  assert.equal(turnCalls.length, 0);
});

test("a room-bound bot's envelope goes to the bridge instead of a chat session", async () => {
  const bot = makeBot({ name: "roomed", bindingId: "b_room" });
  db.updateBot(bot.id, { zhiRoomId: "room-1" });
  const bridged = [];
  ctx.zhiyuImBridge = {
    async handleInbound(args) {
      bridged.push(args);
      return true;
    },
  };
  turnCalls = [];
  try {
    const res = await post({ bindingId: "b_room", chatKey: "grp", senderId: "u2", senderName: "Bob", text: "room please" });
    assert.equal(res.status, 200);
    assert.equal(bridged.length, 1);
    assert.equal(bridged[0].bot.id, bot.id);
    assert.equal(turnCalls.length, 0, "a bridged message must not also run a per-chat turn");
  } finally {
    ctx.zhiyuImBridge = undefined;
  }
});

test("a retryable bridge failure answers 503 (fd-bot retries), not 200-drop", async () => {
  const bot = makeBot({ name: "roomed-cold", bindingId: "b_cold" });
  db.updateBot(bot.id, { zhiRoomId: "room-2" });
  ctx.zhiyuImBridge = {
    async handleInbound() {
      const e = new Error("gateway unreachable for bot \"x\": ECONNREFUSED");
      e.code = "bridge_unreachable";
      e.retryable = true;
      throw e;
    },
  };
  turnCalls = [];
  try {
    const res = await post({ bindingId: "b_cold", chatKey: "grp", senderId: "u2", senderName: "Bob", text: "cold please" });
    // 503 → fd-bot re-delivers once the cell is up. A 200 here would mark it
    // delivered and lose it (the 2026-11-22 cold-start bug).
    assert.equal(res.status, 503);
    assert.equal(turnCalls.length, 0, "no per-chat turn fallback on a retryable bridge failure");
  } finally {
    ctx.zhiyuImBridge = undefined;
  }
});

test("a missing bindingId is a client error", async () => {  const res = await post({ chatKey: "c", text: "hi" });
  assert.equal(res.status, 400);
});

test("the transport switch stores the pair together, and legacy clears both", () => {
  const bot = makeBot({ name: "switch", bindingId: "b_switch" });
  assert.equal(bot.transport, "fd-bot");
  assert.equal(bot.fdBotBindingId, "b_switch");
  const back = db.setBotTransport(bot.id, "legacy");
  assert.equal(back.transport, null);
  assert.equal(back.fdBotBindingId, null);
});
