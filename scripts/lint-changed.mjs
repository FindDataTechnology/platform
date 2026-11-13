// Lint only what a push (or a CI run) actually changed
// (openspec: release-line-hygiene).
//
// The release line is shared and has no push-time hygiene: on 2026-11-09 four
// separate pushes shipped lint-red commits, each one blocked the image build at
// its `Lint (Biome)` step, and the person who had to clear them was never the
// person who wrote them. The gate belongs at the push, and it must judge ONLY
// the pushed files — otherwise every push inherits the whole line's history.
//
// One implementation, two entry points (the pre-push hook and CI): the range
// differs, the judgement must not. Anything else drifts, and a drifting gate
// teaches people to bypass it.
//
// Usage:
//   node scripts/lint-changed.mjs                 # range: @{push}..HEAD, else HEAD~1..HEAD
//   node scripts/lint-changed.mjs --range A..B     # explicit range
//   node scripts/lint-changed.mjs --files a b c    # explicit file list (CI)
// Exit: 0 clean / nothing to check, 1 violations found, 2 usage error.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// `agent-runner` joined this list on 2026-11-12, after a merge left manager.js
// calling billingKeyFromHome without importing it: biome's noUndeclaredVariables
// flags exactly that line, but the push gate never looked at the tree, so it
// shipped and broke billing-park in production. The tree lints clean today —
// measured, 26 files, zero errors — so this adds coverage without inheriting debt.
const CODE_PATH = /^(web\/src|packages|server|server\.js|lib|gateway|app\/src|agent-runner)\/|^(server|task-engine|cron|db|pack-store|dsh-bridge)\.js$/;
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
};

function resolveRange() {
  const explicit = flag("--range");
  if (explicit) return explicit;
  try {
    // @{push} is the tracking branch for this branch; absent on a fresh clone.
    execFileSync("git", ["rev-parse", "--verify", "@{push}"], { stdio: "ignore" });
    return "@{push}..HEAD";
  } catch {
    return "HEAD~1..HEAD";
  }
}

function diffRange(range) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=d", range], {
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function changedFiles() {
  const files = flag("--files");
  if (files) {
    return files
      .split(/[\s,]+/)
      .map((f) => f.trim())
      .filter(Boolean);
  }
  const range = resolveRange();
  // A synthetic-history repo (the image-build mirror force-pushes ONE commit
  // per snapshot) hands us a `before` sha that does not exist in the new
  // history, and the range is invalid. Degrade instead of failing: try the
  // requested range, then the single commit, then give up quietly — the
  // full-repo `npm run lint` in the same job is the backstop there.
  const ALL_ZERO = /^0+$/;
  const [from] = range.split("..");
  const candidates = ALL_ZERO.test(from ?? "") ? ["HEAD~1..HEAD"] : [range, "HEAD~1..HEAD"];
  for (const candidate of candidates) {
    try {
      return diffRange(candidate);
    } catch {
      /* try the next, narrower range */
    }
  }
  console.warn(`[lint-changed] 无法解析推送范围（${range}）——跳过；本仓全量 lint 仍是最终判据。`);
  return [];
}

function isCode(rel) {
  if (!CODE_EXT.test(rel)) return false;
  // Tests and e2e count too: the four pushes that broke the gate were mostly
  // in `scripts/test-*.mjs` and `e2e/*.spec.js`.
  if (/^(scripts|e2e|test)\//.test(rel)) return true;
  return CODE_PATH.test(rel);
}

const SKIP = process.env.SKIP_LINT_HOOK === "1";

const target = changedFiles().filter((f) => isCode(f) && existsSync(path.resolve(f)));

if (target.length === 0) {
  // A docs-only or empty push is not a hygiene event — stay quiet.
  process.exit(0);
}

if (SKIP) {
  console.warn(
    "[lint-changed] SKIP_LINT_HOOK=1 — 跳过推送前 lint。CI 仍会红；这只用于紧急回滚。",
  );
  process.exit(0);
}

const biome = path.resolve("node_modules/.bin/biome");
if (!existsSync(biome)) {
  // 缺依赖时 MUST NOT 静默放行：这一行原来 exit(0)，于是「钩子报了跳过、实际
  // 什么都没查」——2026-11-11 一天里两次推送都是这样过去的（一次带进两处 lint
  // 债，一次差点把没人读的参数带上产）。闸门自己的失效必须是响的。
  console.error(
    "[lint-changed] 找到必须检查的代码改动，但没有 biome（node_modules 未安装）。\n" +
      "  · 修法一：在本仓跑 `npm i`（只装依赖，不跑别的）；\n" +
      "  · 修法二：`SKIP_LINT_HOOK=1 git push`——仅限紧急回滚，CI 仍会红。",
  );
  process.exit(1);
}
let code = 0;
try {
  execFileSync(biome, ["check", ...target], { stdio: "inherit" });
} catch (err) {
  code = err.status ?? 1;
}

if (code === 0) process.exit(0);

console.error(`
[lint-changed] 推送被拦：上面「本次推送改动的」文件里有 lint 违规。

怎么办：
  1. 改掉它：npx biome check --write <文件>（可自动修的会修，剩下的人工改）；
  2. 再推一次。
  3. 真的必须现在推（紧急回滚）：SKIP_LINT_HOOK=1 git push —— CI 仍会红，只是不挡推送。

为什么只查改动文件：这条线是多人共用的发布分支，历史欠账不属于本次推送；
判据只覆盖你改的东西，所以它挡得住回潮，挡不住别人。
`);
process.exit(code);
