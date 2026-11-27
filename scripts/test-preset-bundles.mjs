// Unit tests — preinstalled starter bundles (change 4, tasks 2.x).
// Run: node --test scripts/test-preset-bundles.mjs
//
//  2.x  the installer's starter bundles are a CATALOGUE, not an install:
//        listing them never materializes anything; importing one goes
//        through the same verified install path as any other bundle, and the
//        recorded provenance is "bundle".

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "preset-bundles-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const { buildBundle } = await import("../server/offline-bundle.js");
const { importPresetBundle, listPresetBundles, presetBundlesDir } = await import("../server/preset-bundles.js");
const packStore = await import("../pack-store.js");

// A fake "installer resources" tree: <resources>/bundles/*.yizpack
const resources = fs.mkdtempSync(path.join(os.tmpdir(), "resources-"));
const bundlesDir = path.join(resources, "bundles");
fs.mkdirSync(bundlesDir, { recursive: true });
const env = { PLATFORM_RESOURCES_DIR: resources };

const MANIFEST = {
  name: "Starter Fleet",
  description: "official starter",
  skills: [{ name: "starter-skill", description: "d", content: "# body\n" }],
  agents: [{ id: "starter-worker", name: "Worker", persona: "w", serving: { protocol: "a2a" } }],
};

test("2.1 the bundles directory resolves from the resources pointer", () => {
  assert.equal(presetBundlesDir(env), bundlesDir);
});

test("2.2 listing shows the catalogue without installing anything", async () => {
  const bytes = await buildBundle({ packId: "starter-demo", version: 1, manifest: MANIFEST, origin: "official" });
  fs.writeFileSync(path.join(bundlesDir, "starter-demo-v1.yizpack"), bytes);

  const list = await listPresetBundles({ env });
  assert.equal(list.length, 1);
  assert.equal(list[0].packId, "starter-demo");
  assert.equal(list[0].version, 1);
  assert.equal(list[0].name, "Starter Fleet");
  assert.equal(list[0].origin, "official");
  // Listing is not installing.
  assert.equal(db.getInstalledPack("starter-demo"), null);
});

test("2.3 an empty (or missing) directory is a normal state", async () => {
  const empty = await listPresetBundles({ env: { PLATFORM_RESOURCES_DIR: path.join(resources, "nope") } });
  assert.deepEqual(empty, []);
});

test("2.4 importing installs through the verified path and records source=bundle", async () => {
  const bytes = await buildBundle({ packId: "starter-import", version: 2, manifest: MANIFEST });
  fs.writeFileSync(path.join(bundlesDir, "starter-import-v2.yizpack"), bytes);

  const out = await importPresetBundle({
    file: "starter-import-v2.yizpack",
    env,
    installPack: packStore.installPack,
  });
  assert.equal(out.report.source, "bundle");
  assert.equal(out.installed.source, "bundle");
  assert.equal(db.getInstalledPack("starter-import").source, "bundle");
  assert.equal(out.bundle.packId, "starter-import");
  assert.equal(out.bundle.version, 2);
});

test("2.5 a traversal or unknown name is refused", async () => {
  const err = await importPresetBundle({ file: "../../etc/passwd", env, installPack: packStore.installPack })
    .then(() => null, (e) => e);
  assert.equal(err?.code, "preset_bad_name");

  const missing = await importPresetBundle({ file: "nope.yizpack", env, installPack: packStore.installPack })
    .then(() => null, (e) => e);
  assert.equal(missing?.code, "preset_not_found");
});

test("2.6 a tampered starter bundle is refused before installation", async () => {
  const JSZip = (await import("jszip")).default;
  const bytes = await buildBundle({ packId: "starter-bad", version: 1, manifest: MANIFEST });
  const zip = await JSZip.loadAsync(bytes);
  zip.file("manifest.json", JSON.stringify({ ...MANIFEST, name: "Injected" }));
  fs.writeFileSync(path.join(bundlesDir, "starter-bad-v1.yizpack"), await zip.generateAsync({ type: "nodebuffer" }));

  const err = await importPresetBundle({ file: "starter-bad-v1.yizpack", env, installPack: packStore.installPack })
    .then(() => null, (e) => e);
  assert.equal(err?.code, "bundle_digest_mismatch");
  assert.equal(db.getInstalledPack("starter-bad"), null, "no half install");
});
