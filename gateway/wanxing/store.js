// ── Wanxing facade persistence (add-wanxing-serving-api) ─────────────────────
//
// The facade's own SQLite file at the gateway data root (the same
// per-concern isolation rule as packs.db / share-tokens.db): the external
// usage ledger (v1's authoritative record for external turns — ADR-0014
// boundary settlement), the idempotency replay window, the per-agent caller
// allowlist, and the caller debt-suspension state. No key material is ever
// stored — callers' sub2api keys live in sub2api, the facade only caches
// probe verdicts in memory (see core.js).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export function createWanxingStore({ file }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");

  // Private-agent caller allowlist: sub2api user ids per agent slug. The
  // deployer manages membership on the pack deploy surface; admission checks
  // membership for private agents only (public agents admit any solvent key).
  db.exec(`CREATE TABLE IF NOT EXISTS wanxing_agent_callers (
    agent_slug TEXT NOT NULL,
    sub2api_user_id INTEGER NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (agent_slug, sub2api_user_id)
  )`);

  // Idempotency-Key replay window (scoped caller+agent+key): one row per
  // deduplicated message/send; `response` is the exact JSON-RPC doc replayed
  // verbatim. Rows age out of the window lazily on read.
  db.exec(`CREATE TABLE IF NOT EXISTS wanxing_requests (
    caller_id INTEGER NOT NULL,
    agent_slug TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    state TEXT NOT NULL,
    response TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (caller_id, agent_slug, idem_key)
  )`);

  // The external usage ledger — v1's authoritative record (spec:
  // platform-billing "external turns settle against the caller's key"). `id`
  // doubles as the settlement Idempotency-Key, so a retried deduction can
  // only ever land once. outcome=error rows are recorded but waived (no
  // charge): the caller got nothing for a platform-side failure.
  db.exec(`CREATE TABLE IF NOT EXISTS wanxing_usage (
    id TEXT PRIMARY KEY,
    caller_id INTEGER NOT NULL,
    caller_email TEXT NOT NULL DEFAULT '',
    agent_slug TEXT NOT NULL,
    idem_key TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    minutes_billed INTEGER NOT NULL,
    rate_usd REAL NOT NULL,
    settlement_status TEXT NOT NULL,
    settled_at INTEGER
  )`);

  // Caller debt state: consecutive settlement failures; a non-null
  // suspended_reason refuses admission until the billing gate passes again.
  db.exec(`CREATE TABLE IF NOT EXISTS wanxing_caller_state (
    user_id INTEGER PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    suspended_reason TEXT,
    updated_at INTEGER NOT NULL
  )`);

  const now = () => Date.now();

  return {
    close() {
      db.close();
    },

    // ── Allowlist ───────────────────────────────────────────────────────────
    allowlistHas(agentSlug, userId) {
      return Boolean(
        db.prepare(`SELECT 1 FROM wanxing_agent_callers WHERE agent_slug = ? AND sub2api_user_id = ?`).get(agentSlug, userId),
      );
    },
    allowlistList(agentSlug) {
      return db.prepare(`SELECT sub2api_user_id AS userId, email, added_at AS addedAt FROM wanxing_agent_callers WHERE agent_slug = ? ORDER BY added_at`).all(agentSlug);
    },
    allowlistAdd(agentSlug, userId, email) {
      db.prepare(`INSERT INTO wanxing_agent_callers (agent_slug, sub2api_user_id, email, added_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (agent_slug, sub2api_user_id) DO UPDATE SET email = excluded.email`).run(agentSlug, Number(userId), String(email || ""), now());
    },
    allowlistRemove(agentSlug, userId) {
      db.prepare(`DELETE FROM wanxing_agent_callers WHERE agent_slug = ? AND sub2api_user_id = ?`).run(agentSlug, Number(userId));
    },

    // ── Idempotency ─────────────────────────────────────────────────────────
    requestGet(callerId, agentSlug, idemKey) {
      return db.prepare(`SELECT * FROM wanxing_requests WHERE caller_id = ? AND agent_slug = ? AND idem_key = ?`).get(callerId, agentSlug, idemKey) ?? null;
    },
    requestStart(callerId, agentSlug, idemKey) {
      // Returns false when a row already exists (single-flight race loser).
      const res = db.prepare(`INSERT INTO wanxing_requests (caller_id, agent_slug, idem_key, state, created_at) VALUES (?, ?, ?, 'running', ?)
        ON CONFLICT DO NOTHING`).run(callerId, agentSlug, idemKey, now());
      return res.changes === 1;
    },
    requestFinish(callerId, agentSlug, idemKey, state, response) {
      db.prepare(`UPDATE wanxing_requests SET state = ?, response = ? WHERE caller_id = ? AND agent_slug = ? AND idem_key = ?`)
        .run(state, response == null ? null : String(response).slice(0, 256 * 1024), callerId, agentSlug, idemKey);
    },

    // ── Usage ledger ────────────────────────────────────────────────────────
    usageInsert(row) {
      db.prepare(`INSERT INTO wanxing_usage (id, caller_id, caller_email, agent_slug, idem_key, started_at, ended_at, duration_ms, outcome, minutes_billed, rate_usd, settlement_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.callerId, row.callerEmail || "", row.agentSlug, row.idemKey || "", row.startedAt, row.endedAt, row.durationMs, row.outcome, row.minutesBilled, row.rateUsd, row.settlementStatus);
    },
    usageMarkSettled(id) {
      db.prepare(`UPDATE wanxing_usage SET settlement_status = 'settled', settled_at = ? WHERE id = ?`).run(now(), id);
    },
    usagePending() {
      return db.prepare(`SELECT * FROM wanxing_usage WHERE settlement_status = 'pending' ORDER BY started_at`).all();
    },
    usageBoard() {
      const byCaller = db.prepare(`SELECT caller_id AS callerId, caller_email AS email, COUNT(*) AS turns, SUM(minutes_billed) AS minutes, SUM(CASE WHEN settlement_status != 'waived' THEN minutes_billed * rate_usd ELSE 0 END) AS usd,
        SUM(CASE WHEN settlement_status = 'pending' THEN 1 ELSE 0 END) AS pending FROM wanxing_usage GROUP BY caller_id ORDER BY usd DESC`).all();
      const byAgent = db.prepare(`SELECT agent_slug AS agent, COUNT(*) AS turns, SUM(minutes_billed) AS minutes, SUM(CASE WHEN settlement_status != 'waived' THEN minutes_billed * rate_usd ELSE 0 END) AS usd,
        SUM(CASE WHEN settlement_status = 'pending' THEN 1 ELSE 0 END) AS pending FROM wanxing_usage GROUP BY agent_slug ORDER BY usd DESC`).all();
      return { byCaller, byAgent };
    },

    // ── Caller debt state ───────────────────────────────────────────────────
    callerState(userId) {
      return db.prepare(`SELECT * FROM wanxing_caller_state WHERE user_id = ?`).get(Number(userId)) ?? null;
    },
    recordSettlementFailure(userId, reason) {
      db.prepare(`INSERT INTO wanxing_caller_state (user_id, consecutive_failures, suspended_reason, updated_at) VALUES (?, 1, NULL, ?)
        ON CONFLICT (user_id) DO UPDATE SET consecutive_failures = consecutive_failures + 1, updated_at = excluded.updated_at`)
        .run(Number(userId), now());
      return db.prepare(`SELECT consecutive_failures FROM wanxing_caller_state WHERE user_id = ?`).get(Number(userId)).consecutive_failures;
    },
    suspendCaller(userId, reason) {
      db.prepare(`INSERT INTO wanxing_caller_state (user_id, consecutive_failures, suspended_reason, updated_at) VALUES (?, 0, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET suspended_reason = excluded.suspended_reason, updated_at = excluded.updated_at`)
        .run(Number(userId), String(reason), now());
    },
    clearCaller(userId) {
      db.prepare(`UPDATE wanxing_caller_state SET consecutive_failures = 0, suspended_reason = NULL, updated_at = ? WHERE user_id = ?`).run(now(), Number(userId));
    },
  };
}
