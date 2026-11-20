// The ingest face's meeting checks (openspec: add-meeting-capture, 3.1–3.2 / 4.3).
//
// This is the ONE place where "whose words are these" is not a client claim.
// Everything upstream (the capture, its declaration, the split) is produced by
// the platform and could in principle say anything; here the gateway checks it
// against its OWN room: the meeting must be open in THIS room, and the person a
// message names must have actually joined that meeting.
//
// The other half is negative and just as important: with no `meetingId` the
// path must be byte-identical to what shipped yesterday — including not touching
// the meeting tables at all.
//
//   node --test scripts/test-meeting-capture-ingest.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { createServer } from "node:http";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { createVoiceRoute } from "../gateway/zhiyu/voice-route.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "ingest-secret";
const HEADER = "x-cloud-gateway-secret";

const msg = (member, extra = {}) => ({
  content: `${member ?? "匿名"}说了一句`,
  memberRef: member,
  capture: {
    streamId: `zym_x#${member ?? "unknown"}`,
    mode: member ? "per_stream" : "mixed",
    ...(member ? { seatOwnerMemberId: member } : {}),
  },
  ...extra,
});

async function boot() {
  const app = express();
  app.use(express.json());
  const woken = [];
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: `/tmp/zym-ingest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    resolveUser: () => null,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    secret: SECRET,
    webDist: null,
    callAgent: async (m) => {
      woken.push(m.ref);
      return { text: "（答复）" };
    },
    settleTurn: null,
    startTimers: false,
    voiceRoute: createVoiceRoute(),
  });
  const srv = createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const store = zhiyu.store;
  const room = store.roomCreate({ title: "会议房", ownerEmail: "a@x" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: "a@x", display: "张三" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: "b@x", display: "李四" });
  const seatA = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:a", display: "张三的助手", onBehalfOf: "a@x" });
  const seatB = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:b", display: "李四的助手", onBehalfOf: "b@x" });

  const post = async (path, body, actor = "a@x") => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADER]: SECRET, "x-actor-email": actor },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { store, room, seatA, seatB, woken, post, close: () => srv.close() };
}

const ingestPath = (roomId) => `/api/zhiyu/capture-ingest/rooms/${roomId}/messages`;

// ── the bind face (meeting-capture-client-wiring, 5.3) ──────────────────────
//
// The ingest cases above authenticate with the gateway secret; the bind face is
// a *user* endpoint and goes through `authorize`, so it needs an actor. This is
// the same room/seat fixture, booted with a header-based resolver.
async function bootUser() {
  const app = express();
  app.use(express.json());
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: `/tmp/zym-bind-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    resolveUser: (req) => (req.headers["x-user"] ? { email: String(req.headers["x-user"]), groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    secret: SECRET,
    webDist: null,
    callAgent: async () => ({ text: "（答复）" }),
    settleTurn: null,
    startTimers: false,
    voiceRoute: createVoiceRoute(),
  });
  const srv = createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const store = zhiyu.store;
  const room = store.roomCreate({ title: "会议房", ownerEmail: "a@x" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: "a@x", display: "张三" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: "b@x", display: "李四" });

  const call = async (method, path, body, user = "a@x") => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-user": user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { store, room, call, close: () => srv.close() };
}

// ── 3.1 the four refusals ───────────────────────────────────────────────────
test("3.1 unknown meeting / ended meeting / non-member / not-joined are refused, and nothing is written", async () => {
  const t = await boot();
  try {
    const before = t.store.messagesAfter(t.room.id, 0, { limit: 100 }).length;

    const unknown = await t.post(ingestPath(t.room.id), { meetingId: "zym_nope", messages: [msg("a@x")] });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "meeting_not_found");

    const meeting = t.store.meetingCreate({ roomId: t.room.id, title: "双人会议", ownerEmail: "a@x" });
    t.store.meetingJoin({ meetingId: meeting.id, member: { id: t.seatA.id, ref: "a@x" } });

    // b@x is a room member but never joined this meeting.
    const notJoined = await t.post(ingestPath(t.room.id), { meetingId: meeting.id, messages: [msg("b@x")] });
    assert.equal(notJoined.status, 409);
    assert.equal(notJoined.body.code, "meeting_member_not_joined");

    // A ref the room does not know is the same refusal.
    const stranger = await t.post(ingestPath(t.room.id), { meetingId: meeting.id, messages: [msg("zz@x")] });
    assert.equal(stranger.status, 409);
    assert.equal(stranger.body.code, "meeting_member_not_joined");

    t.store.meetingEnd(meeting.id);
    const ended = await t.post(ingestPath(t.room.id), { meetingId: meeting.id, messages: [msg("a@x")] });
    assert.equal(ended.status, 409);
    assert.equal(ended.body.code, "meeting_not_open");

    assert.equal(
      t.store.messagesAfter(t.room.id, 0, { limit: 100 }).length,
      before,
      "四种拒绝一条行都不写",
    );
    assert.deepEqual(t.woken, [], "被拒的批次不叫醒任何席位");
  } finally {
    t.close();
  }
});

