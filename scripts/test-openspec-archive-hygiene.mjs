#!/usr/bin/env node
// ── Archive hygiene: "complete" must mean "in effect" ───────────────────────
//
// Three changes were found sitting in openspec/changes/ with every task ticked
// and `openspec validate --strict` green (add-memory-visible-ux,
// add-erp-supply-chain-gateway-proxy, add-lex-line-board). Their spec deltas
// were therefore NOT in openspec/specs/ — the contract they described had never
// taken effect, while `openspec list` showed a reassuring "✓ Complete".
//
// The failure mode is structural, not careless: ticking the last task feels
// like finishing, and nothing anywhere fails when the archive step is skipped.
// This check is that missing failure. It is deliberately narrow — it does not
// judge whether a change SHOULD be archived (a change may legitimately sit
// complete-but-open while an image ships), so it can only fail when a change
// claims completion it has not delivered into specs/.
//
//   node --test scripts/test-openspec-archive-hygiene.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES = path.join(REPO, "openspec", "changes");

// Read the change list from tasks.md — NOT through the `openspec` CLI. The CLI
// is installed globally on a developer machine but is deliberately NOT a
// dependency of this repo, so shelling out to `npx openspec` would fail (or
// worse, try to download) inside CI's fresh snapshot. The markdown is the
// source of truth anyway: a task is done iff its line starts with "- [x]".
function changeList() {
  if (!existsSync(CHANGES)) return [];
  const changes = [];
  for (const entry of readdirSync(CHANGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const tasksPath = path.join(CHANGES, entry.name, "tasks.md");
    if (!existsSync(tasksPath)) continue;
    const lines = readFileSync(tasksPath, "utf8").split("\n");
    const total = lines.filter((l) => /^- \[[ xX]\]/.test(l)).length;
    const done = lines.filter((l) => /^- \[[xX]\]/.test(l)).length;
    changes.push({ name: entry.name, completedTasks: done, totalTasks: total });
  }
  return changes;
}

// A change "claims completion" when it has tasks AND all of them are ticked.
// The two are different assertions on purpose: a 0-task change is not complete.
const completeButOpen = (changes) =>
  changes.filter((c) => (c.totalTasks ?? 0) > 0 && c.completedTasks === c.totalTasks);

test("a change with every task ticked is archived, not merely listed as complete", () => {
  const offenders = completeButOpen(changeList()).map((c) => `${c.name} (${c.completedTasks}/${c.totalTasks})`);
  assert.deepEqual(
    offenders,
    [],
    "every task is ticked but the change still sits in openspec/changes/, so its spec delta " +
      "never reached openspec/specs/ — archive it (openspec archive <name> --yes) or leave a " +
      `deliberate unticked task with a reason:\n${offenders.join("\n")}`,
  );
});

test("the check itself fails on a synthetic offender", () => {
  // Reverse verification, in-test: if this predicate ever stops catching the
  // shape it exists for, the suite must say so rather than pass vacuously.
  const fake = [
    { name: "done-but-open", completedTasks: 3, totalTasks: 3 },
    { name: "genuinely-open", completedTasks: 2, totalTasks: 3 },
    { name: "no-tasks", completedTasks: 0, totalTasks: 0 },
  ];
  assert.deepEqual(completeButOpen(fake).map((c) => c.name), ["done-but-open"]);
});
