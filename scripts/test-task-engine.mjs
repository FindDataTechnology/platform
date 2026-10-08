// Unit tests for the task engine (add-task-engine).
// Covers the spec scenarios:
//   - legacy records backfill trigger/target/sessionId at load, state derived
//     from history (failed on last-false, done on last-true)
//   - load repair: persisted `running` becomes `interrupted` with a gist and
//     is never re-executed; persisted `queued` re-enqueues via drainRepairQueue
//     and runs exactly once
//   - enqueue guards: paused/expired/completed rejected; already queued or
//     running is a no-op carrying the current state (re-run never double-queues)
//   - failed/interrupted executions record the error gist and allow re-run
//   - insertTask rejects unsupported target types and persona-less targets
//   - finishExecution broadcasts cron_completed carrying the lifecycle state
//   - persistence stays atomic under concurrent saves (valid JSON after)
//
// Run: node --test scripts/test-task-engine.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-engine-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db"); // paths.js may touch db dirs

const engine = await import("../task-engine.js");
const JOBS_FILE = path.join(tmpRoot, "jobs.json");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Boot the singleton against a fresh fixture file; returns the collected
// broadcast events. Each initTaskEngine resets the in-memory map.
async function boot(records, runTurn = async () => ({ ok: true })) {
  // Drain the persistence write chain FIRST: mutations persist fire-and-forget
  // (void saveTasks()), so a save still in flight from the previous test can
  // land AFTER the seed write below and clobber it — initTaskEngine then
  // loads a file without the seeded record (CI-load flake 2026-10-07: the
  // enqueue guard refused job_1 far from the cause). Awaiting saveTasks()
  // queues behind every earlier write; the seed then wins.
  await engine.saveTasks();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(records));
  const events = [];
  await engine.initTaskEngine({
    broadcast: (e) => events.push(e),
    runTurn,
    isBusy: () => false,
  });
  return events;
}

function readStored() {
  return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
}

const legacyRecord = (over = {}) => ({
  id: "job_1",
  type: "recurring",
  cron: "0 9 * * *",
  when: null,
  prompt: "morning report",
  preset: "legal-case",
  sessionId: null, // legacy: no session id yet
  tz: null,
  status: "scheduled",
  paused: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastRun: null,
  nextRun: null,
  missed: 0,
  history: [],
  ...over,
});

beforeEach(() => {
  fs.rmSync(JOBS_FILE, { force: true });
});

test("legacy records backfill trigger/targetType/sessionId and persist", async () => {
  await boot([legacyRecord()]);
  const stored = readStored();
  assert.equal(stored[0].trigger, "schedule");
  assert.equal(stored[0].targetType, "persona");
  assert.equal(stored[0].sessionId, "cron-job_1");
  assert.equal(stored[0].state, null); // no history → no derived state
});

test("state derives from the last history outcome", async () => {
  await boot([legacyRecord({ history: [{ time: "t", duration: 5, success: false, error: "boom" }] })]);
  assert.equal(engine.getTask("job_1").state, "failed");
  assert.equal(engine.getTask("job_1").error, null); // gist lives in history for legacy rows

  await boot([legacyRecord({ history: [{ time: "t", duration: 5, success: true }] })]);
  assert.equal(engine.getTask("job_1").state, "done");
});

test("persisted running repairs to interrupted and never re-executes", async () => {
  let runs = 0;
  await boot([legacyRecord({ state: "running", history: [{ time: "t", success: true }] })], async () => {
    runs++;
    return { ok: true };
  });
  const task = engine.getTask("job_1");
  assert.equal(task.state, "interrupted");
  assert.ok(task.error.includes("restarted"));
  await engine.idle();
  assert.equal(runs, 0);
});

test("persisted queued re-enqueues through drainRepairQueue and runs exactly once", async () => {
  let runs = 0;
  await boot([legacyRecord({ state: "queued" })], async () => {
    runs++;
    return { ok: true };
  });
  engine.drainRepairQueue();
  await engine.idle();
  assert.equal(runs, 1);
  assert.equal(engine.getTask("job_1").state, "done");
});

test("enqueue guards: paused rejected, already-queued is a no-op", async () => {
  await boot([legacyRecord({ paused: true, status: "paused" })]);
  const blocked = engine.enqueueExecution("job_1");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /paused/);

  await boot([legacyRecord()]);
  const first = engine.enqueueExecution("job_1");
  assert.equal(first.ok, true);
  assert.equal(first.state, "queued");
  const dup = engine.enqueueExecution("job_1");
  assert.equal(dup.ok, true);
  assert.equal(dup.already, true);
  await engine.idle();
  const task = engine.getTask("job_1");
  assert.equal(task.state, "done");
  assert.equal(task.history.length, 1); // exactly one execution ran
});

