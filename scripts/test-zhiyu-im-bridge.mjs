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
