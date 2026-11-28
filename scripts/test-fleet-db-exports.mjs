#!/usr/bin/env node
// ── fleets-db's export surface must not move ────────────────────────────────
//
// openspec change: converge-fleet-surface (knife 3). The DB module is about to
// be split into a barrel + per-domain files. scripts/capture-fleet-surface.mjs
// proves the HTTP surface is unchanged, but it drives ROUTES — it never calls
// a DB export directly, so a dropped or renamed export would pass it while
// breaking every caller that imports one.
//
// This pins the export surface itself against a checked-in baseline.
//
// The baseline is `scripts/fixtures/fleet-surface-export-baseline.json`, which
// was captured BEFORE any split, so "identical" means "identical to the
// pre-split module".
//
// Run: node --test scripts/test-fleet-db-exports.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(REPO, "scripts", "fixtures", "fleet-surface-export-baseline.json");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-db-exports-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const MODULES = {
  "./server/routes/fleets-db.js": "fleets-db",
  "./server/routes/fleets.js": "fleets",
  "./server/fleet-orchestration.js": "fleet-orchestration",
  "./server/fleet-model.js": "fleet-model",
};

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test("every fleet module still exports exactly what it did before the split", async () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  for (const [spec, key] of Object.entries(MODULES)) {
    const mod = await import(spec.replace("./server/", "../server/"));
    const actual = Object.keys(mod).sort();
    assert.deepEqual(actual, baseline[spec], `${key}: export surface changed`);
  }
});

test("no export resolved to undefined (a re-export that forgot to bind)", async () => {
  const mod = await import("../server/routes/fleets-db.js");
  for (const [name, value] of Object.entries(mod)) {
    // Constants are legal exports (REVOKE_WINDOW_MAX is a number), so the only
    // thing that signals a broken re-export is a bound-but-empty value.
    assert.notEqual(value, undefined, `fleets-db export "${name}" is undefined`);
    assert.notEqual(value, null, `fleets-db export "${name}" is null`);
  }
});
