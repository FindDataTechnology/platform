#!/usr/bin/env node
// ── seed-mirror-workflows (openspec: seed-mirror-workflows 2.1) ──────────────
//
// Spec (release-line-hygiene, "A snapshot pushed to the image mirror carries the
// mirror's publish workflow"): the step that keeps a force-pushed snapshot from
// deleting the mirror's only publish path. Each case below is one of the four
// scenarios; the failure cases matter more than the happy one, because this
// step's whole job is to be loud where the previous three failures were silent.
//
//   node --test scripts/test-seed-mirror-workflows.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The implementation file carries internal publish topology, so the public
// snapshot scrubber removes it — while this test stays. In the image mirror
// that made every CI run red on a module that is *supposed* to be absent
// (ERR_MODULE_NOT_FOUND at import time, before any assertion could skip).
//
// Load it conditionally and skip the cases that need it. The absence is
// expected in the snapshot, not a defect there.
const IMPL = new URL("./seed-mirror-workflows.mjs", import.meta.url);
const HAS_IMPL = existsSync(IMPL);
const { MIRROR_ONLY_WORKFLOWS, seedMirrorWorkflows } = HAS_IMPL
  ? await import("./seed-mirror-workflows.mjs")
  : { MIRROR_ONLY_WORKFLOWS: [], seedMirrorWorkflows: null };
const NEEDS_IMPL = HAS_IMPL
  ? {}
  : { skip: "seed-mirror-workflows.mjs is scrubbed from the public snapshot — nothing to exercise here" };

const WF = MIRROR_ONLY_WORKFLOWS[0] ?? null;

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "seedwf-"));
  const repo = path.join(root, "repo");
  const dist = path.join(root, "dist");
  mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(repo, WF), "name: image\non:\n  push:\n    branches: [main]\n");
  return { root, repo, dist, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fresh snapshot gains the publish workflow", NEEDS_IMPL, () => {
  const s = sandbox();
  try {
    const r = seedMirrorWorkflows({ repoRoot: s.repo, distDir: s.dist });
    assert.equal(r.ok, true);
    assert.deepEqual(r.seeded, [WF]);
    assert.equal(readFileSync(path.join(s.dist, WF), "utf8"), readFileSync(path.join(s.repo, WF), "utf8"));
    assert.ok(statSync(path.join(s.dist, WF)).size > 0, "the copy is a real file, not an empty seed");
  } finally {
    s.cleanup();
  }
});

test("a second run changes nothing", NEEDS_IMPL, () => {
  const s = sandbox();
  try {
    seedMirrorWorkflows({ repoRoot: s.repo, distDir: s.dist });
    const dest = path.join(s.dist, WF);
    const before = readFileSync(dest);
    const beforeStat = statSync(dest).mtimeMs;

    const r = seedMirrorWorkflows({ repoRoot: s.repo, distDir: s.dist });

    assert.equal(r.ok, true);
    assert.deepEqual(r.seeded, [], "nothing is copied on an idempotent run");
    assert.deepEqual(r.already, [WF]);
    assert.deepEqual(readFileSync(dest), before);
    assert.equal(statSync(dest).mtimeMs, beforeStat, "no rewrite at all");
  } finally {
    s.cleanup();
  }
});

test("a missing source is an error that names the path, not a silent skip", NEEDS_IMPL, () => {
  const s = sandbox();
  try {
    rmSync(path.join(s.repo, WF));
    const r = seedMirrorWorkflows({ repoRoot: s.repo, distDir: s.dist });

    assert.equal(r.ok, false);
    assert.deepEqual(r.seeded, []);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].path, WF, "the report names the missing workflow");
    assert.match(r.errors[0].reason, /source_unreadable/);
    assert.throws(() => statSync(path.join(s.dist, WF)), /ENOENT/, "nothing is created from a missing source");
  } finally {
    s.cleanup();
  }
});

test("an unwritable destination is an error that names the path", NEEDS_IMPL, () => {
  const s = sandbox();
  try {
    // A file where the directory should be: the copy cannot succeed, and the
    // step must say which workflow it was rather than dying on a raw errno.
    writeFileSync(path.join(s.dist, ".github"), "not a directory");
    const r = seedMirrorWorkflows({ repoRoot: s.repo, distDir: s.dist });

    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, WF);
    assert.match(r.errors[0].reason, /write_failed|missing_after_copy/);
  } finally {
    s.cleanup();
  }
});

test("a missing dist argument is refused rather than guessed", NEEDS_IMPL, () => {
  const r = seedMirrorWorkflows({ distDir: "" });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reason, "missing_argument");
});

test("the real repository has every listed workflow", NEEDS_IMPL, (t) => {
  // The list is a literal; this pins it to reality so a rename cannot turn the
  // seeding step into a no-op that reports success.
  //
  // EXCEPT in the public snapshot, which deletes `image-publish.yml` ON PURPOSE
  // (it names the internal registry topology — make-public-snapshot's exclusion
  // list). There the missing file is the correct state, and this sentinel would
  // be red for being right. BUILD-INFO.json is the snapshot's own marker (only
  // `make-public-snapshot.mjs` writes it), so its presence — not a guess about
  // paths — is what distinguishes the two trees.
  if (existsSync(path.resolve(process.cwd(), "BUILD-INFO.json"))) {
    t.skip("public snapshot: image-publish.yml is excluded by design (seed-mirror-workflows restores it at push time)");
    return;
  }
  for (const rel of MIRROR_ONLY_WORKFLOWS) {
    const abs = path.resolve(process.cwd(), rel);
    assert.doesNotThrow(() => readFileSync(abs), `${rel} must exist in the repository`);
  }
});
