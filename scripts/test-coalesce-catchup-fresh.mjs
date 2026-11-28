// Unit tests — catch-up vs fresh cadence round (2026-11-17-coalesce-catchup-with-fresh-fire).
//
// The defect this pins (measured on cell 1da519d4c1c0bf89, 2026-11-16/17): after a
// restart the engine enqueues a CATCH-UP round for every overdue job while the same
// jobs' FRESH cron rounds fire on time. One task record has one `state`, so the two
// rounds cannot both live in the queue — the bug was the DIRECTION of the merge:
// whichever arrived first won, and the fresh round was absorbed and then recorded as
// `catchUp`. In the minutes where >4 distinct personas fired at once (pool width 4)
// 57% of rounds were dropped as `queue staleness`, and the history could not say
// whether a drop was a catch-up squeezed out or a fresh round starved.
//
// Pins:
//   - catch-up then fresh ⇒ still ONE residence, it counts as FRESH, and a
//     coalesce record names what was replaced (1.1/1.2)
//   - a catch-up spanning 2+ periods enqueues ONE round and records the count (1.3)
//   - when the queue is over its width and a fresh round is waiting, CATCH-UPS
//     yield their slots — with their own skip reason, never `queue staleness` (2.1)
//   - a yielded round is `skipped` (not `failed`), visible in history, attributable
//     by `fireKind` (2.3 + 3.1)
//   - the fresh round still reaches a run after the yield (2.2)
//
// Run: node --test scripts/test-coalesce-catchup-fresh.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Storage env must land BEFORE the module-load-time constant is read.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coalesce-catchup-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// Production patience bound (10 min) — the number this change is about. Pinned
// rather than inherited so a developer's shell cannot change what "stale" means
// to these assertions.
process.env.QUEUE_MAX_AGE_MS = "600000";

const engine = await import("../task-engine.js");
const cron = await import("../cron.js");
const JOBS_FILE = path.join(tmpRoot, "jobs.json");

test.after(async () => {
  cron.shutdown();
  engine.setSlotDispatcher(null);
  engine.setQueueCapacity(null);
  // Drain the write chain BEFORE the store disappears: an in-flight rename into a
  // removed directory logs a scary (and harmless) "flush lost" line from a test
  // that passed.
  await engine.saveTasks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A slot dispatcher that CLAIMS everything and runs nothing: it is how these
// tests observe the queue itself (state, markers, coalesce records) instead of
// racing a turn that settles in a microtask.
function claimingDispatcher() {
  const claimed = [];
  const fn = (t) => {
    claimed.push(t?.id);
    return true;
  };
  fn.claimed = claimed;
  return fn;
}

async function freshEngine({ width = 1 } = {}) {
  // A fresh init drops the in-memory map; the claim/dispatch seams are module
  // globals and are reset explicitly (test order must not matter).
  engine.setSlotDispatcher(null);
  engine.setQueueCapacity(() => width);
  // …but `initTaskEngine` RELOADS the job records from disk, so a task the
  // previous test left behind comes back as `queued` and the queue is non-empty
  // before this test inserts anything. Measured 2026-11-24: `queueHealth()`
  // reported `queued: 3` where the test had inserted two, and the stray third
  // (a still-queued round from the "RUNNING must not relabel" case) made the
  // yield path fire instead of the staleness path — 3 red in 8 local runs.
  //
  // Clearing the store is the whole fix: "a fresh engine" has to mean an empty
  // one, and the in-memory reset alone cannot deliver that when the state is
  // persisted.
  fs.writeFileSync(JOBS_FILE, "[]");
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true, text: "done" }),
    isBusy: () => false,
  });
}

const task = (id, over = {}) => ({
  id,
  trigger: "schedule",
  targetType: "persona",
  prompt: `patrol ${id}`,
  preset: "persona-a",
  cron: "0/5 * * * *",
  tz: null,
  status: "scheduled",
  paused: false,
  history: [],
  ...over,
});

