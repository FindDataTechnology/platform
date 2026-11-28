// Unit tests for fleet turn result events (add-fleet-turn-events).
//
// Covers the chain the spec pins:
//   - member_turn_events storage: append / timeline paging (beforeId cursor)
//     / fleet-wide status+source filter / latest / consecutive-failures
//     aggregation (walks back to the first non-failure, success resets)
//   - rolling prune per member (FLEET_TURN_EVENTS_KEEP), reports untouched
//   - classifyErrorKind: ordered table, one probe per kind, other floor
//   - recordTurnEvent attribution chain: sourceTag (cron) → origin.fleet
//     (execute-now manual) → persona scan (delegation wake / plain manual),
//     ghost posts excluded, non-fleet turns silently skip
//   - source derivation: cron / manual / delegation
//   - the runCronJobTurn seam: three target kinds each record one event,
//     a throwing recorder never fails the turn (degrade open)
//   - routes: member timeline + fleet filter, invalid values 400
//   - cockpit face: memberView lastTurn/consecutiveFailures, health.failing,
//     presence derivation untouched
//
// Run: node --test scripts/test-fleet-turn-events.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-turn-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const cron = await import("../cron.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { classifyErrorKind, turnSourceFor, recordTurnEvent, ERROR_KINDS } = await import("../server/fleet-events.js");
const { attachCronRunner, awaitRuntimeReadyForJob } = await import("../server/cron-runner.js");

await initDb();
await chatHistory.initChatHistory();

// Minimal engine boot so cron.addJob materializes (the scheduler never fires —
// the fixture cadence is Jan 1st, 3am).
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true, text: "ok" }),
  isBusy: () => false,
});

// ── fixtures ────────────────────────────────────────────────────────────────

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fixtureFleet(db, name = "一号舰队") {
  return db.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail: "owner@test" });
}

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "电商部",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence !== undefined ? over.cadence : { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
  });
}

function fixtureEvent(db, member, over = {}) {
  return db.appendTurnEvent({
    fleetId: member.fleetId,
    memberId: member.id,
    source: over.source ?? "cron",
    status: over.status ?? "ok",
    errorKind: over.errorKind ?? null,
    error: over.error ?? null,
    model: over.model ?? null,
    startedAt: over.startedAt ?? Date.now() - 60_000,
    endedAt: over.endedAt ?? Date.now(),
    sessionId: over.sessionId ?? null,
  });
}

// ── 1. storage ──────────────────────────────────────────────────────────────

test("member_turn_events: append, latest, timeline cursor, fleet filter", () => {
  const fleet = fixtureFleet(fleetDb);
  const m1 = fixtureMember(fleetDb, fleet.id, { id: "m_one" });
  const m2 = fixtureMember(fleetDb, fleet.id, { id: "m_two", targetId: "persona-b" });

  fixtureEvent(fleetDb, m1, { status: "failed", errorKind: "timeout", error: "execution timed out" });
  fixtureEvent(fleetDb, m1, { source: "manual", status: "ok" });
  fixtureEvent(fleetDb, m2, { source: "delegation", status: "failed", errorKind: "other", error: "boom" });

  const latest = fleetDb.latestTurnFor("m_one");
  assert.equal(latest.status, "ok");
  assert.equal(latest.source, "manual");
  assert.equal(latest.sessionId, null);

  const page1 = fleetDb.listTurnEvents("m_one", { limit: 1 });
  assert.equal(page1.length, 1);
  assert.equal(page1[0].status, "ok", "newest first");
  const page2 = fleetDb.listTurnEvents("m_one", { beforeId: page1[0].id, limit: 10 });
  assert.equal(page2.length, 1);
  assert.equal(page2[0].status, "failed");
  assert.equal(page2[0].errorKind, "timeout");

  const failed = fleetDb.listFleetTurnEvents(fleet.id, { status: "failed" });
  assert.equal(failed.length, 2);
  assert.deepEqual(
    fleetDb.listFleetTurnEvents(fleet.id, { status: "failed", source: "cron" }).map((e) => e.memberId),
    ["m_one"],
  );
});

