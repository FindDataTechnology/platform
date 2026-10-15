#!/usr/bin/env node
// ── Persona resolution tests (add-persona-resource-sets, tasks 1.1–1.2) ──────
//
// resolvePersona is stage 1 of the two-stage scope derivation (design D1):
// preset id → merged-catalog entry → installed pack + manifest agent entry.
// The branches worth breaking here: a pack persona resolving to its pack and
// agent entry, a shipped preset resolving to nothing, an unknown id, a preset
// whose pack left (self-heal), and the shadowing case — an id overridden by a
// non-pack source (agents.json/cloud) resolves to NO persona and therefore
// composes full, even though its generated preset file still exists.
//
// The cwd fixture (agents.json) shadows one of the pack's agent ids with a
// plain remote-chat entry: catalog.js binds CATALOG_FILE at import, so the
// fixture must be in place (via chdir) before the import — the repo's own
// agents.json must never be read for this test.
//
//   node --test scripts/test-persona-scope.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "persona-scope-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp-absent.json");

// The shadowing source: a local catalog doc whose entry shares the pack
// agent's id but is a plain remote chat (no packId) — later source wins.
const cwdFixture = path.join(tmpRoot, "cwd");
mkdirSync(cwdFixture, { recursive: true });
writeFileSync(
  path.join(cwdFixture, "agents.json"),
  JSON.stringify({
    agents: [
      {
        id: "persona-shadowed",
        type: "agent-remote",
        mode: "chat",
        name: "覆盖者",
        baseUrl: "https://example.invalid/v1",
        model: "test-model",
      },
    ],
    apps: [],
  }),
);
process.chdir(cwdFixture);

const db = await import("../db.js");
await db.initDb();
const catalog = await import("../catalog.js");
const sm = await import("../skill-materialize.js");
const { resolvePersona, deriveScope, writeSkillsPatch, writeToolFilterPatch, writeMcpPatch, writeCatalogAgentPresets } = await import("../dsh-profile.js");

const PACK_ID = "persona-scope-pack";
const manifest = {
  name: "人设解析包",
  skills: [
    { name: "persona-scope-skill", description: "d", content: "# c" },
    { name: "persona-scope-other-skill", description: "d", content: "# c2" },
  ],
  mcpServers: [{ registryName: "persona-scope-ref" }, { registryName: "persona-scope-other-ref" }],
  agents: [
    {
      id: "persona-alpha",
      name: "阿尔法",
      persona: "你是阿尔法。",
      resources: { skills: ["persona-scope-skill"], mcpServers: ["persona-scope-ref"] },
    },
    { id: "persona-shadowed", name: "被覆盖者", persona: "你是被覆盖者。" },
  ],
};
const seedPack = () =>
  db.upsertInstalledPack({
    packId: PACK_ID,
    name: manifest.name,
    version: 1,
    manifest,
    report: {
      skills: manifest.skills.map((s) => ({ name: s.name, status: "installed" })),
      mcpServers: [],
      agents: manifest.agents.map((a) => ({ id: a.id, name: a.name, status: "installed" })),
    },
  });

// resolvePersona requires the generated preset to exist for the id (the same
// gate deriveScope always applied) — persist definitions the way
// writeCatalogAgentPresets would (0.2.0 declarative model: defs file, no dirs).
writeCatalogAgentPresets(
  ["persona-alpha", "persona-shadowed"].map((id) => ({ type: "agent-remote", mode: "chat", id, name: id, description: "seed" })),
);

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// The catalog's local source is lazy (loaded on refresh, not import) — pull it
// in once so the shadowing fixture's agents.json is part of the merge.
await catalog.refresh(null);

test("resolvePersona maps a pack preset to its pack and agent entry", async () => {
  seedPack();
  const persona = await resolvePersona("persona-alpha");
  assert.ok(persona, "a pack persona resolves");
  assert.equal(persona.packId, PACK_ID);
  assert.equal(persona.packName, manifest.name);
  assert.equal(persona.agent?.id, "persona-alpha");
  assert.equal(persona.agent?.name, "阿尔法");
  assert.equal(persona.manifest?.name, manifest.name, "the installed manifest rides along for stage 2");
});

test("shipped, unknown, and blank presets resolve to no persona", async () => {
  seedPack();
  assert.equal(await resolvePersona("standard"), null, "a shipped preset is never a persona");
  assert.equal(await resolvePersona("no-such-preset"), null, "an unknown id resolves to nothing");
  assert.equal(await resolvePersona(null), null, "a null preset is full mode");
});

test("an id shadowed by a non-pack source resolves to no persona (full mode)", async () => {
  seedPack();
  // The preset file EXISTS (the catalog sync generates one for the overriding
  // entry too) — the null must come from the merged entry lacking a packId,
  // not from a missing preset.
  const persona = await resolvePersona("persona-shadowed");
  assert.equal(persona, null, "a shadowed id is no longer a pack persona");
});

