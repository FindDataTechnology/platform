#!/usr/bin/env node
// ── Role mapping migration equivalence (add-connector-role-mapping 6.2) ─────
//
// v115 is additive: a new `connector_role_mappings` table and one nullable
// `connector_binding_ledger.role` column. The rule it must not break is "an
// upgrade changes nothing the user already had" — an existing ledger row keeps
// its status, its provider, its connection and its grant stamp; the binding
// token stays the same string; and every pre-existing row reads `role = NULL`
// (nobody was a role binding before there were roles).
//
// The test rolls a populated database BACK to the pre-115 shape
// (drop the column + table, forget the migration) and lets initDb apply v115
// again — the same shape a real upgrade takes. db.initDb supports exactly this
// on the same handle (see its re-open policy), so nothing here is simulated.
//
//   node --test scripts/test-connector-role-migration.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-role-migration-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.chdir(TMP);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const { SCHEMA_HEAD } = await import("../db.js");
await db.initDb();

const EMAIL = "migration@example.com";
const PACK = "pack-migration";
const TOKEN = "oct_migration_token_7c1";

function schemaVersion() {
  return db.getDb().prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
}

function columns(table) {
  return db.getDb().prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

test("6.2 v115 is additive: existing ledger rows, tokens and states are untouched", async () => {
  assert.equal(schemaVersion(), SCHEMA_HEAD);
  assert.ok(columns("connector_binding_ledger").includes("role"));
  assert.ok(columns("connector_role_mappings").includes("provider"));

  // A row exactly as a pre-115 release would have written it, plus its token.
  db.upsertConnectorBindingLedgerRow({
    email: EMAIL,
    packId: PACK,
    packVersion: "3.2.1",
    bindingKey: "kingdee-cloud",
    provider: "kingdee",
    operations: ["read", "write"],
    connectionId: "conn-legacy",
    status: "satisfied",
    optional: false,
    grantedAt: "2026-10-01T08:09:10.000Z",
  });
  db.setConnectorBinding({ email: EMAIL, slot: `${PACK}:kingdee-cloud`, token: TOKEN, patId: "pat-legacy" });

  const before = db.getConnectorBindingLedgerRow(EMAIL, PACK, "kingdee-cloud");
  const beforeToken = db.getConnectorBinding(EMAIL, `${PACK}:kingdee-cloud`);
  assert.ok(before && beforeToken);

  // Roll back to the pre-115 shape: the table and column did not exist, and the
  // migration had never run.
  const handle = db.getDb();
  handle.exec("DROP TABLE connector_role_mappings");
  handle.exec("ALTER TABLE connector_binding_ledger DROP COLUMN role");
  // 回滚到 v115 之前 = 删掉 >=115 的全部记录。只删 115 那一行不够：
  // 链上还有 116/117 时 MAX(version) 仍是 117，断言会以「117 !== 114」假红。
  handle.prepare("DELETE FROM schema_migrations WHERE version >= 115").run();
  assert.equal(schemaVersion(), 114);
  assert.ok(!columns("connector_binding_ledger").includes("role"));

  // The upgrade.
  await db.initDb();

  assert.equal(schemaVersion(), SCHEMA_HEAD, "v115 applies once");
  assert.ok(columns("connector_binding_ledger").includes("role"), "the role column is back");
  assert.equal(
    db.getDb().prepare("SELECT count(*) AS c FROM connector_role_mappings").get().c,
    0,
    "a fresh mapping table starts empty — no choice may be invented for anyone",
  );

  const after = db.getConnectorBindingLedgerRow(EMAIL, PACK, "kingdee-cloud");
  assert.deepEqual(after, { ...before, role: null }, "status, provider, connection and stamps are untouched; role is NULL");
  assert.equal(after.status, "satisfied");
  assert.equal(after.grantedAt, "2026-10-01T08:09:10.000Z");

  const afterToken = db.getConnectorBinding(EMAIL, `${PACK}:kingdee-cloud`);
  assert.equal(afterToken.token, TOKEN, "the binding token is not re-minted by a migration");
  assert.equal(afterToken.patId, "pat-legacy");
  assert.equal(afterToken.stale, false);

  // And nothing role-shaped was inferred from the existing rows.
  assert.equal(db.getConnectorRoleMapping(EMAIL, "kingdee"), null);
});

test("6.2 re-running the migration is a no-op (an upgrade may be retried)", async () => {
  const before = db.getConnectorBindingLedgerRow(EMAIL, PACK, "kingdee-cloud");
  await db.initDb();
  assert.equal(schemaVersion(), SCHEMA_HEAD);
  assert.deepEqual(db.getConnectorBindingLedgerRow(EMAIL, PACK, "kingdee-cloud"), before);
});