test("consecutiveFailures: walks back, ok resets, absent member reads 0", () => {
  const fleet = fixtureFleet(fleetDb);
  const m = fixtureMember(fleetDb, fleet.id, { id: "m_run" });

  assert.equal(fleetDb.consecutiveFailures("m_run"), 0, "no events yet");

  fixtureEvent(fleetDb, m, { status: "ok" });
  fixtureEvent(fleetDb, m, { status: "failed", error: "a" });
  fixtureEvent(fleetDb, m, { status: "failed", error: "b" });
  fixtureEvent(fleetDb, m, { status: "failed", error: "c" });
  assert.equal(fleetDb.consecutiveFailures("m_run"), 3);

  fixtureEvent(fleetDb, m, { status: "ok" });
  assert.equal(fleetDb.consecutiveFailures("m_run"), 0, "success resets the run");

  fixtureEvent(fleetDb, m, { status: "interrupted", error: "restart" });
  assert.equal(fleetDb.consecutiveFailures("m_run"), 0, "interrupted is not a failure");
});

test("rolling prune: keeps newest N per member, reports untouched", () => {
  const prevKeep = process.env.FLEET_TURN_EVENTS_KEEP;
  process.env.FLEET_TURN_EVENTS_KEEP = "3";
  try {
    const fleet = fixtureFleet(fleetDb);
    const m = fixtureMember(fleetDb, fleet.id, { id: "m_prune" });
    for (let i = 0; i < 5; i++) {
      fixtureEvent(fleetDb, m, { status: "ok", endedAt: 1000 + i });
    }
    assert.equal(fleetDb.listTurnEvents("m_prune", { limit: 50 }).length, 3, "oldest pruned, newest kept");
    assert.equal(fleetDb.latestTurnFor("m_prune").endedAt, 1004);
  } finally {
    if (prevKeep === undefined) delete process.env.FLEET_TURN_EVENTS_KEEP;
    else process.env.FLEET_TURN_EVENTS_KEEP = prevKeep;
  }
});

// ── 2. classifier ───────────────────────────────────────────────────────────

test("classifyErrorKind: ordered table, one probe per kind, other floor", () => {
  assert.ok(ERROR_KINDS.includes("other"));
  assert.equal(classifyErrorKind("execution timed out after 10 minutes"), "timeout");
  // Early stop is the same termination, spelled differently: cron-runner
  // rewrites timeoutError's message to "turn stopped early — context pressure
  // (N compactions)". Unaliased it fell to `other` — measured 2026-11-11 over
  // 24h, 82 of 170 real failures (43%, the single largest class) were early
  // stops recorded as unclassified while their "timed out" siblings were fine.
  assert.equal(classifyErrorKind("turn stopped early — context pressure (4 compactions)"), "timeout");
  // ...but an early stop caused by OVERFLOW is a fit problem, not a time
  // problem: it goes to context_budget so triage stops trying another model
  // against the same wall. This reverses the first cut of this very test
  // (2026-11-11, same day): both spellings were timeout, then the taxonomy
  // decision split them — pressure ⇒ timeout, overflow ⇒ context_budget,
  // matching each row's own detail.kind (turn_budget_exceeded / context_overflow).
  assert.equal(classifyErrorKind("turn stopped early — context overflow (163631/128000 input tokens)"), "context_budget");
  assert.equal(classifyErrorKind('pi-ai detected context overflow for model "deepseek-v4.1-flash"'), "context_budget");
  assert.equal(classifyErrorKind("context_length_exceeded"), "context_budget");
  // A budget-exhausted message names models too; it must stay `budget`, not
  // be swallowed by the new context pattern or by model_upstream.
  assert.equal(classifyErrorKind("budget_exhausted: all candidate models over daily/monthly budget (model 'x' skipped: budget_exhausted (daily))"), "budget");
  assert.equal(classifyErrorKind("could not switch the agent for the scheduled task"), "runtime_not_ready");
  assert.equal(classifyErrorKind("tool call denied: not authorized"), "tool_permission");
  assert.equal(classifyErrorKind("no runnable model for this post"), "model_upstream");
  assert.equal(classifyErrorKind("429 quota exceeded at provider"), "model_upstream");
  // Calibration first case from prod (§15.17 待办①): upstream 503 / api_error
  assert.equal(classifyErrorKind('503: {"message":"Service temporarily unavailable","type":"api_error"}'), "model_upstream");
  // Lane HTTP echoes are model-lane failures, never tool problems (production
  // 2026-10-25: sub2api's "403 status code (no body)" — SUBSCRIPTION_NOT_FOUND
  // underneath — was misfiled as tool_permission).
  assert.equal(classifyErrorKind("403 status code (no body)"), "model_upstream");
  assert.equal(classifyErrorKind("502 status code (no body)"), "model_upstream");
  // A genuine tool refusal still wins even when the status digit rides along.
  assert.equal(classifyErrorKind("report failed (403): permission denied"), "tool_permission");
  assert.equal(classifyErrorKind("该操作被业务拒绝执行"), "business_refused");
  assert.equal(classifyErrorKind(" совершенно неизвестная ошибка "), "other");
  assert.equal(classifyErrorKind(""), "other");
  assert.equal(classifyErrorKind(null), "other");
  // Order: a readiness-flavored timeout reads runtime_not_ready first.
  assert.equal(classifyErrorKind("runtime stayed busy then timed out"), "runtime_not_ready");
});

