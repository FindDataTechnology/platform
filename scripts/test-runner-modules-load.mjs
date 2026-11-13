#!/usr/bin/env node
// ── Runner module-load smoke (2026-11-12 incident follow-up) ─────────────────
//
// Why this exists: image sha-ee757d0 crash-looped BOTH runner pods on boot with
//   SyntaxError: The requested module './compose.js' does not provide an export
//   named 'billingKeyFromHome'
// — manager.js imported a name its sibling module did not export. Nothing caught
// it: biome's report on that same line was read as "unused-import debt", the
// agent-runner suite was not part of the release gate, and the feature suites I
// did run never import manager.js. So the cheap, total check: import every
// module under agent-runner/ and let Node's own linker be the judge. A missing
// export or a typo'd path fails in milliseconds instead of at pod start.
//
//   node --test scripts/test-runner-modules-load.mjs

import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["agent-runner", "lib", "gateway"];
// Side-effectful entrypoints: importing them BOOTS something (listeners, pollers,
// a server). The linker check does not need them in the set, and importing them
// here would start real work in a unit run.
const SKIP = new Set(["agent-runner/index.js", "agent-runner/main.js", "gateway/index.js", "server.js"]);

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) jsFiles(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => {
  const dir = path.join(REPO_ROOT, root);
  try {
    return jsFiles(dir);
  } catch {
    return []; // a tree that does not exist in this checkout is not a failure
  }
}).filter((f) => !SKIP.has(path.relative(REPO_ROOT, f)));

// Without installed deps every module that imports express/js-yaml/better-sqlite3
// fails with "Cannot find package", which says nothing about our code. Skip
// loudly instead of reporting a fake red (measured: a bare release worktree
// produced 117 pass / 1 fail made entirely of missing packages).
const hasDeps = existsSync(path.join(REPO_ROOT, "node_modules"));

test("every runner/lib/gateway module links — a missing export cannot reach a pod", { skip: hasDeps ? false : "node_modules not installed" }, async () => {
  assert.ok(files.length > 20, `expected to find the module trees, found ${files.length}`);
  const failures = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (e) {
      failures.push(`${path.relative(REPO_ROOT, file)}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `modules that fail to load:\n${failures.join("\n")}`);
});
