#!/usr/bin/env node
// ── Pack cell-side tests (add-pack-marketplace, tasks 2.1–2.2, 3.1–3.7) ─────
//
// Exercises the cell's pack machinery at module level against an isolated
// data dir + SQLite: the v20 migration, draft CRUD, installPack's material-
// ization and conflict policy, the catalog's pack agent source, and uninstall
// semantics. The registry-origin MCP happy path (needs a live registry
// catalog + credential) is covered by the e2e suite against e2e/registry-stub.
//
//   node --test scripts/test-pack-cell.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Set the isolation env BEFORE importing anything that resolves paths/db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-cell-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

import Database from "better-sqlite3";
const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");
const catalog = await import("../catalog.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");

const MANIFEST_BASE = {
  name: "法律-合同",
  description: "合同审查工作流",
  tags: ["法律"],
  skills: [
    { name: "legal-contract-workflow", description: "五阶段合同审查", content: "# v1\n按阶段推进。" },
  ],
  mcpServers: [{ registryName: "law-bench" }, { registryName: "fetch" }],
  agents: [{ id: "pack-contract-reviewer", name: "合同审查官", persona: "你是严谨的合同审查官。" }],
};

const hooks = {}; // no downstream effects in unit tests

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("v20 migration: tables, origin columns, and additive safety", () => {
  assert.ok(db.isDbReady());
  const raw = new Database(process.env.DB_PATH, { readonly: true });
  try {
    const cols = raw.prepare("PRAGMA table_info(custom_skills)").all().map((c) => c.name);
    assert.ok(cols.includes("origin_pack_id"), "custom_skills.origin_pack_id missing");
    assert.ok(cols.includes("origin_pack_version"), "custom_skills.origin_pack_version missing");
    for (const t of ["pack_drafts", "installed_packs"]) {
      assert.ok(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `${t} missing`);
    }
  } finally {
    raw.close();
  }
  // Pre-migration semantics: a user-created skill reads as unowned.
  const s = db.addCustomSkill({ name: "user-skill", description: "d", content: "c" });
  assert.equal(s.originPackId, null);
});

test("draft CRUD round-trips and keeps entries JSON", () => {
  const draft = packStore.createDraft({
    name: "我的包",
    description: "desc",
    tags: ["a"],
    entries: { skills: [{ name: "s1", description: "d", content: "c" }], mcpServers: [], agents: [] },
  });
  assert.ok(draft.id);
  assert.deepEqual(draft.tags, ["a"]);
  assert.equal(draft.entries.skills.length, 1);

  const updated = packStore.updateDraft(draft.id, { name: "我的包2", tags: ["b", "c"] });
  assert.equal(updated.name, "我的包2");
  assert.deepEqual(updated.tags, ["b", "c"]);
  assert.equal(updated.entries.skills.length, 1, "entries untouched by a patch without them");

  assert.equal(packStore.listDrafts().length, 1);
  assert.throws(() => packStore.getDraft("nope"), /not found/i);
  assert.deepEqual(packStore.deleteDraft(draft.id), { ok: true });
  assert.equal(packStore.listDrafts().length, 0);
});

test("install materializes skills, reports MCP refs, and snapshots the pack", async () => {
  // A pre-existing USER skill the pack's second skill will collide with.
  db.addCustomSkill({ name: "shared-skill", description: "user's own", content: "user content" });

  const { report, installed } = await packStore.installPack({
    packId: "pack-aaa",
    version: 1,
    manifest: {
      ...MANIFEST_BASE,
      skills: [
        ...MANIFEST_BASE.skills,
        { name: "shared-skill", description: "pack's version", content: "pack content" },
      ],
    },
    user: { email: "user@example.com", groups: [] },
    hooks,
  });

  // Skills: one installed (with origin), one skipped (foreign name).
  assert.deepEqual(
    report.skills.map((s) => [s.name, s.status]),
    [["legal-contract-workflow", "installed"], ["shared-skill", "skipped"]],
  );
  assert.match(report.skills[1].reason, /not owned by this pack/);
  const installedSkill = db.getCustomSkill("legal-contract-workflow");
  assert.equal(installedSkill.originPackId, "pack-aaa");
  assert.equal(installedSkill.originPackVersion, 1);
  // The foreign skill is untouched.
  assert.equal(db.getCustomSkill("shared-skill").content, "user content");
  assert.equal(db.getCustomSkill("shared-skill").originPackId, null);

  // Materialization: the DB row is mirrored to a hot-loadable SKILL.md under
  // the PACK root (add-pack-agent-scoping layout; the flat root is user-only).
  const skillMd = path.join(tmpRoot, "data", "custom-skills", "packs", "pack-aaa", "legal-contract-workflow", "SKILL.md");
  assert.ok(existsSync(skillMd), "SKILL.md not materialized");
  assert.ok(readFileSync(skillMd, "utf8").includes("# v1"));

  // MCP refs: law-bench is not in the (bundled, registry-less) catalog;
  // fetch is bundled but not registry-origin. Both reported, neither fatal.
  assert.equal(report.mcpServers[0].name, "law-bench");
  assert.equal(report.mcpServers[0].status, "unavailable");
  assert.match(report.mcpServers[0].reason, /market catalog/);
  assert.equal(report.mcpServers[1].status, "unavailable");
  assert.match(report.mcpServers[1].reason, /not a registry server/);

  // Agent installed; snapshot recorded with the version's manifest.
  assert.equal(report.agents[0].status, "installed");
  assert.equal(installed.version, 1);
  assert.equal(db.getInstalledPack("pack-aaa").manifest.name, "法律-合同");
});

