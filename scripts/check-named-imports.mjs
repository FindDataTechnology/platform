#!/usr/bin/env node
// Named-import resolution gate (2026-11-24).
//
// What this catches: a caller imports `{ foo }` from a local module that does
// not export `foo`. Node only reports that at *load* time, so the symptom is
// `SyntaxError: does not provide an export named 'foo'` — which on 2026-11-24
// meant every image failed to boot while the files looked correct (a
// parallel-session "restore in-flight work" commit had replaced three modules
// wholesale, keeping the callers and dropping the implementations).
//
// Unit shards do catch it, but only the shard that happens to load that module,
// and only after the image is built. This runs in the lint job — first, fast,
// and it names every missing symbol at once.
//
// Scope is deliberately narrow: only RELATIVE imports of a few core modules,
// because those are the ones with many callers and no package boundary to
// police them. A full resolver would duplicate the module graph; this catches
// the failure mode that actually happened.
//
//   node scripts/check-named-imports.mjs
//
// Exit 0 = every relative named import resolves. Exit 1 = missing, named.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

//: Modules whose export surface many files import by name.
const WATCHED = [
  "dsh-profile.js",
  "db.js",
  "llm-providers.js",
  "credential-refs.js",
  "extension-store.js",
  "task-engine.js",
  "bundle-manifest.js",
  "catalog.js",
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-opensource", "build", ".venv",
  "attic", "__pycache__", "test-results", "playwright-report",
]);

function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { walk(full, out); continue; }
    if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/** Export names of a module: `export const|let|function|class X`, `export { a, b }`, `export *` (unknown). */
/**
 * Strip comments so an `import {…}` inside a comment cannot be read as a real
 * import (the first run of this gate flagged exactly that). A regex cannot
 * fully parse JS, but removing line and block comments before matching is enough
 * for the failure mode here.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*/gm, "");
}

function exportsOf(path) {
  const src = readFileSync(path, "utf8");
  const names = new Set();
  let star = false;
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  if (/^\s*export\s+\*\s+from/m.test(src)) star = true;
  return { names, star };
}

const watchedResolved = new Map(
  WATCHED.map((rel) => [rel, resolve(ROOT, rel)]).filter(([, p]) => existsSync(p)),
);

const problems = [];
let scanned = 0;
for (const file of walk(ROOT)) {
  const src = stripComments(readFileSync(file, "utf8"));
  scanned += 1;
  // Anchored at line start: a real static import begins a line (allowing
  // indentation). Anything mid-line is prose or a comment.
  for (const m of src.matchAll(/^[ \t]*import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/gm)) {
    const spec = m[2];
    const target = resolve(dirname(file), spec);
    const watched = [...watchedResolved].find(([, p]) => p === target);
    if (!watched) continue;
    const { names, star } = exportsOf(watched[1]);
    if (star) continue; // `export *` re-export: cannot decide statically, skip
    for (const raw of m[1].split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const symbol = t.split(/\s+as\s+/)[0].trim();
      if (!symbol || symbol.startsWith("type ")) continue;
      if (!names.has(symbol)) {
        problems.push(`${relative(ROOT, file)}: imports { ${symbol} } from ${spec} — not exported`);
      }
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} named import(s) do not resolve:\n`);
  for (const p of [...new Set(problems)].sort()) console.error(`  · ${p}`);
  console.error(
    "\nThis is the 2026-11-24 failure: a caller kept the import while the export went away,\n" +
    "and Node only says so at load time (every image failed to boot). Restore the export\n" +
    "from history rather than rewriting the caller.",
  );
  process.exit(1);
}

console.log(`✓ named imports resolve (${scanned} files, ${watchedResolved.size} watched modules)`);
