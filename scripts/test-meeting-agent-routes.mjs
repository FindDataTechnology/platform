// Meeting agent — routes + helpers (openspec: add-ai-native-meeting 2.1/2.2).
//
// Pins the contract the worker depends on, in the order it would embarrass us:
//   1. the machine door is the same one capture-ingest uses (no key in worker)
//   2. a named speaker who did NOT join the meeting is refused, not attributed
//   3. an unnamed segment lands as `mixed` (the room asks; nobody is guessed)
//   4. STT/TTS run with the DEPLOYMENT credential, never a member's account
//   5. speak resolves its voice from the catalog's three layers
//
//   node --test scripts/test-meeting-agent-routes.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { cellCredential } from "../gateway/cell-credential.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { registerMeetingAgentRoutes } from "../gateway/zhiyu/meeting-agent-routes.js";
import { meetingEvidence, utteranceToMessage, agentVoiceFor } from "../gateway/zhiyu/meeting-agent.js";

const SECRET = "gw-secret";
const CELL_ID = "0123456789abcdef";
// The door verifies a per-cell credential (harden-cell-isolation 1.1), not the
// master — mint the token the gateway would present.
const TOKEN = cellCredential(SECRET, CELL_ID);
const OWNER = "owner@x.test";

// A programmable fake 词元 lane (wav in/out), same shape the voice tests use.
import { createVoiceForwarder } from "../gateway/zhiyu/voice-forward.js";
import { createServer } from "node:http";
const calls = [];
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    calls.push({ url: req.url, bytes: body.length, auth: req.headers.authorization });
    if (req.url === "/v1/audio/transcriptions") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: "这是会议里的一句话。" }));
    }
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(Buffer.from("RIFF...."));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.VOICE_API_BASE = `http://127.0.0.1:${fake.address().port}`;
process.env.VOICE_API_KEY = "sk-deployment-key";

test.after(() => fake.close());

async function boot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mtg-agent-"));
  const store = createZhiyuStore({ file: path.join(dir, "z.db") });
  const room = store.roomCreate({ title: "会", ownerEmail: OWNER });
  const meeting = store.meetingCreate({ roomId: room.id, title: "会", ownerEmail: OWNER });
  const voiceForward = createVoiceForwarder({ env: process.env });
  const app = express();
  app.use(express.json());
  registerMeetingAgentRoutes(app, { store, voiceForward, secret: SECRET });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const door = { "x-cloud-gateway-secret": TOKEN, "x-actor-email": OWNER };
  return { store, room, meeting, base, door, server, close: () => server.close() };
}

const post = (base, p, { headers = {}, body } = {}) =>
  fetch(base + p, { method: "POST", headers, body }).then(async (r) => {
    const buf = Buffer.from(await r.arrayBuffer());
    let parsed;
    return {
      status: r.status,
      headers: r.headers,
      buf,
      json: async () => {
        if (parsed === undefined) { try { parsed = JSON.parse(buf.toString() || "{}"); } catch { parsed = {}; } }
        return parsed;
      },
    };
  });

function wavForm(seatRef, bytes = Buffer.from("RIFF0000WAVE") ) {
  const fd = new FormData();
  fd.append("audio", new Blob([bytes], { type: "audio/wav" }), "s.wav");
  if (seatRef !== undefined) fd.append("seatRef", seatRef);
  return fd;
}

test("utterance: a request without the machine door is refused (401), and no STT is attempted", async () => {
  const h = await boot().catch(() => null);
  assert.ok(h, "boot");
  try {
    const r = await post(h.base, `/api/zhiyu/meetings/${h.meeting.id}/utterance`, { body: wavForm("") });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0, "no upstream call when the door rejects");
  } finally { h.close(); }
});

test("utterance: a named speaker who has NOT joined is refused (409), not attributed", async () => {
  const h = await boot();
  try {
    const r = await post(h.base, `/api/zhiyu/meetings/${h.meeting.id}/utterance`, {
      headers: h.door, body: wavForm("ghost@x.test"),
    });
    assert.equal(r.status, 409);
    assert.match((await r.json()).code, /meeting_member_not_joined/);
  } finally { h.close(); }
});

