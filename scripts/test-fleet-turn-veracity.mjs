// Unit tests — fleet turn veracity (fix-fleet-turn-veracity; wire §二).
//
// The gap (fd-wire 2026-10-26 census: 58 zero-second `runtime_not_ready`
// failures): a round that never started was recorded as a formal failure —
// it poisoned the failure streak, advanced presence ("just ran") and, batched
// at the same second across one fleet's posts, read as a retry storm.
//
// Pins:
//   - a fleet persona round that exhausts the readiness wait records `skipped`
//     BEFORE the run ledger opens (no run instance, no handoffs, one row)
//   - the failure streak walks PAST skipped rows (never counted, never breaking
//     the chain, never touching since/lastErrorKind) while interrupted still
//     stops it — the two statuses are not the same thing
//   - presence reads real rounds only: a skip-only window degrades to missing
//     with the skip count named; pre-stream posts keep the engine fallback
//
// Run: node --test scripts/test-fleet-turn-veracity.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-veracity-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// The readiness pre-gate's wait is real time; the unit test only needs the
// not-ready branch, so the bounded wait collapses to one poll tick.
process.env.FLEET_TURN_READY_WAIT_MS = "30";

const { deriveMemberStatus } = await import("../server/fleet-reconcile.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { attachCronRunner } = await import("../server/cron-runner.js");

const NOW = Date.parse("2026-10-27T12:00:00Z");
const member = (over = {}) => ({
  id: "m_1",
  fleetId: "f_1",
  title: "投稿岗",
  targetKind: "persona",
  targetId: "persona-a",
  cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  kpiSlots: [],
  ...over,
});
const fleet = { id: "f_1", state: "active" };
const freshTask = { id: "j_1", lastRun: "2026-10-27T01:00:00Z", nextRun: "2026-10-28T01:00:00Z" };

function db() {
  return createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
}
const ev = (memberId, status, startedAt, errorKind = null) => ({
  fleetId: "f_1",
  memberId,
  source: "cron",
  status,
  errorKind,
  error: null,
  model: null,
  startedAt,
  endedAt: startedAt,
  sessionId: null,
});

// ── D1 · the not-executed short-circuit leaves no run instance ─────────────

test("a fleet persona round that never becomes ready records skipped, no ledger", async () => {
  const ctx = {
    dshBridge: { isReady: () => false },
    fleetTurnLedger: {
      begin: () => {
        throw new Error("ledger must never open for a skipped round");
      },
    },
    drainDeferredCredentialRestart: null,
    renewLineCredentialsForTurn: null,
  };
  const recorded = [];
  ctx.recordFleetTurnEvent = (job, out, meta) => recorded.push({ job, out, meta });
  attachCronRunner(ctx, {
    runPersona: () => {
      throw new Error("persona executor must never run for a skipped round");
    },
  });
  const out = await ctx.runCronJobTurn(
    { id: "job_1", targetType: "persona", sourceTag: { fleetId: "f_1", memberId: "m_1" }, sessionId: "s_1" },
    {},
  );
  assert.equal(out.skipped, true);
  assert.equal(out.ok, false);
  assert.match(out.error, /not ready/i);
  assert.equal(recorded.length, 1, "exactly one event per skipped batch");
  assert.equal(recorded[0].out.skipped, true);
  assert.equal(recorded[0].meta.ledgerTurn, null);
});

test("a ready runtime clears the pre-gate and the turn runs normally", async () => {
  const ctx = {
    isStreaming: false,
    dshBridge: {
      isReady: () => true,
      prompt: async () => {},
    },
    fleetTurnLedger: null,
    recordFleetTurnEvent: () => {},
    drainDeferredCredentialRestart: null,
    renewLineCredentialsForTurn: null,
    chatHistory: null,
  };
  let personaRan = 0;
  attachCronRunner(ctx, {
    runPersona: async () => {
      personaRan += 1;
      return { ok: true, usage: null, text: "done" };
    },
  });
  const out = await ctx.runCronJobTurn(
    { id: "job_2", targetType: "persona", sourceTag: { fleetId: "f_1", memberId: "m_1" }, sessionId: "s_2" },
    {},
  );
  assert.equal(personaRan, 1);
  assert.equal(out.ok, true);
});

test("same-second fan-in collapses: the first wait absorbs the restart window (D4)", async () => {
  // Three posts fire into the serial chain inside one bridge-restart window.
  // The first round's bounded wait outlives the window, so NOBODY records a
  // skip — the wire census' "9 same-second failures" needs a window LONGER
  // than the wait to produce even one skipped row.
  const prevEnv = process.env.FLEET_TURN_READY_WAIT_MS;
  process.env.FLEET_TURN_READY_WAIT_MS = "400";
  try {
    const t0 = Date.now();
    let personaRan = 0;
    const ctx = {
      isStreaming: false,
      dshBridge: {
        isReady: () => Date.now() - t0 >= 120,
        prompt: async () => {},
      },
      fleetTurnLedger: null,
      recordFleetTurnEvent: () => {},
      drainDeferredCredentialRestart: null,
      renewLineCredentialsForTurn: null,
    };
    attachCronRunner(ctx, {
      runPersona: async () => {
        personaRan += 1;
        return { ok: true, usage: null, text: "ok" };
      },
    });
    const skipped = [];
    const record = ctx.recordFleetTurnEvent;
    ctx.recordFleetTurnEvent = (job, out, meta) => {
      if (out?.skipped) skipped.push(job.id);
      return record(job, out, meta);
    };
    for (const id of ["j_a", "j_b", "j_c"]) {
      const out = await ctx.runCronJobTurn(
        { id, targetType: "persona", sourceTag: { fleetId: "f_1", memberId: `m_${id}` }, sessionId: `s_${id}` },
        {},
      );
      assert.equal(out.ok, true, `${id} executes after the absorbed window`);
    }
    assert.equal(personaRan, 3);
    assert.deepEqual(skipped, [], "no skipped rows once the wait absorbs the window");
  } finally {
    if (prevEnv === undefined) delete process.env.FLEET_TURN_READY_WAIT_MS;
    else process.env.FLEET_TURN_READY_WAIT_MS = prevEnv;
  }
});

test("a persistent outage records one honest skip per fire, never zero-second failures", async () => {
  const ctx = {
    dshBridge: { isReady: () => false },
    fleetTurnLedger: null,
    drainDeferredCredentialRestart: null,
    renewLineCredentialsForTurn: null,
  };
  const recorded = [];
  ctx.recordFleetTurnEvent = (job, out) => {
    if (out?.skipped) recorded.push(job.id);
  };
  attachCronRunner(ctx, {
    runPersona: () => {
      throw new Error("must never run");
    },
  });
  for (const id of ["j_a", "j_b"]) {
    const out = await ctx.runCronJobTurn(
      { id, targetType: "persona", sourceTag: { fleetId: "f_1", memberId: `m_${id}` }, sessionId: `s_${id}` },
      {},
    );
    assert.equal(out.skipped, true);
  }
  assert.deepEqual(recorded, ["j_a", "j_b"], "each fire = one skipped row, zero failed rows");
});

// ── D2 · the streak skips skipped rows, transparently ──────────────────────

test("failureStreak walks past skipped rows without counting or breaking", () => {
  const d = db();
  const t0 = NOW - 3600_000;
  d.appendTurnEvent(ev("m_1", "failed", t0, "timeout"));
  d.appendTurnEvent(ev("m_1", "skipped", t0 + 60_000, "runtime_not_ready"));
  d.appendTurnEvent(ev("m_1", "failed", t0 + 120_000, "runtime_not_ready"));
  const s = d.failureStreak("m_1");
  assert.equal(s.streak, 2, "two real failures stay consecutive across one skip");
  assert.equal(s.lastErrorKind, "runtime_not_ready", "newest REAL failure's kind, not the skip's");
  assert.equal(s.since, t0, "oldest row in the streak, not the skip's timestamp");
});

test("a skip-only stream reads streak 0; interrupted still stops the streak", () => {
  const d = db();
  d.appendTurnEvent(ev("m_1", "failed", NOW - 7200_000));
  d.appendTurnEvent(ev("m_1", "interrupted", NOW - 3600_000));
  d.appendTurnEvent(ev("m_1", "skipped", NOW - 1800_000));
  d.appendTurnEvent(ev("m_1", "skipped", NOW - 60_000));
  assert.equal(d.failureStreak("m_1").streak, 0, "interrupted broke the chain; skips added nothing");
  const d2 = db();
  d2.appendTurnEvent(ev("m_1", "skipped", NOW - 60_000));
  d2.appendTurnEvent(ev("m_1", "skipped", NOW - 30_000));
  assert.equal(d2.failureStreak("m_1").streak, 0, "skips alone never arm a streak");
});

// ── D3 · presence reads real rounds only ────────────────────────────────────

const deriveMissing = (extra = {}) =>
  deriveMemberStatus({
    member: member(),
    fleet,
    task: freshTask,
    targetAlive: true,
    now: NOW,
    ...extra,
  });

test("a skip-only tolerance window degrades to missing with the count named", () => {
  // Stream exists (latest turn known) but holds no real round: effective
  // lastRunAt is null while the engine's task.lastRun sat 11h ago — presence
  // must not ride the skip-advanced clock.
  const d = deriveMissing({ effectiveLastRunAt: NOW - 60 * 3600_000, skippedRounds: 4 });
  assert.equal(d.status, "missing");
  assert.match(d.reason, /skipped/);
});

test("skipped rows never advance presence on their own (stream without real turns)", () => {
  // Two days of skipped rounds and no real one: the engine would have stamped
  // lastRun yesterday — the derivation must see never-ran (fallback engaged).
  const d = deriveMemberStatus({
    member: member(),
    fleet,
    task: { id: "j_1", lastRun: "2026-10-26T01:00:00Z", nextRun: null, createdAt: "2026-10-25T01:00:00Z" },
    targetAlive: true,
    now: NOW,
    effectiveLastRunAt: null,
    skippedRounds: 12,
  });
  assert.equal(d.status, "missing");
  assert.match(d.reason, /never executed past the tolerance window/);
});

test("undefined effectiveLastRunAt keeps the engine fallback (pre-stream posts)", () => {
  const d = deriveMissing({ skippedRounds: 0 });
  assert.equal(d.status, "on_duty", "fresh lastRun inside window, no events at all");
});

test("failing keeps precedence when skips sit between real failures", () => {
  const d = deriveMissing({
    effectiveLastRunAt: NOW - 3600_000,
    skippedRounds: 1,
    failureStreak: 3,
    failureSince: "2026-10-26T01:00:00Z",
    lastFailureKind: "model_upstream",
  });
  assert.equal(d.status, "failing");
});
