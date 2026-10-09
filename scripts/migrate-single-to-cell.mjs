#!/usr/bin/env node
// ── One-shot: single-process state → gateway/cell layout (migrate-fd-prod-cells 4.1/4.2)
//
// Copies (never moves — the old tree stays as the rollback story) a
// single-process deployment's PLATFORM_DATA_DIR into the per-user cell layout
// the gateway expects:
//
//   <dataDir>/**                → <cellRoot>/<userId>/data/**   (per-cell state)
//   <dataDir>/workspace/**      → <cellRoot>/<userId>/workspace/** (agent workspace)
//   <dataDir>/data/packs.db*    → <cellRoot>/packs.db*            (gateway-level market)
//   <dataDir>/data/mp-bindings.json → <cellRoot>/mp-bindings.json (gateway-level MP binds)
//   <dshHome>/**                → <cellRoot>/<userId>/dsh/**      (dsh profile home)
//   <cellRoot>/<userId>/runtime    (mkdir — the cell's process cwd)
//
// Safety: any non-empty existing target refuses the run; --dry-run prints the
// plan with byte accounting. The platform MUST be stopped while this runs
// (SQLite WAL copies are only settled offline — the cutover checklist's
// downtime window is exactly this script's execution window).
//
//   node scripts/migrate-single-to-cell.mjs --email <owner> \
//     --data-dir /data --dsh-home /opt/dsh-home --cell-root /data/cells [--dry-run]

import { parseArgs } from "node:util";
import { cp, mkdir, readdir, stat, access } from "node:fs/promises";
import path from "node:path";
import { userIdFor } from "../gateway/spawner.js";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    "data-dir": { type: "string" },
    "dsh-home": { type: "string" },
    "cell-root": { type: "string" },
    "stamp-unowned": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const email = values.email || fail("--email <owner-email> is required");
const dataDir = path.resolve(values["data-dir"] || fail("--data-dir <single-process PLATFORM_DATA_DIR> is required"));
const dshHome = path.resolve(values["dsh-home"] || fail("--dsh-home <single-process DSH_HOME> is required"));
const cellRoot = path.resolve(values["cell-root"] || fail("--cell-root <CELL_DATA_ROOT> is required"));
const dryRun = Boolean(values["dry-run"]);

const userId = userIdFor(email);
const userRoot = path.join(cellRoot, userId);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Copy plan entries: { from, to, note }. Directories copy recursively with
// symlink structure preserved (the dsh home's symlinks must stay symlinks —
// its first-restart healer owns fixing stale ones, not this script).
async function buildPlan() {
  const plan = [];
  const top = await readdir(dataDir, { withFileTypes: true });
  for (const entry of top) {
    const from = path.join(dataDir, entry.name);
    if (entry.name === "workspace") {
      plan.push({ from, to: path.join(userRoot, "workspace"), note: "agent workspace (was the AGENT_WORKSPACE pin)" });
      continue;
    }
    if (entry.name === "data") {
      // Gateway-level files leave the user tree; everything else keeps its
      // relative place under the cell's PLATFORM_DATA_DIR.
      const inner = await readdir(from, { withFileTypes: true });
      for (const f of inner) {
        const ffrom = path.join(from, f.name);
        if (/^packs\.db(-wal|-shm)?$/.test(f.name)) {
          plan.push({ from: ffrom, to: path.join(cellRoot, f.name), note: "gateway-level pack market" });
        } else if (f.name === "mp-bindings.json") {
          plan.push({ from: ffrom, to: path.join(cellRoot, "mp-bindings.json"), note: "gateway-level MP bindings" });
        } else {
          plan.push({ from: ffrom, to: path.join(userRoot, "data", "data", f.name), note: `cell state (${f.name})` });
        }
      }
      continue;
    }
    if (entry.name === "mcp.json") {
      // The spawner points MCP_CONFIG_PATH at <root>/mcp.json — beside data/,
      // not inside it (live finding 2026-10-01: inside data/ the cell boots
      // with an empty operator MCP layer).
      plan.push({ from, to: path.join(userRoot, "mcp.json"), note: "cell MCP operator config (beside data/)" });
      continue;
    }
    plan.push({ from, to: path.join(userRoot, "data", entry.name), note: `cell state (${entry.name})` });
  }
  plan.push({ from: dshHome, to: path.join(userRoot, "dsh"), note: "dsh profile home" });
  plan.push({ mkdir: path.join(userRoot, "runtime"), note: "cell process cwd (empty by design)" });
  return plan;
}

