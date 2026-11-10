#!/usr/bin/env node
// ── Per-post server trimming (trim-mcp-injection-per-post 2.x) ──────────────
//
// The cell composes ONE mcp.patch.yml for every persona, so all 34 servers'
// schemas are in scope regardless of which post runs. 2026-11-09/10 the owner
// cell carried 34 servers while a single post referenced 3, and after cron
// session rotation shipped a FRESH round still died with "turn stopped early —
// context pressure (4 compactions)": a new session starts out already near the
// window. Rotation cures "worse the longer it runs"; trimming cures "starts
// out too high". Both are needed.
//
// Safety valve pinned first: a post that declares NOTHING must keep the full
// composition. Dropping servers for an undeclared face would silently remove
// tools from a working post — strictly worse than a fat context.
//
//   node --test scripts/test-mcp-post-trim.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { trimServersToFace, serversFromFace, describeTrim } = await import(
  path.join(here, "../lib/mcp-post-trim.js")
);

const row = (name) => ({ id: `mcp-${name}`, config: { serverName: name } });

const CELL = [
  "facet-market", "wire-ops", "lex-ops", "fd-erp-ledger-mcp", "actions", "fleet",
  "bench-proposal", "library", "cron", "delegation", "airegistry-tools", "blueprint-author",
  "chatwoot", "facet-market-mcp", "facet-ops-mcp", "fd-cn-report", "fd-daas-mcp",
  "fd-find-data-business-mcp", "fd-info", "fd-open-data-mcp", "fd-quant", "fd-sentiment",
  "fd-text-core", "fleet-architect", "infra-telemetry", "pack-author", "persona-evolution",
  "playwright", "skill-evolution", "websearch", "wire-build-mcp", "wire-ops-mcp",
  "connector_chat_explore_ba29f742", "fd-memory",
].map(row);

test("1. the live cell shape: 34 servers trimmed to the constructor's 3", () => {
  const face = {
    "fleet-architect": ["fleet_list", "fleet_spec_read", "fleet_draft", "fleet_turns_read"],
    "facet-market": ["facet_market_pack_browse"],
    "actions-mcp": ["propose_action"],
  };
  const allowed = serversFromFace(face);
  const out = trimServersToFace(CELL, { allowed, keepMemory: true });
  const names = out.map((e) => e.config.serverName).sort();
  // actions-mcp has no row in CELL (the cell carries "actions"), so the trim
  // keeps only what exists — never invents a row for a declared-but-absent name.
  // `fleet` rides along: it carries report_status, a platform obligation.
  assert.deepEqual(names, ["facet-market", "fd-memory", "fleet", "fleet-architect"]);
  assert.ok(out.length <= 4, `expected <=4 servers, got ${out.length}`);
});

test("2. SAFETY VALVE: an empty/absent face keeps the full composition", () => {
  assert.equal(trimServersToFace(CELL, {}).length, CELL.length);
  assert.equal(trimServersToFace(CELL, { allowed: null }).length, CELL.length);
  assert.equal(trimServersToFace(CELL, { allowed: [] }).length, CELL.length);
  assert.equal(trimServersToFace(CELL, { allowed: serversFromFace(null) }).length, CELL.length);
});

test("3. the memory row survives a trim even when the face omits it", () => {
  const allowed = new Set(["fleet-architect"]);
  const out = trimServersToFace(CELL, { allowed, keepMemory: true });
  assert.ok(out.some((e) => e.config.serverName === "fd-memory"));
  const withoutKeep = trimServersToFace(CELL, { allowed, keepMemory: false });
  assert.ok(!withoutKeep.some((e) => e.config.serverName === "fd-memory"));
});

test("4. the input array is never mutated (the shared patch keeps serving chat)", () => {
  const before = CELL.length;
  const out = trimServersToFace(CELL, { allowed: new Set(["fleet-architect"]) });
  assert.equal(CELL.length, before, "input length unchanged");
  assert.notEqual(out, CELL, "a new array comes back");
});

