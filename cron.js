// ── Scheduling front-end ─────────────────────────────────────────────────────
//
// The schedule trigger kind of the task engine (add-task-engine; ADR 0006):
// this module owns WHEN tasks fire — cron/one-shot schedules in an optional
// IANA timezone, missed-occurrence accounting, pause/resume, and expiry. Task
// records, the execution lifecycle, the serialized queue, and the task event
// surface live in task-engine.js; a firing hands the task to the engine's
// enqueueExecution. The public API shape (server.js, server/ws.js,
// server/routes/cron.js) is unchanged from the pre-engine cron module.

import schedule from "node-schedule";
import cronParser from "cron-parser";
import * as engine from "./task-engine.js";

// Missed-occurrence accounting caps iteration at this many gaps per load so a
// task left dead for years cannot spin the parser.
const MAX_MISSED_PER_LOAD = 100;

// ── Initialization ────────────────────────────────────────────────────────────

async function initCron({ broadcast, runJobTurn, isBusy }) {
  await engine.initTaskEngine({
    broadcast,
    runTurn: runJobTurn,
    isBusy,
    onFinished: refreshNextRun,
  });

  // Scheduling pass over the engine's loaded records: downtime accounting
  // before rescheduling, then arm timers / mark expiry. Afterwards the engine
  // re-enqueues executions that were persisted as queued at load.
  for (const j of engine.allRecords()) {
    if (j.type === "recurring" && j.cron) {
      // Downtime accounting happens before rescheduling: occurrences entirely
      // covered by the downtime window are recorded as missed, never replayed.
      if (countMissedOccurrences(j)) void engine.saveTasks();
      scheduleJob(j);
    } else if (j.type === "once" && !j.paused) {
      const scheduledAt = new Date(j.when);
      if (scheduledAt > new Date()) {
        scheduleJob(j);
      } else {
        // One-shot tasks that passed their scheduled time while down are
        // marked expired; they stay in history only.
        j.status = "expired";
        void engine.saveTasks();
      }
    }
  }
  engine.drainRepairQueue();
}

// ── Schedule math ────────────────────────────────────────────────────────────

// cron-parser is node-schedule's own expression parser, so occurrence math
// here always agrees with what the timer fires on.
function parseRule(cron, tz) {
  return cronParser.parseExpression(cron, { tz: tz || undefined });
}

function validateCron(cron, tz) {
  if (!cron || typeof cron !== "string") return "cron expression is required";
  try {
    parseRule(cron, tz);
    return null;
  } catch {
    return `invalid cron expression: ${cron}`;
  }
}

// Count occurrences strictly between lastRun and now for a recurring task that
// was NOT running (load-time gap). Increments the missed counter and appends a
// history marker so the UI can show why a task skipped. Returns true when the
// record changed (caller persists).
function countMissedOccurrences(task) {
  const now = new Date();
  const from = task.lastRun ? new Date(task.lastRun) : null;
  if (!from || Number.isNaN(from.getTime())) return false;
  try {
    const iter = parseRule(task.cron, task.tz);
    let missed = 0;
    // prev() yields occurrences strictly before `now`; each one after lastRun
    // was entirely covered by downtime. No warm-up call — the first prev() is
    // itself a countable occurrence.
    let prev = iter.prev();
    while (prev && prev.toDate() > from && missed < MAX_MISSED_PER_LOAD) {
      missed++;
      prev = iter.prev();
    }
    if (missed > 0) {
      task.missed = (task.missed || 0) + missed;
      task.history = task.history || [];
      task.history.push({ time: now.toISOString(), missed, success: null });
      console.log(`[cron] Task ${task.id} missed ${missed} occurrence(s) during downtime`);
      return true;
    }
  } catch (err) {
    console.warn(`[cron] missed-count failed for ${task.id}: ${err.message}`);
  }
  return false;
}

// ── Schedule management ──────────────────────────────────────────────────────

function generateId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Arm the live timer on the engine's shared record (in place — the record IS
// the engine's map entry; copying would detach state transitions from it).
function scheduleJob(task) {
  if (task.paused) return task;
  try {
    // tz, when present, evaluates the cron rule in the task's IANA timezone
    // (verified: node-schedule honors { rule, tz }); absent = cell-local,
    // which is the pre-change behavior legacy tasks keep.
    const spec = task.type === "recurring" && task.cron
      ? (task.tz ? { rule: task.cron, tz: task.tz } : task.cron)
      : new Date(task.when);
    task.job = schedule.scheduleJob(spec, () => {
      void engine.enqueueExecution(task.id);
    });
    if (task.job?.nextInvocation()) {
      task.nextRun = task.job.nextInvocation().toISOString();
    }
  } catch (err) {
    console.error(`[cron] Failed to schedule task ${task.id}:`, err.message);
    task.status = "error";
    task.error = err.message;
  }
  return task;
}

