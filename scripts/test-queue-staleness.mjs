#!/usr/bin/env node
// ── Queue staleness tests (fix-cell-turn-throughput 2.2) ─────────────────────
//
// The serial chain (`executionQueue.then(...)`) means one turn that never
// settles stops every queued execution behind it. Live 2026-11-08: a turn sat
// in `running` 3.5 minutes with 24 tasks queued and nothing moved, because
// `finishExecution` can only be called by the turn itself.
//
// This file owns ONLY the staleness policy: a separate process, because the
// serial chain is module state — a never-settling turn left by one test would
// otherwise queue every later test behind it.
//
//   node --test scripts/test-queue-staleness.mjs

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

// ── 2.2 Queue staleness ─────────────────────────────────────────────────────
//
// One serial slot + a catch-up burst ⇒ an hours-long backlog. A scheduled fire
// that reaches the front hours late would patrol a slot that already passed and
// hold every newer fire behind it (live 2026-11-08: 18 queued, oldest 3.5h,
// while a `run now` waited 180s and saw nothing). Above the staleness bound a
// scheduled fire is dropped as `skipped` without spending budget; manual fires
// are never aged out.

function addScheduledTask(id) {
  engine.insertTask({ id, name: id, prompt: "p", trigger: "schedule", targetType: "persona" });
  return id;
}