test("5. malformed rows are dropped, not kept by accident", () => {
  const junk = [{ id: "x" }, { config: {} }, { config: { serverName: "" } }, row("fleet-architect")];
  const out = trimServersToFace(junk, { allowed: new Set(["fleet-architect"]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].config.serverName, "fleet-architect");
});

test("6. serversFromFace tolerates junk and de-duplicates", () => {
  assert.deepEqual([...serversFromFace({ a: [], a2: [], b: [] })].sort(), ["a", "a2", "b"]);
  assert.equal(serversFromFace(null).size, 0);
  assert.equal(serversFromFace([1, 2]).size, 0, "an array is not a face map");
  assert.equal(serversFromFace({ "": [], x: [] }).size, 1, "empty key is not a server");
});

test("7. describeTrim reports the reduction honestly", () => {
  // fleet-architect (declared) + fleet (report lane) + nothing else.
  assert.equal(describeTrim(CELL, trimServersToFace(CELL, { allowed: new Set(["fleet-architect"]) })),
    "trimmed 34 → 2 server(s) (dropped 32)");
  assert.equal(describeTrim(CELL, CELL), "trimmed 34 → 34 server(s)");
});

// ── faceForPresetFromPacks ──────────────────────────────────────────────────
// The wiring half: the writer's safety valve keeps all 34 servers unless a
// face is actually resolved. 2026-11-10 production logged
// "injection surface: 34 MCP server(s)" with NO trim line, because the only
// caller passed no face. These pin the resolver's contract.

// Importing dsh-profile.js would pull js-yaml and the whole profile stack into
// a pure-function test (and fails in a bare worktree without node_modules).
// The resolver is imported lazily and guarded so the trim contract still
// runs everywhere; the resolver cases skip only when the module is absent.
let faceForPresetFromPacks = null;
try {
  ({ faceForPresetFromPacks } = await import(path.join(here, "../dsh-profile.js")));
} catch (e) {
  console.warn(`[test] faceForPresetFromPacks unavailable (${e.code || e.message}); resolver cases skipped`);
}

const packWith = (agentId, tools) => ({
  manifest: {
    mcpServers: Object.entries(tools).map(([registryName, allowTools]) => ({ registryName, allowTools })),
    agents: [{ id: agentId, resources: {} }],
  },
});

test("8. resolves the declared face for a preset, merging repeat declarations", { skip: !faceForPresetFromPacks }, () => {
  const packs = [
    packWith("hc-architect", { "fleet-architect": ["fleet_list", "fleet_draft"], "facet-market": ["browse"] }),
    packWith("hc-architect", { "fleet-architect": ["fleet_turns_read"] }),
    packWith("mo-inventory", { fleet: ["report_status"] }),
  ];
  const face = faceForPresetFromPacks(packs, "hc-architect");
  assert.deepEqual(Object.keys(face).sort(), ["facet-market", "fleet-architect"]);
  assert.deepEqual(face["fleet-architect"].sort(), ["fleet_draft", "fleet_list", "fleet_turns_read"]);
});

test("9. an unknown preset resolves to null — the safety valve keeps full composition", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWith("hc-architect", { "fleet-architect": ["fleet_list"] })];
  assert.equal(faceForPresetFromPacks(packs, "nobody-here"), null);
  assert.equal(faceForPresetFromPacks(null, "hc-architect"), null);
  assert.equal(faceForPresetFromPacks(packs, ""), null);
});

test("10. roster-form and catalog-form ids both resolve", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWith("hc.architect", { "fleet-architect": ["fleet_list"] })];
  assert.ok(faceForPresetFromPacks(packs, "hc-architect"), "dotted catalog id normalizes to roster form");
});

test("11. REGRESSION: the fleet server (report_status) survives every trim", () => {
  // Live 2026-11-10: trimming by declared face dropped `fleet`, which carries
  // report_status. The inventory post then produced a complete five-column
  // ledger in its TEXT (out=871) and filed nothing — the trace shows it calling
  // tool_search{"query":"report_status"} twice, hunting a tool that was gone.
  // The report lane is a platform obligation, not a declared capability.
  const out = trimServersToFace(CELL, { allowed: new Set(["fleet-architect"]), keepMemory: true });
  const names = out.map((e) => e.config.serverName);
  assert.ok(names.includes("fleet"), "report_status must always be reachable");
  assert.ok(names.includes("fd-memory"), "memory survives too");
  assert.ok(names.includes("fleet-architect"), "the declared face survives");
  assert.equal(out.length, 3, "and nothing else came along");
});

test("12. the live 4-server shape keeps the report lane", () => {
  // The exact set that shipped and broke reporting: facet-market / fleet-architect
  // / wire-build-mcp / fd-memory. Adding the missing lane must not change the
  // rest — `fleet` is additive, never a replacement for a declared server.
  const allowed = new Set(["facet-market", "fleet-architect", "wire-build-mcp"]);
  const out = trimServersToFace(CELL, { allowed, keepMemory: true });
  assert.deepEqual(out.map((e) => e.config.serverName).sort(),
    ["facet-market", "fd-memory", "fleet", "fleet-architect", "wire-build-mcp"]);
});
