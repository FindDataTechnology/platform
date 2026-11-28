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
// The lineage guard is a THIRD, separate thing: it asks whether the deployed baseline is
// contained in this tree, and it answers by reading /app/BUILD-INFO.json off the running
// pod. A runner has no kubeconfig, so it cannot judge here and refuses (exit 2) — and its
// switch is `SNAPSHOT_SKIP_LINEAGE_CHECK`, one word away from the `…_LINE_CHECK` this test
// used to set. Setting only the release-line switch meant the guard ran anyway and this
// test failed with "snapshot failed: ✗ 谱系判不出" on every CI run (run 43700648942,
// unit shard 7/8). Both switches are set now, and the run's stdout must show the skip
// line — the guard being skipped is a fact about this environment, not a pass.
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
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Three switches, because this test is about BUILD-INFO's contract and nothing else:
      //   LINE_CHECK      → release-line completeness
      //   LINEAGE_CHECK   → deployed-baseline lineage (no cluster here; refuses = exit 2)
      //   FRESHNESS_CHECK → "is this branch behind main?" (a local checkout can legitimately
      //                     be behind for two minutes; in CI there is no origin/main at all
      //                     and the guard self-skips, so leaving it unset made this test
      //                     pass in CI and fail locally for a reason it does not measure)
      env: {
        ...process.env,
        SNAPSHOT_SKIP_LINE_CHECK: "1",
        SNAPSHOT_SKIP_LINEAGE_CHECK: "1",
        SNAPSHOT_SKIP_FRESHNESS_CHECK: "1",
      },
    },
  );
  assert.equal(run.status, 0, `snapshot failed:\n${run.stdout}\n${run.stderr}`);
  // The switch must BIND, and binding must be visible: a run that skipped the lineage
  // guard prints the line below. Name-only agreement would still pass if the exporter
  // stopped reading the switch, so the behaviour is pinned here.
  assert.match(
    run.stdout,
    /lineage\s+⊘ 跳过：SNAPSHOT_SKIP_LINEAGE_CHECK=1/,
    `the lineage guard must be skipped *and say so*:\n${run.stdout}`,
  );

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
