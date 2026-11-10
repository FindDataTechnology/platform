// Model-budget visibility (fix-fleet-failure-visibility D6, explore P0′-2).
//
// 2026-11-08: 441 fleet turns failed in one day with
// `budget_exhausted: all candidate models over daily/monthly budget` — and the
// read face could not tell it apart from ordinary provider wobble, because that
// text contains "model" and classified as `model_upstream`. Nobody noticed the
// deployment was out of quota until the failure count was read by hand.
//
// Three things are pinned here: the classification (budget ahead of upstream),
// the fleet-level aggregate (several posts failing = the deployment, not a
// post), and the streak attribution that lands on a post card.
//
// Run: node --test scripts/test-fleet-budget-visibility.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "budget-visibility-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const { classifyErrorKind, ERROR_KINDS, shapeTurnOutcome } = await import("../server/fleet-events.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("分类：额度耗尽优先于上游抖动", () => {
  const live = "budget_exhausted: all candidate models over daily/monthly budget (model 'deepseek-v3' skipped: budget_exhausted (daily+monthly))";
  assert.equal(classifyErrorKind(live), "budget", "the production string must not read as a provider problem");
  assert.equal(classifyErrorKind("额度已用尽"), "budget");
  assert.equal(classifyErrorKind("模型额度打满"), "budget");
  // The bucket it used to fall into still exists for genuine provider issues.
  assert.equal(classifyErrorKind("no runnable model for this post (model switch failed)"), "model_upstream");
  assert.equal(classifyErrorKind("503 service temporarily unavailable"), "model_upstream");
  assert.equal(classifyErrorKind("turn timed out"), "timeout");
  assert.ok(ERROR_KINDS.includes("budget"), "the kind is part of the published vocabulary");
});

test("回合事件：额度失败以 errorKind=budget 落行", () => {
  const shaped = shapeTurnOutcome({
    ok: false,
    error: "budget_exhausted: all candidate models over daily/monthly budget (model 'm' skipped: budget_exhausted (daily))",
  });
  assert.equal(shaped.status, "failed");
  assert.equal(shaped.errorKind, "budget");
});

function fixtureDb() {
  const db = createFleetDatabase({ file: path.join(tmpRoot, `b_${Math.random().toString(36).slice(2, 7)}.db`) });
  const fleet = db.createFleet({ id: "f_budget", name: "额度舰", ownerEmail: "owner@test" });
  const mk = (id, title) => db.createMember({ id, fleetId: fleet.id, title, targetKind: "persona", targetId: `p-${id}`, parentId: null, kpiSlots: [], cadence: null });
  mk("m1", "甲");
  mk("m2", "乙");
  mk("m3", "丙");
  const turn = (memberId, { kind, status = "failed", at = Date.now() } = {}) =>
    db.appendTurnEvent({ fleetId: fleet.id, memberId, source: "cron", status, errorKind: kind ?? null, error: kind === "budget" ? "budget_exhausted" : null, startedAt: at, endedAt: at + 1000 });
  return { db, fleet, turn };
}

test("舰队聚合：多岗额度失败 → 报出人数/次数/最早时间；单岗不算压力面", () => {
  const { db, fleet, turn } = fixtureDb();
  assert.equal(db.budgetPressure(fleet.id), null, "nothing failed on budget → no aggregate");

  const t0 = Date.now() - 3600_000;
  turn("m1", { kind: "budget", at: t0 });
  turn("m1", { kind: "budget", at: t0 + 60_000 });
  const single = db.budgetPressure(fleet.id);
  assert.equal(single.members, 1);
  assert.equal(single.failures, 2);
  assert.equal(single.since, t0, "the oldest still in the window");

  turn("m2", { kind: "budget", at: t0 + 120_000 });
  turn("m3", { kind: "timeout", at: t0 + 180_000 });
  const multi = db.budgetPressure(fleet.id);
  assert.equal(multi.members, 2, "a timeout is not budget pressure");
  assert.equal(multi.failures, 3);
  assert.equal(multi.windowHours, 24);

  // Outside the window → gone (an old outage is not today's banner).
  const later = db.budgetPressure(fleet.id, { windowMs: 60_000, now: t0 + 3_600_000 });
  assert.equal(later, null);
  db.close();
});

test("岗位连败归因带上 budget（卡面读的就是这个字段）", () => {
  const { db, turn } = fixtureDb();
  turn("m1", { kind: "budget" });
  turn("m1", { kind: "budget" });
  const streak = db.failureStreak("m1");
  assert.equal(streak.streak, 2);
  assert.equal(streak.lastErrorKind, "budget", "the post card can say WHY, not just a number");
  db.close();
});
