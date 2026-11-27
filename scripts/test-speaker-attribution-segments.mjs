// The merge's per-segment contract (openspec: add-speaker-attribution, 3.2).
//
// 3.2 asks for three things that a data layer alone cannot guarantee:
//   1. slices are aligned by OFFSET (a segment's clock is relative to its chunk);
//   2. TEXT is the authority — the lane's segments must rebuild the chunk's own
//      text, otherwise the split is not trusted;
//   3. a mismatch REFUSES the split (whole chunk, reason recorded) instead of
//      force-joining pieces that the transcript never contained.
//
// Case 3 is the one worth protecting. A split assembled out of words the
// transcript does not contain reads as a confident attribution built on nothing —
// worse than saying "we could not tell" (D8).
//
//   node --test scripts/test-speaker-attribution-segments.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { BASIS, CLUSTER_ANONYMOUS, deriveAttributions } from "../server/speaker-attribution.js";

const chunk = (over = {}) => ({
  seq: 0,
  startMs: 0,
  durationMs: 10_000,
  status: "done",
  text: "",
  ...over,
});

test("3.2 segments are aligned to the capture timeline, not the chunk's own clock", () => {
  const rows = deriveAttributions({
    chunks: [
      chunk({
        seq: 1,
        startMs: 60_000,
        endMs: 70_000,
        text: "第一句第二句",
        speaker: "spk_1",
        segments: [
          { startMs: 0, endMs: 2400, speaker: "spk_1", text: "第一句" },
          { startMs: 2400, endMs: 6000, speaker: "spk_2", text: "第二句" },
        ],
      }),
    ],
  });
  assert.equal(rows.length, 2, "one row per segment");
  assert.deepEqual(rows.map((r) => [r.startMs, r.endMs]), [[60_000, 62_400], [62_400, 66_000]]);
  assert.deepEqual(rows.map((r) => r.cluster), ["spk_1", "spk_2"]);
});

test("3.2 a segment's end is clamped inside its chunk — a bad upstream offset cannot claim next door", () => {
  const rows = deriveAttributions({
    chunks: [
      chunk({
        startMs: 1000,
        endMs: 4000,
        text: "甲乙",
        segments: [
          { startMs: 0, endMs: 2000, speaker: "spk_1", text: "甲" },
          { startMs: 2000, endMs: 99_000, speaker: "spk_2", text: "乙" },
        ],
      }),
    ],
  });
  assert.equal(rows[1].endMs, 4000, "clamped to the chunk's stored end_ms");
});

test("3.2 text is the authority: segments that do not rebuild the chunk text REFUSE the split", () => {
  const rows = deriveAttributions({
    chunks: [
      chunk({
        startMs: 0,
        endMs: 10_000,
        text: "完整的一句话",
        speaker: "spk_1",
        segments: [
          // Upstream dropped words while re-segmenting. Splitting here would
          // attribute text that the transcript never had.
          { startMs: 0, endMs: 3000, speaker: "spk_1", text: "完整的" },
          { startMs: 3000, endMs: 6000, speaker: "spk_2", text: "一句" },
        ],
      }),
    ],
  });
  assert.equal(rows.length, 1, "退回整段，不按分段硬拼");
  assert.equal(rows[0].startMs, 0);
  assert.equal(rows[0].endMs, 10_000);
  assert.equal(rows[0].basis, BASIS.segmentTextMismatch, "原因必须写进可见的 basis");
});

test("3.2 whitespace differences alone do not count as a mismatch", () => {
  const rows = deriveAttributions({
    chunks: [
      chunk({
        text: "第一句\n第二句",
        segments: [
          { startMs: 0, endMs: 2000, speaker: "spk_1", text: "第一句 " },
          { startMs: 2000, endMs: 4000, speaker: "spk_2", text: " 第二句" },
        ],
      }),
    ],
  });
  assert.equal(rows.length, 2, "换行/空格不构成错位");
});

test("3.2 the sentinel is not a cluster: it falls back to 'not separated'", () => {
  const rows = deriveAttributions({
    chunks: [
      chunk({
        text: "一句",
        segments: [{ startMs: 0, endMs: 1000, speaker: "UNKNOWN", text: "一句" }],
      }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cluster, CLUSTER_ANONYMOUS);
  assert.equal(rows[0].certainty, "anonymous");
  assert.equal(rows[0].basis, BASIS.anonymousNoDiarization);
});

test("3.2 a stored speaker becomes a person only through a binding, never by itself", () => {
  const chunks = [
    chunk({ text: "一句", speaker: "spk_9", segments: [{ startMs: 0, endMs: 1000, speaker: "spk_9", text: "一句" }] }),
  ];
  const unbound = deriveAttributions({ chunks });
  assert.equal(unbound[0].member, null, "簇标识不是人名");
  assert.equal(unbound[0].certainty, "anonymous");

  const bound = deriveAttributions({ chunks, bindings: new Map([["spk_9", "a@x.test"]]) });
  assert.equal(bound[0].member, "a@x.test");
  assert.equal(bound[0].certainty, "bound");
});

test("3.2 a slice holding two stored speakers is anonymous, not the first one", () => {
  // The merge never sees this from storage (a chunk with two voices stores NULL),
  // but the ladder must hold if a caller hands it a multi-cluster slice.
  const rows = deriveAttributions({
    chunks: [chunk({ text: "甲乙", segments: [
      { startMs: 0, endMs: 1000, speaker: "spk_1", text: "甲" },
      { startMs: 1000, endMs: 2000, speaker: "spk_2", text: "乙" },
    ] })],
    bindings: new Map([["spk_1", "a@x.test"], ["spk_2", "b@x.test"]]),
  });
  assert.equal(rows.length, 2, "两个人两行——一条消息不跨两个人");
  assert.deepEqual(rows.map((r) => r.member), ["a@x.test", "b@x.test"]);
});
