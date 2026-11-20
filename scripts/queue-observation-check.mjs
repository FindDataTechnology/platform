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
//   node scripts/queue-observation-check.mjs --hours 168 --since-fix 2026-11-10T00:00:00Z --cells a.json b.json
//
// 退出码：0=没有未达标项（可以有几条"判据不适用"）/ 1=有未达标项（不代表回滚，
//        只代表"没达到、要写清差在哪"）/ 2=输入不可用（文件读不了 / 样本太少 / 参数非法）
//
// 两处 2026-11-16 补的语义，都是为了"别让读的人被误导"：
//   • `--since-fix`：只统计修复之后的行。7 天窗口会把修复前的日子统进来，
//     于是 `n>=4 压力超时` 报 28 条 ✗——逐日一拆正好是 11-08 的 4 + 11-09 的 24，
//     11-10 起连续 6 天为 0。**窗口效应会伪装成残留缺陷。**
//   • 无样本 ⇒ 判据不适用（`–`，不计失败）：ctx 类失败被早停修到 0 条之后，
//     "中位数"没有定义，而原来的写法把它判成 ✗ ⇒ 修复越彻底这条越红。

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
let sinceFix = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--hours") hours = Number(argv[++i]);
  else if (a === "--json") asJson = true;
  else if (a === "--since-fix") sinceFix = argv[++i];
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
// `--since-fix <ISO8601>`：只统计修复**之后**的行。
//
// 为什么需要它（2026-11-16 实测）：7 天窗口里前 1–2 天是修复前，于是
// `n>=4 压缩的压力超时` 报 28 条 ✗——而那 28 条逐日一拆正好是 11-08 的 4 条
// + 11-09 的 24 条，11-10 起连续 6 天为 0。**窗口效应伪装成残留缺陷**，
// 读的人会以为闸门还有绕过路径。
let sinceFixMs = null;
if (sinceFix) {
  sinceFixMs = Date.parse(sinceFix);
  if (!Number.isFinite(sinceFixMs)) {
    console.error(`--since-fix must be an ISO8601 timestamp (got ${JSON.stringify(sinceFix)})`);
    process.exit(2);
  }
}

const cutoff = Math.max(Date.now() - hours * 3600 * 1000, sinceFixMs ?? 0);
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

// ── 判据 6：整预算超时（`turn timed out` 且**没有**早停）─────────────────────
//
// 为什么单独数：上面两条判据都看不见这个形态。一个回合可以不打满压缩阈值、
// 也不早停，就那么跑满 600s/900s 预算——`n>=4 压缩` 数不到它（压缩数不够），
// `早停覆盖率` 也数不到它（它没早停，只进分母）。2026-11-12 那天有 66 条这样
// 的回合（p50 602s，只涉两个 cell、全天十几个小时），而 24h 窗口里是 0——
// **我是事后翻逐日表才看见的**。
//
// 口径三条，缺一条就会把这个数读反：
//   1. 含 `turn stopped early` 的**必须不计**：那是早停在 80% 处主动收口，
//      正是修复生效的证据，把它算进来会把「修好了」读成「坏了」。
//   2. 判定落在**最近一个完整 UTC 日**，不是整个窗口：窗口一滑（今天的 0 条
//      取代昨天的 66 条）就会「常年绿」，而这条判据的全部意义是「那天出过事」。
//   3. 窗口没完整覆盖那一天时判 `n/a`，不许拿半天当一天：`--hours 24` 在
//      21:00Z 跑时，昨天的 00:00–21:00 全在窗外，按窗口数会把 66 读成个位数。
//
// 一条读法上的事实（2026-11-16 实测，影响的是**逐日表**、不是判定日）：每个
// task 的 `history` 只留最近 100 条（`task-engine.js` 的 `HISTORY_LIMIT`），
// 跑得勤的 task 会把几天前的行挤掉。所以窗口内**旧日子**的计数会随时间变小
// ——同一天两份读数差几条不是口径漂移。判定日取「最近一个完整日」，正是被这
// 个上限影响最小的一天。
const TIMED_OUT_RE = /turn timed out/i;
const EARLY_STOP_RE = /turn stopped early/i;
const rowTime = (h) => Date.parse(h.time || h.at || "");
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const fullBudgetRows = fails.filter((h) => {
  const e = String(h.error || "");
  return TIMED_OUT_RE.test(e) && !EARLY_STOP_RE.test(e);
});
const fullBudgetByDay = new Map();
for (const h of fullBudgetRows) {
  const at = rowTime(h);
  if (!Number.isFinite(at)) continue;
  const d = utcDay(at);
  fullBudgetByDay.set(d, (fullBudgetByDay.get(d) || 0) + 1);
}
const fullBudgetDays = [...fullBudgetByDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

// 最近一个**完整**UTC 日 = 今天 UTC 零点往前一天。窗口起点必须不晚于它的零点，
// 否则这一天在窗口里是残缺的（见口径 3）。
const todayStartUtc = Date.parse(`${utcDay(Date.now())}T00:00:00Z`);
const lastCompleteDay = utcDay(todayStartUtc - 24 * 3600 * 1000);
const lastCompleteCovered = cutoff <= Date.parse(`${lastCompleteDay}T00:00:00Z`);
const lastCompleteCount = fullBudgetByDay.get(lastCompleteDay) || 0;
const FULL_BUDGET_FAIL_OVER = 10; // 只决定「要不要人看」，不是 SLA

const fullBudgetCheck = lastCompleteCovered
  ? {
      id: "fullBudgetTimeouts",
      label: `整预算超时(${lastCompleteDay})`,
      baseline: `0（>${FULL_BUDGET_FAIL_OVER} 判失败）`,
      measured: String(lastCompleteCount),
      // >0 只出 ⚠ 事实行：一个跑满预算的回合可能是上游流卡住（`pi-ai stream idle
      // timeout`），未必是本平台的锅；把它直接判失败会让这条判据变成常年红。
      pass: lastCompleteCount <= FULL_BUDGET_FAIL_OVER,
      warn: lastCompleteCount > 0 && lastCompleteCount <= FULL_BUDGET_FAIL_OVER,
      why: "跑满 600s/900s 且没早停的回合：先分诊「真跑满」vs「上游流卡住」（见 runbook）",
    }
  : {
      id: "fullBudgetTimeouts",
      label: `整预算超时(${lastCompleteDay})`,
      baseline: `0（>${FULL_BUDGET_FAIL_OVER} 判失败）`,
      measured: `n/a（窗口未完整覆盖 ${lastCompleteDay}）`,
      informational: true,
      pass: true,
      why: `窗口起点 ${new Date(cutoff).toISOString()} 晚于该日零点——要判这一天请加大 --hours`,
    };

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
    measured: ctxMedianMs === null ? "无样本" : `${(ctxMedianMs / 1000).toFixed(0)}s`,
    // 三态（2026-11-16 实测教训）：窗口内**一条 ctx 类失败都没有**时，中位数算不出来，
    // 而原来的 `ctxMedianMs !== null && …` 会把它判成 ✗。修复越彻底这条越红——
    // 读的人把「这类失败不再发生」读成「修复没生效」，还差点据此回滚。
    // 无样本 = 判据不适用（skip），不是未达标；可判的旁证由早停覆盖率与 n>=4 条数承担。
    skip: ctxMedianMs === null,
    skipWhy: "窗口内 0 条 ctx 类失败 ⇒ 中位数无定义；这类失败不再发生，不是没达标",
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
  fullBudgetCheck,
];

