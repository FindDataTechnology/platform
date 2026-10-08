// Unit tests for the in-flight turn replay buffer (add-reconnect-resync):
//   - run events are mirrored into the buffer in delivery order while a
//     turn is streaming; non-run types (user echo, done, error) are not
//   - a fresh turn starts a fresh log (resetTurnBuffer)
//   - overflow drops the log whole (miss), exactly once
//   - the buffered payloads are the PRE-stamp wire objects (no sessionId
//     leakage into the replay — the client folds them as plain events)
// The session_loaded extension itself (running/turnEvents fields) is thin
// glue in ws.js over these ctx fields; the wire path is covered by the e2e.
//
// Run: node --test scripts/test-turn-replay.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-replay-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const { createAppContext } = await import("../server/context.js");
await db.initDb();

function makeCtx() {
  const ctx = createAppContext({ AUTH_MODE: "none" });
  const socket = {
    user: null,
    viewedSession: "s-run",
    readyState: 1,
    OPEN: 1,
    sent: [],
    send: (d) => socket.sent.push(d),
  };
  ctx.clients.add(socket);
  return { ctx, socket };
}

test("run events mirror into the buffer in delivery order", () => {
  const { ctx } = makeCtx();
  ctx.isStreaming = true;
  ctx.sendToViewers("s-run", { type: "agent_start" });
  ctx.sendToViewers("s-run", { type: "text", delta: "hello " });
  ctx.sendToViewers("s-run", { type: "text", delta: "world" });
  ctx.sendToViewers("s-run", { type: "tool_start", toolCallId: "c1", name: "bash", args: {} });
  ctx.sendToViewers("s-run", { type: "tool_end", toolCallId: "c1", name: "bash", result: "ok", isError: false });

  assert.ok(ctx.turnBuffer && !ctx.turnBuffer.overflow);
  assert.deepEqual(
    ctx.turnBuffer.events.map((e) => e.type),
    ["agent_start", "text", "text", "tool_start", "tool_end"],
  );
  // Buffered payloads are the pre-stamp wire objects — the replay must not
  // carry the delivery layer's additive sessionId.
  assert.equal(ctx.turnBuffer.events[1].sessionId, undefined);
  assert.equal(ctx.turnBuffer.events[1].delta, "hello ");
});

test("non-run types are not buffered", () => {
  const { ctx } = makeCtx();
  ctx.isStreaming = true;
  ctx.sendToViewers("s-run", { type: "user", text: "prompt" });
  ctx.sendToViewers("s-run", { type: "error", message: "x" });
  ctx.sendToViewers("s-run", { type: "done" });
  ctx.sendToViewers("s-run", { type: "todos", todos: [], counts: {} });
  assert.equal(ctx.turnBuffer, null);
});

test("idle periods do not buffer", () => {
  const { ctx } = makeCtx();
  ctx.isStreaming = false;
  ctx.sendToViewers("s-run", { type: "text", delta: "stray" });
  assert.equal(ctx.turnBuffer, null);
});

test("resetTurnBuffer starts a fresh log; finishTurn semantics", () => {
  const { ctx } = makeCtx();
  ctx.isStreaming = true;
  ctx.sendToViewers("s-run", { type: "agent_start" });
  assert.ok(ctx.turnBuffer.events.length === 1);
  ctx.resetTurnBuffer();
  assert.equal(ctx.turnBuffer, null);
  ctx.sendToViewers("s-run", { type: "text", delta: "fresh" });
  assert.deepEqual(ctx.turnBuffer.events.map((e) => e.type), ["text"]);
});

test("overflow drops the log whole and latches", () => {
  const { ctx } = makeCtx();
  ctx.isStreaming = true;
  ctx.sendToViewers("s-run", { type: "agent_start" });
  for (let i = 0; i < 2100; i++) {
    ctx.sendToViewers("s-run", { type: "text", delta: `chunk-${i}` });
    if (ctx.turnBuffer?.overflow) break;
  }
  assert.ok(ctx.turnBuffer.overflow, "cap must trip within the event budget");
  assert.deepEqual(ctx.turnBuffer.events, []);
  const eventsBefore = ctx.turnBuffer.events.length;
  ctx.sendToViewers("s-run", { type: "text", delta: "post-overflow" });
  assert.equal(ctx.turnBuffer.events.length, eventsBefore, "latched: nothing more appends");
});
