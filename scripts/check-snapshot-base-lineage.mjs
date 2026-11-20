#!/usr/bin/env node
// ── 切片基线闸：候选片必须包含「在役片」的基线 ─────────────────────────────
//
// 抓什么
// ------
// 「新片会把线上正在跑的东西回退掉，而没有任何闸会响。」
//
// 2026-11-14 当晚实况（这道闸的第一具样本）：
//   在役片 sha-8897e9b  ← BUILD-INFO baseCommit d27299665（预算软停等 68 笔只在它上面）
//   mirror 新片 ac696af ← BUILD-INFO baseCommit addcf1876
//   d27299665 与 addcf1876 互不为祖先（各自独有 395 / 22 笔），且候选片里
//   `budgetSoftStop` 取不到 —— 一旦滚上去，线上刚验证生效的软停整段消失。
//
// 为什么既有闸都不响
// ------------------
//   • check-release-lines.mjs 只比 gitee↔origin 同一个分支名（两条主干，彼此一致）；
//   • make-public-snapshot.mjs 的 freshness 只问「HEAD 缺 main 多少」（从 main 切必为 0）；
//   • fd-image-coherence-gate 只问「四处引用是不是同一片」。
// 三道都答不了「这片相对线上少了什么」——因为线上基线只写在镜像的 BUILD-INFO 里。
//
// 判据
// ----
//   候选基线 是 在役基线 的后代 ⇒ 0（单调前进，线上没有东西会被丢弃）
//   否则                         ⇒ 1（并列出「在役有而候选没有」的 feat/fix，最多 20 条）
//   取不到输入                   ⇒ 2（判不出，绝不退化成 0）
//
// 用法
// ----
//   node scripts/check-snapshot-base-lineage.mjs \
//     --deployed d27299665 --candidate mirror/main
//   node scripts/check-snapshot-base-lineage.mjs --deployed-sha 8897e9b --candidate-mirror
//   node scripts/check-snapshot-base-lineage.mjs --self-test
//
// --candidate-mirror  从 mirror 仓的现 HEAD 读 BUILD-INFO.json 的 baseCommit
//                     （需要本地有 mirror remote；离线时用 --candidate <ref>）
// --deployed-sha <tag> 把镜像 tag 当本地提交解析（本仓的镜像 tag 就是私仓短 sha）
//
// 退出码：0 安全 / 1 会回退 / 2 判不出

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

function git(...argv) {
  const r = spawnSync("git", argv, { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}
const resolve = (ref) => git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);

function baseCommitOf(ref) {
  const raw = git("show", `${ref}:BUILD-INFO.json`);
  if (!raw) return null;
  try {
    return JSON.parse(raw)?.baseCommit ?? null;
  } catch {
    return null;
  }
}

// 在役基线从跑着的 pod 现取（2026-11-14 增，AGENTS.md 早已这么写）。两件事促使它必须存在：
//   ① 镜像 tag 来自快照仓，本仓通常没有那个对象 ⇒ `--deployed-sha <tag>` 一律解析不出；
//   ② 「在役基线是哪一笔」只有一处真值——容器里的 `/app/BUILD-INFO.json`。手抄必错：
//      同一天基线变了三次（d27299665 → 08c420927 → 85715e6fa），上午验过的分支 40 分钟后就落后 2 笔。
// 取不到返回 null ⇒ 一路走到 exit 2（判不出），绝不当成「没有在役工作会丢」——这两种结论
// 一个字都不能混（见下面 self-test 的第三臂）。
function baseCommitFromPod(deploy = "platform", { namespace = "fd-prod", context = "cheap" } = {}) {
  const r = spawnSync(
    "kubectl",
    ["--context", context, "-n", namespace, "exec", `deploy/${deploy}`, "-c", deploy, "--", "cat", "/app/BUILD-INFO.json"],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout)?.baseCommit ?? null;
  } catch {
    return null;
  }
}

// 「在役有而候选没有」的 feat/fix —— 这就是操作员真正要看的清单，
// 不是分叉计数（计数里一半是 merge 与 docs，看着吓人、处置方向不同）。
const SHIPPED_TREES = [
  "agent-runner", "lib", "server", "gateway", "web/src", "miniapp",
  "facet", "db.js", "server.js", "task-engine", "cron", "pack-store", "dsh-bridge",
];
function wouldLose(deployedSha, candidateSha) {
  const out = git("log", "--oneline", `${candidateSha}..${deployedSha}`, "--", ...SHIPPED_TREES);
  if (out === null) return null;
  return out
    .split("\n")
    .filter(Boolean)
    .filter((l) => /\s(feat|fix)(\(|:)/.test(l));
}

function check(deployed, candidate) {
  if (!deployed) return { code: 2, why: "在役基线解析不出（--deployed / --deployed-sha / --deployed-from-pod 都没给或不可解析）" };
  if (!candidate) return { code: 2, why: "候选基线解析不出（--candidate <ref> 或 --candidate-mirror 都取不到）" };
  // 打错一个 sha 必须判「判不出」，不能判「会回退」：`git merge-base --is-ancestor <垃圾> …`
  // 只是退出非零，于是旧版把「这个对象根本不存在」读成「不是后代」，报出
  // 「在役独有 ? 笔」——与真分叉逐字同形。一次手滑就被告知「你要把线上抹掉」，
  // 而假红正是让人开始无视一道闸的方式（2026-11-14 实历，AGENTS.md 的四臂自证就是要钉它）。
  for (const [label, sha] of [["在役基线", deployed], ["候选基线", candidate]]) {
    const known = git("cat-file", "-e", `${sha}^{commit}`) !== null;
    if (!known) return { code: 2, why: `${label} \`${String(sha).slice(0, 12)}\` 在本仓不是一个提交（打错 sha？）——判不出，不是「会回退」` };
  }
  const isAncestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", deployed, candidate],
    { cwd: REPO_ROOT },
  ).status === 0;
  if (isAncestor) {
    return { code: 0, why: `候选包含在役基线（${deployed.slice(0, 9)} ⊆ ${candidate.slice(0, 9)}）——单调前进，线上不会丢东西` };
  }
  const losses = wouldLose(deployed, candidate) ?? [];
  const behind = git("rev-list", "--count", `${candidate}..${deployed}`) ?? "?";
  return { code: 1, why: `候选 **不是** 在役基线的后代：在役独有 ${behind} 笔（shipped trees 里的 feat/fix 共 ${losses.length} 笔）`, losses };
}

