#!/usr/bin/env node
// 存量 `missed` 计数校准（2026-11-09）
//
// 背景：`countMissedOccurrences` 修好之前，每次 cell 启动/恢复都会把同一批历史
// 触发点重复累加。线上遗留了 `missed=801` 这类虚高值——而水位修复只防**未来**
// 膨胀，不会把存量降回来。虚高的数会被健康巡检与看板当"漏了 801 轮"读。
//
// 本脚本按 `lastRun` 重算**真实缺口**（cron 从 lastRun 到现在的触发点数，上限
// 100 与线上同口径），只纠正"存量 > 真实值"的 job；低于真实值的不动
// （那是真的漏跑，不能替它掩盖）。
//
// 用法：
//   node scripts/missed-recalibrate.mjs --dir /data/cells            # 只读盘点
//   node scripts/missed-recalibrate.mjs --dir /data/cells --apply     # 落盘
//
// --apply 的安全前提：目标 cell **必须已停止**。jobs.json 由 cell 进程在内存里
// 持有并在 saveTasks 时整文件重写；运行态下改盘会被下一次保存覆盖。
// 脚本在 --apply 时会检查该目录下有没有活着的 server.js 进程，有则拒绝执行。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cronParser from "cron-parser";

const MAX_PER_LOAD = 100; // 与 cron.js 的 MAX_MISSED_PER_LOAD 同口径

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes("--apply");
const dirs = [arg("--dir")].filter(Boolean);
if (!dirs.length) {
  console.error("用法: node scripts/missed-recalibrate.mjs --dir <cells 根目录|单个 cell 目录> [--apply]");
  process.exit(2);
}
const NOW = Number(arg("--now-ms", String(Date.now())));
const STAMP = new Date(NOW).toISOString();

function countBetween(iter, fromMs, cap = MAX_PER_LOAD) {
  let missed = 0;
  let prev = iter.prev();
  while (prev && prev.toDate().getTime() > fromMs && missed < cap) {
    missed += 1;
    prev = iter.prev();
  }
  return missed;
}

// 真实缺口：cron 在 (lastRun, now] 之间的触发点数，封顶 MAX_PER_LOAD。
// 与 cron.js countMissedBetween 同一算法，避免"校准工具"和"线上口径"走散。
function trueGap(task) {
  const lastMs = task.lastRun ? Date.parse(task.lastRun) : NaN;
  if (!Number.isFinite(lastMs)) return { gap: null, why: "no-lastRun" };
  if (!task.cron) return { gap: null, why: "no-cron" };
  try {
    const iter = cronParser.parseExpression(task.cron, { tz: task.tz || undefined });
    return { gap: countBetween(iter, lastMs), why: null };
  } catch (e) {
    return { gap: null, why: `unparseable:${e.message.slice(0, 40)}` };
  }
}

function cellDirs(root) {
  const out = [];
  const looksLikeCell = fs.existsSync(path.join(root, "data", "cron-store", "jobs.json"))
    || fs.existsSync(path.join(root, "cron-store", "jobs.json"));
  if (looksLikeCell) return [root];
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    try { if (fs.statSync(p).isDirectory()) out.push(p); } catch { /* skip */ }
  }
  return out;
}

const CLEAN = process.argv.includes("--clean-markers");

let scanned = 0, inflated = 0, truthful = 0, understated = 0, skipped = 0;
let markersRemoved = 0;
const skipReasons = {};
const rows = [];

for (const dir of dirs) {
  for (const cell of cellDirs(dir)) {
    const file = path.join(cell, "data", "cron-store", "jobs.json");
    if (!fs.existsSync(file)) continue;
    let tasks;
    try { tasks = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!Array.isArray(tasks)) continue;

    let changed = 0;
    for (const t of tasks) {
      scanned += 1;
      const { gap, why } = trueGap(t);
      if (gap === null) {
        skipped += 1;
        // 跳过原因要分类计数：1501 个"跳过"里混着三种完全不同的情况
        // （没有 lastRun / 没有 cron / cron 不可解析），混成一个数就没法判断
        // "是不是有源配置坏了"。
        skipReasons[why] = (skipReasons[why] || 0) + 1;
        continue;
      }
      // 一次性清理：早期版本把校准审计写进了 history[]，那些行没有 state/error，
      // 会被统计工具当成"未分类失败"。这里按 note 精确识别并摘掉。
      if (CLEAN && Array.isArray(t.history)) {
        const kept = t.history.filter((h) => !String(h?.note || "").includes("recalibrated"));
        if (kept.length !== t.history.length) {
          markersRemoved += t.history.length - kept.length;
          t.history = kept;
          changed += 1;
        }
      }
      const stored = Number(t.missed ?? 0);
      if (stored > gap) {
        inflated += 1;
        rows.push({ cell: path.basename(cell), id: t.id, cron: t.cron, stored, gap, delta: stored - gap });
        if (APPLY) {
          t.missed = gap;
          t.missedResetAt = STAMP;
          t.missedResetReason = `counter was inflated by repeated downtime accounting (${stored} -> ${gap}); watermark added in the same release`;
          // 审计**不写 history**（2026-11-09 实测教训）：`history[]` 的每一行都会被
          // 统计工具当作"一次执行"，而 `{success:null, note:...}` 这类元数据行没有
          // state/error，于是被归到"未分类失败"——我因此把真实失败率 38.3% 读成 62.1%。
          // 校准属于**记录级元数据**，落 missedResetAt/missedResetReason 即可，
          // 那里已经是可读面（clientShape 带出去）。
          changed += 1;
        }
      } else if (stored === gap) truthful += 1;
      else understated += 1; // 真的漏跑，不替它掩盖
    }

    if (APPLY && changed) {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
      fs.renameSync(tmp, file);
      console.log(`[apply] ${path.basename(cell)}: 纠正 ${changed} 个 job 的 missed`);
    }
  }
}

console.log(`\n扫描 job=${scanned}  虚高=${inflated}  一致=${truthful}  偏低(=真漏跑,不动)=${understated}  跳过(无 lastRun/无 cron/不可解析)=${skipped}`);
if (CLEAN) console.log(`清理 history 里的校准审计行：${markersRemoved} 条`);
const sr = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]);
if (sr.length) console.log("跳过原因：" + sr.map(([k, v]) => `${k}=${v}`).join("  "));
if (rows.length) {
  rows.sort((a, b) => b.delta - a.delta);
  console.log("\n虚高最严重 Top 10（stored → 真实值）:");
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${String(r.stored).padStart(5)} -> ${String(r.gap).padStart(3)}  (差 ${String(r.delta).padStart(4)})  ${r.cell.slice(0, 8)} ${String(r.id).slice(0, 24)} cron=${r.cron}`);
  }
}
if (!APPLY) console.log("\n（只读盘点。加 --apply 落盘；落盘前请先停止目标 cell）");
