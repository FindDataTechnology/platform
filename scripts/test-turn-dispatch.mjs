// Unit tests for the turn dispatcher (concurrent-chat-sessions, design D1/D2/
// D5/D8). A hand-built ctx (attachTurnStateModule) stands in for the real app
// context: the dispatcher only needs the turn-state module, sendToViewers,
// sessionCollectors, broadcastSessions and (optionally) db lookups.
//
// Covered:
//   - idle runtime dispatches immediately; the turn is reserved synchronously
//   - a busy runtime queues instead of rejecting or dispatching alongside
//   - FIFO across sessions; one entry per session
//   - queue bound (TURN_QUEUE_MAX) and the queue_full refusal
//   - non-web lanes count as busy (sessionCollectors) and their close drains
//   - reservations hold the queue across a bridge restart window
//   - cancel before dispatch; a cancelled queued prompt never runs
//   - the three policies (queue / concurrent / legacy) + the ⑨b gate
//
// Run: node --test scripts/test-turn-dispatch.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { createAppContext, attachTurnStateModule } = await import("../server/context.js");
const { attachTurnDispatch, resolvePolicy } = await import("../server/turn-dispatch.js");

function makeCtx(env = {}) {
  const ctx = createAppContext({});
  attachTurnStateModule(ctx);
  ctx.broadcastSessions = async () => {};
  ctx.db = { getSessionMeta: () => null };
  const seen = [];
  ctx.sendToViewers = (sid, msg) => seen.push({ sid, ...msg });
  ctx.__seen = seen;
  // Fresh policy resolution per test (env is read at attach time).
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  attachTurnDispatch(ctx);
  return ctx;
}

// A run() that parks until released — lets a test hold a turn open.
function parkedRun() {
  const gate = { release: null, started: 0 };
  gate.run = async () => {
    gate.started += 1;
    await new Promise((r) => {
      gate.release = r;
    });
  };
  return gate;
}

let ctx;
beforeEach(() => {
  delete process.env.TURN_DISPATCH;
  delete process.env.TURN_QUEUE_MAX;
  delete process.env.TURN_QUEUE_POLL_MS;
  delete process.env.DSH_MATRIX_CLOSE_INTERLEAVE;
  ctx = makeCtx();
});

test("idle runtime dispatches immediately and reserves the turn synchronously", () => {
  const gate = parkedRun();
  const r = ctx.dispatchTurn({ sessionId: "A", text: "hi", run: gate.run });
  assert.equal(r.accepted, true);
  assert.equal(r.dispatched, true);
  // Reserved before run()'s first await: a second prompt in the same tick sees busy.
  assert.equal(ctx.isStreamingFor("A"), true);
});

test("a busy runtime queues instead of rejecting or dispatching alongside", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "first", run: a.run });

  const b = (() => {
    let ran = false;
    return { run: async () => { ran = true; }, get ran() { return ran; } };
  })();
  const r = ctx.dispatchTurn({ sessionId: "B", text: "second", run: b.run });
  assert.equal(r.accepted, true);
  assert.equal(r.queued, true);
  assert.equal(r.position, 1);
  assert.equal(b.ran, false, "B must not run while A holds the child");
  assert.equal(ctx.isQueuedFor("B"), true);
  // The queued announcement reached B's viewers.
  const queued = ctx.__seen.find((m) => m.type === "queued" && m.sid === "B");
  assert.ok(queued);
  assert.equal(queued.text, "second");
  assert.equal(queued.waitingOn?.id, "A");
});

