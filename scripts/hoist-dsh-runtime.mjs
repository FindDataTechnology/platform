#!/usr/bin/env node
// ── Hoist the dsh runtime's nested tree to the top-level node_modules ───────
//
// The dsh CLI loads its runtime components (170+ @deepseek-ai/dsh-* /
// cordis-plugin-* packages) from its NESTED node_modules. On a dev machine
// Node resolves them fine (sibling lookup inside dsh/node_modules), but
// electron-builder's dependency walk hoists only the packages it can reach
// through static imports — the dynamically-loaded rest gets dropped or
// partially flattened, and the packaged dsh dies on the first missing
// component (v1.3.2/v1.3.3 win-install-smoke: Cannot find package
// '@deepseek-ai/cordis-plugin-group').
//
// Fix at the source: copy every missing nested package up to the top-level
// node_modules BEFORE the builder runs, so the packed tree is complete
// regardless of the builder's hoisting behavior. Existing top-level packages
// are never overwritten (npm's own resolution already validated them).
//
// Idempotent; runs inside `predist` before verify-bundle.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DSH_NESTED = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "node_modules");
const TOP = path.join(PROJECT_ROOT, "node_modules");

if (!existsSync(DSH_NESTED)) {
  console.error(`❌ dsh nested tree missing at ${DSH_NESTED} — run npm install first.`);
  process.exit(1);
}

let copied = 0;
let skipped = 0;

for (const entry of readdirSync(DSH_NESTED, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith("@")) {
    // Scoped packages: @<scope>/<pkg> → node_modules/@<scope>/<pkg>
    const scopeDir = path.join(DSH_NESTED, entry.name);
    const topScopeDir = path.join(TOP, entry.name);
    mkdirSync(topScopeDir, { recursive: true });
    for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      hoist(path.join(scopeDir, pkg.name), path.join(topScopeDir, pkg.name));
    }
  } else {
    hoist(path.join(DSH_NESTED, entry.name), path.join(TOP, entry.name));
  }
}

function hoist(src, dest) {
  // Never overwrite an existing top-level package: npm already validated it,
  // and overwriting could regress a resolved native build.
  if (existsSync(dest)) {
    skipped++;
    return;
  }
  cpSync(src, dest, { recursive: true });
  copied++;
}

console.log(`✅ dsh nested tree hoisted: ${copied} package(s) copied, ${skipped} already present at top level.`);
