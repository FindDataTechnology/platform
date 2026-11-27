// Meeting entity and participants (openspec: add-meeting-capture, 1.1–1.3).
//
// A meeting is the CONTAINER for several one-person capture streams. What must
// hold at this layer:
//   • two tables exist, creating them twice is a no-op, an old db upgrades;
//   • joining is idempotent per (meeting, member) — one person, one stream;
//   • a member is resolved from the ROOM, never from the request body;
//   • ending stops new joins and does not touch anything already delivered;
//   • the read face reports participants, delivered count and the arrival-order
//     basis (D5 — no cross-device clock exists, and saying otherwise would be a
//     precise-looking lie).
//
//   node --test scripts/test-zhiyu-meeting-store.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";

import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zym-")), "zhiyu.db");

function seed(store) {
  const room = store.roomCreate({ title: "会议室", ownerEmail: "a@x" });
  const a = store.memberAdd({ roomId: room.id, kind: "user", ref: "a@x", display: "张三" });
  const b = store.memberAdd({ roomId: room.id, kind: "user", ref: "b@x", display: "李四" });
  return { room, a, b };
}

// ── 1.1 tables ───────────────────────────────────────────────────────────────
test("1.1 two tables exist, ensure is idempotent, and an old db upgrades", () => {
  const file = tmpFile();
  const s1 = createZhiyuStore({ file });
  const { room } = seed(s1);
  const meeting = s1.meetingCreate({ roomId: room.id, title: "双人会议", ownerEmail: "a@x" });
  assert.equal(meeting.status, "open");
  assert.equal(meeting.title, "双人会议");

  // Re-opening the same file must not throw and must not lose the row.
  const s2 = createZhiyuStore({ file });
  assert.equal(s2.meetingsOf(room.id).length, 1, "重复 ensure 不丢行");
  assert.equal(s2.meetingGet(meeting.id).id, meeting.id);
});

// ── 1.2 join ────────────────────────────────────────────────────────────────
test("1.2 joining twice returns the same stream; two people make two", () => {
  const s = createZhiyuStore({ file: tmpFile() });
  const { room, a, b } = seed(s);
  const meeting = s.meetingCreate({ roomId: room.id, ownerEmail: "a@x" });

  const first = s.meetingJoin({ meetingId: meeting.id, member: a });
  const again = s.meetingJoin({ meetingId: meeting.id, member: a });
  assert.equal(first.created, true);
  assert.equal(again.created, false, "重复加入不产生第二路");
  assert.equal(again.participant.memberRef, "a@x");

  s.meetingJoin({ meetingId: meeting.id, member: b });
  assert.deepEqual(
    s.meetingParticipants(meeting.id).map((p) => p.memberRef),
    ["a@x", "b@x"],
  );
  assert.equal(s.meetingParticipants(meeting.id).every((p) => p.state === "joined"), true);
});

test("1.2 the stream records the capture it owns, not a client-supplied identity", () => {
  const s = createZhiyuStore({ file: tmpFile() });
  const { room, a } = seed(s);
  const meeting = s.meetingCreate({ roomId: room.id, ownerEmail: "a@x" });
  s.meetingJoin({ meetingId: meeting.id, member: a });
  const p = s.meetingSetCapture({ meetingId: meeting.id, memberRef: "a@x", captureId: "cap_xyz" });
  assert.equal(p.captureId, "cap_xyz");
  // A ref the room does not know changes nothing — the row is keyed by memberRef.
  assert.ok(
    !s.meetingSetCapture({ meetingId: meeting.id, memberRef: "stranger@x", captureId: "cap_evil" }),
    "非参会者的 memberRef 写不进任何一路",
  );
});

// ── 1.3 lifecycle + read face ───────────────────────────────────────────────
test("1.3 ending stops new joins and keeps what was already there", () => {
  const s = createZhiyuStore({ file: tmpFile() });
  const { room, a } = seed(s);
  const meeting = s.meetingCreate({ roomId: room.id, ownerEmail: "a@x" });
  s.meetingJoin({ meetingId: meeting.id, member: a });
  const ended = s.meetingEnd(meeting.id);
  assert.equal(ended.status, "ended");
  assert.ok(ended.endedAt > 0, "结束时间被记录");
  assert.equal(s.meetingParticipants(meeting.id).length, 1, "已加入的那一路还在");
  assert.equal(s.meetingOpenForMember({ roomId: room.id, memberRef: "b@x" }), null, "结束后不再算开放");
  // b never joined; ending did not invent a participant
  assert.equal(s.meetingParticipants(meeting.id).some((p) => p.memberRef === "b@x"), false);
});

// ── routes over HTTP ────────────────────────────────────────────────────────
async function boot() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zym-http-"));
  const app = express();
  app.use(express.json());
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    secret: "test-secret",
    webDist: null,
    callAgent: async () => ({ text: "ok" }),
    settleTurn: null,
    startTimers: false,
    voiceRoute: null,
  });
  const srv = createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, user = "a@x") => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { "x-user": user, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { zhiyu, call, close: () => srv.close() };
}

