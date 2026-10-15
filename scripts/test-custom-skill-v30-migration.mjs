#!/usr/bin/env node
// ── custom_skills v30 migration (add-external-skill-install 1.1) ─────────────
//
// The change's zero-migration claim, tested directly: an existing (pre-v30)
// database gains the three nullable columns on the next boot, every
// pre-migration row decodes with files/frontmatter/originMeta = null, and the
// boot does not degrade (initDb swallows migration errors into dbReady=false —
// exactly the silent-degradation mode this guards).
//
// Simulated by reshaping the table to the pre-v30 shape, dropping the v30
// marker, and re-running initDb() — the same pattern the connector-credentials
// migration test (test-connector-credentials.mjs 5.1) uses.
//
//   node --test scripts/test-custom-skill-v30-migration.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "skill-v30-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");

test("v29 → v30 adds the three columns; legacy rows stay single-file", async () => {
  await db.initDb();
  assert.ok(db.isDbReady(), "initial boot");
  const d = db.getDb();

  // Reshape to the pre-v30 table and seed one legacy single-file row.
  d.exec(`ALTER TABLE custom_skills DROP COLUMN files`);
  d.exec(`ALTER TABLE custom_skills DROP COLUMN frontmatter`);
  d.exec(`ALTER TABLE custom_skills DROP COLUMN origin_meta`);
  d.prepare(
    `INSERT INTO custom_skills (id, name, description, content, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run("legacy-id", "legacy-skill", "old desc", "# Body", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  d.exec(`DELETE FROM schema_migrations WHERE version = 30`);

  // The upgrade boot: v30 re-applies, database stays ready.
  await db.initDb();
  assert.ok(db.isDbReady(), "boot on an upgraded database must not degrade");

  const row = db.getCustomSkill("legacy-skill");
  assert.ok(row, "legacy row survives the migration");
  assert.equal(row.content, "# Body");
  assert.deepEqual(
    { files: row.files, frontmatter: row.frontmatter, originMeta: row.originMeta },
    { files: null, frontmatter: null, originMeta: null },
    "pre-migration rows carry all three columns as null (single-file shape)",
  );

  const listed = db.listCustomSkills().find((s) => s.name === "legacy-skill");
  assert.ok(listed, "legacy row appears in the listing");
  for (const key of ["files", "frontmatter", "originMeta"]) {
    assert.ok(key in listed, `listing decodes ${key} for every row`);
  }
});

test("re-running the upgrade boot is idempotent", async () => {
  await db.initDb();
  const rows = db.listCustomSkills().filter((s) => s.name === "legacy-skill");
  assert.equal(rows.length, 1, "no duplicate row from the repeat boot");
  assert.equal(rows[0].files, null);
});

rmSync(tmpRoot, { recursive: true, force: true });
