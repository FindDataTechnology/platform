#!/usr/bin/env node
// Capture sessions: storage contract, chunk idempotency, timeline validation,
// merge determinism, budget gates, retention (openspec: add-voice-capture-lane,
// tasks 1.1 / 2.1–2.4 / 3.1–3.4 / 4.1–4.2).
//
// The properties pinned here are the ones a UI cannot repair later:
//   • a duplicate (capture, seq) is rejected by STORAGE, so a second text or a
//     second charge is impossible even if a caller forgets to check;
//   • out-of-order chunks are accepted and merged by seq — never by arrival;
//   • merge is deterministic byte-for-byte, drops silent slices without leaving
//     blank lines, and removes a boundary overlap exactly once;
//   • the two budget gates stop NEW transcription without making finished text
//     unreadable;
//   • audio dies on success (retain=0) but survives a FAILURE so a retry needs
//     no re-upload.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const {
  ensureVoiceCaptureTables,
  createCapture,
  getCapture,
  listCaptures,
  insertChunk,
  getChunk,
  listChunks,
  checkTimeline,
  beginChunk,
  finishChunk,
  durationOfChunks,
  budgetGate,
  mergeChunks,
  finishCapture,
  correctCapture,
  abandonCapture,
  sweepCaptures,
  newCaptureId,
} = await import("../server/voice-capture.js");

const OWNER = "owner@x.test";
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

function fresh() {
  const db = new Database(":memory:");
  ensureVoiceCaptureTables(db);
  return db;
}

const chunk = (over = {}) => ({
  captureId: "cap",
  seq: 1,
  startMs: 0,
  durationMs: 10_000,
  buffer: Buffer.from("audio"),
  mime: "audio/m4a",
  now: NOW,
  ...over,
});

// ── 1.1 storage ───────────────────────────────────────────────────────────

test("the two tables are created idempotently with every column", () => {
  const db = fresh();
  ensureVoiceCaptureTables(db); // second boot must not throw
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of [
    "id",
    "owner",
    "cell_id",
    "title",
    "status",
    "created_at",
    "expires_at",
    "minutes_budget",
    "usd_budget",
    "minutes_used",
    "usd_used",
    "merged_text",
    "original_text",
    "corrected_at",
    "room_id",
    "retain_audio_ms",
  ]) {
    assert.ok(cols("voice_captures").includes(c), `voice_captures missing ${c}`);
  }
  for (const c of ["capture_id", "seq", "start_ms", "duration_ms", "status", "text", "attempts", "audio", "bytes", "mime", "transcribing_at"]) {
    assert.ok(cols("voice_capture_chunks").includes(c), `voice_capture_chunks missing ${c}`);
  }
});

test("a duplicate (capture, seq) is rejected by the unique constraint", () => {
  const db = fresh();
  createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  const first = insertChunk(db, chunk());
  assert.equal(first.ok, true);
  const second = insertChunk(db, chunk({ buffer: Buffer.from("other") }));
  assert.equal(second.ok, false);
  assert.equal(second.code, "chunk_exists");
  // And the stored audio is still the FIRST one — a retry cannot overwrite it.
  const row = db.prepare("SELECT audio FROM voice_capture_chunks WHERE seq = 1").get();
  assert.equal(row.audio.toString(), "audio");
});

test("capture ids are unpredictable and owner-scoped reads are single-answer", () => {
  const a = newCaptureId();
  const b = newCaptureId();
  assert.notEqual(a, b);
  assert.match(a, /^cap_[A-Za-z0-9_-]{20,}$/);
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  assert.equal(getCapture(db, { id: cap.id, owner: OWNER, now: NOW })?.id, cap.id);
  assert.equal(getCapture(db, { id: cap.id, owner: "other@x.test", now: NOW }), null);
  assert.equal(getCapture(db, { id: "cap_nope", owner: OWNER, now: NOW }), null);
  assert.equal(listCaptures(db, { owner: OWNER, now: NOW }).length, 1);
  assert.equal(listCaptures(db, { owner: "other@x.test", now: NOW }).length, 0);
});

// ── 2.x chunk semantics ───────────────────────────────────────────────────

