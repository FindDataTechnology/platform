// Integration tests — zhiyu IM bridge (add-zhiyu-im-bridge).
// Run: node --test scripts/test-zhiyu-im-bridge.mjs
//
//   1.x  gateway ingest: machine auth, seat contract (stable im_ hash), room
//        router triggered, rate drop on its own bucket.
//   2.x  subscription face: filtered shape (agent rows + selected system
//        events only, no meta.im, sender display included); 401 unauthed.
//   3.x  binding face: actor's room access is truth-checked (owner 200,
//        stranger 404).
//   4.x  cell inbound: bound bot posts fine, gate-off stays legacy, unreachable
//        gateway degrades to legacy — never a vanished message.
//   5.x  cell outbound: attribution prefix, chunked long content with the
//        prefix on the first chunk, cursor advances, second poll idles.
//   6.x  management REST: 404s for strangers/non-existent bot, PUT requires a
//        proxy-verified room, DELETE clears.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { registerZhiyuImBridgeRoutes } from "../server/routes/zhiyu-im-bridge.js";
import { createZhiyuImBridge } from "../server/zhiyu-im-bridge.js";

const SECRET = "cell-secret-for-tests";

async function bootGateway({ callAgentByMember = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zyimb-gw-"));
  const calls = [];
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: { PAAS_BASE_URL: "https://platform.test" },
    secret: SECRET,
    callAgent: async (member, { text }) => {
      calls.push({ ref: member.ref, text });
      return { text: callAgentByMember[member.ref] ?? "默认回答" };
    },
    ssePollMs: 50,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const h = { "x-cloud-gateway-secret": SECRET, "x-actor-email": "owner@x", "Content-Type": "application/json" };
  const post = async (p, body, headers = h) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const get = async (p, headers = h) => {
    const r = await fetch(`${base}${p}`, { headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { srv, base, zhiyu, post, get, calls, close: () => srv.close() };
}

const waitFor = async (fn, { tries = 60, ms = 50 } = {}) => {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
};

test("1.x gateway ingest: machine auth, stable seat contract, router triggered", async () => {
  const { base, zhiyu, post, calls, close } = await bootGateway();
  // A room owned by owner@x with one agent seat.
  const owner = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "x-user": "owner@x", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  const room = (await owner("/api/zhiyu/rooms", { title: "接待间" })).room;
  zhiyu.store.memberAdd({ roomId: room.id, kind: "agent", ref: "pk:agent", display: "接待分身" });

  // Unauthenticated ingest refused.
  const unauthed = await post(`/api/zhiyu/im-bridge/rooms/${room.id}/messages`, { content: "hi" }, { ...{} , "Content-Type": "application/json" });
  assert.equal(unauthed.status, 401);

  // First group message lands as guest + its ref is sha-stable across repeats.
  const first = await post(`/api/zhiyu/im-bridge/rooms/${room.id}/messages`, {
    content: "@接待分身 你好",
    chatKey: "-100123",
    senderName: "张三",
    platform: "telegram",
    imUserId: "u-42",
  });
  assert.equal(first.status, 200);
  const ref1 = first.json.member.ref;
  assert.match(ref1, /^im_[0-9a-f]{12}$/);
  const second = await post(`/api/zhiyu/im-bridge/rooms/${room.id}/messages`, {
    content: "又见",
    chatKey: "-100123",
    senderName: "张三",
    platform: "telegram",
    imUserId: "u-42",
  });
  assert.equal(second.json.member.ref, ref1, "same IM identity keeps one seat");
  assert.equal(zhiyu.store.membersOf(room.id).filter((m) => m.kind === "guest" && m.ref === ref1).length, 1, "no duplicate guest seats");
  // Rows carry im provenance; the router fired for the agent mention.
  const rows = zhiyu.store.messagesAfter(room.id, 0, {});
  assert.ok(rows.some((m) => m.meta?.im?.chatKey === "-100123"));
  await waitFor(() => zhiyu.store.messagesAfter(room.id, 0, {}).some((m) => m.kind === "agent"));
  assert.ok(calls.length >= 1, "router dispatched the agent");
  close();
});

test("2.x subscription face: filtered, attributed, agent/system only, no meta.im echo", async () => {
  const { zhiyu, get, close } = await bootGateway();
  // Construct room then emit a mixed stream through the store directly.
  const room = zhiyu.store.roomCreate({ title: "", ownerEmail: "owner@x" });
  const agent = zhiyu.store.memberAdd({ roomId: room.id, kind: "agent", ref: "pk:agent", display: "接待分身" });
  const imGuest = zhiyu.store.memberAdd({ roomId: room.id, kind: "guest", ref: "im_hash1", display: "张三", historyGrant: "join_from" });
  zhiyu.store.messageAppend({ roomId: room.id, kind: "human", senderMemberId: imGuest.id, content: "IM 原话", meta: { im: { platform: "telegram", chatKey: "-1", senderName: "张三" } } });
  zhiyu.store.messageAppend({ roomId: room.id, kind: "agent", senderMemberId: agent.id, content: "副驾回答" });
  zhiyu.store.messageAppend({ roomId: room.id, kind: "system", content: "", meta: { event: "room_ended", reason: "idle" } });
  zhiyu.store.messageAppend({ roomId: room.id, kind: "system", content: "", meta: { event: "member_joined", member: { id: "x" } } });

  // Boot an HTTP face around it via the same app (the im-bridge register is already mounted by registerZhiyuRoutes in bootGateway).
  const rx = await get(`/api/zhiyu/im-bridge/rooms/${room.id}/events`, {
    "x-cloud-gateway-secret": SECRET,
    "x-actor-email": "owner@x",
  });
  assert.equal(rx.status, 200);
  const kinds = rx.json.rows.map((r) => `${r.kind}:${r.content || r.meta?.event}`);
  assert.ok(!kinds.some((k) => k.includes("IM 原话")), "meta.im rows excluded");
  assert.ok(rx.json.rows.some((r) => r.kind === "agent" && r.sender?.display === "接待分身"), "agent rows carry sender display");
  assert.ok(rx.json.rows.some((r) => r.kind === "system" && r.meta?.event === "room_ended"));
  assert.ok(!rx.json.rows.some((r) => r.meta?.event === "member_joined"), "unlisted system events stay out");
  // Unauthenticated access refused.
  const bad = await get(`/api/zhiyu/im-bridge/rooms/${room.id}/events`, { "Content-Type": "application/json" });
  assert.equal(bad.status, 401);
  close();
});

test("3.x binding face: actor's room access is truth-checked", async () => {
  const { zhiyu, get, close } = await bootGateway();
  const room = zhiyu.store.roomCreate({ title: "", ownerEmail: "alice@x" });
  zhiyu.store.memberAdd({ roomId: room.id, kind: "user", ref: "alice@x", invitedBy: "alice@x" });
  const okay = await get(`/api/zhiyu/im-bridge/rooms/${room.id}`, { "x-cloud-gateway-secret": SECRET, "x-actor-email": "alice@x" });
  assert.equal(okay.status, 200);
  const nope = await get(`/api/zhiyu/im-bridge/rooms/${room.id}`, { "x-cloud-gateway-secret": SECRET, "x-actor-email": "mallory@x" });
  assert.equal(nope.status, 404);
  close();
});

test("4.x cell inbound: bound posts, gate-off legacy, unreachable degrades properly", async () => {
  const fetches = [];
  const mkDb = () => ({
    listBots: () => [],
  });
  const env = { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://unreachable.test" };
  const bridgeA = createZhiyuImBridge({
    db: mkDb(),
    env: { ...env, CELL_GATEWAY_SECRET: SECRET },
    fetchImpl: async (url, init) => {
      fetches.push({ url: String(url), init });
      return new Response(JSON.stringify({ seq: 5 }), { status: 200 });
    },
  });
  const bot = { id: "b1", name: "代销", ownerEmail: "alice@x", zhiRoomId: "zy_abc", enabled: true };
  assert.equal(await bridgeA.handleInbound({ bot, chatKey: "-1", senderName: "张三", text: "你好" }), true);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].init.headers["x-actor-email"], "alice@x");
  assert.equal(fetches[0].init.headers["x-cloud-gateway-secret"], SECRET);
  const body = JSON.parse(fetches[0].init.body);
  assert.equal(body.imUserId, "张三", "senderName is the identity fallback");

  // Gate off → decline → legacy gets it.
  const bridgeB = createZhiyuImBridge({ db: mkDb(), env: { ...env, ZHIYU_IM_BRIDGE_ON: "0", CELL_GATEWAY_SECRET: SECRET }, fetchImpl: async () => new Response("{}", { status: 200 }) });
  assert.equal(await bridgeB.handleInbound({ bot, chatKey: "-1", senderName: "张三", text: "hi" }), false);
  // Unreachable gateway → degrade (false), never swallow.
  const bridgeC = createZhiyuImBridge({ db: mkDb(), env: { ...env, CELL_GATEWAY_SECRET: SECRET }, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await bridgeC.handleInbound({ bot, chatKey: "-1", senderName: "张三", text: "hi" }), false);

  // A bot row whose owner_email is NULL must still carry a REAL actor: the
  // gateway answers "machine credential required" to an empty x-actor-email,
  // and the cell's own user (CELL_USER_EMAIL) owns the bot's cell. Prod
  // evidence: every bridged message got 401 and silently degraded to legacy.
  const legacyBot = { id: "b2", name: "旧行", ownerEmail: null, zhiRoomId: "zy_abc", enabled: true };
  const bridgeD = createZhiyuImBridge({
    db: mkDb(),
    env: { ...env, CELL_USER_EMAIL: "owner@x" },
    fetchImpl: async (url, init) => {
      fetches.push({ url: String(url), init });
      return new Response(JSON.stringify({ seq: 6 }), { status: 200 });
    },
  });
  assert.equal(await bridgeD.handleInbound({ bot: legacyBot, chatKey: "-1", senderName: "张三", text: "hi" }), true);
  assert.equal(fetches.at(-1).init.headers["x-actor-email"], "owner@x", "empty owner_email falls back to the cell's user");

  // No owner anywhere → the actor stays empty and the gateway decides; the
  // bridge must not invent an identity of its own.
  const bridgeE = createZhiyuImBridge({
    db: mkDb(),
    env: { ...env, CELL_USER_EMAIL: "" },
    fetchImpl: async (url, init) => {
      fetches.push({ url: String(url), init });
      return new Response(JSON.stringify({ seq: 7 }), { status: 200 });
    },
  });
  assert.equal(await bridgeE.handleInbound({ bot: { ...legacyBot, ownerEmail: "" }, chatKey: "-1", senderName: "张三", text: "hi" }), true);
  assert.equal(fetches.at(-1).init.headers["x-actor-email"], "");
});

test("5.x cell outbound: attribution prefix, chunked long answer, cursor advance", async () => {
  const sends = [];
  const cursorWrites = [];
  const longAnswer = "回".repeat(4200);
  const eventRows = {
    rows: [
      { seq: 11, kind: "agent", content: "短答你好", sender: { display: "接待分身", kind: "facade", onBehalfOf: "alice@x" } },
      { seq: 12, kind: "agent", content: longAnswer, sender: { display: "接待分身", kind: "agent", onBehalfOf: null } },
    ],
  };
  let calls = 0;
  const db = {
    setBotBridgeCursor: (_botId, seq) => { cursorWrites.push(seq); return true; },
  };
  const adapter = {
    sendText: async (_credentials, chatKey, text) => {
      sends.push({ chatKey, text });
    },
  };
  const bridge = createZhiyuImBridge({
    db,
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    fetchImpl: async (_url) => {
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? eventRows : { rows: [] }), { status: 200 });
    },
    adapterForBotFn: () => adapter,
  });
  const bot = { id: "b1", name: "代销", credentials: {}, type: "telegram", ownerEmail: "alice@x", zhiRoomId: "zy_abc", enabled: true, zhiBridgeCursor: 0 };
  bridge.noteInboundChat(bot.id, "-100123");
  await bridge.tickBot(bot);
  // First row: prefix on the (single-chunk) first chunk, agent tie.
  assert.equal(sends[0].text, "接待分身(代 alice@x 出席): 短答你好", "attribution prefix precedes facade content");
  // Long one: multiple chunks, prefix only on the FIRST of its chunks.
  const seq2Parts = sends.slice(1);
  assert.ok(seq2Parts.length >= 2, "long answer split into chunks");
  assert.ok(seq2Parts[0].text.startsWith("接待分身: "), "prefix rides the first chunk only");
  assert.ok(!seq2Parts.slice(1).some((c) => c.text.includes("接待分身: ")), "later chunks carry no duplication");
  assert.ok(cursorWrites.some((s) => s === 12), "cursor advanced to the last row");
  const before = sends.length;
  await bridge.tickBot(bot);
  assert.equal(sends.length, before, "second poll idles: no duplicates");
});

test("5.z cell outbound: a permanently failing send is retried thrice, then skipped so the stream resumes", async () => {
  // Prod evidence: the test bot's WeChat credential was revoked (40003 invalid
  // openid), so the same answer was re-attempted every 2.5s forever and the
  // cursor stayed pinned — blocking every later answer behind it.
  const attempts = [];
  const cursorWrites = [];
  const logs = [];
  const bot = { id: "b1", name: "代销", credentials: {}, type: "wechat-oa", ownerEmail: "alice@x", zhiRoomId: "zy_abc", enabled: true, zhiBridgeCursor: 0 };
  const bridge = createZhiyuImBridge({
    // Production reads the row fresh from the DB on every tick (startOutbounds
    // → listBots), so a cursor write is visible to the next poll. Mirror that.
    db: { setBotBridgeCursor: (_botId, seq) => { cursorWrites.push(seq); bot.zhiBridgeCursor = seq; return true; } },
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    log: { warn: (m) => logs.push(String(m)), info: () => {}, error: () => {} },
    fetchImpl: async (url) => {
      const after = Number(new URL(String(url)).searchParams.get("after") ?? 0) || 0;
      const rows = 7 > after ? [{ seq: 7, kind: "agent", content: "答", sender: { display: "分身", kind: "agent", onBehalfOf: null } }] : [];
      return new Response(JSON.stringify({ rows }), { status: 200 });
    },
    adapterForBotFn: () => ({ sendText: async () => { attempts.push(1); throw new Error("40003 invalid openid"); } }),
  });
  bridge.noteInboundChat(bot.id, "wxid_1");
  await bridge.tickBot(bot); // attempt 1 → retry, cursor held
  await bridge.tickBot(bot); // attempt 2 → retry, cursor held
  assert.equal(attempts.length, 2);
  assert.ok(!cursorWrites.includes(7), "the failing row is not skipped while inside the retry budget");
  await bridge.tickBot(bot); // attempt 3 → give up on that row, cursor advances
  assert.equal(attempts.length, 3);
  assert.ok(cursorWrites.includes(7), "after three failures the row is skipped so later answers are not blocked");
  assert.ok(logs.some((l) => l.includes("SKIPPING")), "the skip is logged loudly, not silent");
  await bridge.tickBot(bot); // cursor now past that row: no further attempts, no re-send
  assert.equal(attempts.length, 3, "the skipped answer is not re-attempted forever (stream unblocked)");
});

test("5.y cell outbound: a rejected poll drains the error body and keeps the actor real", async () => {
  const logs = [];
  const heads = [];
  const bridge = createZhiyuImBridge({
    db: { setBotBridgeCursor: () => true },
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999, CELL_USER_EMAIL: "owner@x" },
    log: { warn: (m) => logs.push(String(m)), info: () => {}, error: () => {} },
    fetchImpl: async (_url, init) => {
      heads.push(init?.headers);
      return new Response(JSON.stringify({ error: "machine credential required" }), { status: 401 });
    },
    adapterForBotFn: () => ({ sendText: async () => {} }),
  });
  const bot = { id: "b1", name: "代销", credentials: {}, type: "telegram", ownerEmail: null, zhiRoomId: "zy_abc", enabled: true, zhiBridgeCursor: 0 };
  bridge.noteInboundChat(bot.id, "-100123");
  await bridge.tickBot(bot);
  assert.equal(heads[0]["x-actor-email"], "owner@x", "events lane uses the same resolved actor");
  assert.ok(logs.some((l) => l.includes("401")), "the rejection is logged with its status, not swallowed");
  assert.ok(logs.some((l) => l.includes("machine credential required")), "the error body is drained and reported");
});

test("6.x-b binding liveness is TRI-state: live / dead / unknown, never a guess", async () => {
  // A binding outlives its room (production: the room row was deleted straight
  // out of sqlite), and the panel drew it exactly like a healthy one while every
  // group message fell back to the legacy path. The status face must SAY so —
  // and must never turn "we could not reach the gateway" into "失效": prompting
  // an operator to unbind a bot that is fine is the worse failure.
  const express = (await import("express")).default;
  const bots = new Map([["b1", { id: "b1", name: "智语·群", ownerEmail: "alice@x", zhiRoomId: "zy_live", enabled: true }]]);
  const originalFetch = globalThis.fetch;

  const boot = async (respond) => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : undefined;
      next();
    });
    globalThis.fetch = async (url, init) => {
      if (/\/api\/zhiyu\/im-bridge\/rooms\//.test(String(url))) return respond(String(url), init);
      return originalFetch(url, init);
    };
    registerZhiyuImBridgeRoutes({
      app,
      db: { getBot: (id) => bots.get(id) ?? null, updateBot: () => null },
      authEnabled: false,
    });
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    return {
      read: async () => {
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/zhiyu-im-bridge/bots/b1/room`, { headers: { "x-user": "alice@x" } });
        return (await r.json()).roomLive;
      },
      close: () => srv.close(),
    };
  };

  try {
    const live = await boot(async () => new Response(JSON.stringify({ id: "zy_live" }), { status: 200 }));
    assert.equal(await live.read(), true, "the gateway has the room ⇒ live");
    live.close();

    const dead = await boot(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    assert.equal(await dead.read(), false, "the gateway 404s the room ⇒ stale binding");
    dead.close();

    const broken = await boot(async () => { throw new Error("ECONNREFUSED"); });
    assert.equal(await broken.read(), "unknown", "unreachable gateway is UNKNOWN, never a false 失效");
    broken.close();

    const serverErr = await boot(async () => new Response("boom", { status: 503 }));
    assert.equal(await serverErr.read(), "unknown", "a 5xx is no evidence about the room either");
    serverErr.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("6.x-c a stale binding leaves a greppable tag; other failures do not", async () => {
  // The degradation itself is silent by design (legacy path continues), so the
  // only trace an operator has is the log. A reworded warn is unfalsifiable
  // later; a stable tag can be asserted here and alerted on in prod.
  const mk = async (status) => {
    const logs = [];
    const bridge = createZhiyuImBridge({
      db: { listBotChats: () => [] },
      log: { warn: (m) => logs.push(String(m)), info: () => {}, error: () => {} },
      fetchImpl: async () => new Response(status === 404 ? '{"error":"not found"}' : "boom", { status }),
      adapterForBotFn: () => ({ sendText: async () => {} }),
      env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: "s" },
    });
    const bot = { id: "b9", name: "智语·WeCom", credentials: {}, type: "wecom", zhiRoomId: "zy_gone", enabled: true, zhiBridgeCursor: 0 };
    const bridged = await bridge.handleInbound({ bot, chatKey: "k", senderName: "甲", text: "在吗" });
    return { bridged, logs };
  };
  const stale = await mk(404);
  assert.equal(stale.bridged, false, "a stale binding still falls back (messages must not vanish)");
  assert.ok(stale.logs.some((l) => l.includes("[zhiyu-im-bridge][binding-stale]")), "404 ⇒ the stable tag");
  assert.ok(stale.logs.some((l) => l.includes("b9") && l.includes("zy_gone")), "…carrying bot id and room id");

  const other = await mk(503);
  assert.equal(other.bridged, false);
  assert.equal(other.logs.some((l) => l.includes("[binding-stale]")), false, "a 5xx is not a stale binding");
});

test("6.x management REST: 404-shapes, PUT validates room through gateway, DELETE clears", async () => {
  const express = (await import("express")).default;
  const app = express();
  const bots = new Map();
  const bot = { id: "b1", name: "代销", ownerEmail: "alice@x", zhiRoomId: null, enabled: true };
  bots.set(bot.id, bot);
  const gatewayCalls = [];
  app.use((req, _res, next) => {
    req.user = req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : undefined;
    next();
  });
  const ctx = {
    app,
    db: {
      getBot: (id) => bots.get(id) ?? null,
      updateBot: (id, patch) => { Object.assign(bots.get(id), patch); return bots.get(id); },
    },
    authEnabled: false,
  };
  const originalFetch = globalThis.fetch;
  const gatewayUrlPattern = /\/api\/zhiyu\/im-bridge\/rooms\//;
  globalThis.fetch = async (url, init) => {
    if (!gatewayUrlPattern.test(String(url))) return originalFetch(url, init);
    gatewayCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "zy_abc", title: "接待间", status: "active" }), { status: 200 });
  };
  registerZhiyuImBridgeRoutes(ctx);
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const b = `http://127.0.0.1:${srv.address().port}`;
  // authEnabled=false ⇒ cell owner's session cookie-free local posture; x-user passes through.
  const h = { "x-user": "alice@x", "Content-Type": "application/json" };
  const unknown = await fetch(`${b}/api/zhiyu-im-bridge/bots/ghost/room`, { headers: h });
  assert.equal(unknown.status, 404);
  const miss = await fetch(`${b}/api/zhiyu-im-bridge/bots/${bot.id}/room`, { method: "PUT", headers: h, body: JSON.stringify({ zhiRoomId: "zy_abc" }) });
  assert.equal(miss.status, 200);
  assert.equal(bots.get("b1").zhiRoomId, "zy_abc");
  // Malformed target refused without touching the gateway.
  const before = gatewayCalls.length;
  const bad = await fetch(`${b}/api/zhiyu-im-bridge/bots/${bot.id}/room`, { method: "PUT", headers: h, body: JSON.stringify({ zhiRoomId: "not-a-room" }) });
  assert.equal(bad.status, 400);
  assert.equal(gatewayCalls.length, before, "no gateway call on shape violation");
  const del = await fetch(`${b}/api/zhiyu-im-bridge/bots/${bot.id}/room`, { method: "DELETE", headers: h });
  assert.equal(del.status, 200);
  assert.equal(bots.get("b1").zhiRoomId, null);
  globalThis.fetch = originalFetch;
  srv.close();
});

test("5.x-b delivery-failed: the gateway lands a shared system event; cell POSTs it after retries exhaust (Req5)", async () => {
  // Gateway leg: machine cred + rate bucket + shared-row shape.
  const { srv, base, zhiyu } = await bootGateway({});
  const roomId = zhiyu.store.roomCreate({ title: "df", ownerEmail: "owner@x" }).id;
  const noAuth = await fetch(`${base}/api/zhiyu/im-bridge/rooms/${roomId}/delivery-failed`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x" }),
  });
  assert.equal(noAuth.status, 401);
  const ok = await fetch(`${base}/api/zhiyu/im-bridge/rooms/${roomId}/delivery-failed`, {
    method: "POST",
    headers: { "x-cloud-gateway-secret": SECRET, "x-actor-email": "alice@x", "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "wechat-oa", chatKey: "wxid_1", seq: 7, reason: "40003 invalid openid" }),
  });
  assert.equal(ok.status, 200);
  const rows = zhiyu.store.messagesAfter(roomId, 0, { viewerMemberId: null });
  const ev = rows.find((m) => m.meta?.event === "im_delivery_failed");
  assert.ok(ev, "the delivery failure lands as a room event row");
  assert.equal(ev.visibility, "shared", "the room sees the failure on the shared stream");
  assert.equal(ev.meta.platform, "wechat-oa");
  assert.equal(ev.meta.seq, 7);
  assert.ok(String(ev.meta.reason).includes("40003"));

  // The row's CONTENT is what a member/visitor reads: an actionable sentence,
  // never the raw provider error (which carries egress IPs and vendor codes).
  assert.ok(String(ev.content).trim().length > 0, "the row carries its own human sentence");
  assert.ok(String(ev.content).includes("IM"), "the sentence names where the answer was going");
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(String(ev.content)), "no internal address in the readable text");
  assert.ok(!String(ev.content).includes("40003"), "no raw vendor code in the readable text");

  // Same cause + same chat within the dedupe window ⇒ acknowledged, not repeated.
  const again = await fetch(`${base}/api/zhiyu/im-bridge/rooms/${roomId}/delivery-failed`, {
    method: "POST",
    headers: { "x-cloud-gateway-secret": SECRET, "x-actor-email": "alice@x", "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "wechat-oa", chatKey: "wxid_1", seq: 8, reason: "40003 invalid openid" }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).deduped, true, "a repeat of the same cause is deduped");
  assert.equal(
    zhiyu.store.messagesAfter(roomId, 0, { viewerMemberId: null }).filter((m) => m.meta?.event === "im_delivery_failed").length,
    1,
    "exactly one row for the same cause",
  );

  // A DIFFERENT cause is a different fact and must surface immediately.
  const other = await fetch(`${base}/api/zhiyu/im-bridge/rooms/${roomId}/delivery-failed`, {
    method: "POST",
    headers: { "x-cloud-gateway-secret": SECRET, "x-actor-email": "alice@x", "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "wechat-oa", chatKey: "wxid_1", seq: 9, reason: "45009 api freq out of limit" }),
  });
  assert.equal(other.status, 200);
  assert.equal(
    zhiyu.store.messagesAfter(roomId, 0, { viewerMemberId: null }).filter((m) => m.meta?.event === "im_delivery_failed").length,
    2,
    "a new cause lands its own row",
  );
  srv.close();

  // Cell leg: after the third failed attempt the bridge POSTs the event (best-effort).
  const posts = [];
  const cursorWrites = [];
  const bot = { id: "b9", name: "代销", credentials: {}, type: "wechat-oa", ownerEmail: "alice@x", zhiRoomId: "zy_abc", enabled: true, zhiBridgeCursor: 0 };
  const bridge = createZhiyuImBridge({
    db: { setBotBridgeCursor: (_id, seq) => { cursorWrites.push(seq); bot.zhiBridgeCursor = seq; return true; } },
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/delivery-failed")) {
        posts.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ seq: 99 }), { status: 200 });
      }
      return new Response(JSON.stringify({ rows: [{ seq: 7, kind: "agent", content: "答", sender: { display: "分身", kind: "agent", onBehalfOf: null } }] }), { status: 200 });
    },
    adapterForBotFn: () => ({ sendText: async () => { throw new Error("40003 invalid openid"); } }),
  });
  bridge.noteInboundChat(bot.id, "wxid_1");
  await bridge.tickBot(bot);
  await bridge.tickBot(bot);
  await bridge.tickBot(bot); // third attempt → skip + surface
  assert.equal(posts.length, 1, "the failure event is POSTed to the gateway exactly once");
  assert.ok(posts[0].url.includes(`/rooms/${bot.zhiRoomId}/delivery-failed`));
  assert.equal(posts[0].body.seq, 7);
  assert.equal(posts[0].body.platform, "wechat-oa");
  assert.ok(String(posts[0].headers["x-actor-email"]).length > 0, "machine actor rides the POST");
});

