// Model-surface budget gate (add-model-surface-budget-gate 3.1-3.3).
//
// 3.1 engine 单测：三级检查/消费/懒滚窗/显式重置/超限事件落 log/报表面。
// 3.2 集成点前置检查：fleetModelFor 的 budgetProbe 注记 + normalizeModelForJob
//     的 walk 跳过超限跳（经 runPersonaTurn 全路径验证，walk 在其内）。
// 3.3 e2e：连续派发触发日上限 → 自动降级到链下一跳 → 次日（注入时钟跨日）
//     恢复可用；single 超限触发一次性降级 + budget_exhausted_log 逐条可溯。
//
// Run: node --test scripts/test-model-budget-gate.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-budget-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
delete process.env.MODEL_BUDGET_ENABLED;

const dbModule = await import("../db.js");
await dbModule.initDb();
await (await import("../chat-history.js")).initChatHistory();
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { fleetModelFor } = await import("../server/fleet-reports.js");
const { runPersonaTurn } = await import("../server/cron-runner.js");
const { createBudgetEngine, attachModelBudgetReset, budgetConfigFromEnv, utcDayKey, turnTokens } = await import("../server/model-budget.js");

const fleetId = "f1";
const memberId = "m1";
const preset = "persona-budget";
const MODEL_A = "deepseek-v4.1-flash";
const MODEL_B = "qwen3.8-flash";

let fleetDb;
// 可注入时钟：e2e 的「次日凌晨恢复」靠它跨日界，不真睡。
let nowMs = Date.UTC(2026, 10, 5, 10, 0, 0); // 2026-11-05T10:00Z
const now = () => nowMs;

let engine; // db 句柄在 before() 建库后才有——引擎随建随挂
const engineConfig = { enabled: true, single: 8192, daily: 100_000, monthly: 500_000 };

