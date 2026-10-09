// Unit tests for the turn/end error broadcast: an errored turn must always
// surface an error message to the clients. LLM failures are captured earlier
// (assistant/chunk finish → ctx.dshTurnError) and replayed on turn/end; other
// failures — the dsh session-log id collision after a child restart is the
// observed case — arrive ONLY on turn/end, and before the fallback they ended
// the turn silently (the user saw no output and no explanation).
//
// Covered contract scenarios:
//   - a turn/end-only error broadcasts that error's message
//   - a chunk-captured dshTurnError takes precedence over the turn/end reason
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
  ctx.sendToViewers = (sid, m) => seen.push(m);
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

test("a chunk-captured dshTurnError takes precedence", () => {
  ctx.dshTurnError = "LLM request failed";
  ctx.handleDshEvent(
    sessionEvent("turn/end", { reason: { kind: "error", error: { message: "later, coarser message" } } }),
  );
  const errors = seen.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "LLM request failed");
  assert.equal(ctx.dshTurnError, null);
});

test("an errored turn with no message anywhere still broadcasts a fallback", () => {
  ctx.handleDshEvent(sessionEvent("turn/end", { reason: { kind: "error" } }));
  const errors = seen.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.length > 0);
});

test("a completed turn broadcasts no error", () => {
  ctx.dshTurnError = null;
  ctx.handleDshEvent(sessionEvent("turn/end", { reason: { kind: "completed" } }));
  assert.deepEqual(seen.filter((m) => m.type === "error"), []);
});
