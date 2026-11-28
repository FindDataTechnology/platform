// Unit tests for the task-level failure retry policy (harden-cell-execution-
// reliability, task group 1). Pins the spec scenarios:
//   - default OFF: a failed execution is terminal immediately (fail-fast
//     status quo unchanged), no automatic re-execution is scheduled
//   - enabled: retries re-enter through the ordinary enqueue path after
//     exponential backoff; each attempt lands on the execution history
//   - exhausted: terminal failed, no further automatic executions, manual
//     re-run still available (and starts a fresh cycle)
//   - misconfiguration fails closed to the default (no retry)
//   - per-target-kind override (raise / lower / disable)
//   - a fresh execution (manual re-run) supersedes a pending retry: the
//     backoff timer is cancelled, no double execution
//   - interrupted outcomes keep their own semantics (never auto-retried)
//   - a restart does not resume a pending backoff (terminal stays, re-run works)
//
// Run: node --test scripts/test-task-retry-policy.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-retry-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db"); // paths.js may touch db dirs

const engine = await import("../task-engine.js");
const JOBS_FILE = path.join(tmpRoot, "jobs.json");

const RETRY_ENVS = [
  "PLATFORM_TASK_RETRY_MAX",
  "PLATFORM_TASK_RETRY_BACKOFF_MS",
  "PLATFORM_TASK_RETRY_MAX_TARGET_PERSONA",
  "PLATFORM_TASK_RETRY_MAX_TARGET_A2A",
  "PLATFORM_TASK_RETRY_MAX_TARGET_TOOL",
];

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Boot the singleton against a fresh fixture file (same harness as
// test-task-engine.mjs). Each initTaskEngine resets the in-memory map.
async function boot(records, runTurn = async () => ({ ok: true })) {
  // Drain the persistence write chain first: a save still in flight from the
  // previous test must not clobber the seed (CI-load flake family, see
  // test-task-engine.mjs boot()).
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
  sessionId: null,
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
  for (const name of RETRY_ENVS) delete process.env[name];
});

// Wait until `cond` turns true or the deadline passes (retry backoffs are real
// timers; polling keeps the test honest without assuming internal scheduling).
async function waitFor(cond, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── 默认关：现网行为零变化 ───────────────────────────────────────────────────

test("默认关：失败立即终态，不安排任何自动重试", async () => {
  let runs = 0;
  await boot([legacyRecord()], async () => {
    runs++;
    return { ok: false, error: "LLM request failed" };
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  const task = engine.getTask("job_1");
  assert.equal(task.state, "failed");
  assert.equal(task.error, "LLM request failed");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 1, "没有自动重试");
  assert.equal(task.history.length, 1);
  assert.equal(task.history[0].attempt, 1);
});

// ── 策略解析：默认值 / fail-closed / 每任务类覆盖 ───────────────────────────

test("策略解析：默认 0 次/60s，误配置 fail-closed，按任务类覆盖", () => {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    // 默认：关 + 默认退避
    assert.deepEqual(engine.resolveRetryPolicy("persona"), { max: 0, backoffMs: 60_000 });

    // 开启 + 自定义退避
    process.env.PLATFORM_TASK_RETRY_MAX = "3";
    process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "1500";
    assert.deepEqual(engine.resolveRetryPolicy("persona"), { max: 3, backoffMs: 1500 });

    // 每任务类覆盖：a2a 关、tool 抬到 5、persona 维持全局
    process.env.PLATFORM_TASK_RETRY_MAX_TARGET_A2A = "0";
    process.env.PLATFORM_TASK_RETRY_MAX_TARGET_TOOL = "5";
    assert.equal(engine.resolveRetryPolicy("a2a").max, 0);
    assert.equal(engine.resolveRetryPolicy("tool").max, 5);
    assert.equal(engine.resolveRetryPolicy("persona").max, 3);

    // 全局误配置（负数）→ fail-closed：不重试 + 默认退避
    process.env.PLATFORM_TASK_RETRY_MAX = "-1";
    assert.deepEqual(engine.resolveRetryPolicy("persona"), { max: 0, backoffMs: 60_000 });
    process.env.PLATFORM_TASK_RETRY_MAX = "3";

    // 覆盖误配置（非数字）→ 该类 fail-closed 不重试
    process.env.PLATFORM_TASK_RETRY_MAX_TARGET_TOOL = "abc";
    assert.equal(engine.resolveRetryPolicy("tool").max, 0, "覆盖误配置 = 该类不重试");

    // 退避误配置 → 整体回落默认（不重试），绝不发明退避值
    process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "nope";
    assert.deepEqual(engine.resolveRetryPolicy("persona"), { max: 0, backoffMs: 60_000 });

    // 非整数（1.5）同样是误配置
    process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "500";
    process.env.PLATFORM_TASK_RETRY_MAX = "1.5";
    assert.equal(engine.resolveRetryPolicy("persona").max, 0);

    assert.ok(warns.length >= 4, "每次误配置都有显式 WARNING");
  } finally {
    console.warn = originalWarn;
  }
});

// ── 开启：指数退避重试后 done，每次尝试落史 ─────────────────────────────────

test("开+退避重试：两败一成 → 第三次执行 done，每次尝试落史且退避指数增长", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "3";
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "20";
  let n = 0;
  await boot([legacyRecord()], async () => {
    n++;
    // 瞬时错误才走重试（harden-fleet-tool-face-and-queue 3.4 / E26）：
    // 502 与 runtime not ready 会自愈，context overflow 不会。
    return n <= 2 ? { ok: false, error: `502: Upstream service temporarily unavailable (attempt ${n})` } : { ok: true };
  });
  engine.enqueueExecution("job_1");
  await engine.idle(); // 第一次执行落定（failed）
  await waitFor(() => n >= 3);
  await engine.idle();

  assert.equal(n, 3);
  const task = engine.getTask("job_1");
  assert.equal(task.state, "done");
  assert.deepEqual(task.history.map((h) => h.attempt), [1, 2, 3]);
  assert.deepEqual(task.history.map((h) => h.state), ["failed", "failed", "done"]);
  assert.match(task.history[0].error, /attempt 1/);
  assert.match(task.history[1].error, /attempt 2/);

  // 指数退避只验下界（计时器不会早触发；上界受 CI 负载影响不可验）
  const t1 = Date.parse(task.history[0].time);
  const t2 = Date.parse(task.history[1].time);
  const t3 = Date.parse(task.history[2].time);
  assert.ok(t2 - t1 >= 19, `第一次退避应 ≥ 20ms，实得 ${t2 - t1}ms`);
  assert.ok(t3 - t2 >= 39, `第二次退避应 ≥ 40ms（2×20），实得 ${t3 - t2}ms`);
  await engine.saveTasks();
});

