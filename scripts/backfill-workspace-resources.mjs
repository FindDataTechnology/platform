// One-shot backfill: scan a cell's existing workspace and capture every file
// into the resource library through the same gate as the turn capture
// (openspec: wire-produced-files-to-outputs, task 4.1).
//
// Why a script and not a migration: workspaces predate the capture hook; the
// affected cell is an operator decision, not a boot-time side effect. Idempotent
// by content hash — a second run inserts nothing. Rows are source=auto with
// empty provenance (the soft-reference model handles a null session id).
//
// Usage (on the pod, via the /tmp/rt staging recipe — node_modules symlink):
//   node /tmp/rt/scripts/backfill-workspace-resources.mjs --cell <16-hex> [--dry-run]
// The cell id scopes both the DB (/data/cells/<id>/data/data/app.db) and the
// workspace (/data/cells/<id>/workspace). BACKFILL_VERBOSE=1 logs refusals.

import path from "node:path";
import fs from "node:fs";

const args = process.argv.slice(2);
const cellArg = args.indexOf("--cell");
const dryRun = args.includes("--dry-run");
const cell = cellArg >= 0 ? args[cellArg + 1] : null;

if (!cell || !/^[0-9a-f]{16}$/.test(cell)) {
  console.error("usage: node backfill-workspace-resources.mjs --cell <16-hex-id> [--dry-run]");
  process.exit(1);
}

const cellsRoot = process.env.CELL_DATA_ROOT || "/data/cells";
const cellRoot = path.join(cellsRoot, cell);
const workspaceRoot = path.join(cellRoot, "workspace");
const dbPath = path.join(cellRoot, "data", "data", "app.db");
if (!fs.existsSync(workspaceRoot)) {
  console.error(`cell ${cell}: workspace missing under ${cellRoot}`);
  process.exit(1);
}
// A dry-run only walks the tree; a real run needs the cell's DB.
if (!dryRun && !fs.existsSync(dbPath)) {
  console.error(`cell ${cell}: DB missing at ${dbPath}`);
  process.exit(1);
}

process.env.DB_PATH = dbPath;
// The cell's own store dir, next to its data — NOT the platform-wide default.
process.env.RESOURCES_STORAGE_PATH = path.join(cellRoot, "data", "resources-store");

// Walk the workspace first. Backfill means every existing file — the
// user-selected full-capture scope for work that predates the hook; the rule
// selects only what turns produce going forward. Dry-run needs none of the
// DB machinery, so the walk happens before those imports.
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_WALKED = 5000;
const files = [];
let walked = 0;
const stack = [workspaceRoot];
while (stack.length && walked < MAX_WALKED) {
  const dir = stack.pop();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      continue;
    }
    if (!entry.isFile()) continue;
    walked++;
    files.push(path.relative(workspaceRoot, full).split(path.sep).join("/"));
  }
}

if (dryRun) {
  console.log(`cell ${cell}: ${files.length} files in workspace`);
  for (const rel of files.slice(0, 30)) console.log("  would capture:", rel);
  if (files.length > 30) console.log(`  … and ${files.length - 30} more`);
  console.log("dry-run: nothing written");
  process.exit(0);
}

const db = await import("../db.js");
const resources = await import("../resources.js");
await db.initDb();
if (!db.isDbReady()) {
  console.error("db not ready after initDb");
  process.exit(1);
}
const before = db.listResources({ type: "file", limit: 1 }).total;
console.log(`cell ${cell}: ${files.length} files in workspace (${before} file rows before)`);

let inserted = 0;
let refreshed = 0;
let refused = 0;
for (const rel of files) {
  try {
    const result = await resources.saveFileAuto({ path: rel, workspaceRoot });
    if (result.inserted) inserted++;
    else refreshed++;
  } catch (err) {
    refused++;
    if (process.env.BACKFILL_VERBOSE) console.log(`  refused ${rel}: ${err?.code || err?.message}`);
  }
}

const after = db.listResources({ type: "file", limit: 1 }).total;
console.log(`backfill done: inserted=${inserted} already-present=${refreshed} refused=${refused}; file rows ${before} -> ${after}`);
