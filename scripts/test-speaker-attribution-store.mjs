// The capture record's speaker contract (openspec: add-speaker-attribution, 3.1 / D7).
//
// D7 says the segment record gains a NULLABLE speaker plus a normalised end
// offset, and that NULL means "unknown" — the same thing today's render path
// already assumes, so nothing is backfilled. What this file pins is the part a
// schema change could quietly get wrong:
//
//   1. one speaker in the slice   → that name lands, end_ms is ABSOLUTE
//   2. the lane's sentinel        → NULL, never a person called "UNKNOWN"
//   3. two voices in one slice    → NULL (mixed), detail kept for the merge
//   4. no segments at all         → all three columns NULL — byte-for-byte the
//                                  behaviour from before this change
//
// Case 3 is the reason the whole capability exists: collapsing a two-voice slice
// into one name is a WRONG attribution, which is worse than none (D8).
//
//   node --test scripts/test-speaker-attribution-store.mjs

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  beginChunk,
  createCapture,
  deriveChunkSegments,
  ensureVoiceCaptureTables,
  finishChunk,
  getChunk,
  insertChunk,
} from "../server/voice-capture.js";
import { SPEAKER_UNKNOWN } from "../server/speaker-attribution.js";

function freshHandle() {
  const db = new Database(":memory:");
  ensureVoiceCaptureTables(db);
  return db;
}

function doneChunk(handle, captureId, { seq, startMs, segments, text = "x" }) {
  insertChunk(handle, { captureId, seq, startMs, durationMs: 1000, buffer: Buffer.from("a"), mime: "audio/webm" });
  beginChunk(handle, { captureId, seq });
  finishChunk(handle, { captureId, seq, ok: true, text, segments });
  return getChunk(handle, { captureId, seq });
}

test("3.1 one speaker: the name lands and end_ms is absolute in the capture timeline", () => {
  const handle = freshHandle();
  const cap = createCapture(handle, { owner: "o@test", cellId: "c1", title: "t" });
  const chunk = doneChunk(handle, cap.id, {
    seq: 0,
    startMs: 4000,
    segments: [
      { startMs: 0, endMs: 700, speaker: "李四", text: "a" },
      { startMs: 700, endMs: 1800, speaker: "李四", text: "b" },
    ],
  });
  assert.equal(chunk.speaker, "李四");
  assert.equal(chunk.endMs, 5800, "4000 + last segment endMs 1800");
  assert.equal(chunk.segments.length, 2, "the detail survives for the merge");
});

test("3.1 the sentinel is not a name: it stores as NULL", () => {
  const handle = freshHandle();
  const cap = createCapture(handle, { owner: "o@test", cellId: "c1", title: "t" });
  const chunk = doneChunk(handle, cap.id, {
    seq: 0,
    startMs: 5000,
    segments: [{ startMs: 0, endMs: 800, speaker: SPEAKER_UNKNOWN, text: "a" }],
  });
  assert.equal(chunk.speaker, null, `"UNKNOWN" is ${SPEAKER_UNKNOWN} — a sentinel, not a person`);
  assert.equal(chunk.endMs, 5800);
});

test("3.1 two voices in one slice are NOT collapsed — NULL, with the detail kept", () => {
  const handle = freshHandle();
  const cap = createCapture(handle, { owner: "o@test", cellId: "c1", title: "t" });
  const chunk = doneChunk(handle, cap.id, {
    seq: 0,
    startMs: 9000,
    segments: [
      { startMs: 0, endMs: 300, speaker: "李四", text: "a" },
      { startMs: 300, endMs: 700, speaker: "王五", text: "b" },
    ],
  });
  assert.equal(chunk.speaker, null, "a mixed slice must not be attributed to whichever came first");
  assert.deepEqual(chunk.segments.map((s) => s.speaker), ["李四", "王五"]);
  assert.equal(chunk.endMs, 9700);
});

test("3.1 no segments at all: every new column is NULL (the pre-change behaviour)", () => {
  const handle = freshHandle();
  const cap = createCapture(handle, { owner: "o@test", cellId: "c1", title: "t" });
  const chunk = doneChunk(handle, cap.id, { seq: 0, startMs: 12000, segments: null });
  assert.equal(chunk.speaker, null);
  assert.equal(chunk.endMs, null);
  assert.equal(chunk.segments, null);
  assert.equal(chunk.text, "x", "the text path is untouched");
});

test("3.1 derivation is a pure function: blank labels and missing offsets never invent values", () => {
  assert.deepEqual(deriveChunkSegments({ segments: [] }), { speaker: null, endMs: null, segmentsJson: null });
  assert.equal(deriveChunkSegments({ segments: [{ speaker: "  ", endMs: 5 }] }).speaker, null);
  // No finite start → end_ms stays unknown rather than guessing from a duration.
  assert.equal(deriveChunkSegments({ segments: [{ speaker: "A", endMs: 5 }] }).endMs, null);
  // A known start with no usable segment end falls back to start + duration.
  assert.equal(deriveChunkSegments({ segments: [{ speaker: "A" }], startMs: 100, durationMs: 900 }).endMs, 1000);
});
