#!/usr/bin/env node
// ── check-release-lines guard: does it actually detect a fork? ───────────────
//
// A guard that always prints OK is worse than none, so this builds two bare
// remotes and pins the three states:
//   A. both tips equal                      → exit 0
//   B. same work on both under different SHAs (cherry-pick mirror) → exit 0
//      with a one-way report, never exit 2
//   C. genuine fork (each side has work the other lacks) → exit 2
//   D. --strict on pure mirror lag          → exit 1
//
//   node --test scripts/test-check-release-lines.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const GUARD = new URL("./check-release-lines.mjs", import.meta.url).pathname;
const BRANCH = "release/cell-session-persona";
const WORK = mkdtempSync(join(tmpdir(), "check-release-lines-"));

// The exporter deletes ITSELF (and its runbook) from the tree it produces, so
// this script is absent in the public snapshot — which is exactly where CI runs.
// The wiring assertion below reads that file, so it can only run where it
// exists; the guard's own behaviour is tested against bare remotes and runs
// everywhere. Skipping is honest: there is no wiring to inspect in this tree.
const NO_SNAPSHOT_SCRIPT = existsSync(new URL("./make-public-snapshot.mjs", import.meta.url))
  ? false
  : "the snapshot exporter is not in this tree (it deletes itself from its own output)";

function run(cwd, ...argv) {
  const env = { ...process.env };
  // A replayed patch only gets a DIFFERENT sha if the committer date differs;
  // same parent + same time would hash identically and the "mirror" case would
  // silently collapse into the equal-tips case.
  if (argv[0] === "cherry-pick") env.GIT_COMMITTER_DATE = "2026-11-08T12:00:00 +0800";
  const result = spawnSync("git", argv, { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, `git ${argv.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function guard(cwd, ...extra) {
  // --no-fetch: the fixture remotes are local paths already fetched by the test.
  const result = spawnSync("node", [GUARD, "--no-fetch", ...extra], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function bare(name) {
  const dir = join(WORK, `${name}.git`);
  run(WORK, "init", "--bare", "-q", dir);
  return dir;
}

function seedClone(gitee) {
  // A fresh clone per test: a shared worktree would keep remotes and branches
  // from the previous case, which is exactly how the first draft failed.
  const dir = join(WORK, `seed-${Math.random().toString(36).slice(2)}`);
  run(WORK, "clone", "-q", gitee, dir);
  run(dir, "config", "user.email", "t@example.test");
  run(dir, "config", "user.name", "t");
  run(dir, "checkout", "-q", "-b", BRANCH);
  return dir;
}

function commit(repo, message) {
  mkdirSync(join(repo, "d"), { recursive: true });
  writeFileSync(
    join(repo, "d", `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
    message,
  );
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", message);
  return run(repo, "rev-parse", "HEAD");
}

test("equal tips: exit 0", () => {
  const gitee = bare("eq-gitee");
  const origin = bare("eq-origin");
  const repo = seedClone(gitee);
  run(repo, "remote", "add", "gitee", gitee);
  run(repo, "remote", "set-url", "origin", origin);
  commit(repo, "base");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);
  run(repo, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);

  const result = guard(repo);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /release lines agree/);
});

test("same work mirrored under different SHAs: exit 0, never a fork", () => {
  const gitee = bare("mirror-gitee");
  const origin = bare("mirror-origin");
  const repo = seedClone(gitee);
  run(repo, "remote", "add", "gitee", gitee);
  run(repo, "remote", "set-url", "origin", origin);
  commit(repo, "base");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);
  run(repo, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);

  // The mirror pattern: same patch, different SHA on each side.
  writeFileSync(join(repo, "mirror.txt"), "same content\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "shared work");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);

  const shared = run(repo, "rev-parse", "HEAD");
  run(repo, "checkout", "-q", "-B", "cherry", `origin/${BRANCH}`);
  run(repo, "cherry-pick", shared);
  run(repo, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  run(repo, "checkout", "-q", BRANCH);

  const result = guard(repo);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /pure mirror|one-way/);
});

test("real fork: exit 2 and both sides are listed", () => {
  const gitee = bare("fork-gitee");
  const origin = bare("fork-origin");
  const repo = seedClone(gitee);
  run(repo, "remote", "add", "gitee", gitee);
  run(repo, "remote", "set-url", "origin", origin);
  commit(repo, "base");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);
  run(repo, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);

  writeFileSync(join(repo, "gitee-only.txt"), "gitee\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "only on gitee");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);

  run(repo, "checkout", "-q", "-B", "origin-side", "origin/" + BRANCH);
  writeFileSync(join(repo, "origin-only.txt"), "origin\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "only on origin");
  run(repo, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  run(repo, "checkout", "-q", BRANCH);

  const result = guard(repo);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /FORKED/);
  assert.match(result.out, /only on gitee/);
  assert.match(result.out, /only on origin/);
});

test("--strict turns a one-way mirror lag into exit 1", () => {
  const gitee = bare("strict-gitee");
  const origin = bare("strict-origin");
  const repo = seedClone(gitee);
  run(repo, "remote", "add", "gitee", gitee);
  run(repo, "remote", "set-url", "origin", origin);
  commit(repo, "base");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);
  run(repo, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);

  commit(repo, "ahead on gitee only");
  run(repo, "push", "-q", "gitee", `HEAD:refs/heads/${BRANCH}`);

  assert.equal(guard(repo).code, 0, "plain mode tolerates pure mirror lag");
  assert.equal(guard(repo, "--strict").code, 1, "--strict refuses any divergence");
});

test("the snapshot script gates on the guard before exporting", { skip: NO_SNAPSHOT_SCRIPT }, async () => {
  // Prove the wiring, not just the guard: make-public-snapshot must call
  // check-release-lines and abort on a non-zero result before any export.
  const { readFileSync } = await import("node:fs");
  const snapshot = readFileSync(new URL("./make-public-snapshot.mjs", import.meta.url), "utf8");
  const guardCall = snapshot.indexOf("check-release-lines.mjs");
  const exportCall = snapshot.indexOf("exported ");
  assert.ok(guardCall > 0, "the snapshot script must call the line guard");
  assert.ok(guardCall < snapshot.indexOf("git archive") || exportCall === -1 || guardCall < exportCall,
    "the guard must run before the tree is exported");
  assert.match(snapshot, /Base is not whole/, "a refused base must explain itself");
  assert.match(snapshot, /SNAPSHOT_SKIP_LINE_CHECK/, "there must be a documented escape hatch");
});

test.after(() => {
  rmSync(WORK, { recursive: true, force: true });
});
