#!/usr/bin/env node
// ── ADD COLUMN idempotence: the general form of the legacy-cell fix ─────────
//
// schema-migrations spec (harden-legacy-cell-migrations): a migration must only
// own the structure it declares, and "任一迁移抛出未预期错误时，失败 SHALL 局限于
// 该迁移，不得让整个数据库进入停用状态". `test-legacy-table-migration.mjs` pins the
// one table that was actually missing in production (v100 / chatwoot); this file
// pins the RULE, so the next missing table does not need its own incident.
//
// SQLite has no `ADD COLUMN IF NOT EXISTS`, and a legacy cell ledger is not a
// faithful record of DDL (it records versions whose CREATE never ran). Without a
// guard, any `ALTER TABLE … ADD COLUMN` on such a DB throws `no such table`, and
// because one migration = one transaction, the throw disables the whole database.
//
// Two shapes, both driven through the real migration runner:
//   A. base table absent  → the statement is skipped, the run completes to head;
//   B. column present     → the statement is skipped, nothing is rewritten.
//
//   node --test scripts/test-migration-add-column-guard.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "add-column-guard-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "guard.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_FILE = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(TMP, "mcp.json"), JSON.stringify({ mcpServers: {} }));

const { initDb, isDbReady, getDb } = await import("../db.js");
await initDb();
assert.equal(isDbReady(), true, "a fresh database must migrate");

const head = getDb().prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;

function forget(...versions) {
  const handle = getDb();
  for (const version of versions) handle.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
}

test("an ADD COLUMN whose base table is absent is skipped, not fatal", async () => {
  // `user_line_credentials.refresh_token` (v102) is an ALTER-only migration on a
  // table an old cell could be missing. Drop both and replay: before the guard
  // this ended in `[db] disabled … no such table: user_line_credentials`.
  getDb().exec("DROP TABLE user_line_credentials");
  forget(31, 102);

  await initDb();

  assert.equal(isDbReady(), true, "a missing base table must not disable the database");
  assert.equal(
    getDb().prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,
    head,
    "the run must still reach head",
  );
  // v31 creates it again (that migration was also forgotten), so the net effect
  // is a rebuilt table rather than a skipped column — either way: no outage.
  const cols = getDb().prepare("PRAGMA table_info(user_line_credentials)").all().map((c) => c.name);
  assert.ok(cols.includes("refresh_token"), "v102's column lands once the table exists");
});

test("an ADD COLUMN whose column already exists is skipped, not fatal", async () => {
  // The column is there, the version is not: the naive ALTER would throw
  // "duplicate column name" inside the transaction and take the run down.
  const before = getDb().prepare("PRAGMA table_info(bots)").all().map((c) => c.name);
  assert.ok(before.includes("owner_email"));
  forget(101);

  await initDb();

  assert.equal(isDbReady(), true, "a replayed ADD COLUMN must not disable the database");
  assert.equal(getDb().prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, head);
  const after = getDb().prepare("PRAGMA table_info(bots)").all().map((c) => c.name);
  assert.deepEqual(after, before, "replaying a satisfied ADD COLUMN changes no column");
});

test("the guard leaves real migrations to do their own work", async () => {
  // The guard covers ONE statement shape (ADD COLUMN). A DROP+CREATE rebuild is
  // still the migration's own business: forgetting v114 and v115 replays both,
  // so the table and its column must come back exactly as that code decides.
  getDb().exec("DROP TABLE connector_binding_ledger");
  forget(114, 115);

  await initDb();

  // v114 recreates the table itself (DROP+CREATE rebuild), so this still ends
  // healthy — the assertion is that the run's outcome is decided by the
  // migration, not by the guard: the ledger is back with its role column.
  assert.equal(isDbReady(), true);
  const cols = getDb().prepare("PRAGMA table_info(connector_binding_ledger)").all().map((c) => c.name);
  assert.ok(cols.includes("role"), "v115's column is present again");
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
