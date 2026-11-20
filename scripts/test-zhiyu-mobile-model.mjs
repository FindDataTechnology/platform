// The room screen's state rules (openspec: add-zhiyu-mobile-clients, tasks 3.3
// and 3.4).
//
// A phone page cannot be asserted from node, so the four interactions it must
// support live here as pure transitions:
//
//   1. 消息流（尾部起播 + 上滑翻页）— what an increment and an older window do
//   2. 发送框                       — when send is live, and what a failed send does
//   3. 按住说话                     — a transcript lands in the DRAFT, never sent
//   4. 底部只读在场状态             — one readable line, no management
//
// and one invariant that is easy to lose: a transport downgrade changes the
// NOTE, never the screen (3.4).
//
//   node --test scripts/test-zhiyu-mobile-model.mjs
//
// The model lives in packages/core so BOTH mobile clients drive it (4.2): the
// mini-program and the app differ in adapter and in rendering, not in what a
// failed send does to the draft.

import test from "node:test";
import assert from "node:assert/strict";

import {
  initialScreen,
  mergeRows,
  applyIncoming,
  applyOlder,
  beginLoadingOlder,
  applyFailure,
  setDraft,
  setRecording,
  transcriptIntoDraft,
  canSend,
  takeDraft,
  applySent,
  applySendFailed,
  connectionNote,
  syncFailures,
  holdFor,
  presenceLine,
  isRenderableRow,
} from "../packages/core/src/zhiyu-mobile-model.ts";

const row = (seq, content = `第 ${seq} 行`, kind = "human") => ({ seq, content, kind });

// ── 1. the stream: tail start and paging back ─────────────────────────────

test("3.3 an increment appends in order and advances the cursor", () => {
  let s = initialScreen("r1");
  s = applyIncoming(s, { messages: [row(1), row(2)], cursor: 2 });
  assert.deepEqual(s.rows.map((r) => r.seq), [1, 2]);
  assert.equal(s.cursor, 2);
  s = applyIncoming(s, { messages: [row(3, "新的", "agent")], cursor: 3 });
  assert.deepEqual(s.rows.map((r) => r.seq), [1, 2, 3]);
  assert.equal(s.cursor, 3);
});

test("3.3 a replay puts no row in twice", () => {
  let s = initialScreen("r1");
  s = applyIncoming(s, { messages: [row(1), row(2)], cursor: 2 });
  s = applyIncoming(s, { messages: [row(1), row(2)], cursor: 2 });
  assert.deepEqual(s.rows.map((r) => r.seq), [1, 2]);
  // mergeRows is the same rule at the list level, including out-of-order input.
  assert.deepEqual(mergeRows([row(3), row(1)], [row(2), row(3)]).map((r) => r.seq), [1, 2, 3]);
});

test("3.3 paging back prepends an adjacent window and keeps the cursor", () => {
  let s = applyIncoming(initialScreen("r1"), { messages: [row(11), row(12)], cursor: 12 });
  s = beginLoadingOlder(s);
  assert.equal(s.loadingOlder, true);
  s = applyOlder(s, { messages: [row(9), row(10)] });
  assert.deepEqual(s.rows.map((r) => r.seq), [9, 10, 11, 12], "adjacent, in order, appended-to-front");
  assert.equal(s.cursor, 12, "the cursor is newest-seen, so paging back must not move it");
  assert.equal(s.hasOlder, true);
  assert.equal(s.loadingOlder, false);
});

test("3.3 an empty older window ends paging", () => {
  let s = applyIncoming(initialScreen("r1"), { messages: [row(1)], cursor: 1 });
  s = applyOlder(s, { messages: [] });
  assert.equal(s.hasOlder, false);
});

test("3.3 system rows are triggers, not bubbles", () => {
  assert.equal(isRenderableRow(row(1, "x", "human")), true);
  assert.equal(isRenderableRow(row(1, "x", "agent")), true);
  assert.equal(isRenderableRow(row(1, "", "system")), false);
});

// ── 2. the composer ───────────────────────────────────────────────────────

test("3.3 send is live only with text, and the draft survives a failed send", () => {
  let s = initialScreen("r1");
  assert.equal(canSend(s), false, "empty draft cannot send");
  s = setDraft(s, "   ");
  assert.equal(canSend(s), false, "whitespace is not content");
  s = setDraft(s, "  说一句 ");
  assert.equal(canSend(s), true);

  const taken = takeDraft(s);
  assert.equal(taken.text, "说一句", "the trimmed text is what goes out");
  assert.equal(taken.state.sending, true);
  assert.equal(canSend(taken.state), false, "no double send while in flight");

  // A failed send keeps the text: losing a sentence to a blip is worse than a
  // duplicate tap the user can see.
  const failed = applySendFailed(taken.state, "网络断开");
  assert.equal(failed.draft, "  说一句 ");
  assert.equal(failed.sending, false);
  assert.equal(failed.error, "网络断开");

  // A successful one clears it.
  assert.equal(applySent(taken.state).draft, "");
});

