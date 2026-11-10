// End-to-end pipeline test for the WeCom intelligent robot (wecom-bot):
// webhook → verify → parse → guards → turn → reply, against the REAL bots
// module with a stub bridge, driving synthetic signed+encrypted callbacks in
// the official envelope (reusing wecom.js's own encrypt/signature).
//
// The load-bearing assertion is the session model (add-wecom-group-chat):
//   - two DIFFERENT members @-mentioning the bot in the SAME group land on ONE
//     persistent session (the group shares its conversation);
//   - a member's private chat with the same bot lands on a DIFFERENT session;
//   - a mention-only group message starts no turn.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wecombot-pipeline-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
await import("../server/bots/wecom-bot.js");
const { encrypt, signature } = await import("../server/bots/wecom.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

const CRED = {
  corpId: "corpx",
  botId: "aibj4Kf4DjoTRASe20slbigehBK6DiSMeMl",
  token: "T0KEN",
  encodingAesKey: crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
};

let server, base, ctx, bot, secret;
const prompts = []; // { sessionId, text } — what the bridge was asked to run
const replies = []; // { url, body } — what was POSTed to response_url

const post = (msg) => {
  const plain = JSON.stringify(msg);
  const enc = encrypt(CRED.encodingAesKey, plain, CRED.corpId);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(6).toString("hex");
  const sig = signature(CRED.token, ts, nonce, enc);
  return fetch(`${base}${WEBHOOK_PREFIX}${bot.id}/${secret}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encrypt: enc }),
  });
};

const groupMsg = (userId, text) => ({
  chattype: "group",
  chatid: "wrGROUP01",
  from: { userId },
  text: { content: text },
  // The real callback carries a per-message passive-reply url; the reply POST
  // below asserts it is used.
  response_url: "https://qyapi.weixin.qq.com/cgi-bin/bot/response?chat=wrGROUP01",
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

  // Stub bridge: the assistant echoes a fixed answer; record the session id.
  ctx.dshBridge = {
    isReady: () => true,
    prompt: async (sessionId, blocks) => {
      prompts.push({ sessionId, text: blocks?.at(-1)?.text ?? "" });
      // Replays the collector's expected notification stream through the same
      // registration the real pump feeds.
      const collector = ctx.sessionCollectors.get(sessionId);
      if (collector) {
        collector({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "群答：条款没问题" }] } } } } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      }
      return "mid";
    },
  };

  const created = await db.addBot({ id: "wecombot-1", type: "wecom-bot", name: "智语·群", credentials: CRED, secret: "wb-secret" });
  bot = created;
  secret = created.secret;
  bots.initBots(ctx);

  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Intercept ONLY the passive-reply POST for the whole process — never let a
  // test send reach qyapi.weixin.qq.com for real.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://qyapi")) {
      const body = JSON.parse(opts.body);
      replies.push({ url: String(url), body });
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    }
    return realFetch(url, opts);
  };
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("two different members in the same group land on ONE shared session", async () => {
  await post(groupMsg("alice", "@智语 合同付款条款是什么"));
  await new Promise((r) => setTimeout(r, 250));
  await post(groupMsg("bob", "@智语 那违约金呢"));
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(prompts.length, 2, "both mentions produced turns");
  assert.equal(prompts[0].sessionId, prompts[1].sessionId, "one group = one session");
  assert.ok(prompts[0].text.includes("合同付款条款"), "mention stripped from the prompt");
  assert.ok(!/@/.test(prompts[1].text), "second mention stripped too");
});

test("a member's private chat lands on a DIFFERENT session than the group", async () => {
  await post({ chattype: "single", from: { userId: "alice" }, text: { content: "私聊你好" }, response_url: "https://qyapi.weixin.qq.com/cgi-bin/bot/response?chat=alice" });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(prompts.length, 3);
  assert.notEqual(prompts[2].sessionId, prompts[0].sessionId, "private chat ≠ group session");
});

test("a mention-only group message starts no turn and replies nothing", async () => {
  prompts.length = 0;
  await post(groupMsg("carol", "@智语"));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(prompts.length, 0, "@-only must not start a turn");
});

test("the reply is POSTed to the stashed response_url of the group", async () => {
  replies.length = 0;
  await post(groupMsg("alice", "@智语 再看一眼"));
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(replies.length >= 1, "a reply was sent");
  console.log("REPLIES:", JSON.stringify(replies, null, 1).slice(0, 800));
  assert.ok(replies.at(-1).url.startsWith("https://"), "went through the passive-reply url");
});

test("group chats enjoy the SAME guards as private chats — no exemption", async () => {
  // BOTS_ALLOW_TOOLS is unset in this fixture: a tool-using turn's answer is
  // withheld exactly as the spec requires (group visibility must not loosen it).
  prompts.length = 0;
  const collector = ctx.sessionCollectors;
  // Re-stub the bridge to produce a tool-using turn.
  const origPrompt = ctx.dshBridge.prompt.bind(ctx.dshBridge);
  ctx.dshBridge.prompt = async (sessionId, _blocks) => {
    const c = collector.get(sessionId);
    c({ method: "session.event", params: { sessionId, event: { type: "tool/call", data: { name: "web_search" } } } });
    c({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "带工具的回答" }] } } } } });
    c({ method: "session.status", params: { sessionId, status: "idle" } });
    return "mid";
  };
  try {
    // A fresh group id: the earlier tests already spent this chat's rate bucket.
  await post({ ...groupMsg("alice", "@智语 帮我搜一下"), chatid: "wrGUARD02", response_url: "https://qyapi.weixin.qq.com/cgi-bin/bot/response?chat=wrGUARD02" });
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    ctx.dshBridge.prompt = origPrompt;
  }
  // The tool-derived answer never went out; the platform-honest fallback did.
  const repliesToGuard = replies.filter((r) => r.url.includes("wrGUARD02"));
  assert.equal(repliesToGuard.length, 1, "one reply for the guarded turn");
  assert.match(repliesToGuard[0].body.markdown.content, /cannot answer that from this channel/);
  const leaked = replies.some((r) => r.body?.markdown?.content === "带工具的回答");
  assert.equal(leaked, false, "tool-derived answer must be withheld in groups too");
});
