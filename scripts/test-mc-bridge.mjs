// Unit tests for the MC bridge (add-mission-control-bridge) against a stub
// console: registration, claim mapping (persona validation, idempotency),
// outcome posting with retry, and backoff on console outage. The engine runs
// REAL against a temp store; the bridge's turn execution is stubbed via the
// engine's runTurn (dead-LLM-style failures).
//
// Run: node --test scripts/test-mc-bridge.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-bridge-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.MC_BRIDGE;
delete process.env.MC_URL;
delete process.env.MC_API_KEY;
process.env.MC_POLL_MS = "100"; // fast ticks for tests

const engine = await import("../task-engine.js");
const { attachMcBridge } = await import("../server/mc-bridge.js");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stub console: the three pinned endpoints plus call recording.
async function startStubConsole() {
  const state = { registrations: [], results: [], queue: [], failResults: 0 };
  // Real semantics (verified live): register answers {agent:{id}}; queue GET
  // CLAIMS one task at a time and answers {task:{...}}; outcomes go to
  // PUT /tasks/{id} (done is Aegis-gated → bridge uses quality_review).
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/api/agents/register") {
      collect(req, (body) => {
        state.registrations.push(body);
        res.end(JSON.stringify({ registered: true, agent: { id: 1, name: body?.name } }));
      });
      return;
    }
    if (req.method === "POST" && /^\/api\/agents\/\d+\/heartbeat$/.test(req.url)) {
      collect(req, () => res.end(JSON.stringify({ ok: true })));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/tasks/queue")) {
      const claimed = state.queue.shift() ?? null;
      res.end(JSON.stringify(claimed ? { task: claimed } : { tasks: [] }));
      return;
    }
    const m = req.url.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "PUT" && m) {
      if (state.failResults > 0) {
        state.failResults--;
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "flaky" }));
        return;
      }
      collect(req, (body) => {
        body.taskId = m[1];
        state.results.push(body);
        res.end(JSON.stringify({ task: { id: m[1], ...(body ?? {}) } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}

function collect(req, fn) {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch { /* empty body */ }
    fn(body);
  });
}

async function bootEngine(runTurn) {
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => (runTurn ? runTurn() : { ok: true }),
    isBusy: () => false,
  });
}

function makeCtx(personas) {
  return {
    broadcast: () => {},
    sessionCollectors: new Map(),
    getAgentPresets: async () => personas.map((id) => ({ id, name: id })),
  };
}

test("bridge is inert without env", () => {
  const h = attachMcBridge(makeCtx([]));
  assert.equal(h.enabled, false);
});

test("register → claim → execute → result round trip; unknown persona rejected; idempotent claim", async () => {
  await bootEngine(async () => ({ ok: false, error: "Connection error." })); // dead-LLM style
  const console_ = await startStubConsole();
  process.env.MC_BRIDGE = "1";
  process.env.MC_URL = console_.url;
  process.env.MC_API_KEY = "stub-key";
  process.env.MC_AGENT_NAME = "test-cell";

  const ctx = makeCtx(["code", "minimal"]);
  const handle = attachMcBridge(ctx);
  assert.equal(handle.enabled, true);

  try {
    // Registration happens on the first tick.
    await sleep(200);
    assert.ok(console_.state.registrations.length >= 1);
    assert.equal(console_.state.registrations[0].name, "test-cell");

    // Queue a valid task and an unknown-persona task.
    console_.state.queue.push(
      { id: "mc-1", title: "code", description: "console probe: one word" },
      { id: "mc-2", title: "ghost-persona", description: "should be rejected" },
    );
    await sleep(300);

    // mc-1 became a cell task (manual trigger, origin.mc, failed on dead LLM);
    // mc-2 was rejected with a structured console failure and no cell task.
    const t1 = engine.allRecords().find((t) => t.origin?.mc === "mc-1");
    assert.ok(t1, "mc-1 created a cell task");
    assert.equal(t1.trigger, "manual");
    assert.equal(t1.preset, "code");
    assert.equal(engine.allRecords().find((t) => t.origin?.mc === "mc-2"), undefined);

    // The dead-LLM failure posted back to the console for BOTH tasks.
    await sleep(700);
    const r1 = console_.state.results.find((r) => r.taskId === "mc-1");
    assert.ok(r1, "mc-1 result posted");
    assert.equal(r1.status, "quality_review");
    assert.match(r1.error, /Connection error/);
    assert.equal(r1.metadata?.paasBridge?.state, "failed");
    const r2 = console_.state.results.find((r) => r.taskId === "mc-2");
    assert.ok(r2 && /unknown persona/.test(r2.error), "mc-2 rejected with structured error");
    assert.equal(r2.metadata?.paasBridge?.state, "failed");

    // Idempotent claim: the same mc id in the queue never creates a second task.
    await sleep(400);
    assert.equal(engine.allRecords().filter((t) => t.origin?.mc === "mc-1").length, 1);
    // Result is not re-posted (mcReportedAt guard).
    assert.equal(console_.state.results.filter((r) => r.taskId === "mc-1").length, 1);
  } finally {
    handle.stop();
    console_.server.close();
    delete process.env.MC_BRIDGE;
    delete process.env.MC_URL;
    delete process.env.MC_API_KEY;
  }
});

test("failed result posts retry on a later tick", async () => {
  await bootEngine(async () => ({ ok: true }));
  const console_ = await startStubConsole();
  console_.state.failResults = 2; // first two posts 500
  process.env.MC_BRIDGE = "1";
  process.env.MC_URL = console_.url;
  process.env.MC_API_KEY = "stub-key";

  const ctx = makeCtx(["cordis"]);
  const handle = attachMcBridge(ctx);
  try {
    await sleep(200);
    console_.state.queue.push({ id: "mc-3", title: "cordis", description: "retry probe" });
    await sleep(400); // let a tick claim it
    const t = engine.allRecords().find((x) => x.origin?.mc === "mc-3");
    assert.ok(t);
    // At-least-once: two failed posts are retried on later ticks until one
    // lands; the marker flips only on a successful post.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !t.mcReportedAt) {
      await sleep(150);
    }
    assert.ok(t.mcReportedAt, "result eventually delivered despite two 500s");
    assert.ok(console_.state.results.some((r) => r.taskId === "mc-3" && r.metadata?.paasBridge?.state === "done"));
  } finally {
    handle.stop();
    console_.server.close();
    delete process.env.MC_BRIDGE;
    delete process.env.MC_URL;
    delete process.env.MC_API_KEY;
  }
});
