// ── Task flow storage (add-task-flow) ───────────────────────────────────────
//
// Flow declarations and card dependencies. A separate sqlite file beside
// fleets.db, on purpose (design D6): a flow is low-frequency shared config,
// while task records are a high-frequency single-writer chain — putting them in
// the same store would make every flow read queue behind task writes.
//
// NOT app.db's MIGRATIONS chain: that chain belongs to app.db, and a table
// here has a different lifecycle (this file can be deleted and recreated
// without touching a single session, ledger row or credential).
//
// Pattern mirrors clusters-db.js: CREATE TABLE IF NOT EXISTS at open, snake_case
// columns, camelCase at the API edge, WAL.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { storeDir } from "../paths.js";

export function createTaskFlowDatabase({ file } = {}) {
  const dbPath = file || path.join(storeDir("data"), "task-flows.db");

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS task_flows (
    flow_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    stations TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // Card dependencies (task-flow-board: blockedBy). The dependant is a TASK id,
  // because a card IS a task (design D1) — a separate card table would be a
  // second writable truth about the same thing.
  db.exec(`CREATE TABLE IF NOT EXISTS task_card_deps (
    task_id TEXT NOT NULL,
    blocked_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, blocked_by)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_card_deps_blocked_by ON task_card_deps(blocked_by)`);

  // Reassignment trail. NOT in the task's history[] on purpose: that array is
  // EXECUTION history, and history-kinds.js records the day a well-meant note
  // there turned a 38.3% failure rate into a reported 62.1%. A reassignment is
  // not an attempt, so it lives in its own append-only table with the card.
  db.exec(`CREATE TABLE IF NOT EXISTS task_flow_reassignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    from_flow TEXT,
    from_station TEXT,
    to_flow TEXT,
    to_station TEXT,
    actor TEXT,
    reason TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_flow_reassign_task ON task_flow_reassignments(task_id, at)`);

  const rowToFlow = (row) => ({
    flowId: row.flow_id,
    name: row.name,
    stations: safeParse(row.stations, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    db,

    listFlows() {
      return db.prepare("SELECT * FROM task_flows ORDER BY flow_id").all().map(rowToFlow);
    },

    getFlow(flowId) {
      const row = db.prepare("SELECT * FROM task_flows WHERE flow_id = ?").get(flowId);
      return row ? rowToFlow(row) : null;
    },

    /** Insert or replace a declaration. The caller validates first; this only stores. */
    putFlow(flow) {
      const now = Date.now();
      const existing = db.prepare("SELECT created_at FROM task_flows WHERE flow_id = ?").get(flow.flowId);
      db.prepare(
        `INSERT INTO task_flows (flow_id, name, stations, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(flow_id) DO UPDATE SET name = excluded.name, stations = excluded.stations, updated_at = excluded.updated_at`,
      ).run(flow.flowId, flow.name, JSON.stringify(flow.stations ?? []), existing?.created_at ?? now, now);
      return this.getFlow(flow.flowId);
    },

    deleteFlow(flowId) {
      return db.prepare("DELETE FROM task_flows WHERE flow_id = ?").run(flowId).changes > 0;
    },

    /** Declared blockers for one card. */
    blockersOf(taskId) {
      return db.prepare("SELECT blocked_by FROM task_card_deps WHERE task_id = ? ORDER BY created_at").all(taskId).map((r) => r.blocked_by);
    },

    /** Which cards this one is holding up (reverse lookup, for "now unblocked" waves). */
    dependantsOf(taskId) {
      return db.prepare("SELECT task_id FROM task_card_deps WHERE blocked_by = ?").all(taskId).map((r) => r.task_id);
    },

    addDeps(taskId, blockedBy = []) {
      const stmt = db.prepare("INSERT OR IGNORE INTO task_card_deps (task_id, blocked_by, created_at) VALUES (?, ?, ?)");
      const now = Date.now();
      const tx = db.transaction((ids) => { for (const id of ids) if (id && id !== taskId) stmt.run(taskId, id, now); });
      tx(blockedBy);
      return this.blockersOf(taskId);
    },

    clearDeps(taskId) {
      db.prepare("DELETE FROM task_card_deps WHERE task_id = ?").run(taskId);
    },

    /** Append one reassignment. Append-only: nothing here is ever updated. */
    recordReassignment({ taskId, from, to, actor = null, reason = null }) {
      db.prepare(
        `INSERT INTO task_flow_reassignments (task_id, at, from_flow, from_station, to_flow, to_station, actor, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        Date.now(),
        from?.flowId ?? null,
        from?.stationId ?? null,
        to?.flowId ?? null,
        to?.stationId ?? null,
        actor,
        reason,
      );
    },

    reassignmentsOf(taskId) {
      return db.prepare("SELECT * FROM task_flow_reassignments WHERE task_id = ? ORDER BY at, id").all(taskId).map((r) => ({
        at: r.at,
        from: { flowId: r.from_flow, stationId: r.from_station },
        to: { flowId: r.to_flow, stationId: r.to_station },
        actor: r.actor,
        reason: r.reason,
      }));
    },
  };
}

function safeParse(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    // A corrupt stations blob must not take the whole flow list down — that
    // would make one bad row look like "there are no flows".
    return fallback;
  }
}

let flowDb = null;
export function getTaskFlowDatabase() {
  if (!flowDb) flowDb = createTaskFlowDatabase({});
  return flowDb;
}
export function setTaskFlowDatabase(db) {
  flowDb = db;
}
