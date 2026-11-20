// Unit tests — official assistant packs carry NO write tools (add-wire-line-board
// 6.2; add-line-boards-and-action-gate D9 lint, made real here).
// Run: node --test scripts/test-official-packs-lint.mjs
//
// Every docs/official-packs/*.json is a copilot pack: its allowTools must be
// disjoint from the wire write-tool universe (lib/wire-tool-risk.js, 17 keys
// vendored from the two MCP repos' tool_risk — 12 + the pack and market
// subscribe/unsubscribe pairs + wire_action_propose, wire-domain-actions) and from the facet/wanxing
// write tools the action registry names. The wire pack is additionally pinned
// to its exact 11-tool read face and to the manifest validator. Since v2
// (copilot-dock-focused-preset D6) the three packs carry DISTINCT agent ids:
// the catalog agent id is the manifest agent id, so a shared `assistant` let
// only the first-installed pack materialize its agent.
//
// Mutation check (manual): add "wire_demand_submit" to the wire manifest's
// allowTools → the first test fails naming the tool.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = path.resolve(here, "..", "docs", "official-packs");

const { WIRE_WRITE_TOOLS, isWireWriteTool } = await import("../lib/wire-tool-risk.js");
const registry = await import("../lib/action-registry.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");

const manifests = fs
  .readdirSync(PACKS_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, manifest: JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), "utf8")) }));

const allowToolsOf = (manifest) =>
  (manifest.mcpServers ?? []).flatMap((s) => (Array.isArray(s.allowTools) ? s.allowTools.map((t) => [s.registryName, t]) : []));

// Every tool the action registry executes through the gate is, by definition,
// a write tool no copilot pack may call directly.
const REGISTRY_WRITE_TOOLS = new Set(registry.listActions().map((a) => a.tool));

test("official packs exist and include the wire assistant", () => {
  assert.ok(manifests.length >= 3);
  assert.ok(manifests.some((m) => m.file === "wire-assistant-manifest.json"));
});

test("no official pack whitelists any wire write tool (tool_risk universe, 18 gated names)", () => {
  // 18 = the sources' declared tools minus `read`. Read names are mirrored in
  // WIRE_TOOL_RISK but stay ungated, so a pack may declare them.
  assert.equal(WIRE_WRITE_TOOLS.length, 18);
  assert.equal(isWireWriteTool("wire_self_action_list"), false, "read stays outside the gate");
  const offenders = [];
  for (const { file, manifest } of manifests) {
    for (const [server, tool] of allowToolsOf(manifest)) {
      if (isWireWriteTool(tool)) offenders.push(`${file}: ${server}/${tool}`);
    }
  }
  assert.deepEqual(offenders, [], `write tools in copilot pack allowTools:\n  ${offenders.join("\n  ")}`);
  // Domain-action proposal (wire_action_propose) is in the universe above, so
  // this lint already refuses any copilot pack that whitelists it. That is the
  // intended consequence, not an accident: proposing an action is a write, and
  // a focused assistant pack is a read-only face by definition.
  assert.equal(isWireWriteTool("wire_action_propose"), true);
});

test("no official pack whitelists any gated tool from the action registry (facet/wanxing/wire)", () => {
  const offenders = [];
  for (const { file, manifest } of manifests) {
    for (const [server, tool] of allowToolsOf(manifest)) {
      if (REGISTRY_WRITE_TOOLS.has(tool)) offenders.push(`${file}: ${server}/${tool}`);
    }
  }
  assert.deepEqual(offenders, [], `gated tools in copilot pack allowTools:\n  ${offenders.join("\n  ")}`);
});

test("wire assistant: exact 11-tool read face, both servers group-gated, private first", () => {
  const { manifest } = manifests.find((m) => m.file === "wire-assistant-manifest.json");
  const byServer = Object.fromEntries((manifest.mcpServers ?? []).map((s) => [s.registryName, s]));
  assert.deepEqual(Object.keys(byServer).sort(), ["wire-build-mcp", "wire-ops-mcp"]);
  assert.deepEqual(
    [...byServer["wire-ops-mcp"].allowTools].sort(),
    ["wire_dataset_aggregate", "wire_dataset_query", "wire_dataset_rows", "wire_datasets_list", "wire_demand_read", "wire_demands_list", "wire_market_browse"],
  );
  assert.deepEqual(
    [...byServer["wire-build-mcp"].allowTools].sort(),
    ["wire_artifact_get", "wire_artifact_list", "wire_dataset_corrections_list", "wire_dataset_schema"],
  );
  for (const s of manifest.mcpServers) assert.equal(s.requiredGroup, "wire-customers", s.registryName);
  assert.equal(manifest.visibility, "private");
  assert.equal(manifest.agents?.[0]?.id, "wire-assistant");
  assert.match(manifest.agents[0].persona, /propose_action/);
  assert.match(manifest.agents[0].persona, /公开源 URL/);
  assert.match(manifest.agents[0].persona, /boards\/wire/);
  assert.ok(manifest.skills?.some((s) => s.name === "wire-console-playbook" && /能力边界/.test(s.content)));
});

test("all official packs pass the manifest validator", () => {
  for (const { file, manifest } of manifests) {
    const errors = validatePackManifest(manifest);
    assert.deepEqual(errors, [], `${file}: ${JSON.stringify(errors)}`);
  }
});

test("official assistant agent ids are distinct across packs (v2: no shared `assistant`)", () => {
  const ids = manifests.map(({ file, manifest }) => [file, manifest.agents?.[0]?.id]);
  for (const [file, id] of ids) assert.ok(id && id !== "assistant", `${file}: agent id '${id}' must be pack-specific`);
  assert.equal(new Set(ids.map(([, id]) => id)).size, ids.length, `duplicate agent ids: ${JSON.stringify(ids)}`);
  assert.deepEqual(
    Object.fromEntries(ids),
    {
      "facet-assistant-manifest.json": "facet-assistant",
      "wanxing-fleet-assistant-manifest.json": "wanxing-fleet-assistant",
      "wire-assistant-manifest.json": "wire-assistant",
    },
  );
});
