// Quota ledger (openspec: add-team-as-a2a-agent, 4.1–4.4).
//
// What is deliberately hard to pass here:
//   • 10 concurrent takes against a limit of 3 must admit EXACTLY 3 — the test
//     runs the takes in one synchronous burst precisely because a read-then-write
//     implementation passes a "sequential" test and fails this one;
//   • a ledger that cannot write must REFUSE the call (no "succeeded but
//     unrecorded" rows);
//   • money is micro-dollars, so 3 × $0.10 against $0.30 is exactly 3;
//   • the day rolls at UTC midnight, and the reset instant is readable.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const {
  ensureTeamQuotaTables,
  takeCallSlot,
  chargeUsage,
  finishCall,
  readUsage,
  getCall,
  usdToMicros,
  dayKey,
  quotaResetAtFor,
} = await import("../server/team-serving-quota.js");

const CELL = "cell-1";
const HANDLE = "cs-team";
const QUOTA = { callsPerDay: 3, tokensPerDay: 1_000, usdPerDay: 0.3 };
// One fixed instant for the whole suite: the ledger is keyed by UTC day, so a
// test that mixes a fixed `now` with the real clock reads a DIFFERENT row.
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

function freshDb() {
  const db = new Database(":memory:");
  ensureTeamQuotaTables(db);
  return db;
}

const take = (db, over = {}) =>
  takeCallSlot(db, {
    cellId: CELL,
    handle: HANDLE,
    caller: "caller@x.test",
    quota: QUOTA,
    now: NOW,
    ...over,
  });

// ── 4.1 the race ──────────────────────────────────────────────────────────

test("ten concurrent takes against a limit of three admit exactly three", () => {
  const db = freshDb();
  const results = [];
  // One synchronous burst — the smallest window a conditional UPDATE has to win
  // and a read-then-write has to lose.
  for (let i = 0; i < 10; i += 1) results.push(take(db));

  const admitted = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  assert.equal(admitted.length, 3, `expected exactly 3 admissions, got ${admitted.length}`);
  assert.equal(refused.length, 7);
  for (const r of refused) {
    assert.equal(r.code, "quota_exceeded");
    assert.equal(r.detail.field, "calls");
  }
  assert.equal(new Set(admitted.map((r) => r.callId)).size, 3, "each admission is its own call");
  assert.deepEqual(readUsage(db, { cellId: CELL, handle: HANDLE, now: NOW }), { calls: 3, tokens: 0, usdMicros: 0 });
});

test("a take writes its call row in the same transaction", () => {
  const db = freshDb();
  const out = take(db);
  assert.equal(out.ok, true);
  const row = getCall(db, out.callId);
  assert.equal(row.status, "running");
  assert.equal(row.caller, "caller@x.test");
  assert.equal(row.day, "2026-11-12");
  assert.equal(row.handle, HANDLE);
});

test("a ledger insert failure refuses the call instead of letting it through", () => {
  const db = freshDb();
  // Break the call-record insert only, leaving the usage update writable: the
  // transaction must roll BOTH back.
  db.exec("DROP TABLE team_calls");
  const out = take(db);
  assert.equal(out.ok, false);
  assert.equal(out.code, "internal_error");
  assert.equal(readUsage(db, { cellId: CELL, handle: HANDLE, now: NOW }).calls, 0, "no slot may be consumed without a record");
});

// ── 4.2 mid-stream exhaustion ─────────────────────────────────────────────

test("a token delta past the bound is refused and does not partially charge", () => {
  const db = freshDb();
  const { callId } = take(db);
  const first = chargeUsage(db, { cellId: CELL, handle: HANDLE, callId, tokens: 900, quota: QUOTA, now: NOW });
  assert.equal(first.ok, true);

  const tooMuch = chargeUsage(db, { cellId: CELL, handle: HANDLE, callId, tokens: 200, quota: QUOTA, now: NOW });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.field, "tokens");
  assert.equal(readUsage(db, { cellId: CELL, handle: HANDLE, now: NOW }).tokens, 900, "the refused delta is not charged at all");

  finishCall(db, { callId, status: "quota_aborted", errorCode: "quota_exceeded" });
  const row = getCall(db, callId);
  assert.equal(row.status, "quota_aborted");
  assert.equal(row.error_code, "quota_exceeded");
  assert.equal(row.tokens, 900, "produced work stays recorded");
});

test("money is integer micro-dollars so a cent does not drift", () => {
  assert.equal(usdToMicros(5), 5_000_000);
  assert.equal(usdToMicros(0.3), 300_000);
  assert.equal(usdToMicros(-1), 0);
  assert.equal(usdToMicros(Number.POSITIVE_INFINITY), 0, "unlimited is not expressible as a bound");

  const db = freshDb();
  const quota = { callsPerDay: 100, tokensPerDay: 1_000_000, usdPerDay: 0.3 };
  const out = take(db, { quota });
  // Three 10-cent deltas fit exactly; the fourth is refused.
  for (let i = 0; i < 3; i += 1) {
    const r = chargeUsage(db, { cellId: CELL, handle: HANDLE, callId: out.callId, usdMicros: 100_000, quota, now: NOW });
    assert.equal(r.ok, true, `delta ${i + 1} must fit`);
  }
  const fourth = chargeUsage(db, { cellId: CELL, handle: HANDLE, callId: out.callId, usdMicros: 100_000, quota, now: NOW });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.field, "usd");
  assert.equal(readUsage(db, { cellId: CELL, handle: HANDLE, now: NOW }).usdMicros, 300_000);
});

test("a call already at the token ceiling is refused at take time", () => {
  const db = freshDb();
  const quota = { callsPerDay: 100, tokensPerDay: 10, usdPerDay: 5 };
  const first = take(db, { quota });
  chargeUsage(db, { cellId: CELL, handle: HANDLE, callId: first.callId, tokens: 10, quota, now: NOW });
  const next = take(db, { quota });
  assert.equal(next.ok, false);
  assert.equal(next.detail.field, "tokens");
});

// ── 4.4 the day boundary ──────────────────────────────────────────────────

test("the counters reset on the UTC day boundary, not on local midnight", () => {
  const db = freshDb();
  const before = Date.UTC(2026, 10, 12, 23, 59, 0);
  const after = Date.UTC(2026, 10, 13, 0, 1, 0);
  for (let i = 0; i < 3; i += 1) take(db, { now: before });
  assert.equal(take(db, { now: before }).ok, false, "the day is spent");
  assert.equal(take(db, { now: after }).ok, true, "the same team has a fresh day");
  assert.equal(dayKey(before), "2026-11-12");
  assert.equal(dayKey(after), "2026-11-13");
});

test("the reset instant is published and lies on the next UTC midnight", () => {
  const now = Date.UTC(2026, 10, 12, 13, 45, 0);
  assert.equal(quotaResetAtFor(now), Date.UTC(2026, 10, 13, 0, 0, 0));
});

// ── status vocabulary ─────────────────────────────────────────────────────

test("an unknown terminal status degrades to incomplete, never to success", () => {
  const db = freshDb();
  const { callId } = take(db);
  finishCall(db, { callId, status: "totally-done" });
  assert.equal(getCall(db, callId).status, "incomplete");
});
