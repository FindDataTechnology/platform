#!/usr/bin/env node
// ── Skill package upload channel (add-packaged-skills, task 4.1) ────────────
//
// POST /api/extensions/skills multipart zip channel: preview inventory,
// server-enforced script confirm, install writes row + tree, bad packages
// (no SKILL.md / path escape / count overflow) refuse 4xx with zero residue,
// and the legacy JSON path keeps working.
//
//   node --test scripts/test-skill-package-upload.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import multer from "multer";
import JSZip from "jszip";
import { test, after } from "node:test";

// Isolation env BEFORE any paths/db import.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "skill-pkg-upload-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const extensionStore = await import("../extension-store.js");
const skillMaterialize = await import("../skill-materialize.js");
const { registerExtensionRoutes } = await import("../server/routes/extensions.js");

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
// Mirror server.js: a global JSON parser feeds the legacy path; multipart
// bodies pass through it untouched (body-parser only consumes JSON).
app.use(express.json());
registerExtensionRoutes({
  app,
  db,
  extensionStore,
  skillMaterialize,
  broadcast: () => {},
  upload,
  bundle: { skills: [], permissions: {}, splitPolicy: null },
  requireMcpManage: (_req, _res) => true,
  getMarketEntries: () => ({ skills: [], mcpServers: [] }),
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function zip(files) {
  const z = new JSZip();
  for (const [p, content] of Object.entries(files)) z.file(p, content);
  return z.generateAsync({ type: "nodebuffer" });
}

async function postSkillPackage(buffer, fields = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([buffer]), "pkg.zip");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(`${base}/api/extensions/skills`, { method: "POST", body: fd });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body, text };
}

