// Regression guard — child exits MID-TURN must not kill the runner
// (add-local-fleet-control-plane task 5.5; spike 1.1 finding F3,
// openspec/changes/add-local-fleet-control-plane/spike/crash-excerpt.txt).
// Run: node --test scripts/test-local-fleet-turn-death.mjs
//
// The spike's real runner died with an unhandled rejection when a dsh child
// exited while a turn was in flight. On a desktop seat that means EVERY hosted
// agent disappears until the supervisor restarts — the local-cluster promise
// breaking. This test drives the PRODUCTION path (real A2A HTTP listener →
// manager.turn → harness pump) with a controllable fake child and asserts:
//   1. the caller gets the structured -32002 child-exit error,
//   2. no unhandled rejection escapes the process,
//   3. the manager keeps serving (dead child evicted, next turn cold-starts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const { ChildManager } = await import("../agent-runner/manager.js");
const { createAgentApp } = await import("../agent-runner/a2a.js");

const ENTRY = {
  path: "/packs/f3/demo",
  name: "F3 Demo",
  supported_protocol: "a2a",
  is_enabled: true,
  metadata: { packId: "f3", packVersion: 1, persona: "p", skills: [] },
};

function fakeClient() {
  const listeners = [];
  const queue = [];
  let died = false;
  return {
    __die() {
      died = true;
      for (const wake of listeners.splice(0)) wake();
    },
    start() {},
    async initialize() {
      return { ok: true };
    },
    async request() {
      return { accepted: true };
    },
    subscribe() {
      return {
        next: async () => {
          for (;;) {
            if (died) throw new Error("child gone");
            const notif = queue.shift();
            if (notif) return notif;
            await new Promise((r) => listeners.push(r));
          }
        },
      };
    },
    // A turn that never settles on its own: we kill the transport instead.
    async prompt() {
      return "msg-1";
    },
    async stop() {},
    child: { pid: null },
  };
}