// ── 1.2 补跑先入队、新鲜轮次随后到达 ⇒ 队列只剩新鲜那轮 ─────────────────────

test("catch-up already queued, then the job's own fresh fire ⇒ one residence, counted as fresh", async () => {
  await freshEngine({ width: 4 });
  engine.setSlotDispatcher(claimingDispatcher());
  engine.insertTask(task("job_coalesce"));

  const first = engine.enqueueExecution("job_coalesce", { catchUp: true, missed: 3 });
  assert.equal(first.ok, true);
  let rec = engine.getRecord("job_coalesce");
  assert.equal(rec.state, "queued");
  assert.equal(rec.catchUpPending, true, "the queued round starts life as a catch-up");
  assert.equal(rec.catchUpMissed, 3);

  // The job's own cron fires while the catch-up still waits. There is ONE
  // residence — the question is which round it now carries.
  const second = engine.enqueueExecution("job_coalesce");
  assert.equal(second.ok, true);
  assert.equal(second.already, true, "still the same queue residence, not a second one");

  rec = engine.getRecord("job_coalesce");
  assert.equal(rec.state, "queued", "the round is still waiting, unchanged in position");
  assert.equal(rec.catchUpPending, false, "the queued round now counts as FRESH");
  assert.equal(rec.catchUpMissed, null, "the absorbed catch-up's period count is spent");

  const coalesced = (rec.history || []).filter((h) => h.replacedFireKind === "catchUp");
  assert.equal(coalesced.length, 1, "exactly one attributable coalesce record");
  assert.equal(coalesced[0].byFireKind, "fresh");
  assert.equal(coalesced[0].missedPeriods, 3, "the replaced round's period count rides the record");
  assert.match(String(coalesced[0].note), /superseded by a fresh cadence fire/);

  // One record, one queued round — the "同一作业有两轮待跑" shape cannot exist.
  const queued = engine.allRecords().filter((r) => r.id === "job_coalesce" && r.state === "queued");
  assert.equal(queued.length, 1);
});

test("the round that then runs is attributed `fresh`, not `catchUp`", async () => {
  await freshEngine({ width: 1 });
  engine.setSlotDispatcher(claimingDispatcher());
  engine.insertTask(task("job_attr"));
  engine.enqueueExecution("job_attr", { catchUp: true, missed: 2 });
  engine.enqueueExecution("job_attr"); // fresh absorbs it

  // Let the serial chain actually run it (the primary slot, width 1).
  engine.setSlotDispatcher(null);
  engine.sweepStaleQueuedFires(Date.now());
  await engine.idle();

  const rec = engine.getRecord("job_attr");
  const executions = (rec.history || []).filter((h) => h.kind === "execution");
  assert.equal(executions.length, 1, "one run, not one per enqueued round");
  assert.equal(executions[0].success, true);
  assert.equal(executions[0].fireKind, "fresh");
  // 3.1b: the kind is written BOTH ways. The acceptance gate splits dropped rows on
  // `catchUp === true / === false / absent`, so a fresh round that wrote nothing
  // would read as "unattributed" — indistinguishable from a pre-change row.
  assert.equal(executions[0].catchUp, false, "a fresh round must say so explicitly, not by omission");
  assert.equal(executions[0].missedPeriods, undefined);
});

// ── 1.3 停摆跨 2 个以上周期 ⇒ 一轮，且记下跳过几个周期 ───────────────────────

