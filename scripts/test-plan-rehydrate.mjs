// WS-level integration test for the plan rehydration pushes
// (add-plan-progress-panel, task 1.4): the real `attachWebSocket` handler, a
// real WebSocket client, and the real `ctx.planMessage` — only the dsh bridge
// and the session store are stubbed.
//
// Why here and not in the Playwright suite: the fast e2e project makes no LLM
// calls, so it can never produce a server-side plan to restore. Seeding
// `ctx.planBySession` is what makes the restore path deterministic.
//
// Covered contract scenarios:
//   - a connecting client receives the current session's snapshot (empty here)
//   - switching to a session that has a plan pushes that plan, after the
//     transcript it belongs to
//   - switching to a session without one pushes the clearing (empty) list
//   - the cached plan survives the switch (it is that session's state)
//
// Run: node --test scripts/test-plan-rehydrate.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-rehydrate-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const { createAppContext } = await import("../server/context.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const { attachWebSocket } = await import("../server/ws.js");
const { createSession } = await import("../chat-history.js");

const WEB_SESSION = "platform-current";
const PLAN_SESSION = "platform-has-plan";
const EMPTY_SESSION = "platform-no-plan";
const NO_COUNTS = { pending: 0, inProgress: 0, completed: 0 };

const PLAN = {
  todos: [
    { content: "Wire the event", status: "completed" },
    { content: "Render the panel", status: "in_progress" },
  ],
  counts: { pending: 0, inProgress: 1, completed: 1 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx;
let server;
let port;
const clients = [];

before(async () => {
  ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = WEB_SESSION;
  // The handlers gate on the runtime being live; the bridge itself is the one
  // piece this test replaces.
  ctx.ready.dsh = true;
  // The bridge and the model list are the only runtime pieces this test does
  // not exercise; everything the connection/switch handlers touch is real.
  ctx.switchableAgents = () => [];
  ctx.getAvailableModels = async () => [];
  ctx.getPermissionPresets = async () => ({ options: [], current: null });
  ctx.sendUserBindings = () => {};
  ctx.switchToSession = async (id) => ({ id, title: `Session ${id}`, messages: [] });
  ctx.session = { model: { id: "test-model", provider: "test" } };
  // The switch handler's ownership gate (add-session-ownership) checks the
  // session row before ctx.switchToSession runs — auth-off still requires the
  // row to exist, so bring the store up and seed the switch targets.
  const { initDb } = await import("../db.js");
  await initDb();
  createSession(PLAN_SESSION);
  createSession(EMPTY_SESSION);

  server = createServer();
  ctx.server = server;
  ctx.wss = new WebSocketServer({ noServer: true });
  attachWebSocket(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  // A live ws connection keeps server.close() waiting forever — terminate the
  // clients first, then the server, then the lingering sockets.
  for (const client of clients) client.terminate();
  for (const client of ctx.clients) client.terminate();
  ctx.wss.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Connect and collect every server message; `waitFor` polls the collected set.
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  clients.push(ws);
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const waitFor = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(messages)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out; saw: ${messages.map((m) => m.type).join(", ")}`);
      }
      await sleep(50);
    }
  };
  return {
    ws,
    messages,
    waitFor,
    open: () => new Promise((resolve) => ws.once("open", resolve)),
    todos: () => messages.filter((m) => m.type === "todos"),
  };
}

test("a connecting client receives the current session's plan snapshot", async () => {
  const c = connect();
  await c.open();
  await c.waitFor((ms) => ms.some((m) => m.type === "todos"));

  // No plan for the current session yet → the empty form, never silence (a
  // fresh page must not keep a previous session's plan on screen).
  assert.deepEqual(c.todos(), [{ type: "todos", todos: [], counts: NO_COUNTS }]);
  c.ws.close();
});

test("switching to a session with a plan pushes that plan; one without clears", async () => {
  ctx.planBySession.set(PLAN_SESSION, PLAN);
  const c = connect();
  await c.open();
  await c.waitFor((ms) => ms.some((m) => m.type === "todos"));

  c.ws.send(JSON.stringify({ type: "switch_session", id: PLAN_SESSION }));
  await c.waitFor((_ms) => c.todos().length === 2);
  assert.deepEqual(
    c.todos().at(-1),
    // Per-viewer payloads carry the session id (add-session-ownership additive field).
    { type: "todos", sessionId: PLAN_SESSION, todos: PLAN.todos, counts: PLAN.counts },
  );

  // The session swap itself still happened, ahead of the plan push.
  const types = c.messages.map((m) => m.type);
  assert.ok(types.includes("session_loaded"), `expected session_loaded in ${types.join(", ")}`);
  assert.ok(
    types.indexOf("session_loaded") < types.lastIndexOf("todos"),
    "the plan push must follow the transcript it belongs to",
  );

  c.ws.send(JSON.stringify({ type: "switch_session", id: EMPTY_SESSION }));
  await c.waitFor((_ms) => c.todos().length === 3);
  assert.deepEqual(
    c.todos().at(-1),
    { type: "todos", sessionId: EMPTY_SESSION, todos: [], counts: NO_COUNTS },
  );

  // The cached plan belongs to its session and is not consumed by the switch.
  assert.deepEqual(ctx.planBySession.get(PLAN_SESSION), PLAN);
  c.ws.close();
});
