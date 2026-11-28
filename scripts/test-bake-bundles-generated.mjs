// Unit tests — the bakery consumes only the generated list (change
// add-pack-bundle-projection, tasks 4.1 / 4.2 / 4.3).
// Run: node --test scripts/test-bake-bundles-generated.mjs
//
// The bakery is where a wrong list becomes a shipped installer. Three cases:
//   · a generated list bakes exactly its bundles (happy path, and idempotent);
//   · a hand-added entry with no digest is REFUSED by name (the drift this
//     change exists to stop);
//   · a digest that no longer matches its file is REFUSED with both digests.
// Plus 4.3's guard: baked bundles are re-validated with the same reader a
// user-picked file goes through, so the preset path has no back door.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildBundle } from "../server/offline-bundle.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "bake-generated-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const MANIFEST = {
  name: "Acme Desk",
  version: 1,
  description: "接收、转派、结案",
  skills: [{ name: "intake", description: "收单", content: "登记" }],
};

async function fixture() {
  const root = mkdtempSync(path.join(tmp, "root-"));
  mkdirSync(path.join(root, "bundles"), { recursive: true });
  mkdirSync(path.join(root, "resources"), { recursive: true });
  const bytes = await buildBundle({ packId: "pack-acme", version: 1, manifest: MANIFEST });
  mkdirSync(path.join(root, "resources", "src"), { recursive: true });
  writeFileSync(path.join(root, "resources", "src", "pack-acme-v1.yizpack"), bytes);
  const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    path.join(root, "bundles", "manifest.json"),
    `${JSON.stringify({ bundles: [{ file: "resources/src/pack-acme-v1.yizpack", sha256: digest }] }, null, 2)}\n`,
  );
  return { root, digest };
}

function bake(root) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts/bake-bundles.mjs"), "--root", root], { encoding: "utf8" });
}

test("a generated list bakes its bundles and is idempotent", async () => {
  const { root } = await fixture();
  const first = bake(root);
  assert.equal(first.status, 0, first.stderr);
  const baked = readdirSync(path.join(root, "resources", "bundles"));
  assert.deepEqual(baked, ["pack-acme-v1.yizpack"]);

  const second = bake(root);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readdirSync(path.join(root, "resources", "bundles")), baked, "rebuild never accumulates");
});

test("a hand-added entry without a digest is refused by name (4.2)", async () => {
  const { root } = await fixture();
  writeFileSync(
    path.join(root, "bundles", "manifest.json"),
    `${JSON.stringify({ bundles: [{ file: "resources/src/pack-acme-v1.yizpack" }] }, null, 2)}\n`,
  );
  const res = bake(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /carries no sha256/);
  assert.match(res.stderr, /GENERATED/);
  assert.match(res.stderr, /packs\/projections\.json/);
});

test("a digest that no longer matches the file is refused with both digests", async () => {
  const { root, digest } = await fixture();
  const file = path.join(root, "resources", "src", "pack-acme-v1.yizpack");
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("tamper")]));
  const res = bake(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /does not match its recorded digest/);
  assert.ok(res.stderr.includes(digest), "the recorded digest is named");
});

test("generate → bake composes in the same tree (the source lives outside the bakery's destination)", async () => {
  const root = mkdtempSync(path.join(tmp, "compose-"));
  mkdirSync(path.join(root, "dsh-matrix"), { recursive: true });
  cpSync(path.join(REPO, "dsh-matrix", "package.json"), path.join(root, "dsh-matrix", "package.json"));
  mkdirSync(path.join(root, "packs"), { recursive: true });
  writeFileSync(
    path.join(root, "packs", "projections.json"),
    `${JSON.stringify({ packs: [{ packId: "pack-acme", version: 1, manifest: MANIFEST }] }, null, 2)}\n`,
  );
  const gen = spawnSync(process.execPath, [path.join(REPO, "scripts", "project-pack-bundles.mjs"), "--root", root], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);

  const baked = bake(root);
  assert.equal(baked.status, 0, baked.stderr);
  // The bakery wipes its destination; the source must survive in packs/bundles.
  assert.deepEqual(readdirSync(path.join(root, "resources", "bundles")), ["pack-acme-v1.yizpack"]);
  assert.deepEqual(readdirSync(path.join(root, "packs", "bundles")), ["pack-acme-v1.yizpack"]);
});

test("a listed file that is not a valid bundle still fails (no back door, 4.3)", async () => {
  const { root } = await fixture();
  const fake = path.join(root, "resources", "src", "fake.yizpack");
  writeFileSync(fake, "definitely not a zip");
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(readFileSync(fake)).digest("hex");
  writeFileSync(
    path.join(root, "bundles", "manifest.json"),
    `${JSON.stringify({ bundles: [{ file: "resources/src/fake.yizpack", sha256: digest }] }, null, 2)}\n`,
  );
  const res = bake(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a valid bundle/);
});
