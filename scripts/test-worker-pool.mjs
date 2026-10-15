// Unit tests for the worker pool (add-worker-pool) with fake bridges:
// persona-affinity spawn, parallel execution, FIFO queueing at cap, idle
// reap with cold restart, spawn-failure fallback to the primary chain, and
// pool-state broadcasts. The engine runs REAL (task-engine.js) against a
// temp store; only the bridge is fake.
//
// Run: node --test scripts/test-worker-pool.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pool-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.TASK_WORKER_MAX = "2";

const engine = await import("../task-engine.js");
const { attachWorkerPool } = await import("../server/worker-slots.js");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A fake bridge whose turns complete only when the test releases them.
class FakeBridge {
  static byPersona = new Map();
  constructor(params) {
    this.params = params;
    this.persona = params.agentPreset;
    this.closed = false;
    this.prompts = [];
    FakeBridge.byPersona.set(this.persona, this);
  }
  async start() {
    this.ready = true;
  }
  isReady() {
    return this.ready && !this.closed;
  }
  async prompt(sessionId, blocks) {
    this.prompts.push({ sessionId, blocks });
    this.emit({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "stub reply" }] } } } } });
    await new Promise((resolve) => {
      this.release = resolve;
    });
    this.emit({ method: "session.status", params: { status: "idle" } });
  }
  emit(notif) {
    this.params.onEvent(notif);
  }
  close() {
    this.closed = true;
  }
}

function makeCtx(events) {
  return {
    broadcast: (e) => events.push(e),
    sessionCollectors: new Map(),
    workerSpawnParams: { provider: "finddata", model: "stub" },
  };
}

async function bootEngine(runTurn) {
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async (t, o) => (runTurn ? runTurn(t, o) : { ok: true }),
    isBusy: () => false,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// Deterministic teardown: any bridge still mid-turn gets released so no
// collector timer outlives the test file.
const releaseAll = () => {
  for (const bridge of FakeBridge.byPersona.values()) {
    bridge.release?.();
  }
};

test("two personas execute in parallel; primary never runs them", async () => {
  await bootEngine();
  const events = [];
  const ctx = makeCtx(events);
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  const b = engine.createManualTask({ prompt: "B", persona: "minimal", initiator: "s1" });

  // Both running simultaneously (parallel claim — the serial chain would not).
  await settle();
  await settle();
  assert.equal(engine.getTask(a.id).state, "running");
  assert.equal(engine.getTask(b.id).state, "running");
  assert.equal(FakeBridge.byPersona.get("code").prompts.length, 1);
  assert.equal(FakeBridge.byPersona.get("minimal").prompts.length, 1);

  FakeBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  assert.equal(engine.getTask(b.id).state, "running"); // still going
  FakeBridge.byPersona.get("minimal").release();
  await settle();
  assert.equal(engine.getTask(b.id).state, "done");
  assert.ok(events.some((e) => e.type === "worker_pool"));
  releaseAll();
  engine.setSlotDispatcher(null);
});

test("cap 1 queues the second persona task until the slot frees", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "1";
  const ctx = makeCtx([]);
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  const b = engine.createManualTask({ prompt: "B", persona: "code", initiator: "s1" });
  await settle();
  assert.equal(engine.getTask(a.id).state, "running");
  // Same persona, single slot: the second waits (worker reuse, no second spawn).
  assert.equal(engine.getTask(b.id).state, "queued");

  FakeBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  await settle();
  assert.equal(engine.getTask(b.id).state, "running");
  FakeBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(b.id).state, "done");
  releaseAll();
  engine.setSlotDispatcher(null);
  process.env.TASK_WORKER_MAX = "2";
});

test("idle reap shuts a worker; a later task cold-starts", async () => {
  await bootEngine();
  const ctx = makeCtx([]);
  const pool = attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p), idleReapMs: 60 });

  const a = engine.createManualTask({ prompt: "A", persona: "cordis", initiator: "s1" });
  await settle();
  FakeBridge.byPersona.get("cordis").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  const first = FakeBridge.byPersona.get("cordis");

  await new Promise((r) => setTimeout(r, 250)); // > reap scan + idle window
  assert.equal(first.closed, true);

  const b = engine.createManualTask({ prompt: "B", persona: "cordis", initiator: "s1" });
  await settle();
  const second = FakeBridge.byPersona.get("cordis");
  assert.notEqual(second, first);
  assert.equal(engine.getTask(b.id).state, "running");
  second.release();
  await settle();
  assert.equal(engine.getTask(b.id).state, "done");
  pool.shutdown();
  engine.setSlotDispatcher(null);
});

test("spawn failure falls back to the primary chain", async () => {
  let primaryRuns = 0;
  await bootEngine(async () => {
    primaryRuns++;
    return { ok: true };
  });
  const ctx = makeCtx([]);
  attachWorkerPool(ctx, {
    spawnBridge: () => ({
      async start() {
        throw new Error("no budget");
      },
      close() {},
    }),
  });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  await settle();
  await settle();
  assert.equal(primaryRuns, 1);
  assert.equal(engine.getTask(a.id).state, "done");
  engine.setSlotDispatcher(null);
});
