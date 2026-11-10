#!/usr/bin/env node
// lint-dsh-adapter.mjs — CI enforcement of the adapter-layer boundary
// (ADR-0023; spec dsh-adapter-boundary).
//
// Fails when:
//   1. a file OUTSIDE the allowlist directly imports an @deepseek-ai/* package
//      (ESM `from` or CJS `require`) — the boundary leaked; or
//   2. the allowlist is stale — a listed file is gone, or no longer imports
//      anything dsh (the list must BE the boundary fact, not a fossil).
//
// Transitive use is fine: importing dsh-bridge.js / dsh-profile.js (platform
// modules) never trips this lint — only a direct specifier does.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIST_PATH = join(ROOT, "scripts", "dsh-adapter-files.json");
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".github", "web", "facet", "openspec", "docs", "e2e", "dsh-matrix", "dist", "dist-opensource", "resources", "coverage",
]);

const IMPORT_RE = /(?:from\s+|require\(\s*)["'](@deepseek-ai\/[^"']+)["']/g;

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith(".")) yield* walk(join(dir, ent.name));
      continue;
    }
    if (/\.(js|mjs|cjs)$/.test(ent.name)) yield join(dir, ent.name);
  }
}

const { adapterFiles } = JSON.parse(readFileSync(LIST_PATH, "utf8"));
const allow = new Set(adapterFiles.map((f) => f.replace(/^\.\//, "")));

const offenders = [];
const importers = new Set();
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  IMPORT_RE.lastIndex = 0;
  if (!IMPORT_RE.test(src)) continue;
  importers.add(rel);
  if (!allow.has(rel)) {
    const hits = [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
    offenders.push(`${rel} → ${[...new Set(hits)].join(", ")}`);
  }
}

// A listed file may be absent in DISTRIBUTION TREES (the public snapshot
// deletes internal probes) — in that tree the entry cannot import anything,
// so it is neither stale nor missing there; the full check runs wherever the
// file set is intact (the private repo's own CI).
const present = [...allow].filter((f) => {
  try {
    statSync(join(ROOT, f));
    return true;
  } catch {
    return false;
  }
});
const absent = [...allow].filter((f) => !present.includes(f) && !importers.has(f));
const stale = present.filter((f) => !importers.has(f));
const missing = [...allow].filter((f) => {
  try {
    statSync(join(ROOT, f));
    return false;
  } catch {
    return importers.has(f); // imported by something else? keep the hard fail
  }
});

let fail = false;
if (offenders.length) {
  fail = true;
  console.error("✖ files OUTSIDE the adapter allowlist import @deepseek-ai/* directly:");
  for (const o of offenders) console.error(`  ${o}`);
  console.error("  → move the import behind an adapter module, or extend scripts/dsh-adapter-files.json in the same review as dsh-matrix changes");
}
if (missing.length) {
  fail = true;
  console.error("✖ allowlist entries whose file no longer exists:");
  for (const m of missing) console.error(`  ${m}`);
}
if (stale.length) {
  fail = true;
  console.error("✖ allowlist entries that import nothing @deepseek-ai anymore (stale):");
  for (const s of stale) console.error(`  ${s}`);
}
if (fail) process.exit(1);
console.log(
  `✓ dsh adapter boundary holds: ${importers.size} importer(s), all within the allowlist` +
    (absent.length ? ` (${absent.length} listed file(s) absent in this tree — snapshot-pruned)` : ""),
);
