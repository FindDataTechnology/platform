#!/usr/bin/env node
// ── Skill-package manifest validation (add-packaged-skills, tasks 1.1-1.3) ──
//
// validatePackManifest's skills[i].files / skills[i].frontmatter block. The
// gateway publish path and the cell install path (pack-store.js) consume this
// same validator, so these tests pin both gates' contract without a live
// facet. Absent fields must stay byte-identical to the legacy single-document
// skill — the rolling-deploy contract (D9).
//
//   node --test scripts/test-pack-skill-files-validation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePackManifest, validateSkillFiles, skillScriptFiles, PACK_LIMITS } from "../lib/pack-manifest.js";

const _KIB = 1024;
const BASE = {
  name: "T",
  skills: [{ name: "s", description: "d", content: "c" }],
  mcpServers: [],
  agents: [],
};

const withFiles = (files, extra = {}) => ({
  ...BASE,
  skills: [{ name: "s", description: "d", content: "c", files, ...extra }],
});

test("a manifest without files/frontmatter validates exactly as before", () => {
  assert.equal(validatePackManifest(BASE).length, 0);
  // And the package block adds nothing when the fields are absent.
  assert.equal(validateSkillFiles(BASE.skills[0], 0).length, 0);
});

test("a valid files map and frontmatter validate clean", () => {
  const manifest = withFiles(
    {
      "references/guide.md": "# Guide\n",
      "references/notes.txt": "notes",
      "scripts/run.py": "print('hi')\n",
    },
    { frontmatter: { whenToUse: "when testing", metadata: { origin: "pack" } } },
  );
  assert.deepEqual(validatePackManifest(manifest), []);
});

test("well-known extensionless text names and shebang files are accepted", () => {
  const manifest = withFiles({
    "build/Dockerfile": "FROM scratch\n",
    "run-tool": "#!/usr/bin/env python3\nprint('ok')\n",
  });
  assert.deepEqual(validatePackManifest(manifest), []);
});

test("a file at exactly the per-file limit validates clean; one over is rejected with path and bound", () => {
  const at = withFiles({ "big.md": "x".repeat(PACK_LIMITS.maxSkillFileChars) });
  assert.deepEqual(validatePackManifest(at), []);
  const over = withFiles({ "big.md": "x".repeat(PACK_LIMITS.maxSkillFileChars + 1) });
  const errors = validatePackManifest(over);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /big\.md.*per-file limit of \d+ characters/);
  assert.equal(errors[0].entry, "skills[0].files['big.md']");
});

test("a skill at exactly the aggregate limit validates clean; frontmatter tips it over", () => {
  const perFile = PACK_LIMITS.maxSkillFileChars;
  const files = {};
  for (let i = 0; i < Math.floor(PACK_LIMITS.maxSkillAuxChars / perFile); i++) {
    files[`part${i}.md`] = "x".repeat(perFile);
  }
  let total = Object.values(files).reduce((n, t) => n + t.length, 0);
  files["tail.md"] = "x".repeat(PACK_LIMITS.maxSkillAuxChars - total);
  assert.deepEqual(validatePackManifest(withFiles(files)), []);

  const errors = validatePackManifest(withFiles(files, { frontmatter: { note: "one char too far" } }));
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /skill 's' auxiliary content.*exceeds \d+ characters in total/);
  assert.equal(errors[0].entry, "skills[0]");
});

test("more auxiliary files than the count limit is rejected naming the bound", () => {
  const files = {};
  for (let i = 0; i < PACK_LIMITS.maxSkillAuxFiles + 1; i++) files[`f${i}.md`] = "x";
  const errors = validatePackManifest(withFiles(files));
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /at most 64 entries \(found 65\)/);
  assert.equal(errors[0].entry, "skills[0]");
});

test("unsafe paths are each rejected with entry and path", () => {
  const bad = ["/etc/passwd", "../escape.md", "a/../../b.md", "back\\slash.md", "C:/drive.md", "nul\0byte.md", "", "."];
  for (const p of bad) {
    const errors = validatePackManifest(withFiles({ [p]: "x" }));
    assert.ok(
      errors.some((e) => e.error.includes("path must be relative and safe")),
      `expected unsafe-path rejection for ${JSON.stringify(p)}`,
    );
    const named = errors.find((e) => e.error.includes("path must be relative and safe"));
    assert.ok(named.entry.startsWith("skills[0].files['"), "entry carries the path");
  }
});

test("SKILL.md in any casing is rejected inside files", () => {
  for (const p of ["SKILL.md", "skill.md", "Skill.MD", "refs/SKILL.md"]) {
    const errors = validatePackManifest(withFiles({ [p]: "# imposter\n" }));
    assert.ok(
      errors.some((e) => e.error.includes("may not include a SKILL.md")),
      `expected SKILL.md collision rejection for ${p}`,
    );
  }
});

test("non-text extensions are rejected", () => {
  for (const p of ["logo.png", "data.bin", "archive.tar.gz"]) {
    const errors = validatePackManifest(withFiles({ [p]: "not really binary" }));
    assert.ok(
      errors.some((e) => e.error.includes("not a text type")),
      `expected text-whitelist rejection for ${p}`,
    );
  }
});

test("case-insensitive path collisions between two files are rejected", () => {
  const errors = validatePackManifest(withFiles({ "refs/A.md": "one", "refs/a.md": "two" }));
  assert.ok(errors.some((e) => e.error.includes("collides (case-insensitively)")));
});

test("non-object files and frontmatter shapes are rejected", () => {
  assert.ok(validatePackManifest(withFiles(["a.md"])).some((e) => e.error.includes("files must be an object")));
  assert.ok(validatePackManifest(withFiles(null)).some((e) => e.error.includes("files must be an object")));
  const fm = withFiles({}, { frontmatter: "nope" });
  assert.ok(validatePackManifest(fm).some((e) => e.error.includes("frontmatter must be an object")));
  const fmArr = withFiles({}, { frontmatter: ["nope"] });
  assert.ok(validatePackManifest(fmArr).some((e) => e.error.includes("frontmatter must be an object")));
});

test("non-string file content is rejected", () => {
  const errors = validatePackManifest(withFiles({ "a.md": 42 }));
  assert.ok(errors.some((e) => e.error.includes("file content must be text")));
});

test("skillScriptFiles lists script files sorted and skips prose", () => {
  const skill = { name: "s", files: { "z.sh": "x", "references/a.md": "y", "a.py": "z", "notes.txt": "t" } };
  assert.deepEqual(skillScriptFiles(skill), ["a.py", "z.sh"]);
  assert.deepEqual(skillScriptFiles({ name: "s", content: "c" }), []);
  assert.deepEqual(skillScriptFiles({ name: "s", files: { "a.md": "y" } }), []);
});
