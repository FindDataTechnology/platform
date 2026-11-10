// ── Cell crash ledger (add-cell-crash-ledger) ───────────────────────────────
//
// A crashing cell used to leave exactly one thing behind: a console line, which
// dies with the process. The counter and the scene now live in the durable
// registry, so "is this cell stable?" survives a restart — and the respawn delay
// is bounded but NEVER a refusal (refusing would lock the user out of their own
// data; that is the mp-demo tombstone lesson).
//
// Run: node --test scripts/test-cell-crash-ledger.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createCellRegistryDb } from "../gateway/cell-registry.js";
import { newRegistryRow, REGISTRY_SCHEMA_VERSION } from "../lib/cell-registry.js";

function tmpFile(name = "cells-registry.db") {
  const dir = mkdtempSync(join(tmpdir(), "cell-crash-ledger-"));
  return { file: join(dir, name), dir };
}

test("a new row carries zeroed crash fields and schema v2", () => {
  const { file, dir } = tmpFile();
  try {
    const db = createCellRegistryDb({ file });
    db.put(newRegistryRow({ cellId: "aaaaaaaaaaaaaaaa", ownerEmail: "a@example.com" }));
    const back = db.get("aaaaaaaaaaaaaaaa");
    assert.equal(REGISTRY_SCHEMA_VERSION, 2);
    assert.equal(back.schemaVersion, 2);
    assert.equal(back.crashCount, 0);
    assert.equal(back.lastCrash, null);
    assert.equal(back.bindFailureCount, 0);
    assert.equal(back.lastBindFailure, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash evidence survives a reopen (the whole point of the ledger)", () => {
  const { file, dir } = tmpFile();
  try {
    const first = createCellRegistryDb({ file });
    first.put(newRegistryRow({ cellId: "bbbbbbbbbbbbbbbb" }));
    first.put({
      ...first.get("bbbbbbbbbbbbbbbb"),
      crashCount: 3,
      lastCrash: { code: 1, signal: null, at: 1794100000000, uptimeMs: 4200, message: "exited (code=1 signal=null)" },
    });
    // A fresh handle over the same file is what a gateway restart does.
    const reopened = createCellRegistryDb({ file });
    const row = reopened.get("bbbbbbbbbbbbbbbb");
    assert.equal(row.crashCount, 3);
    assert.deepEqual(row.lastCrash, {
      code: 1,
      signal: null,
      at: 1794100000000,
      uptimeMs: 4200,
      message: "exited (code=1 signal=null)",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-existing v1 database gains the columns and keeps its rows", () => {
  const { file, dir } = tmpFile();
  try {
    // The OLD shape, exactly as shipped before this change (v1 DDL, no crash columns).
    const old = new Database(file);
    old.exec(`CREATE TABLE cell_registry (
      cell_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, owner_email TEXT,
      state TEXT NOT NULL, policy TEXT NOT NULL, workload_json TEXT NOT NULL DEFAULT '{}',
      last_user_traffic_at INTEGER, last_duty_run_at INTEGER, last_bound_at INTEGER,
      destroy_reason TEXT, destroy_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO cell_registry (cell_id, schema_version, owner_email, state, policy,
      workload_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run("cccccccccccccccc", 1, "old@example.com", "suspended", "on_demand", "{}", 1, 1);
    old.close();

    const db = createCellRegistryDb({ file }); // guarded-add runs here
    const row = db.get("cccccccccccccccc");
    assert.ok(row, "the v1 row is still readable");
    assert.equal(row.ownerEmail, "old@example.com", "existing data untouched");
    assert.equal(row.state, "suspended");
    assert.equal(row.crashCount, 0, "missing crash columns read as zero, not undefined");
    assert.equal(row.bindFailureCount, 0);
    assert.equal(row.lastCrash, null);
    assert.equal(row.schemaVersion, 2, "the row migrates forward on read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn scene (invalid JSON) loses the scene but never the count", () => {
  const { file, dir } = tmpFile();
  try {
    const db = createCellRegistryDb({ file });
    db.put(newRegistryRow({ cellId: "dddddddddddddddd" }));
    const raw = new Database(file);
    raw.prepare("UPDATE cell_registry SET crash_count = 4, last_crash_json = ? WHERE cell_id = ?")
      .run("{not json", "dddddddddddddddd");
    raw.close();
    const row = db.get("dddddddddddddddd");
    assert.equal(row.crashCount, 4, "the count is a column and cannot be torn");
    assert.equal(row.lastCrash, null, "a half-written scene degrades to absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
