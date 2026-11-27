#!/usr/bin/env node
// Every workflow file must be one GitHub can actually load
// (measured 2026-11-14).
//
// Why: `.github/workflows/live-supply-owner-acceptance.yml` carried `name:` twice
// at the top level. GitHub refuses to load such a file — and it says so nowhere
// useful: the push that contained it produced a run whose NAME was the file
// path, with zero jobs and "log not found". Read from the outside, that looks
// like a lane that ran and failed; what actually happened is that the lane has
// never existed. The workflow's own header says "Dispatch-only by design", so
// nobody was waiting for a run to confirm it.
//
// That is the same shape as every other silent lane defect in this repo: the
// absence of a thing looks like a quiet success. A parse check is cheap and it
// is the only judge that agrees with GitHub about validity — `yaml` accepts
// duplicate keys with a warning, so the duplicate scan is done on the raw
// top-level keys, not through the parser.
//
// Run: node scripts/test-workflow-definitions.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, "..", ".github", "workflows");

// GitHub's accepted event names. A typo (`on: pussh`) is accepted by YAML and by
// GitHub's parser, and simply never fires — the same silence as a duplicate key.
const EVENTS = new Set([
  "branch_protection_rule", "check_run", "check_suite", "create", "delete",
  "deployment", "deployment_status", "discussion", "discussion_comment", "fork",
  "gollum", "issue_comment", "issues", "label", "merge_group", "milestone",
  "page_build", "project", "project_card", "project_column", "public",
  "pull_request", "pull_request_comment", "pull_request_review",
  "pull_request_review_comment", "pull_request_target", "push", "registry_package",
  "release", "repository_dispatch", "schedule", "status", "watch", "workflow_call",
  "workflow_dispatch", "workflow_run",
]);

// Top-level keys this repo's lanes legitimately use. Anything else is either a
// typo or a key GitHub will reject outright.
const ALLOWED_TOP_LEVEL = new Set([
  "name", "on", "jobs", "env", "permissions", "concurrency", "defaults", "run-name",
]);

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => path.join(WORKFLOW_DIR, f));
}

// Duplicate top-level keys, straight off the text: `yaml` keeps the last one and
// only warns, which is precisely the failure mode being guarded.
function duplicateTopLevelKeys(text) {
  const seen = new Map();
  const dupes = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) dupes.push(`${key} ×${seen.get(key) + 1}`);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return dupes;
}

// `on:` may be a string, a list, or a map of events.
function declaredEvents(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

function inspect(file) {
  const text = readFileSync(file, "utf8");
  const problems = [];

  const dupes = duplicateTopLevelKeys(text);
  if (dupes.length) problems.push(`duplicate top-level key(s): ${dupes.join(", ")}`);

  let doc;
  try {
    doc = parseYaml(text, { uniqueKeys: false });
  } catch (err) {
    problems.push(`unparseable YAML: ${String(err?.message || err).split("\n")[0]}`);
    return problems;
  }

  if (!doc || typeof doc !== "object") {
    problems.push("not a mapping");
    return problems;
  }
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) problems.push(`unknown top-level key '${key}'`);
  }
  const events = declaredEvents(doc.on);
  if (!events.length) problems.push("no trigger (`on:` missing or empty)");
  for (const event of events) {
    if (!EVENTS.has(event)) problems.push(`unknown trigger '${event}'`);
  }
  if (!doc.jobs || typeof doc.jobs !== "object" || !Object.keys(doc.jobs).length) {
    problems.push("no jobs");
  }
  return problems;
}

let passed = 0;
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};
const ok = (msg) => {
  passed++;
  console.log(`  ok  ${msg}`);
};

// ── The tree itself ────────────────────────────────────────────────────────
const files = workflowFiles();
assert.ok(files.length >= 10, `expected the workflow tree, found ${files.length} file(s)`);
for (const file of files) {
  const rel = path.relative(path.join(HERE, ".."), file);
  const problems = inspect(file);
  if (problems.length) fail(`${rel}: ${problems.join("; ")}`);
  else ok(`${rel}`);
}

// ── The shard count is one fact in two places ──────────────────────────────
// `ci.yml` declares the matrix list AND the literal the artifact-less fallback
// checks (`--check-split 8`). They can drift silently: the fallback would then
// verify a split nobody is running. Measured 2026-11-14 while adding that
// fallback — the two numbers are five hundred lines apart in one file.
{
  const ci = parseYaml(readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8"), { uniqueKeys: false });
  const matrix = ci?.jobs?.unit?.strategy?.matrix?.shard;
  const declared = Array.isArray(matrix) ? matrix.length : Number(matrix?.length ?? 0);
  const scripts = JSON.stringify(ci?.jobs ?? {});
  const used = [...scripts.matchAll(/--check-split (\d+)/g)].map((m) => Number(m[1]));
  if (!declared) fail("ci.yml: unit matrix has no shard list");
  else if (used.length === 0) fail("ci.yml: the coverage fallback does not call --check-split");
  else if (used.some((n) => n !== declared)) {
    fail(`ci.yml: --check-split ${used.join("/")} but the matrix declares ${declared} shard(s)`);
  } else ok(`ci.yml: --check-split ${declared} matches the matrix (${declared} shards)`);
}

// ── The checker can go red (a gate nobody has seen fail is a guess) ─────────
function checkSynthetic(name, text, expected) {
  try {
    const problems = (() => {
      const dupes = duplicateTopLevelKeys(text);
      const out = dupes.length ? [`duplicate top-level key(s): ${dupes.join(", ")}`] : [];
      const doc = parseYaml(text, { uniqueKeys: false });
      for (const key of Object.keys(doc ?? {})) {
        if (!ALLOWED_TOP_LEVEL.has(key)) out.push(`unknown top-level key '${key}'`);
      }
      const events = declaredEvents(doc?.on);
      if (!events.length) out.push("no trigger (`on:` missing or empty)");
      for (const e of events) if (!EVENTS.has(e)) out.push(`unknown trigger '${e}'`);
      if (!doc?.jobs || !Object.keys(doc.jobs ?? {}).length) out.push("no jobs");
      return out;
    })();
    assert.ok(problems.some((p) => p.includes(expected)), `expected '${expected}', got ${JSON.stringify(problems)}`);
    ok(`${name} → red (${expected})`);
  } catch (err) {
    fail(`${name}: ${String(err?.message || err).split("\n")[0]}`);
  }
}

// The exact defect that motivated this file, reproduced verbatim.
checkSynthetic(
  "duplicate `name:`",
  "name: live-supply-owner-acceptance\nname: live-supply-owner-acceptance\non:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
  "duplicate top-level key",
);
checkSynthetic(
  "typo'd trigger",
  "name: x\non:\n  pussh:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
  "unknown trigger 'pussh'",
);
checkSynthetic(
  "no trigger",
  "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
  "no trigger",
);
checkSynthetic(
  "no jobs",
  "name: x\non:\n  workflow_dispatch:\n",
  "no jobs",
);
checkSynthetic(
  "unknown top-level key",
  "name: x\non: push\njobz:\n  a: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
  "unknown top-level key 'jobz'",
);

console.log(`\nworkflow definitions: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