test("5.x-c same-cause failures coalesce; a changed cause surfaces at once (Req5, 11-18)", async () => {
  // Production context: a WeCom egress-IP misconfiguration made EVERY answer
  // fail with the same cause, and the room got 19 rows carrying the internal IP.
  // The room needs the cause once; a different cause is a different fact.
  const posts = [];
  let seqNo = 10;
  let failure = new Error("wecom send failed: 60020 not allow to access from your ip, hint: [1794988131], from ip: 198.51.100.7"); // TEST-NET-2, never a real host
  const bot = { id: "bC", name: "群桥", credentials: {}, type: "wecom", ownerEmail: "alice@x", zhiRoomId: "zy_c", enabled: true, zhiBridgeCursor: 0 };
  const bridge = createZhiyuImBridge({
    db: { setBotBridgeCursor: (_id, seq) => { bot.zhiBridgeCursor = seq; return true; } },
    env: {
      ZHIYU_IM_BRIDGE_ON: "1",
      CELL_GATEWAY_SECRET: SECRET,
      GATEWAY_INTERNAL_URL: "http://gw.local",
      ZHIYU_IM_BRIDGE_POLL_MS: 999_999,
      ZHIYU_IM_FAIL_COALESCE_MS: "600000", // long window: every repeat must be suppressed
    },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/delivery-failed")) {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ seq: 99 }), { status: 200 });
      }
      // The failed row STAYS queued (its seq remains above the cursor) until the
      // bridge gives up on it — that is what makes the 3-attempt path reachable.
      if (bot.zhiBridgeCursor >= seqNo) seqNo += 1;
      return new Response(
        JSON.stringify({ rows: [{ seq: seqNo, kind: "agent", content: "答", sender: { display: "分身", kind: "agent", onBehalfOf: null } }] }),
        { status: 200 },
      );
    },
    adapterForBotFn: () => ({ sendText: async () => { throw failure; } }),
  });
  bridge.noteInboundChat(bot.id, "chat-1");
  const exhaustOneRow = async () => { await bridge.tickBot(bot); await bridge.tickBot(bot); await bridge.tickBot(bot); };

  await exhaustOneRow(); // seq 10 → surface #1
  await exhaustOneRow(); // seq 11, same cause → suppressed
  await exhaustOneRow(); // seq 12, same cause → suppressed
  assert.equal(posts.length, 1, "repeats of the same cause are coalesced");
  assert.ok(!/\d{1,3}(\.\d{1,3}){3}/.test(posts[0].reason), "the surfaced reason carries no internal address");
  assert.ok(!/hint: \[/.test(posts[0].reason), "vendor hint tokens are stripped");

  failure = new Error("wecom send failed: 40001 invalid credential");
  await exhaustOneRow(); // seq 13, NEW cause → surfaces immediately
  assert.equal(posts.length, 2, "a changed cause surfaces immediately");
  assert.ok(posts[1].reason.includes("40001"), "the new cause is described");
});