const GOOD_FILES = {
  "SKILL.md": "---\nname: My Complex Skill\nwhenToUse: 复杂任务时\nmetadata:\n  origin: hand-made\n---\n# 正文\n见 references/。\n",
  "references/x.md": "# 参考 X\n",
  "scripts/run.py": "print('hi')\n",
  "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

const skillDir = (name) => path.join(tmpRoot, "data", "custom-skills", name);

test("preview describes the package honestly: paths, scripts, omissions, excerpt", async () => {
  const r = await postSkillPackage(await zip(GOOD_FILES), { mode: "preview" });
  assert.equal(r.status, 200, r.text);
  const p = r.body.preview;
  assert.equal(p.name, "my-complex-skill", "name normalized from frontmatter");
  assert.equal(p.upstreamName, "My Complex Skill");
  assert.equal(p.hasScripts, true);
  assert.equal(p.storedFileCount, 2);
  const paths = p.files.map((f) => f.path);
  assert.ok(paths.includes("references/x.md"));
  assert.ok(paths.includes("scripts/run.py"));
  const png = p.files.find((f) => f.path === "logo.png");
  assert.equal(png.action, "omitted-binary", "binary omission is visible, not silent");
  assert.match(p.bodyExcerpt, /# 正文/);
  assert.equal(extensionStore.getCustomSkill("my-complex-skill"), null, "preview stores nothing");
});

test("install without confirm on a script-bearing package refuses with zero residue", async () => {
  const r = await postSkillPackage(await zip(GOOD_FILES), { mode: "install" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "script-confirm-required");
  assert.equal(extensionStore.getCustomSkill("my-complex-skill"), null);
  assert.ok(!existsSync(skillDir("my-complex-skill")));
});

test("install with confirm writes the row and materializes the tree", async () => {
  const r = await postSkillPackage(await zip(GOOD_FILES), { mode: "install", confirm: "true", description: "表单描述" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.skill.name, "my-complex-skill");
  assert.equal(r.body.skill.fileCount, 2, "binary omitted, prose + script stored");
  assert.equal(r.body.replaced, false);

  const row = extensionStore.getCustomSkill("my-complex-skill");
  assert.equal(row.description, "表单描述", "form description wins over frontmatter");
  assert.deepEqual(Object.keys(row.files).sort(), ["references/x.md", "scripts/run.py"]);
  // sanitizeFrontmatter: name/description stripped (row owns them), kept keys ride.
  assert.deepEqual(row.frontmatter, { whenToUse: "复杂任务时", metadata: { origin: "hand-made" } });
  assert.equal(row.originMeta.kind, "package-upload");
  assert.equal(row.originMeta.upstreamName, "My Complex Skill");

  const dir = skillDir("my-complex-skill");
  const md = readFileSync(path.join(dir, "SKILL.md"), "utf8");
  assert.match(md, /name: my-complex-skill/);
  assert.match(md, /whenToUse: 复杂任务时/);
  assert.equal(readFileSync(path.join(dir, "scripts", "run.py"), "utf8"), "print('hi')\n");
  assert.ok(!existsSync(path.join(dir, "logo.png")));
});

test("bad packages refuse 4xx with zero residue: no SKILL.md, path escape, count overflow", async () => {
  const noSkill = await postSkillPackage(await zip({ "readme.md": "no skill doc" }), { mode: "install", confirm: "true" });
  assert.equal(noSkill.status, 422);
  assert.match(noSkill.body.error, /no SKILL\.md/);

  // Traversal entries cannot reach storage: JSZip itself demotes `..` at
  // read time (verified: "../evil.md" reloads as "evil.md"), and unzipToMap
  // re-checks every entry against safePackagePath. Prove the end state on a
  // raw-bytes-patched zip (equal-length name swap keeps offsets valid)…
  const rawZip = await zip({ "SKILL.md": "c", "dd/evil.md": "x" });
  const patched = Buffer.from(rawZip.toString("latin1").split("dd/evil.md").join("../evil.md"), "latin1");
  const escaped = await postSkillPackage(patched, { mode: "install", confirm: "true" });
  assert.equal(escaped.status, 200, escaped.text);
  const storedKeys = Object.keys(extensionStore.getCustomSkill("pkg").files ?? {});
  assert.ok(storedKeys.every((k) => !k.includes("..")), `traversal leaked into storage: ${storedKeys}`);
  // …and the guard itself unit-level, for readers that do NOT sanitize.
  const { safePackagePath } = await import("../lib/skill-files.js");
  for (const bad of ["../evil.md", "/abs.md", "a/../b.md", "C:/x", "back\\slash", "nul\0"]) {
    assert.equal(safePackagePath(bad), null, `safePackagePath must refuse ${JSON.stringify(bad)}`);
  }

  const many = { "SKILL.md": "c" };
  for (let i = 0; i < 65; i++) many[`f${i}.md`] = "x";
  const overflow = await postSkillPackage(await zip(many), { mode: "install", confirm: "true" });
  assert.equal(overflow.status, 422);
  assert.match(overflow.body.error, /auxiliary files/);

  for (const n of ["readme-md-skill", "f0"]) {
    assert.equal(extensionStore.getCustomSkill(n), null, `no residue row for ${n}`);
  }
});

test("name conflict with a foreign row is 409; re-upload of the same package replaces", async () => {
  // Foreign row: a plain user skill with the target name.
  extensionStore.addCustomSkill({ name: "taken-skill", description: "user's own", content: "c" });
  const conflict = await postSkillPackage(
    await zip({ "SKILL.md": "---\nname: Taken Skill\n---\nbody" }),
    { mode: "install", confirm: "true" },
  );
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already exists/);

  // Re-uploading the upload-owned skill replaces wholesale.
  const again = await postSkillPackage(await zip(GOOD_FILES), { mode: "install", confirm: "true" });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.replaced, true);
});

test("the legacy JSON path is untouched", async () => {
  const r = await fetch(`${base}/api/extensions/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "plain-skill", content: "# plain\n" }),
  });
  assert.equal(r.status, 200);
  const row = extensionStore.getCustomSkill("plain-skill");
  assert.equal(row.content, "# plain\n");
  assert.equal(row.files, null);
});
