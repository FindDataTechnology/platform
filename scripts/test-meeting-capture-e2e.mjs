// Meeting capture end to end (openspec: add-meeting-capture, 3.3 / 4.1 / 4.2 / 6.1).
//
// Two proofs that can only be made here, because they span BOTH services:
//
//   A. the platform actually carries `meetingId` across the hop — proved against
//      a recording stand-in gateway that keeps the exact JSON body, and proved
//      negative for a standalone capture (its body must be byte-identical to
//      what shipped before this change: no meetingId key at all);
//   B. a real meeting produces per-person dispatch: two members join, each one's
//      stream is delivered, each goes to that person's own seat, and a third
//      stream that names nobody lands in the confirmation queue instead of
//      borrowing a neighbour's identity.
//
//   node --test scripts/test-meeting-capture-e2e.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-e2e-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
// server/owner-groups.js resolves its snapshot from PLATFORM_DATA_DIR, else
// `path.resolve("owner-groups.json")` — i.e. THE REPO. Importing server/auth.js
// therefore rewrites the checked-in owner snapshot unless this points into the
// sandbox: it did exactly that once, leaving a dirty `owner-groups.json` in a
// release worktree, one `git add -A` away from shipping a wrong owner.
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
// 5.4 drives the REAL `POST /api/voice/captures` with the body the two mobile
// clients now send; that route refuses when no voice credential resolves
// (voiceUnavailable ⇒ 503). A deployment-level key is all it needs — this file
// never calls the ASR upstream (the transcript is written straight into the
// capture store), so no stub transcription server is required.
process.env.LLM_API_KEY = ["sk-e2e", "meeting"].join("-");

const SECRET = "meeting-e2e-secret";
const OWNER = "owner@corp.test";
const OTHER = "other@corp.test";

const { registerZhiyuRoutes } = await import("../gateway/zhiyu/index.js");
const { createVoiceRoute } = await import("../gateway/zhiyu/voice-route.js");
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

/** The platform app, with a chat-history stub (this route never uses it). */
function platformApp() {
  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: true,
    logtoAuth: null,
    broadcasts: [],
    cellId: "cell-meeting",
    chatHistory: { accessSession: () => ({ ok: true }), recordMessage: () => {} },
  };
  ctx.broadcast = (m) => ctx.broadcasts.push(m);
  registerAuth(ctx);
  voice.registerVoiceRoutes(ctx);
  // Return the EXPRESS APP, not ctx: `createServer(obj)` reads a non-function as
  // options and installs no listener at all, so the server accepts requests and
  // never answers — a hang with no error, which cost a debugging round.
  return ctx.app;
}

/** A real one-person capture in the platform store. */
function makeCapture({ owner = OWNER, speakerMode = "session", meetingId = null, text = "我同意这个方案" } = {}) {
  const handle = db.getDb();
  captureStore.ensureVoiceCaptureTables(handle);
  attribution.ensureSpeakerTables(handle);
  const cap = captureStore.createCapture(handle, {
    owner,
    cellId: "cell-meeting",
    title: "会议一路",
    speakerMode,
    meetingId,
  });
  captureStore.insertChunk(handle, {
    captureId: cap.id,
    seq: 0,
    startMs: 0,
    durationMs: 3000,
    buffer: Buffer.from("a"),
    mime: "audio/webm",
  });
  captureStore.beginChunk(handle, { captureId: cap.id, seq: 0 });
  captureStore.finishChunk(handle, { captureId: cap.id, seq: 0, ok: true, text, segments: null });
  captureStore.finishCapture(handle, { id: cap.id, owner });
  return cap.id;
}

const AS_OWNER = { "x-forwarded-email": OWNER, "x-forwarded-groups": "" };

// ── A. 3.3 the payload the platform actually sends ──────────────────────────
test("3.3 the platform carries meetingId across the hop, and a standalone payload is unchanged", async () => {
  const seen = [];
  const spy = express();
  spy.use(express.json());
  spy.post("/api/zhiyu/capture-ingest/rooms/:id/messages", (req, res) => {
    seen.push({ room: req.params.id, body: req.body });
    res.json({ ok: true, delivered: [] });
  });
  const gw = await listen(spy);
  process.env.GATEWAY_INTERNAL_URL = gw.base;
  process.env.CELL_GATEWAY_SECRET = SECRET;

  const p = await listen(platformApp());
  const roomId = "zy_aaaaaaaaaaaaaaa1";

  const meetingCap = makeCapture({ meetingId: "zym_abc" });
  const r1 = await call(p.base, "POST", `/api/voice/captures/${meetingCap}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId, confirm: true },
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));

  const looseCap = makeCapture({});
  const r2 = await call(p.base, "POST", `/api/voice/captures/${looseCap}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId, confirm: true },
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));

  assert.equal(seen.length, 2);
  assert.equal(seen[0].body.meetingId, "zym_abc", "会议采集把会议标识送过界");
  assert.equal("meetingId" in seen[1].body, false, "散装采集的 body 与改造前逐字一致（没有该键）");
  // The message-level evidence still rides `meta.capture`, not a new channel.
  assert.match(seen[0].body.messages[0].capture.streamId, /^zym_abc#/, "会议流的 streamId 以会议 id 开头");
  assert.match(seen[1].body.messages[0].capture.streamId, /^cap_/, "散装流的 streamId 仍是采集 id");
});

