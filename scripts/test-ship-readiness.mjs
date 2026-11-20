#!/usr/bin/env node
// ── 出片前核对闸的自测（harden-release-line-hygiene） ────────────────────────
//
// 这个闸存在的理由是：今天三次「拿着『应该是好的』当证据」——生产 pod 缺
// import、镜像仓 CI 静默停在一天前、推送前 lint 读工作树。所以它自己更不能
// 犯同一个错：**每条判据都要有一条会真红的证据，外加一条负对照。**
//
// 每条红证都在本仓历史里找一个真实对象，或就地构造一个真实的失败形状；
// 找不到就 skip 并打印原因，不静默变绿。
//
//   node --test scripts/test-ship-readiness.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Run the gate AS IT EXISTS IN THIS REPO, but with `cwd` pointed at the tree
 * under test.
 *
 * Not `node scripts/check-ship-readiness.mjs` from inside the fixture: the red
 * proof for "a branch forked off an old point" deliberately checks out a commit
 * from BEFORE the gate existed, so the script would not be there and the run
 * would die with MODULE_NOT_FOUND instead of exercising the check. (Caught on
 * 2026-11-20: the suite was green on the branch where it was written and red on
 * main, because main had moved far enough that HEAD~40 predated the script.)
 *
 * The gate reads only git state relative to cwd, so running its code from
 * elsewhere and judging a different tree is exactly what the tests need.
 */
const GATE = path.join(ROOT, "scripts", "check-ship-readiness.mjs");

