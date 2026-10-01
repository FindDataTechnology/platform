// ── Task engine ───────────────────────────────────────────────────────────────
//
// The unified in-cell task engine (add-task-engine; ADR 0006): one task
// concept for all unattended agent work. A task carries a target (the persona
// that executes it), a prompt, a dedicated session, and a trigger; scheduling
// is one trigger kind and lives in cron.js — this module owns task records,
// the execution lifecycle (queued → running → done | failed | interrupted),
// the serialized execution queue, restart repair, and the task event surface.
//
// Execution runs on execution slots (ADR 0005); the primary slot is the only
// one today and is the cron-runner turn flow, injected as `runTurn`. Worker
// slots (change ③) will add executors without touching the task model here.

import fs from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";
import { atomicWriteJson, readJsonOr, createWriteChain } from "./lib/persistence.js";

const TASK_STORAGE_DIR = storeDir("cron-store", process.env.CRON_STORAGE_PATH);
const JOBS_FILE = path.join(TASK_STORAGE_DIR, "jobs.json");

// Same file, same ids as the pre-engine cron store — records gain fields,
// nothing moves (design D1: one store, extended in place).
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 100;
const SUPPORTED_TARGET_TYPES = ["persona"];
const SUPPORTED_TRIGGERS = ["schedule", "manual"];

let tasks = new Map(); // id -> task record (loaded from disk + live schedule
// handle on .job owned by cron.js)
let broadcastFn = null;
let runTurnFn = null;
let isBusyFn = null;
// The scheduling front-end refreshes nextRun; the delegation aggregator arms
// summary injections. Multiple subscribers, order-independent, each guarded.
const onFinishedHooks = new Set();
let executionQueue = Promise.resolve();
const repairQueue = []; // ids persisted as queued at load → re-enqueue after init

// ── Persistence ─────────────────────────────────────────────────────────────

// Serialized + atomic persistence: mutations rewrite the whole tasks file, so
// overlapping saves are queued (no lost update) and each write goes through a
// unique temp file (no interleaved-write corruption).
const writeChain = createWriteChain();
function saveTasks() {
  return writeChain.mutate(async () => {
    // Serialize only the task data (excluding the live node-schedule handle).
    // Computed inside the queued task so a later save always sees the latest
    // in-memory state.
    const serializable = [...tasks.values()].map((t) => ({
      id: t.id,
      trigger: t.trigger ?? "schedule",
      type: t.type,
      cron: t.cron,
      when: t.when,
      prompt: t.prompt,
      preset: t.preset ?? null,
      targetType: t.targetType ?? "persona",
      sessionId: t.sessionId ?? null,
      sessionTitle: t.sessionTitle ?? null,
      tz: t.tz ?? null,
      status: t.status,
      state: t.state ?? null,
      error: t.error ?? null,
      initiator: t.initiator ?? null,
      initiatorPreset: t.initiatorPreset ?? null,
      origin: t.origin ?? null,
      aggregated: t.aggregated ?? false,
      paused: t.paused,
      createdAt: t.createdAt,
      lastRun: t.lastRun,
      nextRun: t.nextRun,
      missed: t.missed ?? 0,
      history: t.history,
    }));
    await atomicWriteJson(JOBS_FILE, serializable);
  });
}

// Derive the execution state a legacy record (pre-engine, no `state` field)
// implies from its history, so the UI can offer re-run on old failures.
function deriveLegacyState(record) {
  const last = Array.isArray(record.history) ? record.history[record.history.length - 1] : null;
  if (!last) return null;
  if (last.success === true) return "done";
  if (last.success === false) return "failed";
  return null;
}

