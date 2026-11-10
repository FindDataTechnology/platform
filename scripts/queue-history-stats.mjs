#!/usr/bin/env node
// 队列历史读面 —— `history[]` 的唯一统计入口（openspec 1.4 的读面半边）
//
// 为什么要有这个脚本：同一天里同一个形状被读错了三次
//   {success:null, missed:1}  到期没跑     -> 被当失败（89.7% 假失败率）
//   {success:null, note:"…"}  校准留痕     -> 被当失败（62.1% vs 真实 38.3%）
// 每个脚本自己写一份 `cls()`，于是每份都猜得不一样。现在分类器只有一份
// （`server/history-kinds.js`，纯函数），这个脚本是它唯一的命令行读面。
//
// 用法::
//
//   node scripts/queue-history-stats.mjs /path/jobs.json [...]
//   node scripts/queue-history-stats.mjs --hours 24 /data/cells/*/data/cron-store/jobs.json
//   node scripts/queue-history-stats.mjs --json ...      # 给 2.4/6.2 的报表吃
//   node scripts/queue-history-stats.mjs --trusted ...   # 丢掉 watermark 修复前的存量 missed 行
//
// 口径（写进输出头，读的人不必猜）:
//   executed = done + failed + skipped + interrupted
//            —— 失败率的分母只含真跑过的回合，missed/meta 不进分母
//   missed   = 到期未执行的**次数之和**；missedCapped>0 时它是下界
//   starvationRatio = missed / executed（排队饥饿的硬指标）
//
// 退出码：0=算完了（有没有坏文件都算完）/ 2=参数或全量不可读

import fs from "node:fs";
import path from "node:path";
import { summarizeHistory } from "../server/history-kinds.js";

function usage(code = 2) {
  console.error("usage: queue-history-stats.mjs [--hours N] [--json] [--per-task] <jobs.json...>");
  process.exit(code);
}

const args = process.argv.slice(2);
let hours = null;
let asJson = false;
let perTask = false;
let trusted = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--hours") hours = Number(args[++i]);
  else if (a === "--json") asJson = true;
  else if (a === "--per-task") perTask = true;
  else if (a === "--trusted") trusted = true;
  else if (a === "-h" || a === "--help") usage(0);
  else if (a.startsWith("-")) usage();
  else files.push(a);
}
if (!files.length) usage();
if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) {
  console.error("--hours must be a positive number");
  process.exit(2);
}

const cutoff = hours === null ? -Infinity : Date.now() - hours * 3600 * 1000;

function rowsOf(doc) {
  const tasks = Array.isArray(doc) ? doc : doc.tasks || [];
  const out = [];
  for (const t of tasks) {
    for (const h of t.history || []) {
      const at = Date.parse(h.time || h.at || "");
      if (!Number.isFinite(at) || at < cutoff) continue;
      out.push({ task: t.id ?? t.name ?? "(unnamed)", row: h });
    }
  }
  return out;
}

const perFile = [];
const perTaskAgg = new Map();
const all = [];
const unreadable = [];
// 存量污染：watermark 修复（2026-11-09）之前写入的 missed 行没有 kind，而且
// 每次加载都会从同一个 lastRun 重数一遍，所以 `missed:100` 这样的行往往是
// **同一批缺口被记了很多次**，不是真实的缺口次数。它们混在任何一个跨越修复
// 时刻的窗口里，都会把 starvation 放大一到两个数量级（实测 24h 内 2700/3261
// 来自 27 行同源 burst）。这里单独数出来并告警，绝不静默求和。
let legacyRows = 0;
let legacyBurstRows = 0;

