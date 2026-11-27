#!/usr/bin/env node
// ── kf sidecar 入口 ─────────────────────────────────────────────────────────
//
// 这组测试守的是一件在单测里看不见、在容器里却致命的事：**进程要活着**。
//
// 真实故障（2026-11-12 部署当天）：调度器与心跳两个定时器都 unref，事件循环
// 里没有任何 ref 住的句柄，进程启动后立刻以 0 退出。容器表现为
// `Restarting (0)`——`docker ps` 一闪而过、日志却打印了「已启动」，极易被当成
// 起成功了。平台里不会犯这个错，因为 HTTP server 撑着事件循环。
//
//   node --test scripts/test-kf-sidecar.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "server", "archive", "kf", "sidecar.mjs");

function start(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "kf-sidecar-"));
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, KF_DB: path.join(dir, "kf.db"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += String(d);
  });
  child.stderr.on("data", (d) => {
    out += String(d);
  });
  return {
    child,
    output: () => out,
    cleanup: () => {
      try {
        child.kill("SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function exited(child, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

test("未启用：立即退出且退出码 2（不是静默空转）", async () => {
  const h = start({});
  const r = await exited(h.child, 5000);
  h.cleanup();
  assert.equal(r?.code, 2, `未启用应以 2 退出，实际 ${JSON.stringify(r)}\n${h.output()}`);
  assert.ok(h.output().includes("未启用"), h.output());
});

test("缺凭据：立即退出且退出码 2，且不建库", async () => {
  const h = start({ KF_SYNC_ENABLED: "1", KF_CORPID: "ww-x" });
  const r = await exited(h.child, 5000);
  const out = h.output();
  h.cleanup();
  assert.equal(r?.code, 2, `缺 secret 应以 2 退出，实际 ${JSON.stringify(r)}\n${out}`);
  assert.ok(out.includes("缺少配置"), out);
});

// 这条是回归守卫：进程必须一直活着，而不是"打印了已启动就退出"。
test("正常配置：启动后保持存活（不会被 unref 的空事件循环立刻退出）", async () => {
  const h = start({
    KF_SYNC_ENABLED: "1",
    KF_CORPID: "ww-dummy",
    KF_SECRET: "S".repeat(40),
  });
  const early = await exited(h.child, 1500);
  const out = h.output();
  assert.equal(
    early,
    null,
    `进程在 1.5s 内退出了（code=${early?.code}）＝容器会反复 Restarting。输出：\n${out}`,
  );
  assert.ok(out.includes("已启动"), `应打印启动行：\n${out}`);

  // SIGTERM 要能干净收尾（容器 stop 走的就是这条）
  h.child.kill("SIGTERM");
  const r = await exited(h.child, 5000);
  h.cleanup();
  assert.equal(r?.code, 0, `SIGTERM 后应正常退出，实际 ${JSON.stringify(r)}\n${out}`);
});
