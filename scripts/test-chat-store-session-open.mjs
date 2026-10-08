// Unit tests for the chat store's optimistic session open (openspec:
// perf-session-open, tasks 1.1 + 2.1): instant pending on activate, the
// stale-load guard, switch-error restore, and the LRU turn cache (fill on
// load, instant re-entry, eviction cap, drop-on-delete, done-refresh).
//
// Drives the REAL store module (not a mirror): node's type stripping loads
// the TS source directly, with a resolve hook appending `.ts` for the
// extensionless relative imports tsc resolves in the web build. The live WS
// path is exercised by the e2e specs; these guard the reducer contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { useChatStore, setChatErrorSink } = await import(
  "../packages/core/src/store/chat-store.ts"
);

// Silence the default console sink in the error-restore tests.
const errors = [];
setChatErrorSink((message) => errors.push(message));

// The store is a module singleton: restore the fields under test between
// cases (setState merges, so untouched machinery — delta buffers, uid —
// carries over harmlessly; session_loaded/activate both discard deltas).
function reset() {
  errors.length = 0;
  useChatStore.setState({
    status: "connected",
    sessions: [],
    currentSessionId: null,
    turns: [],
    pendingSession: null,
    pendingNewSession: false,
    optimisticSessions: false,
    sessionSwitchBackup: null,
    sessionCache: new Map(),
    isStreaming: false,
    todos: [],
    todoCounts: { pending: 0, inProgress: 0, completed: 0 },
    suppressed: false,
  });
}

const apply = (m) => useChatStore.getState().apply(m);
const state = () => useChatStore.getState();

// A minimal session_loaded: one user turn per text.
const loaded = (id, texts) => ({
  type: "session_loaded",
  id,
  title: id,
  messages: texts.map((t) => ({ role: "user", content: t })),
});

test("1.1 activate flips the view instantly and arms the pending state", () => {
  reset();
  apply(loaded("A", ["hello"]));
  assert.equal(state().currentSessionId, "A");
  assert.equal(state().turns.length, 1);

  state().activateSession("B");
  assert.equal(state().currentSessionId, "B", "currentSessionId moves immediately");
  assert.equal(state().pendingSession, "B");
  assert.equal(state().turns.length, 0, "the old transcript leaves the view at once");
  assert.ok(state().optimisticSessions, "the optimistic latch flips on first use");
  assert.equal(state().sessionSwitchBackup.id, "A", "the displaced view is snapshotted");
});

test("1.1 a stale session_loaded is ignored for the view but feeds the cache", () => {
  reset();
  apply(loaded("A", ["hello"]));
  state().activateSession("B");

  // A's load lands after the user already moved to B.
  apply(loaded("A", ["late"]));
  assert.equal(state().currentSessionId, "B", "the view is not clobbered");
  assert.equal(state().pendingSession, "B", "B's pending state is unaffected");
  assert.equal(state().turns.length, 0);
  assert.equal(state().sessionCache.get("A").length, 1, "the stale load still fills the cache");

  apply(loaded("B", ["b1"]));
  assert.equal(state().pendingSession, null, "the matching load resolves the pending state");
  assert.equal(state().turns.length, 1);
});

test("1.1 a switch error restores the displaced view", () => {
  reset();
  apply(loaded("A", ["a1", "a2"]));
  state().activateSession("missing");
  assert.equal(state().pendingSession, "missing");

  apply({ type: "error", message: "session missing not found" });
  assert.equal(state().currentSessionId, "A", "the previous session id is restored");
  assert.equal(state().turns.length, 2, "the previous transcript is restored");
  assert.equal(state().pendingSession, null);
  assert.equal(state().sessionSwitchBackup, null);
  assert.deepEqual(errors, ["session missing not found"], "the failure is still surfaced");
});

test("1.1 a socket drop mid-switch restores the displaced view", () => {
  reset();
  apply(loaded("A", ["a1"]));
  state().activateSession("B");

  state().setStatus("disconnected");
  assert.equal(state().currentSessionId, "A");
  assert.equal(state().turns.length, 1);
  assert.equal(state().pendingSession, null);
});

