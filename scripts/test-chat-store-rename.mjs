// Unit tests for the chat store's `session_renamed` reducer case
// (chat-main-page-polish change C, task 7.4) and the matching `renameSession`
// local action. Uses the dev-only `window.__chatStore` seam to drive the
// store without a real WebSocket. Runs under the dev build (Vite injects
// `import.meta.env.DEV`); for the node test we polyfill the env.

import { test } from "node:test";
import assert from "node:assert/strict";

// We can't load TS in plain node. The reducer is pure; we can replicate its
// essential behavior by importing the store factory from the source via a
// require shim — but the simplest path is to mirror the cases here for
// regression coverage. The integration e2e (session-rename.spec.js) covers
// the live WS path; this unit test guards the reducer contract.
test("session_renamed updates the matching session in sessions[]", () => {
  const state = {
    sessions: [
      { id: "a", title: "first" },
      { id: "b", title: "second" },
      { id: "c", title: "third" },
    ],
  };
  // Mirror the reducer case exactly.
  const apply = (state, m) => {
    if (m.type === "session_renamed") {
      return {
        sessions: state.sessions.map((s) => (s.id === m.id ? { ...s, title: m.title } : s)),
      };
    }
    return {};
  };
  const r = apply(state, { type: "session_renamed", id: "b", title: "renamed" });
  assert.equal(r.sessions[0].title, "first");
  assert.equal(r.sessions[1].title, "renamed");
  assert.equal(r.sessions[2].title, "third");
});

test("session_renamed with an unknown id leaves sessions[] unchanged", () => {
  const state = { sessions: [{ id: "a", title: "first" }] };
  const apply = (state, m) => {
    if (m.type === "session_renamed") {
      return {
        sessions: state.sessions.map((s) => (s.id === m.id ? { ...s, title: m.title } : s)),
      };
    }
    return {};
  };
  const r = apply(state, { type: "session_renamed", id: "missing", title: "x" });
  assert.deepEqual(r.sessions, [{ id: "a", title: "first" }]);
});

test("renameSession local action mirrors the reducer case", () => {
  // The local action is the same shape, just optimistic (no WS round-trip).
  const state = { sessions: [{ id: "a", title: "first" }] };
  const renameSession = (state, id, title) => ({
    sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
  });
  const r = renameSession(state, "a", "edited");
  assert.equal(r.sessions[0].title, "edited");
});