async function sizeOf(p) {
  const info = await stat(p);
  if (info.isFile()) return { files: 1, bytes: info.size };
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  };
  await walk(p);
  return { files, bytes };
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MiB`;

const plan = await buildPlan();
console.log(`owner ${email} → cell ${userId}`);
console.log(`source: ${dataDir} (+ dsh home ${dshHome})`);
console.log(`target: ${cellRoot}`);
console.log("");

let totalFiles = 0;
let totalBytes = 0;
for (const step of plan) {
  if (step.mkdir) {
    console.log(`  mkdir  ${step.note}: ${step.mkdir}`);
    continue;
  }
  const { files, bytes } = await sizeOf(step.from).catch(() => ({ files: 0, bytes: 0 }));
  totalFiles += files;
  totalBytes += bytes;
  console.log(`  copy   ${step.note}: ${step.from} → ${step.to} (${files} files, ${mb(bytes)})`);
}
console.log(`\nplan total: ${totalFiles} files, ${mb(totalBytes)}${dryRun ? " (dry run — nothing written)" : ""}`);

if (dryRun) process.exit(0);

// 4.2 safety: a non-empty target means a second run would layer copies over
// copies — refuse rather than merge.
for (const step of plan) {
  const target = step.mkdir || step.to;
  if (!(await exists(target))) continue;
  const entries = await readdir(target).catch(() => []);
  if (entries.length > 0) {
    fail(`target not empty: ${target} (${entries.length} entries) — clear it or pick a fresh cell root`);
  }
}

let copied = 0;
for (const step of plan) {
  if (step.mkdir) {
    await mkdir(step.mkdir, { recursive: true });
    continue;
  }
  await mkdir(path.dirname(step.to), { recursive: true });
  await cp(step.from, step.to, { recursive: true, force: true, errorOnExist: false });
  copied += 1;
  console.log(`✓ ${step.note}`);
}

// Ownership attribution (session-ownership: a scoped list matches owner
// strictly, so unowned rows would vanish from the owner's view). Sessions
// created before the single-process era's ownership stamping — and any created
// auth-off — are the single user's by definition; stamp them on the MIGRATED
// copy only. The source tree stays byte-identical for rollback.
if (values["stamp-unowned"]) {
  const { default: Database } = await import("better-sqlite3");
  const cellDb = new Database(path.join(userRoot, "data", "data", "app.db"));
  const info = cellDb
    .prepare("UPDATE chat_sessions SET owner = ? WHERE owner IS NULL OR owner = ''")
    .run(email);
  cellDb.pragma("wal_checkpoint(TRUNCATE)");
  cellDb.close();
  console.log(`✓ stamped ${info.changes} unowned session(s) → ${email}`);
}

// Byte accounting (4.2): recount what landed and compare against the plan.
// SQLite sidecars (-wal/-shm) are excluded on both sides: the stamp step's
// clean close checkpoints and REMOVES them by design, so counting them would
// cry wolf on a healthy migration.
const isSidecar = (p) => /-(wal|shm)$/.test(p);
let landedFiles = 0;
let landedBytes = 0;
for (const step of plan) {
  if (step.mkdir) continue;
  if (isSidecar(step.to)) continue;
  const { files, bytes } = await sizeOf(step.to).catch(() => ({ files: 0, bytes: 0 }));
  landedFiles += files;
  landedBytes += bytes;
}
const plannedFiles = totalFiles - plan.filter((s) => s.to && isSidecar(s.to)).length;
const plannedBytes = totalBytes;
console.log(`\n${copied} copy step(s); landed ${landedFiles} files, ${mb(landedBytes)} (planned ${plannedFiles} files, ${mb(plannedBytes)})`);
if (landedFiles !== plannedFiles) {
  fail(`file-count mismatch: landed ${landedFiles} vs planned ${plannedFiles} — inspect the target tree before proceeding`);
}
console.log("✓ migration complete — old tree untouched (rollback = run the platform single-process against it)");
