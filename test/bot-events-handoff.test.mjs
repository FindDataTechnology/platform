// bot-events handoff guard (Chatwoot AI reception): the AI must go silent once a
// HUMAN owns the conversation. The only trustworthy signal is the assignee:
//   · assignee.type === "User" — a human owns it.
// `conversationStatus === "pending"` is deliberately NOT a stop condition: on a
// bot inbox Chatwoot writes `pending` on every new conversation, so gating on it
// silenced the AI on the very first message (fixed 2026-11-23; see the long
// comment in server/routes/bot-events.js). The pending case is now a
// MUST-RUN case, asserted below.
// Unassigned / AgentBot-owned / fields-absent all keep today's behaviour.
//
// Runs a real express app on an ephemeral port with the injectable
// ctx.botTurnRunner seam; no network beyond loopback.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerBotEventRoutes } from "../server/routes/bot-events.js";

const TOKEN = "tok-test";
const BINDING = "binding-1";
const BOT = { id: "bot-1", name: "Reception", enabled: true, fdBotBindingId: BINDING };

let server = null;
let turns = [];

beforeEach(() => {
  process.env.BOTS_EVENTS_TOKEN = TOKEN;
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  delete process.env.BOTS_EVENTS_TOKEN;
});

async function start() {
  turns = [];
  const app = express();
  registerBotEventRoutes({
    app,
    db: { listBots: () => [BOT] },
    botTurnRunner: (botId, args) => {
      turns.push({ botId, args });
      return Promise.resolve();
    },
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${server.address().port}/api/bots/events`;
}

function post(url, envelope) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ bindingId: BINDING, chatKey: "chat-1", text: "hi", ...envelope }),
  });
}

test("assignee User → turn NOT run, note handed-off", async () => {
  const url = await start();
  const res = await post(url, { assignee: { id: 42, type: "User" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, note: "handed-off" });
  assert.equal(turns.length, 0);
});

test("conversationStatus pending → the turn STILL runs (pending means the AI is serving)", async () => {
  const url = await start();
  const res = await post(url, { conversationStatus: "pending", text: "在吗" });
  assert.equal(res.status, 200);
  // Not handed off: pending is what a bot inbox writes on every new
  // conversation, so treating it as "escalated" silenced the AI on the first
  // message. The turn must run.
  const body = await res.json();
  assert.notEqual(body.note, "handed-off", "pending is not a handoff signal");
  assert.equal(turns.length, 1, "the turn ran");
});

test("assignee null or absent → turn runs as today", async () => {
  const url = await start();
  assert.equal((await post(url, { assignee: null })).status, 200);
  await post(url, {});
  assert.equal(turns.length, 2);
});

test("assignee AgentBot → turn runs as today", async () => {
  const url = await start();
  const res = await post(url, { assignee: { id: 7, type: "AgentBot" } });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(turns.length, 1);
});