#!/usr/bin/env node
// The pre-push guard decides on the repo's ACTUAL visibility
// (openspec/changes/release-line-hygiene; hardened 2026-11-14).
//
// Why: the guard used to match remote URLs by string. That refused a branch push
// to `scs001/platform` — a repo GitHub reports as **private** — while the real
// incident it was written for (2026-10: three thousand un-cropped internal files
// public for ~40 minutes) came from a repo whose visibility was the whole
// problem. A string cannot see that, and a refusal on a private repo only
// teaches people to reach for `--no-verify`, which removes the one place where
// someone looks at the push at all.
//
// So the guard now asks GitHub (`gh api repos/<slug> --jq .visibility`) and:
//   private    → any ref allowed, with a line in the log saying why;
//   everything else, INCLUDING an unreadable answer → only main|master.
// "Cannot tell" must mean "refuse": a leak is unrecoverable, a false refusal is
// one sentence. Half of these cases pin that direction.
//
// This drives the REAL hook script with a stubbed `gh` on PATH — the assertion
// is on the hook's decision, not on a reimplementation of it.
//
// Run: node scripts/test-pre-push-hook.mjs

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", ".githooks", "pre-push");

// The stub answers `gh api ... --jq .visibility` from FAKE_VIS; an empty value
// behaves like an unauthenticated/offline gh (non-zero, no output).
const STUB_GH = `#!/bin/sh
if [ -z "\${FAKE_VIS:-}" ]; then
  echo "gh: Not authenticated" >&2
  exit 1
fi
echo "\${FAKE_VIS}"
`;

const bin = mkdtempSync(path.join(os.tmpdir(), "pre-push-gh-"));
writeFileSync(path.join(bin, "gh"), STUB_GH);
chmodSync(path.join(bin, "gh"), 0o755);

// `git push` hands the hook one line per ref on stdin.
const refLine = (ref) => `${ref} 1111111111111111111111111111111111111111 ${ref} 2222222222222222222222222222222222222222\n`;

function runHook({ url, ref = "refs/heads/probe/x", visibility = null, extraEnv = {} }) {
  const res = spawnSync("sh", [HOOK, "origin", url], {
    input: refLine(ref),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PRE_PUSH_TEST_MODE: "1", // skip the lint step: not what this file judges
      FAKE_VIS: visibility ?? "",
      ...extraEnv,
    },
  });
  return { status: res.status, stderr: res.stderr || "", stdout: res.stdout || "" };
}

let passed = 0;
const cases = [];
function check(name, fn) {
  cases.push([name, fn]);
}

// ── The property that made this change necessary ────────────────────────────
check("private repo: a branch ref is allowed, and the log says why", () => {
  const r = runHook({ url: "git@github.com:scs001/platform.git", visibility: "private" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /核为 private/);
});

check("private repo, URL without .git: still recognised", () => {
  const r = runHook({ url: "git@github.com:scs001/platform", visibility: "private" });
  assert.equal(r.status, 0);
});

// ── The property the guard exists for ──────────────────────────────────────
check("public repo: a branch ref is refused", () => {
  const r = runHook({ url: "git@github.com:FindDataTechnology/platform.git", visibility: "public" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /拒绝把 refs\/heads\/probe\/x/);
  assert.match(r.stderr, /可见性 = public/);
});

check("public repo: main is allowed", () => {
  const r = runHook({ url: "git@github.com:FindDataTechnology/platform.git", visibility: "public", ref: "refs/heads/main" });
  assert.equal(r.status, 0);
});

check("public repo: the explicit hatch still works", () => {
  const r = runHook({
    url: "git@github.com:FindDataTechnology/platform.git",
    visibility: "public",
    extraEnv: { ALLOW_PUBLIC_BRANCH_PUSH: "1" },
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /ALLOW_PUBLIC_BRANCH_PUSH=1/);
});

// ── Fail closed: "cannot tell" is not "private" ────────────────────────────
check("gh unavailable: a branch ref is refused (fail closed)", () => {
  const r = runHook({ url: "git@github.com:scs001/platform.git", visibility: null });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /可见性 = 未知/);
});

check("visibility 'internal': a branch ref is refused", () => {
  const r = runHook({ url: "git@github.com:scs001/platform.git", visibility: "internal" });
  assert.equal(r.status, 1);
});

// ── Scope: only GitHub candidates are judged at all ────────────────────────
// The fixture is a SYNTHETIC gitee URL on purpose. The hook's `case` only
// gates the four platform repo URLs; anything else falls straight through to
// "not gated", so the assertion below depends solely on "this is not one of
// those repos" — never on which private repo it names. The real name that used
// to sit here made the public-surface snapshot gate fail
// (`forbidden patterns: [private repo name]`, 2026-11-14), and the gate is
// right: this file ships publicly. Do not "restore" the real remote.
check("a private-source remote is never gated, even with gh broken", () => {
  const r = runHook({ url: "git@gitee.com:example-org/private-mirror.git", visibility: null });
  assert.equal(r.status, 0);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err?.message || err).split("\n").join("\n       ")}`);
  }
}

console.log(`\npre-push hook: ${passed}/${cases.length} cases passed`);
if (failed) {
  console.log("A guard whose refusals are untested is a guard nobody can trust; both directions are pinned above.");
  process.exit(1);
}
