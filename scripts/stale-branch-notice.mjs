// Push-time staleness notice (release-line staleness).
//
// WHY THIS EXISTS
// ---------------
// The repo's normal working pattern is `git checkout -b feat/xxx` from whatever
// branch happens to be current. That is fine until the current branch is itself
// hundreds of commits behind origin/main — then every new branch is born stale,
// and people read the stale branch's state as if it were the project's.
//
// Measured on 2026-11-18: the main working tree sat on a branch 1194 commits
// behind origin/main with 152k lines missing. Two separate sessions in one day
// read that tree, concluded real work was "not started", and redid work that
// had already shipped — one of them wrote four modules and four test suites
// against a stale change manifest.
//
// WHAT IT DOES — AND DELIBERATELY DOES NOT DO
// -------------------------------------------
// It PRINTS A NOTICE. It never blocks the push, and it never rewrites a branch.
// Blocking would strand releases behind an unrelated rebase; auto-rebasing
// someone else's branch is worse. Visibility is the whole intervention: the
// cost of the bug was "nobody knew", so the fix is "everyone is told".
//
// Advisory only. Exits 0 always, so it can never be the reason a push fails.

import { execFileSync } from "node:child_process";

/** Behind-by this many commits, say something. */
const NOTICE_AT = Number(process.env.STALE_NOTICE_AT || 20);
/** Shout (still without blocking) past this. */
const LOUD_AT = Number(process.env.STALE_LOUD_AT || 200);

const run = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// The upstream to compare against: origin/main by default (this repo pushes to
// origin/gitee; a detached CI checkout has neither, which is why every failure
// here is silent).
const upstream = process.env.STALE_UPSTREAM || "origin/main";

const head = run(["rev-parse", "--abbrev-ref", "HEAD"]);
if (!head || head === "HEAD") process.exit(0); // detached: nothing to advise
if (!run(["rev-parse", "--verify", "--quiet", upstream])) process.exit(0);
if (head === upstream || upstream === `origin/${head}`) process.exit(0);

const behind = Number(run(["rev-list", "--count", `HEAD..${upstream}`]) || 0);
if (!Number.isFinite(behind) || behind < NOTICE_AT) process.exit(0);

const ahead = Number(run(["rev-list", "--count", `${upstream}..HEAD`]) || 0);

// How much *content* is missing — commit counts understate it badly (1194
// commits was 152k lines).
const diffstat = run(["diff", "--shortstat", `${upstream}`, "HEAD"]);
const missing = /(\d+) deletions?/.exec(diffstat)?.[1] ?? "?";

const loud = behind >= LOUD_AT;
const lines = [
  "",
  loud
    ? "[stale-branch] ⚠ 这条分支落后 origin/main 很多 —— 你看到的项目状态是旧的。"
    : "[stale-branch] 这条分支落后 origin/main。",
  "",
  `  当前分支   ${head}`,
  `  落后       ${behind} 笔提交（相对 HEAD 少 ${missing} 行）`,
  `  领先       ${ahead} 笔`,
  "",
  "  为什么要看这个：在这个仓里，从「当前分支」开新分支是常规做法。当前分支若是旧的，",
  "  新分支就一出生是旧的，而它上面的 change 清单、测试、源码都还是旧的 —— 会有人",
  "  据此判断「这项工作还没开始」然后把已经上产的东西重做一遍（2026-11-18 实测两次）。",
  "",
  "  该怎么办（自己选，这里不做任何自动动作）：",
  `    · 只是一个无关的小改动：先 git rebase ${upstream} 再推；`,
  `    · 要基于最新代码干活：git checkout -b <新分支> ${upstream}（从最新长出来）；`,
  `    · 本来就在一条长期分支上、确实不想动：忽略这条提示（推送照常）。`,
  "",
];

console.error(lines.join("\n"));
process.exit(0);
