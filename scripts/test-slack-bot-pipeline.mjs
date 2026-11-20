// End-to-end pipeline test for the Slack adapter: webhook → signature verify →
// url_verification handshake → parse → guards → turn → reply, against the REAL
// bots module with a stub bridge, driving correctly-signed Events API payloads.
//
// What this pins that the adapter self-check cannot:
//   - the webhook route accepts a v0-signed body and refuses a tampered one;
//   - the url_verification handshake echoes the challenge through the real
//     route (not just through the adapter function);
//   - a threaded reply keys its room on channel:root while a channel-level
//     message keys on the bare channel — the design's load-bearing decision;
//   - bot echoes and edits never start a turn;
//   - sendText posts to chat.postMessage with thread_ts for a threaded chatKey.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slack-pipeline-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { registry: slack } = await import("../server/bots/slack.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

const CRED = { botToken: "xoxb-test-token", signingSecret: "slack-signing-secret" };

let server, base, bot, secret;
const prompts = []; // { sessionId, text }
const sends = []; // { url, body }

const sign = (raw, ts = String(Math.floor(Date.now() / 1000))) => ({
  "x-slack-request-timestamp": ts,
  "x-slack-signature": `v0=${crypto.createHmac("sha256", CRED.signingSecret).update(`v0:${ts}:${raw}`).digest("hex")}`,
});

const postRaw = (raw, { ts, overrideSig } = {}) => {
  const headers = { "content-type": "application/json", ...sign(raw, ts) };
  if (overrideSig) headers["x-slack-signature"] = overrideSig;
  return fetch(`${base}${WEBHOOK_PREFIX}${bot.id}/${secret}`, { method: "POST", headers, body: raw });
};

const postEvent = (event, extra = {}) =>
  postRaw(JSON.stringify({ type: "event_callback", event_id: extra.eventId ?? "Ev1", event, ...extra.headers ?? {} }));

before(async () => {
  await db.initDb();
  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) => (req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next)));
  const ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);

  ctx.dshBridge = {
    isReady: () => true,
    prompt: async (sessionId, blocks) => {
      prompts.push({ sessionId, text: blocks?.at(-1)?.text ?? "" });
      const collector = ctx.sessionCollectors.get(sessionId);
      if (collector) {
        collector({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "答：收到" }] } } } } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      }
      return "mid";
    },
  };

  const created = await db.addBot({ id: "slack-1", type: "slack", name: "智语·Slack", credentials: CRED, secret: "sl-secret" });
  bot = created;
  secret = created.secret;
  bots.initBots(ctx);

  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Never let a test send reach slack.com for real.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://slack.com/api/")) {
      const body = JSON.parse(opts.body);
      sends.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, ts: "999.1" }), { status: 200 });
    }
    return realFetch(url, opts);
  };
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 250));

test("url_verification handshake echoes the challenge through the real route", async () => {
  const raw = JSON.stringify({ type: "url_verification", challenge: "chal-xyz" });
  const res = await postRaw(raw);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /chal-xyz/);
});

test("a tampered body is refused with 403 and starts no turn", async () => {
  const raw = JSON.stringify({ type: "event_callback", event: { type: "message", channel: "C_T", user: "U1", text: "伪造" } });
  const headers = sign(raw);
  const res = await fetch(`${base}${WEBHOOK_PREFIX}${bot.id}/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, "x-slack-signature": headers["x-slack-signature"].slice(0, -2) + "00" },
    body: raw + " ",
  });
  assert.equal(res.status, 403);
  await tick();
  assert.equal(prompts.length, 0, "a forged request must not produce a turn");
});

test("a stale timestamp is refused with 403", async () => {
  const raw = JSON.stringify({ type: "event_callback", event: { type: "message", channel: "C_T", user: "U1", text: "旧" } });
  const res = await postRaw(raw, { ts: String(Math.floor(Date.now() / 1000) - 900) });
  assert.equal(res.status, 403);
  await tick();
  assert.equal(prompts.length, 0);
});

test("a channel-level message keys on the bare channel", async () => {
  await postEvent({ type: "message", channel: "C1", user: "U1", text: "你好", ts: "111.1" }, { eventId: "Ev-c1" });
  await tick();
  assert.equal(prompts.length, 1, "one turn");
  assert.ok(prompts[0].text.includes("你好"));
});

test("a thread reply keys on channel:root — a different room than the channel", async () => {
  const before1 = prompts.length;
  await postEvent(
    { type: "message", channel: "C1", user: "U2", text: "线程里说", thread_ts: "111.1", event_ts: "111.2" },
    { eventId: "Ev-thread" },
  );
  await tick();
  assert.equal(prompts.length, before1 + 1);
  assert.notEqual(prompts.at(-1).sessionId, prompts[0].sessionId, "thread room ≠ channel room");
});

test("bot echoes and edits start no turn", async () => {
  const n = prompts.length;
  await postEvent({ type: "message", channel: "C1", user: "U1", text: "bot 说的", bot_id: "B1", ts: "2.1" }, { eventId: "Ev-bot" });
  await postEvent({ type: "message", subtype: "message_changed", channel: "C1", hidden: true, ts: "3.1" }, { eventId: "Ev-edit" });
  await tick();
  assert.equal(prompts.length, n, "no turn from bot echo or edit");
});

test("a reply to a thread carries thread_ts on chat.postMessage", async () => {
  await postEvent(
    { type: "message", channel: "C2", user: "U3", text: "@智语 在吗", thread_ts: "222.1", event_ts: "222.2" },
    { eventId: "Ev-reply" },
  );
  await tick();
  assert.ok(sends.length > 0, "an answer was posted back");
  const last = sends.at(-1);
  assert.ok(last.url.endsWith("/chat.postMessage"), last.url);
  assert.equal(last.body.channel, "C2");
  assert.equal(last.body.thread_ts, "222.1", "threaded chatKey → thread_ts set");
  assert.ok(String(last.body.text).includes("收到"), "answer text delivered");
});

test("a channel-level reply carries no thread_ts", async () => {
  await postEvent({ type: "message", channel: "C3", user: "U4", text: "频道里问", ts: "333.1" }, { eventId: "Ev-c3" });
  await tick();
  const last = sends.at(-1);
  assert.equal(last.body.channel, "C3");
  assert.equal(last.body.thread_ts, undefined, "no thread_ts for a channel-level chatKey");
});

test("the adapter is registered so the platform tile and validation see it", async () => {
  const { BOT_TYPES, validateCredentials, getAdapter } = await import("../server/bots/adapter.js");
  assert.ok(BOT_TYPES.includes("slack"));
  assert.equal(validateCredentials("slack", { botToken: "xoxb-1" }), "Missing credentials: signingSecret");
  assert.equal(validateCredentials("slack", CRED), null);
  assert.equal(typeof getAdapter("slack").sendText, "function");
  assert.equal(slack.qr.strategy, "manual");
});
