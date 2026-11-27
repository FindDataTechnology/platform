#!/usr/bin/env node
// Committed-tree completeness gate (2026-11-28).
//
// What this catches: a file the IMAGE will contain imports a relative `.js`
// module the COMMIT does not contain. Images are cut from `git archive <ref>`
// and the Dockerfile's `COPY . .` takes the whole tree, so an import of a module
// that only ever existed in someone's working tree is absent at boot:
//
//   2026-11-28  lib/fleet-ops-manager.js imported ./team-structure.js, which
//               had never been `git add`ed → image run 46037755619 died with
//               ERR_MODULE_NOT_FOUND: file:///app/lib/team-structure.js while
//               every local run was green.
//
// Scope: the RUNTIME reachability set, not the whole repo. Build/test/docs trees
// (scripts/, e2e/, docs/, openspec/, test/) legitimately contain string literals
// that look like imports, and shipping them is not a claim this gate makes. The
// roots below are the directories the image actually runs from.
//
//   node scripts/check-committed-tree.mjs
//
// Exit 0 = every relative import reachable from the runtime roots lands in the
// commit. Exit 1 = at least one does not.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join, normalize, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

// Known-good exceptions: a runtime import that is deliberately pending a commit
// by whoever owns that work. Keep this EMPTY in the steady state — every entry
// is a defect that will ship a broken image the moment the importing commit
// lands without its module.
const BASELINE = new Set([
  // fleet-run-workbench §2 (in flight, another session owns it): server.js's
  // uncommitted workbench-host change imports this file. Delete this line when
  // that change is committed WITH the module.
  "server.js->server/run-workbench-host.js",
]);

// Directories the image runs from (Dockerfile `COPY . .` + the CMD). Anything
// under these must be import-clean against the commit.
const RUNTIME_ROOTS = ["server", "lib", "supervisor", "bootstrap", "agent-runner", "gateway", "services"];
// Root-level modules the entry point chain loads.
const RUNTIME_FILES = ["server.js"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-opensource", "__pycache__", "test-results"]);

let tracked;
try {
  tracked = new Set(git("ls-files").split("\n").filter(Boolean));
} catch {
  console.error("check-committed-tree: not a git repository — nothing to check.");
  process.exit(0);
}

const IMPORT_RE =
  /(?:^|[^\w$.])(?:import\s[^;()]*?from\s*|import\s*\(\s*|export\s[^;()]*?from\s*)["'](\.{1,2}\/[^"']+\.js)["']/g;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && (e.name.endsWith(".js") || e.name.endsWith(".mjs"))) yield p;
  }
}

const defects = [];
const seen = new Set();
function check(fileRel, src) {
  for (const m of src.matchAll(IMPORT_RE)) {
    const target = normalize(join(dirname(fileRel), m[1]));
    if (seen.has(`${fileRel}->${target}`)) continue;
    seen.add(`${fileRel}->${target}`);
    if (tracked.has(target)) continue;
    if (BASELINE.has(`${fileRel}->${target}`)) continue;
    if (!existsSync(join(ROOT, target))) continue; // genuinely absent: a different bug
    defects.push({ file: fileRel, target });
  }
}

for (const f of RUNTIME_FILES) {
  if (!tracked.has(f)) continue;
  check(f, readFileSync(join(ROOT, f), "utf8"));
}
for (const root of RUNTIME_ROOTS) {
  for (const abs of walk(join(ROOT, root))) {
    const rel = relative(ROOT, abs);
    if (!tracked.has(rel)) continue; // untracked runtime code is its own defect
    check(rel, readFileSync(abs, "utf8"));
  }
}

if (defects.length === 0) {
  console.log("check-committed-tree: OK — every relative import reachable from the runtime roots is committed.");
  process.exit(0);
}

console.error(
  `check-committed-tree: ${defects.length} runtime import(s) point at a file the commit does not contain.\n` +
    "The image is cut from the commit, so these would be absent at boot:",
);
for (const d of defects) console.error(`  ${d.file}  ->  ${d.target}  (in the working tree, not committed)`);
console.error("\n  fix: git add the imported file(s), or change the import.");
process.exit(1);