// Load-time backfill + repair. Backfill: legacy records gain trigger/target
// fields and a stable session id. Repair: `running` becomes `interrupted`
// (never re-executed), `queued` is collected for re-enqueue after the
// scheduling front-end initializes.
function loadTasks() {
  repairQueue.length = 0;
  const saved = readJsonOr(JOBS_FILE, [], { label: "task-engine" });
  if (!Array.isArray(saved)) return false;
  let dirty = false;
  for (const data of saved) {
    const t = { missed: 0, state: null, error: null, ...data };
    if (!t.trigger) {
      t.trigger = "schedule";
      dirty = true;
    }
    if (!t.targetType) {
      t.targetType = "persona";
      dirty = true;
    }
    if (!t.sessionId) {
      // Backfill: mint the dedicated session id legacy records never had, so
      // the binding is stable across restarts from the first reload on.
      t.sessionId = `cron-${t.id}`;
      dirty = true;
    }
    if (!t.state) {
      // Legacy record: status was never persisted mid-run (no save between
      // "running" and completion), so a stray one is treated as interrupted;
      // otherwise the last history outcome decides.
      if (t.status === "running") {
        t.state = "interrupted";
        t.error = "cell restarted during execution";
      } else {
        t.state = deriveLegacyState(t);
      }
      dirty = true;
    } else if (t.state === "running") {
      t.state = "interrupted";
      t.error = "cell restarted during execution";
      dirty = true;
    }
    if (t.state === "queued") {
      repairQueue.push(t.id);
    }
    tasks.set(t.id, { ...t, job: null });
  }
  console.log(`[task-engine] Loaded ${tasks.size} task(s) from storage`);
  return dirty;
}

// ── Initialization ──────────────────────────────────────────────────────────

async function initTaskEngine({ broadcast, runTurn, isBusy, onFinished }) {
  broadcastFn = broadcast;
  runTurnFn = runTurn;
  isBusyFn = isBusy;
  onFinishedHooks.clear();
  if (onFinished) onFinishedHooks.add(onFinished);
  tasks = new Map();

  await fs.promises.mkdir(TASK_STORAGE_DIR, { recursive: true });
  // Load-time mutations (backfill, repair) must reach disk before boot
  // completes, or the next restart re-repairs the same records.
  if (loadTasks()) await saveTasks();
}

// After the scheduling front-end has initialized (timers armed, expiry
// marked), re-enqueue executions that were persisted as queued at load.
// These bypass enqueueExecution's already-queued guard — their `queued` state
// IS the persisted flag, no live execution is chained — and go straight onto
// the queue; runQueuedExecution re-checks every guard before running.
function drainRepairQueue() {
  for (const id of repairQueue.splice(0)) {
    const t = tasks.get(id);
    if (!t || scheduleSideBlocked(t)) {
      if (t) {
        t.state = null;
        void saveTasks();
      }
      continue;
    }
    chainExecution(id);
  }
}

// ── Task records ────────────────────────────────────────────────────────────

function getRecord(id) {
  return tasks.get(id) ?? null;
}

function allRecords() {
  return [...tasks.values()];
}

function insertTask(record) {
  if (!record?.id) throw new Error("task id is required");
  if (!record.prompt || typeof record.prompt !== "string") throw new Error("prompt is required");
  const trigger = record.trigger ?? "schedule";
  if (!SUPPORTED_TRIGGERS.includes(trigger)) {
    throw new Error(`unsupported trigger: ${trigger}`);
  }
  const type = record.targetType ?? "persona";
  if (!SUPPORTED_TARGET_TYPES.includes(type)) {
    throw new Error(`unsupported target type: ${type}`);
  }
  // A persona task MAY carry a null ref — legacy semantics: it runs under
  // whatever preset is live when it fires (cron-module's original behavior).
  tasks.set(record.id, { trigger, targetType: type, state: null, error: null, missed: 0, history: [], ...record, job: null });
  return tasks.get(record.id);
}

// Manual trigger (delegation front-end, or the MC bridge): create and
// immediately enqueue — no schedule is attached, so no schedule-side
// lifecycle ever applies. `origin` tags the creating front-end (e.g.
// { mc: <consoleTaskId> }) and persists with the record.
function createManualTask({ prompt, persona, sessionTitle, initiator, initiatorPreset, origin }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  insertTask({
    id,
    trigger: "manual",
    type: "manual",
    cron: null,
    when: null,
    prompt,
    preset: persona ?? null,
    targetType: "persona",
    sessionId: `task-${id}`,
    sessionTitle: sessionTitle || null,
    tz: null,
    status: "manual",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    // The conversation session that delegated this task — the aggregator's
    // fan-out bookkeeping key (persisted; restart-safe). initiatorPreset is
    // the persona the conversation ran under (the aggregator restores it).
    initiator: initiator ?? null,
    initiatorPreset: initiatorPreset ?? null,
    // Creating front-end tag (the MC bridge's idempotency key); persisted,
    // never exposed on the wire.
    origin: origin ?? null,
  });
  const enq = enqueueExecution(id);
  if (!enq.ok) throw new Error(enq.error);
  return getTask(id);
}

function deleteRecord(id) {
  return tasks.delete(id);
}