test("upgrade replaces the pack's own skill and stamps the new version", async () => {
  const { report } = await packStore.installPack({
    packId: "pack-aaa",
    version: 2,
    manifest: {
      ...MANIFEST_BASE,
      skills: [{ name: "legal-contract-workflow", description: "五阶段合同审查", content: "# v2\n改进的阶段。" }],
    },
    user: { email: "user@example.com", groups: [] },
    hooks,
  });
  assert.deepEqual(report.skills.map((s) => [s.name, s.status]), [["legal-contract-workflow", "replaced"]]);
  const row = db.getCustomSkill("legal-contract-workflow");
  assert.equal(row.content, "# v2\n改进的阶段。");
  assert.equal(row.originPackVersion, 2);
  assert.equal(db.getInstalledPack("pack-aaa").version, 2);
});

test("install re-validates the browser-supplied manifest", async () => {
  await assert.rejects(
    packStore.installPack({
      packId: "pack-bad",
      version: 1,
      manifest: { ...MANIFEST_BASE, mcpServers: [{ registryName: "x", url: "https://evil" }] },
      user: null,
      hooks,
    }),
    (err) => err.status === 400 && /Invalid manifest/.test(err.message),
  );
});

test("catalog serves pack agents; ids conflict across packs", async () => {
  // pack-aaa's agent is in the catalog for any requester.
  const cat = catalog.getCatalogFor({ email: "u@x.com", groups: [] });
  const agent = cat.agents.find((a) => a.id === "pack-contract-reviewer");
  assert.ok(agent, "pack agent missing from catalog");
  assert.equal(agent.name, "合同审查官");
  assert.equal(agent.mode, "chat");

  // A second pack carrying the same agent id is skipped with a reason.
  const { report } = await packStore.installPack({
    packId: "pack-bbb",
    version: 1,
    manifest: { ...MANIFEST_BASE, name: "另一个包", skills: [], agents: MANIFEST_BASE.agents },
    user: { email: "user@example.com", groups: [] },
    hooks,
  });
  assert.equal(report.agents[0].status, "skipped");
  assert.match(report.agents[0].reason, /owned by/);
  assert.match(report.agents[0].reason, /法律-合同/); // names the owning pack
});

test("uninstall: modified-skill warning gates, force removes, MCP kept", async () => {
  // Simulate the user editing the pack's skill after install.
  db.updateCustomSkill("legal-contract-workflow", { content: "# 用户改过的" });

  const preview = packStore.uninstallPreview("pack-aaa");
  assert.deepEqual(preview.skills, ["legal-contract-workflow"]);
  assert.deepEqual(preview.modifiedSkills, ["legal-contract-workflow"]);
  assert.deepEqual(preview.mcpServersKept, ["law-bench", "fetch"]);

  // Without force: 409 carrying the modified list.
  assert.throws(
    () => packStore.uninstallPack({ packId: "pack-aaa", hooks }),
    (err) => err.status === 409 && err.modifiedSkills.includes("legal-contract-workflow"),
  );
  assert.ok(db.getInstalledPack("pack-aaa"), "nothing removed on refusal");

  // With force: skills + installed row gone, SKILL.md pruned.
  const result = packStore.uninstallPack({ packId: "pack-aaa", force: true, hooks });
  assert.deepEqual(result.removedSkills, ["legal-contract-workflow"]);
  assert.equal(db.getCustomSkill("legal-contract-workflow"), null);
  assert.equal(db.getInstalledPack("pack-aaa"), null);
  assert.ok(
    !existsSync(path.join(tmpRoot, "data", "custom-skills", "packs", "pack-aaa")),
    "pack root not pruned on uninstall",
  );

  // The pack's agent left the catalog; other packs' entries remain.
  const cat = catalog.getCatalogFor({ email: "u@x.com", groups: [] });
  assert.ok(!cat.agents.some((a) => a.id === "pack-contract-reviewer"));

  assert.throws(() => packStore.uninstallPreview("pack-aaa"), /not installed/i);
});

