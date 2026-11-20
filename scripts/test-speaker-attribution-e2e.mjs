// End-to-end: 一段双人会议录音 → 采集 → 归并 → 入房 → 按归属派发
// (openspec: add-speaker-attribution, task 6.2).
//
// The unit suites prove the pieces and `test-voice-route-room.mjs` proves the
// router accepts a decision. What is only provable HERE is the chain across the
// two services the feature actually spans: the capture store lives in the
// platform's SQLite and the room lives in the gateway's, so the per-speaker
// messages have to travel. This file drives that hop over real HTTP — platform
// route → gateway machine face → room write → router → agent call — and asserts
// the two outcomes the spec names:
//
//   • 有可信归属 (@无): 只叫醒那个人自己的席位，路由依据记为归属
//   • 匿名 (@无): 谁都不叫，落 needs_confirmation 并写明原因
//
// The task text called the second assertion `route_basis`; there is no such
// field anywhere in the code, and there never was. The decision's basis lives at
// `basis` on `decideAddressee`'s result and lands in the room as
// `meta.kind` on the `route_decision` event — those are what is asserted.
//
//   node --test scripts/test-speaker-attribution-e2e.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-e2e-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));

const SECRET = "e2e-gateway-secret";
const OWNER = "owner@corp.test";
const OTHER = "other@corp.test";

const { registerZhiyuRoutes } = await import("../gateway/zhiyu/index.js");
const { createVoiceRoute } = await import("../gateway/zhiyu/voice-route.js");
const { GATEWAY_SECRET_HEADER } = await import("../server/auth.js");
const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
const voice = await import("../server/routes/voice.js");
const captureStore = await import("../server/voice-capture.js");
const attribution = await import("../server/speaker-attribution.js");

await db.initDb();
process.env.CELL_USER_EMAIL = OWNER;

const OPEN = [];
after(() => Promise.all(OPEN.map((s) => new Promise((r) => s.close(r)))));

