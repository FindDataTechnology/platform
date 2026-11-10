// Unit tests for the reconnect resync semantics (add-reconnect-resync):
//   - a socket drop does NOT finalize the open turn (no interrupted marker,
//     no suppression, isStreaming kept, tool blocks keep running) — the run
//     is server-authoritative and keeps executing
//   - session_loaded three-branch recovery: replay rebuild, buffer-miss
//     keep-local, running:false truthful replace
//   - a dismissed run (user stop) resists the resync
//   - stopStreaming is the one honest source of the interrupted marker
//   - session-scoped events for a foreign view are dropped
// Drives the REAL store module (see test-chat-store-session-open.mjs for the
// loader note). The live WS path is exercised by the e2e specs.

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

const flushDeltas = () => new Promise((r) => setTimeout(r, 90));

function reset() {
  useChatStore.setState({
    status: "connected",
    currentSessionId: "s-run",
    optimisticSessions: true,
    turns: [],
    isStreaming: false,
    pendingSession: null,
    pendingNewSession: false,
    sessionSwitchBackup: null,
    suppressed: false,
    todos: [],
    todoCounts: { pending: 0, inProgress: 0, completed: 0 },
    pendingQuestion: null,
    sessionCache: new Map(),
  });
}

function openStreamingTurn() {
  const s = useChatStore.getState();
  s.apply({ type: "user", text: "run this", sessionId: "s-run" });
  s.apply({ type: "agent_start", sessionId: "s-run" });
  s.apply({ type: "text", delta: "partial answer ", sessionId: "s-run" });
  s.apply({
    type: "tool_start",
    toolCallId: "c1",
    name: "bash",
    args: { cmd: "ls" },
    sessionId: "s-run",
  });
}

function tailTurn() {
  const turns = useChatStore.getState().turns;
  return turns[turns.length - 1];
}

test("socket drop leaves the turn transient, not finalized", async () => {
  reset();
  openStreamingTurn();
  const s = useChatStore.getState();
  s.setStatus("disconnected");

  const t = tailTurn();
  assert.equal(t.role, "assistant");
  assert.equal(t.streaming, true, "streaming kept — the run continues server-side");
  assert.equal(t.interrupted, undefined, "no false interrupted marker");
  assert.equal(t.connectionLost, true, "transient marker set");
  assert.equal(useChatStore.getState().isStreaming, true);
  assert.equal(useChatStore.getState().suppressed, false, "no suppression armed");

  // The tool block keeps its running state — no 运行中/已中断 contradiction.
  const tool = t.blocks.find((b) => b.kind === "tool");
  assert.equal(tool.state, "running");

  // Late live events still apply (no swallow) and clear the marker.
  s.apply({ type: "text", delta: "continued", sessionId: "s-run" });
  await flushDeltas();
  const t2 = tailTurn();
  assert.equal(t2.connectionLost, undefined, "first live event clears the marker");
});

test("disconnect with a leaked pendingNewSession still marks the live turn", () => {
  // The empty new-session load can resolve via the id-equality path (the
  // sessions frame adopted the minted id first), leaving pendingNewSession
  // armed. The drop must not take the switch-restore exit and swallow the
  // transient marker for the run the user is watching.
  reset();
  openStreamingTurn();
  useChatStore.setState({ pendingNewSession: true, sessionSwitchBackup: null });
  useChatStore.getState().setStatus("disconnected");
  const t = tailTurn();
  assert.equal(t.role, "assistant");
  assert.equal(t.streaming, true);
  assert.equal(t.connectionLost, true, "marker set despite the leaked handshake flag");
  assert.equal(useChatStore.getState().pendingNewSession, false, "the drop still consumes the handshake");
});

test("done after a drop closes the turn and clears the transient marker", async () => {
  reset();
  openStreamingTurn();
  const s = useChatStore.getState();
  s.setStatus("disconnected");
  s.apply({ type: "text", delta: "more", sessionId: "s-run" });
  await flushDeltas();
  s.apply({ type: "done", sessionId: "s-run" });
  const t = tailTurn();
  assert.equal(t.streaming, false);
  assert.equal(t.connectionLost, undefined);
  assert.equal(useChatStore.getState().isStreaming, false);
});

test("session_loaded running:true + turnEvents rebuilds the turn via replay", async () => {
  reset();
  openStreamingTurn();
  useChatStore.getState().setStatus("disconnected");
  // Server answer: persisted transcript (user echo only — the assistant
  // partial is not persisted mid-run) + the full replay log.
  useChatStore.getState().apply({
    type: "session_loaded",
    id: "s-run",
    messages: [{ role: "user", content: "run this" }],
    running: true,
    turnEvents: [
      { type: "agent_start" },
      { type: "text", delta: "partial answer " },
      { type: "text", delta: "plus the blackout window" },
    ],
  });
  await flushDeltas();

  const turns = useChatStore.getState().turns;
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
  const a = turns[1];
  assert.equal(a.streaming, true);
  assert.equal(
    a.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(""),
    "partial answer plus the blackout window",
    "replay is a superset of the local partial — no visible shrink",
  );
  assert.equal(useChatStore.getState().isStreaming, true);
  assert.equal(tailTurn().connectionLost, undefined);
});