test("an outage spanning 2+ periods enqueues ONE round and records how many periods it stands in for", async () => {
  // Real boot path (cron.js's catch-up pass against a seeded jobs file), because
  // the "one round, not one per period" promise is made there: every missed
  // period used to be a candidate for its own make-up.
  const seeded = {
    id: "job_gap",
    trigger: "schedule",
    type: "recurring",
    cron: "0/5 * * * *",
    when: null,
    prompt: "five-minute patrol",
    preset: "persona-a",
    targetType: "persona",
    sessionId: "cron-job_gap",
    tz: null,
    status: "scheduled",
    paused: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    // 40 minutes of downtime on a 5-minute cadence: 8 missed periods, well inside
    // the 6h tolerance floor, so this is a catch-up and not an out-of-window alert.
    lastRun: new Date(Date.now() - 40 * 60_000).toISOString(),
    nextRun: null,
    missed: 0,
    history: [],
  };
  engine.setSlotDispatcher(null);
  engine.setQueueCapacity(() => 1);
  await engine.saveTasks();
  fs.writeFileSync(JOBS_FILE, JSON.stringify([seeded]));
  try {
    await cron.initCron({
      broadcast: () => {},
      runJobTurn: async () => ({ ok: true, text: "caught up" }),
      isBusy: () => false,
    });
    await engine.idle();
  } finally {
    cron.shutdown();
  }
  const rec = engine.getTask("job_gap");
  const catchUps = (rec.history || []).filter((h) => h.kind === "execution" && h.catchUp === true);
  assert.equal(catchUps.length, 1, `exactly one make-up run, got ${catchUps.length}`);
  assert.equal(catchUps[0].fireKind, "catchUp");
  assert.ok(
    Number.isInteger(catchUps[0].missedPeriods) && catchUps[0].missedPeriods >= 2,
    `the period count must be recorded, got ${catchUps[0].missedPeriods}`,
  );
  assert.ok(rec.missed >= 2, `the missed accounting is untouched (got ${rec.missed})`);
});

// ── 2.1/2.2/2.3 补跑为新鲜轮次让位 ──────────────────────────────────────────

// Six jobs' catch-ups + one fresh round, pool width 4 — the measured burst shape
// (12 personas in one minute at width 4 collapses to the same over-subscription).
async function crowdedQueue() {
  await freshEngine({ width: 4 });
  engine.setSlotDispatcher(claimingDispatcher());
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `job_catchup_${i}`;
    engine.insertTask(task(id, { preset: `persona-${i}` }));
    engine.enqueueExecution(id, { catchUp: true, missed: 1 });
    // Stagger the anchors so "oldest yields first" is observable and deterministic
    // (a real burst enqueues in a defined order; same-millisecond stamps are not).
    // Seconds, not minutes: the offsets only have to ORDER the rounds — backdating
    // them past QUEUE_MAX_AGE_MS would make the survivors genuinely stale and the
    // sweep would (correctly) drop them for the other reason, proving nothing.
    engine.getRecord(id).firstQueuedAt = Date.now() - (20 - i) * 1_000;
    engine.getRecord(id).queuedAt = engine.getRecord(id).firstQueuedAt;
    ids.push(id);
  }
  engine.insertTask(task("job_fresh", { preset: "persona-fresh" }));
  engine.enqueueExecution("job_fresh");
  engine.getRecord("job_fresh").firstQueuedAt = Date.now() - 500;
  engine.getRecord("job_fresh").queuedAt = engine.getRecord("job_fresh").firstQueuedAt;
  return ids;
}

test("queue over width with a fresh round waiting ⇒ catch-ups yield their slots", async () => {
  const ids = await crowdedQueue();
  const yielded = engine.yieldCatchUpsForFresh(Date.now());
  // width 4, one fresh round waiting ⇒ three slots left for seven rounds.
  assert.equal(yielded, 3, `three catch-ups must give up their slots, got ${yielded}`);

  const recs = ids.map((id) => engine.getRecord(id));
  const skipped = recs.filter((r) => r.state === "skipped");
  const stillQueued = recs.filter((r) => r.state === "queued");
  assert.equal(skipped.length, 3);
  assert.equal(stillQueued.length, 3);
  // The OLDEST catch-ups yield: they are the ones furthest from the current slot.
  assert.deepEqual(
    skipped.map((r) => r.id).sort(),
    ["job_catchup_0", "job_catchup_1", "job_catchup_2"],
    "oldest catch-ups yield first",
  );

  // In-play is back at the pool width: three catch-ups + the fresh round.
  const inPlay = engine.allRecords().filter((r) => r.state === "queued" || r.state === "running");
  assert.equal(inPlay.length, 4, "the queue is exactly one pool wide afterwards");
  assert.equal(engine.getRecord("job_fresh").state, "queued", "the fresh round is never the victim");
});

