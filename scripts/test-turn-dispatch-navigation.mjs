// Deterministic reproduction of the "another connection opens a new chat while
// a turn is streaming" path — the exact sequence the live probes kept blurring:
//
//   1. connection A prompts session S; the ws layer latches S streaming and the
//      dispatcher reserves the turn (this test performs both, no HTTP);
//   2. connection B sends `new_session` → ctx.startNewSession(wsB) →
//      createNewSession → sessionManager.newSession() moves the global pointer;
//   3. dsh reports S idle.
//
// Assert: S's viewers receive `done` and S's turn state closes.
//
// Run: node --test scripts/test-turn-dispatch-navigation.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nav-repro-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");
const { createAppContext } = await import("../server/context.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const { attachAgentSession } = await import("../server/agent-session.js");
const { attachTurnDispatch } = await import("../server/turn-dispatch.js");
const { attachRuntimeBindings } = await import("../server/runtime-bindings.js");

await db.initDb();

// A session-manager shim identical to the one server.js installs: it moves
// the CONTEXT's pointer, not a private variable (the wrapper's sid default
// reads that pointer — a test-local variable would hide the bug).
let context = null;
const sm = {
  getSessionId: () => context.dshSessionId,
  getSessionFile: () => null,
  buildSessionContext: () => ({ messages: [] }),
  newSession: () => {
    context.dshSessionId = "platform-new-" + Math.random().toString(36).slice(2, 8);
  },
  setSessionId: (id) => {
    context.dshSessionId = id;
  },
  setSessionFile: () => {},
};
chatHistory.setSessionManager(sm);
chatHistory.setPresetSource(() => "standard");
chatHistory.setWorkspaceSource(() => null);

function makeCtx() {
  const ctx = createAppContext({});
  ctx.broadcast = () => {};
  ctx.broadcastSessions = async () => {};
  ctx.db = { getSessionMeta: () => null, getPreference: () => null };
  ctx.session = {
    prompt: async () => {},
    model: { id: "m", provider: "p" },
    sessionManager: sm,
  };
  ctx.dshBridge = {
    isReady: () => true,
    hasLiveMethod: () => true,
    cancelSession: async () => {},
    restart: async () => {},
    prompt: async () => "mid-1",
  };
  const sent = [];
  ctx.sendToViewers = (sid, msg) => sent.push({ sid, type: msg.type });
  ctx.__sent = sent;
  attachDshEvents(ctx);
  // The real composition root wraps finishTurn here (server.js order). The
  // wrapper must forward (outcome, sid) — dropping sid re-defaults it to the
  // global pointer and a background turn's close lands on the wrong session.
  attachRuntimeBindings(ctx);
  attachAgentSession(ctx);
  attachTurnDispatch(ctx);
  ctx.dshSessionId = "platform-S";
  context = ctx;
  return ctx;
}

test("a new chat on another connection does not swallow the streaming turn's done", async () => {
  const ctx = makeCtx();

  // (1) A's prompt: the ws layer's synchronous latch + the dispatcher.
  ctx.webTurnSessions.add("platform-S");
  ctx.turnStateFor("platform-S").origin = { user: null, sessionId: "platform-S" };
  ctx.setStreaming("platform-S", true);

  // (2) Another connection opens a new chat.
  const wsB = { viewedSession: null, readyState: 1, send: () => {} };
  await ctx.startNewSession(wsB);
  assert.notEqual(chatHistory.currentSessionId(), "platform-S", "the pointer must have moved");

  // (3) dsh reports S idle.
  ctx.handleDshEvent({ method: "session.status", params: { sessionId: "platform-S", status: "idle" } });

  const done = ctx.__sent.find((m) => m.type === "done" && m.sid === "platform-S");
  assert.ok(done, `S must receive done; sent=${JSON.stringify(ctx.__sent)}`);
  assert.equal(ctx.isStreamingFor("platform-S"), false, "S's turn state must close");
});

test("the queued prompt behind it still dispatches after that done", async () => {
  const ctx = makeCtx();

  ctx.webTurnSessions.add("platform-S");
  ctx.turnStateFor("platform-S").origin = { user: null, sessionId: "platform-S" };
  ctx.setStreaming("platform-S", true);

  let qRan = false;
  const receipt = ctx.dispatchTurn({
    sessionId: "platform-Q",
    text: "queued",
    run: async () => {
      qRan = true;
    },
  });
  assert.equal(receipt.queued, true);

  const wsB = { viewedSession: null, readyState: 1, send: () => {} };
  await ctx.startNewSession(wsB);
  ctx.handleDshEvent({ method: "session.status", params: { sessionId: "platform-S", status: "idle" } });

  assert.equal(qRan, true, "S closing must let the queue advance");
});
