#!/usr/bin/env node
// ── External install orchestration (add-external-skill-install 3.1–3.4) ────
//
// Exercises external-install.js against a REAL temp DB + materializer (only
// the network is stubbed, via a fake registry): normalization, preview shape,
// first install, reinstall-replace, name conflict, upstream failure leaving no
// trace, and the origin_meta read-back through the skills listing.
//
//   node --test scripts/test-external-install.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "ext-install-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const store = await import("../extension-store.js");
const materialize = await import("../skill-materialize.js");
const { normalizeSkillName, sanitizeFrontmatter, previewInstall, performInstall } = await import("../external-install.js");

// A fake registry: each slug maps to a package or an error.
function fakeRegistry(packages, entries = {}) {
  return {
    async fetchPackage(source, slug) {
      const v = packages[`${source}/${slug}`];
      if (v === undefined) return null; // unknown/disabled
      if (v instanceof Error) throw v;
      return v;
    },
    async getEntry(source, slug) {
      const e = entries[`${source}/${slug}`];
      return e ? { entry: e } : null;
    },
  };
}

const pack = (over = {}) => ({
  body: "# Skill body\n\nDoes things.",
  frontmatter: { name: "upstream-name", whenToUse: "when testing", metadata: { src: "x" } },
  files: { "scripts/run.py": "print(1)\n" },
  inventory: [
    { path: "SKILL.md", bytes: 20, script: false, action: "stored" },
    { path: "scripts/run.py", bytes: 10, script: true, action: "stored" },
  ],
  skillMdPath: "SKILL.md",
  ...over,
});

const ENTRY = {
  source: "skillhub",
  slug: "pdf-Image_Text.extractor",
  name: "pdf-Image_Text.extractor",
  displayName: "PDF 提取",
  description: "from the market",
  originUrl: "https://skillhub.cn/skills/pdf-Image_Text.extractor",
  licenseState: "unknown",
  licenseText: null,
  version: "2.1.0",
};

test("normalizeSkillName folds into the runtime grammar", () => {
  assert.equal(normalizeSkillName("pdf-Image_Text.extractor"), "pdf-image-text-extractor");
  assert.equal(normalizeSkillName("A__B  C"), "a-b-c");
  assert.equal(normalizeSkillName("---x---"), "x");
  assert.equal(normalizeSkillName("中文"), null);
  assert.equal(normalizeSkillName(""), null);
  assert.ok(normalizeSkillName("x".repeat(100)).length <= 64);
});

test("sanitizeFrontmatter strips runtime-rejected keys and name/description", () => {
  const out = sanitizeFrontmatter({
    name: "up", description: "d", whenToUse: "w",
    userInvocable: false, modelInvocable: true, disableModelInvocation: true,
    "user-invocable": true, metadata: { a: 1 },
  });
  assert.deepEqual(out, { whenToUse: "w", "user-invocable": true, metadata: { a: 1 } });
  assert.equal(sanitizeFrontmatter({ name: "only" }), null);
  assert.equal(sanitizeFrontmatter(null), null);
});

test("preview describes the package without touching the store", async () => {
  const registry = fakeRegistry({ "skillhub/entry": pack() }, { "skillhub/entry": ENTRY });
  const before = store.listCustomSkills().length;
  const p = await previewInstall({ source: "skillhub", slug: "entry", registry });
  assert.equal(p.normalizedName, "entry");
  assert.equal(p.upstreamName, "pdf-Image_Text.extractor");
  assert.equal(p.originUrl, ENTRY.originUrl);
  assert.equal(p.hasScripts, true);
  assert.equal(p.files.find((f) => f.path === "scripts/run.py").script, true);
  assert.ok(p.bodyExcerpt.includes("# Skill body"));
  assert.equal(store.listCustomSkills().length, before, "preview writes nothing");
});