// ── self-test：两个方向各证一次 ─────────────────────────────────────────────
if (flag("--self-test")) {
  // 方向一（应绿）：自己包含自己。
  const self = resolve("HEAD");
  // 方向二（应红）：拿一个互不为祖先的提交对——本仓现成的样本是 merge 双方。
  let green = false, red = false, greenOk = false, redOk = false;
  if (self) {
    const r = check(self, self);
    green = r.code === 0;
    greenOk = green;
  }
  // 用一个已知与 HEAD 分叉的 ref 证红：取任一不是 HEAD 祖先、也不是其后代的 ref。
  const probes = (git("for-each-ref", "--format=%(refname:short)", "refs/remotes/") ?? "")
    .split("\n").filter(Boolean);
  for (const p of probes) {
    const sha = resolve(p);
    if (!sha || sha === self) continue;
    const anc1 = spawnSync("git", ["merge-base", "--is-ancestor", sha, self], { cwd: REPO_ROOT }).status === 0;
    const anc2 = spawnSync("git", ["merge-base", "--is-ancestor", self, sha], { cwd: REPO_ROOT }).status === 0;
    if (!anc1 && !anc2) {
      red = check(self, sha).code === 1;
      redOk = red;
      if (red) break;
    }
  }
  console.log(`self-test: 同基线→${greenOk ? "绿 ✓" : "未证到 ✗"}   分叉基线→${redOk ? "红 ✓" : "未证到 ✗"}`);

  // 三、四臂（AGENTS.md 的四臂自证）：打错 sha 必须是「判不出」，不是「会回退」。
  // 为什么单列：解析不出的输入曾与真分叉逐字同形（都报「在役独有 ? 笔」），一次手滑
  // 就会被告知「你要把线上抹掉」——假红正是让人开始无视一道闸的方式。
  const badDeployed = check(`${self ?? "HEAD"}deadbeef`, self ?? "HEAD");
  const badCandidate = check(self ?? "HEAD", `${self ?? "HEAD"}deadbeef`);
  const typoOk = badDeployed.code === 2 && badCandidate.code === 2;
  console.log(`self-test: 在役基线打错→${badDeployed.code === 2 ? "判不出 ✓" : `✗ (${badDeployed.code})`}   候选基线打错→${badCandidate.code === 2 ? "判不出 ✓" : `✗ (${badCandidate.code})`}`);

  process.exit(greenOk && redOk && typoOk ? 0 : 1);
}

// ── 解析输入 ───────────────────────────────────────────────────────────────
let deployed = val("--deployed");
if (!deployed && flag("--deployed-from-pod")) {
  // 现取（推荐）：tag 来自快照仓、本仓没有那个对象，手抄又会过期。
  deployed = baseCommitFromPod(val("--deployed-from-pod"), {
    namespace: val("--namespace", "fd-prod"),
    context: val("--context", "cheap"),
  });
  if (!deployed) {
    console.error("judge   ⊘ 从 pod 读不到 /app/BUILD-INFO.json 的 baseCommit（pod 名/命名空间/上下文写错，或没有 exec 权限）\n         判不出不是通过。");
    process.exit(2);
  }
  console.log(`  在役基线 ${deployed.slice(0, 9)}   ← deploy/${val("--deployed-from-pod")} 的 /app/BUILD-INFO.json`);
}
if (!deployed) {
  const tagSha = val("--deployed-sha");
  if (tagSha) deployed = resolve(tagSha);
}
if (deployed) deployed = resolve(deployed) ?? deployed;

let candidate = val("--candidate");
if (!candidate && flag("--candidate-mirror")) {
  const mirrorHead = git("rev-parse", "--verify", "--quiet", "mirror/main^{commit}");
  if (mirrorHead) candidate = baseCommitOf("mirror/main") ?? mirrorHead;
}
if (candidate) candidate = resolve(candidate) ?? candidate;

const r = check(deployed, candidate);
if (r.code === 0) {
  console.log(`lineage  ✓ ${r.why}`);
} else if (r.code === 1) {
  console.error(`✗ ${r.why}\n`);
  if (r.losses?.length) {
    console.error("  在役有、候选没有（shipped trees 内）：");
    for (const l of r.losses.slice(0, 20)) console.error(`    ${l}`);
    if (r.losses.length > 20) console.error(`    …另 ${r.losses.length - 20} 条`);
  }
  console.error(
    "\n  这片滚上去会把上面这些从线上抹掉，而三道既有闸都不会红（它们只比「两侧是否一致」与「是否落后 main」）。\n" +
    "  处置：让候选包含在役基线（merge 而不是重切），或确认这些工作确实该退（写清理由再滚）。",
  );
} else {
  console.error(`judge   ⊘ 判不出：${r.why}（判不出不是通过）`);
}
process.exit(r.code);
