// Unit tests for the turn/end error broadcast: an errored turn must always
// surface an error message to the clients. LLM failures are captured earlier
// (platform/stream finish frames → the per-session turn state —
// restore-assistant-stream-020: the 0.2.0 session format removed the
// assistant/chunk event this capture used to read) and replayed on turn/end;
// other failures — the dsh session-log id collision after a child restart is
// the observed case — arrive ONLY on turn/end, and before the fallback they
// ended the turn silently (the user saw no output and no explanation).
//
// Covered contract scenarios:
//   - a turn/end-only error broadcasts that error's message
//   - a stream-lane-captured turn error takes precedence over the turn/end reason
//   - a stream-lane finish error is captured for the turn
//   - settled text falls back exactly once when nothing streamed
//   - streamed deltas suppress the settled-text fallback
//   - an errored turn with no message anywhere still broadcasts a fallback
//   - a completed turn broadcasts no error
//
// Run: node --test scripts/test-turn-error-broadcast.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { createAppContext } = await import("../server/context.js");
const { attachDshEvents } = await import("../server/dsh-events.js");

const SESSION = "platform-web-1";

function sessionEvent(type, data) {
  return { method: "session.event", params: { sessionId: SESSION, event: { type, seq: 1, time: 1, data } } };
}

// A bridge-forwarded live-lane frame (restore-assistant-stream-020).
function streamFrame(frame) {
  return { method: "platform/stream", params: { sessionId: SESSION, frame } };
}

function streamChunk(chunk) {
  return streamFrame({ type: "chunk", attemptId: "a:1", revision: 1, index: 0, chunk });
}

function assistantMessage(text) {
  return sessionEvent("assistant/message", { message: { content: [{ type: "text", text }] } });
}

let ctx;
let seen;

beforeEach(() => {
  ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = SESSION;
  seen = [];
  ctx.broadcast = (m) => seen.push(m);
  // Turn payloads (including the error contract under test) ride the
  // per-session fan-out, not the global broadcast — capture there.
  ctx.sendToViewers = (_sid, m) => seen.push(m);
});

test("a turn/end-only error broadcasts its message", () => {
  ctx.handleDshEvent(
    sessionEvent("turn/end", {
      reason: { kind: "error", error: { message: 'session "x" already has a persisted log (id collision)' } },
    }),
  );
  const errors = seen.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /id collision/);
});

test("a stream-lane-captured turn error takes precedence", () => {
  // Production captures LLM failures into the per-session turn state
  // (live-runtime-control); the turn/end replay prefers that capture over the
  // coarser reason the runtime reports.
  ctx.turnStateFor(SESSION).error = "LLM request failed";
  ctx.handleDshEvent(
    sessionEvent("turn/end", { reason: { kind: "error", error: { message: "later, coarser message" } } }),
  );
  const errors = seen.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "LLM request failed");
  assert.equal(ctx.turnStateFor(SESSION).error, null);
});

test("a stream-lane finish error is captured for the turn", () => {
  ctx.handleDshEvent(sessionEvent("turn/start", {}));
  ctx.handleDshEvent(
    streamChunk({ type: "finish", reason: { kind: "error", failure: { message: "gateway 503" } } }),
  );
  assert.equal(ctx.turnStateFor(SESSION).error, "gateway 503");
  ctx.handleDshEvent(sessionEvent("turn/end", { reason: { kind: "error" } }));
  const errors = seen.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "gateway 503");
});

test("settled text falls back exactly once when nothing streamed", () => {
  ctx.handleDshEvent(sessionEvent("turn/start", {}));
  ctx.handleDshEvent(assistantMessage("第一段回复"));
  // No deltas preceded the settlement: the full text is emitted once…
  const texts = seen.filter((m) => m.type === "text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].delta, "第一段回复");
  // …and the same settlement never emits twice.
  ctx.handleDshEvent(assistantMessage("第一段回复"));
  assert.equal(seen.filter((m) => m.type === "text").length, 1);
  // A NEW attempt resets the marker: its silent settlement falls back too.
  ctx.handleDshEvent(streamFrame({ type: "start", attemptId: "a:2", revision: 2, turn: 1, step: 2 }));
  ctx.handleDshEvent(assistantMessage("第二段回复"));
  const texts2 = seen.filter((m) => m.type === "text");
  assert.equal(texts2.length, 2);
  assert.equal(texts2[1].delta, "第二段回复");
});

test("streamed deltas suppress the settled-text fallback", () => {
  ctx.handleDshEvent(sessionEvent("turn/start", {}));
  ctx.handleDshEvent(streamFrame({ type: "start", attemptId: "a:1", revision: 1, turn: 1, step: 1 }));
  ctx.handleDshEvent(streamChunk({ type: "text-delta", text: "流式" }));
  ctx.handleDshEvent(assistantMessage("流式回复全文"));
  // The delta was delivered live; the settlement must not re-emit the text.
  const texts = seen.filter((m) => m.type === "text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].delta, "流式");
});

test("an errored turn with no message anywhere still broadcasts a fallback", () => {
  ctx.handleDshEvent(sessionEvent("turn/end", { reason: { kind: "error" } }));
  const errors = seen.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.length > 0);
});

test("a completed turn broadcasts no error", () => {
  ctx.turnStateFor(SESSION).error = null;
  ctx.handleDshEvent(sessionEvent("turn/end", { reason: { kind: "completed" } }));
  assert.deepEqual(seen.filter((m) => m.type === "error"), []);
});
