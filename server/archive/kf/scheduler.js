// ── kf 定时拉取 ─────────────────────────────────────────────────────────────
//
// 定时拉取在这里是**产品需求，不是运维优化**：kf 只保留 3 天消息，一天没人跑
// 就开始出缺口，三天没人跑就是永久丢失。所以这一层要能自己跑起来，并且坏了要看得见。
//
// 四条纪律（每条都对应一类真实故障）：
//
// 1. **串联定时器，不用 setInterval**。一次拉取慢于间隔时，setInterval 会叠加，
//    多个周期同时跑同一段游标——表现为重复拉取、配额被吃光、日志时间戳交错。
//    这里改成"上一次跑完才排下一次"。
// 2. **同一时刻只允许一个周期在跑**。外部也可能调 runOnce（调试/补拉），
//    用 `inFlight` 挡住，返回 skipped 而不是排队堆积。
// 3. **每个周期重建客户端**。令牌缓存在客户端里；重建才能让轮换后的 secret 生效，
//    而不必重启进程。这是"改对了却还是旧值"的常见来源。
// 4. **失败要留状态，不只是打日志**。日志会被刷掉；`status()` 是巡检面能读的。

import { createKfClient } from "./api.js";
import { runKfPullCycle } from "./ingest.js";
import { pullKfMedia, fileWriter } from "./media.js";
import { ensureKfSchema } from "./store.js";

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_INITIAL_DELAY_MS = 20 * 1000;

/** 从环境变量读配置。每个周期读一次，轮换 secret 不需要重启。 */
export function kfConfigFromEnv(env = process.env) {
  return {
    corpId: env.KF_CORPID || "",
    secret: env.KF_SECRET || "",
    openKfId: env.KF_OPEN_KFID || "",
    mediaDir: env.KF_MEDIA_DIR || "",
    enabled: env.KF_SYNC_ENABLED === "1",
  };
}

/**
 * @param {object} opts
 * @param {object} opts.db
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.initialDelayMs]
 * @param {() => object} [opts.readConfig]
 * @param {(cfg: object) => object} [opts.makeClient]  测试注入
 * @param {(msg: string) => void} [opts.log]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @param {() => number} [opts.now]
 */
export function createKfSyncScheduler({
  db,
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  readConfig = kfConfigFromEnv,
  makeClient = (cfg) => createKfClient({ corpId: cfg.corpId, secret: cfg.secret }),
  log = (msg) => console.log(msg),
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
} = {}) {
  if (!db) throw new Error("createKfSyncScheduler 需要 db");

  const state = {
    running: false,
    inFlight: false,
    cycles: 0,
    skippedInFlight: 0,
    consecutiveFailures: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastReport: null,
    lastError: null,
    nextRunAt: null,
    disabledReason: null,
  };
  let timer = null;

  function status() {
    return { ...state, intervalMs };
  }

  /**
   * 跑一次。返回 `{ran:true, report}` 或 `{ran:false, reason}`。
   * 配置不全时返回 `disabled` 而不是抛错——未配置的 cell 不该在日志里天天报警。
   */
  async function runOnce() {
    if (state.inFlight) {
      state.skippedInFlight += 1;
      return { ran: false, reason: "in-flight" };
    }
    const cfg = readConfig();
    const missing = ["corpId", "secret"].filter((k) => !cfg[k]);
    if (missing.length) {
      state.disabledReason = `缺少配置：${missing.join(", ")}`;
      return { ran: false, reason: "unconfigured", missing };
    }
    state.disabledReason = null;
    state.inFlight = true;
    state.lastStartedAt = now();
    try {
      ensureKfSchema(db);
      // 每个周期新建客户端：令牌缓存与 secret 一起轮换
      const client = makeClient(cfg);
      const report = await runKfPullCycle({
        db,
        client,
        openKfId: cfg.openKfId,
        now: state.lastStartedAt,
      });

      let media = null;
      if (cfg.mediaDir) {
        media = await pullKfMedia(db, client, { writer: fileWriter(cfg.mediaDir), limit: 20 });
      }

      state.cycles += 1;
      state.lastReport = { ...report, media };

      // 「一条都没拉到且有错误」= 这一轮根本没成功，不能记成健康周期。
      // 只把错误塞进 report.errors 的话，consecutiveFailures 永远是 0，
      // 巡检面会说"一切正常"而通道其实早就断了——这正是要避免的假绿。
      const pullFailed = report.errors.length > 0 && report.pulled === 0;
      if (pullFailed) {
        state.consecutiveFailures += 1;
        state.lastError = `拉取失败：${JSON.stringify(report.errors[0])}`;
      } else {
        state.consecutiveFailures = 0;
        state.lastError = null;
      }

      log(
        `[kf-sync] pulled=${report.pulled} inserted=${report.inserted} ` +
          `errors=${report.errors.length} lag=${report.lag?.level || "?"}` +
          (media ? ` media_done=${media.done} media_failed=${media.failed}` : ""),
      );
      if (report.errors.length) {
        // 错误不吞：把第一条的原话打出来，否则巡检只看到计数
        log(`[kf-sync] error: ${JSON.stringify(report.errors[0])}`);
      }
      return { ran: true, report: state.lastReport };
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastError = `${err?.name || "Error"}: ${err?.message || String(err)}`;
      log(`[kf-sync] 周期失败（连续 ${state.consecutiveFailures} 次）：${state.lastError}`);
      return { ran: false, reason: "error", error: state.lastError };
    } finally {
      state.inFlight = false;
      state.lastFinishedAt = now();
    }
  }

  function schedule(delay) {
    if (!state.running) return;
    state.nextRunAt = now() + delay;
    timer = timers.setTimeout(async () => {
      timer = null;
      await runOnce();
      // 只有上一轮结束才排下一轮：慢周期不会叠加
      schedule(intervalMs);
    }, delay);
    // 不让定时器把进程吊住（测试与正常退出都受益）
    if (typeof timer?.unref === "function") timer.unref();
  }

  function start() {
    if (state.running) return status();
    state.running = true;
    log(`[kf-sync] 启动：初次 ${Math.round(initialDelayMs / 1000)}s 后，间隔 ${Math.round(intervalMs / 1000)}s`);
    schedule(initialDelayMs);
    return status();
  }

  function stop() {
    state.running = false;
    state.nextRunAt = null;
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    return status();
  }

  return { status, runOnce, start, stop };
}

/**
 * 由 server.js 调用：只有显式打开且配置齐全时才启动。
 *
 * `getDb` 是**惰性**的：未启用或未配置时，连数据库都不打开。
 * 否则每个 cell 启动都会在 data/ 下留一个空 kf.db——那是"没在用的通道"
 * 对磁盘和巡检面都留下的痕迹。
 */
export function maybeStartKfSyncJob({ db = null, getDb = null, env = process.env, log = console.log } = {}) {
  const cfg = kfConfigFromEnv(env);
  if (!cfg.enabled) {
    log("[kf-sync] 未启用（KF_SYNC_ENABLED!=1）。手动补拉：node server/archive/kf/cli.mjs sync");
    return null;
  }
  if (!cfg.corpId || !cfg.secret) {
    log("[kf-sync] 已启用但缺少 KF_CORPID / KF_SECRET，暂不启动");
    return null;
  }
  const handle = db || (getDb ? getDb() : null);
  if (!handle) {
    log("[kf-sync] 已启用但没有可用的数据库句柄，暂不启动");
    return null;
  }
  const scheduler = createKfSyncScheduler({ db: handle, log });
  scheduler.start();
  return scheduler;
}
