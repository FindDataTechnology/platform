// Auto-evaluation queue (openspec: owner-inbox 7.1–7.5).
//
// What this pins:
//   • agreement NEVER waits for the evaluation: enqueue returns immediately and
//     the propose response cannot block on a judge call;
//   • a candidate with no scenario is SKIPPED (not burned as a failure) and
//     stays unevaluated — "评测没跑成 ≠ 通过";
//   • the daily budget stops queueing without deleting anything;
//   • the rollback switch (AUTO_EVAL=0) turns the whole thing off;
//   • one failing evaluation does not stop the queue.
//
// Run: node --test scripts/test-eval-queue.mjs

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createEvalQueue, autoEvalEnabled, dailyEvalBudget } from "../server/eval-queue.js";

const saved = { AUTO_EVAL: process.env.AUTO_EVAL, AUTO_EVAL_DAILY_CAP: process.env.AUTO_EVAL_DAILY_CAP };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// A store double: rows keyed by id, with the same status/report transitions the
// real store performs.
function makeStore(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    byId,
    getCandidate: (id) => byId.get(id) ?? null,
    saveEvalReport: (id, report) => {
      const r = byId.get(id);
      if (r) r.evalReport = report;
    },
    // The real stores guard this with `WHERE status = 'candidate'` — a ruling
    // that landed while the evaluation ran must not be overwritten by it. The
    // double models that guard rather than relying on call order.
    markEvaluated: (id) => {
      const r = byId.get(id);
      if (r && r.status === "candidate") r.status = "evaluated";
    },
    markUnevaluated: (id, reason) => {
      const r = byId.get(id);
      if (r) {
        if (r.status === "candidate") r.status = "candidate";
        r.evalReport = { error: "evaluation failed", reason };
      }
    },
  };
}

const withScenario = (id, extra = {}) => ({
  id,
  status: "candidate",
  evalReport: null,
  supersedes: null,
  evidence: { source: "turn-1", solved: "x", scenario: "do the thing" },
  ...extra,
});

test("enqueue returns before the evaluation runs; drain() observes the outcome", async () => {
  process.env.AUTO_EVAL = "1";
  const store = makeStore([withScenario("c1")]);
  let resolveEval;
  const q = createEvalQueue({
    store,
    runEval: () => new Promise((res) => { resolveEval = res; }),
    log: () => {},
  });
  const out = q.enqueueSkill(store.getCandidate("c1"));
  assert.equal(out.queued, true);
  // The queue runs on a microtask, so the harness has not been entered yet
  // when enqueue returns — that alone proves propose never waits on it.
  await Promise.resolve();
  // Still in flight: nothing has been written yet.
  assert.equal(store.getCandidate("c1").status, "candidate");
  resolveEval({ passed: true, reason: "candidate arm wins" });
  await q.drain();
  assert.equal(store.getCandidate("c1").status, "evaluated");
  assert.equal(store.getCandidate("c1").evalReport.passed, true);
});

test("a candidate with no scenario is skipped, stays unevaluated, and burns no budget", async () => {
  process.env.AUTO_EVAL = "1";
  const store = makeStore([{ ...withScenario("n1"), evidence: { source: "turn-1" } }]);
  let called = 0;
  const q = createEvalQueue({ store, runEval: async () => {
      called += 1;
      return { passed: true };
    }, log: () => {} });
  const before = q.budgetLeft();
  q.enqueueSkill(store.getCandidate("n1"));
  await q.drain();
  assert.equal(called, 0, "no judge call for a scene-less candidate");
  assert.equal(store.getCandidate("n1").status, "candidate", "stays a candidate");
  assert.equal(q.budgetLeft(), before, "skip does not consume budget");
});

test("budget exhaustion refuses to queue and deletes nothing", async () => {
  process.env.AUTO_EVAL = "1";
  process.env.AUTO_EVAL_DAILY_CAP = "1";
  assert.equal(dailyEvalBudget(), 1);
  const store = makeStore([withScenario("b1"), withScenario("b2")]);
  let calls = 0;
  const q = createEvalQueue({ store, runEval: async () => {
      calls += 1;
      return { passed: true };
    }, log: () => {} });
  assert.equal(q.enqueueSkill(store.getCandidate("b1")).queued, true);
  await q.drain();
  const second = q.enqueueSkill(store.getCandidate("b2"));
  assert.equal(second.queued, false);
  assert.match(second.reason, /budget/);
  await q.drain();
  assert.equal(calls, 1, "the over-budget candidate was never evaluated");
  assert.ok(store.getCandidate("b2"), "and it was not deleted");
  assert.equal(store.getCandidate("b2").status, "candidate");
});

test("AUTO_EVAL=0 disables queueing entirely (rollback switch)", () => {
  process.env.AUTO_EVAL = "0";
  assert.equal(autoEvalEnabled(), false);
  const store = makeStore([withScenario("d1")]);
  const q = createEvalQueue({ store, runEval: async () => ({ passed: true }), log: () => {} });
  const out = q.enqueueSkill(store.getCandidate("d1"));
  assert.equal(out.queued, false);
  assert.match(out.reason, /disabled/);
});

test("a failing evaluation is recorded honestly and does not stop the queue", async () => {
  process.env.AUTO_EVAL = "1";
  const store = makeStore([withScenario("e1"), withScenario("e2")]);
  let n = 0;
  const q = createEvalQueue({
    store,
    runEval: async () => {
      n += 1;
      if (n === 1) throw new Error("judge lane unreachable");
      return { passed: true, reason: "ok" };
    },
    log: () => {},
  });
  q.enqueueSkill(store.getCandidate("e1"));
  q.enqueueSkill(store.getCandidate("e2"));
  await q.drain();
  assert.match(String(store.getCandidate("e1").evalReport?.reason), /judge lane unreachable/);
  assert.equal(store.getCandidate("e1").status, "candidate", "an interrupted evaluation is never a pass");
  assert.equal(store.getCandidate("e2").status, "evaluated", "the next candidate still ran");
});

test("a candidate decided while queued is skipped, not resurrected", async () => {
  process.env.AUTO_EVAL = "1";
  const store = makeStore([withScenario("f1")]);
  let resolveFirst;
  const q = createEvalQueue({
    store,
    runEval: () => new Promise((res) => { resolveFirst = res; }),
    log: () => {},
  });
  q.enqueueSkill(store.getCandidate("f1"));
  await Promise.resolve();
  // The owner rejects it before the evaluation completes.
  store.getCandidate("f1").status = "rejected";
  resolveFirst({ passed: true });
  await q.drain();
  assert.equal(store.getCandidate("f1").status, "rejected", "a rejection is not overwritten by a late evaluation");
  // ...and the same holds for the report itself: it is recorded but the row's
  // terminal state stands (the store's WHERE guard, modelled above).
});
