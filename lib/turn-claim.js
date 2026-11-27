// ── Turn claim (harden-agent-runtime-spine, agent-turn-claim) ────────────────
//
// "This attempt exists" as a fact that outlives the process executing it.
//
// The gap this closes, in one line: a turn's ledger row is written at the END
// (`server/fleet-events.js::recordTurnEvent`), so a pod roll mid-turn leaves
// nothing on disk — the run header stays open with 0 turns and the orphan
// sweep later guesses `failed`, when the truth is "interrupted, re-runnable".
//
// Four rules here, each with the failure it prevents:
//
//   1. THE CLAIM COMES FIRST. It is written before the attempt can produce any
//      side effect. A claim that cannot be written fails the attempt loudly;
//      executing without one is indistinguishable from "never happened".
//   2. LIVENESS IS A HEARTBEAT, NOT AN INFERENCE. `heartbeat_at` is renewed at
//      a bounded interval; a lapsed lease is CLOSED as `lease_expired` by the
//      sweeper. Nobody answers "is it alive" by subtracting timestamps.
//   3. THE TERMINAL SET IS CLOSED and separates "stopped from outside" from
//      "ran to a bad conclusion". `interrupted` / `lease_expired` are not
//      failures and must not sit in a failure-rate denominator.
//   4. CLAIM AND MEASUREMENT ARE SEPARATE TABLES. Claim fields are mutable and
//      small; result rows are append-only because the export contract is
//      id-based increments (an UPDATE to an exported row is never re-sent, and
//      re-sending the whole row is refused as a rewrite). See
//      `lib/turn-claim-store.js` for the schema and that reasoning in place.
//
// This module is pure: vocabulary, the address, and the state derivation. No
// I/O, no clock of its own — `nowMs` is always an argument.

import { createHash } from "node:crypto";

export const TERMINAL_REASONS = Object.freeze(["ok", "failed", "interrupted", "cancelled", "lease_expired"]);

/** Terminal reasons that must NOT count as failures in any rate. */
export const NOT_A_FAILURE = Object.freeze(["interrupted", "lease_expired", "cancelled"]);

export const DRIVERS = Object.freeze(["platform", "crew"]);

// The read-face vocabulary. Every consumer (board, console, task query) renders
// these; nothing re-derives liveness on its own.
export const CLAIM_STATES = Object.freeze([
  "closed_ok",
  "closed_failed",
  "closed_cancelled",
  "dead", // closed as interrupted / lease_expired
  "running", // claim open, heartbeat inside the conservative threshold
  "stalled", // claim open, heartbeat old but lease not yet lapsed
  "lease_passed", // claim open past its lease; the sweeper owes a close
  "never_dispatched", // no claim, and the caller has evidence it never started
  "undetermined", // no claim on an attempt we know started — a writer fault
  "pre_contract", // the attempt predates the claim contract; absence is expected
  "indeterminate", // the claim store could not be read at all
]);

// Heartbeat cadence and the lease that bounds it. Declared here and nowhere
// else: two copies of these numbers is how "the board says dead, the sweeper
// says alive" starts.
export const HEARTBEAT_MS = Number(process.env.TURN_CLAIM_HEARTBEAT_MS) || 30_000;
export const LEASE_MS = Number(process.env.TURN_CLAIM_LEASE_MS) || 3 * HEARTBEAT_MS;
// "Stalled" is deliberately earlier than "lease_passed": an operator wants to
// see "this has not beaten in two intervals" before the sweeper acts on it.
export const STALL_MS = Number(process.env.TURN_CLAIM_STALL_MS) || 2 * HEARTBEAT_MS;
// Writes are coalesced: a 10-minute turn beats 20 times but persists at most
// one heartbeat per interval.
// shortcut: lease accuracy is ±half a heartbeat, ample against a 3× heartbeat
// lease; revisit if a caller ever needs sub-second liveness.
export const HEARTBEAT_WRITE_MS = Math.max(1_000, Math.floor(HEARTBEAT_MS / 2));

/**
 * The claim contract's start. Turns that began before it legitimately have no
 * claim; reporting them as `never_dispatched` would fabricate a fact.
 * Set at deploy time (see the change's migration plan); overridable in tests.
 */
