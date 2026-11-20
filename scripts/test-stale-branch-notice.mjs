// stale-branch-notice (release-line staleness).
//
// The one property that matters most: this script must NEVER be the reason a
// push fails. An advisory that can block gets bypassed once and then ignored
// forever, and a stale-branch gate that blocks would strand releases behind
// unrelated rebases.
//
// Run: node --test scripts/test-stale-branch-notice.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = path.join(ROOT, "scripts/stale-branch-notice.mjs");

const sh = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A throwaway repo: `main` has `mainCommits` commits, and branch `topic` is cut
 * `behindMain` commits back. (Cutting by a fixed HEAD~N broke as soon as a test
 * asked for a repo with fewer commits than N.)
 */
function fixture({ mainCommits = 30, behindMain = 10, current = "topic" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stale-notice-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "t@t"]);
  sh(dir, ["config", "user.name", "t"]);
  for (let i = 0; i < mainCommits; i++) {
    writeFileSync(path.join(dir, "f.txt"), `x${i}\n`);
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", `c${i}`]);
  }
  sh(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (behindMain > 0) sh(dir, ["checkout", "-q", "-b", current, `HEAD~${behindMain}`]);
  return dir;
}

function runCapturingStderr(dir, env = {}) {
  // spawnSync, not execFileSync: the notice writes to stderr and exits 0, and
  // execFileSync's `stdio: pipe` gives no stderr handle on the success path.
  const r = spawnSync("node", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── never blocks ────────────────────────────────────────────────────────────

test("a badly stale branch still exits 0", () => {
  const dir = fixture();
  try {
    const r = runCapturingStderr(dir);
    assert.equal(r.code, 0, "the notice must never fail a push");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── says something when it should ───────────────────────────────────────────

test("a stale branch prints the behind count and the branch name", () => {
  const dir = fixture({ mainCommits: 30, behindMain: 10 });
  try {
    const r = runCapturingStderr(dir, { STALE_NOTICE_AT: "5" });
    assert.match(r.stderr, /stale-branch/);
    assert.match(r.stderr, /topic/);
    assert.match(r.stderr, /落后\s+10 笔/); // branched at HEAD~10
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a loud threshold escalates the wording but still exits 0", () => {
  const dir = fixture({ mainCommits: 400, behindMain: 100 });
  try {
    const r = runCapturingStderr(dir, { STALE_LOUD_AT: "50", STALE_NOTICE_AT: "5" });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /⚠/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── silent when it should be ────────────────────────────────────────────────

test("a branch level with main says nothing", () => {
  const dir = fixture({ mainCommits: 5, behindMain: 0 });
  try {
    sh(dir, ["checkout", "-q", "-B", "level", "main"]);
    const r = runCapturingStderr(dir, { STALE_NOTICE_AT: "1" });
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), "", "no notice when there is nothing to report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shallow staleness below the threshold says nothing", () => {
  const dir = fixture({ mainCommits: 30, behindMain: 10 });
  try {
    const r = runCapturingStderr(dir, { STALE_NOTICE_AT: "500" });
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no upstream ref at all is silent (detached CI checkouts)", () => {
  const dir = fixture({ mainCommits: 5, behindMain: 2 });
  try {
    sh(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const r = runCapturingStderr(dir, { STALE_NOTICE_AT: "1" });
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