test("failed execution records the gist and re-run works", async () => {
  let n = 0;
  await boot([legacyRecord()], async () => {
    n++;
    return n === 1 ? { ok: false, error: "LLM request failed" } : { ok: true };
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  let task = engine.getTask("job_1");
  assert.equal(task.state, "failed");
  assert.equal(task.error, "LLM request failed");

  const rerun = engine.runTaskNow("job_1");
  assert.equal(rerun.ok, true);
  assert.equal(rerun.state, "queued");
  await engine.idle();
  task = engine.getTask("job_1");
  assert.equal(task.state, "done");
  assert.equal(task.history.length, 2); // failed execution preserved
  assert.equal(task.history[0].state, "failed");
  assert.equal(task.history[1].state, "done");
});

test("interrupted outcome from a bridge abort", async () => {
  await boot([legacyRecord()], async () => ({ ok: false, error: "the agent runtime restarted mid-turn", interrupted: true }));
  engine.enqueueExecution("job_1");
  await engine.idle();
  const task = engine.getTask("job_1");
  assert.equal(task.state, "interrupted");
  // re-run is available on interrupted (guard only blocks paused/expired/completed)
  const rerun = engine.runTaskNow("job_1");
  assert.equal(rerun.ok, true);
});

test("insertTask validates target types, allows null persona ref (legacy semantics)", async () => {
  await boot([]);
  assert.throws(() => engine.insertTask({ id: "x", prompt: "p", targetType: "agent-service" }), /unsupported target type/);
  // Null ref = runs under the live preset (cron-module's original behavior).
  const legacy = engine.insertTask({ id: "y", prompt: "p", targetType: "persona", preset: null });
  assert.equal(legacy.targetType, "persona");
  const ok = engine.insertTask({ id: "x", prompt: "p", targetType: "persona", preset: "legal-case" });
  assert.equal(ok.targetType, "persona");
  assert.equal(engine.getTask("x").target.ref, "legal-case");
});

test("clientShape exposes trigger/target/state for the wire", async () => {
  await boot([legacyRecord()]);
  const shape = engine.getTask("job_1");
  assert.equal(shape.trigger, "schedule");
  assert.deepEqual(shape.target, { type: "persona", ref: "legal-case" });
  assert.ok("state" in shape && "error" in shape);
});

test("cron_completed broadcast carries the lifecycle state", async () => {
  const events = await boot([legacyRecord()], async () => ({ ok: true }));
  engine.enqueueExecution("job_1");
  await engine.idle();
  const completed = events.filter((e) => e.type === "cron_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].state, "done");
  assert.equal(completed[0].success, true);
  const fired = events.find((e) => e.type === "cron_fired");
  assert.equal(fired.state, "running");
});

test("concurrent saves leave the store valid JSON (atomic chain)", async () => {
  await boot([]);
  engine.insertTask({ id: "a", prompt: "p", targetType: "persona", preset: "x" });
  engine.insertTask({ id: "b", prompt: "p", targetType: "persona", preset: "x" });
  await Promise.all([engine.saveTasks(), engine.saveTasks(), engine.saveTasks()]);
  const stored = readStored();
  assert.ok(Array.isArray(stored));
  assert.equal(stored.length, 2);
});

test("manual trigger: create enqueues immediately, no schedule fields, re-run works", async () => {
  let runs = 0;
  await boot([], async () => {
    runs++;
    return { ok: true };
  });
  const task = engine.createManualTask({ prompt: "delegate me", persona: "legal-case", sessionTitle: "Probe" });
  assert.equal(task.trigger, "manual");
  assert.equal(task.status, "manual");
  assert.equal(task.state, "queued");
  assert.equal(task.target.ref, "legal-case");
  assert.ok(task.sessionId.startsWith("task-"));
  assert.ok(task.initiator === null);
  await engine.idle();
  assert.equal(runs, 1);
  const done = engine.getTask(task.id);
  assert.equal(done.state, "done");

  // Re-run still available on manual tasks (fresh execution, same identity).
  const rerun = engine.runTaskNow(task.id);
  assert.equal(rerun.ok, true);
  await engine.idle();
  assert.equal(runs, 2);
  assert.equal(engine.getTask(task.id).history.length, 2);
});

test("manual trigger: initiator and aggregated persist through reload", async () => {
  await boot([], async () => ({ ok: true }));
  engine.createManualTask({ prompt: "p", persona: "x", initiator: "sess-1" });
  await engine.idle();
  const id = [...engine.listTasks()][0].id;
  engine.getRecord(id).aggregated = true;
  await engine.saveTasks();
  // Reload from disk (a new boot reads the same file): fields survive.
  await boot(readStored(), async () => ({ ok: true }));
  const reloaded = engine.getTask(id);
  assert.equal(reloaded.initiator, "sess-1");
  assert.equal(reloaded.aggregated, true);
  assert.equal(reloaded.trigger, "manual");
});

test("usage from the runner lands in the history entry", async () => {
  await boot([], async () => ({ ok: true, usage: { input: 12, output: 34, total: 46 } }));
  engine.createManualTask({ prompt: "p", persona: "x" });
  await engine.idle();
  const entry = engine.getTask([...engine.listTasks()][0].id).history.at(-1);
  assert.deepEqual(entry.tokens, { input: 12, output: 34, total: 46 });
});

test("insertTask rejects unknown triggers; addOnFinished subscribers fire", async () => {
  await boot([]);
  assert.throws(() => engine.insertTask({ id: "z", prompt: "p", trigger: "webhook" }), /unsupported trigger/);

  let seen = null;
  engine.addOnFinished((t) => {
    seen = t.id;
  });
  await boot([legacyRecord()], async () => ({ ok: true }));
  engine.addOnFinished((t) => {
    seen = t.id;
  });
  // A no-op enqueue (state already terminal) would leave `seen` null and fail
  // far from the cause — assert the accept explicitly.
  const enq = engine.enqueueExecution("job_1");
  assert.equal(enq.ok, true);
  await engine.idle();
  // finishExecution's persistence is fire-and-forget; drain the write chain so
  // it cannot race this file's teardown.
  await engine.saveTasks();
  // Subscribers fire inside the finish chain, but that chain's ordering
  // against idle() is not a contract — poll bounded instead of assuming
  // (CI-load flake 2026-10-07: same family as the reload test f37ab11 fixed).
  const deadline = Date.now() + 5000;
  while (seen !== "job_1" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(seen, "job_1");
});

test("slot dispatcher: a claimed execution skips the primary chain until the pool runs it", async () => {
  let primaryRuns = 0;
  await boot([legacyRecord()], async () => {
    primaryRuns++;
    return { ok: true };
  });
  let _claimed = null;
  engine.setSlotDispatcher((task) => {
    if (task?.id === "job_1") {
      _claimed = task.id;
      return true;
    }
    return false;
  });
  const enq = engine.enqueueExecution("job_1");
  assert.equal(enq.ok, true);
  await engine.idle();
  // Claimed by the pool: the primary never ran it.
  assert.equal(primaryRuns, 0);
  assert.equal(engine.getTask("job_1").state, "queued");
  // The pool executes with its own turn fn via beginExecution.
  const ran = await engine.beginExecution("job_1", async () => ({ ok: true, usage: { total: 5 } }));
  assert.equal(ran, true);
  const t = engine.getTask("job_1");
  assert.equal(t.state, "done");
  assert.deepEqual(t.history.at(-1).tokens, { total: 5 });
  await engine.saveTasks();
});

test("slot dispatcher: unclaimed executions run on the primary as before", async () => {
  let primaryRuns = 0;
  await boot([legacyRecord()], async () => {
    primaryRuns++;
    return { ok: true };
  });
  engine.setSlotDispatcher(() => false);
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(primaryRuns, 1);
  assert.equal(engine.getTask("job_1").state, "done");
  await engine.saveTasks();
});

test("runOnPrimary chains a claimed execution back onto the serial queue", async () => {
  let primaryRuns = 0;
  await boot([legacyRecord()], async () => {
    primaryRuns++;
    return { ok: true };
  });
  engine.setSlotDispatcher((task, { runOnPrimary }) => {
    // A pool that claims then fails to spawn would hand it back.
    if (task?.id === "job_1") {
      runOnPrimary(task.id);
      return true;
    }
    return false;
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(primaryRuns, 1);
  assert.equal(engine.getTask("job_1").state, "done");
  await engine.saveTasks();
});
