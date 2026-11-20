// Unit tests for turn-claim storage (harden-agent-runtime-spine, agent-turn-claim D2).
//
// Covers the spec pins that live in the STORE rather than the rules:
//   - a claim survives a reopen (it is a fact on disk, not process memory)
//   - re-claiming the same turn_ref reuses the row (认领幂等)
//   - heartbeat is coalesced, and a late beat cannot revive a closed claim
//   - closing is one-way: the loser of a sweeper/end race reads the winner
//   - an invalid terminal reason is refused (closed vocabulary)
//   - sweep() closes lapsed claims as lease_expired and emits ONE event each
//   - heartbeat writes do NOT grow the row count (the claim stays one row)
//
// Run: node --test scripts/test-turn-claim-store.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

const { createTurnClaimStore } = await import("../lib/turn-claim-store.js");
const { LEASE_MS, HEARTBEAT_WRITE_MS, turnRefFor } = await import("../lib/turn-claim.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turn-claim-"));
const dbFile = path.join(tmp, "fleets.db");

let db;
let store;
let events;

const REF = turnRefFor({ driver: "platform", source: "cell:0123456789abcdef", runId: "run_1", turnId: "turn_1" });
const base = (over = {}) => ({
  turnRef: REF,
  driver: "platform",
  source: "cell:0123456789abcdef",
  runId: "run_1",
  turnId: "turn_1",
  fleetId: "fleet_1",
  memberId: "member_1",
  sessionId: "sess_1",
  startedAt: 1_000_000,
  ...over,
});

