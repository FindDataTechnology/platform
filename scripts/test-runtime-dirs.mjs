#!/usr/bin/env node
// ── Runtime-dir coverage gate (desktop-catch-up-release 1.2/1.3) ───────────
//
// Exercises scripts/lib/runtime-dirs.mjs: the single source of runtime
// directories the installer packs. The gate exists because three releases
// shipped with a referenced-but-unpacked directory (lib/, services/,
// agent-runner/); these tests prove the gate FAILS on exactly that shape and
// passes on the real repo layout.
//
//   node --test scripts/test-runtime-dirs.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { RUNTIME_DIRS, descriptorSpawnRefs, runtimeDirCoverageProblems } from "../scripts/lib/runtime-dirs.mjs";

const REAL_DESCRIPTORS = readFileSync(new URL("../supervisor/descriptors.js", import.meta.url), "utf8");

function makeTree(dirs) {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-dirs-"));
  for (const d of dirs) mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test("descriptorSpawnRefs extracts project-relative spawn dirs and root files", () => {
  const refs = descriptorSpawnRefs(`
    const a = { args: [path.join(projectRoot, "server.js")] };
    const b = { args: [path.join(projectRoot, "agent-runner", "index.js")] };
    const c = path.join(projectRoot, 'services', 'x', 'y.js');
    const ignore = path.join(someOtherRoot, "nope", "x.js");
  `);
  assert.deepEqual(refs, [
    { kind: "file", name: "server.js" },
    { kind: "dir", name: "agent-runner" },
    { kind: "dir", name: "services" },
  ]);
});

test("gate passes on the real repo layout and the real descriptors", () => {
  const root = new URL("..", import.meta.url).pathname;
  const problems = runtimeDirCoverageProblems({ root, descriptorSource: REAL_DESCRIPTORS });
  assert.deepEqual(problems, []);
});

test("gate fails when a descriptor references a directory outside RUNTIME_DIRS", () => {
  const root = makeTree([...RUNTIME_DIRS, "oops"]);
  writeFileSync(path.join(root, "oops", "x.js"), "");
  const problems = runtimeDirCoverageProblems({
    root,
    descriptorSource: `args: [path.join(projectRoot, "oops", "x.js")]`,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /oops.*neither RUNTIME_DIRS nor PACKED_ELSEWHERE_DIRS/);
  rmSync(root, { recursive: true, force: true });
});

test("gate fails when a referenced dir or a RUNTIME_DIRS entry is missing on disk", () => {
  const root = makeTree(RUNTIME_DIRS.filter((d) => d !== "gateway")); // RUNTIME_DIRS entry missing
  const problems = runtimeDirCoverageProblems({
    root,
    descriptorSource: `args: [path.join(projectRoot, "gateway", "index.js")]`, // referenced + missing
  });
  assert.equal(problems.length, 2);
  assert.match(problems.find((p) => p.includes("descriptor-referenced")), /gateway/);
  assert.match(problems.find((p) => p.includes("RUNTIME_DIRS entry")), /gateway/);
  rmSync(root, { recursive: true, force: true });
});

test("the files list actually carries every RUNTIME_DIRS entry", () => {
  // electron-builder.js generates its positive dir entries from the same list;
  // this pins that wiring so the single source cannot silently rot.
  const builder = readFileSync(new URL("../electron-builder.js", import.meta.url), "utf8");
  assert.match(builder, /RUNTIME_DIRS\.map\(\(d\) => `\$\{d\}\/\*\*`\)/);
  assert.ok(builder.includes('import { RUNTIME_DIRS }'));
});
