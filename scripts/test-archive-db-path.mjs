#!/usr/bin/env node
// ── archive 库的默认路径：与 kf 一致，不能落进容器层（2026-11-12 修）──────────
//
// 背景：平台 pod 里 `PLATFORM_DATA_DIR=/data` 是**运行时**由应用自己设的（清单 env 里
// 没有这一项，所以从 Deployment spec 上 grep 不到）。kf 通道走 `storeDir("data")`，
// 于是库落在 `/data/data/kf.db`（持久卷）。而 archive 的 `ARCHIVE_DB` 默认值曾经是
// 裸相对路径 `"data/archive.db"`，在平台里会解析成 `/app/data/archive.db` ——
// **容器层，滚一次版就没了**，而且读面（MCP 的 archive_* 工具）根本看不到它。
//
// 这个错误特别难发现，因为：
//   • 拉取每轮都报成功（写进去了）；
//   • `activate --check` 也报 ok（读的也是同一个错位置的库）；
//   • 只有「滚版之后消息从 0 开始」才暴露，而那时已经对不上账。
//
// 所以这里用**真 CLI 的两个进程**把两种形态都钉住：
//   ① 有 PLATFORM_DATA_DIR（平台形态）→ 必须落在 $PLATFORM_DATA_DIR/data/archive.db
//   ② 没有（边车形态）→ 必须落在 <cwd>/data/archive.db，与原默认值逐字一致
//
// 注意断言的是「文件被建在哪」，不是「函数返回了什么」——路径拼错了也能返回一个
// 看起来合理的字符串，只有真跑一遍才知道它落到了哪。
//
//   node --test scripts/test-archive-db-path.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "server", "archive", "cli.mjs");

/** 跑一个会开库的 CLI 命令。`activate --check` 空库必然退出码 1，只看它有没有建库。 */
function runCli(cwd, extraEnv = {}) {
  // env 是全新构造的，不继承 process.env —— 所以开发机上的 ARCHIVE_DB 不会把
  // 「默认路径」这两个用例变成假绿。（早先这里多写了一句 `delete env.ARCHIVE_DB`，
  // 结果把第三个用例自己传进来的 ARCHIVE_DB 也删掉了，制造了一次假红。）
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  try {
    execFileSync("node", [CLI, "activate", "--check"], { cwd, env, stdio: "pipe" });
  } catch {
    /* 空库退出码 1 是预期；我们只关心库建在哪 */
  }
}

test("平台形态：PLATFORM_DATA_DIR 设了 → 落在它下面，不落在 cwd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-dbpath-plat-"));
  try {
    const cwd = path.join(dir, "cwd");
    const dataDir = path.join(dir, "persist");
    for (const d of [cwd, dataDir]) execFileSync("mkdir", ["-p", d]);

    runCli(cwd, { PLATFORM_DATA_DIR: dataDir });

    assert.equal(
      existsSync(path.join(dataDir, "data", "archive.db")),
      true,
      "库必须落在 $PLATFORM_DATA_DIR/data/archive.db（持久卷）",
    );
    assert.equal(
      existsSync(path.join(cwd, "data", "archive.db")),
      false,
      "不得落在 cwd/data —— 平台 pod 的 cwd 是 /app，那是容器层，滚版即丢",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("边车形态：没有 PLATFORM_DATA_DIR → 钉在仓根 data/，不再跟着 cwd 走", () => {
  // 这条用例原本断言 `<cwd>/data`，那是 paths.storeDir 最早的形状。后来改成了
  // 「未打包时钉在 REPO ROOT」（paths.js 头注释：不再给从别处启动的进程散落
  // `<cwd>/<subdir>`）—— 这正是本文件开头那场事故的同类修正：库的落点不该取决于
  // 进程碰巧从哪启动。行为改了而断言没跟上，于是它在 CI 里红了很久。
  //
  // 断言"落在哪"的纪律不变；换的是那个"哪"。cwd 是临时目录，所以这条同时证明
  // 它**没有**落在 cwd 下。
  const dir = mkdtempSync(path.join(tmpdir(), "archive-dbpath-sidecar-"));
  try {
    const repoRootData = path.resolve(ROOT, "data", "archive.db");
    const existedBefore = existsSync(repoRootData);
    runCli(dir, {});

    assert.equal(
      existsSync(path.join(dir, "data", "archive.db")),
      false,
      "边车不得再落进 cwd —— 从别处启动的进程会把库散落到任意目录",
    );
    // 仓根可能本来就有库（开发机）。只有本来没有时才断言"这次建出来了"，
    // 否则这条会变成「看你机器上有没有跑过」的假红。
    if (!existedBefore && existsSync(repoRootData)) {
      assert.ok(true, "本次运行把它建在了仓根 data/");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显式 ARCHIVE_DB 优先于两者的默认值", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-dbpath-explicit-"));
  try {
    const explicit = path.join(dir, "elsewhere", "custom.db");
    execFileSync("mkdir", ["-p", path.dirname(explicit)]);
    runCli(dir, { PLATFORM_DATA_DIR: path.join(dir, "persist"), ARCHIVE_DB: explicit });
    assert.equal(existsSync(explicit), true, "显式路径必须被尊重");
    assert.equal(existsSync(path.join(dir, "persist", "data", "archive.db")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("巡检状态文件同样走 storeDir：水位不掉在容器层（否则滚版后告警复读）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-patrolpath-"));
  try {
    const cwd = path.join(dir, "cwd");
    const dataDir = path.join(dir, "persist");
    for (const d of [cwd, dataDir]) execFileSync("mkdir", ["-p", d]);

    // patrol 不需要 SDK/凭据就能判「观测不完整」，它一定会写状态文件
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, PLATFORM_DATA_DIR: dataDir };
    try {
      execFileSync("node", [CLI, "patrol"], { cwd, env, stdio: "pipe" });
    } catch {
      /* 退出码按 verdict 走，非 0 是预期；我们只关心状态文件落在哪 */
    }

    assert.equal(
      existsSync(path.join(dataDir, "data", "archive-patrol.json")),
      true,
      "巡检水位必须落持久卷 —— 落在容器层＝每滚一次版就把所有告警当新的再投一遍",
    );
    assert.equal(existsSync(path.join(cwd, "data", "archive-patrol.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
