// The pure derivations behind the role roster (add-agent-roster-management
// 3.1/3.2/3.4). The package has no DOM test runner — the repo's precedent for
// frontend logic is a pure module imported by a scripts/test-*.mjs file (see
// test-cadence-draft.mjs, test-board-tabs-agreement.mjs) — so every decision
// the view makes that could be wrong lives in web/src/lib/roster-view.ts and
// is pinned here.
//
// The three states that must never collapse into one another:
//   usage unavailable ≠ zero turns ≠ not read yet (design D7).
// And the three capability predicates: local is never hideable, copy/adjust
// apply only to roles whose persona this cell owns.
//
// Run: node --test scripts/test-agent-roster-view.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { addHidden, canAdjust, canCopy, canHide, removeHidden, sourceOf, toRow, usageFor } from "../web/src/lib/roster-view.ts";

const packAgent = { id: "pack-a.role", type: "agent-remote", name: "Role", packId: "pack-a", packName: "Pack A" };
const customPreset = { id: "user.mine", type: "agent-remote", customPreset: true, name: "Mine" };
const localAgent = { id: "local", type: "agent-local", name: "Platform" };
const catalogAgent = { id: "remote.chat", type: "agent-remote", name: "Remote" };

test("source: the four kinds are distinguished, and pack/custom/resources survive", () => {
  assert.equal(sourceOf(packAgent), "pack");
  assert.equal(sourceOf(customPreset), "custom");
  assert.equal(sourceOf(localAgent), "local");
  assert.equal(sourceOf(catalogAgent), "catalog");

  const row = toRow({
    ...packAgent,
    resourceSummary: { skillCount: 3, mcpCount: 2, declared: true },
  });
  assert.equal(row.packName, "Pack A");
  assert.equal(row.skillCount, 3);
  assert.equal(row.mcpCount, 2);

  const bare = toRow(localAgent);
  assert.equal(bare.skillCount, null, "no summary → null, never a fabricated 0");
  assert.equal(bare.mcpCount, null);
});

test("capabilities: local is never hideable; copy/adjust only for owned personas", () => {
  assert.equal(canHide(toRow(localAgent)), false, "the runtime carrier is not a partner");
  assert.equal(canHide(toRow(packAgent)), true);
  assert.equal(canHide(toRow(customPreset)), true);

  assert.equal(canCopy(toRow(packAgent)), true);
  assert.equal(canCopy(toRow(customPreset)), true);
  assert.equal(canCopy(toRow(catalogAgent)), false, "a catalog-only role has no persona this cell owns");
  assert.equal(canCopy(toRow(localAgent)), false);

  assert.equal(canAdjust(toRow(packAgent)), true);
  assert.equal(canAdjust(toRow(catalogAgent)), false);
});

test("usage: unavailable ≠ zero ≠ loading ≠ some", () => {
  assert.deepEqual(usageFor("x", null, false), { state: "loading" });
  assert.deepEqual(usageFor("x", { rows: [] }, true), { state: "unknown" }, "a failed read is UNKNOWN, never 0");
  assert.deepEqual(usageFor("x", { rows: [] }, false), { state: "zero" }, "a successful read with no row is ZERO");

  const doc = { rows: [{ agentId: "x", turns: 7, lastUsedAt: 1700000000000 }] };
  assert.deepEqual(usageFor("x", doc, false), { state: "some", turns: 7, lastUsedAt: 1700000000000 });

  // A row that exists with turns:0 is still ZERO, not SOME.
  assert.deepEqual(usageFor("x", { rows: [{ agentId: "x", turns: 0, lastUsedAt: 1 }] }, false), { state: "zero" });
});

test("usage: a failed read outranks a stale doc (failure is the fresher fact)", () => {
  const doc = { rows: [{ agentId: "x", turns: 7, lastUsedAt: 1 }] };
  assert.deepEqual(usageFor("x", doc, true), { state: "unknown" });
});
test("hidden algebra: hide/restore are idempotent complete-set edits (3.4)", () => {
  assert.deepEqual(addHidden([], "a"), ["a"]);
  assert.deepEqual(addHidden(["a"], "b"), ["a", "b"]);
  assert.deepEqual(addHidden(["a", "b"], "a"), ["a", "b"], "hiding twice is one hide");

  assert.deepEqual(removeHidden(["a", "b"], "a"), ["b"]);
  assert.deepEqual(removeHidden(["b"], "missing"), ["b"], "restoring an absent id changes nothing");

  // Hide-then-restore of the SAME id lands exactly where it started — this is
  // what makes a retried write converge rather than oscillate.
  const start = ["x", "y"];
  const hidden = addHidden(start, "z");
  assert.deepEqual(hidden, ["x", "y", "z"]);
  assert.deepEqual(removeHidden(hidden, "z"), start);
});

test("hidden algebra: the count the section shows tracks the set", () => {
  let set = [];
  assert.equal(set.length, 0);
  set = addHidden(set, "a");
  set = addHidden(set, "b");
  assert.equal(set.length, 2, "section header reads 已隐藏(2)");
  set = removeHidden(set, "a");
  assert.equal(set.length, 1, "restoring one drops the count by one");
});
