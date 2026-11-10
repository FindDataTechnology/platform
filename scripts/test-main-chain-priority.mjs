// Main-chain fairness (fix-main-chain-human-priority).
//
// The primary slot is ONE serial chain. Production runs `TASK_WORKER_MAX=0`, so
// the worker pool is inert and every execution — cadence fires, fanout targets,
// the owner's `execute now` — queues on that chain. `humanPriority` was honoured
// only by the pool, so on prod the one turn a human asked for had no priority:
// live 2026-11-08 a run-now waited 180s behind 18 queued fires.
//
// These pin the ordering contract: a humanPriority execution jumps executions
// that have NOT started, keeps arrival order among equals, and never overlaps
// the running one. The pool is deliberately left at cap 0 — that is the
// deployment being fixed.
//
// Run: node --test scripts/test-main-chain-priority.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "main-chain-priority-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.TASK_WORKER_MAX = "0";
process.env.QUEUE_MAX_AGE_MS = "0"; // manual fires are never aged out; be explicit

const engine = await import("../task-engine.js");

// Every turn parks on `release` so the queue's order is observable before the
// next execution can be picked.
let order = [];
let release = null;
let running = 0;
let maxConcurrent = 0;

await engine.initTaskEngine({
  broadcast: () => {},
  isBusy: () => false,
  runTurn: async (t) => {
    order.push(t.id);
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((resolve) => {
      release = resolve;
    });
    running -= 1;
    return { ok: true };
  },
});

async function until(fn, label, ms = 2000) {
  const from = Date.now();
  while (!fn()) {
    if (Date.now() - from > ms) throw new Error(`timed out waiting for ${label} (order: ${order.join(",")})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const make = (prompt, extra = {}) =>
  engine.createManualTask({ prompt, persona: "minimal", initiator: "s1", ...extra });

test.beforeEach(async () => {
  // A previous test may have parked a turn (and failed before releasing it):
  // drain it first, or the shared engine module starts this test mid-chain.
  release?.();
  await engine.idle();
  order = [];
  release = null;
  running = 0;
  maxConcurrent = 0;
});

test.after(async () => {
  release?.();
  await engine.idle(); // let the last execution's save flush before the dir goes
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("a human wake jumps executions that have not started", async () => {
  const a = make("A");
  await until(() => order.length === 1, "A running");
  const b = make("B");
  const c = make("C");
  const h = make("H", { humanPriority: true });
  // The raw record is what the drain reads (the wire shape stays minimal).
  assert.equal(engine.getTaskRecord(h.id).humanPriority, true, "the stamp is on the record");

  // Nothing may have started behind the parked A.
  assert.deepEqual(order, [a.id]);

  release();
  await until(() => order.length === 2, "the next execution picked");
  assert.equal(order[1], h.id, "H (human) runs next, not B (arrived first)");

  release();
  await until(() => order.length === 3, "third execution picked");
  assert.equal(order[2], b.id, "the rest keep FIFO");
  release();
  await until(() => order.length === 4, "fourth execution picked");
  assert.equal(order[3], c.id);
  release();

  await engine.idle();
  assert.deepEqual(order, [a.id, h.id, b.id, c.id]);
  assert.equal(maxConcurrent, 1, "still strictly one execution at a time");
});

test("human wakes keep their own arrival order", async () => {
  make("A"); // side effect only: this case never reads A's id
  await until(() => order.length === 1, "A running");
  const h1 = make("H1", { humanPriority: true });
  const h2 = make("H2", { humanPriority: true });
  const b = make("B");

  release();
  await until(() => order.length === 2, "first pick");
  assert.equal(order[1], h1.id);
  release();
  await until(() => order.length === 3, "second pick");
  assert.equal(order[2], h2.id);
  release();
  await until(() => order.length === 4, "third pick");
  assert.equal(order[3], b.id, "a normal task never overtakes an older human wake");
  release();
  await engine.idle();
  assert.equal(maxConcurrent, 1);
});

test("without a human wake the chain is plain FIFO (no regression)", async () => {
  const a = make("A");
  await until(() => order.length === 1, "A running");
  const b = make("B");
  const c = make("C");
  release();
  await until(() => order.length === 2, "B picked");
  assert.equal(order[1], b.id);
  release();
  await until(() => order.length === 3, "C picked");
  assert.equal(order[2], c.id);
  release();
  await engine.idle();
  assert.deepEqual(order, [a.id, b.id, c.id]);
});

test("idle() waits for executions still waiting their turn", async () => {
  const a = make("A");
  await until(() => order.length === 1, "A running");
  const b = make("B");
  const c = make("C");

  let settled = false;
  const waited = engine.idle().then(() => {
    settled = true;
  });
  // The chain's current tail (A) is parked: idle must not claim emptiness.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, "idle must not resolve while B and C are pending");

  release();
  await until(() => order.length === 2, "B picked");
  release();
  await until(() => order.length === 3, "C picked");
  release();
  await waited;
  assert.equal(settled, true);
  assert.deepEqual(order, [a.id, b.id, c.id]);
  assert.equal(engine.getTask(c.id).state, "done");
});