// ── B. 4.1 / 4.2 / 6.1 a real meeting, real routing ─────────────────────────
// `resolveUser` stays null by default: the pre-existing cases reach the gateway
// through the machine face (the shared secret), exactly as production does.
// 5.4 is the one case that needs a USER identity at the gateway, because the
// bind is a user endpoint — it passes a resolver in.
async function bootRealGateway({ resolveUser = () => null } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-gw-"));
  const woken = [];
  const settles = [];
  const gwApp = express();
  gwApp.use(express.json());
  const zhiyu = registerZhiyuRoutes(gwApp, {
    dataRoot,
    resolveUser,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: process.env,
    secret: SECRET,
    webDist: null,
    callAgent: async (member) => {
      woken.push({ id: member.id, ref: member.ref });
      return { text: "（答复）" };
    },
    settleTurn: async (member, meta) => settles.push({ ref: member.ref, usageId: meta?.usageId }),
    startTimers: false,
    voiceRoute: createVoiceRoute(),
  });
  const gw = await listen(gwApp);
  process.env.GATEWAY_INTERNAL_URL = gw.base;
  process.env.CELL_GATEWAY_SECRET = SECRET;

  const store = zhiyu.store;
  const room = store.roomCreate({ title: "双人会议房", ownerEmail: OWNER });
  store.memberAdd({ roomId: room.id, kind: "user", ref: OWNER, display: "本人" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: OTHER, display: "同事" });
  const mine = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:mine", display: "我的助手", onBehalfOf: OWNER });
  const theirs = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:theirs", display: "同事的助手", onBehalfOf: OTHER });

  const meeting = store.meetingCreate({ roomId: room.id, title: "双人会议", ownerEmail: OWNER });
  store.meetingJoin({ meetingId: meeting.id, member: { id: mine.id, ref: OWNER } });
  store.meetingJoin({ meetingId: meeting.id, member: { id: theirs.id, ref: OTHER } });

  const p = await listen(platformApp());
  return { store, room, meeting, mine, theirs, woken, settles, gateway: gw, platform: p };
}

// ── 5.4 the client's own shape, end to end ─────────────────────────────────
//
// Why this case exists: every case above creates the capture by calling the
// platform store directly (`makeCapture`), which BORROWS an identity the product
// never had. That is precisely how the meeting lane could look "complete on the
// server" while the real-device acceptance could never pass: no client ever
// created a capture in the meeting shape, so nothing could be attributed.
//
// This case drives the bytes a phone actually sends, in order:
//   1. POST /api/voice/captures  { title, speakerMode, meetingId }   ← the transport
//   2. POST /api/zhiyu/meetings/:id/capture { captureId }            ← the bind
//   3. finish the capture (the phone's upload already happened)
//   4. POST /api/voice/captures/:id/zhiyu-room { roomId, confirm }   ← into the room
// and it must end as ONE room row naming me, waking only my seat.
function finishWithText(captureId, text) {
  const handle = db.getDb();
  captureStore.insertChunk(handle, {
    captureId,
    seq: 0,
    startMs: 0,
    durationMs: 3000,
    buffer: Buffer.from("a"),
    mime: "audio/webm",
  });
  captureStore.beginChunk(handle, { captureId, seq: 0 });
  captureStore.finishChunk(handle, { captureId, seq: 0, ok: true, text, segments: null });
  captureStore.finishCapture(handle, { id: captureId, owner: OWNER });
}

