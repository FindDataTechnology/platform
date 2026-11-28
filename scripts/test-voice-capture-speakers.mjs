// 导出/入房与归并共用同一份分段（openspec: add-speaker-attribution, 3.3).
//
// The spec pins two shapes and nothing in between:
//   • a speaker CHANGE is visible at the segment boundary ("换人看得出来");
//   • ALL-unknown text is byte-identical to the pre-change plain line — no label,
//     no separator drift, nothing to explain to anyone reading a transcript.
//
// What must never happen: an invented label. An unbound cluster has no name, so
// the merge prints none — "说话人 1" with no source is exactly the pseudo-label
// the spec forbids.
//
// Export and the room message read the SAME artifact (voice_captures.merged_text),
// which is why this is asserted on finishCapture's output rather than on a
// renderer: there is no second renderer to drift.
//
//   node --test scripts/test-voice-capture-speakers.mjs

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  beginChunk,
  createCapture,
  ensureVoiceCaptureTables,
  finishCapture,
  insertChunk,
  finishChunk,
  mergeChunks,
} from "../server/voice-capture.js";
import { bindCluster, ensureSpeakerTables } from "../server/speaker-attribution.js";

const OWNER = "owner@x.test";

function fresh() {
  const db = new Database(":memory:");
  ensureVoiceCaptureTables(db);
  ensureSpeakerTables(db);
  return db;
}

function put(handle, captureId, { seq, startMs, text, speaker }) {
  insertChunk(handle, { captureId, seq, startMs, durationMs: 2000, buffer: Buffer.from("a"), mime: "audio/webm" });
  beginChunk(handle, { captureId, seq });
  // `finishChunk` takes the lane's SEGMENT array, not a bare label — the store is
  // what turns a label into a row column (3.1).
  const segments = speaker ? [{ startMs: 0, endMs: 2000, speaker, text }] : null;
  finishChunk(handle, { captureId, seq, ok: true, text, segments });
}

// ── the pure function first (no storage involved) ───────────────────────────
test("3.3 a speaker change is visible at the boundary, in offset order", () => {
  const { text, segments } = mergeChunks(
    [
      { seq: 1, start_ms: 2000, status: "done", text: "后半句" },
      { seq: 0, start_ms: 0, status: "done", text: "前半句" },
    ],
    { labelOf: (row) => (row.seq === 0 ? "李四" : "王五") },
  );
  assert.equal(text, "前半句【王五】后半句", "换人处出现可辨识标注，顺序按 start_ms 而非插入序");
  assert.deepEqual(segments.map((s) => s.speaker), ["李四", "王五"]);
});

test("3.3 all unknown: no label, no separator drift — byte-identical to the old line", () => {
  const rows = [
    { seq: 0, start_ms: 0, status: "done", text: "第一句" },
    { seq: 1, start_ms: 2000, status: "done", text: "第二句" },
  ];
  const withResolver = mergeChunks(rows, { labelOf: () => null });
  const legacy = mergeChunks(rows);
  assert.equal(withResolver.text, legacy.text, "全未知必须与改造前逐字相同");
  assert.equal(withResolver.text, "第一句第二句");
  assert.ok(!withResolver.text.includes("【"), "不得凭空插入标注");
});

test("3.3 one unknown neighbour means no marker: we never label half a boundary", () => {
  const { text } = mergeChunks(
    [
      { seq: 0, start_ms: 0, status: "done", text: "甲" },
      { seq: 1, start_ms: 2000, status: "done", text: "乙" },
    ],
    { labelOf: (row) => (row.seq === 1 ? "王五" : null) },
  );
  assert.equal(text, "甲乙", "一侧没有名字就不标——否则等于给未知那半句贴了标签");
});

test("3.3 a single speaker throughout produces no marker (no boundary to mark)", () => {
  const { text } = mergeChunks(
    [
      { seq: 0, start_ms: 0, status: "done", text: "甲" },
      { seq: 1, start_ms: 2000, status: "done", text: "乙" },
    ],
    { labelOf: () => "李四" },
  );
  assert.equal(text, "甲乙");
});

// ── through storage: export and room read the same artifact ──────────────────
test("3.3 finishCapture labels a bound cluster, and the stored text is what the room reads", () => {
  const handle = fresh();
  const cap = createCapture(handle, { owner: OWNER, cellId: "c1", title: "双人会议" });
  put(handle, cap.id, { seq: 0, startMs: 0, text: "我同意", speaker: "spk_1" });
  put(handle, cap.id, { seq: 1, startMs: 2000, text: "我反对", speaker: "spk_2" });
  bindCluster(handle, { captureId: cap.id, owner: OWNER, cluster: "spk_2", member: "b@x.test", actor: OWNER, allowedMembers: ["b@x.test"] });

  const out = finishCapture(handle, { id: cap.id, owner: OWNER });
  assert.equal(out.ok, true);
  // spk_1 was never bound → it stays silent; only the named change is marked.
  assert.equal(out.capture.mergedText, "我同意我反对", "未绑定的簇不产生伪标注");
});

test("3.3 an unbound speaker adds nothing; a bound one makes the change readable", () => {
  const handle = fresh();
  const cap = createCapture(handle, { owner: OWNER, cellId: "c1", title: "双人会议" });
  put(handle, cap.id, { seq: 0, startMs: 0, text: "我同意", speaker: "spk_1" });
  put(handle, cap.id, { seq: 1, startMs: 2000, text: "我反对", speaker: "spk_2" });
  bindCluster(handle, { captureId: cap.id, owner: OWNER, cluster: "spk_1", member: "a@x.test", actor: OWNER, allowedMembers: ["a@x.test"] });
  bindCluster(handle, { captureId: cap.id, owner: OWNER, cluster: "spk_2", member: "b@x.test", actor: OWNER, allowedMembers: ["b@x.test"] });

  const out = finishCapture(handle, { id: cap.id, owner: OWNER });
  assert.match(out.capture.mergedText, /我同意【b@x\.test】我反对/, "两个都绑定后，换人看得见");
});

test("3.3 a capture with no speakers at all keeps today's text exactly", () => {
  const handle = fresh();
  const cap = createCapture(handle, { owner: OWNER, cellId: "c1", title: "单人" });
  put(handle, cap.id, { seq: 0, startMs: 0, text: "第0段文本" });
  put(handle, cap.id, { seq: 1, startMs: 2000, text: "第1段文本" });
  const out = finishCapture(handle, { id: cap.id, owner: OWNER });
  assert.equal(out.capture.mergedText, "第0段文本第1段文本");
  assert.equal(out.capture.originalText, out.capture.mergedText);
});

test("3.3 a session capture labels with its owner — but only at a change, so a solo recording is untouched", () => {
  const handle = fresh();
  const cap = createCapture(handle, { owner: OWNER, cellId: "c1", title: "独录", speakerMode: "session" });
  put(handle, cap.id, { seq: 0, startMs: 0, text: "第一段" });
  put(handle, cap.id, { seq: 1, startMs: 2000, text: "第二段" });
  const out = finishCapture(handle, { id: cap.id, owner: OWNER });
  assert.equal(out.capture.mergedText, "第一段第二段", "同一人全程，无边界可标");
  assert.deepEqual(out.segments.map((s) => s.speaker), [OWNER, OWNER]);
});
