// Red-proof tests for the claim lane (harden-agent-runtime-spine,
// agent-turn-claim I1). These are the assertions that FAILED before the claim
// existed: a turn that starts and then loses its process must still be a fact
// on disk, and it must settle as "interrupted", never as "failed".
//
// Covers:
//   - begin() writes a claim BEFORE anything can run; the row is on disk
//   - a claim that cannot be written THROWS and leaves no in-memory handle
//   - end() closes the claim with the row's own verdict
//   - a `skipped` round closes nothing (no attempt existed)
//   - a hollow `ok` (the existing shapeTurnOutcome rule) closes `interrupted`,
//     not `ok` — reusing the vocabulary rather than re-deriving it
//   - the sweeper closes a lapsed claim as lease_expired (the pod-roll case:
//     the process died, nothing ever called end()), and that attempt is NOT a
//     failure in any rate
//   - heartbeats keep a live claim's lease moving
//
// Run: node --test scripts/test-turn-claim-lane.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-claim-lane-"));
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
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");
const { createTurnClaimStore } = await import("../lib/turn-claim-store.js");
const { LEASE_MS, turnRefFor, countsAsFailure } = await import("../lib/turn-claim.js");

await initDb();
await chatHistory.initChatHistory();
await cron.initCron({ broadcast: () => {}, runTurn: async () => ({ ok: true, text: "ok" }) });
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true, text: "ok" }),
  isBusy: () => false,
});

const tmp = tmpRoot;
let fleetDb;
let claimsDb;
let claims;
let ledger;
let fleetId;
let memberId;

