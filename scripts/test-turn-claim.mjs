// Unit tests for the turn-claim rules (harden-agent-runtime-spine,
// agent-turn-claim). Pure: no database, no clock — every input is an argument.
//
// Covers the spec pins:
//   - the address is four segments and is the same key every read face uses
//   - the carrier shape is a two-sided contract (writers AND readers apply it)
//   - the cell hex is the SAME derivation the gateway uses for /data/cells/<hex>
//   - the terminal set is closed, and interrupted/lease_expired/cancelled are
//     not failures
//   - deriveClaimState answers all eleven states, and never guesses: an absent
//     claim with no evidence is `undetermined`, not `never_dispatched`
//   - pre-contract absence is its own state (no claim ≠ never happened)
//
// Run: node --test scripts/test-turn-claim.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  TERMINAL_REASONS,
  NOT_A_FAILURE,
  CLAIM_STATES,
  LEASE_MS,
  STALL_MS,
  turnRefFor,
  parseTurnRef,
  cellSourceFor,
  crewSourceFor,
  isCarrierShaped,
  cellHexOf,
  isTerminalReason,
  countsAsFailure,
  deriveClaimState,
  isClosedState,
  isOpenState,
  isUnhealthyState,
} = await import("../lib/turn-claim.js");

const { createHash } = await import("node:crypto");
const { userIdFor } = await import("../gateway/spawner.js");

test("address: four segments, both directions, rejects holes", () => {
  const ref = turnRefFor({ driver: "platform", source: "cell:0123456789abcdef", runId: "run_1", turnId: "turn_1" });
  assert.equal(ref, "platform|cell:0123456789abcdef|run_1|turn_1");
  assert.deepEqual(parseTurnRef(ref), {
    driver: "platform",
    source: "cell:0123456789abcdef",
    runId: "run_1",
    turnId: "turn_1",
  });
  // A missing segment is not an address; inventing one would merge two attempts.
  assert.equal(turnRefFor({ driver: "platform", source: "", runId: "r", turnId: "t" }), null);
  assert.equal(parseTurnRef("platform|cell:aa|run_1"), null);
  assert.equal(parseTurnRef("a|b||d"), null);
});

test("carrier: the cell hex is the gateway's own derivation (one hex, two writers)", () => {
  const email = "Someone@Example.COM";
  assert.equal(cellSourceFor({ email }), `cell:${userIdFor(email)}`);
  // And it is the 16-hex prefix of sha256(lowercased email) — the value
  // `export_platform.mjs --cell` is given.
  const expected = createHash("sha256").update("someone@example.com").digest("hex").slice(0, 16);
  assert.equal(cellHexOf(cellSourceFor({ email })), expected);
});

test("carrier: single-tenant has no email and gets the honest local key", () => {
  const src = cellSourceFor({ single: true });
  assert.match(src, /^cell:[0-9a-f]{16}$/);
  assert.equal(src, cellSourceFor({ email: null }));
});

test("carrier: shape is two-sided — junk is refused on the reader side too", () => {
  assert.equal(isCarrierShaped("cell:0123456789abcdef"), true);
  assert.equal(isCarrierShaped("project:fd-wanxing@cheap8"), true);
  assert.equal(isCarrierShaped("cell:abc"), false, "too short to be a hex cell");
  assert.equal(isCarrierShaped("pod:platform-5d794d888-x"), false, "a pod name carries many tenants");
  assert.equal(isCarrierShaped(""), false);
  assert.equal(crewSourceFor({ repo: "", host: "h" }), null);
});

test("terminal vocabulary: closed set, and the three non-failures are excluded from rates", () => {
  assert.deepEqual([...TERMINAL_REASONS], ["ok", "failed", "interrupted", "cancelled", "lease_expired"]);
  assert.equal(isTerminalReason("interrupted"), true);
  assert.equal(isTerminalReason("timeout"), false, "a word outside the set is not guessable into one");
  assert.equal(countsAsFailure("failed"), true);
  for (const r of NOT_A_FAILURE) assert.equal(countsAsFailure(r), false, `${r} must not count as a failure`);
  assert.equal(countsAsFailure("ok"), false);
});

