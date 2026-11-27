#!/usr/bin/env node
// ── Legacy cell DB must still migrate (harden-legacy-cell-migrations) ────────
//
// One missing legacy table used to disable a whole cell database. Cell
// 2b043ce050ca134c is the live example: 42 tables at schema v37, its ledger
// records v35, but `user_chatwoot_credentials` is gone (compacted/legacy DB).
// v100 was a bare `ALTER TABLE user_chatwoot_credentials ADD COLUMN …`, so every
// boot ended with `[db] disabled: … no such table` and that tenant lost every
// DB-backed feature — not just Chatwoot.
//
// Two shapes are pinned here:
//   A. healthy DB, table present, column absent (the normal upgrade path):
//      an existing row keeps its token and gains the column.
//   B. legacy DB, table absent, ledger rolled back to v37 (the cell above):
//      migrations complete, the DB stays usable, and the column exists.
//
//   node --test scripts/test-legacy-table-migration.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-cell-migrate-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

// (No direct better-sqlite3 handle here: every scenario goes through db.js's
// own connection so the migration path under test is the one production runs —
// the import that used to sit on this line was dead weight and failed the lint
// gate with noUnusedVariables.)

// db.js opens the handle from DB_PATH and keeps it module-private, so every
// scenario drives it through initDb() after mutating the file underneath.
async function freshMigratedDb() {
  const { initDb, isDbReady, getDb } = await import("../db.js");
  await initDb();
  assert.equal(isDbReady(), true, "a fresh database must migrate");
  return { db: getDb(), initDb, isDbReady, getDb };
}

test("healthy upgrade: existing chatwoot row survives and gains the column", async () => {
  const file = path.join(TMP, "healthy.db");
  process.env.DB_PATH = file;
  const { db } = await freshMigratedDb();

  // Rebuild the pre-v100 shape, then roll the ledger back so v100 runs again.
  db.exec("DROP TABLE user_chatwoot_credentials");
  db.exec(`CREATE TABLE user_chatwoot_credentials (
    email TEXT PRIMARY KEY, token TEXT NOT NULL, login_email TEXT,
    login_password TEXT, stale INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`);
  db.prepare(
    "INSERT INTO user_chatwoot_credentials (email, token, stale, updated_at) VALUES (?, ?, 0, ?)",
  ).run("owner@example.test", "cw_live_token", "2026-11-01T00:00:00.000Z");
  // Only v100 re-runs: the later unguarded ALTERs already added their
  // columns, so rolling them back too would fail on `duplicate column name`
  // and prove nothing about this fix.
  db.prepare("DELETE FROM schema_migrations WHERE version = 100").run();

  const { initDb, isDbReady, getDb } = await import("../db.js");
  await initDb();
  assert.equal(isDbReady(), true);

  const after = getDb();
  const row = after
    .prepare("SELECT token, chatwoot_user_id AS id FROM user_chatwoot_credentials WHERE email = ?")
    .get("owner@example.test");
  assert.equal(row.token, "cw_live_token", "the stored token must not be dropped or rewritten");
  assert.equal(row.id, null);
  const cols = after.prepare("PRAGMA table_info(user_chatwoot_credentials)").all().map((c) => c.name);
  assert.ok(cols.includes("chatwoot_user_id"));
});

test("legacy cell: missing table no longer disables the database", async () => {
  const file = path.join(TMP, "legacy.db");
  process.env.DB_PATH = file;
  const { db } = await freshMigratedDb();

  // Reproduce the live cell: the table never existed and the ledger sits below
  // the migration that alters it (that cell's ledger stops at v37, whose rows
  // come from an older code line; what matters here is only that v100 re-runs).
  db.exec("DROP TABLE user_chatwoot_credentials");
  db.prepare("DELETE FROM schema_migrations WHERE version = 100").run();

  const { initDb, isDbReady, getDb } = await import("../db.js");
  await initDb();
  assert.equal(
    isDbReady(),
    true,
    "a missing legacy table must not turn the whole cell database off",
  );

  const after = getDb();
  const cols = after.prepare("PRAGMA table_info(user_chatwoot_credentials)").all().map((c) => c.name);
  assert.ok(cols.includes("chatwoot_user_id"), "the v35 shape is recreated, then altered");
  assert.equal(after.prepare("SELECT count(*) AS c FROM user_chatwoot_credentials").get().c, 0);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
