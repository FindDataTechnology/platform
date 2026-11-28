// Tests for the copilot card resolver (openspec: unify-copilot-workbench 3.1/3.2).
// Run: node --test scripts/test-copilot-card.mjs
//
// The properties that matter are the ones that BREAK SILENTLY: a user override
// that quietly freezes a deployment default, an axis that moves when a sibling
// moved, or the proposeOnly invariant becoming configurable.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  resolveCopilotCard,
  mergeCopilotCard,
  BUILTIN_COPILOT_CARD,
  COPILOT_SURFACES,
  parseCopilotCardsEnv,
} = await import("../packages/core/src/lib/copilot-card.ts");

test("3.1 with no configuration the dock card matches the shipped constants", () => {
  const card = resolveCopilotCard("dock", {});
  // These four numbers are the pre-change hard-coded panel; a default that
  // drifts here changes every deployment's first impression.
  assert.equal(card.shell.placement, "left");
  assert.equal(card.shell.size.width, 420);
  assert.equal(card.shell.size.minWidth, 320);
  assert.equal(card.shell.defaultOpen, false);
  assert.equal(card.shell.pinned, false);
  // And the dock's own built-in: it is the board surface.
  assert.deepEqual(card.context, ["line", "page", "board", "viewSummary", "selection"]);
  assert.deepEqual(card.tools.readTools, ["board_read"]);
});

test("3.1 a surface with no explicit default still resolves to the builtin", () => {
  for (const surface of COPILOT_SURFACES) {
    const card = resolveCopilotCard(surface, {});
    assert.ok(card.shell && card.context && card.tools, `${surface} resolved`);
    assert.equal(card.tools.proposeOnly, true);
  }
});

test("3.1 user overrides one axis without freezing the others", () => {
  const card = resolveCopilotCard("dock", {
    deployment: { dock: { shell: { size: { width: 500 } }, tools: { presetId: "assistant-a" } } },
    user: { dock: { shell: { size: { width: 640 } } } },
  });
  assert.equal(card.shell.size.width, 640, "user width wins");
  // THE POINT: the deployment's later/default values still come through on the
  // axes the user did not touch.
  assert.equal(card.tools.presetId, "assistant-a", "preset untouched by a width override");
  assert.deepEqual(card.context, ["line", "page", "board", "viewSummary", "selection"]);
});

test("3.1 a partially-specified size keeps the other dimensions", () => {
  const card = resolveCopilotCard("dock", { user: { dock: { shell: { size: { width: 700 } } } } });
  assert.equal(card.shell.size.width, 700);
  assert.equal(card.shell.size.minWidth, 320, "minWidth was not specified anywhere and stays builtin");
});

test("3.1 an unknown placement is ignored, not applied", () => {
  const card = resolveCopilotCard("dock", { user: { dock: { shell: { placement: "diagonal" } } } });
  assert.equal(card.shell.placement, "left");
});

test("3.1 min larger than max is clamped so the panel stays resizable", () => {
  const card = resolveCopilotCard("dock", {
    user: { dock: { shell: { size: { width: 400, minWidth: 900 } } } },
  });
  assert.ok(card.shell.size.minWidth <= card.shell.size.width);
});

test("3.1 context and readTools replace rather than accumulate", () => {
  const card = resolveCopilotCard("dock", { user: { dock: { context: ["page"], tools: { readTools: ["other_read"] } } } });
  assert.deepEqual(card.context, ["page"]);
  assert.deepEqual(card.tools.readTools, ["other_read"]);
});

test("3.1 proposeOnly cannot be configured off", () => {
  const card = mergeCopilotCard(BUILTIN_COPILOT_CARD, { tools: { proposeOnly: false } });
  assert.equal(card.tools.proposeOnly, true, "the write-tool ban is an invariant, not a knob");
});

test("3.2 env JSON parses; junk degrades to no config without throwing", () => {
  assert.deepEqual(parseCopilotCardsEnv(""), null);
  assert.deepEqual(parseCopilotCardsEnv(undefined), null);
  assert.deepEqual(parseCopilotCardsEnv("{not json"), null);
  const parsed = parseCopilotCardsEnv(JSON.stringify({ dock: { shell: { defaultOpen: true } } }));
  assert.equal(parsed.dock.shell.defaultOpen, true);
  // A surface name that is not a copilot surface is dropped rather than kept
  // under an unreachable key.
  const filtered = parseCopilotCardsEnv(JSON.stringify({ nonsense: { shell: {} }, dock: { shell: { pinned: true } } }));
  assert.equal("nonsense" in filtered, false);
  assert.equal(filtered.dock.shell.pinned, true);
});