test("a preset whose pack was uninstalled self-heals to no persona", async () => {
  seedPack();
  db.deleteInstalledPack(PACK_ID);
  assert.equal(await resolvePersona("persona-alpha"), null);
  seedPack();
});

test("deriveScope stays focused through the same resolution", async () => {
  seedPack();
  const scope = await deriveScope("persona-alpha");
  assert.equal(scope.packId, PACK_ID);
  assert.deepEqual(scope.mcpKeep, ["persona-scope-ref"]);
  const full = await deriveScope("persona-shadowed");
  assert.equal(full.packId, null, "the shadowed persona composes full end-to-end");
});

// ── Declaration semantics (tasks 3.2–3.3) ────────────────────────────────────
test("declared subset narrows the focus: mcpKeep ∩ declared, skills via persona root", async () => {
  seedPack();
  // The durable rows the compose-root builder reads (installPack's job in the
  // real flow): both skills owned by the pack.
  for (const s of manifest.skills) {
    db.addCustomSkill({ name: s.name, description: s.description, content: s.content, originPackId: PACK_ID });
  }
  const scope = await deriveScope("persona-alpha");
  assert.equal(scope.persona, "persona-alpha");
  assert.deepEqual(scope.mcpKeep, ["persona-scope-ref"], "only the declared ref of the two survives");
  assert.deepEqual(scope.skillsDecl, ["persona-scope-skill"]);
  // writeSkillsPatch BUILDS the compose root then lists it (baseline + root).
  const patch = await writeSkillsPatch({ agentPreset: "persona-alpha" });
  const dirs = yaml.load(readFileSync(patch, "utf8"))[0].config.customSkillDirs;
  const personaRoot = sm.personaSkillsRoot(PACK_ID, "persona-alpha");
  assert.ok(dirs.includes(personaRoot), "the persona compose root is listed");
  assert.ok(!dirs.includes(sm.packSkillsRoot(PACK_ID)), "the pack root itself is NOT listed for a declared persona");
  assert.deepEqual(readdirSync(personaRoot).sort(), ["persona-scope-skill"], "only the declared skill is linked");
});

test("empty declaration focuses both dimensions to the baseline alone", async () => {
  manifest.agents[0].resources = { skills: [], mcpServers: [] };
  seedPack();
  const scope = await deriveScope("persona-alpha");
  assert.deepEqual(scope.mcpKeep, []);
  assert.equal(scope.skillsDir, null);
  const patch = await writeSkillsPatch({ agentPreset: "persona-alpha" });
  const dirs = yaml.load(readFileSync(patch, "utf8"))[0].config.customSkillDirs;
  assert.equal(dirs.length, 1, "baseline only — no pack root, no persona root");
});

test("undeclared persona keeps the pack root and the whole ref list", async () => {
  delete manifest.agents[0].resources;
  seedPack();
  const scope = await deriveScope("persona-alpha");
  assert.deepEqual(scope.mcpKeep, ["persona-scope-ref", "persona-scope-other-ref"]);
  assert.equal(scope.skillsDecl, undefined);
  // The pack root exists once a skill row materializes; then it is the scope.
  sm.writeSkill({ name: "persona-scope-skill", description: "d", content: "# c", originPackId: PACK_ID, enabled: true });
  const scope2 = await deriveScope("persona-alpha");
  assert.equal(scope2.skillsDir, sm.packSkillsRoot(PACK_ID));
  const patch = await writeSkillsPatch({ agentPreset: "persona-alpha" });
  const dirs = yaml.load(readFileSync(patch, "utf8"))[0].config.customSkillDirs;
  assert.ok(dirs.includes(sm.packSkillsRoot(PACK_ID)), "undeclared focus lists the pack root");
});

// ── Tool allowlist derivation (add-mcp-tool-scoping, tasks 2.1–2.2) ──────────
const resetRefs = () => {
  manifest.mcpServers = [{ registryName: "persona-scope-ref" }, { registryName: "persona-scope-other-ref" }];
};

test("scope derives per-server tool allowlists: pack-level, role-narrowed, absent", async () => {
  manifest.mcpServers = [
    { registryName: "persona-scope-ref", allowTools: ["read", "search", "purge"] },
    { registryName: "persona-scope-other-ref" }, // no allowlist = full surface
  ];
  manifest.agents[0].resources = { skills: ["persona-scope-skill"], mcpServers: ["persona-scope-ref"] };
  seedPack();
  const scope = await deriveScope("persona-alpha");
  assert.deepEqual(scope.mcpKeep, ["persona-scope-ref"]);
  // Pack-level allowlist, only for the kept server; the dropped server is moot.
  assert.deepEqual(scope.mcpTools, { "persona-scope-ref": ["read", "search", "purge"] });

  // Role-level narrowing (mcpTools) intersects the pack-level list.
  manifest.agents[0].resources = {
    skills: ["persona-scope-skill"],
    mcpServers: ["persona-scope-ref"],
    mcpTools: { "persona-scope-ref": ["read", "search", "not-in-pack"] },
  };
  seedPack();
  const narrowed = await deriveScope("persona-alpha");
  assert.deepEqual(narrowed.mcpTools, { "persona-scope-ref": ["read", "search"] }, "narrowing only, never widening");

  // Undeclared role + undeclared pack: no allowlists at all.
  resetRefs();
  delete manifest.agents[0].resources;
  seedPack();
  const full2 = await deriveScope("persona-alpha");
  assert.deepEqual(full2.mcpTools, {});
  // Full mode and custom presets carry null (v1 declares tools on packs only).
  assert.equal((await deriveScope("standard")).mcpTools, null);
});

