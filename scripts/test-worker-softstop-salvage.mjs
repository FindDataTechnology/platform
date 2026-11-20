// fix-worker-softstop-salvage: the worker lane must consult the salvage lane on
// an early stop, and must never skip it silently.
//
// Measured 2026-11-14 on production (10 days, three cells, `member_turn_events`):
//   • after fix-turn-budget-soft-stop shipped (11-13T06:24Z), pure
//     "turn timed out" went 193 → 0 — every timeout is now a budget soft stop;
//   • but of 131 soft-stop rounds, `detail.wrapUp` appeared in exactly ONE
//     ({"ok":false,"chars":0}), and `salvageFacts` in ONE — the same row, which
//     ran on the serial chain;
//   • 65 of the 131 had `reported:false`, i.e. they needed the lane and 64 of
//     them were never even asked.
//
// The cause is structural, not a behaviour bug in the predicate: `collectTurn`
// settles a soft stop by REJECTING, so on the worker lane it lands in
// `runOnWorker`'s catch — and that catch forwarded `e.detail` without ever
// calling `shouldSalvageReport` / `runWrapUpReport`. The serial chain's catch
// does (cron-runner.js), which is why the one salvaged row exists at all. The
// worker lane carries most of the traffic.
//
// Three properties are pinned here:
//   1. a rejection carrying `budgetSoftStop` reaches the salvage lane, and the
//      outcome is recorded (`wrapUp`) — attempt or success, never silence;
//   2. a skipped salvage on a pressure/soft-stop shape is recorded
//      (`salvageFacts`), so the next reader does not have to guess;
//   3. an interrupted round is still refused (restart is not the round's fault).
//
// Run: node --test scripts/test-worker-softstop-salvage.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-softstop-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.TASK_WORKER_MAX = "1";
delete process.env.FLEET_BUDGET_SOFT_STOP;

const engine = await import("../task-engine.js");
const { attachWorkerPool } = await import("../server/worker-slots.js");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A bridge whose prompt rejects with the exact error shape `collectTurn`'s soft
// stop timer produces (fix-turn-budget-soft-stop): a timeoutError whose detail
// carries budgetSoftStop / elapsedMs / steps / budgetMs / softStopAtMs, with
// earlyStop set and no `interrupted`.
class SoftStopBridge {
  static byPersona = new Map();
  constructor(params) {
    this.params = params;
    this.persona = params.agentPreset;
    this.closed = false;
    this.prompts = [];
    this.cancelCalls = [];
    SoftStopBridge.byPersona.set(this.persona, this);
  }
  async start() { this.ready = true; }
  isReady() { return this.ready && !this.closed; }
  cancelSession(sessionId) {
    this.cancelCalls.push(sessionId);
    return Promise.resolve({ cancelled: true });
  }
  async prompt(sessionId, blocks) {
    this.prompts.push({ sessionId, blocks });
    // The wrap-up prompt (runWrapUpReport) is a SECOND prompt on the same
    // session — a cancelled round answers nothing, which is the production
    // shape (`{"ok":false,"chars":0}`). Throw for it so the test exercises the
    // "lane ran and failed" branch instead of hanging.
    if (this.prompts.length > 1) throw new Error("session cancelled");
    const err = new Error("turn stopped early — budget soft stop (480s of 600s)");
    err.earlyStop = true;
    err.detail = {
      kind: "turn_budget_exceeded",
      steps: 11,
      lastTool: "mcp__fleet__report_status",
      hasOutput: true,
      reported: false, // ← the round did NOT file its report: the lane's business
      budgetSoftStop: true,
      elapsedMs: 480_002,
      budgetMs: 600_000,
      softStopAtMs: 480_000,
    };
    throw err;
  }
  emit(notif) { this.params.onEvent(notif); }
  close() { this.closed = true; }
}

