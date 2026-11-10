#!/usr/bin/env node
// ── Connector binding storage (add-connector-bindings, 2.1-2.3) ──────────────
//
// Pins the two facts the rest of the change rests on:
//
//   2.1  v114 rebuilds user_connector_credentials into two row kinds
//        ('account' / 'binding') keyed by (email, kind, slot), and creates the
//        binding ledger. A pre-114 (v25-shaped) database upgrades with every
//        column preserved — token, pat_id, stale, active, slot.
//   2.2  The built-in free-exploration binding is backfilled once per identity
//        that has an active account, and re-running the backfill changes
//        nothing.
//   2.3  Account projections never see binding rows (and vice versa), so a
//        binding key that collides with an account name cannot hijack injection.
//
//   node --test scripts/test-connector-binding-store.mjs

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-bindings-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.chdir(TMP);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");

test("v114 rebuilds the table into two row kinds and creates the ledger", async () => {
  await db.initDb();
  const probe = new DatabaseSync(process.env.DB_PATH);
  const columns = probe.prepare("PRAGMA table_info(user_connector_credentials)").all().map((c) => c.name);
  for (const column of ["kind", "purpose", "source_account"]) {
    assert.ok(columns.includes(column), `missing column ${column}`);
  }
  const pk = probe
    .prepare("PRAGMA table_info(user_connector_credentials)")
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  assert.deepEqual(pk, ["email", "kind", "slot"]);
  const ledger = probe.prepare("PRAGMA table_info(connector_binding_ledger)").all().map((c) => c.name);
  for (const column of [
    "pack_id",
    "pack_version",
    "binding_key",
    "provider",
    "operations",
    "connection_id",
    "status",
    "optional",
    "granted_at",
  ]) {
    assert.ok(ledger.includes(column), `ledger missing ${column}`);
  }
  probe.close();
});

test("a fresh install has no accounts and no bindings", () => {
  assert.deepEqual(db.listConnectorCredentials("nobody@example.com"), []);
  assert.deepEqual(db.listConnectorBindings("nobody@example.com"), []);
  assert.deepEqual(db.listConnectorBindingLedger("nobody@example.com"), []);
});

test("accounts and bindings round-trip through one table without colliding", () => {
  db.setConnectorCredential({ email: "u@example.com", slot: "default", token: "oct_account", patId: "pat-1" });
  db.setConnectorBinding({
    email: "u@example.com",
    slot: "default",
    token: "oct_binding",
    purpose: "pack:p/demo",
    sourceAccount: "default",
  });

  const accounts = db.listConnectorCredentials("u@example.com");
  assert.deepEqual(accounts.map((row) => row.slot), ["default"]);
  assert.equal(db.getActiveConnectorCredential("u@example.com").token, "oct_account");

  const bindings = db.listConnectorBindings("u@example.com");
  assert.deepEqual(bindings.map((row) => row.slot), ["default"]);
  assert.equal(db.getConnectorBinding("u@example.com", "default").token, "oct_binding");
  assert.equal(db.getConnectorBinding("u@example.com", "default").purpose, "pack:p/demo");
  assert.equal(db.getConnectorBinding("u@example.com", "default").sourceAccount, "default");

  // Deleting the binding leaves the account alone.
  assert.equal(db.deleteConnectorBinding("u@example.com", "default"), true);
  assert.equal(db.getActiveConnectorCredential("u@example.com").token, "oct_account");
});

test("the backfill gives each active account one built-in explore binding, once", () => {
  const inserted = db.backfillConnectorExploreBinding();
  assert.equal(inserted, 1, "one active account, one binding");

  const bindings = db.listConnectorBindings("u@example.com");
  const explore = bindings.find((row) => row.slot === db.CONNECTOR_EXPLORE_BINDING);
  assert.ok(explore, "missing chat:explore binding");
  assert.equal(explore.purpose, "内置自由探索");
  assert.equal(explore.sourceAccount, "default");
  // Same token as the account: behavior is unchanged until the user re-grants.
  assert.equal(db.getConnectorBinding("u@example.com", db.CONNECTOR_EXPLORE_BINDING).token, "oct_account");

  assert.equal(db.backfillConnectorExploreBinding(), 0, "second run must be a no-op");
  assert.equal(
    db.listConnectorBindings("u@example.com").filter((row) => row.slot === db.CONNECTOR_EXPLORE_BINDING).length,
    1
  );
});