test("A closing drains B, and B announces its dispatch before running", async () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "first", run: a.run });
  let bRan = false;
  ctx.dispatchTurn({ sessionId: "B", text: "second", run: async () => { bRan = true; } });

  // A's turn closes the way finishTurn does: flag off, then drain.
  ctx.finishTurnLikeDrain = () => {
    ctx.setStreaming("A", false);
    ctx.turnStateBySession.delete("A");
    ctx.drainTurnQueue();
  };
  ctx.finishTurnLikeDrain();
  assert.equal(bRan, true);
  assert.equal(ctx.isQueuedFor("B"), false);
  assert.equal(ctx.isStreamingFor("B"), true);
  const dequeued = ctx.__seen.find((m) => m.type === "dequeued" && m.sid === "B");
  assert.equal(dequeued.reason, "dispatched");
});

test("FIFO across sessions", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  const order = [];
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => order.push("B") });
  ctx.dispatchTurn({ sessionId: "C", text: "c", run: async () => order.push("C") });
  assert.equal(ctx.queuedViewFor("B").position, 1);
  assert.equal(ctx.queuedViewFor("C").position, 2);
  ctx.setStreaming("A", false);
  ctx.turnStateBySession.delete("A");
  ctx.drainTurnQueue();
  assert.deepEqual(order, ["B"], "one dispatch per idle transition");
});

test("one entry per session and a bounded queue", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => {} });
  const again = ctx.dispatchTurn({ sessionId: "B", text: "b2", run: async () => {} });
  assert.equal(again.accepted, false);
  assert.equal(again.reason, "session_busy");

  // Fill to the bound (default 8 total entries).
  for (let i = 0; i < 7; i++) {
    const r = ctx.dispatchTurn({ sessionId: `Q${i}`, text: "x", run: async () => {} });
    assert.equal(r.accepted, true, `Q${i} should be accepted`);
  }
  const full = ctx.dispatchTurn({ sessionId: "OVER", text: "x", run: async () => {} });
  assert.equal(full.accepted, false);
  assert.equal(full.reason, "queue_full");
});

test("non-web lanes count as busy, and their collector close drains the queue", () => {
  // A scheduled task's turn: visible only as a collector.
  const collectorSid = "cron-1";
  const collector = () => {};
  ctx.sessionCollectors.set(collectorSid, collector);
  assert.equal(ctx.runtimeBusy(), true);

  let ran = false;
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => { ran = true; } });
  assert.equal(ran, false, "must not dispatch into a lane's open turn");
  const queued = ctx.__seen.find((m) => m.type === "queued" && m.sid === "B");
  assert.equal(queued.waitingOn, null, "waiting on a non-web lane has no session to name");

  ctx.sessionCollectors.delete(collectorSid);
  ctx.onRuntimeIdle();
  assert.equal(ran, true);
});

test("a reservation holds the queue across the restart it causes", () => {
  const release = ctx.reserveRuntime("cron-preset-switch");
  let ran = false;
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => { ran = true; } });
  // The restart's ready notification must NOT drain into the cron window.
  ctx.drainTurnQueue();
  assert.equal(ran, false);
  release();
  ctx.drainTurnQueue();
  assert.equal(ran, true);
});

test("cancel before dispatch removes the entry without running it", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  let bRan = false;
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => { bRan = true; } });

  assert.equal(ctx.cancelQueued("B"), true);
  assert.equal(ctx.isQueuedFor("B"), false);
  const cancelled = ctx.__seen.find((m) => m.type === "dequeued" && m.sid === "B");
  assert.equal(cancelled.reason, "cancelled");

  ctx.setStreaming("A", false);
  ctx.turnStateBySession.delete("A");
  ctx.drainTurnQueue();
  assert.equal(bRan, false);
});

test("a queued entry waits for its own session to go idle, never double-driven", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  let bRan = 0;
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => { bRan += 1; } });

  // A cron job bound to the SAME session opens a turn there while B is queued.
  // The queue must not dispatch B into that open turn (the runtime is busy),
  // and must not silently drop the user's message either.
  ctx.setStreaming("B", true);
  ctx.setStreaming("A", false);
  ctx.turnStateBySession.delete("A");
  ctx.drainTurnQueue();
  assert.equal(bRan, 0, "no dispatch while the runtime is busy on any lane");
  assert.equal(ctx.isQueuedFor("B"), true, "the entry survives — the message is not lost");

  // The cron turn closes: B's queued prompt finally runs.
  ctx.setStreaming("B", false);
  ctx.turnStateBySession.delete("B");
  ctx.drainTurnQueue();
  assert.equal(bRan, 1);
  assert.equal(ctx.isQueuedFor("B"), false);
});

