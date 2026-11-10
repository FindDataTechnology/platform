#!/usr/bin/env node
// ── Cell MCP budget tests
//    (enable-constructor-skill-authoring / D8 ④ 容量面) ───────────────────────
//
// Pins the install-face budget for MCP server count. Motivation (2026-11-08
// live): 41 installed packs → 32 MCP servers → dsh init exceeded its 60s
// budget → the entire cell was unreachable and every fleet's rounds were
// skipped, with the only symptom being "initialize timed out".
//
//   node --test scripts/test-cell-mcp-budget.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { mcpNamesOf, projectedMcpNames, mcpBudgetCheck, DEFAULT_MCP_SOFT_LIMIT, DEFAULT_MCP_HARD_LIMIT } =
  await import(path.join(here, "../lib/cell-mcp-budget.js"));

const manifestOf = (...names) => ({ mcpServers: names.map((n) => ({ registryName: n })) });
const manyManifests = (count) =>
  Array.from({ length: count }, (_, i) => manifestOf(`srv_${i}`));

test("mcpNamesOf is shape-tolerant", () => {
  assert.deepEqual([...mcpNamesOf(manifestOf(" a ", "b"))].sort(), ["a", "b"]);
  for (const bad of [null, {}, { mcpServers: null }, { mcpServers: [null, {}, { registryName: 5 }] }]) {
    assert.equal(mcpNamesOf(bad).size, 0, `must not throw on ${JSON.stringify(bad)}`);
  }
});

test("overlapping references count once — the profile materialises the union", () => {
  const existing = [manifestOf("fleet-architect", "facet-market")];
  const incoming = manifestOf("facet-market", "actions-mcp");
  const union = projectedMcpNames(existing, incoming);
  assert.deepEqual([...union].sort(), ["actions-mcp", "facet-market", "fleet-architect"]);
});

test("under the soft limit is a clean ok with no message", () => {
  const out = mcpBudgetCheck({ existingManifests: manyManifests(5), incomingManifest: manifestOf("x") });
  assert.equal(out.level, "ok");
  assert.equal(out.ok, true);
  assert.equal(out.message, null);
  assert.equal(out.count, 6);
});

test("crossing the soft limit still installs but names the real cause", () => {
  const out = mcpBudgetCheck({
    existingManifests: manyManifests(DEFAULT_MCP_SOFT_LIMIT),
    incomingManifest: manifestOf("extra"),
  });
  assert.equal(out.level, "soft");
  assert.equal(out.ok, true);
  assert.match(out.message, /60s/);
  assert.match(out.message, /stops starting/);
});

test("crossing the hard limit refuses and explains the whole-cell impact", () => {
  const out = mcpBudgetCheck({
    existingManifests: manyManifests(DEFAULT_MCP_HARD_LIMIT),
    incomingManifest: manifestOf("one_too_many"),
  });
  assert.equal(out.level, "hard");
  assert.equal(out.ok, false);
  assert.match(out.message, /EVERY fleet on it stops running/);
  assert.match(out.message, /Uninstall unused packs/);
  assert.deepEqual(out.added, ["one_too_many"]);
});

test("the 2026-11-08 incident shape is refused, not silently accepted", () => {
  // 32 distinct servers on the cell — the observed failing state.
  const out = mcpBudgetCheck({ existingManifests: manyManifests(32), incomingManifest: null });
  assert.equal(out.level, "hard");
  assert.equal(out.ok, false);
  assert.equal(out.count, 32);
});

test("env overrides move both limits, and hard never sits below soft", () => {
  const out = mcpBudgetCheck({
    existingManifests: manyManifests(9),
    incomingManifest: manifestOf("ten"),
    env: { CELL_MCP_SOFT_LIMIT: "5", CELL_MCP_HARD_LIMIT: "8" },
  });
  assert.equal(out.softLimit, 5);
  assert.equal(out.hardLimit, 8);
  assert.equal(out.level, "hard");

  const weird = mcpBudgetCheck({
    existingManifests: manyManifests(2),
    incomingManifest: null,
    env: { CELL_MCP_SOFT_LIMIT: "30", CELL_MCP_HARD_LIMIT: "5" },
  });
  assert.equal(weird.hardLimit, 30, "hard is clamped up to soft");
});