// ── 耗尽：终态 failed，不再自动执行，手动可重跑 ─────────────────────────────

test("耗尽（max=1）：首败即终态，手动重跑仍可用且从新周期起算", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "1";
  let n = 0;
  await boot([legacyRecord()], async () => {
    n++;
    return { ok: false, error: "always fails" };
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(engine.getTask("job_1").state, "failed");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(n, 1, "max=1：首败即耗尽，零自动重试");

  const rerun = engine.runTaskNow("job_1");
  assert.equal(rerun.ok, true);
  await engine.idle();
  assert.equal(n, 2);
  assert.equal(engine.getTask("job_1").state, "failed");
  assert.equal(engine.getTask("job_1").history.at(-1).attempt, 1, "手动重跑是新周期的 attempt 1");
  await engine.saveTasks();
});

test("耗尽（max=2）：两次失败后无第三次自动执行", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "2";
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "10";
  let n = 0;
  await boot([legacyRecord()], async () => {
    n++;
    return { ok: false, error: "502: upstream_error" };
  });
  engine.enqueueExecution("job_1");
  await waitFor(() => n >= 2);
  await engine.idle();
  assert.equal(n, 2);
  assert.equal(engine.getTask("job_1").state, "failed");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(n, 2, "耗尽后不再自动执行");
  assert.equal(engine.getTask("job_1").history.at(-1).attempt, 2);
  await engine.saveTasks();
});

test("非瞬时失败不重试：overflow / budget 一次就终态", async () => {
  // harden-fleet-tool-face-and-queue 3.4 / ledger E26. Live 2026-11-09: an
  // upstream 502, a real context overflow, a budget exhaustion and a not-ready
  // runtime all surfaced through the same wording; enabling retries naively
  // would burn the same window again on every overflow.
  process.env.PLATFORM_TASK_RETRY_MAX = "3";
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "10";
  for (const err of ["pi-ai detected context overflow for model \"deepseek-v4.1-flash\"",
                     "budget_exhausted: all candidate models are over budget"]) {
    let n = 0;
    await boot([legacyRecord()], async () => {
      n++;
      return { ok: false, error: err };
    });
    engine.enqueueExecution("job_1");
    await engine.idle();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(n, 1, `永久性失败只能跑一次（${err.slice(0, 30)}）`);
    assert.equal(engine.getTask("job_1").state, "failed");
    await engine.saveTasks();
  }
});

