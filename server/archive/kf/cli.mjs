#!/usr/bin/env node
// ── kf 通道命令行 ───────────────────────────────────────────────────────────
//
//   node server/archive/kf/cli.mjs doctor
//   node server/archive/kf/cli.mjs sync [--batches N] [--limit N]
//   node server/archive/kf/cli.mjs convs [--limit N]
//   node server/archive/kf/cli.mjs search <关键词>
//
// 配置全部来自环境变量，不进代码、不进仓库：
//   KF_CORPID / KF_SECRET / KF_OPEN_KFID   （secret 走凭据注入，不写在命令行里）
//   KF_DB                                    （默认 data/kf.db）
//   KF_CORP_VERIFIED=1                       （已认证企业，仅影响展示的上限口径）
//
// 为什么先做 CLI 而不是直接挂进服务：CLI 能在真账号上把四步（取票 / 拉取 / 入库 / 检索）
// 一次跑穿，且不需要改动服务启动路径。等服务侧接线时，它仍是最快的排障入口。

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createKfClient } from "./api.js";
import { runKfPullCycle } from "./ingest.js";
import { runKfDoctor, kfDoctorLine } from "./doctor.js";
import { replyWindow, sendReply, sendFileReply, lastCustomerMessageAt } from "./reply.js";
import { inspectUpload } from "./upload-guard.js";
import { kfInbox } from "./inbox.js";
import { pullKfMedia, fileWriter, runKfExtractionBackfill } from "./media.js";
import {
  ensureKfSchema,
  getKfAttachmentText,
  kfCoverageReport,
  kfExtractionCompletion,
  kfMediaCompletion,
  listKfMessages,
  searchKfMessages,
} from "./store.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

function openDb() {
  const file = process.env.KF_DB || "data/kf.db";
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  ensureKfSchema(db);
  return db;
}

function configFromEnv() {
  return {
    corpId: process.env.KF_CORPID || "",
    secret: process.env.KF_SECRET || "",
    openKfId: process.env.KF_OPEN_KFID || "",
  };
}

