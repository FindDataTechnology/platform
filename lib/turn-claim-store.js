// ── Turn claim storage (harden-agent-runtime-spine, agent-turn-claim D2) ────
//
// Where claim rows live, and why they are a table of their own.
//
// THE SPLIT IS FORCED BY AN EXISTING CONTRACT, not a preference:
//
//   `fd-agent-run/tools/export_platform.mjs` exports increments by the
//   `member_turn_events` AUTOINCREMENT id (`--after-id`). An UPDATE to a row
//   already exported therefore never reaches the central store — its id did not
//   move. And re-sending the whole row is refused by the projector's content
//   fingerprint as "history rewritten" (that exact collision is documented in
//   the exporter's header: 2026-11-14, two new columns changed every row's
//   digest at once).
//
//   ⇒ Mutable fields (heartbeat, terminal state, close time) may not live on
//     the result row. They live here; the result row stays append-only.
//
// Two more rules this file keeps:
//
//   • A claim is written BEFORE the attempt can do anything, and a failed write
//     fails the attempt. `appendClaim` returning `{ok:false}` is not a warning.
//   • Closing is one-way. `closeClaim` only writes when `closed_at IS NULL`, so
//     a race between the sweeper and the normal end path has exactly one
//     winner, and the loser reads the winner's answer instead of overwriting.
//
// Retention: claims are `permanent` (they are the only proof an attempt
// existed). The table is small — one row per attempt, a handful of columns.