test("writeToolFilterPatch materializes the bridge config; empty = no filtering", async () => {
  resetRefs();
  manifest.mcpServers = [{ registryName: "persona-scope-ref", allowTools: ["read"] }];
  delete manifest.agents[0].resources;
  seedPack();
  const scope = await deriveScope("persona-alpha");
  const filterPath = writeToolFilterPatch(scope.source === "pack" ? scope.mcpTools : null);
  const doc = JSON.parse(readFileSync(filterPath, "utf8"));
  assert.deepEqual(doc, { mcpTools: { "persona-scope-ref": ["read"] } });
  // The scope module ships beside the filter (the preset bridge imports it).
  assert.ok(readdirSync(path.dirname(filterPath)).includes("platform-tool-scope.js"));
  // Full mode / no allowlists: an empty mapping — the bridge no-ops on it.
  const emptyPath = writeToolFilterPatch(null);
  assert.deepEqual(JSON.parse(readFileSync(emptyPath, "utf8")), { mcpTools: {} });
  // Parameterized dirs (the runner's private homes) aim the same writer.
  const runnerHome = path.join(tmpRoot, "runner-home");
  const aimed = writeToolFilterPatch({ "persona-scope-ref": ["read"] }, { dirs: { dshHome: runnerHome, profileName: "platform" } });
  assert.ok(aimed.startsWith(runnerHome));
  assert.deepEqual(JSON.parse(readFileSync(aimed, "utf8")), { mcpTools: { "persona-scope-ref": ["read"] } });
});

test("a later local install activates an awaiting reference (task 4.2)", async () => {
  // The pack references a name with no market entry and no local row — the
  // install reported awaiting-local-binding; the focused compose drops the
  // name for now, but the allowlist is already materialized.
  resetRefs();
  manifest.mcpServers = [{ registryName: "persona-scope-await", allowTools: ["read"] }];
  delete manifest.agents[0].resources;
  seedPack();
  const before = await writeMcpPatch({ agentPreset: "persona-alpha" });
  assert.equal(before, null, "no servers at all — patch skipped");
  const filterBefore = JSON.parse(readFileSync(path.join(process.env.DSH_HOME, "profiles", "platform", "tool-filter.json"), "utf8"));
  assert.deepEqual(filterBefore, { mcpTools: { "persona-scope-await": ["read"] } }, "the allowlist waits with the reference");

  // The user installs a local server of that name — the NEXT composition
  // picks the binding up with no reinstall of the pack.
  const { addMcpServer } = await import("../extension-store.js");
  addMcpServer({
    name: "persona-scope-await",
    config: { url: "http://await.example.test/mcp", headers: {} },
    enabled: true,
  });
  const after = await writeMcpPatch({ agentPreset: "persona-alpha" });
  assert.ok(after, "the composition now carries the server");
  const patch = yaml.load(readFileSync(after, "utf8"));
  const names = patch[0].insert.map((e) => e.config.serverName);
  assert.deepEqual(names, ["persona-scope-await"], "the awaiting reference is live, no reinstall needed");
});

test("catalog serializes the role-level resourceSummary (D5)", async () => {
  resetRefs();  // Declared: per-role counts (1 of 2 skills, 1 of 2 refs).
  manifest.agents[0].resources = { skills: ["persona-scope-skill"], mcpServers: ["persona-scope-ref"] };
  seedPack();
  const declared = catalog.getCatalogFor(null).agents.find((x) => x.id === "persona-alpha");
  assert.deepEqual(declared.resourceSummary, { skillCount: 1, mcpCount: 1, declared: true });
  // Undeclared: pack-level counts.
  delete manifest.agents[0].resources;
  seedPack();
  const undeclared = catalog.getCatalogFor(null).agents.find((x) => x.id === "persona-alpha");
  assert.deepEqual(undeclared.resourceSummary, { skillCount: 2, mcpCount: 2, declared: false });
  // Empty declaration: persona-only role.
  manifest.agents[0].resources = { skills: [], mcpServers: [] };
  seedPack();
  const empty = catalog.getCatalogFor(null).agents.find((x) => x.id === "persona-alpha");
  assert.deepEqual(empty.resourceSummary, { skillCount: 0, mcpCount: 0, declared: true });
});