test("a scheduled fire that waited past the staleness bound is dropped as skipped", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("stale");
    // Simulate a backlog: the fire first asked for a slot long before it got
    // one (both clocks aged — this case is about the bound, not about which
    // clock is authoritative; the restart case below covers that).
    engine.enqueueExecution("stale");
    const stale = engine.getRecord("stale");
    stale.firstQueuedAt = Date.now() - 60_000;
    stale.queuedAt = Date.now() - 60_000;
    addScheduledTask("fresh");
    engine.enqueueExecution("fresh");

    const settled = await waitFor(() => engine.getRecord("stale").state === "skipped");
    assert.equal(settled, true, "a stale scheduled fire must settle instead of running");
    assert.match(engine.getRecord("stale").error ?? "", /queue staleness/, "the cause must name staleness");
    assert.equal(started.includes("stale"), false, "a dropped fire must not spend a turn");

    const freshRan = await waitFor(() => started.includes("fresh"));
    assert.equal(freshRan, true, "the newer fire must get the slot");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

test("a DAILY cron fire is not aged out however long it waits", async () => {
  // The regression this pins (measured 2026-11-13): the staleness bound dropped
  // a `30 8 * * *` round as "waited 10min > 10min". `skipped` neither retries
  // nor counts as missed, so the whole day's round vanished with no failure
  // recorded — the exemption existed for exactly this case and never applied
  // because cron rounds reported an unknown period.
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    engine.insertTask({ id: "daily", name: "daily", prompt: "p", trigger: "schedule", cron: "30 8 * * *", tz: "Asia/Shanghai", targetType: "persona" });
    engine.enqueueExecution("daily");
    const daily = engine.getRecord("daily");
    daily.firstQueuedAt = Date.now() - 60_000;
    daily.queuedAt = Date.now() - 60_000;

    await new Promise((r) => setTimeout(r, 300));
    const rec = engine.getRecord("daily");
    // Either outcome is fine (it may get the slot immediately); what must never
    // happen is the silent drop, which leaves no failure and no retry.
    assert.notEqual(rec.state, "skipped",
      "a daily round must never be dropped — losing it loses the whole day");
    assert.doesNotMatch(rec.error ?? "", /queue staleness/,
      "no staleness verdict may be recorded against a daily round");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

test("a manual run is never aged out (a human asked for that round)", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addTask("manual-old");
    engine.enqueueExecution("manual-old");
    engine.getRecord("manual-old").firstQueuedAt = Date.now() - 60_000;
    const ran = await waitFor(() => started.includes("manual-old"));
    assert.equal(ran, true, "manual fires must run regardless of queue age");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

test("QUEUE_MAX_AGE_MS=0 restores the pre-policy behaviour", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "0";
  try {
    addScheduledTask("old-but-allowed");
    engine.enqueueExecution("old-but-allowed");
    engine.getRecord("old-but-allowed").firstQueuedAt = Date.now() - 60_000;
    const ran = await waitFor(() => started.includes("old-but-allowed"));
    assert.equal(ran, true, "0 disables the staleness policy");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

// A restart re-stamps `queuedAt` (the WAIT clock) so the probe never cries
// "waiting 12 hours". The staleness decision must therefore key off the FIRST
// queue timestamp, or every restart refreshes the whole backlog to "brand new"
// and the policy can never fire (live 2026-11-08: 16-18 fires re-stamped on
// each boot while a `run now` waited behind them).
test("a re-stamped wait clock does not refresh the staleness age", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("rebooted-old");
    // Enqueue, then simulate what a restart does: keep the first-queue anchor,
    // but refresh the wait clock to "now".
    engine.enqueueExecution("rebooted-old");
    const rec = engine.getRecord("rebooted-old");
    rec.firstQueuedAt = Date.now() - 120_000;
    rec.queuedAt = Date.now();

    addScheduledTask("after-restart");
    engine.enqueueExecution("after-restart");

    const settled = await waitFor(() => engine.getRecord("rebooted-old").state === "skipped");
    assert.equal(settled, true, "the anchor, not the refreshed wait clock, decides staleness");
    assert.equal(started.includes("rebooted-old"), false);
    assert.equal(await waitFor(() => started.includes("after-restart")), true);
  } finally { delete process.env.QUEUE_MAX_AGE_MS; }
});

// The anchor must survive a process restart, and `saveTasks` persists by
// WHITELIST — a field it does not name is dropped even though `loadTasks`
// spreads whatever it finds. Without this the policy looked correct in-process
// and could never fire in production: every boot handed the whole backlog a
// fresh anchor (live 2026-11-08: 18 queued, all stamped inside one second).
test("the first-queue anchor is persisted, so a restart cannot refresh it", async () => {
  // Hold the serial slot so the task under test stays QUEUED (leaving the queue
  // for a real run clears the anchor by design — that is not what this tests).
  let release;
  const gate = new Promise((r) => { release = r; });
  await boot((task) => (task.id === "blocker" ? gate : Promise.resolve({ ok: true })));
  addScheduledTask("blocker");
  engine.enqueueExecution("blocker");
  addScheduledTask("persisted-anchor");
  engine.enqueueExecution("persisted-anchor");
  const rec = engine.getRecord("persisted-anchor");
  assert.equal(rec.state, "queued", "the task must still be waiting behind the blocker");
  const anchoredAt = Date.now() - 90_000;
  rec.firstQueuedAt = anchoredAt;
  await engine.saveTasks();

  const saved = JSON.parse(fs.readFileSync(path.join(process.env.CRON_STORAGE_PATH, "jobs.json"), "utf8"));
  const row = saved.find((r) => r.id === "persisted-anchor");
  assert.ok(row, "the task must be on disk");
  assert.equal(row.firstQueuedAt, anchoredAt, "saveTasks must whitelist the anchor");
  release({ ok: true });
  await engine.idle();
});

// The staleness age may only drop a fire NOBODY asked for. `run now` on a
// cadence task keeps trigger="schedule", so keying the policy on the trigger
// alone dropped the operator's own ignition once it waited past the bound —
// the very "run-now lost" symptom this change set out to kill (live
// 2026-11-08: a fleet scout run-now was dropped as "waited 28min > 10min").
test("a run-now on a cadence task is never aged out, however long it waits", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("human-ignition");
    engine.runTaskNow("human-ignition");
    const rec = engine.getRecord("human-ignition");
    assert.equal(rec.queuedBy, "human", "run-now must mark the residence as human");
    rec.firstQueuedAt = Date.now() - 300_000;
    const ran = await waitFor(() => started.includes("human-ignition"));
    assert.equal(ran, true, "a human ignition must run regardless of queue age");
  } finally { delete process.env.QUEUE_MAX_AGE_MS; }
});

// The dequeue-time check only ever sees the fire that WINS the slot. With human
// wakes and manual turns arriving continuously, an over-age cadence fire parked
// behind them never reaches the front — so it was never dropped, and it held
// `queueHealth().degraded` true the whole time (live 2026-11-09:
// job_1793413192186_g51s7b, cadence, 80 minutes queued, /api/ready 503 on an
// otherwise healthy cell). The sweep looks at the queue itself, not the slot.
test("the sweep drops an over-age cadence fire that never reaches the front", async () => {
  // Hold the slot with a blocker so nothing dequeues during the test.
  let release;
  const gate = new Promise((r) => { release = r; });
  await boot((task) => (task.id === "blocker" ? gate : Promise.resolve({ ok: true })));
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("blocker");
    engine.enqueueExecution("blocker");
    addScheduledTask("parked-old");
    engine.enqueueExecution("parked-old");
    const rec = engine.getRecord("parked-old");
    assert.equal(rec.state, "queued");
    rec.firstQueuedAt = Date.now() - 660_000; // 11 min parked behind the blocker
    assert.equal(engine.queueHealth().degraded, true, "an over-age queued fire degrades the probe");

    const dropped = engine.sweepStaleQueuedFires();
    assert.ok(dropped >= 1, "the parked cadence fire is swept");
    assert.equal(engine.getRecord("parked-old").state, "skipped");
    assert.match(engine.getRecord("parked-old").error ?? "", /queue staleness/);
    // Scope to THIS task: the suite shares one engine, so other cases' leftovers
    // may legitimately keep the aggregate probe degraded.
    const after = engine.queueHealth();
    assert.equal(after.queued < 1 || engine.getRecord("parked-old").state !== "queued", true,
      "the swept fire no longer occupies a queue slot");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
    release({ ok: true });
    await engine.idle();
  }
});

test("the sweep never touches a human ignition nor a running turn", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await boot((task) => (task.id === "runner" ? gate : Promise.resolve({ ok: true })));
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("runner");
    engine.enqueueExecution("runner");           // becomes the running turn
    // Dispatch is a promise chain: wait for the turn to actually start, else the
    // sweep would legitimately see it as queued and drop it.
    assert.equal(await waitFor(() => engine.getRecord("runner").state === "running"), true);
    addScheduledTask("human-old");
    engine.runTaskNow("human-old");              // queued, human
    const human = engine.getRecord("human-old");
    human.firstQueuedAt = Date.now() - 600_000;
    const runner = engine.getRecord("runner");
    if (Number.isFinite(runner.firstQueuedAt)) runner.firstQueuedAt = Date.now() - 600_000;

    // Other tests' leftovers may also be swept here — assert on THIS pair, which
    // is the actual contract: a human ignition and a running turn are untouchable.
    engine.sweepStaleQueuedFires();
    assert.equal(engine.getRecord("human-old").state, "queued", "a human ignition is never swept");
    assert.equal(engine.getRecord("human-old").queuedBy, "human");
    assert.notEqual(engine.getRecord("runner").state, "skipped", "a running turn is never swept");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
    release({ ok: true });
    await engine.idle();
  }
});

