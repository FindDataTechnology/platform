#!/usr/bin/env node
// ── 存档通道命令行（交付侧）──────────────────────────────────────────────────
//
//   node server/archive/cli.mjs activate --check     五项激活清单 + 一行结论（进程退出码即判据）
//   node server/archive/cli.mjs pull                 拉一轮（定时入口；同意状态走官方接口）
//   node server/archive/cli.mjs consent-event        stdin 进一条 msg_audit_approved 回调（明文 XML）
//   node server/archive/cli.mjs integrity            库自检（PRAGMA integrity_check）
//   node server/archive/cli.mjs export --dir <路径>  导出为 JSONL（客户随时能拿走）
//
// 配置全走环境变量，secret 与私钥都不进命令行参数（参数会进 ps 与 shell history）：
//   ARCHIVE_DB            默认 storeDir("data")/archive.db（平台里= /data/data，与 kf 一致）
//   ARCHIVE_SDK_PATH      libWeWorkFinanceSdk_C 的挂载路径（/opt/wecom-sdk/...）
//   ARCHIVE_CORPID / ARCHIVE_SECRET
//   ARCHIVE_PRIVATE_KEY   私钥文件路径（只读挂载）
//   ARCHIVE_EGRESS_IP     声明出口 IP（实测值与它比对）
//   ARCHIVE_SEAT_SCOPE    逗号分隔的席位 userid 列表
//   ARCHIVE_ENABLED=1     表示企业侧已开通会话存档
//
// `activate --check` 的退出码是给部署脚本用的：非 0 表示"不要启动拉取循环"。

import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureArchiveSchema, coverageReport } from "./store.js";
import { runDoctor, doctorLine } from "./doctor.js";
import { exportArchive, integrityCheck } from "./export.js";
import { buildAcceptanceReport, acceptanceLine } from "./acceptance.js";
import { createStdioDriver } from "./sdk.js";
import { readPatrolState, writePatrolState, runPatrol } from "./patrol.js";
import { createAgreeClient, createConsentResolver } from "./consent-api.js";
import { applyApprovalEvent } from "./consent-event.js";
import { createConsentCache } from "./consent.js";
import { runPullCycle } from "./ingest.js";
import { storeDir } from "../../paths.js";

/**
 * 投递通道：把告警交给外部命令，不在本仓库里长一套邮件/短信客户端。
 *
 * 约定：命令从 `ARCHIVE_ALERT_CMD` 读，JSON 走 stdin。收不到（未配置）就返回
 * null —— 巡检照跑、判定照样输出，只是不投递。这比"没配置就整个巡检不跑"
 * 好：监视器至少还能靠退出码发现异常。
 */
