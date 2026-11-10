#!/usr/bin/env node
// ── Resource library: history seeding (openspec: add-resource-library 5.2) ──
//
// The one-time seeding pass that captures chart fences from previously
// recorded assistant messages runs automatically at cell startup, guarded by a
// completion marker (so a restart never resurrects a resource the user
// deleted). This script is the EXPLICIT operator path — for a cell whose
// marker is set but whose history still holds charts (an import landed after
// the first seeding, say), or for a pre-flight count before deploying.
//
//   node scripts/seed-resources.mjs                  # seed the default DB
//   node scripts/seed-resources.mjs --dry-run        # report, write nothing
//   node scripts/seed-resources.mjs --force          # ignore the marker
//   node scripts/seed-resources.mjs --db /path/app.db
//
// ⚠ --force (and any real run) MAY re-create entries a user deleted — the
// documented consequence of asking for it explicitly. Prefer --dry-run first.
//
// Printing is the interface: exit 0 with a report, exit 1 when the DB cannot
// be opened.

import "dotenv/config";
import path from "node:path";
import { storeDir } from "../paths.js";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const dryRun = has("--dry-run");
const force = has("--force");
const dbPath = flagValue("--db") || path.join(storeDir("data"), "app.db");

process.env.DB_PATH = path.resolve(dbPath);
const db = await import("../db.js");
const resources = await import("../resources.js");

console.log(`[seed-resources] database: ${process.env.DB_PATH}`);
console.log(`[seed-resources] mode: ${dryRun ? "dry-run" : force ? "force" : "normal"}`);

await db.initDb();
if (!db.isDbReady()) {
  console.error("[seed-resources] failed to open the database; nothing seeded");
  process.exit(1);
}

const result = resources.seedFromHistory({ force, dryRun });
if (result.skipped) {
  console.log(
    result.reason === "already-seeded"
      ? "[seed-resources] seeding marker present — nothing to do (use --force to re-run)"
      : `[seed-resources] skipped: ${result.reason}`,
  );
  process.exit(0);
}
if (dryRun) {
  console.log(
    `[seed-resources] scanned ${result.scanned} message(s); would seed ${result.wouldSeed} chart resource(s)`,
  );
} else {
  console.log(
    `[seed-resources] scanned ${result.scanned} message(s); seeded ${result.seeded} new chart resource(s)`,
  );
  console.log(`[seed-resources] library now holds ${db.countResources()} resource(s)`);
}
process.exit(0);