function listen(app) {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      OPEN.push(srv);
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

function call(base, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(new URL(base).port),
        path: p,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const bufs = [];
        res.on("data", (c) => bufs.push(c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(bufs).toString("utf8"));
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Boot the gateway (rooms) and the platform (captures), sharing one secret. */
async function boot() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-e2e-gw-"));
  const woken = [];
  const settles = [];
  const gwApp = express();
  gwApp.use(express.json());
  const zhiyu = registerZhiyuRoutes(gwApp, {
    dataRoot,
    resolveUser: () => null,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: process.env,
    secret: SECRET,
    webDist: null,
    // The whole point: who was woken, and was anything billed for it.
    callAgent: async (member) => {
      woken.push({ id: member.id, ref: member.ref });
      return { text: "（答复）" };
    },
    settleTurn: async (member, meta) => settles.push({ ref: member.ref, usageId: meta?.usageId }),
    startTimers: false,
    // The production seam, not a test stand-in.
    voiceRoute: createVoiceRoute(),
  });
  const gw = await listen(gwApp);
  process.env.GATEWAY_INTERNAL_URL = gw.base;
  process.env.CELL_GATEWAY_SECRET = SECRET;

  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: true,
    logtoAuth: null,
    broadcasts: [],
    cellId: "cell-e2e",
    chatHistory: {
      accessSession: () => ({ ok: true }),
      recordMessage: () => {},
    },
  };
  ctx.broadcast = (m) => ctx.broadcasts.push(m);
  registerAuth(ctx);
  voice.registerVoiceRoutes(ctx);
  const platform = await listen(ctx.app);

  return { dataRoot, zhiyu, woken, settles, platform, gw };
}

/** A real capture in the platform store: two slices, two voices, one bound. */
function makeCapture({ owner = OWNER, speakerMode = "shared", bind = [], segs } = {}) {
  const handle = db.getDb();
  captureStore.ensureVoiceCaptureTables(handle);
  attribution.ensureSpeakerTables(handle);
  const cap = captureStore.createCapture(handle, { owner, cellId: "cell-e2e", title: "双人会议", speakerMode });
  const chunks = segs ?? [
    { seq: 0, startMs: 0, text: "我同意这个方案", speaker: "spk_1" },
    { seq: 1, startMs: 3000, text: "我反对，风险太大", speaker: "spk_2" },
  ];
  for (const c of chunks) {
    captureStore.insertChunk(handle, { captureId: cap.id, seq: c.seq, startMs: c.startMs, durationMs: 3000, buffer: Buffer.from("a"), mime: "audio/webm" });
    captureStore.beginChunk(handle, { captureId: cap.id, seq: c.seq });
    captureStore.finishChunk(handle, {
      captureId: cap.id,
      seq: c.seq,
      ok: true,
      text: c.text,
      segments: [{ startMs: 0, endMs: 3000, speaker: c.speaker, text: c.text }],
    });
  }
  for (const b of bind) {
    const out = attribution.bindCluster(handle, {
      captureId: cap.id,
      owner,
      cluster: b.cluster,
      member: b.member,
      actor: owner,
      allowedMembers: b.allowedMembers ?? [OWNER, OTHER],
    });
    assert.equal(out.ok, true, `bindCluster(${b.cluster}) refused: ${out.code}`);
  }
  captureStore.finishCapture(handle, { id: cap.id, owner });
  return cap.id;
}

/** A room with two agent seats, each owned by one of the two people. */
function seedRoom(zhiyu) {
  const store = zhiyu.store;
  const room = store.roomCreate({ title: "双人会议房", ownerEmail: OWNER });
  store.memberAdd({ roomId: room.id, kind: "user", ref: OWNER, display: "本人" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: OTHER, display: "同事" });
  const mine = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:mine", display: "我的助手", onBehalfOf: OWNER });
  const theirs = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:theirs", display: "同事的助手", onBehalfOf: OTHER });
  return { room, mine, theirs };
}

const AS_OWNER = { "x-forwarded-email": OWNER, "x-forwarded-groups": "" };

// ── the acceptance path ───────────────────────────────────────────────────

test("6.2 有可信归属的一段走本人席位，匿名的一段落待确认——两条消息不是一条", async () => {
  const t = await boot();
  const { room, mine, theirs } = seedRoom(t.zhiyu);
  // spk_1 is bound to the owner (a seat binding, the hardest evidence there is);
  // spk_2 stays unbound — nobody declared it, so it is anonymous.
  const captureId = makeCapture({ bind: [{ cluster: "spk_1", member: OWNER }] });

  const out = await call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: room.id, confirm: true },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.messages, 2, "两个人两句 → 两条消息，一条不跨两个人");

  // ── the artifact: two rows, each carrying its own evidence ──────────────
  const rows = t.zhiyu.store.messagesAfter(room.id, 0, { limit: 100 }).filter((m) => m.kind === "human");
  assert.deepEqual(rows.map((m) => m.content), ["我同意这个方案", "我反对，风险太大"]);
  assert.equal(rows[0].meta?.capture?.seatOwnerMemberId, OWNER, "第一条带着「这是本人那一路」的证据");
  assert.equal(rows[1].meta?.capture?.seatOwnerMemberId ?? null, null, "第二条没有编造归属");
  assert.equal(rows[1].meta?.capture?.mode, "mixed", "无名字的一段按混录上报，路由只会去问");

  // ── the dispatch: exactly the owner's seat, exactly once ────────────────
  assert.deepEqual(t.woken.map((w) => w.id), [mine.id], "只叫醒本人席位");
  assert.equal(t.settles.length, 1, "只计费一次");
  assert.deepEqual(t.woken.map((w) => w.id).includes(theirs.id), false, "别人的席位零成本");

  // ── the recorded reason (the real field: meta.kind, not route_basis) ────
  const [first, second] = out.body.delivered;
  assert.equal(first.decision.basis, "attribution");
  assert.match(first.decision.reason, /归属/);
  assert.equal(second.decision.basis, "needs_confirmation");
  assert.match(second.decision.reason, /归属不确定/);
  assert.deepEqual(second.decision.recipients, [], "待确认不派发任何人");
});

test("6.2 两个人都绑定时各走各的席位；点名仍然赢过归属", async () => {
  const t = await boot();
  const { room, mine, theirs } = seedRoom(t.zhiyu);
  const captureId = makeCapture({
    bind: [
      { cluster: "spk_1", member: OWNER },
      { cluster: "spk_2", member: OTHER },
    ],
  });

  const out = await call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: room.id, confirm: true },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.delivered.length, 2);
  assert.equal(out.body.delivered[0].decision.basis, "attribution");
  assert.equal(out.body.delivered[1].decision.basis, "attribution");
  assert.deepEqual(t.woken.map((w) => w.id).sort(), [mine.id, theirs.id].sort(), "两个人各自的人被叫醒");
  assert.equal(t.settles.length, 2);
});