beforeEach(() => {
  try { fs.rmSync(dbFile, { force: true }); } catch { /* fresh */ }
  try { fs.rmSync(`${dbFile}-wal`, { force: true }); } catch { /* fresh */ }
  try { fs.rmSync(`${dbFile}-shm`, { force: true }); } catch { /* fresh */ }
  db = new Database(dbFile);
  events = [];
  store = createTurnClaimStore({ db, emit: (ev) => events.push(ev) });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

test("claim: a claim survives a reopen — the state is not the process's memory", () => {
  const out = store.claim(base());
  assert.equal(out.ok, true);
  assert.equal(out.claim.turn_ref, REF);
  assert.equal(out.claim.close_reason, null);
  db.close();

  // A new process opens the same file: the attempt is still there.
  db = new Database(dbFile);
  store = createTurnClaimStore({ db, emit: (ev) => events.push(ev) });
  const row = store.get(REF);
  assert.equal(row?.turn_ref, REF);
  assert.equal(row?.started_at, 1_000_000);
});

test("claim: re-claiming the same attempt reuses the row (idempotent per turn_ref)", () => {
  store.claim(base());
  // A retry arrives with a DIFFERENT startedAt (a second attempt at the same
  // address); it must not create a second claim nor move the start time.
  const again = store.claim(base({ startedAt: 1_500_000 }));
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(again.claim.started_at, 1_000_000, "the first start time is the fact");
  const count = db.prepare("SELECT COUNT(*) AS n FROM turn_claims").get().n;
  assert.equal(count, 1);
});

test("claim: a write failure is reported, never swallowed", () => {
  // Drop the table out from under the store to force a write failure.
  db.exec("DROP TABLE turn_claims");
  const out = store.claim(base());
  assert.equal(out.ok, false);
  // The store must not have half-created anything it can now read.
  assert.equal(out.reason, "claim-write-failed");
});

test("heartbeat: coalesced within the write interval, then written once", () => {
  store.claim(base());
  const t0 = 1_000_000;

  // The FIRST beat always persists (the claim write itself only stamped
  // started_at; a 30 s turn deserves at least one real liveness write).
  const first = store.heartbeat(REF, { nowMs: t0 + 10 });
  assert.equal(first.ok, true);
  assert.equal(first.coalesced, false);
  assert.equal(store.get(REF).heartbeat_at, t0 + 10);

  const a = store.heartbeat(REF, { nowMs: t0 + 20 });
  assert.equal(a.ok, true);
  assert.equal(a.coalesced, true, "inside the interval ⇒ no write");
  assert.equal(store.get(REF).heartbeat_at, t0 + 10, "heartbeat_at did not move");

  const b = store.heartbeat(REF, { nowMs: t0 + 10 + HEARTBEAT_WRITE_MS + 1 });
  assert.equal(b.ok, true);
  assert.equal(b.coalesced, false);
  assert.equal(store.get(REF).heartbeat_at, t0 + 10 + HEARTBEAT_WRITE_MS + 1);
});

test("heartbeat: a late beat cannot revive a closed claim", () => {
  store.claim(base());
  store.close(REF, { reason: "ok", at: 1_002_000 });
  const out = store.heartbeat(REF, { nowMs: 1_100_000 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "closed-or-missing");
  assert.equal(store.get(REF).close_reason, "ok", "the close stands");
});

test("close: one-way — a second close reads the winner instead of overwriting", () => {
  store.claim(base());
  const first = store.close(REF, { reason: "interrupted", at: 1_003_000 });
  assert.equal(first.applied, true);
  const second = store.close(REF, { reason: "failed", at: 1_004_000 });
  assert.equal(second.applied, false, "the late writer loses");
  assert.equal(second.claim.close_reason, "interrupted", "and reads the winner's answer");
});

test("close: a reason outside the vocabulary is refused outright", () => {
  store.claim(base());
  const out = store.close(REF, { reason: "timeout", at: 1_003_000 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "invalid-terminal-reason");
  assert.equal(store.get(REF).closed_at, null, "nothing was written");
});

test("sweep: lapsed claims close as lease_expired, once each, with a visible event", () => {
  store.claim(base()); // lapses at started_at + LEASE_MS
  const late = 1_000_000 + LEASE_MS + 1;

  const closed = store.sweep({ nowMs: late });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close_reason, "lease_expired");
  const evs = events.filter((e) => e.kind === "lease.expired");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].last_heartbeat_at, 1_000_000);
  assert.equal(evs[0].run_id, "run_1");

  // A second sweep finds nothing: expiry is a fact, not a repeating inference.
  const again = store.sweep({ nowMs: late + 60_000 });
  assert.equal(again.length, 0);
  assert.equal(events.filter((e) => e.kind === "lease.expired").length, 1);
});

test("sweep: a live claim is untouched", () => {
  store.claim(base());
  const closed = store.sweep({ nowMs: 1_000_000 + Math.floor(LEASE_MS / 2) });
  assert.equal(closed.length, 0);
  assert.equal(store.get(REF).closed_at, null);
});

test("fingerprint: write-once — a second fingerprint does not overwrite the first", () => {
  store.claim(base());
  const a = store.setFingerprint(REF, "aaa", { skills: [{ name: "s", sha: "1" }] });
  assert.equal(a.ok, true);
  const b = store.setFingerprint(REF, "bbb", null);
  assert.equal(b.ok, false, "the first fingerprint is the attempt's identity");
  assert.equal(store.get(REF).runtime_fingerprint, "aaa");
  assert.deepEqual(store.get(REF).runtime_fingerprint_parts, { skills: [{ name: "s", sha: "1" }] });
});

test("heartbeats do not grow the row count — the claim stays one row", () => {
  store.claim(base());
  for (let i = 1; i <= 40; i++) store.heartbeat(REF, { nowMs: 1_000_000 + i * HEARTBEAT_WRITE_MS });
  const n = db.prepare("SELECT COUNT(*) AS n FROM turn_claims").get().n;
  assert.equal(n, 1, "a long turn must not add rows");
  assert.ok(store.get(REF).heartbeat_at > 1_000_000);
});

test("listOpen: a carrier filter is exact, and closing removes from the list", () => {
  store.claim(base());
  store.claim(base({ turnRef: turnRefFor({ driver: "platform", source: "cell:ffffffffffffffff", runId: "r2", turnId: "t2" }), source: "cell:ffffffffffffffff", runId: "r2", turnId: "t2" }));
  assert.equal(store.listOpen().length, 2);
  assert.equal(store.listOpen({ source: "cell:0123456789abcdef" }).length, 1);
  store.close(REF, { reason: "ok", at: 1_005_000 });
  assert.equal(store.listOpen({ source: "cell:0123456789abcdef" }).length, 0);
});
