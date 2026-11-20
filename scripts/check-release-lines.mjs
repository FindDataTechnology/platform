#!/usr/bin/env node
// ── Release-line guard: is the line I am about to snapshot from whole? ───────
//
// The two remotes (gitee, origin) both carry `release/cell-session-persona`, and
// that branch — not `main` — is what `scripts/make-public-snapshot.mjs` cuts
// images from (`--ref HEAD` on the operator's checkout). Twice now a shipped
// image was missing work that only existed on the other remote, and once a merge
// reintroduced a block the other line had already deleted.
//
// `git cherry` is the right comparison here, not `rev-list --count`: the two
// lines routinely carry the SAME work under different SHAs (cherry-picked
// mirrors), so counting commits reports a fake 38-vs-32 divergence. Patch-id
// equality is what distinguishes "mirrored" from "genuinely forked".
//
//   node scripts/check-release-lines.mjs            # report; exit 2 on a real fork
//   node scripts/check-release-lines.mjs --strict   # exit 1 on any divergence at all
//   node scripts/check-release-lines.mjs --no-fetch # compare stale tracking refs
//
// Exit codes
//   0  both lines agree, or one is a pure mirror of the other (nothing unique)
//   1  --strict and the tips differ (includes pure mirror lag)
//   2  both sides have commits the other lacks — merge before cutting an image
//   3  a remote/branch could not be read

import { spawnSync } from "node:child_process";

const REMOTES = ["gitee", "origin"];
const BRANCH = "release/cell-session-persona";
const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const FETCH = !args.has("--no-fetch");

function git(...argv) {
  const result = spawnSync("git", argv, { encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
}

if (FETCH) {
  for (const remote of REMOTES) {
    const fetched = git("fetch", "--quiet", remote, BRANCH);
    if (!fetched.ok) {
      console.error(`could not fetch ${remote} ${BRANCH}: ${fetched.err || "unknown error"}`);
      process.exit(3);
    }
  }
}

const tips = {};
for (const remote of REMOTES) {
  const resolved = git("rev-parse", "--verify", `${remote}/${BRANCH}`);
  if (!resolved.ok) {
    console.error(`could not resolve ${remote}/${BRANCH}`);
    process.exit(3);
  }
  tips[remote] = resolved.out;
}

const [left, right] = REMOTES;
const shortSha = (sha) => sha.slice(0, 9);

if (tips[left] === tips[right]) {
  console.log(`release lines agree: ${left} = ${right} = ${shortSha(tips[left])}`);
  process.exit(0);
}

// `git cherry <upstream> <head>` marks commits IN head that upstream lacks with
// `+`, and commits whose patch is already upstream (mirrored) with `-`.
function uniqueTo(headRef, upstreamRef) {
  const cherry = git("cherry", upstreamRef, headRef);
  if (!cherry.ok) return null;
  return cherry.out
    .split("\n")
    .filter((line) => line.startsWith("+ "))
    .map((line) => line.slice(2));
}

const uniqueLeft = uniqueTo(`${left}/${BRANCH}`, `${right}/${BRANCH}`);
const uniqueRight = uniqueTo(`${right}/${BRANCH}`, `${left}/${BRANCH}`);
if (uniqueLeft === null || uniqueRight === null) {
  console.error("git cherry failed; are both refs fetched?");
  process.exit(3);
}

const subjectOf = (sha) =>
  git("log", "-1", "--format=%h %s", sha).out.replace(/\s+/g, " ").slice(0, 100);

console.log(
  `release lines differ: ${left}=${shortSha(tips[left])}  ${right}=${shortSha(tips[right])}`,
);
for (const [name, list] of [
  [`only in ${left}`, uniqueLeft],
  [`only in ${right}`, uniqueRight],
]) {
  console.log(`\n${name} (${list.length}):`);
  if (list.length === 0) console.log("  (none — pure mirror of the other line)");
  for (const sha of list.slice(0, 20)) console.log(`  ${subjectOf(sha)}`);
  if (list.length > 20) console.log(`  … ${list.length - 20} more`);
}

// The failure that actually cost a bad image: BOTH sides carried work the other
// lacked, so whichever checkout cut the snapshot, the image was incomplete.
if (uniqueLeft.length > 0 && uniqueRight.length > 0) {
  console.error(
    `\nFORKED: ${left} has ${uniqueLeft.length} and ${right} has ${uniqueRight.length} commits the other lacks.` +
      `\nMerge the two into one line before cutting an image (image base = HEAD of the checkout).`,
  );
  process.exit(2);
}

if (STRICT) {
  console.error(`\nSTRICT: tips differ (${shortSha(tips[left])} vs ${shortSha(tips[right])}).`);
  process.exit(1);
}

const behind = uniqueLeft.length > 0 ? right : left;
const ahead = uniqueLeft.length > 0 ? left : right;
console.log(
  `\nOK (one-way): ${behind} is missing ${uniqueLeft.length || uniqueRight.length} commit(s) from ${ahead}.`,
);
console.log(`Push ${behind} from ${ahead} to clear it; the content itself has no fork.`);
process.exit(0);