import { deriveClaimState, HEARTBEAT_WRITE_MS, isTerminalReason, LEASE_MS } from "./turn-claim.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS turn_claims (
     turn_ref TEXT PRIMARY KEY,
     driver TEXT NOT NULL,
     source TEXT NOT NULL,
     run_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     fleet_id TEXT,
     member_id TEXT,
     session_id TEXT,
     carrier TEXT,
     carrier_instance TEXT,
     started_at INTEGER NOT NULL,
     heartbeat_at INTEGER,
     lease_expires_at INTEGER,
     closed_at INTEGER,
     close_reason TEXT,
     cancelled_by TEXT,
     runtime_fingerprint TEXT,
     runtime_fingerprint_parts TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_turn_claims_open ON turn_claims(closed_at, lease_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_claims_run ON turn_claims(run_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_claims_source ON turn_claims(source, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_claims_member ON turn_claims(member_id, started_at)`,
];

const rowToClaim = (r) =>
  r && {
    turn_ref: r.turn_ref,
    driver: r.driver,
    source: r.source,
    run_id: r.run_id,
    turn_id: r.turn_id,
    fleet_id: r.fleet_id,
    member_id: r.member_id,
    session_id: r.session_id,
    carrier: r.carrier,
    carrier_instance: r.carrier_instance,
    started_at: r.started_at,
    heartbeat_at: r.heartbeat_at,
    lease_expires_at: r.lease_expires_at,
    closed_at: r.closed_at,
    close_reason: r.close_reason,
    cancelled_by: r.cancelled_by,
    runtime_fingerprint: r.runtime_fingerprint,
    runtime_fingerprint_parts: r.runtime_fingerprint_parts ? safeParse(r.runtime_fingerprint_parts) : null,
  };

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null; // a corrupt parts blob is honest absence, never a partial guess
  }
}

/**
 * @param {object} p
 * @param {import("better-sqlite3").Database} p.db
 * @param {() => number} [p.now]
 * @param {(ev: object) => void} [p.emit]  claim lifecycle events (lease.expired …)
 */
export function createTurnClaimStore({ db, now = Date.now, emit = null }) {
  for (const sql of SCHEMA) db.exec(sql);
  const say = emit ?? (() => {});

  const insert = db.prepare(`
    INSERT INTO turn_claims (turn_ref, driver, source, run_id, turn_id, fleet_id, member_id, session_id,
                             carrier, carrier_instance, started_at, heartbeat_at, lease_expires_at,
                             runtime_fingerprint, runtime_fingerprint_parts)
    VALUES (@turn_ref, @driver, @source, @run_id, @turn_id, @fleet_id, @member_id, @session_id,
            @carrier, @carrier_instance, @started_at, @heartbeat_at, @lease_expires_at,
            @runtime_fingerprint, @runtime_fingerprint_parts)
    ON CONFLICT(turn_ref) DO NOTHING
  `);
  const getStmt = db.prepare("SELECT * FROM turn_claims WHERE turn_ref = ?");
  const beatStmt = db.prepare(
    "UPDATE turn_claims SET heartbeat_at = ?, lease_expires_at = ? WHERE turn_ref = ? AND closed_at IS NULL",
  );
  // One-way close: `closed_at IS NULL` in the predicate is what makes the
  // sweeper and the normal end path race safely.
  const closeStmt = db.prepare(
    "UPDATE turn_claims SET closed_at = ?, close_reason = ?, cancelled_by = ? WHERE turn_ref = ? AND closed_at IS NULL",
  );
  const fingerprintStmt = db.prepare(
    "UPDATE turn_claims SET runtime_fingerprint = ?, runtime_fingerprint_parts = ? WHERE turn_ref = ? AND runtime_fingerprint IS NULL",
  );
  const lapsedStmt = db.prepare(
    "SELECT * FROM turn_claims WHERE closed_at IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
  );

  // Coalesce heartbeats: a long turn beats often, persists at most every
  // HEARTBEAT_WRITE_MS. Keyed by turn_ref so N concurrent turns each keep
  // their own cadence.
  const lastWrite = new Map();

  /**
   * Write the claim. Idempotent by `turn_ref`: a re-entered attempt reuses the
   * row (spec: "认领幂等"). Returns `{ok, claim, reused}`.
   */
  function claim({ turnRef, driver, source, runId, turnId, fleetId = null, memberId = null, sessionId = null, carrier = null, carrierInstance = null, startedAt = now(), runtimeFingerprint = null, runtimeFingerprintParts = null }) {
    const t = Number(startedAt);
    try {
      insert.run({
        turn_ref: turnRef,
        driver,
        source,
        run_id: runId,
        turn_id: turnId,
        fleet_id: fleetId,
        member_id: memberId,
        session_id: sessionId,
        carrier,
        carrier_instance: carrierInstance,
        started_at: t,
        heartbeat_at: t,
        lease_expires_at: t + LEASE_MS,
        runtime_fingerprint: runtimeFingerprint,
        runtime_fingerprint_parts: runtimeFingerprintParts ? JSON.stringify(runtimeFingerprintParts) : null,
      });
    } catch (e) {
      return { ok: false, reason: "claim-write-failed", error: e?.message || String(e) };
    }
    const row = rowToClaim(getStmt.get(turnRef));
    // Reuse is the conflict path: the fingerprint is write-once for the same
    // reason the version counter is (a second, different fingerprint on one
    // attempt means the attempt was re-materialized under a different config —
    // an event worth failing loudly on, not silently overwriting).
    if (row && runtimeFingerprint && !row.runtime_fingerprint) {
      fingerprintStmt.run(runtimeFingerprint, runtimeFingerprintParts ? JSON.stringify(runtimeFingerprintParts) : null, turnRef);
    }
    return { ok: true, claim: row, reused: row?.started_at != null && Number(row.started_at) !== t };
  }

  /** Record the fingerprint for an already-claimed attempt (write-once). */
  function setFingerprint(turnRef, bundleFp, parts = null) {
    if (!bundleFp) return { ok: false, reason: "fingerprint-required" };
    const info = fingerprintStmt.run(bundleFp, parts ? JSON.stringify(parts) : null, turnRef);
    return { ok: info.changes > 0, applied: info.changes > 0, current: rowToClaim(getStmt.get(turnRef))?.runtime_fingerprint ?? null };
  }

  /**
   * Renew liveness. Coalesced (see HEARTBEAT_WRITE_MS) and refused once closed —
   * a late beat must not revive a closed attempt (that is how two holders start).
   */
  function heartbeat(turnRef, { nowMs = now() } = {}) {
    const t = Number(nowMs);
    const prev = lastWrite.get(turnRef);
    if (prev != null && t - prev < HEARTBEAT_WRITE_MS) {
      return { ok: true, coalesced: true };
    }
    const info = beatStmt.run(t, t + LEASE_MS, turnRef);
    if (info.changes === 0) {
      return { ok: false, reason: "closed-or-missing" };
    }
    lastWrite.set(turnRef, t);
    return { ok: true, coalesced: false };
  }

  /**
   * Close the attempt. One-way; the loser of a race reads the winner's answer.
   * A reason outside the vocabulary is refused outright (spec: closed set).
   */
  function close(turnRef, { reason, at = now(), cancelledBy = null } = {}) {
    if (!isTerminalReason(reason)) return { ok: false, reason: "invalid-terminal-reason", got: reason };
    const info = closeStmt.run(Number(at), reason, cancelledBy, turnRef);
    lastWrite.delete(turnRef);
    return { ok: true, applied: info.changes > 0, claim: rowToClaim(getStmt.get(turnRef)) };
  }

  function get(turnRef) {
    return rowToClaim(getStmt.get(turnRef));
  }

  /** Claims of one run, oldest first — the run's attempt history. */
  function listByRun(runId) {
    return db
      .prepare("SELECT * FROM turn_claims WHERE run_id = ? ORDER BY started_at ASC")
      .all(runId)
      .map(rowToClaim);
  }

  /**
   * The sweeper. Lapsed-and-open claims close as `lease_expired` and produce a
   * visible event. This is the ONLY place expiry becomes a fact.
   *
   * Returns the claims it closed (so a caller can act on them, e.g. settle a
   * run header as interrupted).
   */
  function sweep({ nowMs = now() } = {}) {
    const t = Number(nowMs);
    const rows = lapsedStmt.all(t).map(rowToClaim);
    const closed = [];
    for (const row of rows) {
      const info = closeStmt.run(t, "lease_expired", null, row.turn_ref);
      if (info.changes === 0) continue; // somebody else closed it first
      lastWrite.delete(row.turn_ref);
      closed.push(rowToClaim(getStmt.get(row.turn_ref)));
      say({
        kind: "lease.expired",
        turn_ref: row.turn_ref,
        source: row.source,
        run_id: row.run_id,
        turn_id: row.turn_id,
        last_heartbeat_at: row.heartbeat_at ?? null,
        held_ms: t - Number(row.started_at ?? t),
        closed_at: t,
      });
    }
    return closed;
  }

  /** The derivation's input, with the store's own "could not read" collapse. */
  function stateOf(turnRef, { nowMs = now(), contractEpochMs = null, everDispatched = null, startedAt = null } = {}) {
    let row;
    try {
      row = get(turnRef);
    } catch {
      return "indeterminate";
    }
    return deriveClaimState({ claim: row, nowMs, contractEpochMs, everDispatched, startedAt });
  }

  /** Open claims (optionally for one carrier) — the board's "what is running". */
  function listOpen({ source = null, limit = 500 } = {}) {
    const args = [];
    let where = "closed_at IS NULL";
    if (source) {
      where += " AND source = ?";
      args.push(source);
    }
    return db
      .prepare(`SELECT * FROM turn_claims WHERE ${where} ORDER BY started_at ASC LIMIT ?`)
      .all(...args, limit)
      .map(rowToClaim);
  }

  return { claim, setFingerprint, heartbeat, close, get, listByRun, listOpen, sweep, stateOf };
}