// ── 3. recordTurnEvent attribution + source ────────────────────────────────

test("recordTurnEvent: sourceTag wins (cron), origin.fleet reads manual, persona scan reads delegation", () => {
  const fleet = fixtureFleet(fleetDb);
  const mCron = fixtureMember(fleetDb, fleet.id, { id: "m_cron", targetId: "persona-cron" });
  const mPassive = fixtureMember(fleetDb, fleet.id, {
    id: "m_passive",
    targetId: "persona-passive",
    cadence: null,
  });

  const cron = recordTurnEvent(fleetDb, { id: "t1", sourceTag: { fleetId: fleet.id, memberId: mCron.id }, sessionId: "task-t1" },
    { ok: false, error: "execution timed out" }, { startedAt: 1, endedAt: 2, model: "glm-5" });
  assert.equal(cron.source, "cron");
  assert.equal(cron.status, "failed");
  assert.equal(cron.errorKind, "timeout");
  assert.equal(cron.model, "glm-5");
  assert.equal(cron.sessionId, "task-t1");

  const execNow = recordTurnEvent(fleetDb,
    { id: "t2", origin: { fleet: { fleetId: fleet.id, memberId: mPassive.id } }, sessionId: "task-t2" },
    { ok: true }, { startedAt: 3, endedAt: 4 });
  assert.equal(execNow.source, "manual");
  assert.equal(execNow.status, "ok");

  const delegation = recordTurnEvent(fleetDb,
    { id: "t3", preset: "persona-passive", initiator: "sess-9", sessionId: "task-t3" },
    { ok: true, usage: { model: "glm-4.7" } }, { startedAt: 5, endedAt: 6 });
  assert.equal(delegation.source, "delegation", "initiator ⇒ delegation wake");
  assert.equal(delegation.memberId, "m_passive", "persona scan attributes the on-duty post");
  assert.equal(delegation.model, "glm-4.7");

  const plain = recordTurnEvent(fleetDb, { id: "t4", preset: "persona-passive" }, { ok: true }, { startedAt: 7, endedAt: 8 });
  assert.equal(plain.source, "manual", "no initiator ⇒ plain manual lane");
});