test("a yielded round is `skipped` with its own reason — visible, attributable, not failed", async () => {
  await crowdedQueue();
  engine.yieldCatchUpsForFresh(Date.now());

  const victim = engine.getRecord("job_catchup_0");
  assert.equal(victim.state, "skipped", "yielding is a skip, never a failure");
  assert.notEqual(victim.state, "failed");
  assert.match(String(victim.error), /yielded to fresh/, "the reason names the yield");
  assert.doesNotMatch(
    String(victim.error),
    /queue staleness/,
    "a yield must not be recorded as staleness — the two have opposite fixes",
  );

  const row = (victim.history || []).filter((h) => h.kind === "execution").at(-1);
  assert.ok(row, "the yield leaves a history row (invisible skips cannot be audited)");
  assert.equal(row.state, "skipped");
  assert.equal(row.fireKind, "catchUp", "attributable: this was a catch-up");
  assert.equal(row.catchUp, true);
  assert.equal(row.missedPeriods, 1);
  assert.doesNotMatch(String(row.error), /queue staleness/);

  // Nothing anywhere is `failed` — a skipped round must not inflate the failure count.
  assert.equal(
    engine.allRecords().filter((r) => r.state === "failed").length,
    0,
    "yielding adds no failure count",
  );
  // And the rounds that kept their slots are untouched.
  for (const id of ["job_catchup_5", "job_fresh"]) {
    assert.equal(engine.getRecord(id).state, "queued");
  }
});

test("after the yield the fresh round still runs inside its patience budget", async () => {
  const ids = await crowdedQueue();
  engine.yieldCatchUpsForFresh(Date.now());

  // Hand the remaining rounds to the serial chain and let them settle. The fresh
  // round must be among the ones that actually ran — not aged out.
  engine.setSlotDispatcher(null);
  engine.sweepStaleQueuedFires(Date.now());
  await engine.idle();

  const freshRec = engine.getRecord("job_fresh");
  const runs = (freshRec.history || []).filter((h) => h.kind === "execution");
  assert.equal(runs.length, 1, "the fresh round ran");
  assert.equal(runs[0].success, true);
  assert.equal(runs[0].fireKind, "fresh");
  assert.doesNotMatch(String(runs[0].error ?? ""), /queue staleness/);

  // Every catch-up either ran as a catch-up or yielded — none was aged out.
  const catchUpRuns = ids.filter((id) =>
    (engine.getRecord(id).history || []).some((h) => h.kind === "execution" && h.success === false && /queue staleness/.test(String(h.error))),
  );
  assert.deepEqual(catchUpRuns, [], "no catch-up was dropped for staleness — they yield instead");
});

// ── 运行中的吸收不得改标签（一轮 8–10 分钟，cron 每 5 分钟一火 ⇒ 真实形态）─────

test("a fresh fire arriving while the catch-up is RUNNING must not relabel that run as fresh", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  engine.setSlotDispatcher(null);
  engine.setQueueCapacity(() => 1);
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => {
      await gate;
      return { ok: true, text: "caught up" };
    },
    isBusy: () => false,
  });
  engine.insertTask(task("job_running"));
  engine.enqueueExecution("job_running", { catchUp: true, missed: 5 });
  // Wait until the round is actually in flight.
  for (let i = 0; i < 200 && engine.getRecord("job_running").state !== "running"; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(engine.getRecord("job_running").state, "running");

  // Its own cron fires mid-run. One residence ⇒ the run absorbs it, but the run
  // is still the CATCH-UP and must settle as such.
  engine.enqueueExecution("job_running");
  assert.equal(engine.getRecord("job_running").catchUpPending, true, "the in-flight round keeps its kind");

  release();
  await engine.idle();

  const rec = engine.getRecord("job_running");
  const row = (rec.history || []).filter((h) => h.kind === "execution").at(-1);
  assert.equal(row.success, true);
  assert.equal(row.fireKind, "catchUp", "the run that happened IS the catch-up");
  assert.equal(row.catchUp, true);
  assert.equal(row.missedPeriods, 5);
  // And the absorption is still on the record — a silent swallow is unauditable.
  const absorbed = (rec.history || []).filter((h) => /absorbed by the catch-up round already in flight/.test(String(h.note)));
  assert.equal(absorbed.length, 1);
});