function makeDeliver() {
  const cmd = String(process.env.ARCHIVE_ALERT_CMD || "").trim();
  if (!cmd) return null;
  return async (payload) => {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(cmd, {
      shell: true,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 30_000,
    });
    if (res.status !== 0) {
      // 投递失败也要说清楚，否则"告警没响"会被当成"没有告警"
      process.stderr.write(
        `[archive-patrol] 告警投递失败（exit=${res.status}）：${(res.stderr || "").slice(0, 300)}\n`,
      );
      return false;
    }
    return true;
  };
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

/**
 * 库文件路径。
 *
 * 默认值必须跟 kf 通道一致地走 `storeDir("data")`，不能写死 `"data/archive.db"`：
 * 平台 pod 里 `PLATFORM_DATA_DIR=/data`（运行时由应用自己设，不在清单 env 里），
 * 于是 kf 落在 `/data/data/kf.db`（持久卷），而裸相对路径会解析到 `/app/data/archive.db`
 * ——容器层，**滚一次版就没了**，而且读面（MCP archive_*）看不到它。
 *
 * 边车（客户自己机器）上没有 `PLATFORM_DATA_DIR`，`storeDir("data")` 退化成
 * `resolve("data")`，与原默认值逐字相同，故对边车形态零变化。
 */
function archiveDbPath() {
  return process.env.ARCHIVE_DB || path.join(storeDir("data"), "archive.db");
}

/**
 * 巡检状态文件（差量投递的水位）。
 *
 * 与库同一个理由走 `storeDir("data")`：这是**跨轮次**才起作用的状态，落在容器层
 * 就等于每滚一次版水位归零，下一轮把所有告警当"新出现"再投一遍——用户会收到已经
 * 通知过的告警复读，而报告里没有任何异常。文件名用 `archive-patrol.json` 与库同卷，
 * 导出/备份时一起带走。
 */
function patrolStatePath() {
  return process.env.ARCHIVE_PATROL_STATE || path.join(storeDir("data"), "archive-patrol.json");
}

function openDb() {
  const file = archiveDbPath();
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  ensureArchiveSchema(db);
  return db;
}

function configFromEnv() {
  const scope = String(process.env.ARCHIVE_SEAT_SCOPE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    archiveEnabled: process.env.ARCHIVE_ENABLED === "1",
    privateKeyPath: process.env.ARCHIVE_PRIVATE_KEY || "",
    secret: process.env.ARCHIVE_SECRET || "",
    expectedEgressIp: process.env.ARCHIVE_EGRESS_IP || "",
    seatScope: scope,
    corpId: process.env.ARCHIVE_CORPID || "",
    sdkPath: process.env.ARCHIVE_SDK_PATH || "",
    expectedSdkSha256: process.env.ARCHIVE_SDK_SHA256 || "",
  };
}

/** 只有 SDK 路径存在时才建 driver：没挂 SDK 应该表现为"未配置"，不是崩溃。 */
function maybeDriver() {
  const sdkPath = process.env.ARCHIVE_SDK_PATH || "";
  if (!sdkPath) return null;
  return createStdioDriver({
    command: process.env.ARCHIVE_HELPER_PYTHON || "python3",
    args: [path.resolve(import.meta.dirname, "helper", "archive_helper.py")],
    // spawnImpl 必须显式传：driver 刻意不在模块顶层 import child_process，
    // 少了这一行会抛 "缺少 spawn 实现"——而它只在**配了 SDK 路径**的分支才走到，
    // 于是"没挂 SDK"的演练全绿、"挂了 SDK"的真机直接崩栈。演练第一关就是靠这个炸出来的。
    spawnImpl: spawn,
    // 凭据从两处进来：env 交给 helper 自己用，secrets 交给 driver 擦异常正文。
    // 少传 secrets 不会报错——但 helper 一旦在报错里回显请求内容，secret 就会
    // 出现在日志、告警和用户截图里。所以这两处必须一起给。
    secrets: [process.env.ARCHIVE_SECRET || ""],
    env: {
      ...process.env,
      ARCHIVE_SDK_PATH: sdkPath,
      ARCHIVE_CORPID: process.env.ARCHIVE_CORPID || "",
      ARCHIVE_SECRET: process.env.ARCHIVE_SECRET || "",
      ARCHIVE_EGRESS_IP: process.env.ARCHIVE_EGRESS_IP || "",
    },
  });
}

const cmd = process.argv[2] || "activate";

if (cmd === "activate") {
  const check = process.argv.includes("--check");
  const db = openDb();
  const driver = maybeDriver();
  const result = await runDoctor({ db, driver, config: configFromEnv() });
  if (driver) driver.close?.();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`${doctorLine(result)}\n`);
  if (!check) process.exit(0);
  // --check 的语义：非 0 就是"别启动"。缺项清单在 blockers 里，不在退出码里。
  process.exit(result.ok ? 0 : 1);
} else if (cmd === "integrity") {
  const db = openDb();
  const verdict = integrityCheck(db);
  process.stdout.write(`${JSON.stringify({ ok: verdict === "ok", integrity: verdict })}\n`);
  process.exit(verdict === "ok" ? 0 : 1);
} else if (cmd === "export") {
  const dir = arg("dir");
  if (!dir) {
    process.stderr.write("用法：export --dir <目录>\n");
    process.exit(2);
  }
  const db = openDb();
  const manifest = exportArchive(db, { dir: path.resolve(dir) });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(manifest.integrity === "ok" ? 0 : 1);
} else if (cmd === "acceptance") {
  // 交付验收：四个实数 + 判定。--out 写文件（给客户留存），否则打到 stdout。
  const db = openDb();
  const purchased = process.env.ARCHIVE_SEATS_PURCHASED;
  const effective = process.env.ARCHIVE_SEATS_EFFECTIVE;
  const report = buildAcceptanceReport(db, {
    purchasedSeats: purchased === undefined || purchased === "" ? null : Number(purchased),
    effectiveSeats: effective === undefined || effective === "" ? null : Number(effective),
    seriesDays: Number(arg("days", 14)),
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const out = arg("out");
  if (out) {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(path.resolve(out), body, "utf8");
  }
  process.stdout.write(body);
  process.stderr.write(`${acceptanceLine(report)}\n`);
  process.exit(report.verdict.ok ? 0 : 1);
} else if (cmd === "deactivate") {
  /**
   * 停用：只出凭据，不动数据。
   *
   * 这里**故意没有任何删除逻辑**。停用是一个客户可能随时反悔的动作，
   * 而删数据不可逆；真要销毁应当是一次独立、带确认、留记录的动作，
   * 不该藏在"停用"里。这段代码存在的意义就是让这句话可被审计：
   * 它打出的清单就是客户手里的收据。
   */
  const db = openDb();
  const file = archiveDbPath();
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  const coverage = coverageReport(db);
  const receipt = {
    action: "deactivate",
    deletesAnything: false,
    note: "停用不删除任何数据。库文件、附件与导出目录原样保留，可直接用 sqlite3 打开。",
    dbFile: path.resolve(file),
    dbBytes: size,
    integrity: integrityCheck(db),
    counts: {
      conversations: coverage.conversations.total,
      messages: coverage.messages.total,
      media: coverage.media.total,
    },
    takeAway: `node server/archive/cli.mjs export --dir <目录>`,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(receipt.integrity === "ok" ? 0 : 1);
} else if (cmd === "patrol") {
  // 巡检面：给外部监视器（cron + 告警脚本）一个稳定入口。
  //
  // 退出码就是判定，便于任何监控直接用：
  //   0 = ok（含首次无数据但观测新鲜）
  //   1 = warn
  //   2 = lost（缺口不可补偿）
  //   3 = degraded（观测不完整，不敢下结论——不是"正常"）
  //
  // --deliver 时才真的投递，且只投「新出现」的告警码（差量）。状态默认落在
  // storeDir("data")/archive-patrol.json，跨轮次才能做差量。
  const db = openDb();
  const statePath = patrolStatePath();
  const prev = readPatrolState(statePath);
  const deliver = process.argv.includes("--deliver") ? makeDeliver() : null;
  const out = await runPatrol({
    db,
    config: configFromEnv(),
    prev,
    deliver,
  });
  writePatrolState(statePath, out.state);
  process.stdout.write(`${JSON.stringify({ ...out, statePath }, null, 2)}\n`);
  const code = out.verdict.level === "ok" ? 0 : out.verdict.level === "lost" ? 2 : out.verdict.level === "degraded" ? 3 : 1;
  process.exit(code);
} else if (cmd === "pull") {
  /**
   * 拉一轮。这是 sidecar 的定时入口（cron / systemd timer），也是同意接口真正
   * 接上的地方（任务 3.1c）。
   *
   * 两个前置判断是刻意的、且都会**拒绝运行**而不是降级：
   *   - 没挂 SDK：拉不了；
   *   - 没有 corpId/secret：同意状态问不出来。此时若照常跑，`queryConsent` 全部返回
   *     unknown → 每条消息都因"未同意"被丢弃，而报告看起来只是"本轮 0 条入库"。
   *     这比不跑危险得多——它会把"凭据没配"伪装成"客户不同意"。
   */
  const cfg = configFromEnv();
  // 注意这里的键名：configFromEnv() 给的是 `corpId`（驼峰）。写成 `cfg.corpid` 会永远
  // 取到 undefined —— 守卫就变成"总是拒绝运行"，而报错文案看着完全合理。演练第一轮
  // 就是这么炸出来的。
  if (!cfg.corpId || !cfg.secret) {
    process.stderr.write("pull 需要 ARCHIVE_CORPID 与 ARCHIVE_SECRET：同意状态无法判定时不得拉取\n");
    process.exit(2);
  }
  const driver = maybeDriver();
  if (!driver) {
    process.stderr.write("pull 需要 ARCHIVE_SDK_PATH（SDK 未挂载）\n");
    process.exit(2);
  }

  const db = openDb();
  const cache = createConsentCache();
  const client = createAgreeClient({
    corpId: cfg.corpId,
    secret: cfg.secret,
    // 私有化部署里请求可能必须走客户自己的出口/代理，演练时也用它指向本地假接口。
    // 默认仍是官方域名——不配这个变量时行为完全不变。
    baseUrl: process.env.ARCHIVE_API_BASE || undefined,
  });
  const resolver = createConsentResolver({ client, db, cache, seatScope: cfg.seatScope });

  let report;
  try {
    report = await runPullCycle({
      db,
      driver,
      queryConsent: resolver.query,
      selfUserIds: cfg.seatScope,
    });
  } finally {
    driver.close?.();
  }

  const consent = resolver.stats();
  process.stdout.write(`${JSON.stringify({ ...report, consent }, null, 2)}\n`);
  // 判定：一个消息都没拉到且存在错误 = 失败。部分成功（拉到过但有错）不算失败，
  // 否则"一条坏附件"会让整条巡检天天红。
  const failed = report.errors.length > 0 && report.pulled === 0;
  process.exit(failed ? 1 : 0);
} else if (cmd === "consent-event") {
  /**
   * 接一条同意变更回调（`msg_audit_approved`），明文 XML 从 stdin 进来。
   *
   * 为什么走 stdin 而不是自己起 HTTP：这条通道部署在客户网络里，回调 URL 由
   * 企业微信打到客户自己的网关（已做过验签与解密的那一侧）。sidecar 不该再开一个
   * 对公网端口，也不该自己实现一遍验签——那只会多一处可错的地方。
   *
   * 退出码分三种，给网关用：
   *   0 = 已处理，或明确不是本通道的事件（其它事件共享同一个回调 URL，正常）
   *   1 = 是同意事件但读不懂（缺字段/状态未知）——网关应记一条可观测的失败
   *   2 = 配置/读取失败
   */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const xml = Buffer.concat(chunks).toString("utf8").trim();
  if (!xml) {
    process.stderr.write("用法：<回调 XML> | consent-event\n");
    process.exit(2);
  }

  const db = openDb();
  const cache = createConsentCache();
  const out = applyApprovalEvent({ db, cache, xml });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  if (out.handled) process.exit(0);
  if (out.reason === "not_approval_event") process.exit(0);
  process.exit(1);
} else {
  process.stderr.write(
    `未知命令：${cmd}\n用法：activate [--check] | pull | consent-event | integrity | patrol [--deliver] | export --dir <目录>\n`,
  );
  process.exit(2);
}
