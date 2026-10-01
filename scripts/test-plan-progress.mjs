// Unit tests for the plan progress capture (add-plan-progress-panel): the
// dsh `todo/write` session event → WS `todos` broadcast, the per-session cache
// the rehydration pushes read, and the option-C lifetime (turn boundaries do
// NOT clear the plan).
//
// Covered contract scenarios:
//   - todo/write broadcasts the whole list + per-status counts and caches it
//   - a later write replaces the list wholesale
//   - a non-web session's plan never reaches the web broadcast
//   - a malformed payload is ignored and leaves the cache untouched
//   - turn/start and turn/end leave the plan alone (it outlives the turn)
//   - planMessage answers with the snapshot, or the empty list for an unknown
//     session (the clearing signal a session switch relies on)
//
// Run: node --test scripts/test-plan-progress.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { createAppContext } = await import("../server/context.js");
const { attachDshEvents } = await import("../server/dsh-events.js");

const WEB_SESSION = "platform-web-1";
const BOT_SESSION = "platform-bot-1";

function makeContext() {
  const ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = WEB_SESSION;
  ctx.broadcast = () => {};
  return ctx;
}

// One dsh notification as the bridge pump delivers it.
function sessionEvent(sessionId, type, data) {
  return { method: "session.event", params: { sessionId, event: { type, seq: 1, time: 1, data } } };
}

let ctx;
let seen;
beforeEach(() => {
  ctx = makeContext();
  seen = [];
  ctx.broadcast = (m) => seen.push(m);
});

test("todo/write broadcasts the list with counts and caches it", () => {
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", {
      todos: [
        { content: "Read the spec", status: "completed" },
        { content: "Wire the event", status: "in_progress" },
        { content: "Add the panel", status: "pending" },
      ],
    }),
  );

  assert.deepEqual(seen, [
    {
      type: "todos",
      todos: [
        { content: "Read the spec", status: "completed" },
        { content: "Wire the event", status: "in_progress" },
        { content: "Add the panel", status: "pending" },
      ],
      counts: { pending: 1, inProgress: 1, completed: 1 },
    },
  ]);
  assert.deepEqual(ctx.planBySession.get(WEB_SESSION).counts, {
    pending: 1,
    inProgress: 1,
    completed: 1,
  });
});

test("a later write replaces the list wholesale", () => {
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", {
      todos: [
        { content: "A", status: "completed" },
        { content: "B", status: "completed" },
        { content: "C", status: "completed" },
      ],
    }),
  );
  seen.length = 0;
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", { todos: [{ content: "D", status: "pending" }] }),
  );

  assert.deepEqual(seen[0].todos, [{ content: "D", status: "pending" }]);
  assert.deepEqual(seen[0].counts, { pending: 1, inProgress: 0, completed: 0 });
  assert.equal(ctx.planBySession.get(WEB_SESSION).todos.length, 1);
});

test("a non-web session's plan goes to its collector, never the web broadcast", () => {
  const collected = [];
  ctx.sessionCollectors.set(BOT_SESSION, (n) => collected.push(n));

  ctx.handleDshEvent(
    sessionEvent(BOT_SESSION, "todo/write", { todos: [{ content: "Bot work", status: "pending" }] }),
  );

  assert.equal(seen.length, 0);
  assert.equal(collected.length, 1);
  assert.equal(ctx.planBySession.has(BOT_SESSION), false);
});

test("a malformed payload is ignored and leaves the cache untouched", () => {
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", { todos: [{ content: "Keep", status: "pending" }] }),
  );
  seen.length = 0;

  ctx.handleDshEvent(sessionEvent(WEB_SESSION, "todo/write", { todos: "not a list" }));
  ctx.handleDshEvent(sessionEvent(WEB_SESSION, "todo/write", {}));

  assert.equal(seen.length, 0);
  assert.deepEqual(ctx.planBySession.get(WEB_SESSION).todos, [
    { content: "Keep", status: "pending" },
  ]);
});

test("entries with no content are dropped and an unknown status reads as pending", () => {
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", {
      todos: [
        { content: "", status: "pending" },
        { content: "  ", status: "completed" },
        { content: "Real", status: "whatever" },
        { content: "Sneaky", status: "pending", id: "extra-key" },
      ],
    }),
  );

  assert.deepEqual(seen[0].todos, [
    { content: "Real", status: "pending" },
    { content: "Sneaky", status: "pending" },
  ]);
  assert.deepEqual(seen[0].counts, { pending: 2, inProgress: 0, completed: 0 });
});

test("turn/start and turn/end leave the plan alone", () => {
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", { todos: [{ content: "A", status: "pending" }] }),
  );
  seen.length = 0;

  // turn/start does broadcast (agent_start — that is the run lifecycle, not the
  // plan), so this asserts on the plan channel specifically.
  ctx.handleDshEvent(sessionEvent(WEB_SESSION, "turn/start", {}));
  ctx.handleDshEvent(sessionEvent(WEB_SESSION, "turn/end", {}));

  assert.deepEqual(
    seen.filter((m) => m.type === "todos"),
    [],
  );
  assert.deepEqual(ctx.planBySession.get(WEB_SESSION).todos, [
    { content: "A", status: "pending" },
  ]);
});

test("planMessage answers with the snapshot, or the empty list for an unknown session", () => {
  ctx.handleDshEvent(
    sessionEvent(WEB_SESSION, "todo/write", {
      todos: [{ content: "A", status: "in_progress" }],
    }),
  );

  assert.deepEqual(ctx.planMessage(WEB_SESSION), {
    type: "todos",
    todos: [{ content: "A", status: "in_progress" }],
    counts: { pending: 0, inProgress: 1, completed: 0 },
  });
  assert.deepEqual(ctx.planMessage("platform-never-written"), {
    type: "todos",
    todos: [],
    counts: { pending: 0, inProgress: 0, completed: 0 },
  });
  assert.deepEqual(ctx.planMessage(null), {
    type: "todos",
    todos: [],
    counts: { pending: 0, inProgress: 0, completed: 0 },
  });
});