function makeClient(config) {
  return createKfClient({
    corpId: config.corpId,
    secret: config.secret,
    baseUrl: process.env.KF_BASE_URL || undefined,
  });
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

const cmd = process.argv[2] || "doctor";
const config = configFromEnv();

if (cmd === "doctor") {
  const db = openDb();
  // 配置不全时不发请求：这才是"未配置"的正确表现，而不是报一个网络错误。
  const client = config.corpId && config.secret ? makeClient(config) : null;
  const out = await runKfDoctor({
    db,
    client,
    config,
    corpVerified: process.env.KF_CORP_VERIFIED === "1",
  });
  print(out);
  process.stderr.write(`${kfDoctorLine(out)}\n`);
  process.exit(out.ok ? 0 : 1);
} else if (cmd === "sync") {
  // open_kfid 在官方接口里是必填；不填时由 resolveOpenKfId 取唯一账号，
  // 多个或零个都明确报错——绝不臆造"不填即拉全部"。
  const missing = ["corpId", "secret"].filter((k) => !config[k]);
  if (missing.length) {
    process.stderr.write(`缺少环境变量：${missing.join(", ")}（先跑 doctor 看口径）\n`);
    process.exit(2);
  }
  const db = openDb();
  const report = await runKfPullCycle({
    db,
    client: makeClient(config),
    openKfId: config.openKfId,
    maxBatches: Number(arg("batches", 5)),
    limit: Number(arg("limit", 1000)),
  });
  print({ report, coverage: kfCoverageReport(db) });
  process.exit(report.errors.length ? 1 : 0);
} else if (cmd === "convs") {
  const db = openDb();
  const limit = Number(arg("limit", 20));
  print(
    db
      .prepare("SELECT * FROM kf_conversation ORDER BY last_msg_at DESC LIMIT ?")
      .all(limit),
  );
} else if (cmd === "media") {
  // 附件补取：客户发来的报价单/执照照片只有 media_id，不带这一轮永远打不开。
  const db = openDb();
  if (!config.corpId || !config.secret) {
    process.stderr.write("缺少 KF_CORPID / KF_SECRET\n");
    process.exit(2);
  }
  const dir = arg("dir", process.env.KF_MEDIA_DIR || "data/kf-media");
  const report = await pullKfMedia(db, makeClient(config), {
    writer: fileWriter(dir),
    limit: Number(arg("limit", 20)),
  });
  print({ report, dir, completion: kfMediaCompletion(db), extraction: kfExtractionCompletion(db) });
  process.exit(report.failed > 0 ? 1 : 0);
} else if (cmd === "extract") {
  // 回填：文件已经在盘上、但升级前没抽过正文的附件。**不下载任何东西**。
  const db = openDb();
  const report = await runKfExtractionBackfill(db, { limit: Number(arg("limit", 50)) });
  print({ report, extraction: kfExtractionCompletion(db) });
  process.exit(report.failed > 0 ? 1 : 0);
} else if (cmd === "show") {
  // 看一条消息的附件正文。运维最常问的就是"客户到底发了个什么"。
  const db = openDb();
  const messageId = process.argv.slice(3).filter((a) => !a.startsWith("--"))[0] || "";
  if (!messageId) {
    process.stderr.write("用法：show <messageId> [--chars N]\n");
    process.exit(2);
  }
  const stored = getKfAttachmentText(db, messageId);
  if (!stored) {
    process.stderr.write(`这条消息没有已抽取的附件正文（消息 id：${messageId}）\n`);
    process.exit(1);
  }
  const maxChars = Number(arg("chars", 4000));
  const text = stored.text.length > maxChars ? stored.text.slice(0, maxChars) : stored.text;
  print({
    messageId,
    kind: stored.kind,
    chars: stored.chars,
    truncated: stored.truncated || text.length < stored.text.length,
    text,
  });
} else if (cmd === "inbox") {
  // 商机接住的核心视图：谁在等，谁已经等不到了。
  const db = openDb();
  print(kfInbox(db, { limit: Number(arg("limit", 50)) }));
} else if (cmd === "search") {
  const q = process.argv.slice(3).filter((a) => !a.startsWith("--"))[0] || "";
  const db = openDb();
  const rows = q ? searchKfMessages(db, { query: q }) : listKfMessages(db, { limit: 20 });
  print(rows);
} else if (cmd === "reply") {
  // 对外动作：默认只演算不发。要真发必须显式 --confirm。
  const rest = process.argv.slice(3);
  const confirm = rest.includes("--confirm");
  const filePath = arg("file", "");
  const words = rest.filter((a) => !a.startsWith("--"));
  const externalUserId = words.shift() || "";
  const content = words.join(" ");
  const kfid = arg("kfid", process.env.KF_OPEN_KFID || "");

  // 发文件：与正文互斥，走同一条窗口判定；演练时**不上传**（上传即产生对外副作用）。
  if (filePath) {
    if (!externalUserId) {
      process.stderr.write("用法：reply <external_userid> --file <路径> [--kfid kfX] [--root 目录] [--confirm]\n");
      process.exit(2);
    }
    const db = openDb();
    const allowedRoot = arg("root", process.env.KF_MEDIA_DIR || process.cwd());
    const inspected = inspectUpload({ filePath, allowedRoot });
    if (!inspected.ok) {
      process.stderr.write(`未发送：${inspected.reason}\n`);
      process.exit(1);
    }
    const window = replyWindow({
      lastCustomerAt: lastCustomerMessageAt(db, `${kfid}|${externalUserId}`),
    });
    if (!confirm) {
      print({
        dryRun: true,
        to: externalUserId,
        openKfId: kfid,
        file: { path: inspected.realPath, name: inspected.name, bytes: inspected.bytes },
        window,
      });
      process.stderr.write("未上传也未发送（演练）。确认要发给真实客户请加 --confirm\n");
      process.exit(0);
    }
    if (!config.corpId || !config.secret) {
      process.stderr.write("缺少 KF_CORPID / KF_SECRET\n");
      process.exit(2);
    }
    const res = await sendFileReply({
      db,
      client: makeClient(config),
      openKfId: kfid,
      externalUserId,
      filePath: inspected.realPath,
      allowedRoot,
    });
    print(res);
    process.exit(res.ok ? 0 : 1);
  }

  if (!externalUserId || !content) {
    process.stderr.write("用法：reply <external_userid> <正文> [--kfid kfX] [--confirm]\n");
    process.stderr.write("      reply <external_userid> --file <路径> [--root 目录] [--confirm]\n");
    process.exit(2);
  }
  const db = openDb();
  const window = replyWindow({
    lastCustomerAt: lastCustomerMessageAt(db, `${kfid}|${externalUserId}`),
  });
  if (!confirm) {
    print({ dryRun: true, to: externalUserId, openKfId: kfid, content, window });
    process.stderr.write("未发送（演练）。确认要发给真实客户请加 --confirm\n");
    process.exit(0);
  }
  if (!config.corpId || !config.secret) {
    process.stderr.write("缺少 KF_CORPID / KF_SECRET\n");
    process.exit(2);
  }
  const res = await sendReply({
    db,
    client: makeClient(config),
    openKfId: kfid,
    externalUserId,
    content,
  });
  print(res);
  process.exit(res.ok ? 0 : 1);
} else {
  process.stderr.write(
    `未知命令：${cmd}\n用法：doctor | sync | convs | media | extract | show <消息id> | inbox | search <词> | reply <用户> <正文>\n`,
  );
  process.exit(2);
}