for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // 坏文件必须报出来，不能当"零行"——`kubectl cp` 截断过大文件时，
    // 截断的 JSON 看起来只是"这个 cell 没记录"，实测骗过一次。
    unreadable.push({ file, error: `${err.name}: ${err.message}`.slice(0, 160) });
    continue;
  }
  let rows = rowsOf(doc);
  for (const { row } of rows) {
    if (row.kind === undefined) legacyRows += 1;
    if (row.kind === undefined && (Number(row.missed) || 0) >= 100) legacyBurstRows += 1;
  }
  // 只丢"存量的 missed 行"：执行行的 state 一直都在，分类不依赖 kind；
  // missed 行的计数语义在 watermark 修复前是错的，这才是必须排除的那批。
  if (trusted) rows = rows.filter(({ row }) => !(row.kind === undefined && row.missed));
  const label = path.basename(file).replace(/\.json$/, "");
  all.push(...rows.map((r) => r.row));
  perFile.push({ file, label, rows: rows.length, ...summarizeHistory(rows.map((r) => r.row)) });

  if (perTask) {
    const byTask = new Map();
    for (const r of rows) {
      if (!byTask.has(r.task)) byTask.set(r.task, []);
      byTask.get(r.task).push(r.row);
    }
    for (const [task, rs] of byTask) {
      const key = `${path.basename(path.dirname(path.dirname(file)))}/${task}`;
      const prev = perTaskAgg.get(key) || [];
      perTaskAgg.set(key, prev.concat(rs));
    }
  }
}

const total = summarizeHistory(all);

const pct = (x) => (x === null ? "null" : (x * 100).toFixed(1) + "%");
const line = (label, s) =>
  `${label.padEnd(28)} rows=${String(s.executed + s.missed + s.superseded + s.meta).padStart(5)} ` +
  `executed=${String(s.executed).padStart(4)} failed=${String(s.failed).padStart(3)} ` +
  `missed=${String(s.missedOccurrences).padStart(5)}${s.missedCapped ? `(capped ${s.missedCapped})` : ""} ` +
  `starvation=${s.starvationRatio === null ? "null" : s.starvationRatio.toFixed(2)} ` +
  `failureRate=${pct(s.failureRate)}`;

const result = {
  window: hours === null ? "all" : `last ${hours}h`,
  files: perFile,
  unreadable,
  trustedOnly: trusted,
  legacy: { rows: legacyRows, burstRows: legacyBurstRows },
  total,
};
if (perTask) {
  result.perTask = [...perTaskAgg.entries()]
    .map(([task, rs]) => ({ task, ...summarizeHistory(rs) }))
    .filter((t) => t.missedOccurrences > 0 || t.failed > 0)
    .sort((a, b) => (b.starvationRatio ?? 0) - (a.starvationRatio ?? 0));
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`== queue history (${result.window}) ==`);
  console.log("executed = done+failed+skipped+interrupted; failed-rate denominator excludes missed/meta");
  console.log("");
  for (const f of perFile) console.log(line(f.label, f));
  console.log("");
  console.log(line("TOTAL", total));
  if (total.missedCapped > 0) {
    console.log(`\n注：${total.missedCapped} 行撞到单次加载上限，missed 是**下界**（真实缺口只会更大）`);
  }
  if (legacyBurstRows > 0 && !trusted) {
    console.log(
      `\n警告：本窗口含 ${legacyBurstRows} 行 watermark 修复前的存量 burst（无 kind，missed≥100）。` +
      `那批行是**同一批缺口被重复记**（实测 27 行贡献 2700 次），所以上面的 missed/starvation` +
      ` 对这类窗口是虚高的。要读真实饥饿量级，只看修复之后写入的行（有 kind:"missed"）。`,
    );
  }
  if (perTask && result.perTask.length) {
    console.log("\n== worst starvation (missed / executed) ==");
    for (const t of result.perTask.slice(0, 10)) console.log(line(t.task.slice(-40), t));
  }
  if (unreadable.length) {
    console.log("\n== unreadable (NOT counted as zero rows) ==");
    for (const u of unreadable) console.log(`  ${u.file}: ${u.error}`);
  }
}

process.exit(unreadable.length && !perFile.length ? 2 : 0);
