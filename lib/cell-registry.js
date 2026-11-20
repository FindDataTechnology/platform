// ── Cell registry: row schema + idempotent boot migration (add-cell-lifecycle)
//
// The durable registry record an executor keeps per cell. Storage is the
// executor's own (gateway: its SQLite; steward: a JSON ledger beside the data
// root) — this module owns the SHAPE and the forward-only migration applied
// at boot, never where the bytes live.

import fs from "node:fs";

export const REGISTRY_SCHEMA_VERSION = 2;

export function newRegistryRow({ cellId, ownerEmail = null, policy = "on_demand", now = Date.now() }) {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    cellId,
    ownerEmail,
    state: "unbound",
    policy,
    workload: { cronCount: 0, botCount: 0, fleetCount: 0, nextDueAt: null },
    lastUserTrafficAt: null,
    lastDutyRunAt: null,
    lastBoundAt: null,
    // Memory-gate refusal evidence (harden-platform-memory-carrier): the last
    // residency refusal's four-tuple (usage/limit/headroom/threshold) + at.
    // Never a lifecycle transition — a refused residency leaves state where it
    // was; this is the operator-visible trace next to spawn/wake/suspend.
    lastGateRefusal: null,
    // Wake-footprint archive (harden-cell-wake-admission): the cell's
    // calibrated memory contribution at its last complete residency, sampled
    // at park time. Null = no archive (never parked since rollout, or the
    // sampler had nothing to read) — admission then degrades to current-only.
    lastFootprintBytes: null,
    // Crash ledger (add-cell-crash-ledger): crashes are the one cell event that
    // used to leave NO durable trace beyond a console line, so "is this cell
    // stable?" was unanswerable. crashCount counts non-deliberate exits inside
    // the crash window; lastCrash keeps the most recent scene even after the
    // count resets on rehabilitation. bindFailure* is the separate "came up but
    // never listened" failure — different cause, different handling.
    crashCount: 0,
    lastCrash: null,
    bindFailureCount: 0,
    lastBindFailure: null,
    destroy: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Forward-only, idempotent: v0 (absent) → v1 by default fill. Later versions
// append one step each and never rewrite earlier ones.
export function migrateRegistryRow(row, now = Date.now()) {
  if (!row || typeof row !== "object") return null;
  if (row.schemaVersion === REGISTRY_SCHEMA_VERSION) return { row, changed: false };
  const migrated = {
    ...newRegistryRow({ cellId: row.cellId ?? "unknown", now }),
    ...row,
    workload: { cronCount: 0, botCount: 0, fleetCount: 0, nextDueAt: null, ...(row.workload ?? {}) },
    schemaVersion: REGISTRY_SCHEMA_VERSION,
  };
  return { row: migrated, changed: true };
}

// JSON-ledger persistence for executors without a SQLite surface (the desktop
// steward). Atomic write (tmp+rename) so a crash mid-write never halves a row.
export function createJsonRegistry({ file }) {
  let rows = new Map();
  const load = () => {
    rows = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const r of Array.isArray(parsed) ? parsed : []) {
        const m = migrateRegistryRow(r);
        if (m) rows.set(m.row.cellId, m.row);
      }
    } catch { /* missing/corrupt → start empty, never block boot on the ledger */ }
    return rows;
  };
  const persist = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...rows.values()], null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    load,
    get: (cellId) => rows.get(cellId) ?? null,
    put: (row) => { rows.set(row.cellId, { ...row, updatedAt: Date.now() }); persist(); return rows.get(row.cellId); },
    all: () => [...rows.values()],
  };
}
