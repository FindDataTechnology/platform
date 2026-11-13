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
async function boot(records, runTurn = async () => ({ ok: true }), opts = {}) {
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
    ...(opts.workerStats ? { workerStats: opts.workerStats } : {}),
    ...(opts.beforeTurn ? { beforeTurn: opts.beforeTurn } : {}),
    ...(opts.resolveTurnBudget ? { resolveTurnBudget: opts.resolveTurnBudget } : {}),
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

test("run-now on an already-queued fire upgrades the staleness exemption", async () => {
  // harden-fleet-tool-face-and-queue 2.1. Live 2026-11-09: a scheduled fire had
  // waited 8 minutes (queuedBy=null) and POST /api/cron/:id/run answered
  // {already:true, queuedForMs:481625} without touching queuedBy — so the
  // operator's request kept the cadence fire's age and was one bound from being
  // dropped. The upgrade must not reorder the entry or reset its wait.
  await boot([legacyRecord()]);
  engine.enqueueExecution("job_1", { by: "cadence" });
  const before = engine.getTaskRecord("job_1"); // raw: clientShape strips queuedBy
  assert.equal(before.queuedBy, "cadence", "a cadence fire is not exempt");
  const anchor = before.firstQueuedAt;

  const again = engine.enqueueExecution("job_1", { by: "human" });
  assert.equal(again.already, true);
  assert.equal(again.upgraded, true, "the caller must be able to tell the stamp moved");
  const after = engine.getTaskRecord("job_1");
  assert.equal(after.queuedBy, "human", "an operator ignition is exempt from the age bound");
  assert.equal(after.firstQueuedAt, anchor, "催办不得清零已等待的时长");
  assert.equal(after.history.at(-1).note.includes("upgraded to human"), true, "催办必须留痕");

  // A second run-now is a plain no-op: the stamp is already human.
  const third = engine.enqueueExecution("job_1", { by: "human" });
  assert.equal(third.already, true);
  assert.equal(third.upgraded, undefined);
  await engine.idle();
});

test("replay order is waiting order, not file order", async () => {
  // harden-fleet-tool-face-and-queue 2.4. The platform restarted ~8 times in one
  // day; each boot rebuilt the repair queue from the persisted order, so a fire
  // that had waited for hours kept landing behind later arrivals (live
  // 2026-11-09: a human-exempt fire sat queued for 1.5 h). firstQueuedAt is the
  // per-residence anchor boot does NOT re-stamp, so replay must sort on it.
  const order = [];
  const now = Date.now();
  // Real wall-clock anchors, both human-exempt so the staleness policy (30 min
  // default) is not what decides this test — ordering is.
  const old = legacyRecord({ id: "job_old", state: "queued", queuedBy: "human",
    queuedAt: now - 20 * 60_000, firstQueuedAt: now - 20 * 60_000 });
  const fresh = legacyRecord({ id: "job_fresh", state: "queued", queuedBy: "human",
    queuedAt: now - 60_000, firstQueuedAt: now - 60_000 });
  // File order deliberately puts the long-waiting fire LAST.
  await boot([fresh, old], async (promptOrTask) => {
    order.push(typeof promptOrTask === "string" ? promptOrTask : (promptOrTask?.id ?? "unknown"));
    return { ok: true };
  });
  engine.drainRepairQueue();
  await engine.idle();
  assert.equal(order.length, 2, "both replayed fires ran");
  assert.equal(order[0].includes("old"), true, `the oldest waiter must run first, got ${JSON.stringify(order)}`);
});

test("a failed round rotates the session instead of resuming a dead child id", async () => {
  // Ledger E35 (live 2026-11-10): the rotation threshold reads token usage, and
  // an upstream 502/503 round records NO tokens — so `shouldRotateSession` never
  // fired and the task kept the same rotated id forever. Once the child that
  // owned it was gone, every later round failed with `502 upstream_error` at
  // revision 3 / index 1 (the job's sessionId still carried --r<ts> from 11:41
  // while rounds ran at 12:19). A failed round has nothing worth resuming.
  const seen = [];
  await boot([legacyRecord()], async (task) => {
    seen.push(task?.sessionId ?? null);
    return { ok: false, error: "502: upstream_error" };
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  const first = engine.getTaskRecord("job_1").sessionId;

  engine.enqueueExecution("job_1");
  await engine.idle();
  const second = engine.getTaskRecord("job_1").sessionId;

  assert.ok(first, "first round has a session id");
  assert.ok(second, "second round has a session id");
  assert.notEqual(second, first, "失败后必须换一个会话，不能复用已死的 child id");
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

// ── Fleet stats snapshot (unify-wanxing-management-plane) ────────────────────

test("stats snapshot: counts executions, worker occupancy, and windowed recents", async () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - 3 * 3_600_000).toISOString();
  await boot([
    legacyRecord({
      id: "job_s",
      prompt: "SECRET-PROMPT-MARKER",
      history: [
        { time: stale, success: true, state: "done" },
        { time: fresh, success: true, state: "done" },
        { time: fresh, success: false, state: "failed" },
        { time: fresh, success: false, state: "interrupted" },
        { time: fresh, success: true, state: null }, // legacy row: derived from success
      ],
    }),
    legacyRecord({ id: "job_q", history: [] }),
  ]);
  // job_q persisted as queued: load keeps the in-memory state until the
  // scheduling front-end drains the repair queue (not booted here).
  // allRecords() hands the live records — getTask returns a clientShape copy,
  // so mutating through it would not stick.
  const live = Object.fromEntries(engine.allRecords().map((t) => [t.id, t]));
  live.job_q.state = "queued";
  live.job_s.state = "running"; // live in-flight execution shape

  const snap = engine.stats({ now });
  assert.equal(snap.jobs, 2);
  assert.deepEqual(snap.executions, { running: 1, queued: 1 });
  assert.deepEqual(snap.recent, { done: 2, failed: 1, interrupted: 1 }); // stale row excluded
  assert.equal(snap.agentBusy, false);
});

test("stats snapshot: worker occupancy via the injected provider; broken reads empty", async () => {
  await boot([legacyRecord()], async () => ({ ok: true }), {
    workerStats: () => ({ cap: 4, busy: 1, idle: 3 }),
  });
  assert.deepEqual(engine.stats().workers, { cap: 4, busy: 1, idle: 3 });

  await boot([legacyRecord()], async () => ({ ok: true }), {
    workerStats: () => {
      throw new Error("pool gone");
    },
  });
  assert.deepEqual(engine.stats().workers, { cap: 0, busy: 0, idle: 0 });
});

test("stats snapshot: carries no user content (prompts never leave the cell)", async () => {
  await boot([legacyRecord({ prompt: "SECRET-PROMPT-MARKER" })]);
  const serialized = JSON.stringify(engine.stats());
  assert.ok(!serialized.includes("SECRET-PROMPT-MARKER"));
  assert.ok(!serialized.includes("morning report"));
});

test("stats snapshot: side-effect free (repeat calls, queue untouched)", async () => {
  await boot([legacyRecord()]);
  const a = engine.stats();
  const b = engine.stats();
  assert.deepEqual(a, b);
  assert.equal(engine.getTask("job_1").state, null); // nothing queued or run by sampling
});

// ── pre-turn 注入缝（fix-fleet-context-injection-seam） ────────────────────
//
// 引擎侧只验两件事：钩子在唯一的起轮点上跑（异常落成该次执行的 failed，绝不
// 炸串行链），以及补跑标记不会在「丢弃未执行」时泄漏给下一次开火。舰队语义在
// scripts/test-fleet-report-lane.mjs 的路径矩阵里钉。

test("pre-turn 钩子：抛错落该次执行 failed，不产生裸模板回合，不炸后续任务", async () => {
  const seen = [];
  await boot(
    [legacyRecord(), legacyRecord({ id: "job_2", prompt: "second" })],
    async (job) => { seen.push(job.prompt); return { ok: true }; },
    {
      beforeTurn: async (t) => {
        if (t.id === "job_1") throw new Error("fleetContext render failed: db exploded");
      },
    },
  );
  engine.enqueueExecution("job_1");
  await engine.idle();

  const t1 = engine.getTask("job_1");
  assert.equal(t1.state, "failed", "钩子异常 = 该次执行失败");
  assert.match(t1.history.at(-1).error, /fleetContext render failed: db exploded/, "结构化错误落史");
  assert.equal(seen.length, 0, "没有 turn 起跑——绝不拿裸模板执行");

  // 串行链未断：后续任务照常
  engine.enqueueExecution("job_2");
  await engine.idle();
  assert.equal(engine.getTask("job_2").state, "done");
  assert.deepEqual(seen, ["second"]);
});

test("补跑标记：入队即被调度侧拒绝时释放", async () => {
  await boot([legacyRecord({ paused: true, status: "paused" })]);
  engine.getTask("job_1").catchUpPending = true;
  const rejected = engine.enqueueExecution("job_1");
  assert.equal(rejected.ok, false);
  assert.equal(engine.getTask("job_1").catchUpPending, false, "拒绝即释放，不给下一次开火贴虚假补跑标签");
  await engine.saveTasks(); // 标记释放带写盘，先排空再交给 after 删目录
});

test("补跑标记：恢复队列遇拦截时同样释放", async () => {
  await boot([legacyRecord({ state: "queued", paused: true, status: "paused" })]);
  engine.getTask("job_1").catchUpPending = true;
  engine.drainRepairQueue();
  await engine.idle();
  assert.equal(engine.getTask("job_1").catchUpPending, false);
  await engine.saveTasks();
});

// ── Turn budget delivery (fix-fleet-turn-budget) ─────────────────────────────
//
// The defect these pin: the engine handed `turnFn` a fixed 10 minutes, so
// every declarable budget (cadence.turnTimeoutMs, constraints.budgetPerEdgeMin)
// was dead — while five resolver tests passed, because they only called the
// resolver. These assert the number that actually reaches the turn.

async function turnBudgetOf(opts = {}, recordOver = {}) {
  let seen = null;
  await boot([legacyRecord(recordOver)], async (_task, turnOpts) => {
    seen = turnOpts?.turnTimeoutMs;
    return { ok: true };
  }, opts);
  engine.enqueueExecution("job_1");
  await engine.idle();
  return seen;
}

test("预算交付：注入的解析器决定回合上界（不再恒为 10 分钟）", async () => {
  const budget = await turnBudgetOf({ resolveTurnBudget: () => 20 * 60 * 1000 });
  assert.equal(budget, 20 * 60 * 1000, "解析器说 20 分钟，回合就必须拿到 20 分钟");
});

test("预算交付：未注入解析器时退回默认 10 分钟（行为不变）", async () => {
  assert.equal(await turnBudgetOf(), 10 * 60 * 1000);
});

test("预算交付：解析器返回非法值/抛错都降级到默认，回合照常跑", async () => {
  assert.equal(await turnBudgetOf({ resolveTurnBudget: () => undefined }), 10 * 60 * 1000, "undefined");
  assert.equal(await turnBudgetOf({ resolveTurnBudget: () => 0 }), 10 * 60 * 1000, "zero");
  assert.equal(await turnBudgetOf({ resolveTurnBudget: () => Number.NaN }), 10 * 60 * 1000, "NaN");
  assert.equal(await turnBudgetOf({ resolveTurnBudget: () => { throw new Error("db gone"); } }), 10 * 60 * 1000, "throws");
  // …and the turn still completed (no failure path taken).
  assert.equal(engine.getTask("job_1").state, "done");
});

test("预算交付：解析器拿到的是本回合的任务（可按岗位/边分辨）", async () => {
  let id = null;
  await boot([legacyRecord({ sourceTag: { fleetId: "f1", memberId: "m1" } })], async () => ({ ok: true }), {
    resolveTurnBudget: (task) => {
      id = task?.sourceTag?.memberId ?? null;
      return 5 * 60 * 1000;
    },
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(id, "m1", "解析器必须看到任务本身，否则岗位/边维度无从分辨");
});

// ── 4.3 耗尽即 skip：结算与留痕 ────────────────────────────────────────
//
// 全链超限时 runPersonaTurn 在任何模型调用之前就返回了，所以那一步既不是执行
// 失败也不是配置错。记 failed 会污染失败率与重跑面（与 lane breaker 打开同一条
// 理由）。这里钉两件事：状态落 skipped，且历史行带得出原因——否则 skipped 会
// 变成第二个"看不出为什么"的桶。
test("budget exhaustion settles skipped (not failed) and records the reason", async () => {
  await boot(
    [legacyRecord()],
    async () => ({ ok: false, skipped: true, budgetExhausted: true,
                   error: "budget_exhausted: all candidate models over daily/monthly budget" }),
  );
  engine.enqueueExecution("job_1");
  await engine.idle?.();

  const t = engine.getTask("job_1");
  assert.equal(t.state, "skipped", "额度耗尽不是执行失败");
  assert.notEqual(t.state, "failed");
  const last = t.history.at(-1);
  assert.equal(last.state, "skipped");
  assert.equal(last.kind, "execution");
  assert.equal(last.skippedReason, "budget_exhausted",
    "原因必须落盘，否则 skipped 桶无法与「运行时未就绪」区分");
  assert.match(String(last.error), /budget_exhausted/);
});

test("a plain skip carries no budget reason (没有原因就不许编原因)", async () => {
  await boot(
    [legacyRecord()],
    async () => ({ ok: false, skipped: true, error: "llm lane open — round skipped" }),
  );
  engine.enqueueExecution("job_1");
  await engine.idle?.();

  const last = engine.getTask("job_1").history.at(-1);
  assert.equal(last.state, "skipped");
  assert.equal(last.skippedReason, undefined, "其它 skip 不该被贴上 budget 原因");
});

// ── 溢出后下一轮必换会话（rotate-cron-session-on-context-pressure 的盲点）──
//
// 溢出回合不写 tokens，靠 tokens 的判据对它失明。这里走真实执行链验：
// ① 溢出 → 任务被打上 rotateNextSession；② 该标记持久化；③ 下一轮换会话且标记清掉。
test("an overflow round arms the next rotation, and the flag survives a reload", async () => {
  await boot([legacyRecord({ sessionId: "cron-job_1" })], async () => ({
    ok: false, error: 'pi-ai detected context overflow for model "deepseek-v4.1-flash"',
  }));
  engine.enqueueExecution("job_1");
  await engine.idle?.();

  // getTask 是对外形状（副本），内部字段要用 getRecord 读。
  assert.equal(engine.getRecord("job_1").rotateNextSession, true, "溢出即武装下一轮");
  // 持久化：重启后这个决定不能丢。
  // 先把写链排空（saveTasks 是 fire-and-forget，直接读盘会读到上一版）——
  // boot() 里为同一个原因也这么做。
  await engine.saveTasks();
  const stored = readStored().find((r) => r.id === "job_1");
  assert.equal(stored.rotateNextSession, true, "must be persisted, else a restart loses it");
});

test("a normal failure does not arm a rotation", async () => {
  await boot([legacyRecord()], async () => ({ ok: false, error: "502: upstream unavailable" }));
  engine.enqueueExecution("job_1");
  await engine.idle?.();
  assert.notEqual(engine.getRecord("job_1").rotateNextSession, true);
});