// ── 3.1 被 `queue staleness` 丢的轮次同样带种类 ─────────────────────────────

test("a round dropped for staleness still records whether it was a catch-up or a fresh fire", async () => {
  await freshEngine({ width: 1 });
  // Freeze the drain for THIS test only: the staleness path needs both rounds to
  // stay `queued`, but `enqueueExecution` pushes onto `pendingExecutions` and
  // `drainExecutions` flips a round to `running` on the next microtask. That was
  // masked before by the one-process runner (earlier files left the drain idle
  // for this file); under the per-file runner each file is a fresh process so the
  // drain fires, `job_stale_fresh` is already `running`, and the sweep takes the
  // yield path instead of the staleness path. Resumed in the finally so the
  // `job_running` test later in this file still sees a real dispatch.
  engine._setDrainPaused(true);
  try {
    engine.setSlotDispatcher(claimingDispatcher());
  engine.insertTask(task("job_stale_catchup"));
  engine.insertTask(task("job_stale_fresh"));
  engine.enqueueExecution("job_stale_catchup", { catchUp: true, missed: 4 });
  engine.enqueueExecution("job_stale_fresh");
  // Both waited past the 10-minute bound (no fresh-round yield applies: the sweep
  // sees a fresh round, but the queue holds 2 rounds at width 1 ⇒ the catch-up is
  // the one that yields here; this test wants the STALENESS path, so drop the
  // fresh round's claim on the slot by making the stale drop run alone).
  for (const id of ["job_stale_catchup", "job_stale_fresh"]) {
    const r = engine.getRecord(id);
    r.firstQueuedAt = Date.now() - 30 * 60_000;
    r.queuedAt = r.firstQueuedAt;
  }
  // Remove the fresh round's claim on a slot (a manual fire never yields and is
  // never aged out) so the staleness path is the only one that can fire here.
  const fresh = engine.getRecord("job_stale_fresh");
  fresh.trigger = "manual";
  engine.sweepStaleQueuedFires(Date.now());

  const catchUp = engine.getRecord("job_stale_catchup");
  assert.equal(catchUp.state, "skipped");
  assert.match(String(catchUp.error), /queue staleness/);
  const row = (catchUp.history || []).filter((h) => h.kind === "execution").at(-1);
  assert.equal(row.fireKind, "catchUp", "a stale catch-up is still attributable as a catch-up");
  assert.equal(row.catchUp, true);
  assert.equal(row.missedPeriods, 4, "and it still says how many periods it stood for");
  } finally {
    engine._setDrainPaused(false);
  }
});

test("no fresh round waiting ⇒ catch-ups are NOT dropped (the sweep leaves a pure backlog alone)", async () => {
  await freshEngine({ width: 2 });
  engine.setSlotDispatcher(claimingDispatcher());
  for (let i = 0; i < 5; i += 1) {
    const id = `job_only_catchup_${i}`;
    engine.insertTask(task(id, { preset: `persona-${i}` }));
    engine.enqueueExecution(id, { catchUp: true, missed: 1 });
  }
  assert.equal(engine.yieldCatchUpsForFresh(Date.now()), 0, "nothing to yield to");
  assert.equal(engine.allRecords().filter((r) => r.state === "queued").length, 5);
});
