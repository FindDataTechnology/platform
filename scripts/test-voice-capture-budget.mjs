// The dual budget gate (openspec: add-voice-capture-lane, task 4.1).
//
// The shape being pinned: hitting a ceiling stops NEW transcription but never
// destroys work and never destroys audio. That asymmetry is the whole decision —
// a plain 429 would be simpler and would lose the user's recording, so the test
// asserts both halves: nothing more is transcribed, and the slice is still there.
//
//   node --test scripts/test-voice-capture-budget.mjs

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const {
  ensureVoiceCaptureTables,
  createCapture,
  getCapture,
  insertChunk,
  beginChunk,
  finishChunk,
  durationOfChunks,
  budgetGate,
} = await import("../server/voice-capture.js");

const OWNER = "owner@x.test";
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

function fresh(options) {
  const db = new Database(":memory:");
  ensureVoiceCaptureTables(db);
  const capture = createCapture(db, { owner: OWNER, cellId: "cell", now: NOW, options });
  return { db, capture };
}

const transcribe = (db, captureId, { seq, startMs, durationMs, text }) => {
  insertChunk(db, { captureId, seq, startMs, durationMs, buffer: Buffer.from("a"), mime: "audio/mp4", now: NOW });
  beginChunk(db, { captureId, seq, now: NOW });
  finishChunk(db, { captureId, seq, ok: true, text, now: NOW });
  // The route recomputes usage from the rows; mirror that here.
  const rows = db
    .prepare("SELECT seq, start_ms, duration_ms, bytes FROM voice_capture_chunks WHERE capture_id = ? AND attempts > 0")
    .all(captureId);
  const minutes = durationOfChunks(rows) / 60_000;
  db.prepare("UPDATE voice_captures SET minutes_used = ? WHERE id = ?").run(minutes, captureId);
  return getCapture(db, { id: captureId, owner: OWNER, now: NOW });
};

test("an untouched capture trips neither gate", () => {
  const { capture } = fresh();
  assert.equal(budgetGate(capture), null);
  assert.equal(capture.budget.minutes, 120, "default minutes ceiling");
  assert.equal(capture.budget.usd, 6, "default usd ceiling");
});

test("the minutes gate trips exactly at the ceiling, and the work already done stays readable", () => {
  const { db, capture } = fresh({ minutesBudget: 30 });
  let after = null;
  for (let seq = 0; seq < 3; seq += 1) {
    after = transcribe(db, capture.id, { seq, startMs: seq * 600_000, durationMs: 600_000, text: `第${seq}十分钟` });
    if (seq < 2) assert.equal(budgetGate(after), null, `gate must stay open at ${after.used.minutes} min`);
  }
  assert.equal(after.used.minutes, 30);
  assert.equal(budgetGate(after), "minutes", "30 of 30 minutes is at the ceiling");
  // The text of the transcribed slices is untouched by the gate.
  const stored = db.prepare("SELECT text FROM voice_capture_chunks WHERE capture_id = ? ORDER BY seq").all(capture.id);
  assert.deepEqual(
    stored.map((r) => r.text),
    ["第0十分钟", "第1十分钟", "第2十分钟"],
  );
});

test("the slice that arrives past the gate is STORED and not transcribed", () => {
  const { db, capture } = fresh({ minutesBudget: 1 });
  const after = transcribe(db, capture.id, { seq: 0, startMs: 0, durationMs: 60_000, text: "已转写的一分钟" });
  assert.equal(budgetGate(after), "minutes");

  // Buffering past the gate: audio in, no attempts, status pending.
  insertChunk(db, { captureId: capture.id, seq: 1, startMs: 60_000, durationMs: 60_000, buffer: Buffer.from("a"), mime: "audio/mp4", now: NOW });
  const buffered = db.prepare("SELECT status, attempts, audio FROM voice_capture_chunks WHERE capture_id = ? AND seq = 1").get(capture.id);
  assert.equal(buffered.status, "pending");
  assert.equal(buffered.attempts, 0, "no transcription was attempted");
  assert.ok(buffered.audio, "the audio is still here — it is the user's recording, not ours to drop");

  // And because it was never attempted, it did not push usage past the ceiling.
  const still = getCapture(db, { id: capture.id, owner: OWNER, now: NOW });
  assert.equal(still.used.minutes, 1, "buffered audio is not billed as transcribed minutes");
});

test("the usd gate is independent: a generous minutes ceiling does not mask it", () => {
  const { db, capture } = fresh({ minutesBudget: 1_000, usdBudget: 0.5 });
  const after = transcribe(db, capture.id, { seq: 0, startMs: 0, durationMs: 60_000, text: "一分钟" });
  // usageOf() writes usd from the price; do the same here.
  db.prepare("UPDATE voice_captures SET usd_used = ? WHERE id = ?").run(0.75, capture.id);
  const gated = getCapture(db, { id: capture.id, owner: OWNER, now: NOW });
  assert.equal(gated.used.minutes, 1);
  assert.equal(budgetGate(gated), "usd");
  assert.ok(after.used.minutes < gated.budget.minutes);
});

test("a ceiling of zero closes the gate before the first slice, not after a charge", () => {
  const { capture } = fresh({ minutesBudget: 0 });
  assert.equal(budgetGate(capture), "minutes");
});

test("both gates tripped at once reports the minutes gate first (a stable answer)", () => {
  const capture = { used: { minutes: 5, usd: 5 }, budget: { minutes: 5, usd: 5 } };
  assert.equal(budgetGate(capture), "minutes", "one answer, and the same one every time");
});
