#!/usr/bin/env node
// 把「镜像 tag」翻译成 lineage 闸能吃的候选基线，然后原样交给它判。
//
// 为什么单独有一个文件（而不再写一套判据）：
// 出片/升清单时手里只有一个 **镜像 tag**（`sha-bb912d4`），而 `check-snapshot-base-lineage.mjs`
// 收的是**本仓提交**——镜像 tag 来自快照仓，本仓根本没有那个对象。这个文件只做这一件翻译：
// tag → mirror 仓该提交 → 该提交树里 `BUILD-INFO.json` 的 `baseCommit`。
// 判据（祖先关系、丢失提交清单、0/1/2 三态）一律由那道闸出，**不在这里复制一份**。
//
// 在役基线默认从跑着的 pod 现取（`--deployed-from-pod platform`），因为它一天能变三四次：
// 2026-11-14 实测 `d27299665 → 08c420927 → 85715e6fa`，上午验过的分支 40 分钟后就落后了。
//
// 用：
//   node scripts/check-deploy-lineage.mjs --tag sha-bb912d4          # 升清单前跑这个
//   node scripts/check-deploy-lineage.mjs --tag sha-f01b8b8          # 事故片 → 红
//   node scripts/check-deploy-lineage.mjs --candidate-base <sha>     # 已有基线时跳过 mirror 查询
//   node scripts/check-deploy-lineage.mjs --deployed-base <sha>      # 不连集群（离线复核）
//
// Exit: 0 前进 ✓ / 1 会抹掉在役工作 / 2 判不出（判不出不是通过）

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "check-snapshot-base-lineage.mjs");
const MIRROR_REPO = "FindDataTechnology/platform";
const args = process.argv.slice(2);
const val = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

function run(cmd, argv) {
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 镜像 tag 的约定见出片链：tag = `sha-<mirror 提交短 sha>`。短 sha 由 GitHub API 展开。
function candidateBaseFromTag(tag) {
  const m = /^sha-([0-9a-f]{7,40})$/.exec(tag ?? "");
  if (!m) {
    console.error(`judge   ⊘ 看不懂的 tag：${tag ?? "(未给)"} —— 期望 sha-<短 sha>（镜像 tag 就是 mirror 提交）`);
    return null;
  }
  try {
    const raw = run("gh", [
      "api",
      `repos/${MIRROR_REPO}/contents/BUILD-INFO.json?ref=${m[1]}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    return JSON.parse(raw).baseCommit ?? null;
  } catch (e) {
    console.error(`judge   ⊘ 从 mirror 仓读不到 ${m[1]} 的 BUILD-INFO.json（${String(e?.message || e).split("\n")[0]}）`);
    return null;
  }
}

const candidateBase = val("--candidate-base") ?? candidateBaseFromTag(val("--tag"));
if (!candidateBase) {
  // 两种到达这里的形态，文案必须分开：一个字都不给是用法错，给了 tag 却读不到是
  // 「判不出」——混成一句会让人以为是参数没写对，而真相是 mirror 那边取不到。
  if (!val("--tag") && !val("--candidate-base")) {
    console.error("judge   ⊘ 判不出：需要 --tag sha-xxxx 或 --candidate-base <sha>。\n         判不出不是通过。");
  } else {
    console.error("judge   ⊘ 判不出：候选基线取不到（见上面那行原因）。滚之前补齐，别把它读成「没问题」。");
  }
  process.exit(2);
}

// 在役基线：显式给了就用；否则交给闸自己去 pod 现取（它已经会，且取不到会退 2）。
const deployedBase = val("--deployed-base");
const gateArgs = [GATE, "--candidate", candidateBase];
if (deployedBase) gateArgs.push("--deployed", deployedBase);
else gateArgs.push("--deployed-from-pod", val("--deploy", "platform"));
if (val("--namespace")) gateArgs.push("--namespace", val("--namespace"));
if (val("--context")) gateArgs.push("--context", val("--context"));

console.log(`  候选基线 ${candidateBase.slice(0, 9)}   ← mirror ${val("--tag") ?? "(直接给的基线)"}`);
try {
  execFileSync(process.execPath, gateArgs, { stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 2);
}
