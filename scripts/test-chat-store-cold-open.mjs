// Regression tests for fix-cold-open-stuck-skeleton: a `sessions` list
// broadcast must not write the view's currentSessionId while a switch is
// settling, and the stale-load guard must compare against the SWITCH TARGET.
//
// The lived bug (2026-11-20): a cron round's `sessions` broadcast carries
// `current` = the deployment's live session, which during a cold deep-link is
// usually NOT the session the client is opening. It rewrote currentSessionId,
// so the switch's own `session_loaded` failed the stale-load guard, filled the
// cache only, and left pendingSession set — a skeleton that never resolves.
//
// Drives the REAL store module, same resolve-hook setup as
// test-chat-store-session-open.mjs.

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

setChatErrorSink(() => {});

function reset() {
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

const row = (id) => ({ id, title: id });
const loaded = (id, texts) => ({
  type: "session_loaded",
  id,
  title: id,
  messages: texts.map((t) => ({ role: "user", content: t })),
});

test("B1 a sessions broadcast during a pending switch does not steal the view", () => {
  reset();
  apply(loaded("A", ["a1"]));
  state().activateSession("Y");
  assert.equal(state().currentSessionId, "Y");
  assert.equal(state().pendingSession, "Y");

  // cron round ends: the list refresh names the deployment's live session X.
  apply({ type: "sessions", sessions: [row("A"), row("Y"), row("X")], current: "X" });
  assert.equal(state().currentSessionId, "Y", "the broadcast must not clobber the settling view");
  assert.equal(state().pendingSession, "Y", "the pending switch stays armed");

  // The switch's own load lands and resolves normally.
  apply(loaded("Y", ["y1"]));
  assert.equal(state().currentSessionId, "Y");
  assert.equal(state().pendingSession, null, "the skeleton resolves");
  assert.equal(state().turns.length, 1);
});

test("B1 a sessions broadcast during a pending NEW session does not steal the view", () => {
  reset();
  apply(loaded("A", ["a1"]));
  state().beginNewSession();
  assert.equal(state().pendingNewSession, true);

  apply({ type: "sessions", sessions: [row("A"), row("X")], current: "X" });
  assert.equal(state().currentSessionId, "A", "the pre-new-session view is held");

  // The structural new-chat arrival still applies past the guard.
  apply(loaded("fresh-id", []));
  assert.equal(state().currentSessionId, "fresh-id");
  assert.equal(state().pendingNewSession, false);
});

test("B1 the cold deep-link frame order that used to strand the skeleton", () => {
  reset();
  // Cold open: no prior view. The client activates the deep-link target…
  state().activateSession("Y");
  assert.equal(state().pendingSession, "Y");

  // …then the connect burst's session-list frames arrive with the live session.
  apply({ type: "sessions", sessions: [row("X"), row("Y")], current: "X" });
  apply({ type: "sessions", sessions: [row("X"), row("Y")], current: "X" });
  assert.equal(state().currentSessionId, "Y", "still on the target");
  assert.equal(state().pendingSession, "Y");

  apply(loaded("Y", ["y1", "y2"]));
  assert.equal(state().pendingSession, null, "resolved — no permanent skeleton");
  assert.equal(state().turns.length, 2);
});

test("B1 an unrelated session_loaded cannot outrank the switch target", () => {
  reset();
  apply(loaded("A", ["a1"]));
  state().activateSession("Y");

  // A stray load for Z arrives first (another viewer / a stale frame).
  apply(loaded("Z", ["z1"]));
  assert.equal(state().currentSessionId, "Y", "Z does not replace the view");
  assert.equal(state().pendingSession, "Y", "the switch is still armed");
  assert.ok(state().sessionCache.has("Z"), "Z still feeds the cache");

  apply(loaded("Y", ["y1"]));
  assert.equal(state().currentSessionId, "Y");
  assert.equal(state().pendingSession, null);
  assert.equal(state().turns.length, 1);
});

test("B1 with no switch settling, a sessions broadcast still updates the view", () => {
  reset();
  apply(loaded("A", ["a1"]));
  assert.equal(state().pendingSession, null);

  // Another device switched the deployment's session; this client follows —
  // the pre-existing contract must survive the guard's narrowing.
  apply({ type: "sessions", sessions: [row("A"), row("B")], current: "B" });
  assert.equal(state().currentSessionId, "B");
});

test("B1 a sessions frame without a current leaves the view alone", () => {
  reset();
  apply(loaded("A", ["a1"]));
  apply({ type: "sessions", sessions: [row("A")] });
  assert.equal(state().currentSessionId, "A");
});
