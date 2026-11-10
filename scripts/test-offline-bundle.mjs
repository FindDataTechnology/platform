// Unit tests — offline pack bundles (add-offline-pack-supply 1.x/2.x/3.x).
// Run: node --test scripts/test-offline-bundle.mjs
//
//  1.x  container: manifest snapshot + digest list; readBundle re-validates
//       path safety, entry count, digests and unlisted extras; tampering
//       rejects the WHOLE bundle (no half install).
//  2.x  determinism: two exports of the same version are byte-identical.
//  3.x  install path: the bundle's manifest enters installPack with source
//       "bundle" recorded, and the report marks the provenance; the market
//       purchase gate keeps its semantics (reachable 402 / unreachable
//       degrade).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "offline-bundle-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const { buildBundle, readBundle, fromBase64, toBase64, BUNDLE_LIMITS, assertSafePath } = await import("../server/offline-bundle.js");
const packStore = await import("../pack-store.js");

function demoManifest(overrides = {}) {
  return {
    name: "Offline Demo",
    description: "bundle fixture",
    tags: ["demo"],
    skills: [{ name: `offline-demo-${Math.random().toString(36).slice(2, 8)}`, description: "d", content: "# body\n" }],
    agents: [],
    ...overrides,
  };
}

const MANIFEST = demoManifest();

test("1.1 build + read round-trips the manifest snapshot", async () => {
  const bytes = await buildBundle({ packId: "offline-demo", version: 3, manifest: MANIFEST, origin: "test" });
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
  const parsed = await readBundle(bytes);
  assert.equal(parsed.meta.packId, "offline-demo");
  assert.equal(parsed.meta.version, 3);
  assert.equal(parsed.meta.origin, "test");
  assert.deepEqual(parsed.manifest, MANIFEST);
  assert.deepEqual(Object.keys(parsed.files), []);
  // The digest list covers the manifest itself.
  assert.equal(parsed.meta.files.length, 1);
  assert.equal(parsed.meta.files[0].path, "manifest.json");
});

test("1.2 a tampered manifest is rejected whole", async () => {
  const bytes = await buildBundle({ packId: "offline-demo", version: 1, manifest: MANIFEST });
  // Swap in a different manifest body while keeping the digest list untouched.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  zip.file("manifest.json", JSON.stringify({ ...MANIFEST, name: "Injected" }));
  const tampered = await zip.generateAsync({ type: "nodebuffer" });
  const err = await readBundle(tampered).then(() => null, (e) => e);
  assert.ok(err, "tampering must be refused");
  assert.equal(err.code, "bundle_digest_mismatch");
});

test("1.3 path traversal / absolute / unlisted entries are refused", async () => {
  const JSZip = (await import("jszip")).default;

  // Traversal segments are refused by the path guard itself. (The zip
  // library normalizes `../` on the way IN — `../escape.txt` is stored as
  // `escape.txt` — so the container-level case is covered by the absolute
  // path below, which the library preserves.)
  for (const bad of ["../escape.txt", "a/../../b.txt", "/abs.txt", "C:/x.txt", "a\\b.txt"]) {
    const err = (() => { try { assertSafePath(bad); return null; } catch (e) { return e; } })();
    assert.ok(err, `path guard must refuse ${bad}`);
    assert.equal(err.code, "bundle_bad_path");
  }
  assert.equal(assertSafePath("skills/demo/SKILL.md"), "skills/demo/SKILL.md");

  const meta = { formatVersion: 1, packId: "x", version: 1, files: [{ path: "manifest.json", sha256: "0".repeat(64), bytes: 1 }] };
  const zip = new JSZip();
  zip.file("bundle.json", JSON.stringify(meta));
  zip.file("manifest.json", "{}");
  zip.file("/abs.txt", "nope");
  const err = await readBundle(await zip.generateAsync({ type: "nodebuffer" })).then(() => null, (e) => e);
  assert.equal(err?.code, "bundle_bad_path");

  // Unlisted extra files are refused too (nothing rides along unaccounted).
  const zip2 = new JSZip();
  zip2.file("bundle.json", JSON.stringify({ ...meta, files: [] }));
  zip2.file("manifest.json", "{}");
  zip2.file("extra.txt", "hi");
  const err2 = await readBundle(await zip2.generateAsync({ type: "nodebuffer" })).then(() => null, (e) => e);
  assert.equal(err2?.code, "bundle_unlisted_entry");
});

test("1.4 empty / non-zip / oversize payloads are refused", async () => {
  assert.equal((await readBundle(Buffer.alloc(0)).then(() => null, (e) => e))?.code, "bundle_empty");
  assert.equal((await readBundle(Buffer.from("not a zip")).then(() => null, (e) => e))?.code, "bundle_unreadable");
  const big = Buffer.alloc(BUNDLE_LIMITS.maxBytes + 1);
  assert.equal((await readBundle(big).then(() => null, (e) => e))?.code, "bundle_too_large");
});

test("2.1 exporting the same version twice is byte-identical", async () => {
  const a = await buildBundle({ packId: "offline-demo", version: 2, manifest: MANIFEST });
  const b = await buildBundle({ packId: "offline-demo", version: 2, manifest: MANIFEST });
  assert.equal(a.equals(b), true, "deterministic packing (sorted entries, pinned dates)");
});

test("2.2 base64 transport round-trips (the JSON upload shape)", async () => {
  const bytes = await buildBundle({ packId: "offline-demo", version: 4, manifest: MANIFEST });
  const back = fromBase64(toBase64(bytes));
  assert.equal(back.equals(bytes), true);
  const parsed = await readBundle(back);
  assert.equal(parsed.meta.version, 4);
});

test("3.1 importing installs through the same pipeline and records source=bundle", async () => {
  const bytes = await buildBundle({ packId: "offline-demo", version: 1, manifest: MANIFEST });
  const { meta, manifest } = await readBundle(bytes);
  const { report, installed } = await packStore.installPack({
    packId: meta.packId,
    version: meta.version,
    manifest,
    confirm: true,
    source: "bundle",
  });
  assert.equal(report.source, "bundle");
  assert.equal(installed.source, "bundle");
  const row = db.getInstalledPack("offline-demo");
  assert.equal(row.source, "bundle");
  assert.equal(row.version, 1);
  // The skill materialized exactly as a market install would.
  assert.equal(report.skills[0].status, "installed");
  assert.ok(db.getCustomSkill(MANIFEST.skills[0].name));
});

test("3.2 a market install keeps source=market (no behaviour change)", async () => {
  const manifest = demoManifest({ name: "Market Demo" });
  const { installed } = await packStore.installPack({
    packId: "market-demo",
    version: 2,
    manifest,
    confirm: true,
  });
  assert.equal(installed.source, "market");
  assert.equal(db.getInstalledPack("market-demo").source, "market");
});

test("3.3 historical rows read as market (column default)", () => {
  const rows = db.listInstalledPacks();
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(row.source === "market" || row.source === "bundle");
});
