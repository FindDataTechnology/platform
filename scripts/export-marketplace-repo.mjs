#!/usr/bin/env node
// ── export-marketplace-repo — the WorkBuddy/CodeBuddy market channel ──────────
//
//   node scripts/export-marketplace-repo.mjs --db <packs.db> [--out <dir>]
//                                            [--push] [--remote <name>] [--dry-run]
//
// Why this exists: that client family's URL-typed marketplaces are catalog-only
// (the client fetches marketplace.json and a relative entry's plugin.json, but
// cannot recursively mirror plugin files over HTTP — stated in its own plugin
// marketplace docs). Its GitHub/Git-typed marketplaces are fully materialized.
// So the channel's deliverable is a REPOSITORY, not an endpoint: this script
// projects the current listing into one and (optionally) commits + pushes it.
//
// Last-good is the contract: everything is built and validated in a staging
// directory first; only a clean snapshot replaces the live tree. A failure
// leaves the previous snapshot byte-identical, so clients keep working.
//
// No credentials live in the output. The pack content is scanned for key-shaped
// strings and the export refuses rather than sanitizing (a match means a
// publish-gate bug upstream, not something to quietly strip). Push credentials
// come from the git remote's own configuration / environment — never from here.
//
//   --db      path to the facet registry SQLite file (required)
//   --out     repository working tree (default ./marketplace-repo)
//   --push    commit (only when content changed) and push to --remote
//   --remote  git remote name (default origin)
//   --dry-run build + validate + report, write nothing

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createPackRegistry } from "../gateway/packs.js";
import {
  MarketplaceRepoError,
  buildMarketplaceRepo,
  writeMarketplaceRepo,
} from "../facet/marketplace-repo.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const DB = opt("db");
const OUT = path.resolve(opt("out", "marketplace-repo"));
const PUSH = flag("push");
const REMOTE = opt("remote", "origin");
const DRY = flag("dry-run");

if (!DB) {
  console.error("用法：node scripts/export-marketplace-repo.mjs --db <packs.db> [--out <dir>] [--push] [--remote origin] [--dry-run]");
  process.exit(2);
}
if (!existsSync(DB)) {
  console.error(`✗ 找不到注册表文件：${DB}`);
  process.exit(2);
}

// Change detection is git's own answer, not a byte diff of our own: the
// working tree can hold untracked leftovers (a fresh repo with no commit yet
// has no HEAD to diff against), and `git status --porcelain` is the one
// authority on "is there anything to commit".
function git(cwd, argv, { allowFail = false } = {}) {
  try {
    return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${argv.join(" ")} 失败：${String(e.stderr || e.message).split("\n")[0]}`);
  }
}

const registry = createPackRegistry({ file: DB });

let built;
try {
  built = buildMarketplaceRepo(registry, { env: process.env });
} catch (e) {
  if (e instanceof MarketplaceRepoError) {
    console.error(`✗ 导出被拒（${e.code}）：${e.message}`);
    process.exit(1);
  }
  throw e;
}

const entries = built.manifest.plugins.length;
console.log(`收录 ${entries} 个功能集（口径与 Claude 端点同源）`);
if (entries === 0) console.log("  注意：清单为空——检查策展（category/featured）或 FACET_MARKETPLACE_PACK_IDS");

if (DRY) {
  // Validate through the same gate the writer uses, without touching disk.
  const { validateMarketplaceRepo } = await import("../facet/marketplace-repo.js");
  validateMarketplaceRepo(built);
  console.log("✓ 自检通过（--dry-run，未写盘）");
  process.exit(0);
}

// Stage → validate → swap. The staging directory lives next to the target so
// the final rename is same-filesystem (atomic) and a failure leaves OUT alone.
const parent = path.dirname(OUT);
mkdirSync(parent, { recursive: true });
const staging = mkdtempSync(path.join(parent, ".marketplace-repo-staging-"));

async function run() {
try {
  const stats = writeMarketplaceRepo(built, staging);

  // Swap: drop everything but .git, then move the staged tree in. Identical
  // bytes are written again harmlessly — git decides what changed, below.
  if (existsSync(OUT)) {
    for (const entry of readdirSync(OUT)) {
      if (entry === ".git") continue;
      rmSync(path.join(OUT, entry), { recursive: true, force: true });
    }
  } else {
    mkdirSync(OUT, { recursive: true });
  }
  for (const entry of readdirSync(staging)) {
    execFileSync("mv", [path.join(staging, entry), path.join(OUT, entry)]);
  }
  console.log(`✓ 已写出 ${stats.files} 个文件到 ${OUT}`);

  if (!existsSync(path.join(OUT, ".git"))) {
    if (PUSH) {
      console.error("✗ --push 需要目标目录已是 git 仓库（先 git init + 配好 remote）");
      process.exitCode = 1;
    } else {
      console.log("  （还不是 git 仓库；要发布请先 git init 并配置 remote）");
    }
    return;
  }

  const dirty = git(OUT, ["status", "--porcelain"]);
  if (!dirty) {
    console.log("✓ 内容无变化——不产生提交（客户端按 commit 判新鲜度）");
    // A repository with nothing to commit can still be BEHIND its remote (a
    // prior run committed without pushing). `git push` is a no-op when the
    // remote is already at HEAD, so asking costs nothing and fixes the case
    // that made --push silently do nothing on the first publish.
    if (PUSH) {
      git(OUT, ["push", REMOTE, "HEAD"]);
      console.log(`✓ 已推送到 ${REMOTE}（本次无新提交）`);
    }
    return;
  }

  git(OUT, ["add", "-A"]);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  git(OUT, ["commit", "-m", `[skip ci] marketplace snapshot ${stamp} — ${entries} packs`]);
  console.log(`✓ 已提交（${entries} 个功能集）`);

  if (!PUSH) {
    console.log("  （未 --push；本地提交已完成）");
    return;
  }
  git(OUT, ["push", REMOTE, "HEAD"]);
  console.log(`✓ 已推送到 ${REMOTE}`);
} catch (e) {
  console.error(`✗ 快照生成失败，已保留上一份（last-good）：${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
}

await run();
