#!/usr/bin/env node
// ── Export an installed pack version as an offline bundle ───────────────────
// (add-offline-pack-supply, export direction — CLI granularity by design: the
// browser never carries manifest bodies, spec pack-installation
// "Manifest retrieval is server-side".)
//
// Usage:
//   node scripts/export-pack-bundle.mjs --pack <packId> [--out <file>] [--origin "note"]
//   node scripts/export-pack-bundle.mjs --all --out-dir <dir>
//
// Reads the INSTALLED row (durable manifest snapshot) and writes a `.yizpack`
// next to the requested path (default: ./<packId>-v<version>.yizpack).
// Deterministic: exporting the same version twice yields byte-identical files.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildBundle, bundleFileName } from "../server/offline-bundle.js";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const PACK = arg("pack");
const OUT = arg("out");
const OUT_DIR = arg("out-dir");
const ORIGIN = arg("origin", null);
const ALL = flag("all");

if (!PACK && !ALL) {
  console.error("usage: node scripts/export-pack-bundle.mjs --pack <packId> [--out <file>] | --all [--out-dir <dir>]");
  process.exit(2);
}

// The cell DB path follows the same convention as the running service.
process.env.DB_PATH = process.env.DB_PATH || path.join(process.env.PLATFORM_DATA_DIR || ".", "platform.db");
const db = await import("../db.js");
await db.initDb();

const installed = db.listInstalledPacks();
if (installed.length === 0) {
  console.error("[export-bundle] no installed packs on this machine");
  process.exit(1);
}

async function exportOne(row) {
  const bytes = await buildBundle({
    packId: row.packId,
    version: Number(row.version),
    manifest: row.manifest,
    ...(ORIGIN ? { origin: ORIGIN } : {}),
  });
  const target = OUT_DIR
    ? path.join(OUT_DIR, bundleFileName(row.packId, row.version))
    : (OUT || bundleFileName(row.packId, row.version));
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, bytes);
  console.log(`[export-bundle] ${row.packId} v${row.version} → ${target} (${bytes.length} bytes)`);
  return target;
}

if (ALL) {
  for (const row of installed) await exportOne(row);
} else {
  const row = installed.find((p) => p.packId === PACK);
  if (!row) {
    console.error(`[export-bundle] pack ${PACK} is not installed on this machine`);
    process.exit(1);
  }
  await exportOne(row);
}
