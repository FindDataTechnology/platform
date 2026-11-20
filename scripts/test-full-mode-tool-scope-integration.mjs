#!/usr/bin/env node
// ── Full-mode tool scope integration (full-mode-tool-scope 1.3/1.4/4.2) ─────
//
// Real composition: temp DB + DSH home, installed-pack snapshots, the shared
// writeMcpPatch pipeline, and the materialized tool-filter.json. Covers the
// flag's byte-equality promise, the union, the safety valve, the override,
// uninstall re-derivation, and a custom preset's declared/fallback face.
//
//   node --test scripts/test-full-mode-tool-scope-integration.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "full-mode-scope-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
// catalog.js binds its file at import and must never read the repo's own
// agents.json — an empty fixture cwd is the established test trick.
const cwdFixture = path.join(tmpRoot, "cwd");
mkdirSync(cwdFixture, { recursive: true });
writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
process.chdir(cwdFixture);

const db = await import("../db.js");
await db.initDb();
const { writeMcpPatch, writeCatalogAgentPresets } = await import("../dsh-profile.js");
const catalog = await import("../catalog.js");

const FILTER_PATH = path.join(process.env.DSH_HOME, "profiles", "platform", "tool-filter.json");
const readFilter = () => readFileSync(FILTER_PATH, "utf8");
const filterDoc = () => JSON.parse(readFilter());

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const installPack = (packId, refs) =>
  db.upsertInstalledPack({
    packId,
    name: packId,
    version: 1,
    manifest: { name: packId, mcpServers: refs },
    report: {},
  });

test("flag off: composition is byte-identical to the pre-change writer", async () => {
  delete process.env.FULL_MODE_TOOL_SCOPE;
  installPack("pack-off", [{ registryName: "srv-a", allowTools: ["read"] }]);
  await writeMcpPatch();
  assert.equal(readFilter(), '{\n  "mcpTools": {}\n}\n');
  db.deleteInstalledPack("pack-off");
});

test("flag on: two packs referencing one server contribute the union", async () => {
  process.env.FULL_MODE_TOOL_SCOPE = "on";
  installPack("pack-a", [{ registryName: "srv-a", allowTools: ["read", "search"] }]);
  installPack("pack-b", [{ registryName: "srv-a", allowTools: ["search", "write"] }]);
  await writeMcpPatch();
  assert.deepEqual(filterDoc().mcpTools["srv-a"].sort(), ["read", "search", "write"]);
});

test("flag on: an undeclared reference keeps the whole surface (never an empty set)", async () => {
  installPack("pack-legacy", [{ registryName: "srv-a" }]);
  await writeMcpPatch();
  assert.equal(filterDoc().mcpTools["srv-a"], undefined);
});

test("flag on: the per-server override lifts a narrowed server", async () => {
  db.deleteInstalledPack("pack-legacy");
  db.setFullSurfaceServers(["srv-a"]);
  await writeMcpPatch();
  assert.equal(filterDoc().mcpTools["srv-a"], undefined);
  db.setFullSurfaceServers([]);
});

test("flag on: uninstalling the last referencing packs drops the key", async () => {
  db.deleteInstalledPack("pack-a");
  db.deleteInstalledPack("pack-b");
  await writeMcpPatch();
  assert.equal(filterDoc().mcpTools["srv-a"], undefined);
});

test("flag on: a custom preset declares a face or inherits the union", async () => {
  installPack("pack-c", [{ registryName: "srv-b", allowTools: ["read", "search"] }]);
  const declared = db.createUserPreset({
    name: "声明预设",
    persona: "p",
    mcpServers: ["srv-b"],
    mcpTools: { "srv-b": ["read"] },
  });
  // Data layer round-trip first: a missing face here would be a persistence
  // bug, not a catalog-lookup one.
  assert.deepEqual(db.getUserPreset(declared.id).mcpTools, { "srv-b": ["read"] });
  // Same sequence the create route rides: refresh the catalog AND regenerate
  // the roster's generated presets (hasCatalogAgentPreset gates on the defs
  // file, not just the catalog row).
  await catalog.refresh();
  writeCatalogAgentPresets(catalog.getChatAgentEntries());
  await writeMcpPatch({ agentPreset: declared.id });
  assert.deepEqual(filterDoc().mcpTools["srv-b"], ["read"]);

  const inherited = db.createUserPreset({ name: "继承预设", persona: "p", mcpServers: ["srv-b"] });
  await catalog.refresh();
  writeCatalogAgentPresets(catalog.getChatAgentEntries());
  await writeMcpPatch({ agentPreset: inherited.id });
  assert.deepEqual(filterDoc().mcpTools["srv-b"].sort(), ["read", "search"]);
});