test("3.1 a joined member's stream is accepted and routed to that member's own seat", async () => {
  const t = await boot();
  try {
    const meeting = t.store.meetingCreate({ roomId: t.room.id, title: "双人会议", ownerEmail: "a@x" });
    t.store.meetingJoin({ meetingId: meeting.id, member: { id: t.seatA.id, ref: "a@x" } });

    const ok = await t.post(ingestPath(t.room.id), { meetingId: meeting.id, messages: [msg("a@x")] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.delivered.length, 1);
    assert.equal(ok.body.delivered[0].decision.basis, "attribution");
    assert.deepEqual(t.woken, [t.seatA.ref], "只叫醒张三自己的助手");
  } finally {
    t.close();
  }
});

test("3.1 a stream that names nobody is still accepted (mixed mic must be able to ask)", async () => {
  const t = await boot();
  try {
    const meeting = t.store.meetingCreate({ roomId: t.room.id, title: "双人会议", ownerEmail: "a@x" });
    t.store.meetingJoin({ meetingId: meeting.id, member: { id: t.seatA.id, ref: "a@x" } });

    const ok = await t.post(ingestPath(t.room.id), { meetingId: meeting.id, messages: [msg(null)] });
    assert.equal(ok.status, 200, "没有归属的一路不该被拒——它要落待确认");
    assert.equal(ok.body.delivered[0].decision.basis, "needs_confirmation");
    assert.deepEqual(t.woken, []);
  } finally {
    t.close();
  }
});

// ── 3.2 no meetingId ⇒ the shipped path, untouched ──────────────────────────
test("3.2 without meetingId the meeting tables are never consulted", async () => {
  const t = await boot();
  try {
    // Poison every meeting read: if the standalone path touches one, this throws.
    const boom = () => {
      throw new Error("meeting table was consulted on the standalone path");
    };
    t.store.meetingGet = boom;
    t.store.meetingParticipants = boom;

    const ok = await t.post(ingestPath(t.room.id), { messages: [msg("a@x")] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.delivered[0].decision.basis, "attribution");
    assert.deepEqual(t.woken, [t.seatA.ref]);
  } finally {
    t.close();
  }
});

// ── 5.3 bind face: joining is the evidence, and a refusal writes nothing ─────
test("5.3 an un-joined caller's bind is refused (409 not_joined) and the room gains no row", async () => {
  const t = await bootUser();
  try {
    const opened = await t.call("POST", `/api/zhiyu/rooms/${t.room.id}/meetings`, { title: "双人会议" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const mid = opened.body.meeting.id;

    const joined = await t.call("POST", `/api/zhiyu/meetings/${mid}/join`, {});
    assert.equal(joined.status, 200, JSON.stringify(joined.body));

    // The green branch first: without it, a route that 409s EVERY caller would
    // look exactly like a correct refusal (the criteria could be reversed).
    const okBind = await t.call("POST", `/api/zhiyu/meetings/${mid}/capture`, { captureId: "cap_a" });
    assert.equal(okBind.status, 200, JSON.stringify(okBind.body));
    assert.equal(okBind.body.participant.captureId, "cap_a");

    const before = t.store.messagesAfter(t.room.id, 0, { limit: 500 }).length;

    // b@x is a real room member but never joined THIS meeting. Binding says
    // "this stream is my seat", so the server wants the join, not the room seat.
    const refused = await t.call("POST", `/api/zhiyu/meetings/${mid}/capture`, { captureId: "cap_b" }, "b@x");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "not_joined");

    // And "refused" means refused: no participant row was invented for b, and
    // nothing landed in the room.
    const parts = t.store.meetingParticipants(mid);
    assert.equal(parts.some((p) => p.memberRef === "b@x"), false, "被拒的调用者不得凭空得到一路");
    assert.equal(parts.find((p) => p.memberRef === "a@x").captureId, "cap_a", "别人的绑定不受影响");
    assert.equal(
      t.store.messagesAfter(t.room.id, 0, { limit: 500 }).length,
      before,
      "被拒的绑定一条行都不写",
    );

    // Rebinding is idempotent (the client retries it on every start): the same
    // participant row is updated, no second row appears.
    const rebind = await t.call("POST", `/api/zhiyu/meetings/${mid}/capture`, { captureId: "cap_a2" });
    assert.equal(rebind.status, 200, JSON.stringify(rebind.body));
    assert.equal(rebind.body.participant.captureId, "cap_a2");
    assert.equal(t.store.meetingParticipants(mid).length, parts.length, "重复绑定不新增参与行");
  } finally {
    t.close();
  }
});

// ── 4.3 the router really is untouched ──────────────────────────────────────
test("4.3 voice-route.js and voice-router.js carry no change (routing was reused, not reopened)", () => {
  // Cheap, honest guard: the two files the feature claims NOT to have touched.
  // If a later edit needs to change them, this assertion is the prompt to say so
  // out loud in the change rather than sneak a routing change in underneath.
  const router = readFileSync(join(REPO, "gateway/zhiyu/voice-router.js"), "utf8");
  const route = readFileSync(join(REPO, "gateway/zhiyu/voice-route.js"), "utf8");
  assert.match(router, /ATTRIBUTION_CERTAIN = Object\.freeze\(\["session", "bound"\]\)/);
  assert.match(route, /export function createVoiceRoute/);
  // 判据是**新概念** `meetingId` 没有渗进路由：`meetingMode` 是路由早就有的旧词汇
  // （会议模式下的征询规则），拿 "meeting" 这个词当判据是假红。
  assert.doesNotMatch(router, /meetingId/, "路由不得知道「会议标识」这个概念");
  assert.doesNotMatch(route, /meetingId/, "seam 只认 meta.capture，不认会议标识");
});