test("recordTurnEvent: non-fleet turns and ghost posts skip silently", () => {
  const fleet = fixtureFleet(fleetDb);
  const _m = fixtureMember(fleetDb, fleet.id, { id: "m_live", targetId: "persona-live" });

  assert.equal(recordTurnEvent(fleetDb, { id: "x1", preset: "stranger" }, { ok: true }, { startedAt: 1, endedAt: 2 }), null);
  assert.equal(recordTurnEvent(fleetDb, { id: "x2" }, { ok: true }, { startedAt: 1, endedAt: 2 }), null);
  assert.equal(fleetDb.listTurnEvents("m_live", { limit: 10 }).length, 0);

  // Archived (ghost) fleets release their posts: attribution must not hit.
  fleetDb.updateFleet(fleet.id, { state: "archived" });
  assert.equal(recordTurnEvent(fleetDb, { id: "x3", preset: "persona-live" }, { ok: true }, { startedAt: 1, endedAt: 2 }), null);
});

test("turnSourceFor: three lanes + cluster execute-now riding the cron task", () => {
  assert.equal(turnSourceFor({ sourceTag: { fleetId: "f", memberId: "m" } }), "cron");
  assert.equal(turnSourceFor({ origin: { fleet: { fleetId: "f", memberId: "m" } } }), "manual");
  assert.equal(turnSourceFor({ initiator: "s" }), "delegation");
  assert.equal(turnSourceFor({}), "manual");
});

// ── 4. runCronJobTurn seam ──────────────────────────────────────────────────

test("runCronJobTurn seam: three target kinds record one event each; recorder failure degrades open", async () => {
  const fleet = fixtureFleet(fleetDb);
  const mP = fixtureMember(fleetDb, fleet.id, { id: "m_p", targetId: "persona-p" });
  const mA = fixtureMember(fleetDb, fleet.id, { id: "m_a", targetKind: "a2a", targetId: "agent-x" });
  const mC = fixtureMember(fleetDb, fleet.id, { id: "m_c", targetKind: "cluster", targetId: "cluster-x" });

  const recorded = [];
  const ctx = {
    recordFleetTurnEvent: (job, out, meta) => {
      recorded.push({ job, out, meta });
      return {};
    },
    session: { model: { id: "boot-model" } },
    taskTurnRegistry: new Map(),
    // fix-fleet-turn-veracity D1 pre-gate: this fake represents an UP runtime
    // — without a ready bridge the persona pre-check waits out its full 120s
    // budget and skips the round instead of recording it.
    dshBridge: { isReady: () => true },
  };
  attachCronRunner(ctx, {
    runPersona: async () => ({ ok: true, usage: null, text: "done" }),
    runA2a: async () => ({ ok: false, error: "upstream provider 5xx" }),
    listAgents: () => [],
  });

  await ctx.runCronJobTurn({ id: "j1", targetType: "persona", preset: "persona-p", sourceTag: { fleetId: fleet.id, memberId: mP.id }, sessionId: "s1" });
  await ctx.runCronJobTurn({ id: "j2", targetType: "a2a", preset: "agent-x", sourceTag: { fleetId: fleet.id, memberId: mA.id } });
  await ctx.runCronJobTurn({ id: "j3", targetType: "cluster", preset: "cluster-x", sourceTag: { fleetId: fleet.id, memberId: mC.id } });

  assert.equal(recorded.length, 3);
  assert.equal(recorded[0].out.ok, true);
  assert.equal(recorded[0].meta.model, "boot-model", "persona model falls back to the runtime's landed model");
  assert.equal(recorded[1].out.ok, false);
  assert.ok(Number.isFinite(recorded[2].meta.startedAt) && recorded[2].meta.endedAt >= recorded[2].meta.startedAt);

  // Degrade open: a throwing recorder must not fail the turn.
  const boom = { recordFleetTurnEvent: () => { throw new Error("db gone"); }, taskTurnRegistry: new Map() };
  attachCronRunner(boom, {
    runPersona: async () => ({ ok: true }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });
  const r = await boom.runCronJobTurn({ id: "j4", targetType: "persona", preset: "x" });
  assert.equal(r.ok, true, "turn result passes through untouched");
});

// ── 4b. cold-cell runtime readiness for fleet rounds ───────────────────────

test("fleet round waits for a cold runtime instead of failing runtime_not_ready", async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 30);
  const out = await awaitRuntimeReadyForJob(
    { dshBridge: { isReady: () => ready } },
    { sourceTag: { fleetId: "f1", memberId: "m1" } },
    { waitMs: 3_000, pollMs: 10 },
  );
  assert.equal(out.ok, true, "fleet round survives a cold cell instead of being lost");
});

