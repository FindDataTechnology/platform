#!/usr/bin/env node
// ── Snapshot provenance: BUILD-INFO.json says which base the tree came from ──
//
// The image tag is the SNAPSHOT repo's commit, so a published image cannot say
// which paas commit it was cut from. That gap is not theoretical: on 2026-11-08
// a manifest claimed `paas 53be7fbbe` while the image carried neither the v100
// migration guard nor the uninstall ledger deprecation, and nothing in the image
// could contradict the claim.
//
// BUILD-INFO.json closes it inside the artefact, so a rollout can be checked
// instead of trusted:
//
//   kubectl exec deploy/platform -- cat /app/BUILD-INFO.json
//
// This test runs the real exporter (gitleaks and the release-line guard both
// skipped — those have their own tests) and pins the file's contract.
//
//   node --test scripts/test-snapshot-build-info.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = "dist-opensource/build-info-test";
const OUT = join(REPO_ROOT, OUT_REL);

// This test drives the real exporter, and the exporter deletes itself from the
// tree it produces — so in the public snapshot (where CI runs) there is nothing
// to drive and the run dies on MODULE_NOT_FOUND, red for a reason that has
// nothing to do with provenance. The contract is pinned where the exporter
// lives; elsewhere the skip states why.
const NO_SNAPSHOT_SCRIPT = existsSync(join(REPO_ROOT, "scripts", "make-public-snapshot.mjs"))
  ? false
  : "the snapshot exporter is not in this tree (it deletes itself from its own output)";

test("the exported tree carries BUILD-INFO.json with the base commit", { skip: NO_SNAPSHOT_SCRIPT }, () => {
  rmSync(OUT, { recursive: true, force: true });
  const run = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "make-public-snapshot.mjs"), "--ref", "HEAD", "--out", OUT_REL, "--skip-gitleaks"],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, SNAPSHOT_SKIP_LINE_CHECK: "1" } },
  );
  assert.equal(run.status, 0, `snapshot failed:\n${run.stdout}\n${run.stderr}`);

  const file = join(OUT, "BUILD-INFO.json");
  assert.ok(existsSync(file), "BUILD-INFO.json must exist in the exported tree");

  const info = JSON.parse(readFileSync(file, "utf8"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  assert.equal(info.baseRef, "HEAD");
  assert.equal(info.baseCommit, head, "baseCommit must be the exact commit the tree was cut from");
  assert.match(info.baseCommit, /^[0-9a-f]{40}$/, "a full sha, not an abbreviation");
  assert.ok(!Number.isNaN(Date.parse(info.builtAt)), "builtAt must be a parseable timestamp");

  rmSync(OUT, { recursive: true, force: true });
});
