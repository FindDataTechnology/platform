// Tests for the accountless demo sandbox (openspec: mp-demo-sandbox):
// the everyone-budget, the per-connection prompt cap, the upload guard, and
// the session-wipe step. All unit/fake-ctx level — the demo POD's deployment
// contract is exercised at go-live (see tasks 5.x). Runs under
// `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

test("unit: everyone-budget counts every identity, instances independent", async () => {
  const { createDemoBudget } = await import("../server/ws.js");
  const a = createDemoBudget(2, { everyone: true });
  assert.equal(a.take(null), true, "no identity counts in everyone mode");
  assert.equal(a.take({ email: "x@y.z", groups: [] }), true);
  assert.equal(a.take(null), false, "third take refused");
  const b = createDemoBudget(2, { everyone: true });
  assert.equal(b.take(null), true, "a second instance has its own budget");
  const gw = createDemoBudget(2);
  assert.equal(gw.take({ email: "x@y.z", groups: [] }), true, "gateway mode still passes account users");
  assert.equal(gw.take({ email: "d@demo.invalid", groups: ["demo"] }), true);
});

test("unit: sandbox pod — each connection gets its own cap; refusal starts no turn", async () => {
  process.env.MP_DEMO_MSG_LIMIT = "3";
  const { attachWebSocket, SANDBOX_LIMIT_REPLY } = await import("../server/ws.js");

  const prompts = [];
  const replies = [];
  const broadcasts = [];
  const ctx = {
    server: new EventEmitter(),
    wss: new EventEmitter(),
    clients: new Set(),
    authMode: "none", // the demo pod runs AUTH_MODE=none — identity-free
    DEMO_SANDBOX: true,
    ready: { dsh: true },
    isStreaming: false,
    promptStoppedByNavigation: false,
    currentAgentId: "local",
    dshSessionId: null,
    runtimeModel: null,
    session: {
      prompt: async () => {
        prompts.push(1);
        ctx.finishTurn();
      },
      // beginTurnFor's no-live-session path (add-session-ownership) adopts a
      // new session as this connection's view before prompting into it.
      sessionManager: { setSessionId: () => {} },
    },
    startNewSession: async (ws) => {
      const id = "sandbox-test-session";
      if (ws) ws.viewedSession = id;
      return id;
    },
    getPermissionPresets: async () => ({ options: [], current: null }),
    switchableAgents: () => [],
    // The connect-time session list is scoped per connection (add-session-
    // ownership); AUTH_MODE=none ⇒ no scoping — undefined is the auth-off scope.
    sessionScopeFor: () => undefined,
    planMessage: () => ({ type: "plan", steps: [] }),
    remoteChatEntryFor: () => null,
    broadcast: (m) => broadcasts.push(m),
    // Turn fan-out is per-session now (add-session-ownership); this suite
    // asserts on prompts and per-connection replies, not on the fan-out.
    sendToViewers: () => {},
    finishTurn: () => {
      ctx.isStreaming = false;
    },
  };
  attachWebSocket(ctx);

  const openWs = () => {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.OPEN = 1;
    ws.send = (raw) => replies.push(JSON.parse(raw));
    ctx.wss.emit("connection", ws, { headers: {} });
    return ws;
  };
  const send = (ws, text) => ws.emit("message", Buffer.from(JSON.stringify({ type: "prompt", text })));
  const settle = () => new Promise((r) => setTimeout(r, 20));

  // Reviewer 1 uses up their connection budget…
  const one = openWs();
  for (let i = 1; i <= 3; i++) {
    send(one, `q${i}`);
    await settle();
  }
  assert.equal(prompts.length, 3);
  send(one, "q4");
  await settle();
  assert.equal(prompts.length, 3, "prompt #4 starts no turn");
  assert.ok(replies.some((m) => m.type === "error" && m.message === SANDBOX_LIMIT_REPLY.message));

  // …and reviewer 2, connected concurrently, still has a full budget.
  const repliesBefore = replies.length;
  const two = openWs();
  send(two, "hello");
  await settle();
  assert.equal(prompts.length, 4, "a second connection is not affected by the first's cap");
  assert.equal(replies.length - repliesBefore >= 0, true);

  delete process.env.MP_DEMO_MSG_LIMIT;
});

test("unit: the sandbox rejects document uploads before touching the store", async () => {
  const { registerDocumentRoutes } = await import("../server/routes/documents.js");
  const routes = {};
  const noop = () => {};
  const app = { post: (p, ...h) => (routes[p] = h), get: noop, put: noop, patch: noop, delete: noop };
  let added = 0;
  const ctx = {
    app,
    db: { isDbReady: () => true },
    documents: { addDocument: async () => (added += 1) },
    collections: {},
    upload: { single: () => (_req, _res, next) => next() },
    DEMO_SANDBOX: true,
  };
  registerDocumentRoutes(ctx);
  assert.ok(routes["/api/documents"], "route registered");

  const handler = routes["/api/documents"].at(-1);
  const res = {
    statusCode: 0,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  await handler({ body: {}, file: { originalname: "a.pdf", buffer: Buffer.alloc(4) } }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /演示环境不支持上传/);
  assert.equal(added, 0, "no document may be written");
});

test("unit: wipeSandboxSessions — skip while streaming, fresh session kept, rest deleted", async () => {
  const { wipeSandboxSessions } = await import("../server/sandbox.js");

  // Streaming turn defers the wipe.
  const skipped = await wipeSandboxSessions({
    isStreaming: () => true,
    listSessions: async () => [{ id: "a" }],
    deleteSession: async () => {},
    startNewSession: async () => {
      throw new Error("must not run while streaming");
    },
    currentSessionId: () => "a",
  });
  assert.equal(skipped.skipped, "streaming");

  // Empty store is a no-op.
  assert.equal((await wipeSandboxSessions({
    isStreaming: () => false,
    listSessions: async () => [],
    deleteSession: async () => {},
    startNewSession: async () => {},
    currentSessionId: () => null,
  })).skipped, "empty");

  // Normal wipe: new session becomes active, prior ones deleted, a failing
  // delete is counted but does not abort the sweep.
  const deleted = [];
  let active = "old-1";
  const r = await wipeSandboxSessions({
    isStreaming: () => false,
    listSessions: async () => [{ id: "old-1" }, { id: "old-2" }, { id: "old-3" }],
    deleteSession: async (id) => {
      if (id === "old-2") throw new Error("locked");
      deleted.push(id);
    },
    startNewSession: async () => {
      active = "fresh";
    },
    currentSessionId: () => active,
  });
  assert.deepEqual(deleted, ["old-1", "old-3"], "every prior session is deleted; only the fresh active one stays");
  assert.equal(r.wiped, 2);
  assert.equal(r.failed, 1);
});