// ── 3. hold-to-talk ───────────────────────────────────────────────────────

test("3.3 a transcript lands in the draft and is NOT sent", () => {
  let s = setRecording(initialScreen("r1"), true);
  s = applyIncoming(s, { messages: [row(1)], cursor: 1 });
  s = transcriptIntoDraft(s, "这段话应该可编辑");
  assert.equal(s.recording, false);
  assert.equal(s.draft, "这段话应该可编辑");
  assert.equal(s.sending, false, "transcription never sends");
  assert.deepEqual(s.rows.map((r) => r.seq), [1], "no new row appeared");
  assert.equal(canSend(s), true, "the user may now edit and send");

  // A second take appends into the same draft rather than replacing an edit.
  s = transcriptIntoDraft(s, "再补一句");
  assert.equal(s.draft, "这段话应该可编辑 再补一句");

  // An empty transcript is not an edit.
  assert.equal(transcriptIntoDraft(s, "   ").draft, s.draft);
});

// ── 4. read-only presence ─────────────────────────────────────────────────

test("3.3 the presence strip is one readable line and manages nothing", () => {
  const people = [
    { id: "m1", display: "老王", kind: "user", presence: "active" },
    { id: "m2", display: "值守", kind: "facade", presence: "on_duty" },
    { id: "m3", display: "小李", kind: "user", presence: "away" },
    { id: "m4", display: "小张", kind: "user", presence: "active" },
  ];
  assert.equal(presenceLine(people), "老王、值守、小张 在场");
  assert.equal(presenceLine(people, 2), "老王、值守 等 3 人在场");
  assert.equal(presenceLine([]), "暂无人在场");
  assert.equal(presenceLine([{ id: "m3", display: "小李", kind: "user", presence: "away" }]), "暂无人在场");
});

// ── 3.4 the downgrade is a note, not a reset ──────────────────────────────

test("3.4 one failure is a blip; two downgrade the note and change nothing else", () => {
  let s = applyIncoming(initialScreen("r1"), { messages: [row(1), row(2)], cursor: 2 });
  s = setDraft(s, "打到一半的字");
  assert.equal(connectionNote(s.transport), null, "a long poll is not news");

  s = applyFailure(s, "timeout");
  assert.equal(s.transport, "longpoll", "one failure does not rename the transport");
  assert.equal(connectionNote(s.transport), null);

  s = applyFailure(s, "timeout");
  assert.equal(s.transport, "shortpoll");
  assert.match(connectionNote(s.transport) ?? "", /短轮询/);

  // The screen is untouched: same rows, same cursor, same draft.
  assert.deepEqual(s.rows.map((r) => r.seq), [1, 2]);
  assert.equal(s.cursor, 2);
  assert.equal(s.draft, "打到一半的字", "a downgrade must not cost the user their sentence");

  // And a success puts the note away.
  s = applyIncoming(s, { messages: [row(3)], cursor: 3 });
  assert.equal(s.transport, "longpoll");
  assert.equal(s.failures, 0);
  assert.equal(connectionNote(s.transport), null);
  assert.equal(s.draft, "打到一半的字", "still there after recovery");
});

test("3.4 the driver's failure count is what the note is synced to, and it sets the hold", () => {
  let s = applyIncoming(initialScreen("r1"), { messages: [row(1)], cursor: 1 });
  s = setDraft(s, "草稿");
  assert.equal(holdFor(s.transport), 5_000, "a healthy client parks a request for 5s");
  s = syncFailures(s, 1);
  assert.equal(s.transport, "longpoll");
  s = syncFailures(s, 2);
  assert.equal(s.transport, "shortpoll");
  assert.equal(holdFor(s.transport), 0, "degraded means no hold, i.e. a real cadence change");
  assert.equal(s.draft, "草稿");
  s = syncFailures(s, 0);
  assert.equal(s.transport, "longpoll", "a success restores the hold");
  assert.equal(holdFor(s.transport), 5_000);
});

test("3.4 a downgrade does not lose an in-progress recording state", () => {
  let s = setRecording(initialScreen("r1"), true);
  s = applyFailure(applyFailure(s, "x"), "x");
  assert.equal(s.recording, true, "the take is still being recorded");
  assert.equal(s.transport, "shortpoll");
});
