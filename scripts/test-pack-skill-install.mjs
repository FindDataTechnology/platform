#!/usr/bin/env node
// ── Pack skill-package install line (add-packaged-skills, tasks 2.1-2.4) ────
//
// installPack's files/frontmatter passthrough (row + materialized tree),
// the script-confirm gate (server-enforced, zero-install on refusal), the
// report's fileCount/scriptFiles disclosure, the upgrade stale-sweep, and
// uninstallPreview's three-way modified detection — against an isolated data
// dir + SQLite, mirroring test-pack-cell.mjs's harness.
//
//   node --test scripts/test-pack-skill-install.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Set the isolation env BEFORE importing anything that resolves paths/db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-skill-install-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");

const hooks = {};

const FILES_V1 = {
  "references/x.md": "# 参考\n第一阶段材料。\n",
  "scripts/run.py": "print('v1')\n",
  "notes.txt": "v1 notes",
};
const FILES_V2 = {
  "references/x.md": "# 参考 v2\n",
  "references/y.md": "# 新增材料\n",
};

const manifestWith = (skills) => ({
  name: "复杂技能包",
  description: "带辅助文件",
  skills,
  mcpServers: [],
  agents: [],
});
const TREE_SKILL_V1 = {
  name: "tree-skill",
  description: "多文件技能",
  content: "# 正文 v1\n见 references/。",
  files: FILES_V1,
  frontmatter: { whenToUse: "复杂任务时", metadata: { origin: "pack" } },
};

const packRoot = (packId, skill) =>
  path.join(tmpRoot, "data", "custom-skills", "packs", packId, skill);

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("script-bearing pack installs only with confirm; refusal writes nothing", async () => {
  await assert.rejects(
    packStore.installPack({ packId: "pack-files", version: 1, manifest: manifestWith([TREE_SKILL_V1]), user: null, hooks }),
    (err) =>
      err.status === 400 &&
      err.code === "script-confirm-required" &&
      /executable script files/.test(err.message) &&
      err.details.length === 1 &&
      err.details[0].name === "tree-skill" &&
      err.details[0].scriptFiles.includes("scripts/run.py"),
  );
  assert.equal(db.getCustomSkill("tree-skill"), null, "no row on refusal");
  assert.equal(db.getInstalledPack("pack-files"), null, "no pack snapshot on refusal");
  assert.ok(!existsSync(packRoot("pack-files", "tree-skill")), "nothing materialized on refusal");
});

test("install with confirm stores files+frontmatter, materializes the tree, discloses in the report", async () => {
  const { report } = await packStore.installPack({
    packId: "pack-files",
    version: 1,
    manifest: manifestWith([TREE_SKILL_V1]),
    user: null,
    confirm: true,
    hooks,
  });

  // Row carries the whole package.
  const row = db.getCustomSkill("tree-skill");
  assert.deepEqual(row.files, FILES_V1);
  assert.deepEqual(row.frontmatter, TREE_SKILL_V1.frontmatter);
  assert.equal(row.originPackId, "pack-files");

  // Materialized tree under the pack root: SKILL.md + aux files.
  const root = packRoot("pack-files", "tree-skill");
  const skillMd = readFileSync(path.join(root, "SKILL.md"), "utf8");
  assert.match(skillMd, /whenToUse: 复杂任务时/);
  assert.match(skillMd, /# 正文 v1/);
  assert.equal(readFileSync(path.join(root, "references", "x.md"), "utf8"), FILES_V1["references/x.md"]);
  assert.equal(readFileSync(path.join(root, "scripts", "run.py"), "utf8"), FILES_V1["scripts/run.py"]);

  // Report disclosure: fileCount + scriptFiles on the tree skill row.
  const item = report.skills[0];
  assert.equal(item.status, "installed");
  assert.equal(item.fileCount, 3);
  assert.deepEqual(item.scriptFiles, ["scripts/run.py"]);
});

test("a pack without script files needs no confirm (legacy path untouched)", async () => {
  const proseSkill = { name: "prose-skill", description: "纯文稿", content: "# c", files: { "references/a.md": "a" } };
  const { report } = await packStore.installPack({
    packId: "pack-prose",
    version: 1,
    manifest: manifestWith([proseSkill]),
    user: null,
    hooks, // no confirm — none required
  });
  assert.equal(report.skills[0].status, "installed");
  assert.equal(report.skills[0].fileCount, 1);
  assert.deepEqual(report.skills[0].scriptFiles, []);

  // And a fully legacy manifest keeps its byte-identical report row.
  const legacy = await packStore.installPack({
    packId: "pack-legacy",
    version: 1,
    manifest: manifestWith([{ name: "legacy-skill", description: "旧式", content: "# 旧" }]),
    user: null,
    hooks,
  });
  assert.deepEqual(legacy.report.skills[0], { name: "legacy-skill", status: "installed" });
});

test("upgrade replaces files wholesale and the stale sweep drops removed files", async () => {
  const { report } = await packStore.installPack({
    packId: "pack-files",
    version: 2,
    manifest: manifestWith([
      { ...TREE_SKILL_V1, content: "# 正文 v2\n", files: FILES_V2, frontmatter: { whenToUse: "升级后" } },
    ]),
    user: null,
    confirm: true,
    hooks,
  });
  assert.equal(report.skills[0].status, "replaced");
  assert.equal(report.skills[0].fileCount, 2);

  const row = db.getCustomSkill("tree-skill");
  assert.deepEqual(row.files, FILES_V2, "files replaced wholesale");
  assert.deepEqual(row.frontmatter, { whenToUse: "升级后" });
  assert.equal(row.originPackVersion, 2);

  const root = packRoot("pack-files", "tree-skill");
  assert.equal(readFileSync(path.join(root, "references", "y.md"), "utf8"), FILES_V2["references/y.md"]);
  assert.ok(!existsSync(path.join(root, "scripts", "run.py")), "removed script swept");
  assert.ok(!existsSync(path.join(root, "notes.txt")), "removed note swept");
});

test("uninstall preview warns on aux-file-only edits, not just body edits", async () => {
  // Body matches the installed snapshot (v2); only a files drift is injected.
  db.updateCustomSkill("tree-skill", {
    files: { ...FILES_V2, "references/z.md": "user added" },
  });
  let preview = packStore.uninstallPreview("pack-files");
  assert.deepEqual(preview.modifiedSkills, ["tree-skill"], "files-only drift warns");

  // Frontmatter-only drift also warns.
  db.updateCustomSkill("tree-skill", { files: FILES_V2, frontmatter: { whenToUse: "用户改的" } });
  preview = packStore.uninstallPreview("pack-files");
  assert.deepEqual(preview.modifiedSkills, ["tree-skill"], "frontmatter-only drift warns");

  // Restored to the snapshot: clean.
  db.updateCustomSkill("tree-skill", { frontmatter: { whenToUse: "升级后" } });
  preview = packStore.uninstallPreview("pack-files");
  assert.deepEqual(preview.modifiedSkills, [], "matching snapshot is clean");

  // The gate itself still refuses without force.
  db.updateCustomSkill("tree-skill", { files: { ...FILES_V2, "references/z.md": "user added" } });
  assert.throws(
    () => packStore.uninstallPack({ packId: "pack-files", hooks }),
    (err) => err.status === 409,
  );
  const result = packStore.uninstallPack({ packId: "pack-files", force: true, hooks });
  assert.deepEqual(result.removedSkills, ["tree-skill"]);
  assert.equal(db.getCustomSkill("tree-skill"), null);
});
