#!/usr/bin/env node
// 上产后的验收判据（openspec 6.2 的"后"半边，机械可跑）
//
// 为什么要有它：6.2 要求"观察记录落档，不以跑绿了代替数字"。基线已经落在
// `openspec/changes/harden-fleet-execution-economics/reports/queue-baseline-2026-11-09.md`，
// 但"拿同一组命令复算、逐条对照五条判据"这件事如果靠人记，就会退化成
// "镜像更新了、看起来好点了"——那正是这份 change 想消灭的读数方式。
//
// 判据（基线 → 期望方向）：
//   1. 失败率        **只报告，不判定**（见下）
//   2. ctx 失败耗时  基线 p50 619582ms → 更低（这是修复真正改变的量）
//   3. 早停覆盖率    达到阈值的回合里，早停应占绝大多数（基线 3/(3+44)=6.4% → 目标 >=90%）
//
// 注意：**不要把"ctx 占失败比"当判据**。早停的回合本身就结算成压力失败，所以修复
// 并不减少 ctx 失败的数量，它减少的是每个这样的回合**占用的时间**（600s → 60~240s）。
// 数量口径会把这个改进读成"没变化甚至更差"。
//   4. n>=4 压缩的压力超时  baseline 8  → **0**
//   5. --trusted 的 missed  baseline 0（存量污染）→ > 0
//
// 用法::
//
//   node scripts/queue-observation-check.mjs --hours 24 --cells a.json b.json
//   node scripts/queue-observation-check.mjs --hours 24 --json --cells a.json b.json
//
// 退出码：0=五条全过 / 1=有未达标项（不代表回滚，只代表"没达到、要写清差在哪"）
//        2=输入不可用（文件读不了 / 样本太少，无法判断）

import fs from "node:fs";
import path from "node:path";
import { summarizeHistory } from "../server/history-kinds.js";

// 基线常量取自 reports/queue-baseline-2026-11-09.md（2026-11-08T23:41Z 之后的
// 干净窗口：751 行 / executed 373 / failed 104）。改基线必须同时改那份报告。
const BASELINE = {
  // 只作参考值报告。**不能当通过/不通过判据**：早停的回合按设计仍结算为
  // failed（只是从 600s 变成 60~240s），所以这个修复不减少失败数量、只减少
  // 每次占用；把它当闸门会让"修复生效"读成"更糟"。2026-11-09 实测：近 2h
  // 12 条失败里有 5 条就是早停本身。
  failureRate: 0.279,
  // ctx 失败的中位耗时（17 天实测 p50）。修复前这些回合跑满预算。
  ctxMedianMs: 619582,
  // 17 天全窗实测：3 次真早停 vs 44 次「压缩数已过阈值却仍超时」。
  earlyStopsSeen: 3,
  pressureTimeoutsWith4PlusCompactions: 44,
  trustedMissed: 0,
};

// 样本下限：少于这个执行回合数，任何百分比都是噪声，宁可判"无法判断"。
const MIN_EXECUTED = 50;

const argv = process.argv.slice(2);
let hours = 24;
let asJson = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--hours") hours = Number(argv[++i]);
  else if (a === "--json") asJson = true;
  else if (a === "--cells") {
    while (argv[i + 1] && !argv[i + 1].startsWith("--")) files.push(argv[++i]);
  } else if (a === "-h" || a === "--help") {
    console.log("usage: queue-observation-check.mjs --hours 24 --cells <jobs.json...> [--json]");
    process.exit(0);
  } else if (!a.startsWith("--")) files.push(a);
}
if (!files.length) {
  console.error("need at least one jobs.json (use --cells <paths...>)");
  process.exit(2);
}
if (!Number.isFinite(hours) || hours <= 0) {
  console.error("--hours must be a positive number");
  process.exit(2);
}

const cutoff = Date.now() - hours * 3600 * 1000;
const rows = [];
const unreadable = [];
for (const file of files) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const t of Array.isArray(doc) ? doc : doc.tasks || []) {
      for (const h of t.history || []) {
        const at = Date.parse(h.time || h.at || "");
        if (!Number.isFinite(at) || at < cutoff) continue;
        rows.push(h);
      }
    }
  } catch (err) {
    // 截断过的 JSON 看起来只是"这个 cell 没记录"——必须点名，不能当零行。
    unreadable.push({ file: path.basename(file), error: `${err.name}: ${err.message}`.slice(0, 120) });
  }
}

const all = summarizeHistory(rows);
// 只数"修复之后写入"的 missed：存量行没有 kind，而且那批数字本身是重复记的。
const trustedRows = rows.filter((h) => !(h.kind === undefined && h.missed));
const trusted = summarizeHistory(trustedRows);

const fails = rows.filter((h) => h.state === "failed");
const CTX_RE = /context|compaction|overflow/i;

