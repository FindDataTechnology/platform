// add-cron-automation-parity — the schedule-model contract (tasks 1.1–1.4, 2.x).
// Covers the three forms' mutual exclusion, the server-side clock anchor for a
// relative one-shot, interval occurrence math (cron-impossible steps), the
// finite-run cap, and in-place update preserving id/history/paused.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import schedule from "node-schedule";
import * as engine from "../task-engine.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-parity-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const cron = await import("../cron.js");

// Arming a job leaves node-schedule timers alive; without this the runner
// never exits. Cancel every armed job, then remove the fixture directory.
test.after(async () => {
  await new Promise((resolve) => schedule.gracefulShutdown(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function boot() {
  const events = [];
  await cron.initCron({
    broadcast: (e) => events.push(e),
    runJobTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  return events;
}

test("relative one-shot is anchored to the server clock (not a client wall time)", async () => {
  await boot();
  const before = Date.now();
  const job = await cron.addJob({ prompt: "water", delayMinutes: 8 });
  const when = new Date(job.when).getTime();
  // Lands ~8 minutes out, computed from now — never in the past.
  assert.ok(when >= before + 8 * 60_000 - 2_000, "anchored 8 minutes ahead of acceptance");
  assert.ok(when <= Date.now() + 8 * 60_000 + 2_000, "not drifting beyond the delay");
  assert.equal(job.type, "once");
});

test("relative delay rejects non-positive and over-long values", async () => {
  await boot();
  await assert.rejects(() => cron.addJob({ prompt: "x", delayMinutes: 0 }), /delayMinutes/);
  await assert.rejects(() => cron.addJob({ prompt: "x", delayMinutes: 525601 }), /delayMinutes/);
});

test("schedule forms are mutually exclusive", async () => {
  await boot();
  await assert.rejects(
    () => cron.addJob({ prompt: "x", delayMinutes: 5, cron: "0 9 * * *" }),
    /exclusive/,
  );
  await assert.rejects(
    () => cron.addJob({ prompt: "x", interval: { number: 2, unit: "hour" }, cron: "0 9 * * *" }),
    /exclusive/,
  );
});

test("interval accepts a cron-impossible step (every 40 days) and rejects bad shapes", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "rare", interval: { number: 40, unit: "day" } });
  assert.equal(job.type, "recurring");
  assert.deepEqual(job.interval, { number: 40, unit: "day" });
  assert.ok(job.anchor, "an anchor is stamped at creation");

  await assert.rejects(() => cron.addJob({ prompt: "x", interval: { number: 0, unit: "day" } }), /interval/);
  await assert.rejects(() => cron.addJob({ prompt: "x", interval: { number: 401, unit: "day" } }), /interval/);
  await assert.rejects(() => cron.addJob({ prompt: "x", interval: { number: 2, unit: "year" } }), /interval/);
});

test("maxRuns requires a recurring form and seeds the counter", async () => {
  await boot();
  await assert.rejects(() => cron.addJob({ prompt: "x", delayMinutes: 5, maxRuns: 3 }), /maxRuns/);
  const job = await cron.addJob({ prompt: "x", interval: { number: 1, unit: "hour" }, maxRuns: 3 });
  assert.equal(job.maxRuns, 3);
  assert.equal(job.runs, 0);
});

test("update preserves id + paused and reschedules in place", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "daily", cron: "0 9 * * *" });
  await cron.pauseJob(job.id);
  const updated = await cron.updateJob(job.id, { interval: { number: 6, unit: "hour" }, prompt: "every six hours" });
  assert.equal(updated.id, job.id, "same id");
  assert.deepEqual(updated.interval, { number: 6, unit: "hour" });
  assert.equal(updated.cron, null, "cron form cleared by the interval switch");
  assert.equal(updated.prompt, "every six hours");
  assert.equal(updated.paused, true, "paused state survives the edit");
});

test("update rejects an unknown id and conflicting forms", async () => {
  await boot();
  assert.equal(await cron.updateJob("nope", { prompt: "x" }), null);
  const job = await cron.addJob({ prompt: "x", cron: "0 9 * * *" });
  await assert.rejects(
    () => cron.updateJob(job.id, { interval: { number: 2, unit: "hour" }, cron: "0 10 * * *" }),
    /exclusive/,
  );
  // A cap can be raised or lowered on a live task; the counter survives.
  const capped = await cron.addJob({ prompt: "y", interval: { number: 1, unit: "hour" }, maxRuns: 5 });
  const updated = await cron.updateJob(capped.id, { maxRuns: 2 });
  assert.equal(updated.maxRuns, 2);
  assert.equal(updated.runs, 0, "the run counter is preserved (not reset by a cap edit)");
});

// ── Interval rows re-arm everywhere a live timer is (re)built ────────────────
// (fix-audit-code-gaps: boot/resume/update all conditioned re-arming on
// `task.cron`, so an interval task's timer silently died at restart, on
// resume, and on ANY in-place update — spec: recurring schedules reschedule
// automatically, resume continues from the next future occurrence, and an
// update recomputes the next occurrence from the new form.)

test("interval rows are armed at boot, not only after their first run", async () => {
  // Persist an interval row whose anchor is in the past, then boot the
  // scheduling pass over the reloaded records. (The anchor is aged via the
  // live record + the engine's own save chain — addJob always anchors at now,
  // and a raw file write would race the engine's pending saves.)
  const job = await cron.addJob({ prompt: "boot-arm", interval: { number: 30, unit: "minute" } });
  const anchor = new Date(Date.now() - 90 * 60_000).toISOString();
  const seeded = engine.getRecord(job.id);
  seeded.anchor = anchor;
  seeded.createdAt = anchor;
  await engine.saveTasks();
  await boot();
  const rec = engine.getRecord(job.id);
  assert.ok(rec, "the persisted row loaded");
  assert.ok(rec.job, "the interval row is armed by the boot pass");
  assert.ok(rec.nextRun, "nextRun recomputed from the anchor grid");
  assert.ok(new Date(rec.nextRun).getTime() > Date.now(), "the armed occurrence is in the future (past beats collapse to the next grid point)");
});

test("resume re-arms an interval task (continues from the next future occurrence)", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "resumable", interval: { number: 1, unit: "hour" } });
  await cron.pauseJob(job.id);
  assert.ok(!engine.getRecord(job.id).job, "pause disarms the timer");
  await cron.resumeJob(job.id);
  assert.ok(engine.getRecord(job.id).job, "resume re-arms the interval timer");
  assert.ok(engine.getRecord(job.id).nextRun, "next occurrence restored");
});

test("an in-place update re-arms an interval task instead of killing it", async () => {
  await boot();
  const job = await cron.addJob({ prompt: "editable", interval: { number: 1, unit: "hour" } });
  assert.ok(engine.getRecord(job.id).job, "armed at creation");
  const updated = await cron.updateJob(job.id, { prompt: "edited" });
  assert.equal(updated.prompt, "edited");
  assert.ok(engine.getRecord(job.id).job, "the update's cancel+re-arm cycle leaves the interval timer alive");
  assert.ok(engine.getRecord(job.id).nextRun, "next occurrence recomputed from the unchanged rule");
});