test("reserved callers are not blocked by their own synchronous latch", () => {
  const gate = parkedRun();
  // The ws layer sets the guard, then dispatches that very prompt.
  ctx.setStreaming("A", true);
  const r = ctx.dispatchTurn({ sessionId: "A", text: "hi", run: gate.run, reserved: true });
  assert.equal(r.accepted, true);
  assert.equal(r.dispatched, true);
  assert.equal(ctx.isStreamingFor("A"), true);
});

test("a reserved caller that lands in the queue releases its latch", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  // A fresh session minted during beginTurnFor: nothing was marked, so this is
  // an ordinary (unreserved) queue entry.
  const r = ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => {}, reserved: false });
  assert.equal(r.queued, true);

  // Now the reserved shape: the caller marked B, the dispatcher queues it.
  ctx.setStreaming("C", true);
  const rc = ctx.dispatchTurn({ sessionId: "C", text: "c", run: async () => {}, reserved: true });
  assert.equal(rc.queued, true);
  assert.equal(ctx.isStreamingFor("C"), false, "the speculative latch must be released when queued");
});

test("turnStatusFor reports running / queued / null", () => {
  const a = parkedRun();
  ctx.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  ctx.dispatchTurn({ sessionId: "B", text: "b", run: async () => {} });
  assert.equal(ctx.turnStatusFor("A"), "running");
  assert.equal(ctx.turnStatusFor("B"), "queued");
  assert.equal(ctx.turnStatusFor("Z"), null);
});

test("policy: concurrent dispatches while busy (only behind the ⑨b flag)", () => {
  const concurrent = makeCtx({ TURN_DISPATCH: "concurrent", DSH_MATRIX_CLOSE_INTERLEAVE: "1" });
  const a = parkedRun();
  concurrent.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  const r = concurrent.dispatchTurn({ sessionId: "B", text: "b", run: async () => {} });
  assert.equal(r.dispatched, true, "concurrent policy does not queue");
  assert.equal(concurrent.isStreamingFor("B"), true);
});

test("policy: concurrent is downgraded to queue without the ⑨b flag", () => {
  const downgraded = makeCtx({ TURN_DISPATCH: "concurrent" });
  assert.equal(downgraded.dispatchPolicy, "queue");
  assert.equal(downgraded.dispatchPolicyRequested, "concurrent");
});

test("policy: unknown values fall back to queue", () => {
  const weird = makeCtx({ TURN_DISPATCH: "turbo" });
  assert.equal(weird.dispatchPolicy, "queue");
});

test("policy: legacy dispatches regardless of busyness", () => {
  const legacy = makeCtx({ TURN_DISPATCH: "legacy" });
  const a = parkedRun();
  legacy.dispatchTurn({ sessionId: "A", text: "a", run: a.run });
  const r = legacy.dispatchTurn({ sessionId: "B", text: "b", run: async () => {} });
  assert.equal(r.dispatched, true);
});

test("resolvePolicy is pure and names its reason", () => {
  assert.equal(resolvePolicy({}).policy, "queue");
  assert.equal(resolvePolicy({ TURN_DISPATCH: "legacy" }).policy, "legacy");
  const refused = resolvePolicy({ TURN_DISPATCH: "concurrent" });
  assert.equal(refused.policy, "queue");
  assert.match(refused.reason, /⑨b/);
  assert.equal(resolvePolicy({ TURN_DISPATCH: "concurrent", DSH_MATRIX_CLOSE_INTERLEAVE: "1" }).policy, "concurrent");
});
