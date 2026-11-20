// Webhook durable acceptance, route level (add-rollout-gap-durability): the
// record is on disk before the platform's ack, a retry of the same platform
// message id never runs a second turn, and a previous process's accepted
// records are taken over honestly (pending → turn; dispatched → interrupted,
// never re-run).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import { readdirSync } from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bots-durable-"));
const acceptDir = path.join(tmpRoot, "acceptance");
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.BOTS_ACCEPTANCE_DIR = acceptDir;
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { registry: telegramRegistry } = await import("../server/bots/telegram.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");
const { createBotAcceptance } = await import("../server/bot-acceptance.js");

const sent = [];
let server;
let base;
let ctx;
let botRow;

const updateFor = (messageId, chatId, text) => ({
  update_id: messageId,
  message: { message_id: messageId, chat: { id: chatId }, from: { username: "u" }, date: 0, text },
});

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

  botRow = db.addBot({
    id: "durable-bot-1",
    type: "telegram",
    name: "durable",
    credentials: { token: "SECRET" },
    secret: "durable-secret",
  });
  telegramRegistry.sendText = async (_cred, chatKey, text) => { sent.push({ chatKey, text }); };
  telegramRegistry.start = undefined;

  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  bots.initBots(ctx);
  await new Promise((r) => setTimeout(r, 150));
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const post = (messageId, chatId, text) =>
  fetch(`${base}${WEBHOOK_PREFIX}${botRow.id}/${botRow.secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updateFor(messageId, chatId, text)),
  });

test("the record is on disk before the ack, and the turn settles it as done", async () => {
  const res = await post(101, 5001, "durable one");
  assert.equal(res.status, 200);
  const files = readdirSync(acceptDir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1, "a record file exists by ack time");
  const rec = JSON.parse(fs.readFileSync(path.join(acceptDir, files[0]), "utf8"));
  assert.equal(rec.kind, "message");
  assert.equal(rec.key, `${botRow.id}:101`);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 1, "the turn ran");
  const acceptance = createBotAcceptance({ dir: acceptDir });
  assert.equal(acceptance.byId(rec.id).state, "done", "settled turn marks the record done");
});

test("a retried platform message id is acked without a second turn", async () => {
  sent.length = 0;
  await post(202, 5002, "retry me");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 1);
  const res = await post(202, 5002, "retry me"); // same message id — platform retry / edge replay
  assert.equal(res.status, 200, "the retry is still acked (the platform must not flag the endpoint)");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 1, "no second turn for the same message id");
});

test("a different message id (same chat) turns normally — dedupe keys per message, not per chat", async () => {
  sent.length = 0;
  await post(203, 5002, "next message");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 1, "a fresh id is a fresh message");
});

test("takeover: a pre-crash pending record is dispatched by the next process", async () => {
  // Simulate the crash window: a record persisted, ack sent, process died
  // before the turn. The next process (here: the takeover pass armed at
  // register time over a NEW store instance) dispatches it.
  sent.length = 0;
  const store = createBotAcceptance({ dir: acceptDir });
  store.accept({
    kind: "message",
    botId: botRow.id,
    key: `${botRow.id}:301`,
    message: { chatKey: "5003", senderName: "u", text: "takeover pending", platformMessageId: "301" },
  });
  registerBotRoutes(ctx); // arms a fresh takeover pass (same ctx, new store? no — same route module closure)
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 1, "the takeover dispatched the pre-crash accepted message");
});

test("takeover: a pre-crash dispatched record settles as interrupted, never re-run", async () => {
  sent.length = 0;
  const store = createBotAcceptance({ dir: acceptDir });
  const rec = store.accept({
    kind: "message",
    botId: botRow.id,
    key: `${botRow.id}:401`,
    message: { chatKey: "5004", senderName: "u", text: "takeover claimed", platformMessageId: "401" },
  }).record;
  store.markDispatched(rec.id); // the turn had started before the "crash"
  registerBotRoutes(ctx);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0, "a dispatched record must not re-run (double reply)");
  const reader = createBotAcceptance({ dir: acceptDir }); // fresh read from disk
  assert.equal(reader.byId(rec.id).state, "done");
  assert.equal(reader.byId(rec.id).note, "interrupted");
});
