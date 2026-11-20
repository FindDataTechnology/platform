// Meeting capture, platform side (openspec: add-meeting-capture, 2.1–2.3).
//
// Three things only provable here:
//   • the new `meeting_id` column upgrades an OLD db and leaves old rows alone
//     (`null` — which is exactly "standalone capture", today's behaviour);
//   • the create route records the meeting it was given and nothing else;
//   • the room-message artifact names a meeting stream after the MEETING, and a
//     standalone capture keeps the old `<captureId>#…` shape byte for byte.
//
// The last one matters because `streamId` is the only handle the gateway has for
// "which stream is this": a capture id changes when a stream is re-recorded,
// a meeting id does not.
//
//   node --test scripts/test-voice-capture-meeting.mjs

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  createCapture,
  ensureVoiceCaptureTables,
  finishCapture,
  insertChunk,
  beginChunk,
  finishChunk,
  getCapture,
  mergedView,
} from "../server/voice-capture.js";
import { ensureSpeakerTables } from "../server/speaker-attribution.js";
import { captureRoomMessages } from "../server/capture-room-messages.js";

const OWNER = "owner@x.test";

function fresh() {
  const db = new Database(":memory:");
  ensureVoiceCaptureTables(db);
  ensureSpeakerTables(db);
  return db;
}

function speak(handle, captureId, { seq, startMs, text, speaker }) {
  insertChunk(handle, { captureId, seq, startMs, durationMs: 2000, buffer: Buffer.from("a"), mime: "audio/webm" });
  beginChunk(handle, { captureId, seq });
  finishChunk(handle, {
    captureId,
    seq,
    ok: true,
    text,
    segments: speaker ? [{ startMs: 0, endMs: 2000, speaker, text }] : null,
  });
}

// ── 2.1 the column ──────────────────────────────────────────────────────────
test("2.1 an old db gains meeting_id and old rows read as null (standalone)", () => {
  // A db created by the PREVIOUS shape: no meeting_id at all.
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE voice_captures (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, cell_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, finished_at INTEGER,
    minutes_budget REAL NOT NULL, usd_budget REAL NOT NULL, minutes_used REAL NOT NULL DEFAULT 0,
    usd_used REAL NOT NULL DEFAULT 0, merged_text TEXT, original_text TEXT, corrected_at INTEGER,
    room_id TEXT, retain_audio_ms INTEGER NOT NULL DEFAULT 0, speaker_mode TEXT NOT NULL DEFAULT 'shared')`);
  db.prepare(
    `INSERT INTO voice_captures (id, owner, cell_id, title, status, created_at, expires_at, minutes_budget, usd_budget)
     VALUES ('cap_old', 'owner@x.test', 'c1', '旧采集', 'finished', 1, 9999999999999, 10, 1)`,
  ).run();

  ensureVoiceCaptureTables(db);
  const cols = db.prepare("PRAGMA table_info(voice_captures)").all().map((c) => c.name);
  assert.ok(cols.includes("meeting_id"), "自迁移加了 meeting_id");
  const old = getCapture(db, { id: "cap_old", owner: OWNER, now: Date.now() });
  assert.equal(old.meetingId, null, "旧行 = 散装采集，语义与改造前一致");
});

test("2.2 a capture records the meeting it was created for", () => {
  const h = fresh();
  const withMeeting = createCapture(h, { owner: OWNER, cellId: "c1", title: "会议一路", meetingId: "zym_abc" });
  assert.equal(withMeeting.meetingId, "zym_abc");

  const standalone = createCapture(h, { owner: OWNER, cellId: "c1", title: "散装" });
  assert.equal(standalone.meetingId, null, "不带会议 = 今天的形状");

  // Overlong ids are trimmed rather than rejected: the meeting store caps at 64.
  const long = createCapture(h, { owner: OWNER, cellId: "c1", meetingId: "z".repeat(200) });
  assert.equal(long.meetingId.length, 64);
});

// ── 2.3 streamId ────────────────────────────────────────────────────────────
test("2.3 a meeting stream is named after the meeting; a standalone one is unchanged", () => {
  const h = fresh();
  const meetingCap = createCapture(h, {
    owner: OWNER,
    cellId: "c1",
    title: "会议一路",
    speakerMode: "session",
    meetingId: "zym_abc",
  });
  speak(h, meetingCap.id, { seq: 0, startMs: 0, text: "我同意", speaker: null });
  finishCapture(h, { id: meetingCap.id, owner: OWNER });
  const meetingRows = captureRoomMessages({
    capture: getCapture(h, { id: meetingCap.id, owner: OWNER }),
    view: mergedView(h, getCapture(h, { id: meetingCap.id, owner: OWNER })),
  });
  assert.equal(meetingRows.messages.length, 1);
  assert.match(meetingRows.messages[0].meta.capture.streamId, /^zym_abc#/, "会议流的 streamId 以会议 id 开头");
  assert.equal(meetingRows.messages[0].meta.meetingId, "zym_abc", "消息 meta 带会议标识，读面才能按会议分组");
  // session 模式走的是「本场声明」这一条合法来源，所以是 declaredMemberId 而不是 seatOwner。
  assert.equal(meetingRows.messages[0].meta.capture.declaredMemberId, OWNER);

  const loose = createCapture(h, { owner: OWNER, cellId: "c1", title: "散装", speakerMode: "session" });
  speak(h, loose.id, { seq: 0, startMs: 0, text: "一个人", speaker: null });
  finishCapture(h, { id: loose.id, owner: OWNER });
  const looseRows = captureRoomMessages({
    capture: getCapture(h, { id: loose.id, owner: OWNER }),
    view: mergedView(h, getCapture(h, { id: loose.id, owner: OWNER })),
  });
  assert.equal(
    looseRows.messages[0].meta.capture.streamId,
    `${loose.id}#${OWNER}`,
    "散装采集的 streamId 仍是 <captureId>#<成员>，逐字不变",
  );
  assert.equal(looseRows.messages[0].meta.meetingId, null);
});