test("a binding row never becomes the active account", () => {
  // The binding row is kind='binding' with active=0; even a slot named like an
  // account cannot displace the account's injection source.
  db.setConnectorCredential({ email: "w@example.com", slot: "chat:explore", token: "oct_account_named_like_binding" });
  assert.equal(db.getActiveConnectorCredential("w@example.com").token, "oct_account_named_like_binding");
  db.setConnectorBinding({ email: "w@example.com", slot: "chat:explore", token: "oct_binding_same_name" });
  assert.equal(db.getActiveConnectorCredential("w@example.com").token, "oct_account_named_like_binding");
  assert.equal(db.getConnectorBinding("w@example.com", "chat:explore").token, "oct_binding_same_name");
});

test("the ledger upserts one row per (identity, pack, binding) and keeps granted_at", () => {
  db.setConnectorCredential({ email: "ledger@example.com", slot: "default", token: "oct_l" });
  db.upsertConnectorBindingLedgerRow({
    email: "ledger@example.com",
    packId: "pack-a",
    packVersion: "1.0.0",
    bindingKey: "kingdee-cloud",
    provider: "kingdee",
    operations: ["read", "write"],
    connectionId: "conn-1",
    status: "satisfied",
    grantedAt: "2026-11-01T00:00:00.000Z",
  });
  db.upsertConnectorBindingLedgerRow({
    email: "ledger@example.com",
    packId: "pack-a",
    packVersion: "1.1.0",
    bindingKey: "kingdee-cloud",
    provider: "kingdee",
    operations: ["read"],
    connectionId: "conn-1",
    status: "missing",
  });

  const rows = db.listConnectorBindingLedger("ledger@example.com", "pack-a");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].packVersion, "1.1.0");
  assert.deepEqual(rows[0].operations, ["read"]);
  assert.equal(rows[0].status, "missing");
  // A later update without grantedAt must not erase the original grant time.
  assert.equal(rows[0].grantedAt, "2026-11-01T00:00:00.000Z");

  assert.equal(db.deleteConnectorBindingLedgerRow("ledger@example.com", "pack-a", "kingdee-cloud"), true);
  assert.deepEqual(db.listConnectorBindingLedger("ledger@example.com"), []);
});