// The engine calls this after each finished execution so recurring tasks show
// the next armed occurrence.
function refreshNextRun(task) {
  if (task.job?.nextInvocation()) {
    task.nextRun = task.job.nextInvocation().toISOString();
  }
}

async function addJob({ cron, when, prompt, preset, tz, sessionTitle }) {
  if (cron) {
    const invalid = validateCron(cron, tz);
    if (invalid) throw new Error(invalid);
  } else if (!when || Number.isNaN(new Date(when).getTime())) {
    throw new Error("a valid cron expression or one-shot time is required");
  }
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");

  const id = generateId();
  const taskData = {
    id,
    trigger: "schedule",
    type: cron ? "recurring" : "once",
    cron,
    when,
    prompt,
    // Binding: the persona the task runs under and the session its output
    // belongs to. sessionId is minted here so the id is stable from creation,
    // but the dsh/SQLite session itself is only created at first execution
    // (a paused or deleted task leaves no orphan session behind).
    preset: preset ?? null,
    targetType: "persona",
    sessionId: `cron-${id}`,
    sessionTitle: sessionTitle || null,
    tz: tz || null,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    missed: 0,
    history: [],
  };

  // insertTask validates the target (persona-only today) before anything is
  // scheduled or persisted.
  const record = engine.insertTask(taskData);
  scheduleJob(record);
  await engine.saveTasks();
  engine.broadcastStatus(id);
  // Return the client-facing shape, never the live record: it carries the
  // node-schedule Job handle (a circular object), and the WS reply serializes
  // this value.
  return engine.getTask(id);
}

async function removeJob(id) {
  const task = engine.getRecord(id);
  if (!task) return false;
  if (task.job) {
    task.job.cancel();
  }
  engine.deleteRecord(id);
  await engine.saveTasks();
  // Shape kept from the pre-engine module so client stores can drop the row.
  engine.broadcastEvent({ type: "cron_removed", id });
  return true;
}

async function pauseJob(id) {
  const task = engine.getRecord(id);
  if (!task) return false;
  // Manual (delegated) tasks have no schedule-side lifecycle — pause/resume
  // are schedule concepts and SHALL NOT apply (spec: task-engine).
  if (task.trigger === "manual") return false;
  if (task.job) {
    task.job.cancel();
    task.job = null;
  }
  task.paused = true;
  task.status = "paused";
  await engine.saveTasks();
  engine.broadcastStatus(id);
  return true;
}

async function resumeJob(id) {
  const task = engine.getRecord(id);
  if (!task || !task.paused) return false;
  if (task.trigger === "manual") return false;
  task.paused = false;
  task.status = "scheduled";
  // Reschedule
  if (task.type === "recurring" && task.cron) {
    countMissedOccurrences(task);
    scheduleJob(task);
  } else if (task.type === "once" && task.when) {
    const scheduledAt = new Date(task.when);
    if (scheduledAt > new Date()) {
      scheduleJob(task);
    } else {
      task.status = "expired";
    }
  }
  await engine.saveTasks();
  engine.broadcastStatus(id);
  return true;
}

// Run or re-run a task immediately (bypasses the schedule). Returns the
// engine's enqueue result: { ok, already?, state?, error? } — already-queued
// or running executions are a no-op carrying the current state, and re-run of
// a failed/interrupted execution is allowed.
async function runJobNow(id) {
  return engine.runTaskNow(id);
}

function listJobs() {
  return engine.listTasks();
}

function getJob(id) {
  return engine.getTask(id);
}

function getDashboardState() {
  return engine.getDashboardState();
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  for (const task of engine.allRecords()) {
    if (task.job) {
      task.job.cancel();
    }
  }
  schedule.gracefulShutdown();
}

export {
  initCron,
  addJob,
  removeJob,
  pauseJob,
  resumeJob,
  listJobs,
  getJob,
  runJobNow,
  getDashboardState,
  validateCron,
  shutdown,
};