test("utterance: STT runs with the deployment cred and a joined speaker's words land per_stream", async () => {
  const h = await boot();
  try {
    // The owner already has an active user seat in the room (roomCreate creates it);
    // join the meeting as that seat.
    const seat = h.store.memberFor(h.room.id, "user", OWNER) || h.store.memberAdd({ roomId: h.room.id, kind: "user", ref: OWNER, display: OWNER });
    h.store.meetingJoin({ meetingId: h.meeting.id, member: seat });
    calls.length = 0;
    const r = await post(h.base, `/api/zhiyu/meetings/${h.meeting.id}/utterance`, { headers: h.door, body: wavForm(OWNER) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(j.delivered?.length === 1, "one message delivered");
    const row = h.store.messageAt(h.room.id, j.delivered[0].seq);
    assert.equal(row.kind, "human");
    assert.equal(row.meta.capture.mode, "per_stream");
    assert.equal(h.store.messageAt(h.room.id, j.delivered[0].seq).content, "这是会议里的一句话。");
    assert.equal(calls.length, 1, "exactly one upstream transcriptions call");
    assert.equal(calls[0].auth, "Bearer sk-deployment-key", "deployment key, not a member's");
  } finally { h.close(); }
});

test("speak: text → audio in the catalog voice (deployment layer), machine door required", async () => {
  const h = await boot();
  try {
    const denied = await post(h.base, `/api/zhiyu/meetings/${h.meeting.id}/speak`, {
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(denied.status, 401);
    calls.length = 0;
    const r = await post(h.base, `/api/zhiyu/meetings/${h.meeting.id}/speak`, {
      headers: { ...h.door, "content-type": "application/json" }, body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(r.status, 200, Buffer.from(r.buf).toString().slice(0, 40));
    assert.equal(r.headers.get("content-type"), "audio/wav");
    assert.equal(r.headers.get("x-voice-used"), "tencent-tts:101001", "catalog default voice");
    assert.equal(calls.length, 1);
  } finally { h.close(); }
});

test("helpers: evidence is per_stream named; no seat → mixed; never guesses a person", () => {
  assert.equal(meetingEvidence({ meetingId: "m1", seatRef: "A@X" }).mode, "per_stream");
  const mixed = utteranceToMessage({ meetingId: "m1", seatRef: null, text: "x" });
  assert.equal(mixed.capture.mode, "mixed");
  assert.equal(mixed.memberRef, undefined, "no memberRef when nobody named");
});

test("helpers: agentVoiceFor uses the catalog and prefers the seat layer", () => {
  const r = agentVoiceFor({ seat: { model: "tencent-tts", voice: "101013" } });
  assert.deepEqual([r.model, r.voice], ["tencent-tts", "101013"]);
  const stale = agentVoiceFor({ seat: { model: "tencent-tts", voice: "101007" }, deployment: { model: "tencent-tts", voice: "101001" } });
  assert.deepEqual([stale.model, stale.voice], ["tencent-tts", "101001"], "stale seat layer skipped, deployment wins");
});

test("a meeting and its media room are one object: create names a livekit room", async () => {
  const h = await boot();
  try {
    assert.ok(h.meeting.livekitRoom, "meetingCreate sets a livekit room");
    assert.equal(h.meeting.livekitRoom, `mtg-${h.meeting.id}`, "room name derives from the meeting id");
  } finally { h.close(); }
});

test("media route: the worker asks which room to join (machine door required)", async () => {
  const h = await boot();
  try {
    const denied = await fetch(`${h.base}/api/zhiyu/meetings/${h.meeting.id}/media`);
    assert.equal(denied.status, 401);
    const r = await fetch(`${h.base}/api/zhiyu/meetings/${h.meeting.id}/media`, { headers: h.door });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.livekitRoom, `mtg-${h.meeting.id}`);
  } finally { h.close(); }
});

test("media route: an ended meeting has no media room to join (409)", async () => {
  const h = await boot();
  try {
    h.store.meetingEnd(h.meeting.id);
    const r = await fetch(`${h.base}/api/zhiyu/meetings/${h.meeting.id}/media`, { headers: h.door });
    assert.equal(r.status, 409);
  } finally { h.close(); }
});

test("to-say feed: only agent rows after the cursor, with a monotone cursor", async () => {
  const h = await boot();
  try {
    const base = `/api/zhiyu/meetings/${h.meeting.id}/to-say`;
    const empty = await (await fetch(`${h.base}${base}`, { headers: h.door })).json();
    assert.deepEqual([empty.cursor, empty.items.length], [0, 0], "nothing said yet");

    // Append an agent row and a human row; only the agent one is to speak.
    const seat = h.store.memberFor(h.room.id, "user", OWNER) || h.store.memberAdd({ roomId: h.room.id, kind: "user", ref: OWNER, display: OWNER });
    const a = h.store.messageAppend({ roomId: h.room.id, kind: "agent", fromAgent: 1, senderMemberId: seat.id, content: "我来回答。" });
    h.store.messageAppend({ roomId: h.room.id, kind: "human", senderMemberId: seat.id, content: "人类消息不念" });

    const r1 = await (await fetch(`${h.base}${base}`, { headers: h.door })).json();
    assert.equal(r1.items.length, 1, "only the agent row");
    assert.equal(r1.items[0].text, "我来回答。");
    assert.ok(r1.cursor >= a.seq);

    const r2 = await (await fetch(`${h.base}${base}?after=${r1.cursor}`, { headers: h.door })).json();
    assert.equal(r2.items.length, 0, "cursor is idempotent: nothing new");
  } finally { h.close(); }
});

test("to-say feed: the machine door is required (401)", async () => {
  const h = await boot();
  try {
    const r = await fetch(`${h.base}/api/zhiyu/meetings/${h.meeting.id}/to-say`);
    assert.equal(r.status, 401);
  } finally { h.close(); }
});