function clientShape(t) {
  return {
    id: t.id,
    trigger: t.trigger ?? "schedule",
    type: t.type,
    cron: t.cron,
    when: t.when,
    prompt: t.prompt,
    target: { type: t.targetType ?? "persona", ref: t.preset ?? null },
    preset: t.preset ?? null,
    sessionId: t.sessionId ?? null,
    sessionTitle: t.sessionTitle ?? null,
    tz: t.tz ?? null,
    status: t.status,
    state: t.state ?? null,
    error: t.error ?? null,
    // Delegation bookkeeping (manual trigger): the session that delegated this
    // task and whether its outcome has already been summarized into one.
    initiator: t.initiator ?? null,
    aggregated: t.aggregated ?? false,
    paused: t.paused,
    createdAt: t.createdAt,
    lastRun: t.lastRun,
    nextRun: t.nextRun,
    missed: t.missed ?? 0,
    history: t.history.slice(-20), // Last 20 executions
  };
}

function listTasks() {
  return allRecords().map(clientShape);
}

function getTask(id) {
  const t = tasks.get(id);
  return t ? clientShape(t) : null;
}

// ── Execution lifecycle ─────────────────────────────────────────────────────

function scheduleSideBlocked(t) {
  return Boolean(t.paused || t.status === "expired" || t.status === "completed");
}

// Enqueue one execution of a task (schedule fire, run-now, re-run, or repair).
// Guards: schedule-side states that must not run are rejected; an execution
// already queued or running is a no-op returning the current state (re-run
// must not double-queue).
function enqueueExecution(id) {
  const t = tasks.get(id);
  if (!t) return { ok: false, error: "task not found" };
  if (scheduleSideBlocked(t)) {
    return { ok: false, error: `task is ${t.paused ? "paused" : t.status}` };
  }
  if (t.state === "queued" || t.state === "running") {
    return { ok: true, already: true, state: t.state };
  }
  t.state = "queued";
  void saveTasks();
  broadcastStatus(id);
  dispatch(id);
  return { ok: true, state: "queued" };
}

// Slot dispatch (ADR 0005): the worker pool, when active, claims executions
// it can run on a persona-bound worker; everything else runs on the primary
// slot's serial chain. The dispatcher returns true when it CLAIMED the
// execution (including queueing it for a future slot).
let slotDispatcherFn = null;
function setSlotDispatcher(fn) {
  slotDispatcherFn = typeof fn === "function" ? fn : null;
}
function dispatch(id) {
  if (slotDispatcherFn) {
    let claimed = false;
    try {
      claimed = slotDispatcherFn(tasks.get(id), { runOnPrimary: () => chainExecution(id) }) === true;
    } catch {
      claimed = false;
    }
    if (claimed) return;
  }
  chainExecution(id);
}

// Chain one execution onto the serialized queue (no guards — callers either
// passed them or want the run-time re-check to decide).
function chainExecution(id) {
  executionQueue = executionQueue.then(() => runQueuedExecution(id));
}

// Hand an execution back to the primary slot's serial chain (the worker
// pool's spawn-failure fallback).
function runOnPrimary(id) {
  chainExecution(id);
}

// Chain an arbitrary turn-shaped job onto the same serialized queue (the
// delegation aggregator's summary injection rides this so it never overlaps a
// task execution or a runtime mutation).
function chainTurn(fn) {
  executionQueue = executionQueue.then(fn);
}

async function runQueuedExecution(id) {
  const t = tasks.get(id);
  // The schedule front-end may have paused/removed/completed the task between
  // enqueue and turn — reset the lifecycle and skip (pre-engine behavior: a
  // paused job's due firing silently did not run).
  if (!t || scheduleSideBlocked(t)) {
    if (t) {
      t.state = null;
      void saveTasks();
    }
    return;
  }
  await runExecutionTurn(t, runTurnFn);
}

// The shared execution body — primary slot and worker slots run the SAME
// lifecycle transitions; only the turn executor differs (the primary's
// switchPreset flow vs a worker's pinned-persona prompt).
async function runExecutionTurn(t, turnFn) {
  const startTime = new Date().toISOString();
  t.lastRun = startTime;
  t.state = "running";
  // Persist BEFORE the turn: a crash mid-execution reloads as `interrupted`
  // instead of silently reverting to idle (the pre-engine gap).
  void saveTasks();
  if (broadcastFn) broadcastFn({ type: "cron_fired", id: t.id, prompt: t.prompt, startTime, state: "running" });
  broadcastStatus(t.id);

  try {
    const result = await turnFn(t, { turnTimeoutMs: TURN_TIMEOUT_MS });
    finishExecution(t, startTime, result);
  } catch (err) {
    finishExecution(t, startTime, { ok: false, error: err?.message || String(err), interrupted: err?.interrupted === true });
  }
}