test("6.y binding face answers outbound capability, not just room liveness (1.2)", async () => {
  // 2026-11-18: a bound bot with a live room delivered 19 answers nowhere and the
  // panel said "bound, room alive". The face now answers the OTHER question too.
  const express = (await import("express")).default;
  const app = express();
  const bots = new Map([
    ["w1", { id: "w1", name: "自建应用", ownerEmail: "alice@x", enabled: true, type: "wecom", zhiRoomId: "zy_abc", credentials: {} }],
    ["g1", { id: "g1", name: "智能机器人", ownerEmail: "alice@x", enabled: true, type: "wecom-bot", zhiRoomId: "zy_abc", credentials: {} }],
    ["x1", { id: "x1", name: "未知类型", ownerEmail: "alice@x", enabled: true, type: "whatever", zhiRoomId: "zy_abc", credentials: {} }],
  ]);
  app.use((req, _res, next) => {
    req.user = req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : undefined;
    next();
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!/\/api\/zhiyu\/im-bridge\/rooms\//.test(String(url))) return originalFetch(url, init);
    return new Response(JSON.stringify({ id: "zy_abc", title: "t", status: "active" }), { status: 200 });
  };
  registerZhiyuImBridgeRoutes({
    app,
    db: {
      getBot: (id) => bots.get(id) ?? null,
      listBotChats: () => [],
      updateBot: () => null,
    },
    authEnabled: false,
  });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  const h = { "x-user": "alice@x" };

  const wecom = await (await fetch(`${b}/api/zhiyu-im-bridge/bots/w1/room`, { headers: h })).json();
  assert.equal(wecom.roomLive, true, "the room is alive");
  assert.equal(wecom.outbound.mode, "proactive-ip-gated");
  assert.equal(wecom.outbound.detail, "egress-must-be-allowlisted");
  assert.equal(wecom.outbound.canSendNow, true, "it CAN send — from an allowlisted egress");

  const grp = await (await fetch(`${b}/api/zhiyu-im-bridge/bots/g1/room`, { headers: h })).json();
  assert.equal(grp.outbound.mode, "passive-window");
  assert.equal(grp.outbound.canSendNow, false, "no inbound has opened a reply window");
  assert.equal(grp.outbound.detail, "reply-window-closed");
  assert.equal(grp.roomLive, true, "room alive and undeliverable are two separate facts");

  const unknown = await (await fetch(`${b}/api/zhiyu-im-bridge/bots/x1/room`, { headers: h })).json();
  assert.equal(unknown.outbound.mode, "none");
  assert.equal(unknown.outbound.canSendNow, false);

  globalThis.fetch = originalFetch;
  srv.close();
});

test("7.x a bot binds a TEAM ACCOUNT: gateway face, mutual exclusivity, inbound lane", async () => {
  const express = (await import("express")).default;
  const { registerZhiyuImBridgeRoutes } = await import("../server/routes/zhiyu-im-bridge.js");

  // ── gateway half: account face + account inbound lane ────────────────────
  const gw = await bootGateway();
  const zhiyu = gw.zhiyu;
  // Seed an account owned by owner@x (the machine actor the test client uses).
  const account = zhiyu.store.teamAccountCreate({ fleetId: "f1", fleetName: "客服团", ownerEmail: "owner@x" });

  const face = await gw.get(`/api/zhiyu/im-bridge/team-accounts/${account.id}`);
  assert.equal(face.status, 200);
  assert.equal(face.json.fleetName, "客服团");
  // A stranger (different actor email) is 404, identical to a missing account.
  const strangerFace = await gw.get(`/api/zhiyu/im-bridge/team-accounts/${account.id}`, {
    "x-cloud-gateway-secret": SECRET, "x-actor-email": "other@x", "Content-Type": "application/json",
  });
  assert.equal(strangerFace.status, 404);
  const missingFace = await gw.get(`/api/zhiyu/im-bridge/team-accounts/fd_deadbeef`);
  assert.equal(missingFace.status, 404);
  assert.equal(JSON.stringify(strangerFace.json), JSON.stringify(missingFace.json), "no oracle");

  // Inbound lane: one group = one room, reused across messages.
  const ingest = async (chatKey, who) =>
    gw.post(`/api/zhiyu/im-bridge/team-accounts/${account.id}/messages`, {
      content: `@客服团 你好 ${who}`, chatKey, senderName: who, platform: "slack", imUserId: `u-${who}`,
    });
  const m1 = await ingest("C1:111.1", "alice");
  const m2 = await ingest("C1:111.1", "bob");
  assert.equal(m1.status, 200);
  assert.equal(m2.json.roomId, m1.json.roomId, "the same group chat stays in one room");
  const m3 = await ingest("C2", "carol");
  assert.notEqual(m3.json.roomId, m1.json.roomId, "a different chat opens its own room");
  // Guests carry stable per-sender seats inside that room.
  assert.notEqual(m1.json.member.ref, m2.json.member.ref, "different senders, different seats");
  const roomsOfAcc = zhiyu.store.roomsOfAccount(account.id);
  assert.equal(roomsOfAcc.length, 2, "two chats → two rooms under the account");

  // A revoked account refuses ingest exactly like an unknown one.
  zhiyu.store.teamAccountRevoke(account.id);
  const afterRevoke = await ingest("C1:111.1", "alice");
  assert.equal(afterRevoke.status, 404);
  gw.close();

  // ── cell half: binding REST enforces mutual exclusivity ──────────────────
  const app = express();
  const bots = new Map([["b1", { id: "b1", name: "群桥", ownerEmail: "alice@x", zhiRoomId: null, zhiAccountId: null, enabled: true }]]);
  app.use((req, _res, next) => { req.user = req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : undefined; next(); });
  registerZhiyuImBridgeRoutes({
    app,
    db: {
      getBot: (id) => bots.get(id) ?? null,
      updateBot: (id, patch) => { Object.assign(bots.get(id), patch); return bots.get(id); },
      listBotChats: () => [],
    },
    authEnabled: false,
  });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  const put = async (body) => {
    const r = await fetch(`${b}/api/zhiyu-im-bridge/bots/b1/room`, {
      method: "PUT", headers: { "x-user": "alice@x", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // Both targets at once is a client error, never "last one wins".
  const both = await put({ zhiRoomId: "zy_abc123", zhiAccountId: "fd_abc123" });
  assert.equal(both.status, 400);
  assert.match(both.json.error, /not both/);

  // A malformed account id is refused before any network call.
  const badShape = await put({ zhiAccountId: "not-an-account" });
  assert.equal(badShape.status, 400);

  srv.close();
});

test("5.x-d failure CLASS drives the wording, and it is not a prose match (4.1)", async () => {
  // Two crippling causes, two different fixes. If they shared one sentence the
  // reader would land on the wrong settings page half the time.
  const seen = [];
  const bot = { id: "bK", name: "群桥", credentials: {}, type: "wecom", ownerEmail: "alice@x", zhiRoomId: "zy_k", enabled: true, zhiBridgeCursor: 0 };
  let seqNo = 10;
  let failure = new Error("wecom send failed: 60020 not allow to access from your ip");
  const bridge = createZhiyuImBridge({
    db: { setBotBridgeCursor: (_id, s) => { bot.zhiBridgeCursor = s; return true; }, getBot: () => null },
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/delivery-failed")) {
        seen.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ seq: 1 }), { status: 200 });
      }
      if (bot.zhiBridgeCursor >= seqNo) seqNo += 1;
      return new Response(JSON.stringify({ rows: [{ seq: seqNo, kind: "agent", content: "答", sender: { display: "x", kind: "agent", onBehalfOf: null } }] }), { status: 200 });
    },
    adapterForBotFn: () => ({ sendText: async () => { throw failure; } }),
  });
  bridge.noteInboundChat(bot.id, "chat-k");
  const exhaust = async () => { await bridge.tickBot(bot); await bridge.tickBot(bot); await bridge.tickBot(bot); };

  await exhaust();
  assert.equal(seen[0].cause, "ip-not-allowed");
  assert.match(seen[0].reason, /出口/);

  // Same code, vendor sentence reworded entirely: the class must not change.
  // This is what "not a prose match" buys — WeCom can reword its errmsg any day.
  failure = new Error("errcode 60020: source address is not trusted for this application");
  await exhaust();
  assert.equal(seen[seen.length - 1].cause, "ip-not-allowed", "the numeric code decides, not the sentence");

  // The other crippling cause gets its OWN wording and its own class.
  failure = new Error("wecom-bot: no live response_url for wrX (passive-reply window closed)");
  await exhaust();
  const last = seen[seen.length - 1];
  assert.equal(last.cause, "reply-window-closed");
  assert.match(last.reason, /窗口/);
  assert.notEqual(last.reason, seen[0].reason, "the two causes must not share a sentence");
});