test("first install writes row + materialized tree + provenance", async () => {
  const registry = fakeRegistry({ "skillhub/multi": pack() }, { "skillhub/multi": ENTRY });
  const out = await performInstall({ source: "skillhub", slug: "multi", registry, store, materialize, dbReady: () => true });
  assert.equal(out.replaced, false);
  assert.equal(out.skill.name, "multi");
  assert.equal(out.skill.originMeta.kind, "external");
  assert.equal(out.skill.originMeta.upstreamName, "pdf-Image_Text.extractor");
  assert.equal(out.skill.originMeta.upstreamVersion, "2.1.0");
  assert.deepEqual(Object.keys(out.skill.files), ["scripts/run.py"]);
  const dir = path.join(process.env.PLATFORM_DATA_DIR, "custom-skills", "multi");
  assert.ok(existsSync(path.join(dir, "scripts/run.py")), "auxiliary file materialized");
  const md = readFileSync(path.join(dir, "SKILL.md"), "utf8");
  assert.ok(md.includes("name: multi"));
  assert.ok(md.includes("whenToUse: when testing"));
});

test("reinstall of the same entry replaces content and files", async () => {
  const registry = fakeRegistry({
    "skillhub/reins": pack(),
  }, { "skillhub/reins": ENTRY });
  await performInstall({ source: "skillhub", slug: "reins", registry, store, materialize, dbReady: () => true });
  const v2 = pack({
    body: "# V2 body",
    files: { "scripts/new.py": "print(2)\n" },
    inventory: [
      { path: "SKILL.md", bytes: 10, script: false, action: "stored" },
      { path: "scripts/new.py", bytes: 10, script: true, action: "stored" },
    ],
  });
  const registry2 = fakeRegistry({ "skillhub/reins": v2 }, { "skillhub/reins": ENTRY });
  const out = await performInstall({ source: "skillhub", slug: "reins", registry: registry2, store, materialize, dbReady: () => true });
  assert.equal(out.replaced, true);
  assert.deepEqual(Object.keys(out.skill.files), ["scripts/new.py"]);
  const dir = path.join(process.env.PLATFORM_DATA_DIR, "custom-skills", "reins");
  assert.ok(!existsSync(path.join(dir, "scripts/run.py")), "stale file reconciled away");
  assert.ok(existsSync(path.join(dir, "scripts/new.py")));
  assert.ok(readFileSync(path.join(dir, "SKILL.md"), "utf8").includes("# V2 body"));
});

test("conflicting name from a different origin is refused, existing untouched", async () => {
  // A user-authored skill named "occupied".
  store.addCustomSkill({ name: "occupied", description: "mine", content: "# mine" });
  const registry = fakeRegistry({ "skillhub/occupied": pack() }, { "skillhub/occupied": ENTRY });
  await assert.rejects(
    () => performInstall({ source: "skillhub", slug: "occupied", registry, store, materialize, dbReady: () => true }),
    (e) => e.code === "name-conflict" && e.status === 409,
  );
  const row = store.getCustomSkill("occupied");
  assert.equal(row.content, "# mine", "existing skill untouched");
  assert.equal(row.originMeta, null);
});

test("upstream failure leaves no trace", async () => {
  const err = Object.assign(new Error("upstream directory not found"), { code: "upstream-not-found" });
  const registry = fakeRegistry({ "smithery/gone": err });
  await assert.rejects(
    () => performInstall({ source: "smithery", slug: "gone", registry, store, materialize, dbReady: () => true }),
    (e) => e.code === "upstream-not-found",
  );
  assert.equal(store.getCustomSkill("gone"), null, "no row");
  assert.ok(!existsSync(path.join(process.env.PLATFORM_DATA_DIR, "custom-skills", "gone")), "no dir");
});

test("unknown/disabled source is refused with 404", async () => {
  const registry = fakeRegistry({});
  await assert.rejects(
    () => performInstall({ source: "nope", slug: "x", registry, store, materialize, dbReady: () => true }),
    (e) => e.code === "unknown-source" && e.status === 404,
  );
});

test("normalization to empty refuses with 422 and no trace", async () => {
  const registry = fakeRegistry({ "skillhub/中文名": pack() });
  await assert.rejects(
    () => performInstall({ source: "skillhub", slug: "中文名", registry, store, materialize, dbReady: () => true }),
    (e) => e.code === "invalid-name" && e.status === 422,
  );
  assert.equal(store.getCustomSkill("中文名"), null);
});

test("origin_meta round-trips through the skills listing decode", () => {
  const row = store.getCustomSkill("multi");
  assert.equal(row.originMeta.source, "skillhub");
  assert.equal(row.originMeta.slug, "multi");
  assert.ok(typeof row.files === "object" && row.files !== null);
});

rmSync(tmpRoot, { recursive: true, force: true });