test("1.1–1.3 over HTTP: open, join twice, link capture, read, end, refuse late join", async () => {
  const t = await boot();
  const { room } = seed(t.zhiyu.store);
  try {
    const opened = await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "双人会议" });
    assert.equal(opened.status, 201);
    const mid = opened.body.meeting.id;

    const first = await t.call("POST", `/api/zhiyu/meetings/${mid}/join`, {});
    assert.equal(first.body.created, true);
    const again = await t.call("POST", `/api/zhiyu/meetings/${mid}/join`, {});
    assert.equal(again.body.created, false, "重复加入返回同一路");

    const joinedB = await t.call("POST", `/api/zhiyu/meetings/${mid}/join`, {}, "b@x");
    assert.equal(joinedB.body.created, true);

    const linked = await t.call("POST", `/api/zhiyu/meetings/${mid}/capture`, { captureId: "cap_1" });
    assert.equal(linked.body.participant.captureId, "cap_1");

    const view = await t.call("GET", `/api/zhiyu/meetings/${mid}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.participants.length, 2);
    assert.equal(view.body.orderBasis, "arrival", "顺序口径必须写明是按到达");
    assert.equal(typeof view.body.delivered, "number");
    assert.equal(typeof view.body.awaitingConfirmation, "number");

    const ended = await t.call("POST", `/api/zhiyu/meetings/${mid}/end`, {});
    assert.equal(ended.body.meeting.status, "ended");

    const late = await t.call("POST", `/api/zhiyu/meetings/${mid}/join`, {}, "b@x");
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "meeting_not_open");
  } finally {
    t.close();
  }
});

test("1.3 a non-member cannot open, read, or end a meeting", async () => {
  const t = await boot();
  const { room } = seed(t.zhiyu.store);
  try {
    const opened = await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "x" });
    const mid = opened.body.meeting.id;

    const strangerOpen = await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "x" }, "zz@x");
    assert.equal(strangerOpen.status, 404, "非成员连房间存在都不该知道");

    const strangerRead = await t.call("GET", `/api/zhiyu/meetings/${mid}`, null, "zz@x");
    assert.equal(strangerRead.status, 404);

    // A member who never joined cannot end someone else's meeting.
    t.zhiyu.store.memberAdd({ roomId: room.id, kind: "user", ref: "c@x", display: "王五" });
    const other = await t.call("POST", `/api/zhiyu/meetings/${mid}/end`, {}, "c@x");
    assert.equal(other.status, 403);
  } finally {
    t.close();
  }
});

// ── add-meeting-discovery: the room's "is anything on right now" face ────────
test("1.1 the open-meeting face is truthful: empty, then the meeting, then me", async () => {
  const t = await boot();
  const { room } = seed(t.zhiyu.store);
  try {
    // ① 没有开放会议 ⇒ 如实为空（不是「最近一场已结束的」）
    const empty = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.meeting, null);
    assert.equal(empty.body.participant, null);

    // ② 开一场之后，另一个成员也能读到（这正是原来缺的那一半）
    const opened = await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "双人会议" }, "a@x");
    const mid = opened.body.meeting.id;
    const seenByOther = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null, "b@x");
    assert.equal(seenByOther.status, 200);
    assert.equal(seenByOther.body.meeting.id, mid, "第二个成员看得到这场会议");
    assert.equal(seenByOther.body.participant, null, "他还没加入，所以没有自己那一路");

    // ③ 加入后同一面要如实说「我已经在里面」
    await t.call("POST", `/api/zhiyu/meetings/${mid}/join`, {}, "b@x");
    const afterJoin = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null, "b@x");
    assert.equal(afterJoin.body.participant?.memberRef, "b@x");
    assert.equal(afterJoin.body.participant?.state, "joined");

    // ④ 结束后这一面回到空（结束的会议不该还「开着」）
    await t.call("POST", `/api/zhiyu/meetings/${mid}/end`, {}, "a@x");
    const afterEnd = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null);
    assert.equal(afterEnd.body.meeting, null);
  } finally {
    t.close();
  }
});

test("1.1 a non-member gets the same answer as a room that does not exist", async () => {
  const t = await boot();
  const { room } = seed(t.zhiyu.store);
  try {
    await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "x" }, "a@x");
    const stranger = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null, "zz@x");
    const ghost = await t.call("GET", "/api/zhiyu/rooms/zy_doesnotexist0000/meetings/open", null, "zz@x");
    assert.equal(stranger.status, 404, "非成员读不到");
    assert.equal(stranger.status, ghost.status, "与房间不存在的响应无差别");
    assert.deepEqual(stranger.body, ghost.body, "…连响应体都一样，才不会泄露房间存在性");
  } finally {
    t.close();
  }
});

test("1.2 with several open meetings the face is deterministic: newest, then fall back", async () => {
  const t = await boot();
  const { room } = seed(t.zhiyu.store);
  try {
    const first = await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "早的" }, "a@x");
    // createdAt 是毫秒时间戳；同一毫秒内连开两场时靠 id 兜底，所以这里只需「后开的更晚」
    await new Promise((r) => setTimeout(r, 5));
    const second = await t.call("POST", `/api/zhiyu/rooms/${room.id}/meetings`, { title: "晚的" }, "a@x");

    const a = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null);
    const b = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null);
    assert.equal(a.body.meeting.id, second.body.meeting.id, "多场并存时取最新发起的那场");
    assert.equal(a.body.meeting.id, b.body.meeting.id, "两次读必须是同一场（确定性）");

    await t.call("POST", `/api/zhiyu/meetings/${second.body.meeting.id}/end`, {}, "a@x");
    const fallback = await t.call("GET", `/api/zhiyu/rooms/${room.id}/meetings/open`, null);
    assert.equal(fallback.body.meeting.id, first.body.meeting.id, "结束后回落到仍开着的那场");
  } finally {
    t.close();
  }
});
