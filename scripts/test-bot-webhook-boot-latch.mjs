// Regression for the fd-prod 2026-10-29 message loss: the cell calls
// server.listen 8.2s BEFORE bots.initBots finishes (db open + dsh handshake),
// and the gateway proxies a bot webhook as soon as the port answers. A message
// landing in that window found an EMPTY registry and got a definite 403
// "unknown bot" — which the chat platform treats as final, so the message was
// dropped (observed twice right after a roll).
//
// Waiting is not an option either: WeCom/WeChat drop a callback at ~5s, well
// inside that 8s boot. So the boot window ACKS AT ONCE and replays the buffered
// request through the FULL pipeline (signature check included) once the
// registry loads. A forged request earns a bare 200 and is never dispatched;
// a genuinely unknown bot still gets the same 403 once boot settles.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bots-latch-test-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { registry: telegramRegistry } = await import("../server/bots/telegram.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

const sent = [];
let server;
let base;
let ctx;
let botRow;

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

  ctx.dshBridge = { isReady: () => true, prompt: async () => { throw new Error("unused"); } };

  // The bot ROW exists in the database, but initBots has NOT run yet — this is
  // exactly the boot window: the cell is listening, the registry is empty.
  botRow = db.addBot({
    id: "latch-bot-1",
    type: "telegram",
    name: "latch",
    credentials: { token: "SECRET" },
    secret: "latch-secret",
  });
  telegramRegistry.sendText = async (_cred, chatKey, text) => { sent.push({ chatKey, text }); };
  telegramRegistry.start = undefined;

  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let fixtureMessageId = 1;
const updateFor = (chatId, text) => ({
  update_id: Math.floor(Math.random() * 1e6),
  // Real platforms never reuse ids — the acceptance idempotency key would collapse a fixed one.
  message: { message_id: fixtureMessageId++, chat: { id: chatId }, from: { username: "u" }, date: 0, text },
});

test("a webhook arriving before the registry loads is acked at once, then processed", async () => {
  assert.equal(bots.bootPending(), true, "the fixture must be inside the boot window");
  assert.equal(bots.getEntry(botRow.id), null, "registry is still empty at this point");

  // The platform gets its "success" immediately — it will not retry or judge
  // the endpoint dead, which is the whole point (the old code answered 403).
  const t0 = Date.now();
  const res = await fetch(`${base}${WEBHOOK_PREFIX}${botRow.id}/${botRow.secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updateFor(777, "boot race")),
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 200, "the boot-window webhook must be acked, not refused");
  assert.equal(await res.text(), "success");
  assert.ok(elapsed < 1000, `the ack must not wait for boot (took ${elapsed}ms)`);
  assert.equal(sent.length, 0, "nothing is dispatched before the registry loads");

  // The boot completes: the buffered request is replayed through the full
  // pipeline (verification included) and the turn runs.
  bots.initBots(ctx);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.length, 1, "the buffered webhook must be replayed after boot");
  assert.deepEqual(sent[0], { chatKey: "777", text: "Sorry — I could not complete that request." });
});

test("a buffered webhook with a BAD secret is refused on replay, never dispatched", async () => {
  // Fresh boot window is not available here (latch already settled), so this
  // asserts the pipeline itself: a wrong secret cannot reach handleMessage.
  sent.length = 0;
  const res = await fetch(`${base}${WEBHOOK_PREFIX}${botRow.id}/wrong-secret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updateFor(888, "forged")),
  });
  assert.equal(res.status, 403);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0, "a forged webhook must never dispatch");
});

test("a genuinely unknown bot still gets the same 403 once boot settles", async () => {
  assert.equal(bots.bootPending(), false, "boot is settled by now");
  const res = await fetch(`${base}${WEBHOOK_PREFIX}no-such-bot/whatever`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});