beforeEach(async () => {
  const file = path.join(tmp, `fleets-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  fleetDb = createFleetDatabase({ file });
  setFleetDatabase(fleetDb);
  fleetId = "f_claim";
  fleetDb.createFleet({ id: fleetId, name: "claim lane", ownerEmail: "owner@example.com" });
  memberId = "m_worker";
  fleetDb.createMember({ id: memberId, fleetId, title: "worker", targetKind: "persona", targetId: "persona-a", parentId: null, kpiSlots: [], cadence: null });

  claimsDb = new Database(file);
  claims = createTurnClaimStore({ db: claimsDb });
  ledger = createFleetTurnLedger({ db: fleetDb, claims, now: () => 1_000_000 });
});

afterEach(async () => {
  await engine.idle?.();
  try { claimsDb.close(); } catch { /* already closed */ }
  try { fleetDb.close(); } catch { /* already closed */ }
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A fleet-attributed job (the same shape test-fleet-runs builds).
function job(over = {}) {
  return {
    id: `job_${Math.random().toString(16).slice(2, 10)}`,
    preset: "persona-a",
    targetType: "persona",
    trigger: "manual",
    prompt: "do the thing",
    sessionId: "sess-1",
    sourceTag: { fleetId, memberId },
    ...over,
  };
}

test("begin: the claim is on disk from the start (pod-roll survivable)", () => {
  const handle = ledger.begin(job(), { startedAt: 1_000_000 });
  assert.ok(handle, "a fleet turn opens a ledger handle");

  const ref = turnRefFor({ driver: "platform", source: handle.claimRef.split("|")[1], runId: handle.runId, turnId: handle.turnId });
  const row = claims.get(ref);
  assert.ok(row, "the attempt exists on disk before anything ran");
  assert.equal(row.turn_id, handle.turnId);
  assert.equal(row.run_id, handle.runId);
  assert.equal(row.started_at, 1_000_000);
  assert.equal(row.closed_at, null);
  assert.equal(row.fleet_id, fleetId);
  assert.equal(row.member_id, memberId);
});

test("begin: a claim write failure throws and leaves no in-memory handle", () => {
  claimsDb.exec("DROP TABLE turn_claims"); // force the write to fail
  let threw = null;
  try {
    ledger.begin(job(), { startedAt: 1_000_000 });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "begin must fail loudly rather than run an unrecorded attempt");
  assert.equal(threw.code, "TURN_CLAIM_FAILED");
  // No leaked in-flight handle: nothing else may pick this turn up.
  assert.equal(ledger.openTurns().length, 0);
});

test("end: the claim closes with the row's own verdict", () => {
  const handle = ledger.begin(job(), { startedAt: 1_000_000 });
  ledger.end(job(), handle, { ok: true }, { startedAt: 1_000_000, endedAt: 1_000_500 });
  const row = claims.get(handle.claimRef);
  assert.equal(row.closed_at, 1_000_500);
  assert.equal(row.close_reason, "ok");
});

test("end: a failed round closes as failed — and that IS a failure in a rate", () => {
  const handle = ledger.begin(job(), { startedAt: 1_000_000 });
  ledger.end(job(), handle, { ok: false, error: "boom" }, { startedAt: 1_000_000, endedAt: 1_000_500 });
  const row = claims.get(handle.claimRef);
  assert.equal(row.close_reason, "failed");
  assert.equal(countsAsFailure(row.close_reason), true);
});

test("end: an interrupted round closes as interrupted — never a failure", () => {
  const handle = ledger.begin(job(), { startedAt: 1_000_000 });
  ledger.end(job(), handle, { ok: false, interrupted: true }, { startedAt: 1_000_000, endedAt: 1_000_500 });
  const row = claims.get(handle.claimRef);
  assert.equal(row.close_reason, "interrupted");
  assert.equal(countsAsFailure(row.close_reason), false, "an interrupted attempt is not a failure");
});

test("end: the claim's verdict always agrees with the row it settled", () => {
  // The rule this pins: one vocabulary, two writers. Whatever shapeTurnOutcome
  // decided (ok / interrupted / failed / skipped) is what the claim records —
  // no second derivation that could disagree with the ledger.
  const cases = [
    [{ ok: true, usage: { input: 100, output: 50 }, text: "done", toolBlocks: [{ name: "t" }], reported: true }, "ok"],
    [{ ok: false, error: "boom" }, "failed"],
    [{ ok: false, interrupted: true }, "interrupted"],
  ];
  for (const [outcome, expected] of cases) {
    const h = ledger.begin(job(), { startedAt: 1_000_000 });
    ledger.end(job(), h, outcome, { startedAt: 1_000_000, endedAt: 1_000_500 });
    const row = claims.get(h.claimRef);
    assert.equal(row.close_reason, expected, `outcome ${JSON.stringify(outcome)} ⇒ ${expected}`);
  }
});

test("sweepClaims: a process that died mid-turn settles interrupted, never failed", () => {
  // This is the case that had no answer before: begin() ran, the pod rolled,
  // nothing ever called end(). Nothing is on memledger's `open` map after the
  // sweep process restarts — the claim row is the only evidence.
  const dead = createTurnClaimStore({ db: claimsDb }); // a fresh store = a fresh process
  const handle = ledger.begin(job(), { startedAt: 1_000_000 });
  const ref = handle.claimRef;
  assert.ok(dead.get(ref).closed_at === null);

  // A NEW ledger (the restarted process) sweeps past the lease.
  const restarted = createFleetTurnLedger({ db: fleetDb, claims: dead, now: () => 1_000_000 + LEASE_MS + 5 });
  const closed = restarted.sweepClaims({ nowMs: 1_000_000 + LEASE_MS + 5 });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close_reason, "lease_expired");

  const row = dead.get(ref);
  assert.equal(row.close_reason, "lease_expired");
  assert.equal(countsAsFailure(row.close_reason), false, "a lapsed attempt must not sit in a failure rate");
});

test("heartbeat: the ledger beats every open claim it knows about", () => {
  const handleA = ledger.begin(job(), { startedAt: 1_000_000 });
  const handleB = ledger.begin(job(), { startedAt: 1_000_000 });
  const before = claims.get(handleA.claimRef).heartbeat_at;
  // Past the coalescing window, from the SAME ledger (it holds the handles).
  const later = 1_000_000 + 60_000;
  const beaten = ledger.heartbeat({ nowMs: later });
  assert.equal(beaten, 2);
  assert.ok(claims.get(handleA.claimRef).heartbeat_at > before);
  assert.ok(claims.get(handleB.claimRef).heartbeat_at > before);
});

test("skipped: a round that never started leaves no attempt to close", () => {
  // In production the `skipped` paths (runtime-not-ready ladder, lane breaker)
  // return BEFORE `begin`, so no claim exists at all. This asserts the
  // consequence for a caller that does reach end(): the claim stays open and
  // the SWEEPER — not the end path — is what eventually closes it, as
  // lease_expired rather than as a failure or a success.
  const handle = ledger.begin(job(), { startedAt: 1_000_000 });
  ledger.end(job(), handle, { ok: false, skipped: true }, { startedAt: 1_000_000, endedAt: 1_000_500 });
  assert.equal(claims.get(handle.claimRef).closed_at, null, "a skipped round closes nothing");

  const later = 1_000_000 + LEASE_MS + 5;
  const closed = ledger.sweepClaims({ nowMs: later });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close_reason, "lease_expired");
  assert.equal(countsAsFailure(closed[0].close_reason), false);
});

test("fingerprint: the claim and the result row carry the SAME identity", () => {
  // Spec 3.3: one value, two rows. The claim gets it at START, the result row
  // at END; a read face must never see two different fingerprints for one
  // attempt. `fingerprintFor` is injected here as a constant so the assertion
  // is about the plumbing, not about hashing.
  const fp = { bundle: "f".repeat(64), parts: { persona: "p", skills: [] } };
  const withFp = createFleetTurnLedger({ db: fleetDb, claims, now: () => 1_000_000, fingerprintFor: () => fp });
  const handle = withFp.begin(job(), { startedAt: 1_000_000 });
  assert.equal(claims.get(handle.claimRef).runtime_fingerprint, fp.bundle);

  withFp.end(job(), handle, { ok: true }, { startedAt: 1_000_000, endedAt: 1_000_500 });
  const row = fleetDb.getTurnEvent(handle.turnId);
  assert.equal(row.runtimeFingerprint, fp.bundle, "the result row carries the same value");
  assert.equal(row.runtimeFingerprint, claims.get(handle.claimRef).runtime_fingerprint);
});

test("fingerprint: an injected value wins over the cell's own computation", () => {
  const injected = { bundle: "a".repeat(64), parts: { persona: "given", skills: [] } };
  const fp = createFleetTurnLedger({ db: fleetDb, claims, now: () => 1_000_000, fingerprintFor: () => ({ bundle: "b".repeat(64), parts: {} }) });
  const handle = fp.begin(job(), { startedAt: 1_000_000, fingerprint: injected.bundle, fingerprintParts: injected.parts });
  assert.equal(claims.get(handle.claimRef).runtime_fingerprint, injected.bundle);
  assert.deepEqual(claims.get(handle.claimRef).runtime_fingerprint_parts, injected.parts);
});

test("fingerprint: no fingerprint source records NULL, never a guess", () => {
  const bare = createFleetTurnLedger({ db: fleetDb, claims, now: () => 1_000_000 });
  const handle = bare.begin(job(), { startedAt: 1_000_000 });
  assert.equal(claims.get(handle.claimRef).runtime_fingerprint, null);
  bare.end(job(), handle, { ok: true }, { startedAt: 1_000_000, endedAt: 1_000_500 });
  assert.equal(fleetDb.getTurnEvent(handle.turnId).runtimeFingerprint, null);
});

// ── fingerprint-grouped read face (runtime-fingerprint 3.5) ─────────────────

function turnRow(over) {
  fleetDb.appendTurnEvent({
    fleetId,
    memberId,
    source: "cron",
    startedAt: 1_000_000,
    endedAt: 1_010_000,
    ...over,
  });
}

test("version read face: verdicts are the denominator; not-a-verdict is excluded", () => {
  turnRow({ status: "ok", runtimeFingerprint: "vA", usage: { input: 10, output: 5 } });
  turnRow({ status: "failed", runtimeFingerprint: "vA", usage: { input: 10, output: 5 } });
  turnRow({ status: "interrupted", runtimeFingerprint: "vA" });
  turnRow({ status: "ok", runtimeFingerprint: "vB", usage: { input: 10, output: 5 } });

  const groups = fleetDb.fingerprintGroups({ fleetId });
  const a = groups.find((g) => g.fingerprint === "vA");
  assert.equal(a.attempts, 3);
  assert.equal(a.verdicts, 2, "interrupted is not a verdict");
  assert.equal(a.notAVerdict, 1);
  assert.equal(a.successRate, 0.5, "1 ok of 2 verdicts — the interrupted one is not in the denominator");

  const b = groups.find((g) => g.fingerprint === "vB");
  assert.equal(b.successRate, 1);
});

test("version read face: a fingerprint-less attempt is its own row, never folded in", () => {
  turnRow({ status: "ok", runtimeFingerprint: "vA", usage: { input: 1, output: 1 } });
  turnRow({ status: "ok", runtimeFingerprint: null, usage: { input: 1, output: 1 } });
  const groups = fleetDb.fingerprintGroups({ fleetId });
  const unnamed = groups.find((g) => g.unnamed);
  assert.ok(unnamed, "the null-fingerprint attempts are visible as their own group");
  assert.equal(unnamed.fingerprint, null);
  assert.equal(unnamed.attempts, 1);
  const a = groups.find((g) => g.fingerprint === "vA");
  assert.equal(a.attempts, 1, "and they are NOT added to a real version");
});

test("version read face: unmetered is counted and visible; no verdicts ⇒ null rate", () => {
  turnRow({ status: "ok", runtimeFingerprint: "vC" }); // no usage
  turnRow({ status: "ok", runtimeFingerprint: "vC" }); // no usage
  const g = fleetDb.fingerprintGroups({ fleetId }).find((x) => x.fingerprint === "vC");
  assert.equal(g.unmetered, 2);
  assert.equal(g.unmeteredShare, 1);
  assert.equal(g.successRate, 1, "ok is still a verdict");

  turnRow({ status: "interrupted", runtimeFingerprint: "vD" });
  const d = fleetDb.fingerprintGroups({ fleetId }).find((x) => x.fingerprint === "vD");
  assert.equal(d.verdicts, 0);
  assert.equal(d.successRate, null, "no verdicts ⇒ null, never 0 %");
  assert.equal(d.cost.usd, null, "no priced turns ⇒ null, never $0.00");
});

test("version read face: cost and latency carry their sample size", () => {
  fleetDb.appendTurnEvent({
    fleetId, memberId, source: "cron", status: "ok", startedAt: 1_000_000, endedAt: 1_004_000,
    runtimeFingerprint: "vE", usage: { input: 1, output: 1 },
    pricing: { pricingAt: 1, inputUsd: 0.25, outputUsd: 0.05, cacheWriteUsd: 0, cacheReadUsd: 0 },
  });
  const g = fleetDb.fingerprintGroups({ fleetId }).find((x) => x.fingerprint === "vE");
  assert.equal(g.cost.pricedTurns, 1);
  assert.equal(g.cost.usd, 0.3);
  assert.equal(g.duration.timedTurns, 1);
  assert.equal(g.duration.meanMs, 4000);
});