test("6.2 本场声明（session 模式）整段归本人——一条消息，不做无意义的切分", async () => {
  const t = await boot();
  const { room, mine } = seedRoom(t.zhiyu);
  const captureId = makeCapture({
    speakerMode: "session",
    segs: [
      { seq: 0, startMs: 0, text: "第一句", speaker: null },
      { seq: 1, startMs: 3000, text: "第二句", speaker: null },
    ],
  });

  const out = await call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: room.id, confirm: true },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.messages, 1, "同一人全程：一条消息");
  assert.equal(out.body.delivered[0].decision.basis, "attribution");
  assert.deepEqual(t.woken.map((w) => w.id), [mine.id]);
});

// ── the refusals that keep the door the size it is ────────────────────────

test("6.2 机器面只收带证据的消息：一条没有证据就整批拒绝，一行都不写", async () => {
  const t = await boot();
  const { room } = seedRoom(t.zhiyu);
  const before = t.zhiyu.store.messagesAfter(room.id, 0, { limit: 100 }).length;

  const refused = await call(t.gw.base, "POST", `/api/zhiyu/capture-ingest/rooms/${room.id}/messages`, {
    headers: { [GATEWAY_SECRET_HEADER]: SECRET, "x-actor-email": OWNER },
    body: { messages: [{ content: "有证据的", capture: { streamId: "s1", mode: "per_stream" } }, { content: "没有证据的" }] },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "evidence_required");
  assert.equal(
    t.zhiyu.store.messagesAfter(room.id, 0, { limit: 100 }).length,
    before,
    "半场会议不是可用的转写——整批拒绝，不留半份",
  );
  assert.deepEqual(t.woken, []);
});

test("6.2 机器面拒绝无凭据、非成员与不存在的房间", async () => {
  const t = await boot();
  const { room } = seedRoom(t.zhiyu);
  const msg = [{ content: "一句话", capture: { streamId: "s1", mode: "per_stream" } }];

  const noSecret = await call(t.gw.base, "POST", `/api/zhiyu/capture-ingest/rooms/${room.id}/messages`, {
    headers: { "x-actor-email": OWNER },
    body: { messages: msg },
  });
  assert.equal(noSecret.status, 401);

  const stranger = await call(t.gw.base, "POST", `/api/zhiyu/capture-ingest/rooms/${room.id}/messages`, {
    headers: { [GATEWAY_SECRET_HEADER]: SECRET, "x-actor-email": "stranger@corp.test" },
    body: { messages: msg },
  });
  assert.equal(stranger.status, 403, "正是「不是这间房的人不能把录音塞进来」");

  const missing = await call(t.gw.base, "POST", "/api/zhiyu/capture-ingest/rooms/zy_ffffffffffffffffff/messages", {
    headers: { [GATEWAY_SECRET_HEADER]: SECRET, "x-actor-email": OWNER },
    body: { messages: msg },
  });
  assert.equal(missing.status, 404);
});

test("6.2 平台侧：没有确认、房间号不像房间、未结束的采集都被拒", async () => {
  const t = await boot();
  const { room } = seedRoom(t.zhiyu);
  const captureId = makeCapture({ bind: [{ cluster: "spk_1", member: OWNER }] });

  const noConfirm = await call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: room.id },
  });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.body.code, "confirmation_required");

  const badRoom = await call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: "not-a-room", confirm: true },
  });
  assert.equal(badRoom.status, 400);
  assert.equal(badRoom.body.code, "bad_room");

  // A capture still recording has no text to send.
  const handle = db.getDb();
  const live = captureStore.createCapture(handle, { owner: OWNER, cellId: "cell-e2e", title: "录音中" });
  const notFinished = await call(t.platform.base, "POST", `/api/voice/captures/${live.id}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: room.id, confirm: true },
  });
  assert.equal(notFinished.status, 409);
  assert.equal(notFinished.body.code, "not_finished");
});

test("6.2 同一份采集送第二次：幂等，不产生第二份会议", async () => {
  const t = await boot();
  const { room } = seedRoom(t.zhiyu);
  const captureId = makeCapture({ bind: [{ cluster: "spk_1", member: OWNER }] });
  const send = () =>
    call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
      headers: AS_OWNER,
      body: { roomId: room.id, confirm: true },
    });

  assert.equal((await send()).status, 200);
  const rowsAfterFirst = t.zhiyu.store.messagesAfter(room.id, 0, { limit: 100 }).length;
  const again = await send();
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyInRoom, true);
  assert.equal(t.zhiyu.store.messagesAfter(room.id, 0, { limit: 100 }).length, rowsAfterFirst, "第二次点击不加第二份");
});
