// [PROTOTYPE · 非权威] fleet-blueprint-studio Slice 1
// apply 时落点：server/routes/blueprints-db.js（import 路径保持现状即可）
//
// Blueprint persistence, factory-injected like fleets-db.js (repo convention):
//   const db = createBlueprintDatabase();            // production default file
//   const db = createBlueprintDatabase({ file });    // tests: tmp sqlite path
// No environment variable decides storage — the caller owns the file choice.

import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { storeDir } from "../../paths.js";

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS blueprints (
        id TEXT PRIMARY KEY,
        owner_email TEXT NOT NULL,
        name TEXT NOT NULL,
        one_line TEXT NOT NULL DEFAULT '',
        out_of_scope TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        approved_by TEXT,
        approved_at TEXT,
        diff_summary TEXT,
        cast_pack_id TEXT,
        cast_pack_version INTEGER,
        trial_report_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS blueprints_owner_idx ON blueprints(owner_email, updated_at DESC)`,
    ],
  },
];

function runMigrations(db) {
  const run = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
    const current = row?.v ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      for (const sql of m.statements) db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
    }
  });
  run();
}

// Factory-first signature mirrors server/routes/fleets-db.js createFleetDatabase.
export function createBlueprintDatabase({ file } = {}) {
  const dbPath = file || path.join(storeDir("data"), "blueprints.db");
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export function blueprintId() {
  return `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listBlueprints(db, ownerEmail) {
  return db
    .prepare("SELECT * FROM blueprints WHERE owner_email = ? ORDER BY updated_at DESC")
    .all(ownerEmail);
}

export function getBlueprint(db, id) {
  return db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) ?? null;
}

export function createBlueprint(db, { ownerEmail, name, oneLine, outOfScope, contentJson }) {
  const id = blueprintId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO blueprints (id, owner_email, name, one_line, out_of_scope, content_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerEmail, name ?? "", oneLine ?? "", outOfScope ?? "", contentJson, now, now);
  return getBlueprint(db, id);
}

// Every edit bumps the version and clears approval (an older approval never
// carries over to a new draft — that is what makes cast-time revalidation
// meaningful instead of ceremonial).
export function updateBlueprint(db, id, { contentJson, diffSummary }, expectedVersion) {
  const now = new Date().toISOString();
  const res = db.prepare(
    `UPDATE blueprints SET content_json = ?, diff_summary = ?, version = version + 1, status = 'draft',
       approved_by = NULL, approved_at = NULL, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).run(contentJson, diffSummary ?? null, now, id, expectedVersion);
  return res.changes === 1;
}

export function recordApproval(db, id, { approvedBy, approvedAt, diffSummary }) {
  const res = db.prepare(
    `UPDATE blueprints SET status = 'approved', approved_by = ?, approved_at = ?, diff_summary = ?
     WHERE id = ? AND status != 'cast'`,
  ).run(approvedBy, approvedAt, diffSummary ?? null, id);
  return res.changes === 1;
}

export function recordCast(db, id, { packId, packVersion }) {
  const res = db.prepare(
    `UPDATE blueprints SET status = 'cast', cast_pack_id = ?, cast_pack_version = ?, updated_at = ? WHERE id = ?`,
  ).run(packId, packVersion, new Date().toISOString(), id);
  return res.changes === 1;
}

export function saveTrialReport(db, id, reportJson) {
  const res = db.prepare(
    `UPDATE blueprints SET trial_report_json = ?, updated_at = ? WHERE id = ?`,
  ).run(reportJson, new Date().toISOString(), id);
  return res.changes === 1;
}

export function rowToBlueprint(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    name: row.name,
    oneLine: row.one_line,
    outOfScope: row.out_of_scope,
    content: JSON.parse(row.content_json),
    status: row.status,
    version: row.version,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    diffSummary: row.diff_summary ? JSON.parse(row.diff_summary) : null,
    castPackId: row.cast_pack_id,
    castPackVersion: row.cast_pack_version,
    trialReport: row.trial_report_json ? JSON.parse(row.trial_report_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** List-entry payload (content excluded from listing). */
export function rowToListEntry(row) {
  return { ...rowToBlueprint(row), content: undefined };
}