test("fleet round gives up after the wait budget and names the wait", async () => {
  const out = await awaitRuntimeReadyForJob(
    { dshBridge: { isReady: () => false } },
    { sourceTag: { fleetId: "f1", memberId: "m1" } },
    { waitMs: 60, pollMs: 10 },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /waited for fleet round/);
});

test("non-fleet cron keeps the byte-identical immediate refusal", async () => {
  let ticked = 0;
  const out = await awaitRuntimeReadyForJob(
    { dshBridge: { isReady: () => false } },
    { id: "plain-job" },
    { waitMs: 5_000, pollMs: 10, now: () => { ticked += 1; return ticked * 1000; } },
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "the agent runtime is not ready", "no waiting was added for ordinary cron");
  assert.equal(ticked, 0, "the refusal short-circuits before any poll");
});

test("a restarting child does not burn the wait budget (credential-change window)", async () => {
  // 2026-11-08 live: a credential change restarted the dsh child; the queued
  // fleet round polled isReady() for the full 120s against a restarting
  // runtime, timed out, and the round was recorded `skipped` — lost.
  // The contract: a restart adds (up to) one more budget window, so a child
  // that comes up shortly after the restart finishes still gets its round.
  let ready = false;
  let restarting = true;
  setTimeout(() => { restarting = false; }, 40);
  setTimeout(() => { ready = true; }, 130);
  const out = await awaitRuntimeReadyForJob(
    { dshBridge: { isReady: () => ready, isRestarting: () => restarting } },
    { sourceTag: { fleetId: "f1", memberId: "m1" } },
    { waitMs: 100, pollMs: 10 },
  );
  assert.equal(out.ok, true, "the wait must cover the restart, not race it");
});

test("a readiness timeout is reported as retryable so the round can come back", async () => {
  const out = await awaitRuntimeReadyForJob(
    { dshBridge: { isReady: () => false, isRestarting: () => false } },
    { sourceTag: { fleetId: "f1", memberId: "m1" } },
    { waitMs: 40, pollMs: 10 },
  );
  assert.equal(out.ok, false);
  assert.equal(out.retryable, true, "a fleet round blocked by readiness is retryable, not doomed");
});

test("exhausted readiness ladder still records the honest skip (no silent loss)", async () => {
  // The ladder must not turn a permanently-dead runtime into an infinite retry
  // loop: once the delays are spent, the outcome is today's `skipped`.
  // FLEET_TURN_READY_WAIT_MS keeps the four passes cheap — the real budget is
  // 120s per attempt and this test would otherwise run for eight minutes.
  const prevWait = process.env.FLEET_TURN_READY_WAIT_MS;
  process.env.FLEET_TURN_READY_WAIT_MS = "20";
  try {
    const calls = [];
    const boom = {
      dshBridge: { isReady: () => false, isRestarting: () => false },
      reenqueueFleetTurn: (id, delayMs) => { calls.push([id, delayMs]); return true; },
      taskTurnRegistry: new Map(),
    };
    attachCronRunner(boom, {
      runPersona: async () => ({ ok: true }),
      runA2a: async () => ({ ok: true }),
      listAgents: () => [],
    });
    const job = { id: "job_ladder_dead", prompt: "p", targetType: "persona", preset: "x", sourceTag: { fleetId: "f1", memberId: "m1" } };
    // Drive the pre-gate four times: three crawl the ladder, the fourth skips.
    for (let i = 0; i < 4; i++) {
      const out = await boom.runCronJobTurn(job, { turnTimeoutMs: 1 });
      if (i < 3) {
        assert.equal(out.retried, true, `attempt ${i + 1} must be retried, not lost`);
        assert.equal(out.skipped, true, "a retried round still leaves no ledger/handoffs behind");
      } else {
        assert.equal(out.retried, undefined, "the exhausted ladder must not retry again");
        assert.equal(out.skipped, true);
      }
    }
    assert.equal(calls.length, 3, "exactly the ladder length of re-enqueues");
    assert.deepEqual(calls.map((c) => c[1]), [30_000, 90_000, 180_000], "escalating backoff");
  } finally {
    if (prevWait === undefined) delete process.env.FLEET_TURN_READY_WAIT_MS;
    else process.env.FLEET_TURN_READY_WAIT_MS = prevWait;
  }
});

