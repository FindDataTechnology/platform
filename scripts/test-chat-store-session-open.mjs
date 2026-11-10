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
    sessionWindowMeta: new Map(),
    transcriptTotal: 0,
    transcriptHasMore: false,
    transcriptOldestSeq: null,
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
  assert.equal(state().sessionWindowMeta.has("A"), false, "and their window meta goes with them");
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

// ── Windowed transcript + paging (polish-web-surfaces) ───────────────────────

// A windowed load: messages carry their paging cursor, plus the counts.
const windowed = (id, texts, { totalTurns, hasMore } = {}) => ({
  type: "session_loaded",
  id,
  title: id,
  messages: texts.map((t, i) => ({ role: "user", content: t, seq: (hasMore ? 51 : 1) + i })),
  totalTurns: totalTurns ?? texts.length,
  hasMore: hasMore ?? false,
});

test("3.2 a windowed load records the counts and the earliest cursor", () => {
  reset();
  apply(windowed("L", ["m51", "m52"], { totalTurns: 80, hasMore: true }));
  assert.equal(state().turns.length, 2, "only the window is in the store");
  assert.equal(state().transcriptTotal, 80, "the full count rides the load");
  assert.equal(state().transcriptHasMore, true);
  assert.equal(state().transcriptOldestSeq, 51, "cursor = the earliest loaded seq");
});

test("3.5 a pre-windowing load (no counts) reads as complete", () => {
  reset();
  apply(loaded("A", ["a1", "a2"]));
  assert.equal(state().transcriptTotal, 2, "falls back to the loaded length");
  assert.equal(state().transcriptHasMore, false, "older servers have nothing to page");
  assert.equal(state().transcriptOldestSeq, null, "no seq on legacy messages");
});

// User turns carry `text`; assistant turns carry content in `blocks` — read
// whichever the role uses.
const textOf = (t) => (t.role === "user" ? t.text : (t.blocks?.[0]?.text ?? ""));

test("3.4 a session_page prepends the earlier turns and advances the cursor", () => {
  reset();
  apply(windowed("L", ["m51", "m52"], { totalTurns: 80, hasMore: true }));
  apply({
    type: "session_page",
    id: "L",
    messages: [
      { role: "user", content: "m49", seq: 49 },
      { role: "assistant", content: "m50", seq: 50 },
    ],
    hasMore: true,
  });
  assert.deepEqual(
    state().turns.map(textOf),
    ["m49", "m50", "m51", "m52"],
    "the page mounts above the existing window",
  );
  assert.equal(state().transcriptOldestSeq, 49, "the cursor moves to the page's first seq");
  assert.equal(state().transcriptHasMore, true);

  // The oldest page ends the paging.
  apply({ type: "session_page", id: "L", messages: [{ role: "user", content: "m1", seq: 1 }], hasMore: false });
  assert.equal(state().transcriptHasMore, false);
  assert.equal(textOf(state().turns[0]), "m1");
});

test("3.4 a page for a session the client is not viewing is dropped", () => {
  reset();
  apply(windowed("L", ["m51"], { totalTurns: 80, hasMore: true }));
  apply({ type: "session_page", id: "OTHER", messages: [{ role: "user", content: "x", seq: 1 }], hasMore: false });
  assert.equal(state().turns.length, 1, "the viewed transcript is untouched");
  assert.equal(state().transcriptHasMore, true, "and its paging state is untouched");
});

test("3.4 a cached re-entry restores the session's OWN paging state (hangbook fix)", () => {
  reset();
  apply(windowed("L", ["m51", "m52"], { totalTurns: 80, hasMore: true }));
  apply(loaded("B", ["b1"]));

  // Re-enter L from cache — BEFORE any background refresh lands, the paging
  // state must already be L's own: its total, its flag, and crucially its own
  // cursor. (This was the lived gap: the fields stayed B's for the whole
  // reconcile window, and a click could page L with B's seq.)
  state().activateSession("L");
  assert.equal(state().transcriptTotal, 80, "L's own total, not B's 1");
  assert.equal(state().transcriptHasMore, true, "L still has earlier pages cached-side");
  assert.equal(state().transcriptOldestSeq, 51, "L's own cursor — never B's");
  assert.equal(state().turns.length, 2, "L's cached turns render instantly");
  assert.deepEqual(
    state().sessionWindowMeta.get("L"),
    { total: 80, hasMore: true, oldestSeq: 51 },
    "L's metadata rides the cache entry",
  );

  // ...and B's state survives inside ITS entry for its own re-entry.
  state().activateSession("B");
  assert.equal(state().transcriptTotal, 1, "B's own total");
  assert.equal(state().transcriptHasMore, false, "B reads as complete");
  assert.equal(state().transcriptOldestSeq, null, "B had no seq to restore");
});

test("3.4 an uncached switch never keeps the previous session's paging state", () => {
  reset();
  apply(windowed("L", ["m51", "m52"], { totalTurns: 80, hasMore: true }));
  state().activateSession("EMPTY");
  assert.equal(state().transcriptTotal, 0, "a skeleton is not a transcript");
  assert.equal(state().transcriptHasMore, false);
  assert.equal(state().transcriptOldestSeq, null);
  assert.ok(state().sessionWindowMeta.has("L"), "but L's meta stays in the cache for its re-entry");
});
