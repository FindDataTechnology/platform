// Unit tests — the three envelopes (change add-pack-bundle-projection, tasks
// 2.1 / 2.2 / 2.3).
// Run: node --test scripts/test-pack-projection-envelopes.mjs
//
// Each envelope is pinned by the property that would silently break if someone
// "improved" it:
//   · .yizpack   byte-identical to the existing builder (a drifting container
//                would break every already-shipped import);
//   · dsh bundle no patch layer, no endpoint, capability present;
//   · desktop    file names + digests only — nothing about content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBundle } from "../server/offline-bundle.js";
import {
  projectManifestToIR,
  toYizpackEnvelope,
  toDshBundle,
  toDesktopPresetManifest,
} from "../server/pack-projection.js";

const MANIFEST = {
  name: "Acme Desk",
  version: 2,
  description: "接收、转派、结案",
  skills: [{ name: "intake", description: "收单", content: "登记需求" }],
  agents: [{ id: "lead", name: "主管", persona: "先分诊。" }],
  mcpServers: [{ registryName: "crm" }],
};

test(".yizpack bytes are identical to the existing builder (no drift)", async () => {
  const args = { packId: "pack-acme", version: 2, manifest: MANIFEST };
  const viaAdapter = await toYizpackEnvelope(args, { buildBundle });
  const direct = await buildBundle(args);
  assert.deepEqual(Buffer.from(viaAdapter), Buffer.from(direct));
});

test(".yizpack refuses to run without the real builder", async () => {
  await assert.rejects(() => toYizpackEnvelope({ packId: "p", version: 1, manifest: MANIFEST }), (err) => {
    assert.equal(err.code, "projection_needs_builder");
    return true;
  });
});

test("the dsh envelope is capability-only: skills + presets, no patch layer", () => {
  const ir = projectManifestToIR(MANIFEST);
  const { files, packageJson } = toDshBundle(ir);
  const paths = Object.keys(files).sort();
  assert.deepEqual(paths, ["presets/lead.json", "skills/intake/SKILL.md"]);
  assert.equal(paths.some((p) => p.includes("cordis")), false, "no patch layer may be generated");
  assert.equal(packageJson.dsh.profile.bundles.length, 1, "the envelope composes only itself");
  assert.equal(packageJson.dsh.compat, ir.dshCompat);
});

test("the dsh envelope carries no endpoint or credential, whatever the pack declared", () => {
  const ir = projectManifestToIR(MANIFEST);
  const { files, packageJson } = toDshBundle(ir);
  const blob = JSON.stringify({ files, packageJson });
  for (const needle of ["http://", "https://", "apiKey", "token", "Authorization"]) {
    assert.equal(blob.includes(needle), false, `envelope must not contain ${needle}`);
  }
});

test("skill files ride along under the skill's own directory", () => {
  const manifest = {
    ...MANIFEST,
    skills: [{ name: "intake", content: "登记", files: { "ref/checklist.md": "- 核对" } }],
  };
  const { files } = toDshBundle(projectManifestToIR(manifest));
  assert.equal(files["skills/intake/ref/checklist.md"], "- 核对");
});

test("the desktop manifest is names and digests only, sorted", () => {
  const out = toDesktopPresetManifest([
    { file: "b.bundle", bytes: "second" },
    { file: "a.bundle", bytes: "first" },
    { file: "", bytes: "ignored" },
  ]);
  assert.deepEqual(out.bundles.map((b) => b.file), ["a.bundle", "b.bundle"]);
  for (const entry of out.bundles) {
    assert.deepEqual(Object.keys(entry).sort(), ["file", "sha256"]);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  // Same bytes → same digest (deterministic), different bytes → different digest.
  const again = toDesktopPresetManifest([{ file: "a.bundle", bytes: "first" }]);
  assert.equal(again.bundles[0].sha256, out.bundles[0].sha256);
  const other = toDesktopPresetManifest([{ file: "a.bundle", bytes: "first!" }]);
  assert.notEqual(other.bundles[0].sha256, out.bundles[0].sha256);
});
