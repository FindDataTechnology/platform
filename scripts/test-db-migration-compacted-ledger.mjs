#!/usr/bin/env node
// ── Compacted cell ledgers must still upgrade (2026-11-08 incident) ──────────
//
// A cell's `schema_migrations` is not a faithful record of DDL. Old cells carry
// a COMPACTED ledger (see the v100 note in db.js), so a version can be marked
// applied without its `CREATE TABLE` ever having run. Two live cells are in
// exactly that state: `2b043ce050ca134c` (ledger v37) and `0f483a072f22ae37`
// (v54) both lack `user_chatwoot_credentials` (created by v35).
//
// Before the fix, v100's bare `ALTER TABLE user_chatwoot_credentials ADD COLUMN
// chatwoot_user_id` threw `no such table: user_chatwoot_credentials`. Each
// migration runs inside one transaction, so the throw aborted the whole run and
// `initDb` reported `[db] disabled: could not open/migrate …` — the cell then
// served with NO database at all (verified in production on 2b043ce050ca134c).
//
// This test builds that exact shape (full v115 database, then rolled back to a
// v37 ledger with the chatwoot table dropped) and asserts the upgrade completes
// to head with the table and its SSO column restored. It also pins the runner's
// ADD COLUMN guard: re-running a column-adding migration whose column already
// exists must not throw.
//
//   node --test scripts/test-db-migration-compacted-ledger.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "db-compacted-ledger-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.chdir(TMP);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const { SCHEMA_HEAD } = await import("../db.js");
await db.initDb();

// Tables created by migrations ABOVE v37 — a real v37 cell does not have them,
// so dropping them reproduces the shape instead of relying on luck.
const ABOVE_37 = [
  "connector_role_mappings",
  "connector_binding_ledger",
  "persona_candidates",
  "projects",
  "skill_candidates",
  "local_fleet_deployments",
];

function schemaVersion() {
  return db.getDb().prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
}

function tableNames() {
  return new Set(
    db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
}

function columnsOf(table) {
  return db.getDb().prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test("a compacted v37 cell ledger upgrades to head instead of disabling the database", async () => {
  assert.equal(schemaVersion(), SCHEMA_HEAD);

  // ── Reproduce the two production cells ────────────────────────────────────
  const handle = db.getDb();
  handle.exec("DROP TABLE user_chatwoot_credentials");
  for (const table of ABOVE_37) handle.exec(`DROP TABLE IF EXISTS ${table}`);
  // Versions need not be contiguous (nothing sits between 36 and 99), so the
  // base is whatever is left — the point is that the chatwoot CREATE is gone
  // while its version is still recorded, exactly like the two live cells.
  handle.exec("DELETE FROM schema_migrations WHERE version > 37");
  const base = schemaVersion();
  assert.ok(base <= 37, `expected a pre-v100 base, got v${base}`);
  assert.equal(tableNames().has("user_chatwoot_credentials"), false, "the pre-state must be missing the table");

  // ── The upgrade ───────────────────────────────────────────────────────────
  await db.initDb();

  assert.equal(schemaVersion(), SCHEMA_HEAD, "the run must reach head, not stop at the first ALTER");
  const tables = tableNames();
  assert.equal(tables.has("user_chatwoot_credentials"), true, "the skipped CREATE is replayed at v100");
  assert.ok(columnsOf("user_chatwoot_credentials").includes("chatwoot_user_id"), "and its SSO column lands");
  assert.equal(tables.has("connector_binding_ledger"), true);
  assert.ok(columnsOf("connector_binding_ledger").includes("role"));
  assert.equal(tables.has("connector_role_mappings"), true);
  // The repaired table is usable, not just present.
  db.getDb()
    .prepare("INSERT INTO user_chatwoot_credentials (email, token, updated_at) VALUES (?, ?, ?)")
    .run("compacted@example.com", "tok", new Date().toISOString());
  assert.equal(
    db.getDb().prepare("SELECT count(*) AS c FROM user_chatwoot_credentials").get().c,
    1,
  );
});

test("re-running a column-adding migration whose column exists does not throw", async () => {
  // Forget v100 while leaving its column in place: the naive ALTER would throw
  // "duplicate column name" and, inside one transaction, kill the whole run.
  db.getDb().exec("DELETE FROM schema_migrations WHERE version = 100");
  await db.initDb();
  assert.equal(schemaVersion(), SCHEMA_HEAD);
  assert.ok(columnsOf("user_chatwoot_credentials").includes("chatwoot_user_id"));
});

test("a column-adding migration on an absent table is skipped, not fatal", async () => {
  // Same class, different table: a cell can lack `bots` (v?? CREATE skipped by
  // compaction) while v101/v103/v104/v111 alter it. Skipping must not abort.
  db.getDb().exec("DELETE FROM schema_migrations WHERE version IN (101, 103, 104, 111)");
  db.getDb().exec("DROP TABLE bots");
  await db.initDb();
  assert.equal(schemaVersion(), SCHEMA_HEAD, "ALTERs on a missing table are skipped, the run still completes");
  assert.equal(tableNames().has("bots"), false, "nothing invents the table behind the ledger's back");
});