function runGate(cwd, extraArgs = []) {
  try {
    const out = execFileSync("node", [GATE, "--offline", "--root", cwd, ...extraArgs], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function git(cwd, ...argv) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/**
 * The fixture base, built ONCE per test file.
 *
 * Each test still needs its own tree it can mangle, but cloning this repo four
 * times is ~8s apiece on a 270MB history — the whole suite was 150s, of which
 * the gate itself is 2.7s. So one base clone is made, and each test gets a
 * `--shared` clone OF THE BASE, which is milliseconds.
 *
 * A clone at all (rather than a worktree) because a worktree registers itself in
 * the real repo's `git worktree list` — a CI run would leave entries on the
 * builder's repo and concurrent runs could see each other's fixtures.
 *
 * The upstream ref is materialized by hand. The gate looks for `gitee/main` then
 * `origin/main`; a clone carries only `origin/main` pointed at whatever the
 * parent had, so the fixture pins `gitee/main` at HEAD to make "HEAD is the
 * upstream" unambiguous.
 */
let baseDir = null;
let baseError = null;

function fixtureBase() {
  if (baseDir || baseError) return baseDir;
  try {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ship-readiness-base-")), "repo");
    execFileSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", ROOT, dir], { stdio: "pipe" });
    execFileSync("git", ["update-ref", "refs/remotes/gitee/main", "HEAD"], { cwd: dir, stdio: "pipe" });
    baseDir = dir;
  } catch (err) {
    baseError = String(err.stderr ?? err.message).slice(0, 120);
  }
  return baseDir;
}

test.after(() => {
  if (baseDir) fs.rmSync(path.dirname(baseDir), { recursive: true, force: true });
});

/** A private, disposable copy of the fixture base. */
function scratchWorktree(t) {
  const base = fixtureBase();
  if (!base) {
    t.skip(`could not build the fixture base: ${baseError}`);
    return null;
  }
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ship-readiness-")), "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", base, dir], { stdio: "pipe" });
    // `--shared` carries objects, not remote-tracking refs: the base's
    // `refs/remotes/gitee/main` does NOT come along, and without it the gate
    // answers `unknown` for every check. Re-point it at the base's HEAD.
    execFileSync("git", ["update-ref", "refs/remotes/gitee/main", "HEAD"], { cwd: dir, stdio: "pipe" });
    fs.copyFileSync(
      path.join(ROOT, "scripts", "check-ship-readiness.mjs"),
      path.join(dir, "scripts", "check-ship-readiness.mjs"),
    );
    // `--allow-empty` because when the gate script is already identical in HEAD
    // there is nothing to commit, and `-am` would then exit 1 and every red
    // proof would silently skip — a fixture that cannot build must not look
    // like a test that passed.
    git(
      dir,
      "-c", "user.email=t@t",
      "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-am", "test fixture",
    );
    return dir;
  } catch (err) {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    t.skip(`could not build a scratch clone: ${String(err.stderr ?? err.message).slice(0, 120)}`);
    return null;
  }
}

function dropWorktree(dir) {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

test("negative control: a clean checkout of this repo passes every offline check", () => {
  const r = runGate(ROOT);
  // The offline run still resolves HEAD vs the upstream. If that cannot be
  // resolved the gate says `unknown` (exit 2), which is NOT a pass — so this
  // test must distinguish "clean" from "could not tell".
  assert.notEqual(r.code, 2, `the gate could not judge this checkout:\n${r.out}`);
  assert.equal(r.code, 0, `a clean checkout must be green:\n${r.out}`);
});

test("CI shape: with only origin/main and HEAD at it, the gate still judges", (t) => {
  // GitHub Actions has no `gitee` remote — only `origin`. When the gate resolved
  // `gitee/main` alone, every CI run answered `unknown` → exit 2 → the image job
  // failed on a perfectly good tree (this wiring was added to image.yml, so the
  // shape must be proven, not assumed).
  const dir = scratchWorktree(t);
  if (!dir) return;
  try {
    git(dir, "update-ref", "-d", "refs/remotes/gitee/main");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    const r = runGate(dir);
    assert.equal(r.code, 0, `the CI shape must be judgeable, not "unknown":\n${r.out}`);
    assert.match(r.out, /origin\/main/, "the output must name which upstream it used");
  } finally {
    dropWorktree(dir);
  }
});

test("red proof: HEAD importing a module that is not in HEAD is caught", (t) => {
  const dir = scratchWorktree(t);
  if (!dir) return;
  try {
    const entry = path.join(dir, "server.js");
    const src = fs.readFileSync(entry, "utf8");
    fs.writeFileSync(
      entry,
      src.replace(
        /^import express from "express";$/m,
        'import express from "express";\nimport { nope } from "./_absent_probe.js";',
      ),
    );
    // Commit it WITHOUT the target file: this is exactly 23c78073e's shape
    // (HEAD references an uncommitted module → snapshot boots to a crash).
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-am", "probe: dangling import");

    const r = runGate(dir);
    assert.notEqual(r.code, 0, "a dangling import in HEAD must not pass");
    assert.match(r.out, /committed-refs/, "the red must name which check failed");
    assert.match(r.out, /_absent_probe/, "the red must name the dangling specifier");
  } finally {
    dropWorktree(dir);
  }
});

test("red proof: a branch forked off an old point is caught as behind", (t) => {
  const dir = scratchWorktree(t);
  if (!dir) return;
  try {
    // Fork 40 commits back, then add one commit so it is genuinely divergent
    // (not an ancestor — an ancestor is a legitimate side branch, and the gate
    // must NOT red those; see the next test).
    git(dir, "checkout", "-q", "-b", "probe-old", "HEAD~40");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "probe");

    const r = runGate(dir);
    assert.notEqual(r.code, 0, "a forked old branch must not pass");
    assert.match(r.out, /base-on-main/, "the red must name the base check");
    assert.match(r.out, /落后/, "the red must say how far behind");
  } finally {
    dropWorktree(dir);
  }
});

test("negative control: a side branch that is an ANCESTOR of main is legitimate", (t) => {
  const dir = scratchWorktree(t);
  if (!dir) return;
  try {
    // Cutting an image from an ancestor of main is the normal side-branch ship
    // (NOT a defect). The gate must stay green here, or it would teach people
    // to ignore it.
    git(dir, "checkout", "-q", "--detach", "HEAD~2");
    const r = runGate(dir);
    assert.equal(r.code, 0, `an ancestor side branch must stay green:\n${r.out}`);
    assert.doesNotMatch(r.out, /✗ \[base-on-main\]/, "an ancestor branch must not be red on the base check");
  } finally {
    dropWorktree(dir);
  }
});