test("shared manifest validation stays importable for the editor path", () => {
  assert.deepEqual(validatePackManifest(MANIFEST_BASE), []);
});

// ── Resource declarations (add-persona-resource-sets, tasks 2.1–2.2) ─────────
const withResources = (resources) => ({
  ...MANIFEST_BASE,
  agents: [{ ...MANIFEST_BASE.agents[0], ...(resources !== undefined ? { resources } : {}) }],
});

test("resource declarations: valid mixed-dimension subset passes", () => {
  // One dimension each, both subsets of the pack's own lists.
  assert.deepEqual(
    validatePackManifest(withResources({ skills: ["legal-contract-workflow"], mcpServers: ["law-bench"] })),
    [],
    "a mixed skills+MCP declaration of own names is valid",
  );
});

test("resource declarations: foreign names are rejected naming the role", () => {
  const errs = validatePackManifest(withResources({ skills: ["not-a-pack-skill"] }));
  assert.ok(errs.length === 1, `expected one error, got ${JSON.stringify(errs)}`);
  assert.match(errs[0].error, /pack-contract-reviewer/);
  assert.match(errs[0].error, /not-a-pack-skill/);
  assert.equal(errs[0].entry, "agents[0]");

  const mcpErrs = validatePackManifest(withResources({ mcpServers: ["foreign-server"] }));
  assert.match(mcpErrs[0].error, /pack-contract-reviewer/);
  assert.match(mcpErrs[0].error, /foreign-server/);
});

test("resource declarations: duplicates within one declaration are rejected", () => {
  const errs = validatePackManifest(withResources({ skills: ["law-bench", "law-bench"] }));
  // law-bench is an MCP name, not a skill — both the foreign-name and
  // duplicate checks matter; assert the duplicate fires for a real skill name.
  const dupe = validatePackManifest(withResources({ mcpServers: ["law-bench", "law-bench"] }));
  assert.ok(dupe.some((e) => /twice/.test(e.error) && /law-bench/.test(e.error) && /pack-contract-reviewer/.test(e.error)));
  assert.ok(errs.some((e) => /does not declare|twice/.test(e.error)));
});

test("resource declarations: dimensions scope independently (absent = whole-pack, empty = none)", () => {
  // Absent MCP dimension: only skills narrowed — valid.
  assert.deepEqual(validatePackManifest(withResources({ skills: ["legal-contract-workflow"] })), []);
  // Absent skills dimension: only MCP narrowed — valid.
  assert.deepEqual(validatePackManifest(withResources({ mcpServers: ["fetch"] })), []);
  // Present-but-empty both dimensions: persona-only role — valid.
  assert.deepEqual(validatePackManifest(withResources({ skills: [], mcpServers: [] })), []);
  // Empty object: same as both-empty — valid.
  assert.deepEqual(validatePackManifest(withResources({})), []);
});

test("resource declarations: malformed shapes are rejected", () => {
  assert.ok(validatePackManifest(withResources(null)).length > 0, "resources must be an object");
  assert.ok(validatePackManifest(withResources({ skills: "legal-contract-workflow" })).length > 0, "a dimension must be an array");
  assert.ok(validatePackManifest(withResources({ skills: ["bad name!"] })).length > 0, "names must be well-formed");
  assert.ok(validatePackManifest(withResources({ tools: [] })).length > 0, "unknown dimensions are rejected");
});

test("install path re-validates declarations with status 400", async () => {
  await assert.rejects(
    packStore.installPack({
      packId: "pack-decl-invalid",
      version: 1,
      manifest: withResources({ skills: ["not-a-pack-skill"] }),
      user: null,
      hooks,
    }),
    (err) =>
      err.status === 400 &&
      /Invalid manifest/.test(err.message) &&
      err.details.some((d) => /not-a-pack-skill/.test(d.error)),
  );
  assert.equal(db.getInstalledPack("pack-decl-invalid"), null, "nothing installed on refusal");
});