test("5.4 客户端形状：create(会议字段) → bind → 结束 → 入房，一条消息且只叫醒我的席位", async () => {
  const t = await bootRealGateway({
    resolveUser: (req) =>
      req.headers["x-forwarded-email"] ? { email: String(req.headers["x-forwarded-email"]), groups: [] } : null,
  });

  // 1. Exactly what miniapp/app `capture-upload.ts` + `CaptureEntry.tsx` send.
  const created = await call(t.platform.base, "POST", "/api/voice/captures", {
    headers: AS_OWNER,
    body: { title: "会议记录", speakerMode: "session", meetingId: t.meeting.id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.capture.speakerMode, "session", "会议模式必须真的落到采集行上");
  assert.equal(created.body.capture.meetingId, t.meeting.id, "会议标识必须真的落到采集行上");
  const capId = created.body.capture.id;

  // 2. The binding the client makes right after create. Without it the stream has
  //    a meeting but no owner, and the room hop would land in 待确认.
  const bound = await call(t.gateway.base, "POST", `/api/zhiyu/meetings/${t.meeting.id}/capture`, {
    headers: AS_OWNER,
    body: { captureId: capId },
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  assert.equal(bound.body.participant.captureId, capId, "读面能把这一路指到本人");

  // 3. The phone finished recording (its upload is not what this file proves).
  finishWithText(capId, "我这边补充两点");

  // 4. Publishing into the meeting's room, behind the same explicit confirm the
  //    product uses (a client never auto-publishes).
  const out = await call(t.platform.base, "POST", `/api/voice/captures/${capId}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: t.room.id, confirm: true },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.delivered[0].decision.basis, "attribution", "按归属派发，不落待确认");
  assert.deepEqual(t.woken.map((w) => w.id), [t.mine.id], "只叫醒我自己的席位，不连带同事");

  const rows = t.store.messagesAfter(t.room.id, 0, { limit: 100 }).filter((m) => m.kind === "human");
  assert.equal(rows.length, 1, "一路一条，不多不少");
  assert.equal(rows[0].meta?.meetingId, t.meeting.id);
  assert.equal(rows[0].meta?.capture?.declaredMemberId, OWNER, "这条消息指的就是我");
});

test("6.1 两人各一路 → 两条消息、各派各的人；未署名的一路落待确认且不连带", async () => {
  const t = await bootRealGateway();
  const send = (captureId) =>
    call(t.platform.base, "POST", `/api/voice/captures/${captureId}/zhiyu-room`, {
      headers: AS_OWNER,
      body: { roomId: t.room.id, confirm: true },
    });

  const capA = makeCapture({ owner: OWNER, meetingId: t.meeting.id, text: "我同意这个方案" });
  const outA = await send(capA);
  assert.equal(outA.status, 200, JSON.stringify(outA.body));
  assert.equal(outA.body.delivered[0].decision.basis, "attribution", "张三那一路按归属派");
  assert.deepEqual(t.woken.map((w) => w.id), [t.mine.id], "只叫醒张三自己的席位");

  const capB = makeCapture({ owner: OTHER, meetingId: t.meeting.id, text: "我反对，风险太大" });
  const outB = await call(t.platform.base, "POST", `/api/voice/captures/${capB}/zhiyu-room`, {
    headers: { "x-forwarded-email": OTHER, "x-forwarded-groups": "" },
    body: { roomId: t.room.id, confirm: true },
  });
  assert.equal(outB.status, 200, JSON.stringify(outB.body));
  assert.equal(outB.body.delivered[0].decision.basis, "attribution");
  assert.deepEqual(t.woken.map((w) => w.id).sort(), [t.mine.id, t.theirs.id].sort(), "两个人都派给了自己的人");
  assert.equal(t.settles.length, 2, "两路各结算一次");

  // A third stream that belongs to nobody: shared mic, no lambda. It must be
  // accepted (a mixed mic has to be able to ask) and must NOT inherit 张三's
  // identity just because 张三 is in the same meeting.
  const capMixed = makeCapture({ owner: OWNER, speakerMode: "shared", meetingId: t.meeting.id, text: "嗯……那个" });
  const outMixed = await send(capMixed);
  assert.equal(outMixed.status, 200, JSON.stringify(outMixed.body));
  assert.equal(outMixed.body.delivered[0].decision.basis, "needs_confirmation");
  assert.deepEqual(outMixed.body.delivered[0].decision.recipients, [], "未署名不派发任何人");
  assert.equal(t.woken.length, 2, "第三路没有唤醒任何额外席位");

  // The artifact: three human rows, each with its own evidence, two of them
  // naming their own person and the third naming nobody.
  const rows = t.store.messagesAfter(t.room.id, 0, { limit: 100 }).filter((m) => m.kind === "human");
  assert.equal(rows.length, 3, "一路一条，一条不跨两个人");
  assert.deepEqual(
    rows.map((m) => m.meta?.meetingId),
    [t.meeting.id, t.meeting.id, t.meeting.id],
    "三条共享同一个会议标识，读面才能按场归组",
  );
  assert.deepEqual(
    rows.map((m) => m.meta?.capture?.declaredMemberId ?? null),
    [OWNER, OTHER, null],
    "有归属的两条各指本人，未署名的那条谁也不指",
  );
});

test("6.1 会议结束后同一路再送一次被拒（会议状态是硬门，不是提示）", async () => {
  const t = await bootRealGateway();
  const cap = makeCapture({ owner: OWNER, meetingId: t.meeting.id });
  const first = await call(t.platform.base, "POST", `/api/voice/captures/${cap}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: t.room.id, confirm: true },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  t.store.meetingEnd(t.meeting.id);

  const cap2 = makeCapture({ owner: OWNER, meetingId: t.meeting.id, text: "会后又一段" });
  const after = await call(t.platform.base, "POST", `/api/voice/captures/${cap2}/zhiyu-room`, {
    headers: AS_OWNER,
    body: { roomId: t.room.id, confirm: true },
  });
  assert.equal(after.status, 502, "网关以 409 拒绝，平台如实转成 502");
  assert.equal(after.body.code, "meeting_not_open");
});