const result = {
  window: sinceFixMs ? `since ${new Date(sinceFixMs).toISOString()}（上限 ${hours}h）` : `last ${hours}h`,
  rows: rows.length,
  executed: all.executed,
  failed: all.failed,
  enoughSamples: enough,
  unreadable,
  fullBudget: {
    day: lastCompleteDay,
    dayCovered: lastCompleteCovered,
    countOnDay: lastCompleteCount,
    byDay: Object.fromEntries(fullBudgetDays),
  },
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
    const mark = c.informational ? "•" : c.skip ? "–" : c.warn ? "⚠" : c.pass ? "✓" : "✗";
    const suffix = c.informational
      ? "   （仅参考，不判定）"
      : c.skip
        ? `   （判据不适用：${c.skipWhy}）`
        : c.warn
          ? "   （事实行：有但未过阈值，不判失败）"
          : "";
    console.log(`${mark} ${c.label.padEnd(22)} 基线 ${c.baseline.padEnd(16)} 实测 ${c.measured}${suffix}`);
  }
  // 逐日计数：让「那天是多少」不必再翻第二张表（窗口内出现过的每个 UTC 日）。
  if (fullBudgetDays.length) {
    console.log("\n== 整预算超时逐日（窗口内，UTC）==");
    for (const [d, n] of fullBudgetDays) {
      const partial = Date.parse(`${d}T00:00:00Z`) < cutoff ? "  ← 窗口只覆盖当天一部分" : "";
      console.log(`  ${d}  ${String(n).padStart(4)}${partial}`);
    }
  } else {
    console.log("\n== 整预算超时逐日（窗口内，UTC）==\n  （窗口内 0 条）");
  }
  if (unreadable.length) {
    console.log("\n== 读不了的文件（未计入零行）==");
    for (const u of unreadable) console.log(`  ${u.file}: ${u.error}`);
  }
  const bad = checks.filter((c) => !c.pass && !c.skip && !c.informational);
  const skipped = checks.filter((c) => c.skip);
  console.log(
    bad.length === 0
      ? `\n全部达标${skipped.length ? `（${skipped.length} 项不适用：${skipped.map((c) => c.label).join("、")}）` : ""}。`
      : `\n未达标 ${bad.length} 项：${bad.map((c) => c.label).join("、")}——按 6.2 要求把"实测值/差在哪/下一步"补进基线报告，不要回滚镜像。`,
  );
}

if (!enough || (unreadable.length && !rows.length)) process.exit(2);
// `skip` 不计失败：无样本不是「没达标」（见 ctxDuration 上的注释）。
process.exit(checks.every((c) => c.pass || c.skip) ? 0 : 1);
