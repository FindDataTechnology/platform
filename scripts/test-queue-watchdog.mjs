#!/usr/bin/env node
// ── Queue watchdog tests (fix-cell-turn-throughput 2.1 - 2.3) ────────────────
//
// The serial chain (`executionQueue.then(...)`) means one turn that never
// settles stops every queued execution behind it. Live 2026-11-08: a turn sat
// in `running` 3.5 minutes with 24 tasks queued and nothing moved, because
// `finishExecution` can only be called by the turn itself.
//
// The watchdog lives OUTSIDE the turn so a turn wedged in an `await` cannot
// defeat it. These tests pin: expiry settles the task and advances the queue;
// an in-budget turn is untouched; the env escape hatch disables it.
//
//   node --test scripts/test-queue-watchdog.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Isolate task storage: TASK_STORAGE_DIR is frozen at module load from
// CRON_STORAGE_PATH, so the env must be set AFTER the static imports above
// but BEFORE the dynamic engine import below — otherwise the suite reads
// (and rewrites!) the developer machine's real cron store.
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
const engine = await import(path.join(here, "../task-engine.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(runTurn) {
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn,
    isBusy: () => false,
    resolveTurnBudget: () => 50, // tiny budget so grace math stays in ms scale
  });
}

function addTask(id) {
  engine.insertTask({ id, name: id, prompt: "p", trigger: "manual", targetType: "persona" });
  return id;
}

async function waitFor(predicate, { timeoutMs = 4000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

test("a turn that never settles is settled by the watchdog and the queue advances", async () => {
  const started = [];
  await boot((task) => {
    started.push(task.id);
    if (task.id === "wedge") return new Promise(() => {}); // never settles
    return Promise.resolve({ ok: true, text: "done" });
  });

  process.env.QUEUE_WATCHDOG_MS = "120";
  try {
    addTask("wedge");
    addTask("behind");
    engine.enqueueExecution("wedge");
    engine.enqueueExecution("behind");

    const advanced = await waitFor(() => started.includes("behind"));
    assert.equal(advanced, true, "the task behind the wedged turn must start");

    const wedge = engine.getRecord("wedge");
    assert.notEqual(wedge.state, "running", "the wedged turn must leave running");
    assert.match(wedge.error ?? "", /queue watchdog/, "the cause must name the watchdog");
  } finally {
    delete process.env.QUEUE_WATCHDOG_MS;
  }
});

test("a turn that settles inside its budget is not touched", async () => {
  await boot(() => Promise.resolve({ ok: true, text: "ok" }));
  process.env.QUEUE_WATCHDOG_MS = "5000";
  try {
    addTask("quick");
    engine.enqueueExecution("quick");
    const done = await waitFor(() => engine.getRecord("quick").state === "done");
    assert.equal(done, true);
    assert.equal(engine.getRecord("quick").error, null, "no watchdog error on a clean turn");
  } finally {
    delete process.env.QUEUE_WATCHDOG_MS;
  }
});

test("QUEUE_WATCHDOG_MS=0 disables the watchdog", async () => {
  await boot(() => new Promise(() => {}));
  process.env.QUEUE_WATCHDOG_MS = "0";
  try {
    addTask("forever");
    engine.enqueueExecution("forever");
    await sleep(300);
    assert.equal(engine.getRecord("forever").state, "running", "disabled means no forced settle");
  } finally {
    delete process.env.QUEUE_WATCHDOG_MS;
  }
});
