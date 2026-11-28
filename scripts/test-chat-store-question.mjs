// Unit tests for the chat store's pending-question slice (openspec:
// add-user-questions, task 3.1): agent_question establishes the pending ask,
// the ask's own tool_end clears it (answer / cancel / failure alike), a
// foreign tool_end does not, `done` clears it, session load clears it for the
// server's re-push, and a refused answer submission changes nothing.
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

const errors = [];
setChatErrorSink((message) => errors.push(message));

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
    pendingQuestion: null,
    suppressed: false,
  });
}

const apply = (m) => useChatStore.getState().apply(m);
const state = () => useChatStore.getState();

const QUESTIONS = [
  { id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
  { id: "q2", question: "Notes?" },
];

// Open a turn with the ask tool call, then the ask itself — the live order.
function openAsk() {
  apply({ type: "agent_start" });
  apply({ type: "tool_start", toolCallId: "c1", name: "ask_user_question", args: { questions: QUESTIONS } });
  apply({ type: "agent_question", askId: "a1", toolCallId: "c1", questions: QUESTIONS });
}

test("agent_question establishes the pending ask; a re-push replaces it", () => {
  reset();
  openAsk();
  assert.deepEqual(state().pendingQuestion, { askId: "a1", toolCallId: "c1", questions: QUESTIONS });

  // Reconnect sync re-delivers the same ask — the replacement is idempotent.
  apply({ type: "agent_question", askId: "a1", toolCallId: "c1", questions: QUESTIONS });
  assert.equal(state().pendingQuestion.askId, "a1");
});

test("the ask's own tool_end clears the pending state and resolves the block", () => {
  reset();
  openAsk();
  apply({
    type: "tool_end",
    toolCallId: "c1",
    name: "ask_user_question",
    result: '{"answers":[{"id":"q1","selected":["Yes"]}]}',
    isError: false,
  });
  assert.equal(state().pendingQuestion, null);
  const block = state().turns.at(-1).blocks.find((b) => b.id === "c1");
  assert.equal(block.state, "done");
});

test("a foreign tool_end does not clear the pending ask", () => {
  reset();
  openAsk();
  apply({ type: "tool_start", toolCallId: "c2", name: "bash", args: {} });
  apply({ type: "tool_end", toolCallId: "c2", name: "bash", result: "", isError: false });
  assert.equal(state().pendingQuestion?.askId, "a1");
});

test("done clears a pending ask — it can never resolve after its turn", () => {
  reset();
  openAsk();
  apply({ type: "done" });
  assert.equal(state().pendingQuestion, null);
});

test("session load clears the card for the server's own re-push", () => {
  reset();
  openAsk();
  apply({ type: "session_loaded", id: "s2", title: "t", messages: [] });
  assert.equal(state().pendingQuestion, null);
  // The server's sync (still pending) re-establishes it.
  apply({ type: "agent_question", askId: "a1", toolCallId: "c1", questions: QUESTIONS });
  assert.equal(state().pendingQuestion.askId, "a1");
});

test("a refused answer submission changes nothing", () => {
  reset();
  openAsk();
  apply({ type: "answer_question_error", message: "No pending question for this session" });
  assert.equal(state().pendingQuestion?.askId, "a1");
});
