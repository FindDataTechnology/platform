#!/usr/bin/env node
// ── 微信客服 sidecar 入口 ───────────────────────────────────────────────────
//
// 这是「私有化 sidecar」的产品形态：**一个进程、一个库、不启动平台**。
// 客户只把它跑在自己的服务器上，数据落在自己盘里；不需要装整套平台，
// 也不需要给平台开任何入站端口。
//
//   KF_SYNC_ENABLED=1 KF_CORPID=ww... KF_SECRET=... node server/archive/kf/sidecar.mjs
//   node server/archive/kf/sidecar.mjs --once     # 只拉一轮就退出（容器 init / 巡检用）
//
// 三条纪律：
//   1. **配置不全就退出，不空转**。缺 corpid/secret 的进程只会天天刷日志。
//   2. **不建无用的库**。配置不全时不碰数据库，避免留下空 kf.db。
//   3. **收到 SIGTERM 先停定时器**。容器重启不该留下两个周期抢同一个游标。

import { createKfSyncScheduler, kfConfigFromEnv, DEFAULT_INTERVAL_MS } from "./scheduler.js";
import { getKfDatabase } from "./db.js";

const once = process.argv.includes("--once");
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const cfg = kfConfigFromEnv();
if (!cfg.enabled) {
  log("[kf-sidecar] 未启用（KF_SYNC_ENABLED!=1），退出");
  process.exit(2);
}
const missing = ["corpId", "secret"].filter((k) => !cfg[k]);
if (missing.length) {
  log(`[kf-sidecar] 缺少配置：${missing.join(", ")}，退出`);
  process.exit(2);
}

const db = getKfDatabase();
const scheduler = createKfSyncScheduler({ db, log });

if (once) {
  const out = await scheduler.runOnce();
  if (!out.ran) log(`[kf-sidecar] 单轮未执行：${out.reason}`);
  else {
    const r = out.report;
    log(
      `[kf-sidecar] 单轮完成 pulled=${r.pulled} inserted=${r.inserted} errors=${r.errors.length} ` +
        `kfid=${r.openKfId || "?"}`,
    );
    for (const e of r.errors) log(`[kf-sidecar] error: ${JSON.stringify(e)}`);
  }
  const failed = !out.ran || (out.report?.errors?.length > 0 && out.report?.pulled === 0);
  process.exit(failed ? 1 : 0);
}

scheduler.start();
log(`[kf-sidecar] 已启动，间隔 ${Math.round(DEFAULT_INTERVAL_MS / 1000)}s，库=${process.env.KF_DB || "默认"}`);

// 心跳：让巡检面在外面只能看到容器时也有脉搏，而不是"没日志=没在跑"。
//
// ⚠ 这个 interval **故意不 unref**。调度器自己的定时器是 unref 的（在平台里由
// HTTP server 撑着事件循环，那里 unref 才对）；独立 sidecar 里没有别的东西撑着，
// 若这里也 unref，进程启动后会立刻以 0 退出，容器表现为反复 Restarting。
const heartbeat = setInterval(() => {
  const st = scheduler.status();
  log(
    `[kf-sidecar] 心跳 cycles=${st.cycles} 连续失败=${st.consecutiveFailures} ` +
      `最近拉取=${st.lastReport?.pulled ?? "—"} 错误=${st.lastError ? "有" : "无"}`,
  );
}, 10 * 60 * 1000);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`[kf-sidecar] 收到 ${sig}，停止定时器后退出`);
    clearInterval(heartbeat);
    scheduler.stop();
    process.exit(0);
  });
}