// ── Orphaned queued executions (fix-orphaned-queued-executions) ────────────
//
// A task can carry state="queued" while holding NO pending execution. Then
// `drainExecutions` has nothing to pick, the cell stops with running=0, no error
// is raised anywhere, and every later enqueue is absorbed by the "already
// queued" branch — so it never heals. Live 2026-11-09: queue.queued=4,
// queue.running=0, fairness pending=0 for ~20 minutes while a `run now` kept
// answering {ok:true, already:true}.

test("a queued-but-off-chain task is re-dispatched instead of being absorbed", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  try {
    addScheduledTask("orphan");
    engine.enqueueExecution("orphan");
    await waitFor(() => started.includes("orphan"));
    // Reproduce the orphan: state says queued, but nothing pending holds it.
    const rec = engine.getRecord("orphan");
    rec.state = "queued";
    engine.queueHealth(); // first sighting (dispatch may be in flight)
    assert.equal(engine.queueHealth().orphaned >= 1, true, "the probe must count it");
    assert.equal(engine.queueHealth().degraded, true, "an orphan degrades the probe");

    const ranBefore = started.filter((x) => x === "orphan").length;
    const r = engine.runTaskNow("orphan");
    assert.equal(r.ok, true);
    assert.equal(r.requeued, true, "the orphan must be re-chained, not absorbed");
    assert.equal(await waitFor(() => started.filter((x) => x === "orphan").length > ranBefore), true,
      "the re-dispatched execution must actually run");
  } finally { await engine.idle(); }
});

test("the periodic sweep revives an orphan that nobody re-fires", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  try {
    addScheduledTask("orphan-swept");
    engine.enqueueExecution("orphan-swept");
    await waitFor(() => started.includes("orphan-swept"));
    // Drift into the orphan state: queued, but no pending execution holds it.
    engine.getRecord("orphan-swept").state = "queued";
    engine.queueHealth(); // first sighting (dispatch may be in flight)
    assert.equal(engine.queueHealth().orphaned >= 1, true);
    const before = started.filter((x) => x === "orphan-swept").length;
    engine.sweepStaleQueuedFires();
    assert.equal(await waitFor(() => started.filter((x) => x === "orphan-swept").length > before), true,
      "the sweep must put the orphan back on the chain without an operator action");
  } finally { await engine.idle(); }
});