// ── 5. routes + cockpit face ────────────────────────────────────────────────

test("memberView/cockpit: lastTurn + consecutiveFailures ride along; presence untouched", async () => {
  const fleet = fixtureFleet(fleetDb);
  const m = fixtureMember(fleetDb, fleet.id, { id: "m_view", targetId: "persona-v" });
  fixtureEvent(fleetDb, m, { status: "failed", errorKind: "tool_permission", error: "denied", sessionId: "s-1" });
  fixtureEvent(fleetDb, m, { status: "failed", errorKind: "timeout", error: "timed out", sessionId: "s-2" });
  // Materialize the cadence task so the presence derivation reads on_duty —
  // the failing count is presence-scoped by spec (missing posts count in
  // their own dimension, not this one).
  await cron.addJob({
    cron: "0 3 1 1 *",
    tz: null,
    prompt: "巡视",
    preset: "persona-v",
    sourceTag: { fleetId: fleet.id, memberId: m.id },
  });

  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: (member) => ({ alive: true, label: member.targetId }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const cock = await (await fetch(`${base}/api/fleets/${fleet.id}/cockpit`)).json();
    const view = cock.members.find((x) => x.id === "m_view");
    assert.equal(view.lastTurn.status, "failed");
    assert.equal(view.lastTurn.errorKind, "timeout");
    assert.equal(view.lastTurn.sessionId, "s-2");
    assert.equal(view.consecutiveFailures, 2);
    // fix-fleet-failure-visibility: health.failing derives from the STATUS,
    // so a two-round streak (below the default threshold of 3) is still a
    // working post — it keeps its colour and does not count as failing.
    assert.equal(cock.health.failing, 0, "a sub-threshold streak does not downgrade the post");
    assert.equal(view.status, "on_duty", "two failed rounds stay on duty");
    assert.equal(view.failureStreak, 2, "the streak itself is always visible");
    assert.equal(view.lastErrorKind, "timeout", "attribution names the newest failure");
    assert.equal(cock.health.total, cock.members.length);

    const tl = await (await fetch(`${base}/api/fleets/${fleet.id}/members/m_view/turns?limit=1`)).json();
    assert.equal(tl.turns.length, 1);
    assert.equal(tl.turns[0].source, "cron");
    assert.ok(tl.nextBefore, "cursor offered when a page was cut");
    const tl2 = await (await fetch(`${base}/api/fleets/${fleet.id}/members/m_view/turns?limit=10&before=${tl.nextBefore}`)).json();
    assert.equal(tl2.turns.length, 1);

    const flt = await (await fetch(`${base}/api/fleets/${fleet.id}/turns?status=failed&source=cron`)).json();
    assert.equal(flt.turns.length, 2);
    assert.ok(flt.turns.every((e) => e.status === "failed" && !("prompt" in e)), "facts only, no prompts");

    const bad = await fetch(`${base}/api/fleets/${fleet.id}/turns?status=weird`);
    assert.equal(bad.status, 400);
    const bad2 = await fetch(`${base}/api/fleets/${fleet.id}/turns?source=later`);
    assert.equal(bad2.status, 400);
  } finally {
    server.close();
  }
});