test("5.z a cursor written from outside is never rolled back by a running tick (5.2)", async () => {
  // Observed 2026-11-18: a rebind aligned the cursor to the room tail (94) while
  // a tick was mid-flight; the tick wrote its snapshot value (57) back and the
  // room's history began replaying into the group. The guard is "never move
  // backwards", not "write what I computed".
  const writes = [];
  const bot = { id: "bM", name: "群桥", credentials: {}, type: "telegram", ownerEmail: "a@x", zhiRoomId: "zy_m", enabled: true, zhiBridgeCursor: 5 };
  const row = { zhiBridgeCursor: 5 }; // the durable row, which an outside actor can move
  const bridge = createZhiyuImBridge({
    db: {
      getBot: () => ({ ...bot, zhiBridgeCursor: row.zhiBridgeCursor }),
      setBotBridgeCursor: (_id, s) => { row.zhiBridgeCursor = s; writes.push(s); return true; },
    },
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    fetchImpl: async (url, _init = {}) => {
      if (String(url).endsWith("/delivery-failed")) return new Response("{}", { status: 200 });
      // While this tick is in flight, someone rebinds and aligns to 94.
      row.zhiBridgeCursor = 94;
      return new Response(JSON.stringify({ rows: [{ seq: 10, kind: "agent", content: "答", sender: { display: "x", kind: "agent", onBehalfOf: null } }] }), { status: 200 });
    },
    adapterForBotFn: () => ({ sendText: async () => {} }),
  });
  bridge.noteInboundChat(bot.id, "c");
  await bridge.tickBot(bot); // snapshot says 5, would write 10, but row is now 94
  assert.deepEqual(writes, [], "must not write a cursor below the row's current value");
  assert.equal(row.zhiBridgeCursor, 94, "the outside alignment stands");
});