// ── per-preset tool faces (fix-parked-preset-attribution D2) ────────────────
//
// A parked round mounts its persona on the SESSION and deliberately leaves the
// runtime's deployment default alone, so the cell's single MCP patch is
// composed for the DEFAULT persona. Without per-preset sections the parked
// persona's session resolves the whole-home map — i.e. someone else's face
// (2026-10-31 live: the ontology scout's session held fleet-architect's tools
// and `wire_datasets_list` searched to zero hits). These pin the sections.

test("per-preset: each pack persona gets its OWN allowlist section", async () => {
  process.env.FULL_MODE_TOOL_SCOPE = "on";
  // Two personas on the SAME server with DIFFERENT faces — the exact shape that
  // makes "the default's face" visibly wrong for the other one.
  db.upsertInstalledPack({
    packId: "pack-faces",
    name: "pack-faces",
    version: 1,
    manifest: {
      name: "pack-faces",
      mcpServers: [{ registryName: "srv-f", allowTools: ["datasets_list", "object_search", "action_propose"] }],
      agents: [
        { id: "face-scout", name: "盘账岗", persona: "p", resources: { mcpTools: { "srv-f": ["datasets_list"] } } },
        { id: "face-deployer", name: "提案岗", persona: "p", resources: { mcpTools: { "srv-f": ["action_propose"] } } },
      ],
    },
    report: {},
  });
  await writeMcpPatch();
  const doc = filterDoc();
  assert.ok(doc.byPreset, "the doc carries per-preset sections");
  assert.deepEqual(doc.byPreset["face-scout"].mcpTools["srv-f"], ["datasets_list"], "scout keeps only its own tools");
  assert.deepEqual(doc.byPreset["face-deployer"].mcpTools["srv-f"], ["action_propose"], "deployer keeps only its own tools");
  // The top-level map stays the UNION (the guard/register-shadow upper bound).
  assert.deepEqual(doc.mcpTools["srv-f"].sort(), ["action_propose", "datasets_list", "object_search"]);
});

test("per-preset: an undeclared persona falls back to the PACK-level face", async () => {
  db.upsertInstalledPack({
    packId: "pack-nofaces",
    name: "pack-nofaces",
    version: 1,
    manifest: {
      name: "pack-nofaces",
      mcpServers: [{ registryName: "srv-g", allowTools: ["read"] }],
      agents: [{ id: "face-plain", name: "普通岗", persona: "p" }],
    },
    report: {},
  });
  await writeMcpPatch();
  const doc = filterDoc();
  // effectiveMcpTools' existing rule: an agent without its own declaration
  // inherits the pack-level allowTools — the section mirrors that, never an
  // invented empty face.
  assert.deepEqual(doc.byPreset?.["face-plain"]?.mcpTools["srv-g"], ["read"]);
  assert.deepEqual(doc.mcpTools["srv-g"], ["read"]);
});

test("per-preset: a pack persona referencing NO server contributes no section", async () => {
  db.upsertInstalledPack({
    packId: "pack-empty",
    name: "pack-empty",
    version: 1,
    manifest: {
      name: "pack-empty",
      mcpServers: [],
      agents: [{ id: "face-solo", name: "单岗", persona: "p" }],
    },
    report: {},
  });
  await writeMcpPatch();
  const doc = filterDoc();
  assert.equal(doc.byPreset?.["face-solo"], undefined, "no MCP reference ⇒ no section (nothing to narrow)");
});

test("per-preset: uninstalling the pack drops its sections with it", async () => {
  db.deleteInstalledPack("pack-faces");
  db.deleteInstalledPack("pack-nofaces");
  db.deleteInstalledPack("pack-empty");
  await writeMcpPatch();
  const doc = filterDoc();
  assert.equal(doc.byPreset?.["face-scout"], undefined);
  assert.equal(doc.byPreset?.["face-deployer"], undefined);
  assert.equal(doc.byPreset?.["face-plain"], undefined);
});