test("chunks are accepted out of order and read back by seq", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  for (const [seq, startMs] of [[3, 60_000], [1, 0], [2, 30_000]]) {
    const r = insertChunk(db, chunk({ captureId: cap.id, seq, startMs }));
    assert.equal(r.ok, true, `seq ${seq}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(listChunks(db, { captureId: cap.id }).map((c) => c.seq), [1, 2, 3]);
});

test("a non-monotonic start_ms is refused and names the conflicting slice", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1, startMs: 0 }));
  insertChunk(db, chunk({ captureId: cap.id, seq: 3, startMs: 60_000 }));

  const late = checkTimeline(db, { captureId: cap.id, seq: 2, startMs: 0 });
  assert.equal(late.ok, false);
  assert.equal(late.code, "timeline_conflict");
  assert.equal(late.detail.conflictingSeq, 1, "the conflicting neighbour is named");

  const far = checkTimeline(db, { captureId: cap.id, seq: 4, startMs: 10_000 });
  assert.equal(far.ok, false);
  assert.equal(far.detail.conflictingSeq, 3);

  assert.equal(checkTimeline(db, { captureId: cap.id, seq: 2, startMs: 30_000 }).ok, true);
});

test("a failed chunk can be retried alone and keeps its audio for the retry", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1, startMs: 0 }));
  insertChunk(db, chunk({ captureId: cap.id, seq: 2, startMs: 10_000 }));
  assert.equal(beginChunk(db, { captureId: cap.id, seq: 1 }).ok, true);
  finishChunk(db, { captureId: cap.id, seq: 1, ok: false, errorCode: "upstream_error", now: NOW });
  assert.equal(getChunk(db, { captureId: cap.id, seq: 1 }).status, "failed");
  assert.equal(getChunk(db, { captureId: cap.id, seq: 1 }).hasAudio, true, "a retry must not need a re-upload");

  // Retrying re-runs only this slice.
  assert.equal(beginChunk(db, { captureId: cap.id, seq: 1 }).ok, true);
  assert.equal(getChunk(db, { captureId: cap.id, seq: 1 }).attempts, 2);
  finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "第一段", now: NOW });
  const done = getChunk(db, { captureId: cap.id, seq: 1 });
  assert.equal(done.status, "done");
  assert.equal(done.text, "第一段");
  assert.equal(done.hasAudio, false, "audio dies with a successful transcription");
});

test("a done chunk is not retryable, so its text and charge cannot change", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1 }));
  beginChunk(db, { captureId: cap.id, seq: 1 });
  finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "一", now: NOW });
  const again = beginChunk(db, { captureId: cap.id, seq: 1 });
  assert.equal(again.ok, false);
  assert.equal(again.code, "chunk_not_retryable");
});

test("an expired capture stops accepting chunks but stays readable", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW, options: { ttlMs: 1000 } });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1 }));
  beginChunk(db, { captureId: cap.id, seq: 1 });
  finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "已完成的文本", now: NOW });

  const later = NOW + 5000;
  assert.equal(getCapture(db, { id: cap.id, owner: OWNER, now: later }).status, "expired");
  // The finished text is still there.
  assert.equal(listChunks(db, { captureId: cap.id })[0].text, "已完成的文本");
});

// ── 3.2/3.3 merge ─────────────────────────────────────────────────────────

test("merge is deterministic byte-for-byte and ordered by seq", () => {
  const rows = [
    { seq: 2, start_ms: 30_000, status: "done", text: "第二段内容" },
    { seq: 1, start_ms: 0, status: "done", text: "第一段内容" },
  ];
  const a = mergeChunks(rows);
  const b = mergeChunks([...rows].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.text, "第一段内容第二段内容");
  assert.deepEqual(a.segments.map((s) => s.startMs), [0, 30_000]);
});

test("a silent slice produces no blank line", () => {
  const out = mergeChunks([
    { seq: 1, start_ms: 0, status: "done", text: "开头" },
    { seq: 2, start_ms: 1000, status: "done", text: "   " },
    { seq: 3, start_ms: 2000, status: "done", text: "结尾" },
  ]);
  assert.equal(out.text, "开头结尾");
  assert.equal(out.segments.length, 2);
  assert.equal(/\n{2,}/.test(out.text), false);
});

test("a sentence cut across two slices appears exactly once", () => {
  // The same words were transcribed at the tail of slice 1 and the head of 2.
  const out = mergeChunks([
    { seq: 1, start_ms: 0, status: "done", text: "我们今天讨论三件事，第一是预算安排" },
    { seq: 2, start_ms: 5000, status: "done", text: "第一是预算安排，第二是排期" },
  ]);
  assert.equal(out.text, "我们今天讨论三件事，第一是预算安排，第二是排期");
  assert.equal(out.text.split("第一是预算安排").length - 1, 1, "the overlap appears exactly once");
});

test("latin slices get a space at the seam, CJK gets none", () => {
  assert.equal(
    mergeChunks([
      { seq: 1, start_ms: 0, status: "done", text: "we reviewed the budget" },
      { seq: 2, start_ms: 5000, status: "done", text: "and the schedule" },
    ]).text,
    "we reviewed the budget and the schedule",
  );
  assert.equal(
    mergeChunks([
      { seq: 1, start_ms: 0, status: "done", text: "预算" },
      { seq: 2, start_ms: 5000, status: "done", text: "排期" },
    ]).text,
    "预算排期",
  );
});

test("only done slices are merged — a failed or pending one is never invented", () => {
  const out = mergeChunks([
    { seq: 1, start_ms: 0, status: "done", text: "已完成的" },
    { seq: 2, start_ms: 1000, status: "failed", text: "" },
    { seq: 3, start_ms: 2000, status: "pending", text: "" },
  ]);
  assert.equal(out.text, "已完成的");
  assert.equal(out.segments.length, 1);
});

// ── 3.4 finish + correction ───────────────────────────────────────────────

test("finish stores both the merge and its pristine copy; one correction keeps both", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1, startMs: 0, durationMs: 60_000 }));
  beginChunk(db, { captureId: cap.id, seq: 1 });
  finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "原始归并文本", now: NOW });

  const fin = finishCapture(db, { id: cap.id, owner: OWNER, now: NOW });
  assert.equal(fin.ok, true);
  assert.equal(fin.capture.status, "finished");
  assert.equal(fin.capture.mergedText, "原始归并文本");
  assert.equal(fin.capture.originalText, "原始归并文本");
  assert.equal(fin.capture.used.minutes, 1, "60s of audio = 1 minute");

  const fixed = correctCapture(db, { id: cap.id, owner: OWNER, text: "订正后的文本", now: NOW });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.capture.mergedText, "订正后的文本");
  assert.equal(fixed.capture.originalText, "原始归并文本", "the pristine merge stays traceable");
  assert.equal(fixed.capture.correctedAt, NOW);

  const twice = correctCapture(db, { id: cap.id, owner: OWNER, text: "再改一次", now: NOW });
  assert.equal(twice.ok, false);
  assert.equal(twice.code, "already_corrected", "one correction, as specified");
});

test("finishing twice is idempotent, and finishing before any chunk still works", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  const first = finishCapture(db, { id: cap.id, owner: OWNER, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.capture.mergedText, "");
  const second = finishCapture(db, { id: cap.id, owner: OWNER, now: NOW });
  assert.equal(second.already, true);
});

// ── 2.4 abandon ───────────────────────────────────────────────────────────

test("abandon deletes audio and text and hides the capture from the list", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1 }));
  beginChunk(db, { captureId: cap.id, seq: 1 });
  finishChunk(db, { captureId: cap.id, seq: 1, ok: false, errorCode: "upstream_error", now: NOW });
  finishCapture(db, { id: cap.id, owner: OWNER, now: NOW });

  assert.equal(abandonCapture(db, { id: cap.id, owner: OWNER, now: NOW }).ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM voice_capture_chunks WHERE capture_id = ?").get(cap.id).n, 0);
  const row = db.prepare("SELECT status, merged_text FROM voice_captures WHERE id = ?").get(cap.id);
  assert.equal(row.status, "abandoned");
  assert.equal(row.merged_text, null);
  assert.equal(listCaptures(db, { owner: OWNER, now: NOW }).length, 0);
  // And it is gone for its owner too, not just from the list.
  assert.equal(abandonCapture(db, { id: cap.id, owner: OWNER, now: NOW }).ok, true, "abandon is idempotent");
});

// ── 4.1 budget gates ──────────────────────────────────────────────────────

test("the minutes gate stops new transcription and says where it stopped", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW, options: { minutesBudget: 2 } });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1, startMs: 0, durationMs: 120_000 }));
  beginChunk(db, { captureId: cap.id, seq: 1 });
  finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "已转写两分钟", now: NOW });
  finishCapture(db, { id: cap.id, owner: OWNER, now: NOW });

  const after = getCapture(db, { id: cap.id, owner: OWNER, now: NOW });
  assert.equal(after.used.minutes, 2);
  assert.equal(budgetGate(after), "minutes");
  // The finished part stays readable — a tripped gate never hides work.
  assert.equal(after.mergedText, "已转写两分钟");
});

test("the usd gate is independent of the minutes gate", () => {
  const capture = { used: { minutes: 1, usd: 6 }, budget: { minutes: 120, usd: 6 } };
  assert.equal(budgetGate(capture), "usd");
  assert.equal(budgetGate({ used: { minutes: 0, usd: 0 }, budget: { minutes: 120, usd: 6 } }), null);
});

test("duration falls back to the next slice's start, then to a byte estimate", () => {
  const rows = [
    { seq: 1, start_ms: 0, duration_ms: null, bytes: 0 },
    { seq: 2, start_ms: 30_000, duration_ms: null, bytes: 0 },
    { seq: 3, start_ms: 60_000, duration_ms: null, bytes: 6000 },
  ];
  // 30s (from the next start) + 30s (from the next start) + 1s (6000 B ≈ 6 kB/s)
  assert.equal(durationOfChunks(rows), 30_000 + 30_000 + 1000);
});

// ── 4.2 retention sweep ───────────────────────────────────────────────────

test("the sweep expires recordings and purges audio only after its own window", () => {
  const db = fresh();
  const short = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW, options: { ttlMs: 1000, retainAudioMs: 500 } });
  const long = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW, options: { ttlMs: 10 * 60_000, retainAudioMs: 60 * 60_000 } });
  for (const cap of [short, long]) {
    insertChunk(db, chunk({ captureId: cap.id, seq: 1 }));
    beginChunk(db, { captureId: cap.id, seq: 1 });
    finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "文本", now: NOW });
  }

  const first = sweepCaptures(db, { now: NOW + 2000 });
  assert.equal(first.expired, 1, "only the short capture expired");
  assert.equal(first.purgedAudio, 1, "only the short capture's retain window elapsed");

  const second = sweepCaptures(db, { now: NOW + 2000 });
  assert.equal(second.expired, 0, "the sweep is idempotent");
  assert.equal(second.purgedAudio, 0);

  // The long-retention capture still has its audio at that point.
  const still = getChunk(db, { captureId: long.id, seq: 1 });
  assert.equal(still.hasAudio, true);
});

test("a slice whose request died mid-flight is freed by the sweep, then retried", () => {
  const db = fresh();
  const cap = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW });
  insertChunk(db, chunk({ captureId: cap.id, seq: 1 }));
  // A reservation that never settled — exactly what a process restart leaves.
  assert.equal(beginChunk(db, { captureId: cap.id, seq: 1, now: NOW }).ok, true);
  assert.equal(getChunk(db, { captureId: cap.id, seq: 1 }).status, "transcribing");
  assert.equal(beginChunk(db, { captureId: cap.id, seq: 1, now: NOW }).code, "chunk_busy");

  // Too early: still in flight, so the sweep must leave it alone.
  const early = sweepCaptures(db, { now: NOW + 5_000 });
  assert.equal(early.requeued, 0);
  assert.equal(getChunk(db, { captureId: cap.id, seq: 1 }).status, "transcribing");

  // Past the deadline it becomes a normal retryable failure which KEEPS the
  // audio, so the retry costs one request and no re-upload.
  const later = sweepCaptures(db, { now: NOW + 11 * 60_000 });
  assert.equal(later.requeued, 1);
  const freed = getChunk(db, { captureId: cap.id, seq: 1 });
  assert.equal(freed.status, "failed");
  assert.equal(freed.errorCode, "stale_transcribing");
  assert.equal(freed.hasAudio, true);

  assert.equal(beginChunk(db, { captureId: cap.id, seq: 1, now: NOW + 11 * 60_000 }).ok, true);
  finishChunk(db, { captureId: cap.id, seq: 1, ok: true, text: "补上的文本", now: NOW + 11 * 60_000 });
  assert.equal(getChunk(db, { captureId: cap.id, seq: 1 }).text, "补上的文本");
});