let earlyStops = 0;
let pressure4Plus = 0;
for (const h of fails) {
  const e = h.error;
  if (/turn stopped early/.test(String(e || ""))) earlyStops += 1;
  const m = /turn timed out — context pressure \((\d+) compactions?\)/.exec(String(e || ""));
  if (m && Number(m[1]) >= 4) pressure4Plus += 1;
}

// ctx 失败耗时中位数：修复把 600s 的跑满变成 60~240s 的早停。
const ctxDurations = fails
  .filter((h) => CTX_RE.test(String(h.error || "")) && Number.isFinite(h.duration))
  .map((h) => h.duration)
  .sort((a, b) => a - b);
const ctxMedianMs = ctxDurations.length
  ? ctxDurations[Math.floor(ctxDurations.length / 2)]
  : null;
const enough = all.executed >= MIN_EXECUTED;

const checks = [
  {
    id: "failureRate",
    label: "失败率",
    baseline: `${(BASELINE.failureRate * 100).toFixed(1)}%`,
    measured: all.failureRate === null ? "null" : `${(all.failureRate * 100).toFixed(1)}%`,
    // informational：见 BASELINE 上的注释。不参与通过/不通过。
    informational: true,
    pass: true,
    why: "仅供参考——早停回合仍记 failed，此数不因本修复下降（看耗时与覆盖率）",
  },
  {
    id: "ctxDuration",
    label: "ctx 失败耗时p50",
    baseline: `${(BASELINE.ctxMedianMs / 1000).toFixed(0)}s`,
    measured: ctxMedianMs === null ? "null" : `${(ctxMedianMs / 1000).toFixed(0)}s`,
    pass: ctxMedianMs !== null && ctxMedianMs < BASELINE.ctxMedianMs * 0.6,
    why: "修复不减少 ctx 失败的数量（早停本身也算压力失败），减少的是每回合占用时间",
  },
  {
    id: "earlyStopCoverage",
    label: "早停覆盖率(n>=4)",
    // 用比例而不是"次数>0"：修复前也偶尔有 3 次早停，只数次数会被这 3 次骗过。
    // 覆盖率 = 早停次数 / (早停次数 + 达标却仍超时的次数)。
    baseline: `${(BASELINE.earlyStopsSeen / (BASELINE.earlyStopsSeen + BASELINE.pressureTimeoutsWith4PlusCompactions) * 100).toFixed(1)}%`,
    measured:
      earlyStops + pressure4Plus === 0
        ? "n/a（窗口内无达标回合）"
        : `${((earlyStops / (earlyStops + pressure4Plus)) * 100).toFixed(1)}%`,
    pass: earlyStops + pressure4Plus === 0 || earlyStops / (earlyStops + pressure4Plus) >= 0.9,
    why: "闸门修复后，达到阈值的回合应当几乎都走早停，而不是等到预算耗尽",
  },
  {
    id: "pressure4Plus",
    label: "n>=4 压缩的压力超时",
    baseline: "0（17 天累计 44）",
    measured: String(pressure4Plus),
    pass: pressure4Plus === 0,
    why: "达到阈值就该早停；还有残留说明闸门仍有绕过路径",
  },
  {
    id: "trustedMissed",
    label: "可信 missed（--trusted）",
    baseline: String(BASELINE.trustedMissed),
    measured: String(trusted.missedOccurrences),
    pass: trusted.missedOccurrences > 0,
    why: "kind:\"missed\" 开始落盘 = 镜像已更新；仍为 0 说明镜像没上产",
  },
];

const result = {
  window: `last ${hours}h`,
  rows: rows.length,
  executed: all.executed,
  failed: all.failed,
  enoughSamples: enough,
  unreadable,
  checks,
};
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`== 上产验收（${result.window}）==`);
  console.log(`rows=${rows.length} executed=${all.executed} failed=${all.failed}`);
  if (!enough) {
    console.log(`\n⚠️ 执行回合只有 ${all.executed}（< ${MIN_EXECUTED}）——百分比是噪声，本窗口无法判断`);
  }
  console.log("");
  for (const c of checks) {
    const mark = c.informational ? "•" : c.pass ? "✓" : "✗";
    const suffix = c.informational ? "   （仅参考，不判定）" : "";
    console.log(`${mark} ${c.label.padEnd(22)} 基线 ${c.baseline.padEnd(16)} 实测 ${c.measured}${suffix}`);
  }
  if (unreadable.length) {
    console.log("\n== 读不了的文件（未计入零行）==");
    for (const u of unreadable) console.log(`  ${u.file}: ${u.error}`);
  }
  const bad = checks.filter((c) => !c.pass);
  console.log(
    bad.length === 0
      ? "\n全部达标。"
      : `\n未达标 ${bad.length} 项：${bad.map((c) => c.label).join("、")}——按 6.2 要求把"实测值/差在哪/下一步"补进基线报告，不要回滚镜像。`,
  );
}

if (!enough || (unreadable.length && !rows.length)) process.exit(2);
process.exit(checks.every((c) => c.pass) ? 0 : 1);
