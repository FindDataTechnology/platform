#!/usr/bin/env node
// The remote-CI entry point has to be safe to reach for (2026-11-14).
//
// `scripts/ci-remote.sh` is the answer to "the suite no longer fits on this
// machine": one command pushes HEAD to the private mirror and dispatches the
// full gate. Three of its four steps have a silent failure mode, and two of them
// bit this round:
//
//   * pushing a BRANCH to a public repo bypasses every snapshot gate (the
//     2026-10 leak); the pre-push hook refuses it, but the hook is exactly what
//     someone works around at 2am. The script must therefore target the private
//     mirror and say so.
//   * `gh run watch` without `-R` watches the local origin — gitee here — and
//     404s. So must `gh run list`.
//   * the dispatch endpoint returns no run id, and "the newest run on the branch"
//     is the PREVIOUS one on a branch that has run before. The run must be found
//     by commit SHA.
//
// This asserts those three properties on the script's own output (dry-run) and
// that a dirty tree is refused, using a throwaway repo so the real checkout's
// state is irrelevant.
//
// Run: node scripts/test-ci-remote.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "ci-remote.sh");

// A checkout that looks real enough: one commit and a `scs001` remote whose URL
// is never contacted in dry-run mode.
function scratchRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ci-remote-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "probe/branch");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("remote", "add", "scs001", "git@github.com:scs001/platform.git");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

function run(dir, args) {
  const res = spawnSync("sh", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err?.message || err).split("\n").join("\n       ")}`);
  }
};

const { dir } = scratchRepo();

check("dry-run pushes a BRANCH to the private mirror (never the public repo)", () => {
  const r = run(dir, ["--dry-run"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /git push scs001 [0-9a-f]{40}:refs\/heads\/ci\/probe-branch-[0-9a-f]{7,}/);
  assert.doesNotMatch(r.out, /FindDataTechnology\/platform|platform-image-verify/);
});

check("dry-run dispatches the workflow on that ref, by name", () => {
  const r = run(dir, ["--dry-run"]);
  assert.match(r.out, /gh workflow run ci\.yml --ref ci\/probe-branch-[0-9a-f]+ -R scs001\/platform/);
});

check("every gh call names the repo (a bare `gh run watch` watches gitee and 404s)", () => {
  const r = run(dir, ["--dry-run", "--watch"]);
  const ghLines = r.out.split("\n").filter((l) => l.trim().startsWith("gh "));
  assert.ok(ghLines.length >= 3, `expected the gh calls, got ${JSON.stringify(ghLines)}`);
  for (const line of ghLines) assert.match(line, /-R scs001\/platform/, `missing -R: ${line}`);
});

check("the run is found by commit, not by 'newest on the branch'", () => {
  const r = run(dir, ["--dry-run"]);
  assert.match(r.out, /headSha/, "the lookup must filter on the dispatched commit");
});

check("--branch overrides the ref name", () => {
  const r = run(dir, ["--dry-run", "--branch", "v2"]);
  assert.match(r.out, /refs\/heads\/v2\b/);
});

check("a dirty tree is refused, and the refusal names the files", () => {
  const { dir: dirtyDir, git } = scratchRepo();
  writeFileSync(path.join(dirtyDir, "README.md"), "changed\n");
  const r = run(dirtyDir, ["--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /uncommitted changes/);
  assert.match(r.out, /README\.md/);
  void git;
});

// The hole this script had on its first day: the dirty check excludes untracked
// files (generated artifacts make that necessary), which means a NEW test that
// was never `git add`ed is absent from the commit the mirror builds — and the
// run comes back green about a tree that does not contain it. Exactly the
// "the gate cannot see your file" family, in the tool meant to prevent it.
check("an untracked test file is refused before it can silently not run", () => {
  const { dir: scratchDir } = scratchRepo();
  execFileSync("mkdir", ["-p", path.join(scratchDir, "scripts")]);
  writeFileSync(path.join(scratchDir, "scripts", "test-brand-new.mjs"), "// never added\n");
  const r = run(scratchDir, ["--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /NOT tracked/);
  assert.match(r.out, /test-brand-new\.mjs/);
});

check("untracked scratch outside the source tree does not block a run", () => {
  const { dir: scratchDir } = scratchRepo();
  execFileSync("mkdir", ["-p", path.join(scratchDir, "site-plaza", "generated")]);
  writeFileSync(path.join(scratchDir, "site-plaza", "generated", "catalog.json"), "{}\n");
  writeFileSync(path.join(scratchDir, "notes.txt"), "scratch\n");
  const r = run(scratchDir, ["--dry-run"]);
  assert.equal(r.status, 0, r.out);
});

check("a missing mirror remote is refused with the command to add it", () => {
  const { dir: bare } = scratchRepo();
  execFileSync("git", ["remote", "remove", "scs001"], { cwd: bare });
  const r = run(bare, ["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.out, /git remote add scs001/);
});

console.log(`\nci-remote: ${passed}/${passed + failed} cases passed`);
if (failed) process.exit(1);
