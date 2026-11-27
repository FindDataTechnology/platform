// End-to-end pipeline test for the Mattermost adapter (add-mattermost-channel 4.1-4.4):
// webhook → token verify → parse → guards → turn → reply, against the REAL bots
// module with a stub bridge, driving outgoing-webhook payloads.
//
// What this pins that the adapter self-check cannot:
//   - the webhook route accepts a body carrying the right per-webhook token and
//     refuses a wrong/missing one with 403 (no content logged, no turn);
//   - a threaded reply keys its room on channel:root while a channel-level post
//     keys on its own post id — the design's load-bearing decision (D4);
//   - bot echoes (no user_id) never start a turn;
//   - sendText posts to /api/v4/posts with a bearer token and root_id for a
//     threaded chatKey;
//   - the callback is acknowledged immediately rather than held open for the
//     turn (D4: Mattermost's 30s integration timeout vs a minutes-long turn).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-pipeline-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL; // subscribe shape; the callback route still exists

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

const CRED = {
  siteUrl: "https://im.example.test",
  botToken: "mm-bot-token",
  webhookToken: "mm-webhook-token",
  botUserId: "bot-user-1",
  // Fail-closed membership: only this channel's posts reach a turn.
  allowedChannels: "C1",
};

let server, base, bot, secret;
const prompts = []; // { sessionId, text }
const sends = []; // { url, body, auth }

// The canonical outgoing-webhook payload shape (docs: integrations-guide/outgoing-webhooks).
const payload = (o = {}) => ({
  token: CRED.webhookToken,
  team_id: "T1",
  team_domain: "im",
  channel_id: "C1",
  channel_name: "alerts",
  timestamp: Date.now(),
  user_id: "user-ada",
  user_name: "ada",
  post_id: "P1",
  text: "你好",
  ...o,
});

const postHook = (body) =>
  fetch(`${base}${WEBHOOK_PREFIX}${bot.id}/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// A turn that takes measurably longer than "immediate", so the ack-time
// assertion (4.2) has something to distinguish from.
const TURN_MS = 400;
const tick = (ms = TURN_MS + 400) => new Promise((r) => setTimeout(r, ms));

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
      await new Promise((r) => setTimeout(r, TURN_MS));
      const collector = ctx.sessionCollectors.get(sessionId);
      if (collector) {
        collector({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "答：收到" }] } } } } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      }
      return "mid";
    },
  };

  const created = await db.addBot({ id: "mm-1", type: "mattermost", name: "智语·Mattermost", credentials: CRED, secret: "mm-secret" });
  bot = created;
  secret = created.secret;
  bots.initBots(ctx);

  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Never let a test send reach a real instance. The adapter builds the URL from
  // cred.siteUrl, so intercept anything headed for /api/v4/posts.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/api/v4/posts")) {
      sends.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers?.authorization });
      return new Response("{}", { status: 201 });
    }
    return realFetch(url, opts);
  };
});

after(async () => {
  // The subscribe path is live in this process (no PUBLIC_BASE_URL), and its
  // retry backoff timer keeps the event loop alive — the same shape that once
  // hung the unit suite for an hour (2026-11-09, telegram). Stop every bot
  // before closing the server, or the test file hangs after its last assertion.
  bots.stopAll();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("a correctly tokened post produces exactly one turn", async () => {
  const before1 = prompts.length;
  const res = await postHook(payload({ post_id: "A1", text: "第一句" }));
  assert.equal(res.status, 200);
  await tick();
  assert.equal(prompts.length, before1 + 1, "one turn");
  assert.ok(prompts.at(-1).text.includes("第一句"));
});

test("a wrong token is refused with 403 and starts no turn", async () => {
  const before1 = prompts.length;
  const res = await postHook(payload({ token: "wrong-token", post_id: "A2", text: "伪造" }));
  assert.equal(res.status, 403);
  await tick();
  assert.equal(prompts.length, before1, "a forged request must not produce a turn");
});

test("a missing token is refused with 403", async () => {
  const body = payload({ post_id: "A3", text: "无 token" });
  delete body.token;
  const before1 = prompts.length;
  const res = await postHook(body);
  assert.equal(res.status, 403);
  await tick();
  assert.equal(prompts.length, before1);
});

test("a bot's own post (no user_id) never starts a turn", async () => {
  const body = payload({ post_id: "A4", text: "我自己的回答" });
  delete body.user_id; // the integration's own posts carry no user
  const before1 = prompts.length;
  await postHook(body);
  await tick();
  assert.equal(prompts.length, before1, "echo must not re-enter the room");
});

test("a threaded reply keys on channel:root — a different room than the channel", async () => {
  const before1 = prompts.length;
  await postHook(payload({ post_id: "B2", root_id: "B1", text: "线程里的第二句" }));
  await tick();
  assert.equal(prompts.length, before1 + 1, "one turn");
  const threadedSession = prompts.at(-1).sessionId;

  await postHook(payload({ post_id: "B3", root_id: "B1", text: "线程里的第三句" }));
  await tick();
  // Both replies share the root's conversation…
  assert.equal(prompts.at(-1).sessionId, threadedSession, "same thread => same session");

  await postHook(payload({ post_id: "B9", text: "频道里的另一句" }));
  await tick();
  // …while a channel-level post opens its own conversation.
  assert.notEqual(prompts.at(-1).sessionId, threadedSession, "channel-level post => its own session");
});

test("the reply is delivered through /api/v4/posts with a bearer token", async () => {
  sends.length = 0;
  await postHook(payload({ post_id: "R1", root_id: "R0", text: "请回答" }));
  await tick();
  // The ack lane posts a placeholder first and then PUTs the answer over it
  // (Mattermost edits in place), so there are two calls but one visible message.
  // What this test protects is how the ANSWER is addressed and authenticated.
  const posts = sends.filter((s) => /\/api\/v4\/posts$/.test(s.url) && s.method !== "PUT");
  assert.ok(posts.length >= 1, `the answer went through /api/v4/posts (saw ${sends.map((s) => s.url).join(", ")})`);
  const first = posts[0];
  assert.equal(first.auth, `Bearer ${CRED.botToken}`);
  assert.equal(first.body.channel_id, "C1");
  assert.equal(first.body.root_id, "R0", "a threaded chatKey threads the answer");
  assert.ok(first.body.message.length > 0);
});

test("a post in an undeclared channel never starts a turn", async () => {
  const before1 = prompts.length;
  await postHook(payload({ channel_id: "C_OTHER", channel_name: "ops", post_id: "X1", text: "运维内部对话" }));
  await tick();
  assert.equal(prompts.length, before1, "an undeclared channel must not reach the room router");
});

test("the callback is acknowledged before the turn finishes (30s window is not sat on)", async () => {
  const started = Date.now();
  const res = await postHook(payload({ post_id: "T1", text: "慢回合" }));
  const ackMs = Date.now() - started;
  assert.equal(res.status, 200);
  // TURN_MS is 400ms; an inline-answer implementation would take at least that
  // long. The ack must land well before it.
  assert.ok(ackMs < TURN_MS, `ack took ${ackMs}ms — must be immediate, not after the turn`);
  await tick();
});

test("the same platformMessageId twice produces one turn (idempotency)", async () => {
  const before1 = prompts.length;
  const body = payload({ post_id: "D1", text: "重复投递" });
  await postHook(body);
  await tick();
  await postHook(body);
  await tick();
  assert.equal(prompts.length - before1, 1, "the second delivery must not start a second turn");
});
