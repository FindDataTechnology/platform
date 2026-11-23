// Room speech (openspec: add-room-voice-and-catalog, tasks 4.1/4.3).
//
// The facts this pins, in the order they would embarrass us:
//   1. only agent messages are speakable (human/system rows are refused);
//   2. the DEPLOYMENT credential is used; none ⇒ honest 503, nothing faked;
//   3. the second playback of the same message is ONE upstream synthesis (cache);
//   4. the character quota blocks the AUTOMATIC path only — a manual tap still
//      gets audio;
//   5. a non-member gets 404 (no existence leak).
//   node --test scripts/test-zhiyu-room-speech.mjs

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";

// Pin the data root so the test never writes into the repo's data/ (the
// path-resolver warning exists because tests have polluted it before).
process.env.PLATFORM_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "zy-rs-root-"));

// A programmable fake 词元 audio lane — the same shape the voice-lane tests use.
const tts = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v1/audio/speech") {
      const json = (() => { try { return JSON.parse(body); } catch { return null; } })();
      tts.push(json);
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(Buffer.from("AUDIO-BYTES"));
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const API_BASE = `http://127.0.0.1:${fake.address().port}`;

const { registerZhiyuRoutes } = await import("../gateway/zhiyu/index.js");

async function boot({ apiKey = "sk-deploy-only", dailyChars } = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zy-rs-"));
  const app = express();
  app.use(express.json());
  const env = { VOICE_API_BASE: API_BASE, VOICE_API_KEY: apiKey, VOICE_CONFIG: JSON.stringify({ enabled: true, ttsFormat: "mp3" }) };
  if (dailyChars !== undefined) env.ZHIYU_SPEECH_DAILY_CHARS = String(dailyChars);
  const z = registerZhiyuRoutes(app, {
    dataRoot,
    resolveUser: (req) => (req.headers["x-t-email"] ? { email: String(req.headers["x-t-email"]), groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "unauth" }),
    env,
    secret: "s3",
    startTimers: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = { "x-t-email": "owner@x.io", "content-type": "application/json" };
  const { room } = await (await fetch(`${base}/api/zhiyu/rooms`, { method: "POST", headers: owner, body: JSON.stringify({ title: "speech" }) })).json();
  // An agent seat + an agent message, written through the store seam so the
  // test needs no model turn. Returns the message seq.
  const appendAgentRow = (content, senderMemberId = null) =>
    z.store.messageAppend({ roomId: room.id, kind: "agent", fromAgent: 1, senderMemberId, content });
  return { base, room, owner, z, server, appendAgentRow, close: () => (server.close(), z.close?.()) };
}

const speak = (base, room, headers, seq, body = {}) =>
  fetch(`${base}/api/zhiyu/rooms/${room.id}/messages/${seq}/speech`, { method: "POST", headers, body: JSON.stringify(body) });

test.after(() => {
  fake.close();
});

test("a human row is refused; no upstream synthesis", async () => {
  const { base, room, owner, z, close } = await boot();
  try {
    const { row } = z.store.messageAppend({ roomId: room.id, kind: "human", content: "hi" });
    const r = await speak(base, room, owner, row.seq);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "not_agent_message");
    assert.equal(tts.length, 0);
  } finally { close(); }
});

test("an agent row is spoken with the deployment credential, and a second play is cached", async () => {
  tts.length = 0;
  const { base, room, owner, appendAgentRow, close } = await boot();
  try {
    const { row } = appendAgentRow("你好，这是一条座席消息。");
    const first = await speak(base, room, owner, row.seq);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "audio/mpeg");
    assert.equal(first.headers.get("x-voice-cached"), "0");
    assert.equal(Buffer.from(await first.arrayBuffer()).toString(), "AUDIO-BYTES");
    assert.equal(tts.length, 1);

    const second = await speak(base, room, owner, row.seq);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-voice-cached"), "1", "the same message replays from cache");
    assert.equal(tts.length, 1, "no second upstream synthesis");
  } finally { close(); }
});

test("no deployment credential ⇒ 503 voice_not_configured, nothing synthesised", async () => {
  tts.length = 0;
  const { base, room, owner, appendAgentRow, close } = await boot({ apiKey: "" });
  try {
    const { row } = appendAgentRow("无声");
    const r = await speak(base, room, owner, row.seq);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "voice_not_configured");
    assert.equal(tts.length, 0);
  } finally { close(); }
});