// Worker entry point: a pool-owned execution claims the same guards and the
// same lifecycle, running its turn on the pool's executor.
async function beginExecution(id, turnFn) {
  const t = tasks.get(id);
  if (!t || scheduleSideBlocked(t)) {
    if (t) {
      t.state = null;
      void saveTasks();
    }
    return false;
  }
  await runExecutionTurn(t, turnFn);
  return true;
}

function finishExecution(t, startTime, result) {
  const interrupted = result?.interrupted === true;
  const ok = result?.ok !== false && !interrupted;
  t.state = interrupted ? "interrupted" : ok ? "done" : "failed";
  t.error = ok ? null : result?.error || (interrupted ? "execution was interrupted" : "execution failed");

  t.history.push({
    time: startTime,
    duration: Date.now() - new Date(startTime).getTime(),
    state: t.state,
    success: ok,
    ...(t.error ? { error: t.error } : {}),
    // Token spend when the runtime reports usage on the finish chunk
    // (absent on some providers — the card omits the line, never blocks).
    ...(result?.usage ? { tokens: result.usage } : {}),
  });
  if (t.history.length > HISTORY_LIMIT) {
    t.history = t.history.slice(-HISTORY_LIMIT);
  }

  // Subscribers (scheduling front-end refreshes nextRun; the delegation
  // aggregator arms summary injections) — each guarded, none may lose the
  // outcome.
  for (const hook of onFinishedHooks) {
    try {
      hook(t);
    } catch { /* a subscriber failure must not lose the outcome */ }
  }

  void saveTasks();
  if (broadcastFn) {
    broadcastFn({
      type: "cron_completed",
      id: t.id,
      success: ok,
      state: t.state,
      ...(t.error ? { error: t.error } : {}),
      completedAt: new Date().toISOString(),
    });
  }
  broadcastStatus(t.id);
}

// Run or re-run a task immediately (bypasses the schedule). Enqueues only —
// the WS ack (cron_run_started) must not wait out the whole turn; completion
// arrives as the cron_completed broadcast.
function runTaskNow(id) {
  const r = enqueueExecution(id);
  return r;
}

// Await the serialized queue (tests, graceful drain).
function idle() {
  return executionQueue.then(() => {});
}

// Register an on-finished subscriber (the delegation aggregator mounts after
// engine init, which clears subscribers).
function addOnFinished(fn) {
  onFinishedHooks.add(fn);
}

// ── Broadcasting ────────────────────────────────────────────────────────────

function broadcastStatus(id) {
  const task = getTask(id);
  if (task && broadcastFn) {
    broadcastFn({ type: "cron_status", job: task });
  }
}

// Passthrough for the scheduling front-end's own events (e.g. cron_removed).
function broadcastEvent(event) {
  broadcastFn?.(event);
}

function getRecentActivity() {
  const activities = [];
  for (const t of tasks.values()) {
    for (const h of t.history.slice(-5)) {
      activities.push({
        type: "cron_execution",
        jobId: t.id,
        prompt: t.prompt,
        time: h.time,
        success: h.success,
      });
    }
  }
  return activities.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
}

function getDashboardState() {
  return {
    jobs: listTasks(),
    activeTasks: [],
    recentActivity: getRecentActivity(),
    agentStatus: {
      isBusy: isBusyFn ? isBusyFn() : false,
    },
  };
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

// Timer cancellation is the scheduling front-end's (cron.js owns the
// node-schedule handles); the engine's queue is allowed to settle naturally.
function shutdown() {}

export {
  initTaskEngine,
  drainRepairQueue,
  loadTasks,
  saveTasks,
  getRecord,
  allRecords,
  insertTask,
  createManualTask,
  deleteRecord,
  clientShape,
  listTasks,
  getTask,
  enqueueExecution,
  runTaskNow,
  idle,
  chainTurn,
  addOnFinished,
  setSlotDispatcher,
  beginExecution,
  runOnPrimary,
  broadcastStatus,
  broadcastEvent,
  getDashboardState,
  shutdown,
  SUPPORTED_TARGET_TYPES,
};