test("瞬时判据本身：502/429/timeout/runtime 为真，overflow/budget 为假", () => {
  const f = engine.isTransientFailure;
  for (const e of ["502: Upstream service temporarily unavailable", "429 rate limit",
                   "turn timed out", "the agent runtime is not ready (waiting)"]) {
    assert.equal(f(e), true, e);
  }
  for (const e of ["pi-ai detected context overflow for model x",
                   "budget_exhausted: all candidate models"]) {
    assert.equal(f(e), false, e);
  }
});

// ── 手动重跑取代待发重试 ─────────────────────────────────────────────────────

test("手动重跑取代待发重试：计时器取消，不双跑", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "3";
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "60";
  let n = 0;
  await boot([legacyRecord()], async () => {
    n++;
    return n === 1 ? { ok: false, error: "first fails" } : { ok: true };
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(n, 1);

  // 退避窗内手动重跑：取消待发计时器，新周期执行并成功
  const rerun = engine.runTaskNow("job_1");
  assert.equal(rerun.ok, true);
  await engine.idle();
  assert.equal(engine.getTask("job_1").state, "done");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(n, 2, "只有手动那一轮，原重试计时器已取消");
  assert.deepEqual(engine.getTask("job_1").history.map((h) => h.attempt), [1, 1]);
  await engine.saveTasks();
});

// ── interrupted 保持既有语义（不自动重试）────────────────────────────────────

test("interrupted 不走重试策略", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "3";
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "10";
  let n = 0;
  await boot([legacyRecord()], async () => {
    n++;
    return { ok: false, error: "the agent runtime restarted mid-turn", interrupted: true };
  });
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(engine.getTask("job_1").state, "interrupted");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(n, 1, "interrupted 不自动重试");
  await engine.saveTasks();
});

// ── 按任务类覆盖（端到端）────────────────────────────────────────────────────

test("按任务类覆盖：persona 按全局策略重试，a2a 被覆盖关闭", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "2";
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "10";
  process.env.PLATFORM_TASK_RETRY_MAX_TARGET_A2A = "0";
  const runs = { job_1: 0, job_2: 0 };
  await boot(
    [legacyRecord(), legacyRecord({ id: "job_2", targetType: "a2a", preset: "agent-1" })],
    async (t) => {
      runs[t.id]++;
      return { ok: false, error: "502: upstream_error" };
    },
  );
  engine.enqueueExecution("job_1");
  engine.enqueueExecution("job_2");
  await new Promise((r) => setTimeout(r, 200));
  await engine.idle();
  assert.equal(runs.job_1, 2, "persona 任务按全局策略重试到上限");
  assert.equal(runs.job_2, 1, "a2a 任务被覆盖关闭：首败即终态");
  assert.equal(engine.getTask("job_2").state, "failed");
  await engine.saveTasks();
});

// ── 重启不恢复待发重试 ───────────────────────────────────────────────────────

test("重启不恢复待发重试：终态保留，人工可重跑", async () => {
  process.env.PLATFORM_TASK_RETRY_MAX = "3";
  // Long backoff: the retry timer armed by the FIRST boot's failure must not
  // fire inside the idle→saveTasks→reboot window — a real-time 50ms backoff
  // races the test and fires mid-boot on a loaded runner (CI-only flake,
  // month-bomb class). The reboot clears stale timers anyway; the semantic
  // under test (no auto-retry across restart) needs the timer merely ARMED,
  // not fired.
  process.env.PLATFORM_TASK_RETRY_BACKOFF_MS = "10000";
  let n = 0;
  const failTurn = async () => {
    n++;
    return { ok: false, error: "boom" };
  };
  await boot([legacyRecord()], failTurn);
  engine.enqueueExecution("job_1");
  await engine.idle();
  assert.equal(n, 1);
  await engine.saveTasks(); // finishExecution 的落盘是 fire-and-forget，先排空写链

  // 以同一份盘上状态重启（失败终态已在盘上）：不自动续跑退避
  await boot(readStored(), failTurn);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(n, 1, "重启后无自动重试");
  assert.equal(engine.getTask("job_1").state, "failed");

  const rerun = engine.runTaskNow("job_1");
  assert.equal(rerun.ok, true);
  await engine.idle();
  assert.equal(n, 2);
  // 手动重跑又失败了（max=3 会再安排退避）：清掉引擎计时器，别让它跑进 teardown
  engine.shutdown();
  await engine.saveTasks();
});
