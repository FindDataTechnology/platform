#!/usr/bin/env node
// ── Skill materialization: directory trees + frontmatter preservation ───────
//
// add-external-skill-install tasks 1.2/1.3. Exercises skill-materialize.js at
// module level against an isolated data dir:
//   · legacy rows (no files/frontmatter) produce byte-identical SKILL.md
//   · a row with `files` materializes the whole tree; stale aux files are
//     reconciled away; unsafe stored paths are refused
//   · a row with `frontmatter` re-emits it (name/description from the row),
//     and the legacy camelCase invocation keys are never materialized (the
//     runtime throws on them and would drop the whole skill)
//
//   node --test scripts/test-skill-materialize-files.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "skill-mat-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const mat = await import("../skill-materialize.js");

function skillDir(name) {
  return path.join(process.env.PLATFORM_DATA_DIR, "custom-skills", name);
}

test("legacy row (no files/frontmatter) renders the exact legacy SKILL.md", () => {
  mat.writeSkill({ name: "legacy-skill", description: "old desc", content: "# Body\n\nlegacy." });
  const md = readFileSync(path.join(skillDir("legacy-skill"), "SKILL.md"), "utf8");
  assert.equal(md, "---\nname: legacy-skill\ndescription: old desc\n---\n\n# Body\n\nlegacy.\n");
  // No extra files beyond SKILL.md.
  assert.deepEqual(readdirSync(skillDir("legacy-skill")), ["SKILL.md"]);
});

test("row with files materializes the whole tree", () => {
  mat.writeSkill({
    name: "multi-skill",
    description: "multi",
    content: "# Multi",
    files: {
      "scripts/run.py": "print('hi')\n",
      "reference/notes.md": "# notes\n",
      "_meta.json": "{\"v\":1}",
    },
  });
  const dir = skillDir("multi-skill");
  assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "---\nname: multi-skill\ndescription: multi\n---\n\n# Multi\n");
  assert.equal(readFileSync(path.join(dir, "scripts/run.py"), "utf8"), "print('hi')\n");
  assert.equal(readFileSync(path.join(dir, "reference/notes.md"), "utf8"), "# notes\n");
  assert.equal(readFileSync(path.join(dir, "_meta.json"), "utf8"), "{\"v\":1}");
});

test("reinstall reconciles stale auxiliary files away", () => {
  mat.writeSkill({
    name: "reconcile-skill",
    description: "d",
    content: "# V1",
    files: { "scripts/a.py": "a", "scripts/b.py": "b" },
  });
  const dir = skillDir("reconcile-skill");
  assert.ok(existsSync(path.join(dir, "scripts/b.py")));
  // New version drops b.py, adds c.py.
  mat.writeSkill({
    name: "reconcile-skill",
    description: "d",
    content: "# V2",
    files: { "scripts/a.py": "a2", "scripts/c.py": "c" },
  });
  assert.equal(readFileSync(path.join(dir, "scripts/a.py"), "utf8"), "a2");
  assert.ok(!existsSync(path.join(dir, "scripts/b.py")), "stale b.py must be removed");
  assert.ok(existsSync(path.join(dir, "scripts/c.py")));
  assert.ok(readFileSync(path.join(dir, "SKILL.md"), "utf8").includes("# V2"));
});

test("unsafe stored auxiliary paths are refused (never escape the skill dir)", () => {
  mat.writeSkill({
    name: "escape-skill",
    description: "d",
    content: "# E",
    files: {
      "../escaped.md": "nope",
      "/tmp/absolute-escape.md": "nope",
      "ok/fine.txt": "yes",
    },
  });
  const dir = skillDir("escape-skill");
  assert.ok(!existsSync(path.join(process.env.PLATFORM_DATA_DIR, "custom-skills", "escaped.md")));
  assert.ok(!existsSync("/tmp/absolute-escape.md"));
  assert.equal(readFileSync(path.join(dir, "ok/fine.txt"), "utf8"), "yes");
});

test("stored frontmatter is re-emitted with the row's name/description winning", () => {
  mat.writeSkill({
    name: "fm-skill",
    description: "platform desc",
    content: "# FM",
    frontmatter: {
      name: "Upstream-Name",
      description: "upstream desc",
      whenToUse: "when the user wants FM",
      "user-invocable": false,
      "disable-model-invocation": true,
      metadata: { origin: "skillhub" },
    },
  });
  const md = readFileSync(path.join(skillDir("fm-skill"), "SKILL.md"), "utf8");
  // Record name/description win.
  assert.ok(md.includes("name: fm-skill"), "platform name must win");
  assert.ok(!md.includes("Upstream-Name"), "upstream name must not remain in frontmatter");
  assert.ok(md.includes("platform desc"));
  // dsh-consumed fields survive.
  assert.ok(md.includes("whenToUse: when the user wants FM"));
  assert.ok(md.includes("user-invocable: false"));
  assert.ok(md.includes("disable-model-invocation: true"));
  assert.ok(md.includes("origin: skillhub"));
});

test("legacy camelCase invocation keys are never materialized (runtime throws on them)", () => {
  mat.writeSkill({
    name: "camel-skill",
    description: "d",
    content: "# Camel",
    frontmatter: {
      whenToUse: "keep me",
      userInvocable: false,
      modelInvocable: true,
      disableModelInvocation: true,
    },
  });
  const md = readFileSync(path.join(skillDir("camel-skill"), "SKILL.md"), "utf8");
  assert.ok(md.includes("whenToUse: keep me"));
  assert.ok(!md.includes("userInvocable"));
  assert.ok(!md.includes("modelInvocable"));
  assert.ok(!md.includes("disableModelInvocation"));
});

test("disabled multi-file skill removes the whole directory", () => {
  mat.writeSkill({
    name: "toggled-skill",
    description: "d",
    content: "# T",
    files: { "scripts/x.py": "x" },
  });
  const dir = skillDir("toggled-skill");
  assert.ok(existsSync(dir));
  mat.writeSkill({ name: "toggled-skill", description: "d", content: "# T", files: { "scripts/x.py": "x" }, enabled: false });
  assert.ok(!existsSync(dir), "disabled skill must be unmaterialized entirely");
});

rmSync(tmpRoot, { recursive: true, force: true });
