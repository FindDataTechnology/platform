// mergeChunks — the pure merge function (openspec: add-voice-capture-lane,
// tasks 3.2 / 3.3).
//
// No database, no HTTP: this is the one piece whose output becomes the record of
// a meeting, so its properties are stated as properties rather than examples
// where that is possible:
//   • determinism — any permutation of the same slices gives byte-identical text
//     (arrival order must never leak into the document);
//   • ordering — by seq, never by start_ms, never by insertion;
//   • silence — a slice with no text adds nothing, not a blank line;
//   • no double, no gap — a sentence transcribed at both edges of a seam
//     appears exactly once, and nothing between slices is dropped.
//
//   node --test scripts/test-voice-capture-merge.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { mergeChunks } = await import("../server/voice-capture.js");

const done = (seq, startMs, text) => ({ seq, start_ms: startMs, status: "done", text });

// ── 3.2 determinism ───────────────────────────────────────────────────────

test("every permutation of the same slices merges to identical bytes", () => {
  const slices = [
    done(0, 0, "会议开始，今天讨论三件事"),
    done(1, 30_000, "第一是预算"),
    done(2, 60_000, "第二是排期"),
    done(3, 90_000, "第三是责任人"),
    done(4, 120_000, "最后确认时间表"),
  ];
  const permutations = [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [2, 0, 4, 1, 3],
    [3, 1, 4, 2, 0],
  ];
  const outputs = permutations.map((order) => mergeChunks(order.map((i) => slices[i])).text);
  for (const out of outputs) assert.equal(out, outputs[0]);
  assert.equal(outputs[0], "会议开始，今天讨论三件事第一是预算第二是排期第三是责任人最后确认时间表");
});

test("the same input merged twice is byte-identical, and the input is not mutated", () => {
  const slices = [done(1, 1000, "后段"), done(0, 0, "前段")];
  const snapshot = JSON.stringify(slices);
  const a = mergeChunks(slices);
  const b = mergeChunks(slices);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(slices), snapshot, "merge must not reorder its argument in place");
});

test("order comes from seq, and segments carry the client's startMs", () => {
  // Deliberately inconsistent start_ms so the two orders would disagree if the
  // function sorted by time instead of by seq.
  const out = mergeChunks([done(2, 10, "丙"), done(0, 500, "甲"), done(1, 20, "乙")]);
  assert.equal(out.text, "甲乙丙");
  assert.deepEqual(
    out.segments.map((s) => s.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    out.segments.map((s) => s.startMs),
    [500, 20, 10],
  );
});

// ── 3.2 silence ───────────────────────────────────────────────────────────

test("a silent slice never produces a blank line", () => {
  for (const silent of ["", "   ", "\n", "\t \n "]) {
    const out = mergeChunks([done(0, 0, "开头"), done(1, 1000, silent), done(2, 2000, "结尾")]);
    assert.equal(out.text, "开头结尾", `silent slice ${JSON.stringify(silent)}`);
    assert.equal(/\n/.test(out.text), false);
    assert.equal(out.segments.length, 2);
  }
});

test("an all-silent capture merges to an empty string, not to whitespace", () => {
  const out = mergeChunks([done(0, 0, " "), done(1, 1000, "")]);
  assert.equal(out.text, "");
  assert.deepEqual(out.segments, []);
});

// ── 3.3 boundary: exactly once ────────────────────────────────────────────

test("a sentence cut across two slices appears exactly once", () => {
  const out = mergeChunks([
    done(0, 0, "我们今天讨论三件事，第一是预算安排"),
    done(1, 5000, "第一是预算安排，第二是排期问题"),
  ]);
  assert.equal(out.text, "我们今天讨论三件事，第一是预算安排，第二是排期问题");
  assert.equal(out.text.split("第一是预算安排").length - 1, 1);
});

test("a long overlap is removed at its full length, not partially", () => {
  const shared = "这句话在两片里都被转写出来了，长度足够长以触发重叠检测";
  const out = mergeChunks([done(0, 0, `开头${shared}`), done(1, 5000, `${shared}结尾`)]);
  assert.equal(out.text, `开头${shared}结尾`);
  assert.equal(out.text.split(shared).length - 1, 1);
});

test("a short coincidental overlap (under 4 chars) is NOT collapsed", () => {
  // "的" / "了" recur naturally; collapsing a 1-2 char match would eat real text.
  const out = mergeChunks([done(0, 0, "我们讨论了预算"), done(1, 5000, "了预算之后")]);
  assert.equal(out.text, "我们讨论了预算了预算之后");
});

test("nothing between slices is dropped: the concatenation covers every slice's text", () => {
  const slices = [done(0, 0, "甲甲甲甲"), done(1, 1000, "乙乙乙乙"), done(2, 2000, "丙丙丙丙")];
  const out = mergeChunks(slices);
  for (const s of slices) assert.ok(out.text.includes(s.text), `${s.text} missing`);
});

// ── seams ─────────────────────────────────────────────────────────────────

test("latin slices are joined with one space; CJK slices with none", () => {
  const latin = mergeChunks([done(0, 0, "we reviewed the budget"), done(1, 5000, "and the schedule")]);
  assert.equal(latin.text, "we reviewed the budget and the schedule");
  assert.equal(latin.text.includes("  "), false, "exactly one space, not two");

  const cjk = mergeChunks([done(0, 0, "预算"), done(1, 5000, "排期")]);
  assert.equal(cjk.text, "预算排期");

  // Punctuation at the seam needs no extra space either.
  const punct = mergeChunks([done(0, 0, "First point."), done(1, 5000, "Second point.")]);
  assert.equal(punct.text, "First point.Second point.");
});

test("mixed scripts meet without a doubled space or a missing one", () => {
  const out = mergeChunks([done(0, 0, "OK 我们开始"), done(1, 5000, "start now")]);
  assert.equal(out.text, "OK 我们开始start now");
  assert.equal(/\s{2,}/.test(out.text), false);
});

// ── non-done slices ───────────────────────────────────────────────────────

test("only done slices are merged — pending and failed contribute nothing", () => {
  const out = mergeChunks([
    done(0, 0, "已完成的"),
    { seq: 1, start_ms: 1000, status: "failed", text: "" },
    { seq: 2, start_ms: 2000, status: "pending", text: "" },
    { seq: 3, start_ms: 3000, status: "transcribing", text: "半截" },
  ]);
  assert.equal(out.text, "已完成的");
  assert.deepEqual(
    out.segments.map((s) => s.seq),
    [0],
  );
});

test("a null/undefined text field is treated as silence, not as 'null'", () => {
  const out = mergeChunks([
    { seq: 0, start_ms: 0, status: "done", text: null },
    { seq: 1, start_ms: 1000, status: "done", text: undefined },
    done(2, 2000, "真文本"),
  ]);
  assert.equal(out.text, "真文本");
});