export function contractEpochMs(env = process.env) {
  const raw = env.TURN_CLAIM_CONTRACT_EPOCH;
  if (!raw) return null;
  if (/^\d+$/.test(String(raw))) return Number(raw);
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/** `driver|source|run_id|turn_id` — the one address shared by every read face. */
export function turnRefFor({ driver, source, runId, turnId }) {
  const parts = [driver, source, runId, turnId].map((v) => (v == null ? "" : String(v)));
  if (!parts[0] || !parts[1] || !parts[2] || !parts[3]) return null;
  return parts.join("|");
}

export function parseTurnRef(ref) {
  const parts = String(ref ?? "").split("|");
  if (parts.length !== 4 || parts.some((p) => !p)) return null;
  const [driver, source, runId, turnId] = parts;
  return { driver, source, runId, turnId };
}

const CELL_SHAPE = /^cell:([0-9a-f]{8,})$/;
const CREW_SHAPE = /^project:([^@]+)@(.+)$/;

/**
 * The carrier identity: `cell:<16 hex>` for platform, `project:<repo>@<host>`
 * for crew.
 *
 * The hex is `sha256(email).slice(0,16)` — the SAME derivation
 * `gateway/spawner.js::userIdFor` uses for `/data/cells/<hex>`, which is also
 * what `export_platform.mjs --cell` is handed. Two derivations of that hex is
 * how one cell's runs get attributed to another, so both sides import THIS
 * function (spawner keeps its own copy only for its existing callers, and
 * `scripts/test-turn-claim.mjs` pins the two equal).
 */
export function cellSourceFor({ email = null, single = false } = {}) {
  // A single-tenant deployment has no tenant email; `local` is the honest key
  // and it matches what `team-card.js::cellIdFor` produces for the empty case
  // (minus its `cell-` prefix, which is a different namespace on purpose).
  const key = single || !email ? "local" : String(email).trim().toLowerCase();
  return `cell:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function crewSourceFor({ repo, host }) {
  const r = String(repo ?? "").trim();
  const h = String(host ?? "").trim();
  if (!r || !h) return null;
  return `project:${r}@${h}`;
}

/** Carrier shape is a two-sided contract: writers and readers apply the same test. */
export function isCarrierShaped(source) {
  return typeof source === "string" && (CELL_SHAPE.test(source) || CREW_SHAPE.test(source));
}

/** The hex inside a well-shaped `cell:` source, or null. */
export function cellHexOf(source) {
  const m = CELL_SHAPE.exec(String(source ?? ""));
  return m ? m[1] : null;
}

/** Terminal reason validation: a closed claim can only hold a vocabulary value. */
export function isTerminalReason(reason) {
  return TERMINAL_REASONS.includes(reason);
}

/** Does this terminal reason count as a failure in a rate? (no for the three) */
export function countsAsFailure(reason) {
  return reason === "failed";
}

/**
 * The one derivation of "what is the state of this attempt right now".
 *
 * @param {object} p
 * @param {object|null} p.claim              the claim row, or null when absent
 * @param {number} p.nowMs
 * @param {number|null} [p.contractEpochMs]  when the claim contract started
 * @param {boolean|null} [p.everDispatched]  caller evidence (engine task state);
 *                                           null = no evidence either way
 * @param {number|null} [p.startedAt]        for the pre-contract test
 */
export function deriveClaimState({ claim, nowMs, contractEpochMs = null, everDispatched = null, startedAt = null }) {
  const t = Number(nowMs);
  if (claim) {
    if (claim.closed_at != null) {
      const r = claim.close_reason;
      if (r === "ok") return "closed_ok";
      if (r === "failed") return "closed_failed";
      if (r === "cancelled") return "closed_cancelled";
      if (r === "interrupted" || r === "lease_expired") return "dead";
      // A reason outside the vocabulary is not guessable into one.
      return "undetermined";
    }
    const beat = Number(claim.heartbeat_at ?? claim.started_at ?? 0);
    const lease = Number(claim.lease_expires_at ?? 0);
    if (lease && t >= lease) return "lease_passed";
    if (t - beat >= STALL_MS) return "stalled";
    return "running";
  }
  // No claim. Three different situations, three different answers.
  if (contractEpochMs != null && startedAt != null && Number(startedAt) < Number(contractEpochMs)) {
    return "pre_contract";
  }
  if (everDispatched === true) return "undetermined";
  if (everDispatched === false) return "never_dispatched";
  // No evidence either way: say so rather than pick the comfortable answer.
  return "undetermined";
}

/** Closed states, for "is this attempt over". */
export function isClosedState(state) {
  return state === "closed_ok" || state === "closed_failed" || state === "closed_cancelled" || state === "dead";
}

/** States an open claim can be in. */
export function isOpenState(state) {
  return state === "running" || state === "stalled" || state === "lease_passed";
}

/** States that must make a board or a health read unhealthy. */
export function isUnhealthyState(state) {
  return state === "undetermined" || state === "indeterminate" || state === "stalled" || state === "lease_passed";
}