// ── Period-aware staleness (fix-stale-drop-respects-period) ────────────────
//
// The bound alone reads "waited 10 minutes" as "the round is worthless", which
// is only true when another occurrence is coming soon. Dropping a DAILY round
// loses the whole day: `skipped` neither retries nor counts as `missed`. So a
// round whose period EXCEEDS the bound is exempt — and, because it will never
// be dropped, it must also stop counting as evidence that the queue is stuck.

test("schedulePeriodMs: interval table, and null when it cannot be established", () => {
  const { schedulePeriodMs } = engine;
  assert.equal(schedulePeriodMs({ interval: { number: 1, unit: "minute" } }), 60_000);
  assert.equal(schedulePeriodMs({ interval: { number: 2, unit: "hour" } }), 7_200_000);
  assert.equal(schedulePeriodMs({ interval: { number: 1, unit: "day" } }), 86_400_000);
  assert.equal(schedulePeriodMs({ interval: { number: 40, unit: "day" } }), 40 * 86_400_000, "every-40-days is expressible");
  assert.equal(schedulePeriodMs({ interval: { number: 1, unit: "week" } }), 604_800_000);
  // Unknown is NOT treated as exempt: guessing would widen the policy on bad data.
  assert.equal(schedulePeriodMs({}), null);
  assert.equal(schedulePeriodMs({ interval: { number: 1, unit: "year" } }), null);
  assert.equal(schedulePeriodMs({ interval: { number: 0, unit: "day" } }), null);
  // Cron form is the dominant one for fleet cadence, and it used to return null,
  // which silently switched the exemption off for every post. Resolved through
  // the same parser the scheduler fires with.
  assert.equal(schedulePeriodMs({ cron: "0 3 * * *" }), 86_400_000, "a daily cron round is a day long");
  assert.equal(schedulePeriodMs({ cron: "30 8 * * *", tz: "Asia/Shanghai" }), 86_400_000, "cron + tz resolves");
  assert.equal(schedulePeriodMs({ cron: "0 * * * *" }), 3_600_000, "hourly cron stays droppable");
  assert.equal(schedulePeriodMs({ cron: "0 0 1 1 *" }), 365 * 86_400_000, "yearly cron is a year long");
  assert.equal(schedulePeriodMs({ cron: "not a cron" }), null, "unparseable schedule is unknown, not exempt");
});

test("isAgeExemptQueued: exempt iff the period is long enough to matter", () => {
  const { isAgeExemptQueued } = engine;
  const day = { state: "queued", trigger: "schedule", interval: { number: 1, unit: "day" } };
  const hour = { state: "queued", trigger: "schedule", interval: { number: 1, unit: "hour" } };
  assert.equal(isAgeExemptQueued(day), true, "losing a daily round costs a whole day");
  assert.equal(isAgeExemptQueued({ state: "queued", trigger: "schedule", interval: { number: 6, unit: "hour" } }), true,
    "the floor is inclusive: 6h is already a quarter of a day");
  assert.equal(isAgeExemptQueued(hour), false, "an hourly round regenerates quickly — keep the queue moving");
  assert.equal(isAgeExemptQueued(day, Infinity), false, "a floor above every period exempts nothing");
  assert.equal(isAgeExemptQueued({ ...day, queuedBy: "human" }), false,
    "a human ignition never ages out — a different rule, not this one");
  assert.equal(isAgeExemptQueued({ ...day, trigger: "manual" }), false);
  assert.equal(isAgeExemptQueued({ ...day, interval: undefined }), false, "unknown period keeps the old rule");
});

test("staleExemptMinPeriodMs: the floor is read per call, and is independently set", () => {
  const { staleExemptMinPeriodMs, isAgeExemptQueued } = engine;
  const saved = process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS;
  try {
    delete process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS;
    assert.equal(staleExemptMinPeriodMs(), 6 * 3_600_000, "default 6h");
    process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS = String(30 * 60_000);
    assert.equal(staleExemptMinPeriodMs(), 30 * 60_000, "the knob takes effect without a restart");
    // And it really changes the decision: a 1h round is now exempt too.
    assert.equal(isAgeExemptQueued({ trigger: "schedule", interval: { number: 1, unit: "hour" } }), true);
    process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS = "not-a-number";
    assert.equal(staleExemptMinPeriodMs(), 6 * 3_600_000, "garbage falls back to the default");
  } finally {
    if (saved === undefined) delete process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS;
    else process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS = saved;
  }
});