before(() => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}.db`) });
  setFleetDatabase(fleetDb);
  fleetDb.createFleet({ id: fleetId, name: "budget gate fleet", ownerEmail: "o@x" });
  fleetDb.createMember({
    id: memberId,
    fleetId,
    title: "patrol",
    targetKind: "persona",
    targetId: preset,
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
    model: MODEL_A,
    fallbackModel: MODEL_B,
  });
  // 引擎表建在 fleet 库里（生产接线同款：createBudgetEngine({ db: getFleetDatabase() })）。
  engine = createBudgetEngine({ db: fleetDb, config: engineConfig, now });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 3.1 engine 单测 ──────────────────────────────────────────────────────────

test("engine: checkBudget allowed on fresh windows, blocks after consume hits the daily cap", () => {
  assert.equal(engine.checkBudget(MODEL_A).allowed, true);
  engine.consumeBudget(MODEL_A, 60_000, { jobId: "j1" });
  assert.equal(engine.checkBudget(MODEL_A).allowed, true, "60k < 100k daily cap");
  engine.consumeBudget(MODEL_A, 50_000, { jobId: "j2" });
  const v = engine.checkBudget(MODEL_A);
  assert.equal(v.allowed, false);
  assert.equal(v.blocked.length, 1);
  assert.equal(v.blocked[0].tier, "daily");
  // 两笔都入账（110k），daily 事件在越限那笔落 log。
  const log = engine.exhaustedLog();
  assert.equal(log.filter((e) => e.model === MODEL_A && e.tier === "daily").length, 1);
  assert.equal(log[0].jobId, "j2");
});

test("engine: lazy daily window roll restores allowance on the next UTC day", () => {
  assert.equal(engine.checkBudget(MODEL_A).allowed, false, "still blocked same day");
  nowMs += 24 * 60 * 60 * 1000; // 次日 10:00Z
  assert.equal(engine.checkBudget(MODEL_A).allowed, true, "next UTC day: daily window rolled");
  const day = utcDayKey(now());
  const row = fleetDb.db.prepare(`SELECT used, window_start AS ws, window_end AS we FROM model_budget WHERE model = ? AND tier = 'daily'`).get(MODEL_A);
  assert.equal(row.used, 0);
  assert.equal(new Date(row.ws).toISOString().slice(0, 10), day);
});

test("engine: monthly window aligns to the first of the next UTC month (Feb never bleeds into Mar)", () => {
  // 引擎此时钟已在 11-06；直接问一个月窗行。
  engine.consumeBudget("mm", 10, { jobId: "jm" });
  const row = fleetDb.db.prepare(`SELECT window_start AS ws, window_end AS we FROM model_budget WHERE model = 'mm' AND tier = 'monthly'`).get();
  assert.equal(new Date(row.ws).toISOString().slice(0, 10), `${utcMonth(now())}-01`);
  // 窗尾=下月 1 号（不是 +30d：二月窗口不得压进三月）。
  const endIso = new Date(row.we).toISOString();
  assert.equal(endIso.slice(0, 7) === utcMonth(now()), false, "end month is NOT the current month");
  assert.equal(endIso.slice(0, 10).endsWith("-01"), true, "end lands on a month boundary");
  // 二月反例：+30d 会给出 03-03，对齐语义给 03-01。
  const savedNow = nowMs;
  nowMs = Date.UTC(2027, 1, 10, 10, 0, 0); // 2027-02-10
  engine.consumeBudget("feb", 10, { jobId: "jf" });
  nowMs = savedNow;
  const febRow = fleetDb.db.prepare(`SELECT window_start AS ws, window_end AS we FROM model_budget WHERE model = 'feb' AND tier = 'monthly'`).get();
  assert.equal(new Date(febRow.ws).toISOString().slice(0, 10), "2027-02-01");
  assert.equal(new Date(febRow.we).toISOString().slice(0, 10), "2027-03-01", "Feb window ends Mar 1, not Mar 3 (+30d)");
});

test("engine: single-tier consume over cap logs an event and flags singleExceeded", () => {
  const r = engine.consumeBudget(MODEL_B, 9_000, { jobId: "js", sessionId: "s1" });
  assert.equal(r.singleExceeded, true, "9000 > 8192 single cap");
  const ev = engine.exhaustedLog().find((e) => e.model === MODEL_B && e.tier === "single");
  assert.ok(ev, "single exceed event in log");
  assert.equal(ev.jobId, "js");
  assert.equal(ev.sessionId, "s1");
  const ok = engine.consumeBudget(MODEL_B, 100, { jobId: "js2" });
  assert.equal(ok.singleExceeded, false);
});

test("engine: attachModelBudgetReset tick rolls daily/monthly on UTC boundary and emits the daily report", () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const att = attachModelBudgetReset({ engine, intervalMs: 60_000, now });
    att.tick(); // same day → no-op
    assert.equal(lines.length, 0);
    nowMs = Date.UTC(2026, 10, 8, 1, 0, 0); // 次日 01:00Z 之后第一 tick
    att.tick();
    console.log = origLog;
    const reportLine = lines.find((l) => l.includes("[model-budget] daily report"));
    assert.ok(reportLine, "daily report line emitted at the day boundary");
    // 再 tick 一次同日 → 不重复出报。
    att.tick();
    assert.equal(lines.filter((l) => l.includes("daily report")).length, 1);
    att.timer.unref?.();
    clearInterval(att.timer);
  } finally {
    console.log = origLog;
  }
});

test("engine: report carries utilization and exhausted stats; disabled engine is a no-op", () => {
  const r = engine.report({ sinceDays: 7 });
  assert.equal(r.enabled, true);
  const a = r.models.find((m) => m.model === MODEL_A && m.tier === "daily");
  assert.ok(a && a.limit === 100_000);
  assert.ok(a.utilization >= 0 && a.utilization <= 1);
  const off = createBudgetEngine({ db: fleetDb, config: { enabled: false, single: 1, daily: 1, monthly: 1 }, now });
  assert.equal(off.checkBudget(MODEL_A).allowed, true, "disabled: always allowed");
  assert.equal(off.consumeBudget(MODEL_A, 999_999).consumed, false, "disabled: consume no-op");
});

test("engine: budgetConfigFromEnv parses env with defaults", () => {
  const c = budgetConfigFromEnv({ MODEL_BUDGET_ENABLED: "1", MODEL_BUDGET_DAILY: "42" });
  assert.equal(c.enabled, true);
  assert.equal(c.daily, 42);
  assert.equal(c.single, 8192);
  assert.equal(c.monthly, 10_000_000);
  assert.equal(budgetConfigFromEnv({}).enabled, false, "default off (opt-in)");
});

function utcMonth(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

// ── 3.2 集成前置检查：fleetModelFor 注记 + walk 跳过 ─────────────────────────

test("fleetModelFor: budgetProbe annotates budgetBlocked; probe absent = no annotation", () => {
  const plan = fleetModelFor(fleetDb, preset, { roster: [MODEL_A, MODEL_B] });
  assert.equal(plan.budgetBlocked, null, "no probe → no annotation");
  const plan2 = fleetModelFor(fleetDb, preset, {
    roster: [MODEL_A, MODEL_B],
    budgetProbe: (model) => (model === MODEL_A ? { allowed: false, blocked: [{ tier: "daily" }] } : { allowed: true, blocked: [] }),
  });
  assert.deepEqual(plan2.budgetBlocked, [{ model: MODEL_A, blocked: [{ tier: "daily" }] }]);
  const plan3 = fleetModelFor(fleetDb, preset, {
    roster: [MODEL_A, MODEL_B],
    budgetProbe: () => {
      throw new Error("engine down");
    },
  });
  assert.equal(plan3.budgetBlocked, null, "probe throw degrades open");
});

// ── 3.3 e2e：连续派发触发日上限 → 自动降级 → 次日恢复 ────────────────────────

// 复用 drift self-heal 的 harness 形状：真 runPersonaTurn + 桩 bridge。
function makeBudgetCtx({ collectorUsage, promptPlan }) {
  const collectors = new Map();
  const switchCalls = [];
  let promptCount = 0;
  const ctx = {
    sessionCollectors: collectors,
    activeTurns: new Map(),
    onRuntimeIdle: () => {},
    isStreaming: false,
    sessionVersion: 1,
    broadcast: () => {},
    session: { model: { id: MODEL_A } },
    dshModels: [
      { id: MODEL_A, provider: "deepseek" },
      { id: MODEL_B, provider: "dashscope" },
    ],
    llmLaneForModel: () => null,
    recordFleetModelNotices: () => {},
    resolveFleetIdentity: null,
    modelBudget: engine,
    resolveFleetModel: async (p) =>
      fleetModelFor(fleetDb, p, {
        roster: [MODEL_A, MODEL_B],
        budgetProbe: (model) => engine.checkBudget(model),
      }),
    switchModelTo: async (model) => {
      switchCalls.push(model);
      return { ok: true };
    },
    dshBridge: {
      isReady: () => true,
      hasLiveMethod: () => true,
      setPreset: async () => {},
      preparedPreset: () => undefined,
      deleteSession: async () => {},
      prompt: async (sessionId) => {
        promptCount += 1;
        const behavior = typeof promptPlan === "function" ? promptPlan(promptCount, switchCalls[switchCalls.length - 1]) : null;
        if (behavior?.fail) throw new Error(behavior.error ?? "upstream boom");
        const collect = collectors.get(sessionId);
        if (collect) {
          collect({
            method: "session.event",
            params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: `turn ${promptCount}` }] }, usage: collectorUsage?.(promptCount) } } },
          });
          collect({ method: "session.status", params: { status: "idle" } });
        }
      },
    },
  };
  return { ctx, switchCalls, collectors };
}

function budgetJob(n) {
  return {
    id: `job_budget_${n}`,
    sessionId: `cron-job_budget_${n}`,
    targetType: "persona",
    preset,
    sourceTag: { fleetId, memberId },
    prompt: "报数",
    executionCarrier: { carrier: "cell" },
    roundSeq: n,
  };
}

test("e2e 3.3: daily cap hit → walk skips the exhausted hop and lands on the chain's next model; next UTC day restores hop 1", async () => {
  // 回合用量 3k（低于 single 8192，不触发结算面降级），daily=100k 用
  // 引擎直注消耗模拟「连续派发烧到超限」。
  const { ctx, switchCalls } = makeBudgetCtx({ collectorUsage: () => ({ input: 3_000, output: 0 }) });
  const startedAt = now();
  const job1 = budgetJob(1);
  const out1 = await runPersonaTurn(ctx, job1, 5_000, new Map(), { startedAt });
  assert.equal(out1.ok, true);
  assert.deepEqual(switchCalls, [MODEL_A], "turn 1 lands on hop 1");
  assert.equal(engine.checkBudget(MODEL_A).allowed, true, "3k far under cap");
  // 直注消耗到 99k（真实派发的累计等效）。
  engine.consumeBudget(MODEL_A, 99_000, { jobId: "burn" });
  assert.equal(engine.checkBudget(MODEL_A).allowed, false, "99k direct + 3k turn = 102k > 100k cap");

  // 第二回合：plan 注记看到 A 超限（99k+3k=102k > 100k）→ 跳过 A 直接落 B。
  const beforeSwitches = switchCalls.length;
  const job2 = budgetJob(2);
  const out2 = await runPersonaTurn(ctx, job2, 5_000, new Map(), { startedAt: now() });
  assert.equal(out2.ok, true);
  assert.deepEqual(switchCalls.slice(beforeSwitches), [MODEL_B], "turn 2 skips the exhausted hop, lands on hop 2");
  // B 也烧到超限（99k 直注 + 3k 回合）。
  engine.consumeBudget(MODEL_B, 99_000, { jobId: "burn-b" });

  // 第三回合：全链超限 → budget_exhausted，不再烧任何模型。
  const beforeAll = switchCalls.length;
  const job3 = budgetJob(3);
  const out3 = await runPersonaTurn(ctx, job3, 5_000, new Map(), { startedAt: now() });
  assert.equal(out3.ok, false);
  assert.match(out3.error, /budget_exhausted/);
  assert.equal(switchCalls.length, beforeAll, "no switch attempted when the whole chain is over budget");
  // 4.3 耗尽即 skip：一个模型都没试就返回，这不是执行失败，是"没轮到它跑"。
  // 记 failed 会污染失败率与重跑面；同时必须带原因，否则 skipped 变成第二个
  // "看不出为什么"的桶。
  assert.equal(out3.skipped, true, "budget exhaustion settles as skipped, not failed");
  assert.equal(out3.budgetExhausted, true, "and carries a machine-readable reason");

  // 次日（UTC 日界翻页）恢复：A/B 窗口滚零 → 第四回合回到 hop 1。
  nowMs = Date.UTC(2026, 10, 9, 10, 0, 0);
  engine.resetDaily();
  assert.equal(engine.checkBudget(MODEL_A).allowed, true, "windows rolled");
  const job4 = budgetJob(4);
  const out4 = await runPersonaTurn(ctx, job4, 5_000, new Map(), { startedAt: now() });
  assert.equal(out4.ok, true);
  assert.deepEqual(switchCalls.slice(-1), [MODEL_A], "next UTC day: hop 1 usable again");
});

test("e2e 3.3b: single-tier over-cap on a successful turn degrades ONE hop at settlement; both attempts consume honestly", async () => {
  nowMs = Date.UTC(2026, 10, 10, 10, 0, 0);
  fleetDb.db.prepare(`UPDATE model_budget SET used = 0`).run(); // 新的一天，全模型清零
  // 第一跳成功但 9k > 8192 single cap → 降级重试跳 B（3k，合规）→ B 落幕。
  const usageByN = (n) => (n === 1 ? { input: 9_000, output: 0 } : { input: 3_000, output: 0 });
  const { ctx, switchCalls } = makeBudgetCtx({ collectorUsage: usageByN });
  const job = budgetJob(6);
  const out = await runPersonaTurn(ctx, job, 5_000, new Map(), { startedAt: now() });
  assert.equal(out.ok, true);
  assert.deepEqual(switchCalls, [MODEL_A, MODEL_B], "single-cap blowout retried exactly one hop down");
  assert.equal(out.detail?.singleBudgetExceeded, true);
  assert.equal(out.usage?.input, 3_000, "settled usage is the surviving attempt's");
  // 记账诚实：A 9k + B 3k 都入日窗（弃掉的半程不藏）。
  const rowA = fleetDb.db.prepare(`SELECT used FROM model_budget WHERE model = ? AND tier = 'daily'`).get(MODEL_A);
  const rowB = fleetDb.db.prepare(`SELECT used FROM model_budget WHERE model = ? AND tier = 'daily'`).get(MODEL_B);
  assert.equal(rowA.used, 9_000);
  assert.equal(rowB.used, 3_000);
  // single 事件逐条可溯。
  const ev = engine.exhaustedLog().find((e) => e.model === MODEL_A && e.tier === "single" && e.jobId === job.id);
  assert.ok(ev, "single over-cap event auditable");
});

test("turnTokens: honest null on unreadable usage, sums all axes, dsh alias shape", () => {
  assert.equal(turnTokens(null), null);
  assert.equal(turnTokens({}), null, "no primary axes → unreadable");
  assert.equal(turnTokens({ input: 100, output: 50, cacheReadTokens: 10, cacheWriteTokens: 5 }), 165);
  assert.equal(turnTokens({ input: 100 }), 100, "missing axes count as 0");
  // dsh TokenUsage 实测形状（dsh-events.js:533）：inputTokens/outputTokens。
  assert.equal(turnTokens({ inputTokens: 9000, outputTokens: 125 }), 9125, "dsh alias shape");
  // normalizeUsage 别名组：snake_case。
  assert.equal(turnTokens({ input_tokens: 40, prompt_tokens: 1 }), 40, "snake alias first-present wins (no double count)");
});
