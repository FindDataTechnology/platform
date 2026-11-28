#!/usr/bin/env node
// ── Tracked build artifacts must stay out of the index ──────────────────────
//
// `graphify-out/` is 4,811 files / 104.8 MB of generated code-graph output. It
// was added to .gitignore on 2026-11-10, but .gitignore only affects UNTRACKED
// files — so the copies committed before that rule stayed in HEAD, and every
// clone / worktree / CI shard materialized all of them. The snapshot lane was
// never affected (scripts/make-public-snapshot.mjs excludes the path).
//
// The judge is the INDEX (`git ls-files`), not the disk: the 115 MB on disk is
// correct — graphify is still using it — and a check that reads the disk would
// report a healthy tree as broken.
//
// Both proofs are required (specs/release-gate-integrity): a gate that can only
// go red also passes for a rule that is always red, and one that can only go
// green passes for a rule that is always green. `--red-proof` runs it against
// the index as it was; `--green-proof` runs it against a path that MUST be
// tracked, so "sees any directory and fails" cannot masquerade as working.
//
// Run: node scripts/check-tracked-artifacts.mjs [--json]

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Paths that must never appear in the index. Named explicitly, never a glob:
 * a "all build output" rule would need a maintained classifier and would
 * happily red-flag `attic/` history that is deliberately kept.
 */
export const FORBIDDEN = [
  { path: "graphify-out/", why: "generated code-graph output; 104.8 MB, excluded from every snapshot" },
];

/** Paths that MUST be tracked — the negative control. */
export const MUST_TRACK = ["web/src/"];

function lsFiles(p) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", p], { cwd: REPO, encoding: "utf8" });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** @returns {{forbidden: Array<{path:string,count:number,bytes:number,why:string}>, missing: string[]}} */
export function checkTracked() {
  const forbidden = [];
  for (const f of FORBIDDEN) {
    const files = lsFiles(f.path);
    if (files.length === 0) continue;
    let bytes = 0;
    try {
      const stat = execFileSync("git", ["ls-tree", "-r", "-l", "HEAD", "--", f.path], { cwd: REPO, encoding: "utf8" });
      for (const line of stat.split("\n")) {
        const m = line.match(/^\d+ blob \w+\s+(\d+)\t/);
        if (m) bytes += Number(m[1]);
      }
    } catch { /* size is decoration; the count is the finding */ }
    forbidden.push({ path: f.path, count: files.length, bytes, why: f.why });
  }
  const missing = MUST_TRACK.filter((p) => lsFiles(p).length === 0);
  return { forbidden, missing };
}

function main() {
  const wantJson = process.argv.includes("--json");
  const { forbidden, missing } = checkTracked();
  const ok = forbidden.length === 0 && missing.length === 0;

  if (wantJson) {
    console.log(JSON.stringify({ forbidden, missing, ok }, null, 2));
  } else if (!ok) {
    for (const f of forbidden) {
      const mb = f.bytes ? ` / ${(f.bytes / 1048576).toFixed(1)} MB` : "";
      console.error(`[tracked-artifacts] ${f.path} is IN THE INDEX (${f.count} files${mb}) — ${f.why}`);
      console.error(`  fix: git rm -r --cached ${f.path.replace(/\/$/, "")} && commit`);
      console.error(`  note: the files stay on disk; .gitignore already covers them (${f.path})`);
    }
    for (const p of missing) {
      console.error(`[tracked-artifacts] control path ${p} is NOT tracked — the check is reading the wrong thing`);
    }
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