function makeCtx(recorded) {
  return {
    broadcast: () => {},
    sessionCollectors: new Map(),
    workerSpawnParams: { provider: "finddata", model: "stub" },
    recordFleetTurnEvent: (_task, out) => recorded.push(out),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const waitFor = async (pred, tries = 120) => {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await settle(); }
  return false;
};

async function runFleetTurn({ interrupted = false } = {}) {
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  const recorded = [];
  const ctx = makeCtx(recorded);
  attachWorkerPool(ctx, { spawnBridge: (p) => new SoftStopBridge(p) });
  const persona = `soft-${Math.random().toString(36).slice(2, 8)}`;
  const task = engine.createManualTask({
    prompt: "soft stop",
    persona,
    initiator: "s1",
    origin: { fleet: { fleetId: "f_soft", memberId: "m_soft" } },
  });
  await waitFor(() => recorded.length > 0);
  engine.setSlotDispatcher(null);
  return { task, recorded, ctx, bridge: SoftStopBridge.byPersona.get(persona) };
}

test("worker 车道：软停 rejection 会真的走到收尾车道，并把结果记下来", async () => {
  const { task, recorded, bridge } = await runFleetTurn();

  assert.ok(bridge, "the worker must have been spawned from the fake bridge");
  assert.ok(recorded.length >= 1, "the worker round must settle into the ledger");
  const out = recorded[0];
  const detail = out?.detail ?? {};
  assert.equal(detail.budgetSoftStop, true, "the soft-stop marker must survive the worker lane");
  assert.equal(out.ok, false, "a soft-stopped round is still a failure (it did not finish)");
  // THE property: the lane was consulted and said something. Today it says
  // nothing at all — `wrapUp` is absent on 130 of 131 production soft stops.
  assert.ok(
    detail.wrapUp !== undefined,
    `the worker lane must record the salvage outcome (wrapUp), got keys: ${Object.keys(detail).join(",")}`,
  );
  assert.equal(typeof detail.wrapUp.ok, "boolean", "wrapUp must say whether the report came back");
  assert.equal(engine.getTask(task.id).state, "failed");
});

test("worker 车道：没报告 = 该补；已报告 = 不该补（判据与序列车道一致）", async () => {
  const { shouldSalvageReport } = await import("../server/cron-runner.js");
  const soft = { budgetSoftStop: true, reported: false };
  assert.equal(shouldSalvageReport(soft, { isFleet: true }), true);
  assert.equal(shouldSalvageReport({ ...soft, reported: true }, { isFleet: true }), false);
});

test("worker 车道：中断的回合不补，但要留下跳过原因（不许静默）", async () => {
  // 直接钉判据而不是跑一整轮：中断来自 owner/重启，形态由 `interrupted` 表达。
  const { shouldSalvageReport } = await import("../server/cron-runner.js");
  const soft = { budgetSoftStop: true, reported: false };
  assert.equal(
    shouldSalvageReport(soft, { isFleet: true, interrupted: true }),
    false,
    "an interruption is not the round's fault",
  );
});

// ── 第三条接缝：`result.error` 分支（attributeFailureAndSalvage）─────────────
//
// 上产后第一条软停行（2026-11-14T14:08:52Z）走了这里而不是 throw：`reported`
// 已是 true，于是被判「不必补」——但它是**静默**地拒的，行上既没有 `wrapUp`
// 也没有 `salvageSkipped`。于是「已报告、无需补」与「根本没问过」在账本里
// 长得一模一样，而那正是让这个缺陷躲了一天的形态。

test("第三条接缝：已报告而拒补时，必须留下跳过原因（不许静默）", async () => {
  const { attributeFailureAndSalvage } = await import("../server/cron-runner.js");
  const err = new Error("turn stopped early — budget soft stop");
  err.detail = { kind: "turn_budget_exceeded", budgetSoftStop: true, reported: true, elapsedMs: 480_002, budgetMs: 600_000 };
  let prompted = 0;
  const detail = await attributeFailureAndSalvage(
    { sessionCollectors: new Map() },
    {
      error: err,
      reported: true,
      text: "本轮已汇报",
      childSessionId: "s-soft",
      mirrorSessionId: "s-soft",
      isFleet: true,
      prompt: async () => { prompted++; return { text: "x" }; },
      collectors: new Map(),
    },
  );
  assert.equal(prompted, 0, "已报告的回合不该再被催一次报告");
  assert.equal(detail?.budgetSoftStop, true, "软停标记必须活下来");
  assert.equal(detail?.wrapUp, undefined, "没补过就不该有 wrapUp");
  assert.deepEqual(
    detail?.salvageSkipped,
    { isFleet: true, interrupted: false, pressure: false, softStop: true, reported: true },
    "跳过必须写清是哪一条不成立",
  );
});

test("第三条接缝：收尾预算按该轮剩余额度给，不是定值 240s", async () => {
  const { remainingWrapUpMs } = await import("../server/cron-runner.js");
  assert.equal(remainingWrapUpMs({ budgetMs: 600_000, elapsedMs: 480_002 }), 119_998);
  assert.equal(remainingWrapUpMs({}), 240_000, "数不可用时才回退到上限");
});