test("session_loaded running:true buffer-miss keeps the local partial", async () => {
  reset();
  openStreamingTurn();
  useChatStore.getState().setStatus("disconnected");
  useChatStore.getState().apply({
    type: "session_loaded",
    id: "s-run",
    messages: [{ role: "user", content: "run this" }],
    running: true,
    // no turnEvents — process restarted / overflow
  });
  await flushDeltas();

  const turns = useChatStore.getState().turns;
  assert.equal(turns.length, 2, "local turns kept, not replaced by the partial-less transcript");
  const a = turns[1];
  assert.equal(a.streaming, true);
  assert.equal(
    a.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(""),
    "partial answer ",
  );
  assert.equal(a.connectionLost, true, "marker persists — renders as resumed-lagging");
  assert.equal(useChatStore.getState().isStreaming, true);

  // Live continuation appends after the kept partial.
  useChatStore.getState().apply({ type: "text", delta: "tail", sessionId: "s-run" });
  await flushDeltas();
  assert.equal(
    tailTurn().blocks.filter((b) => b.kind === "text").map((b) => b.text).join(""),
    "partial answer tail",
  );
});

test("buffer-miss onto a view with no open turn falls back to the transcript", () => {
  reset();
  // A fresh switch onto a running session: local view is a foreign skeleton.
  useChatStore.setState({ currentSessionId: "s-run", turns: [] });
  useChatStore.getState().apply({
    type: "session_loaded",
    id: "s-run",
    messages: [{ role: "user", content: "run this" }],
    running: true,
  });
  const turns = useChatStore.getState().turns;
  assert.deepEqual(turns.map((t) => t.role), ["user"]);
  assert.equal(useChatStore.getState().isStreaming, true, "live events will open the turn");
});

test("session_loaded running:false truthfully finalizes", () => {
  reset();
  openStreamingTurn();
  useChatStore.getState().setStatus("disconnected");
  useChatStore.getState().apply({
    type: "session_loaded",
    id: "s-run",
    messages: [
      { role: "user", content: "run this" },
      { role: "assistant", content: "the full answer that completed during the blackout" },
    ],
    running: false,
  });
  const turns = useChatStore.getState().turns;
  assert.equal(turns.length, 2);
  assert.equal(turns[1].streaming, false);
  assert.equal(useChatStore.getState().isStreaming, false);
});

test("a dismissed run resists the resync", async () => {
  reset();
  openStreamingTurn();
  const s = useChatStore.getState();
  s.stopStreaming();
  assert.equal(tailTurn().interrupted, true, "user stop marks interrupted");
  assert.equal(useChatStore.getState().suppressed, true);

  // The resync answer for a still-running turn must not resurrect the run.
  s.apply({
    type: "session_loaded",
    id: "s-run",
    messages: [{ role: "user", content: "run this" }],
    running: true,
    turnEvents: [{ type: "agent_start" }, { type: "text", delta: "resurrected" }],
  });
  await flushDeltas();
  const turns = useChatStore.getState().turns;
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user"],
    "stays dismissed: the transcript replace applied, but no replay fold opened a turn",
  );
  assert.equal(
    turns.some((t) =>
      t.role === "assistant" &&
      t.blocks.some((b) => b.kind === "text" && b.text.includes("resurrected")),
    ),
    false,
    "replayed text never landed",
  );
  assert.equal(useChatStore.getState().isStreaming, false);

  // Late events stay swallowed until the run's own done.
  s.apply({ type: "text", delta: "late", sessionId: "s-run" });
  await flushDeltas();
  const tailAfterLate = tailTurn();
  assert.equal(
    tailAfterLate.role === "assistant"
      ? tailAfterLate.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("")
      : "(no assistant turn)",
    "(no assistant turn)",
    "swallowed while suppressed — no turn re-opened, no text landed",
  );
  s.apply({ type: "done", sessionId: "s-run" });
  assert.equal(useChatStore.getState().suppressed, false);
});

test("session-scoped events for a foreign view are dropped", async () => {
  reset();
  openStreamingTurn();
  const s = useChatStore.getState();
  // The server adopted the reconnected socket into the live session while
  // this client views another one. Assistant-side run events and done for
  // the foreign session are dropped; the user echo stays unguarded (the
  // prompt-implies-switch race may echo from the connection's previous
  // session — dropping it would blank the turn just submitted).
  s.apply({ type: "text", delta: "foreign", sessionId: "s-other" });
  s.apply({ type: "agent_start", sessionId: "s-other" });
  s.apply({ type: "done", sessionId: "s-other" });
  s.apply({ type: "user", text: "foreign echo", sessionId: "s-other" });
  await flushDeltas();
  const turnsNow = useChatStore.getState().turns;
  const assistant = [...turnsNow].reverse().find((t) => t.role === "assistant");
  assert.equal(
    assistant.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(""),
    "partial answer ",
    "foreign stream never folded",
  );
  assert.equal(assistant.streaming, true, "foreign done did not close the local turn");
  assert.equal(useChatStore.getState().isStreaming, true);
  assert.ok(
    useChatStore.getState().turns.some((t) => t.role === "user" && t.text === "foreign echo"),
    "user echo applies unguarded",
  );

  // Pre-stamp payloads (older servers) still apply.
  s.apply({ type: "text", delta: "legacy" });
  await flushDeltas();
  // The pre-stamp delta applies to the open run — with the interleaved
  // foreign user echo it opens a fresh assistant turn; across the view, both
  // the original partial and the legacy tail are present.
  const allText = useChatStore
    .getState()
    .turns.filter((t) => t.role === "assistant")
    .map((t) => t.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(""))
    .join("|");
  assert.ok(allText.includes("partial answer") && allText.includes("legacy"), allText);
});
