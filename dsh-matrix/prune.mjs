#!/usr/bin/env node
// dsh-matrix/prune.mjs — post-install pruner for the matrix tree (ADR-0023 D2).
//
// Removes, from an installed matrix tree, every package whose name matches a
// pattern in prune.json. Pure host-side code: node builtins only, never any
// @deepseek-ai package — it may run inside a Docker layer where only the
// freshly installed tree exists.
//
// The lock (not the directory listing) is the enumeration source: patterns
// match package NAMES, so nested instances (e.g. fflate under libreoffice-kit)
// are found through their lock paths and their directories removed wherever
// they sit under the tree root.
//
// Usage: node dsh-matrix/prune.mjs [--tree <install-root>]   (default /opt/dsh)

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const tree = process.argv.includes("--tree")
  ? process.argv[process.argv.indexOf("--tree") + 1]
  : "/opt/dsh";

const listPath = join(HERE, "prune.json");
if (!existsSync(listPath)) {
  console.error(`[dsh-prune] no prune.json beside ${import.meta.url} — nothing to do`);
  process.exit(0);
}
const { prune = [] } = JSON.parse(readFileSync(listPath, "utf8"));
const patterns = prune.flatMap((entry) => entry.match ?? []);
if (patterns.length === 0) {
  console.log("[dsh-prune] prune list is empty — nothing to do");
  process.exit(0);
}

const matches = (name) =>
  patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

const lockPath = join(tree, "package-lock.json");
if (!existsSync(lockPath)) {
  console.error(`[dsh-prune] no package-lock.json under ${tree} — is this a matrix install?`);
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

let removed = 0;
for (const key of Object.keys(lock.packages ?? {})) {
  if (key === "") continue;
  const idx = key.lastIndexOf("node_modules/");
  const name = idx === -1 ? null : key.slice(idx + "node_modules/".length);
  if (!name || !matches(name)) continue;
  const dir = join(tree, key);
  if (!existsSync(dir)) continue;
  rmSync(dir, { recursive: true, force: true });
  removed += 1;
}
console.log(`[dsh-prune] removed ${removed} package dir(s) matching ${patterns.length} pattern(s) from ${tree}`);
