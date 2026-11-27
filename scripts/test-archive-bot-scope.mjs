#!/usr/bin/env node
// ── 存档开关不得改变 bot 投递范围（任务 5.1）────────────────────────────────
//
// 规格里写的是：`bot 回调的投递范围 SHALL 与启用前完全一致`。
// 「我看过代码，它不碰 archive」不算验证——那是此刻的观察，不是守卫。
//
// 这里的做法是**前后对照**：把同一套真实的群消息投递用例（webhook → 校验 →
// 解析 → 守卫 → 回合 → 回复，走完整 bots 模块）在两个环境下各跑一遍：
//   A. 存档未启用（基线）
//   B. 存档启用（ARCHIVE_ENABLED=1 + 凭据齐全）
// 断言两次的用例数与通过数完全相同，且都退出 0。
//
// 为什么这条能抓住真问题：一旦有人在 bots 车道上加"存档开着就多投一点"的分支，
// B 的用例结果就会偏离 A——哪怕只是多出一个回合。
//
//   node --test scripts/test-archive-bot-scope.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PIPELINE = path.join(HERE, "test-wecom-bot-pipeline.mjs");

/** 存档开启时的一组自洽配置（不需要真的连得上，只要"看起来已启用"）。 */
const ARCHIVE_ON = {
  ARCHIVE_ENABLED: "1",
  ARCHIVE_CORPID: "ww-scope-test",
  ARCHIVE_SECRET: "S".repeat(40),
  ARCHIVE_SEAT_SCOPE: "member-a,member-b",
  ARCHIVE_EGRESS_IP: "203.0.113.9",
  ARCHIVE_PRIVATE_KEY: "/nonexistent/private.key",
  ARCHIVE_SDK_PATH: "/nonexistent/libWeWorkFinanceSdk_C.so",
};

function runPipeline(extraEnv) {
  const res = spawnSync(process.execPath, ["--test", "--test-concurrency=1", PIPELINE], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const num = (label) => {
    const m = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(out);
    return m ? Number(m[1]) : NaN;
  };
  return { status: res.status, pass: num("pass"), fail: num("fail"), out };
}

const baseline = runPipeline({});
const withArchive = runPipeline(ARCHIVE_ON);

test("基线：存档未启用时，群消息投递用例全部通过", () => {
  assert.equal(baseline.status, 0, `基线应退出 0：\n${baseline.out.slice(-2500)}`);
  assert.ok(baseline.pass >= 5, `基线用例数异常：pass=${baseline.pass}`);
  assert.equal(baseline.fail, 0);
});

test("存档启用后：群消息投递用例的数量与结果完全不变", () => {
  assert.equal(
    withArchive.status,
    0,
    `存档启用不应让投递用例变红：\n${withArchive.out.slice(-2500)}`,
  );
  assert.equal(
    withArchive.pass,
    baseline.pass,
    `用例数变了（基线 ${baseline.pass}，启用后 ${withArchive.pass}）：投递范围可能被扩了`,
  );
  assert.equal(withArchive.fail, 0);
});

// 这一条守的是"结构性独立"：bot 车道连 import 都不该碰到存档模块。
// 行为对照能抓住"多投"；这条能抓住"迟早会多投"的那类耦合。
test("bot 车道不 import 存档模块（没有共享可变状态的入口）", () => {
  const targets = [path.join(ROOT, "server", "bots.js")];
  const botDir = path.join(ROOT, "server", "bots");
  for (const f of readdirSync(botDir)) {
    if (f.endsWith(".js")) targets.push(path.join(botDir, f));
  }
  assert.ok(targets.length > 1, "应找到 bots 模块文件");
  for (const f of targets) {
    const src = readFileSync(f, "utf8");
    const hits = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)]
      .map((m) => m[1])
      .filter((spec) => /archive/.test(spec));
    assert.equal(
      hits.length,
      0,
      `${path.relative(ROOT, f)} 引入了存档模块：${hits.join(", ")}——投递范围会开始依赖存档状态`,
    );
  }
});