test("state vocabulary: closed and open are exclusive; unhealthy is an orthogonal axis", () => {
  const ABSENT = ["never_dispatched", "undetermined", "pre_contract", "indeterminate"];
  for (const s of CLAIM_STATES) {
    // Closed and open are mutually exclusive; an absent state is neither.
    assert.equal(isClosedState(s) && isOpenState(s), false, `${s} cannot be both open and closed`);
    if (ABSENT.includes(s)) {
      assert.equal(isClosedState(s) || isOpenState(s), false, `${s} is neither open nor closed`);
    } else {
      assert.equal(isClosedState(s) || isOpenState(s), true, `${s} must be open or closed`);
    }
  }
  // Unhealthy is NOT a third bucket — it crosses the two: a claim can be open
  // and unhealthy at once (stalled / lease_passed are exactly that).
  assert.deepEqual(CLAIM_STATES.filter(isUnhealthyState), ["stalled", "lease_passed", "undetermined", "indeterminate"]);
  assert.equal(isOpenState("stalled") && isUnhealthyState("stalled"), true);
  // The healthy-open and healthy-closed states must never read as unhealthy.
  for (const s of ["running", "closed_ok", "closed_failed", "closed_cancelled", "dead", "never_dispatched", "pre_contract"]) {
    assert.equal(isUnhealthyState(s), false, `${s} must not be flagged unhealthy`);
  }
});

const T = 1_000_000;
const claim = (over = {}) => ({
  turn_ref: "platform|cell:0123456789abcdef|run|turn",
  started_at: T,
  heartbeat_at: T,
  lease_expires_at: T + LEASE_MS,
  closed_at: null,
  close_reason: null,
  ...over,
});

test("derive: an open claim with a fresh beat is running", () => {
  assert.equal(deriveClaimState({ claim: claim(), nowMs: T + 1_000 }), "running");
});

test("derive: a slow beat is stalled, an expired lease is lease_passed — in that order", () => {
  assert.equal(deriveClaimState({ claim: claim(), nowMs: T + STALL_MS + 1 }), "stalled");
  assert.equal(deriveClaimState({ claim: claim(), nowMs: T + LEASE_MS }), "lease_passed");
  assert.equal(deriveClaimState({ claim: claim(), nowMs: T + LEASE_MS + 60_000 }), "lease_passed");
});

test("derive: closed reasons map one-to-one; an unknown reason is undetermined, not guessed", () => {
  const at = T + 5_000;
  assert.equal(deriveClaimState({ claim: claim({ closed_at: at, close_reason: "ok" }), nowMs: at }), "closed_ok");
  assert.equal(deriveClaimState({ claim: claim({ closed_at: at, close_reason: "failed" }), nowMs: at }), "closed_failed");
  assert.equal(deriveClaimState({ claim: claim({ closed_at: at, close_reason: "cancelled" }), nowMs: at }), "closed_cancelled");
  assert.equal(deriveClaimState({ claim: claim({ closed_at: at, close_reason: "interrupted" }), nowMs: at }), "dead");
  assert.equal(deriveClaimState({ claim: claim({ closed_at: at, close_reason: "lease_expired" }), nowMs: at }), "dead");
  assert.equal(deriveClaimState({ claim: claim({ closed_at: at, close_reason: "mystery" }), nowMs: at }), "undetermined");
});

test("derive: no claim — the four absences stay four different answers", () => {
  // ① the attempt predates the contract: absence is expected, not a fault
  assert.equal(deriveClaimState({ claim: null, nowMs: T, contractEpochMs: T + 1, startedAt: T }), "pre_contract");
  // ② the engine says it never started
  assert.equal(deriveClaimState({ claim: null, nowMs: T, everDispatched: false }), "never_dispatched");
  // ③ the engine says it DID start but there is no claim → a writer fault
  assert.equal(deriveClaimState({ claim: null, nowMs: T, everDispatched: true }), "undetermined");
  // ④ no evidence either way: say so rather than pick the comfortable answer
  assert.equal(deriveClaimState({ claim: null, nowMs: T }), "undetermined");
});

test("derive: the contract epoch is not retroactive when the attempt postdates it", () => {
  // An attempt AFTER the contract with no claim is a fault, not pre-contract.
  assert.equal(
    deriveClaimState({ claim: null, nowMs: T, contractEpochMs: T - 10_000, startedAt: T }),
    "undetermined",
  );
});
