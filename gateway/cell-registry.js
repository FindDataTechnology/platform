// ── Gateway cell registry, durable (add-cell-lifecycle 3.1) ────────────────
//
// SQLite twin of the steward's JSON ledger: one row per cell, ONE file at
// <CELL_DATA_ROOT>/cells-registry.db (never inside packs.db — that store has
// its own owner and schema cadence). Row shape and migrations come from
// lib/cell-registry.js; lifecycle words come from lib/cell-lifecycle.js.
// Everything a gateway restart needs to rebuild the demand surface is HERE —
// never in the process (spec: roll must go quiet→complete without traffic).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrateRegistryRow, newRegistryRow, REGISTRY_SCHEMA_VERSION } from "../lib/cell-registry.js";
import { transition } from "../lib/cell-lifecycle.js";

const DDL = `
CREATE TABLE IF NOT EXISTS cell_registry (
  cell_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  owner_email TEXT,
  state TEXT NOT NULL,
  policy TEXT NOT NULL,
  workload_json TEXT NOT NULL DEFAULT '{}',
  last_user_traffic_at INTEGER,
  last_duty_run_at INTEGER,
  last_bound_at INTEGER,
  destroy_reason TEXT,
  destroy_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export function createCellRegistryDb({ file }) {
  // The durable registry is the gateway's first write to CELL_DATA_ROOT — on a
  // cold deployment (or a test boot) that directory may not exist yet, and
  // better-sqlite3 throws "directory does not exist" rather than creating it.
  // Same discipline as createPackRegistry/createShareRegistry above.
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(DDL);
  // Memory-gate refusal evidence on pre-existing databases (harden-platform-
  // memory-carrier): same guarded-add pattern as packs.js curation columns.
  try {
    db.exec(`ALTER TABLE cell_registry ADD COLUMN last_gate_refusal_json TEXT`);
  } catch { /* column already present */ }
  // Wake-footprint archive (harden-cell-wake-admission): same guarded-add
  // pattern — the column rides every put, older files just gain it.
  try {
    db.exec(`ALTER TABLE cell_registry ADD COLUMN last_footprint_bytes INTEGER`);
  } catch { /* column already present */ }
  // Footprint freshness (fix-stale-wake-footprint): WHEN the archive was taken.
  // Without it an archive is evidence with no expiry, so a high-water mark from
  // a heavier era keeps refusing the wake that would re-measure it — the cell
  // can never come back to correct its own record (live 2026-11-08: 2.0GB
  // archived against 755/788MB peers, headroom -28.1%, cell dark for ~40min).
  try {
    db.exec(`ALTER TABLE cell_registry ADD COLUMN last_footprint_at INTEGER`);
  } catch { /* column already present */ }
  // Crash ledger (add-cell-crash-ledger): same guarded-add pattern. Counters are
  // Integer with 0 default at read (older rows read as no-crash), scenes are JSON.
  for (const ddl of [
    "ALTER TABLE cell_registry ADD COLUMN crash_count INTEGER",
    "ALTER TABLE cell_registry ADD COLUMN last_crash_json TEXT",
    "ALTER TABLE cell_registry ADD COLUMN bind_failure_count INTEGER",
    "ALTER TABLE cell_registry ADD COLUMN last_bind_failure_json TEXT",
  ]) {
    try { db.exec(ddl); } catch { /* column already present */ }
  }

  const serialize = (row) => ({
    cell_id: row.cellId,
    schema_version: row.schemaVersion,
    owner_email: row.ownerEmail ?? null,
    state: row.state,
    policy: row.policy,
    workload_json: JSON.stringify(row.workload ?? {}),
    last_user_traffic_at: row.lastUserTrafficAt ?? null,
    last_duty_run_at: row.lastDutyRunAt ?? null,
    last_bound_at: row.lastBoundAt ?? null,
    destroy_reason: row.destroy?.reason ?? null,
    destroy_at: row.destroy?.at ?? null,
    last_gate_refusal_json: row.lastGateRefusal ? JSON.stringify(row.lastGateRefusal) : null,
    last_footprint_bytes: Number.isFinite(row.lastFootprintBytes) ? row.lastFootprintBytes : null,
    last_footprint_at: Number.isFinite(row.lastFootprintAt) ? row.lastFootprintAt : null,
    crash_count: Number.isFinite(row.crashCount) ? row.crashCount : 0,
    last_crash_json: row.lastCrash ? JSON.stringify(row.lastCrash) : null,
    bind_failure_count: Number.isFinite(row.bindFailureCount) ? row.bindFailureCount : 0,
    last_bind_failure_json: row.lastBindFailure ? JSON.stringify(row.lastBindFailure) : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
  const deserialize = (r) => {
    if (!r) return null;
    let lastGateRefusal = null;
    try { lastGateRefusal = r.last_gate_refusal_json ? JSON.parse(r.last_gate_refusal_json) : null; } catch { /* torn write → absent */ }
    // Crash scenes: a torn write loses the scene, never the count's meaning.
    let lastCrash = null;
    try { lastCrash = r.last_crash_json ? JSON.parse(r.last_crash_json) : null; } catch { /* torn write → absent */ }
    let lastBindFailure = null;
    try { lastBindFailure = r.last_bind_failure_json ? JSON.parse(r.last_bind_failure_json) : null; } catch { /* torn write → absent */ }
    return migrateRegistryRow({
      cellId: r.cell_id,
      ownerEmail: r.owner_email,
      state: r.state,
      policy: r.policy,
      workload: JSON.parse(r.workload_json || "{}"),
      lastUserTrafficAt: r.last_user_traffic_at,
      lastDutyRunAt: r.last_duty_run_at,
      lastBoundAt: r.last_bound_at,
      destroy: r.destroy_reason || r.destroy_at ? { reason: r.destroy_reason, at: r.destroy_at } : null,
      lastGateRefusal,
      lastFootprintBytes: Number.isFinite(r.last_footprint_bytes) ? r.last_footprint_bytes : null,
      lastFootprintAt: Number.isFinite(r.last_footprint_at) ? r.last_footprint_at : null,
      crashCount: Number.isFinite(r.crash_count) ? r.crash_count : 0,
      lastCrash,
      bindFailureCount: Number.isFinite(r.bind_failure_count) ? r.bind_failure_count : 0,
      lastBindFailure,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })?.row ?? null;
  };

  return {
    get(cellId) {
      return deserialize(db.prepare("SELECT * FROM cell_registry WHERE cell_id = ?").get(cellId));
    },
    all() {
      return db.prepare("SELECT * FROM cell_registry ORDER BY created_at").all().map(deserialize).filter(Boolean);
    },
    put(row) {
      const s = serialize({ ...row, schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: Date.now() });
      db.prepare(`
        INSERT INTO cell_registry (cell_id, schema_version, owner_email, state, policy, workload_json,
          last_user_traffic_at, last_duty_run_at, last_bound_at, destroy_reason, destroy_at, last_gate_refusal_json, last_footprint_bytes, last_footprint_at,
          crash_count, last_crash_json, bind_failure_count, last_bind_failure_json, created_at, updated_at)
        VALUES (@cell_id, @schema_version, @owner_email, @state, @policy, @workload_json,
          @last_user_traffic_at, @last_duty_run_at, @last_bound_at, @destroy_reason, @destroy_at, @last_gate_refusal_json, @last_footprint_bytes, @last_footprint_at,
          @crash_count, @last_crash_json, @bind_failure_count, @last_bind_failure_json, @created_at, @updated_at)
        ON CONFLICT(cell_id) DO UPDATE SET
          schema_version=excluded.schema_version, owner_email=COALESCE(excluded.owner_email, cell_registry.owner_email),
          state=excluded.state, policy=excluded.policy, workload_json=excluded.workload_json,
          last_user_traffic_at=COALESCE(excluded.last_user_traffic_at, cell_registry.last_user_traffic_at),
          last_duty_run_at=COALESCE(excluded.last_duty_run_at, cell_registry.last_duty_run_at),
          last_bound_at=COALESCE(excluded.last_bound_at, cell_registry.last_bound_at),
          destroy_reason=excluded.destroy_reason, destroy_at=excluded.destroy_at,
          last_gate_refusal_json=excluded.last_gate_refusal_json, last_footprint_bytes=excluded.last_footprint_bytes,
          last_footprint_at=COALESCE(excluded.last_footprint_at, cell_registry.last_footprint_at),
          crash_count=excluded.crash_count, last_crash_json=COALESCE(excluded.last_crash_json, cell_registry.last_crash_json),
          bind_failure_count=excluded.bind_failure_count,
          last_bind_failure_json=COALESCE(excluded.last_bind_failure_json, cell_registry.last_bind_failure_json),
          updated_at=excluded.updated_at
      `).run(s);
      return this.get(row.cellId);
    },
    // One lifecycle step: read → transition → persist. Returns the same
    // { state, actions } the executor then performs (spawn/drain/…).
    fire(cellId, event, { policy = null } = {}) {
      const current = this.get(cellId);
      const chosenPolicy = current?.policy ?? policy ?? "on_demand";
      const t = transition(current ?? (event.type === "register" ? null : newRegistryRow({ cellId, ownerEmail: event.ownerEmail ?? null, policy: chosenPolicy })), event);
      if (t.error) return { error: t.error, row: current };
      const persisted = this.put({
        // First-ever contact materializes a full row; beats on it only move
        // the lifecycle fields the transition changed.
        ...(current ? t.row : newRegistryRow({ cellId, policy: chosenPolicy })),
        ...t.row,
        cellId,
        policy: t.row.policy ?? chosenPolicy,
        ownerEmail: t.row.ownerEmail ?? event.ownerEmail ?? current?.ownerEmail ?? null,
      });
      return { state: t.state, actions: t.actions, row: persisted };
    },
    close() { db.close(); },
  };
}