test("a v25-shaped database upgrades with every account column preserved", async () => {
  // Faithful upgrade: build a real v114 database, then downgrade *only* the
  // credentials table to the shape v25 shipped and mark v114 as unapplied.
  //
  // The downgrade runs through the platform's own handle (db.getDb()), not a
  // second SQLite binding: two bindings on one WAL file do not reliably see each
  // other's commits (node:sqlite vs better-sqlite3 — reproduced here), and this
  // test is about the migration, not about that quirk.
  const upgradePath = path.join(TMP, "upgrade.db");
  const previous = process.env.DB_PATH;
  process.env.DB_PATH = upgradePath;
  await db.initDb();

  const seeded = [
    ["u@example.com", "primary", "oct_primary", "pat-primary", 0, 1, "2026-10-01T00:00:00.000Z"],
    ["u@example.com", "secondary", "oct_secondary", null, 1, 0, "2026-09-01T00:00:00.000Z"],
    ["v@example.com", "default", "oct_v", "pat-v", 0, 1, "2026-08-01T00:00:00.000Z"],
  ];
  const raw = db.getDb();
  raw.exec("DROP TABLE user_connector_credentials");
  raw.exec(`CREATE TABLE user_connector_credentials (
    email TEXT NOT NULL,
    slot TEXT NOT NULL,
    token TEXT NOT NULL,
    pat_id TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, slot)
  )`);
  for (const row of seeded) {
    raw
      .prepare(
        "INSERT INTO user_connector_credentials (email, slot, token, pat_id, stale, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(...row);
  }
  raw.prepare("DELETE FROM schema_migrations WHERE version >= 114").run();

  await db.initDb();

  const selectAccounts = (handle) =>
    handle
      .prepare(
        "SELECT email, kind, slot, token, pat_id, stale, active, purpose, source_account, updated_at FROM user_connector_credentials WHERE kind = 'account' ORDER BY email, slot"
      )
      .all();

  const rows = selectAccounts(db.getDb());
  assert.equal(rows.length, seeded.length);
  rows.forEach((row, index) => {
    const [email, slot, token, patId, stale, active, updatedAt] = seeded[index];
    assert.equal(row.email, email);
    assert.equal(row.kind, "account");
    assert.equal(row.slot, slot);
    assert.equal(row.token, token);
    assert.equal(row.pat_id, patId);
    assert.equal(row.stale, stale);
    assert.equal(row.active, active);
    assert.equal(row.updated_at, updatedAt);
    assert.equal(row.purpose, null);
    assert.equal(row.source_account, null);
  });

  // One built-in binding per active account (u/primary and v/default); the
  // stale secondary account gets none.
  const exploreU = db.getConnectorBinding("u@example.com", db.CONNECTOR_EXPLORE_BINDING);
  const exploreV = db.getConnectorBinding("v@example.com", db.CONNECTOR_EXPLORE_BINDING);
  assert.equal(exploreU.token, "oct_primary");
  assert.equal(exploreU.sourceAccount, "primary");
  assert.equal(exploreV.token, "oct_v");
  // The stale, non-active account is not promoted.
  assert.equal(db.getConnectorBinding("u@example.com", "secondary"), null);
  // And it stays a mirror of the account, not an active injection candidate.
  assert.equal(db.getActiveConnectorCredential("u@example.com").slot, "primary");
  assert.equal(db.listConnectorCredentials("u@example.com").length, 2);

  // Durability, not just the open handle's view: close the database (switch the
  // path away) and reopen it. A migration that only existed in one connection's
  // page cache would vanish here.
  process.env.DB_PATH = path.join(TMP, "probe-other.db");
  await db.initDb();
  process.env.DB_PATH = upgradePath;
  await db.initDb();
  assert.deepEqual(selectAccounts(db.getDb()), rows);
  assert.equal(db.getConnectorBinding("u@example.com", db.CONNECTOR_EXPLORE_BINDING).token, "oct_primary");

  process.env.DB_PATH = previous;
  await db.initDb();
});

test("account projection is active-driven and never sees binding rows (2.3)", async () => {
  const connectorCredentials = await import("../connector-credentials.js");
  const email = "mixed@example.com";
  db.setConnectorCredential({ email, slot: "a1", token: "oct_a1", patId: "pat-a1" });
  db.setConnectorCredential({ email, slot: "a2", token: "oct_a2", patId: "pat-a2" });
  db.setConnectorBinding({ email, slot: db.CONNECTOR_EXPLORE_BINDING, token: "oct_explore", purpose: "内置自由探索" });
  db.setConnectorBinding({ email, slot: "pack-a:kingdee", token: "oct_kingdee", purpose: "pack:pack-a/kingdee" });

  // Two accounts, two bindings — the account surface sees exactly the accounts.
  const client = connectorCredentials.listForClient(email);
  assert.deepEqual(client.map((row) => row.slot).sort(), ["a1", "a2"]);
  assert.ok(client.every((row) => !("patId" in row)), "client projection must not carry PAT ids");
  assert.ok(client.every((row) => !("token" in row)), "client projection must not carry tokens");

  // The first connect became active; the second did not silently take over.
  assert.equal(connectorCredentials.status(email).slot, "a1");
  assert.equal(connectorCredentials.liveToken(email), "oct_a1");

  // Switching accounts re-reads `active` — bindings never participate.
  assert.equal(connectorCredentials.setActive(email, "a2"), true);
  assert.equal(connectorCredentials.status(email).slot, "a2");
  assert.equal(connectorCredentials.liveToken(email), "oct_a2");

  // A binding-only identity has no account, so nothing is injected for it.
  db.setConnectorBinding({ email: "binding-only@example.com", slot: "chat:explore", token: "oct_only" });
  assert.deepEqual(connectorCredentials.list(email ? "binding-only@example.com" : email), []);
  assert.equal(connectorCredentials.liveToken("binding-only@example.com"), null);
  assert.equal(connectorCredentials.status("binding-only@example.com").connected, false);
});