test("a daily round is NOT swept while an hourly one is", async () => {
  await boot(() => Promise.resolve({ ok: true }));
  process.env.QUEUE_MAX_AGE_MS = "600000";
  try {
    engine.insertTask({ id: "daily", name: "daily", prompt: "p", trigger: "schedule", targetType: "persona", interval: { number: 1, unit: "day" } });
    engine.insertTask({ id: "hourly", name: "hourly", prompt: "p", trigger: "schedule", targetType: "persona", interval: { number: 1, unit: "hour" } });
    // Both waited far past the bound.
    engine.getRecord("daily").firstQueuedAt = Date.now() - 30 * 60_000;
    engine.getRecord("hourly").firstQueuedAt = Date.now() - 30 * 60_000;
    engine.getRecord("daily").state = "queued";
    engine.getRecord("hourly").state = "queued";

    engine.sweepStaleQueuedFires();
    assert.equal(engine.getRecord("daily").state, "queued", "the daily round is exempt — dropping it loses the day");
    assert.equal(engine.getRecord("hourly").state, "skipped", "the hourly round is still superseded inside the window");
    assert.match(engine.getRecord("hourly").error, /next cadence fire/, "and its error says so");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
    for (const id of ["daily", "hourly"]) { try { engine.deleteRecord(id); } catch { /* gone */ } }
    await engine.idle();
  }
});

test("an age-exempt round alone must not report the cell as stalled", async () => {
  // `degraded` is a COMPOSITE (stalled ‖ overBudget ‖ orphaned), and this test
  // is about ONE of the three. Two neighbouring facts used to leak into it and
  // made the assertion depend on the environment rather than on the exemption
  // (2026-11-13: red on a CI shard, green 5/5 locally):
  //   · a queued non-exempt row left behind by an earlier case → `stalled`;
  //   · the ORPHAN heuristic, which flags a queued round with nothing on the
  //     chain from its SECOND consecutive sighting — and the old fixture built
  //     exactly such a round by flipping `state` on an inserted task, so the
  //     verdict changed the first time anything else read queue health.
  // So the fixture is now structural: the single slot is held by a turn that
  // does not resolve, and the daily round waits for it through the real enqueue
  // path, which puts its execution on the chain. A real waiting round is not an
  // orphan, however many times the snapshot is read.
  let release;
  const held = new Promise((r) => { release = r; });
  await boot(async () => { await held; return { ok: true }; });
  process.env.QUEUE_MAX_AGE_MS = "600000";
  try {
    // Isolation from anything an earlier case left queued.
    await engine.idle();
    for (const t of [...engine.listTasks()]) {
      try { engine.deleteRecord(t.id); } catch { /* already gone */ }
    }

    addTask("slot-holder");
    engine.enqueueExecution("slot-holder");
    const running = await waitFor(() => engine.queueHealth().running === 1);
    assert.equal(running, true, "the slot holder must be running before the daily round queues behind it");

    // The worst case: nothing has settled for longer than the bound (an idle
    // cell), and the queue holds ONE round — the exempt one.
    engine._stampSettlement(0);
    engine.insertTask({ id: "lonely-daily", name: "lonely-daily", prompt: "p", trigger: "schedule", targetType: "persona", interval: { number: 1, unit: "day" } });
    const rec = engine.getRecord("lonely-daily");
    rec.firstQueuedAt = Date.now() - 60 * 60_000;
    engine.enqueueExecution("lonely-daily");   // no `by` → queuedBy="cadence", which the staleness policy ages
    assert.equal(engine.getRecord("lonely-daily").state, "queued", "the daily round must be waiting behind the held slot");

    const health = engine.queueHealth();
    assert.equal(health.degraded, false, "one waiting daily round is not a stalled queue");
    assert.equal(health.oldestQueuedMs, null, "an exempt round is not evidence of waiting");
    assert.equal(health.queuedExempt, 1, "and it is named, so `null` is not mistaken for an unreachable cell");
    // The old fixture survived exactly one snapshot; hold the claim across a
    // second one so a stray read elsewhere can never flip it.
    assert.equal(engine.queueHealth().degraded, false, "and it stays healthy on a re-read");

    // The contrast that keeps the bound honest: swap it for an hourly round and
    // the same snapshot must go degraded.
    rec.interval = { number: 1, unit: "hour" };
    const health2 = engine.queueHealth();
    assert.equal(health2.degraded, true, "an hourly round waiting an hour IS a stall");
    assert.ok(health2.oldestQueuedMs >= 60 * 60_000);
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
    release();
    try { engine.deleteRecord("lonely-daily"); } catch { /* gone */ }
    try { engine.deleteRecord("slot-holder"); } catch { /* gone */ }
    await engine.idle();
  }
});