test("1.1 activate on a dead socket does not flip the view", () => {
  reset();
  apply(loaded("A", ["a1"]));
  useChatStore.setState({ status: "disconnected" });
  state().activateSession("B");
  assert.equal(state().currentSessionId, "A", "no optimistic flip without a live socket");
  assert.equal(state().pendingSession, null);
});

test("1.1 a suppressed run does not swallow a pending switch's error", () => {
  reset();
  // Welcome view, run dismissed (suppressed), then a failing switch.
  state().stopStreaming();
  assert.equal(state().suppressed, true);
  state().activateSession("missing");
  apply({ type: "error", message: "Agent is still initializing" });
  assert.equal(state().pendingSession, null, "the restore path ran despite suppression");
});

test("1.1 the new-session handshake applies its id-unknown load", () => {
  reset();
  apply(loaded("A", ["a1"]));
  state().beginNewSession();
  assert.equal(state().pendingNewSession, true);

  // Structural match: empty messages for an id we weren't viewing.
  apply(loaded("fresh-id", []));
  assert.equal(state().currentSessionId, "fresh-id");
  assert.equal(state().turns.length, 0);
  assert.equal(state().pendingNewSession, false, "the handshake is consumed");
});

test("1.1 pre-activation clients keep the apply-every-load contract", () => {
  reset();
  // No activateSession call: the mini program's pessimistic path.
  assert.equal(state().optimisticSessions, false);
  apply(loaded("X", ["x1"]));
  assert.equal(state().currentSessionId, "X");
  assert.equal(state().turns.length, 1);
});

test("2.1 re-entering a cached session renders instantly and reconciles", () => {
  reset();
  apply(loaded("A", ["a1", "a2"]));
  state().activateSession("B");
  apply(loaded("B", ["b1"]));
  assert.equal(state().sessionCache.size, 2, "both applied loads filled the cache");

  state().activateSession("A");
  assert.equal(state().turns.length, 2, "A's turns are already in the view — no wait");
  assert.equal(state().pendingSession, "A", "the background refresh is still armed");

  // The refresh lands with a change; it reconciles.
  apply(loaded("A", ["a1", "a2", "a3"]));
  assert.equal(state().turns.length, 3);
  assert.equal(state().pendingSession, null);
});

test("2.1 the cache holds at most 10 sessions (LRU eviction)", () => {
  reset();
  for (let i = 0; i < 11; i++) {
    const id = `s${i}`;
    state().activateSession(id);
    apply(loaded(id, [`m${i}`]));
  }
  assert.equal(state().sessionCache.size, 10);

  // s0 was the first filled and has been evicted; s10 (MRU) is present.
  state().activateSession("s0");
  assert.equal(state().turns.length, 0, "the evicted entry falls back to the skeleton");
  assert.equal(state().pendingSession, "s0");
  state().activateSession("s10");
  assert.equal(state().turns.length, 1, "the most recent entry is still cached");
});

test("2.1 a session leaving the sessions list drops its cache entry", () => {
  reset();
  apply(loaded("A", ["a1"]));
  assert.ok(state().sessionCache.has("A"));

  apply({ type: "sessions", sessions: [{ id: "B", title: "b" }] });
  assert.equal(state().sessionCache.has("A"), false, "deleted sessions are evicted");
  assert.deepEqual(
    state().sessions.map((s) => s.id),
    ["B"],
  );
});

test("2.1 a done while viewing refreshes the viewed session's entry", () => {
  reset();
  apply(loaded("A", ["a1"]));
  assert.equal(state().sessionCache.get("A").length, 1);

  // A live turn completes in A while the user views A.
  apply({ type: "user", text: "question" });
  apply({ type: "agent_start" });
  apply({ type: "done" });
  assert.equal(state().turns.length, 3, "user echo + assistant turn in the live view");
  assert.equal(state().sessionCache.get("A").length, 3, "the cache entry matches the view");

  // Re-entering A renders the completed conversation, not the loaded-only one.
  state().activateSession("B");
  apply(loaded("B", ["b1"]));
  state().activateSession("A");
  assert.equal(state().turns.length, 3);
});