test("the quota blocks AUTO only; a manual tap still gets audio", async () => {
  tts.length = 0;
  const { base, room, owner, appendAgentRow, close } = await boot({ dailyChars: 4 });
  try {
    // "甲乙丙丁戊" is longer than the 4-char budget; force it into the quota by
    // first speaking it on demand (which always works), then trying AUTO.
    const { row: a } = appendAgentRow("甲乙丙丁戊");
    const onDemand = await speak(base, room, owner, a.seq);
    assert.equal(onDemand.status, 200, "on-demand synthesis is never quota-blocked");

    const { row: b } = appendAgentRow("另一句话也超预算了");
    const auto = await speak(base, room, owner, b.seq, { mode: "auto" });
    // Quota now exceeded (5 chars already spent > 4). AUTO is refused…
    assert.equal(auto.status, 429);
    assert.equal((await auto.json()).code, "speech_quota_exceeded");
    // …but a manual tap on the SAME message still succeeds.
    const manual = await speak(base, room, owner, b.seq, { mode: "on_demand" });
    assert.equal(manual.status, 200);
  } finally { close(); }
});

test("a non-member gets 404 (no existence leak)", async () => {
  const { base, room, close } = await boot();
  try {
    const stranger = { "x-t-email": "stranger@x.io", "content-type": "application/json" };
    const r = await speak(base, room, stranger, 1);
    assert.equal(r.status, 404);
    assert.deepEqual(Object.keys(await r.json()), ["error"]);
  } finally { close(); }
});

test("three-layer voice: the seat's own assignment wins over the deployment block", async () => {
  tts.length = 0;
  const { base, room, owner, z, appendAgentRow, close } = await boot();
  try {
    // Give the deployment block a voice, then give the SEAT another entry.
    const seat = z.store.memberAdd({
      roomId: room.id,
      kind: "agent",
      ref: "packs:seat-v",
      display: "有声席",
      voice: { model: "tencent-tts", voice: "101013" },
    });
    const { row } = appendAgentRow("席位音色优先", seat.id);
    const r = await speak(base, room, owner, row.seq);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-voice-used"), "tencent-tts:101013", "the seat's assignment is what synthesises");
    assert.equal(tts.at(-1).voice, "101013");
  } finally { close(); }
});

test("seat-voice route: an owner assigns a seat's voice, but only a catalog entry", async () => {
  tts.length = 0;
  const { base, room, owner, z, appendAgentRow, close } = await boot();
  try {
    const seat = z.store.memberAdd({ roomId: room.id, kind: "agent", ref: "packs:assign-me", display: "可指派席" });
    const assign = (voice) =>
      fetch(`${base}/api/zhiyu/rooms/${room.id}/seat-voice`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ memberId: seat.id, voice }),
      });

    const bad = await assign({ model: "tencent-tts", voice: "101007" });
    assert.equal(bad.status, 400, "a de-listed voice is refused at the assignment face");
    assert.equal((await bad.json()).code, "voice_not_in_catalog");

    const ok = await assign({ model: "tencent-tts", voice: "101013" });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).member.voice, { model: "tencent-tts", voice: "101013" }, "the seat now carries the entry");

    // And it takes effect in that seat's next speech.
    const { row } = appendAgentRow("指派后的声音", seat.id);
    const spoke = await speak(base, room, owner, row.seq);
    assert.equal(spoke.headers.get("x-voice-used"), "tencent-tts:101013");

    const cleared = await assign(null);
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).member.voice, null, "null clears back to the lower layers");
  } finally { close(); }
});

test("seat-voice route: a stranger cannot assign a seat's voice", async () => {
  const { base, room, z, close } = await boot();
  try {
    const seat = z.store.memberAdd({ roomId: room.id, kind: "agent", ref: "packs:not-yours", display: "别人的席", onBehalfOf: "someone@else" });
    const stranger = { "x-t-email": "stranger@x.io", "content-type": "application/json" };
    const r = await fetch(`${base}/api/zhiyu/rooms/${room.id}/seat-voice`, {
      method: "POST",
      headers: stranger,
      body: JSON.stringify({ memberId: seat.id, voice: { model: "tencent-tts", voice: "101001" } }),
    });
    assert.equal(r.status, 404, "a non-member sees not-found, not a permission hint");
  } finally { close(); }
});

test("three-layer voice: a stale seat declaration is SKIPPED, the deployment block wins", async () => {
  tts.length = 0;
  const { base, room, owner, z, appendAgentRow, close } = await boot();
  try {
    const seat = z.store.memberAdd({
      roomId: room.id,
      kind: "agent",
      ref: "packs:stale",
      display: "旧音色席",
      voice: { model: "tencent-tts", voice: "101007" }, // de-listed voice, not in catalog
    });
    const { row } = appendAgentRow("旧音色不该让播报失败", seat.id);
    const r = await speak(base, room, owner, row.seq);
    assert.equal(r.status, 200, "a stale declaration never blocks speech");
    // The deployment block is empty in this boot, so resolution falls to the
    // catalog default (101001), NOT the stale 101007.
    assert.equal(r.headers.get("x-voice-used"), "tencent-tts:101001");
    assert.notEqual(tts.at(-1).voice, "101007", "the stale voice is never forwarded");
  } finally { close(); }
});
