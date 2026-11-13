// Unit tests — generator, determinism and the drift gate (change
// add-pack-bundle-projection, tasks 3.1 / 3.2).
// Run: node --test scripts/test-pack-projection-drift.mjs
//
// The drift gate is the whole point of "three envelopes, one source": these
// cases prove it can go RED for each way the pair can disagree, and that a
// second run is byte-identical (a non-deterministic generator would make the
// gate cry wolf on every CI run and get muted).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "projection-drift-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const MANIFEST = {
  name: "Acme Desk",
  version: 1,
  description: "接收、转派、结案",
  skills: [{ name: "intake", description: "收单", content: "登记客户需求" }],
  agents: [{ id: "lead", name: "主管", persona: "先分诊，再派单。" }],
  mcpServers: [{ registryName: "crm" }],
};

/** A fixture repo root: only the files the generator actually reads. */
function fixture({ packs = [{ packId: "pack-acme", version: 1, manifest: MANIFEST }] } = {}) {
  const root = mkdtempSync(path.join(tmp, "root-"));
  mkdirSync(path.join(root, "dsh-matrix"), { recursive: true });
  cpSync(path.join(REPO, "dsh-matrix", "package.json"), path.join(root, "dsh-matrix", "package.json"));
  if (packs) {
    mkdirSync(path.join(root, "packs"), { recursive: true });
    writeFileSync(path.join(root, "packs", "projections.json"), `${JSON.stringify({ packs }, null, 2)}\n`);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts/project-pack-bundles.mjs"), "--root", root, ...args], {
    encoding: "utf8",
  });
}

test("an absent source list generates nothing — the zero-change build", () => {
  const root = fixture({ packs: null });
  const res = run(root);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /from 0 pack\(s\)/);
  assert.equal(readdirSync(root).includes("resources"), false, "no envelope directory is invented");
});

test("generate then check is clean", () => {
  const root = fixture();
  assert.equal(run(root).status, 0);
  const check = run(root, "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /clean — 1 pack\(s\), no drift/);
});

test("a tampered skill body makes --check red and names the envelope and skill (3.1)", () => {
  const root = fixture();
  assert.equal(run(root).status, 0);
  const skillPath = path.join(root, "packs", "dsh-bundles", "pack-acme-v1", "skills", "intake", "SKILL.md");
  writeFileSync(skillPath, "被手改了\n");
  const check = run(root, "--check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /envelope dsh/);
  assert.match(check.stderr, /skill intake/);
});

test("a tampered yizpack makes --check red naming that envelope", () => {
  const root = fixture();
  assert.equal(run(root).status, 0);
  const file = path.join(root, "packs", "bundles", "pack-acme-v1.yizpack");
  const bytes = readFileSync(file);
  writeFileSync(file, Buffer.concat([bytes, Buffer.from("x")]));
  const check = run(root, "--check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /envelope yizpack/);
});

test("a hand-edited desktop list is drift, and a stale output is drift too", () => {
  const root = fixture();
  assert.equal(run(root).status, 0);
  writeFileSync(path.join(root, "bundles", "manifest.json"), '{"bundles":[]}\n');
  assert.equal(run(root, "--check").status, 1);
  assert.match(run(root, "--check").stderr, /envelope desktop/);

  assert.equal(run(root).status, 0); // regenerate
  assert.equal(run(root, "--check").status, 0);
  // A file nobody's source accounts for would still be baked and shipped.
  writeFileSync(path.join(root, "packs", "bundles", "ghost-v9.yizpack"), "not a bundle");
  const stale = run(root, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale output — packs\/bundles\/ghost-v9\.yizpack/);
});

test("two runs are byte-identical (determinism, 3.2)", () => {
  const root = fixture();
  assert.equal(run(root).status, 0);
  const first = {
    list: readFileSync(path.join(root, "bundles", "manifest.json"), "utf8"),
    yizpack: readFileSync(path.join(root, "packs", "bundles", "pack-acme-v1.yizpack")),
    skill: readFileSync(path.join(root, "packs", "dsh-bundles", "pack-acme-v1", "skills", "intake", "SKILL.md"), "utf8"),
  };
  assert.equal(run(root).status, 0);
  assert.equal(readFileSync(path.join(root, "bundles", "manifest.json"), "utf8"), first.list);
  assert.deepEqual(readFileSync(path.join(root, "packs", "bundles", "pack-acme-v1.yizpack")), first.yizpack);
  assert.equal(
    readFileSync(path.join(root, "packs", "dsh-bundles", "pack-acme-v1", "skills", "intake", "SKILL.md"), "utf8"),
    first.skill,
  );
});

test("the generator refuses a pack that would leak control surface", () => {
  const root = fixture({
    packs: [{ packId: "pack-leaky", version: 1, manifest: { ...MANIFEST, fleet: { name: "x", members: [] } } }],
  });
  const res = run(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fleet/);
  assert.match(res.stderr, /never leaves the platform/);
});

test("the generator refuses when the matrix version leaves the compat range", () => {
  const root = fixture();
  // A matrix pin outside the envelope's declared range must stop generation:
  // the pack would install on a runtime we do not ship.
  writeFileSync(
    path.join(root, "dsh-matrix", "package.json"),
    JSON.stringify({ dependencies: { "@deepseek-ai/dsh": "0.3.1" } }, null, 2),
  );
  const res = run(root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /dshCompat/);
});
