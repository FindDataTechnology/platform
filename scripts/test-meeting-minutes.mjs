// Meeting minutes (openspec: add-ai-native-meeting 4.3).
//
// The minutes are a factual, deterministic record — NOT an LLM paraphrase of a
// private conversation. Pins: only meeting-sourced rows count, order is
// preserved, each speaker is named (or "未归属"), and an empty meeting produces
// no fabricated lines.
//
//   node --test scripts/test-meeting-minutes.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { meetingMinutes } from "../gateway/zhiyu/meeting-agent.js";

const row = (seq, declared, content, source = "meeting") => ({
  seq, kind: "human", content,
  meta: { source, capture: declared ? { mode: "per_stream", declaredMemberId: declared } : { mode: "mixed" } },
});

test("minutes list who said what, in order", () => {
  const m = meetingMinutes({ messages: [row(1, "a@x", "第一句"), row(2, "b@x", "第二句"), row(3, "a@x", "第三句")] });
  assert.equal(m.count, 3);
  assert.deepEqual(m.lines, ["a@x：第一句", "b@x：第二句", "a@x：第三句"]);
  assert.deepEqual(m.speakers, ["a@x", "b@x"]);
});

test("non-meeting rows are excluded (a room's chat is not the minutes)", () => {
  const m = meetingMinutes({ messages: [row(1, "a@x", "在会里", "meeting"), row(2, "a@x", "只是聊天", "capture"), { seq: 3, kind: "human", content: "no meta", meta: null }] });
  assert.equal(m.count, 1);
  assert.deepEqual(m.lines, ["a@x：在会里"]);
});

test("a mixed (unattributed) stretch is labelled, never guessed", () => {
  const m = meetingMinutes({ messages: [row(1, null, "不知道谁说的")] });
  assert.deepEqual(m.lines, ["未归属：不知道谁说的"]);
});

test("an empty meeting yields no fabricated lines", () => {
  const m = meetingMinutes({ messages: [] });
  assert.deepEqual([m.count, m.lines, m.speakers], [0, [], []]);
});

test("blank content is skipped, not rendered as an empty speaker line", () => {
  const m = meetingMinutes({ messages: [row(1, "a@x", "   "), row(2, "a@x", "有内容")] });
  assert.equal(m.count, 1);
  assert.deepEqual(m.lines, ["a@x：有内容"]);
});

// ── The row shape the END ROUTE actually filters on (2026-11-24) ────────────
// The route keeps only rows where capture.meetingId matches the meeting. The
// rows meetingEvidence() produces carried no such field, so the filter kept
// NOTHING and every meeting produced zero minutes — while the tests above
// stayed green because they hand-build rows with whatever fields they like.
// These two pin the CONTRACT between the producer and the consumer.
import { utteranceToMessage, meetingEvidence, deliverEvidenceMessage } from "../gateway/zhiyu/meeting-agent.js";

test("a produced row carries the meeting id where the end route looks for it", () => {
  const msg = utteranceToMessage({ meetingId: "zym_x", seatRef: "a@b.c", text: "hello" });
  assert.equal(msg.capture.meetingId, "zym_x", "capture must name its meeting");
  assert.equal(msg.capture.declaredMemberId, "a@b.c", "and keep the speaker");
  assert.equal(meetingEvidence({ meetingId: "zym_x", seatRef: "a@b.c" }).streamId, "zym_x#a@b.c");
});

test("the end-route filter matches a produced row for its own meeting and no other", () => {
  const mine = utteranceToMessage({ meetingId: "zym_x", seatRef: "a@b.c", text: "hello" });
  const other = utteranceToMessage({ meetingId: "zym_y", seatRef: "a@b.c", text: "hello" });
  // mirror of index.js's `belongs`, including the pre-fix rows that only have
  // meta.meetingId
  const belongs = (meta, meetingId) =>
    (meta?.capture?.meetingId ?? meta?.meetingId ?? null) === meetingId;
  assert.equal(belongs({ source: "meeting", capture: mine.capture }, "zym_x"), true);
  assert.equal(belongs({ source: "meeting", capture: other.capture }, "zym_x"), false);
  assert.equal(belongs({ source: "meeting", capture: {}, meetingId: "zym_x" }, "zym_x"), true, "legacy rows still count");
});

test("deliverEvidenceMessage stamps the capture block with the meeting id", async () => {
  const appended = [];
  const store = {
    memberFor: () => ({ id: "mem_1", ref: "a@b.c" }),
    messageAppend: ({ meta }) => { appended.push(meta); return { row: { seq: 1 } }; },
    roomGet: () => ({ id: "zy_1" }),
    memberById: () => ({ ref: "a@b.c" }),
  };
  await deliverEvidenceMessage({
    store,
    room: { id: "zy_1", ownerEmail: "a@b.c" },
    meetingId: "zym_x",
    content: "hi",
    capture: meetingEvidence({ meetingId: "zym_x", seatRef: "a@b.c" }),
    memberRef: "a@b.c",
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].capture.meetingId, "zym_x");
  assert.equal(appended[0].meetingId, "zym_x", "the top-level field stays for older readers");
});