test("a child dying while the prompt is IN FLIGHT does not leak an unhandled rejection", async () => {
  // The exact F3 window (spike 1.1, crash-excerpt.txt): harness/dsh.js's
  // turn() creates the `collected` promise, THEN awaits client.prompt(), and
  // only returns `collected` afterwards. If the child dies while the prompt
  // is in flight, the pump's `_child_exit` branch rejects `collected` BEFORE
  // any handler is attached to it — Node then treats it as an unhandled
  // rejection and (default --unhandled-rejections=throw) takes the whole
  // runner down. On a desktop seat that kills every hosted agent.
  //
  // The fix must keep the rejection visible to the caller (the turn still
  // fails) while making sure the promise is never UNHANDLED.
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "f3c-dsh-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f3c-home-"));
  const config = {
    homeRoot: home,
    registryUrl: "https://registry.example.test",
    registryToken: "t",
    backendToken: "bt",
    maxChildren: 2,
    drainMs: 100,
    // A short turn budget: the in-flight prompt never settles, so the turn's
    // own budget is what ends it — the assertion is the SHAPE (a bounded
    // failure instead of a hang), not the wall clock.
    turnTimeoutMs: 1200,
    dshProfile: "platform",
    cwd: home,
    provider: "p",
    model: "m",
    portBase: 9240,
    portSpan: 40,
    budgetMb: 1024,
    agentCostMb: 96,
    respawnAttempts: 0,
    respawnBackoffMs: [1],
  };

  const clients = [];
  const manager = new ChildManager({
    config,
    registryClient: {
      listServedAgents: async () => [ENTRY],
      fetchSkillContent: async () => "# s",
      mcpUrlFor: (name) => `https://registry.example.test/${name}/mcp`,
    },
    clientFactory: () => () => {
      const listeners = [];
      let died = false;
      let _failPrompt = null;
      const client = {
        __die() {
          died = true;
          // The transport fails BOTH lanes: the subscription (the pump wakes
          // and takes the _child_exit path) and the in-flight request. The
          // subscription wake is queued FIRST, so the pump's settle runs
          // before turn()'s own catch — which is the exact ordering of the
          // spike crash (the rejection lands while `collected` has no
          // handler yet).
          for (const wake of listeners.splice(0)) wake();
        },
        start() {},
        async initialize() {
          return { ok: true };
        },
        async request() {
          return { accepted: true };
        },
        subscribe() {
          return {
            next: async () => {
              for (;;) {
                if (died) throw new Error("child gone");
                await new Promise((r) => listeners.push(r));
              }
            },
          };
        },
        // The prompt is IN FLIGHT when the child dies and NEVER settles: the
        // bytes are already buffered, the process is gone, and nothing
        // completes the request. The subscription's EOF (the pump's
        // `_child_exit` branch) is the only signal — and it lands on
        // `collected` while turn() is still suspended on this await, which is
        // the unhandled-rejection window the spike crashed on.
        async prompt() {
          return new Promise(() => {});
        },
        async stop() {},
        child: { pid: null },
      };
      clients.push(client);
      return client;
    },
    log: { log() {}, warn() {}, error() {} },
  });

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = manager.turn(ENTRY, "s1", "hi").then(() => null, (e) => e);
    for (let i = 0; i < 100 && manager.children.size === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(manager.children.size, 1, "the child is live with a prompt in flight");
    await new Promise((r) => setTimeout(r, 150));

    clients[0].__die(); // death while the prompt is still in flight
    const err = await pending;
    assert.ok(err, "the caller gets a bounded failure");
    assert.equal(err.code, -32002, "and it is the structured child-exit error");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      unhandled.length,
      0,
      `the rejection must never be unhandled (this is what killed the spike runner): ${unhandled.map((e) => e?.message).join("; ")}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await manager.stopAll();
  }
});

test("a child whose prompt() rejects (transport already closed) does not leak an unhandled rejection", async () => {
  // The second death shape: the process is gone BEFORE the prompt reaches the
  // wire, so `prompt()` itself rejects. In dsh.js's turn() this path settles
  // the turn from inside the catch — the exact place where a rejection with no
  // attached handler would escape as unhandled and (Node default) kill the
  // runner, which is what the spike log shows.
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "f3b-dsh-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f3b-home-"));
  const config = {
    homeRoot: home,
    registryUrl: "https://registry.example.test",
    registryToken: "t",
    backendToken: "bt",
    maxChildren: 2,
    drainMs: 100,
    turnTimeoutMs: 60_000,
    dshProfile: "platform",
    cwd: home,
    provider: "p",
    model: "m",
    portBase: 9200,
    portSpan: 40,
    budgetMb: 1024,
    agentCostMb: 96,
    respawnAttempts: 0,
    respawnBackoffMs: [1],
  };

  const manager = new ChildManager({
    config,
    registryClient: {
      listServedAgents: async () => [ENTRY],
      fetchSkillContent: async () => "# s",
      mcpUrlFor: (name) => `https://registry.example.test/${name}/mcp`,
    },
    clientFactory: () => () => ({
      start() {},
      async initialize() {
        return { ok: true };
      },
      async request() {
        return { accepted: true };
      },
      subscribe() {
        return { next: async () => { throw new Error("transport closed"); } };
      },
      async prompt() {
        throw new Error("write after end");
      },
      async stop() {},
      child: { pid: null },
    }),
    log: { log() {}, warn() {}, error() {} },
  });

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const err = await manager.turn(ENTRY, "s1", "hi").then(() => null, (e) => e);
    assert.ok(err, "the caller always gets an error object, never a hang");
    // The raw transport error is intentionally NOT re-coded here: the A2A layer
    // normalizes an uncoded failure to -32003 for the caller (a2a.js catch).
    // This guard is about the leak, not the code shape.
    assert.ok(err instanceof Error, "the failure surfaces as an Error to the caller");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      unhandled.length,
      0,
      `prompt-rejection path must not leak: ${unhandled.map((e) => e?.message).join("; ")}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await manager.stopAll();
  }
});

test("a child exiting mid-turn settles the turn and never kills the runner", async () => {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "f3-dsh-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f3-home-"));
  const config = {
    homeRoot: home,
    registryUrl: "https://registry.example.test",
    registryToken: "t",
    backendToken: "bt",
    maxChildren: 2,
    drainMs: 100,
    turnTimeoutMs: 60_000,
    dshProfile: "platform",
    cwd: home,
    provider: "p",
    model: "m",
    portBase: 9160,
    portSpan: 40,
    budgetMb: 1024,
    agentCostMb: 96,
    respawnAttempts: 0,
    respawnBackoffMs: [1],
  };

  const clients = [];
  const manager = new ChildManager({
    config,
    registryClient: {
      listServedAgents: async () => [ENTRY],
      fetchSkillContent: async () => "# s",
      mcpUrlFor: (name) => `https://registry.example.test/${name}/mcp`,
    },
    clientFactory: () => () => {
      const client = fakeClient();
      clients.push(client);
      return client;
    },
    log: { log() {}, warn() {}, error() {} },
  });

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);

  const app = express();
  app.use(express.json());
  app.use(
    "/agent",
    createAgentApp({ entry: ENTRY, getEntry: () => ENTRY, manager, config, log: { log() {}, warn() {}, error() {} } }),
  );
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    const response = fetch(`http://127.0.0.1:${port}/agent/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bt" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } },
      }),
    }).then((r) => r.json());

    // Let the cold start finish and the pump subscribe before killing.
    for (let i = 0; i < 100 && manager.children.size === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(manager.children.size, 1, "the child is live with a turn in flight");
    await new Promise((r) => setTimeout(r, 150));

    clients[0].__die();

    const body = await response;
    assert.equal(body?.error?.code, -32002, "the caller gets the structured child-exit error");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      unhandled.length,
      0,
      `no unhandled rejection may escape the runner: ${unhandled.map((e) => e?.message).join("; ")}`,
    );
    assert.equal(manager.children.size, 0, "the dead child is evicted (no ghost runtime)");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await manager.stopAll();
    server.close();
  }
});