test("6.z a round where everyone passes still says something in the group", async () => {
  // 2026-11-19: a broadcast round where both seats passed produced 32 seconds of
  // dead air in the group and then NOTHING. The room said 「本轮无人作答」; the
  // group heard a bot that might as well have been offline. Silence is not an
  // answer — and the group must never be shown the internal event NAME.
  const { srv, base, zhiyu } = await bootGateway({});
  const roomId = zhiyu.store.roomCreate({ title: "g", ownerEmail: "owner@x" }).id;
  zhiyu.store.messageAppend({
    roomId,
    kind: "event",
    content: "",
    meta: { event: "all_passed", targetCount: 2 },
  });
  zhiyu.store.messageAppend({
    roomId,
    kind: "event",
    content: "",
    meta: { event: "pass", memberId: "m1", display: "产品顾问" },
  });

  const r = await fetch(`${base}/api/zhiyu/im-bridge/rooms/${roomId}/events?after=0`, {
    headers: { "x-cloud-gateway-secret": SECRET, "x-actor-email": "alice@x" },
  });
  const { rows } = await r.json();
  const allPassed = rows.find((x) => x.meta?.event === "all_passed");
  assert.ok(allPassed, "the round-level outcome reaches the group's read face");

  // The group must never learn our internal vocabulary.
  const painted = rows.map((x) => String(x.content ?? "")).join("\n");
  assert.ok(!painted.includes("all_passed"), "never render the event name to a group");
  assert.ok(!painted.includes("pass"), "never render a bare internal event name");

  srv.close();
});

test("a row the group should not see must not pin the cursor forever (watermark)", async () => {
  // 2026-11-19 live: the room sat at seq 144 while the cursor was stuck at 138.
  // Rows 139-143 were fleet reports (not echoable) and 144 was a delivery-failure
  // event; the read face correctly hid all six, so the cell never learned their
  // seqs and every later answer would have queued behind them forever.
  const posts = [];
  const bot = { id: "w1", name: "群", credentials: {}, type: "telegram", ownerEmail: "a@x", zhiRoomId: "zy_w", enabled: true, zhiBridgeCursor: 138 };
  const bridge = createZhiyuImBridge({
    db: {
      getBot: () => ({ ...bot }),
      setBotBridgeCursor: (_id, s) => { bot.zhiBridgeCursor = s; posts.push(s); return true; },
    },
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    fetchImpl: async () =>
      new Response(JSON.stringify({ rows: [], watermark: 144 }), { status: 200 }),
    adapterForBotFn: () => ({ sendText: async () => {} }),
  });
  bridge.noteInboundChat(bot.id, "c");
  await bridge.tickBot(bot);
  assert.deepEqual(posts, [144], "the cursor advances past rows the group was never shown");
  assert.equal(bot.zhiBridgeCursor, 144);
});

test("8.x an ACCOUNT-bound bot carries answers out, using the room its inbound opened", async () => {
  // Regression for a defect found by testing Slack end to end on 2026-11-19:
  // inbound learned `zhiAccountId` and opened a room, but the outbound tick
  // only ever enumerated `zhiRoomId` — so an account-bound bot carried
  // messages IN and never carried answers OUT. The room filled up while the
  // group stayed silent.
  const sends = [];
  const fetched = [];
  const key = "C038:111.1";
  const adapter = { sendText: async (_c, chatKey, text) => sends.push({ chatKey, text }) };
  const db = { setBotBridgeCursor: () => true, listBotChats: () => [] };

  let _inboundRoom = null;  // 保留占位：这组用例暂未用到（lint 放行）
  const bridge = createZhiyuImBridge({
    db,
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    fetchImpl: async (url, _opts = {}) => {
      fetched.push(String(url));
      // Order matters: the events URL also contains "/rooms/", so test the
      // inbound lane FIRST or the mock answers the wrong shape.
      if (!String(url).includes("/events") && String(url).includes("/team-accounts/")) {
        // The gateway opened a room for this chat and says which one.
        return new Response(JSON.stringify({ seq: 1, roomId: "zy_from_account", member: { ref: "im_x", display: "甲" } }), { status: 200 });
      }
      if (String(url).includes("/events")) {
        return new Response(JSON.stringify({ rows: [{ seq: 1, kind: "agent", content: "在的。", sender: { display: "产品顾问", kind: "agent" } }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
    adapterForBotFn: () => adapter,
  });

  const bot = { id: "b9", name: "智语·Slack", credentials: {}, type: "slack", ownerEmail: "alice@x", zhiAccountId: "fd_abc", zhiRoomId: null, enabled: true, zhiBridgeCursor: 0 };

  // Production calls this from bots.js before every inbound; it is what gives
  // the outbound tick a destination chat.
  bridge.noteInboundChat(bot.id, key);

  // 1) Inbound learns the room.
  const bridged = await bridge.handleInbound({ bot, chatKey: key, senderName: "甲", text: "在吗" });
  assert.equal(bridged, true, "inbound accepted");

  // 2) Outbound must use THAT room — not the (absent) row room id.
  await bridge.tickBot(bot);
  assert.ok(fetched.some((u) => u.includes("/rooms/zy_from_account/events")), `outbound polls the account's room; fetched=${JSON.stringify(fetched)}`);
  assert.equal(sends.length, 1, "the answer was delivered back to the group");
  assert.equal(sends[0].chatKey, key, "delivered to the chat the inbound came from");
});

test("8.y startOutbounds enumerates account-bound bots too", async () => {
  // The tick loop's own filter is the other half of the same defect.
  const seen = [];
  const db = {
    listBots: () => [
      { id: "room-bot", name: "房绑", type: "slack", credentials: {}, zhiRoomId: "zy_a", zhiAccountId: null, enabled: true },
      { id: "acct-bot", name: "号绑", type: "slack", credentials: {}, zhiAccountId: "fd_a", zhiRoomId: null, enabled: true },
      { id: "unbound", name: "未绑", type: "slack", credentials: {}, zhiRoomId: null, zhiAccountId: null, enabled: true },
    ],
    setBotBridgeCursor: () => true,
    listBotChats: () => [],
  };
  const bridge = createZhiyuImBridge({
    db,
    env: { ZHIYU_IM_BRIDGE_ON: "1", CELL_GATEWAY_SECRET: SECRET, GATEWAY_INTERNAL_URL: "http://gw.local", ZHIYU_IM_BRIDGE_POLL_MS: 999_999 },
    fetchImpl: async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ rows: [] }), { status: 200 }); },
    adapterForBotFn: () => ({ sendText: async () => {} }),
  });
  bridge.noteInboundChat("room-bot", "k1");
  bridge.noteInboundChat("acct-bot", "k2");
  await bridge.tickBot(db.listBots()[0]).catch(() => {});
  await bridge.tickBot(db.listBots()[1]).catch(() => {});
  // direct tick proves the account bot is tickable; the enumeration filter is
  // asserted by reading the source (startOutbounds has no injectable surface).
  assert.ok(seen.some((u) => u.includes("/rooms/zy_a/events")), "room-bound bot polls");
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "server/zhiyu-im-bridge.js"), "utf8");
  assert.match(src, /bot\.zhiRoomId \|\| bot\.zhiAccountId/, "startOutbounds admits account-bound bots");
});
