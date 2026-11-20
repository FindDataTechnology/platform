#!/usr/bin/env node
// cron-session-metrics.mjs — 会话轮换/上下文累积的**只读**读数（EXIT=0 出数，EXIT=2 判不出）。
//
// 回答三个问题，且必须一起报（只报一个都会得出相反结论）：
//   ① 会话有多长？（中位 1 轮 ⇒ 任何「防累积」的机制无事可做）
//   ② 会话内每轮涨多少？（中位 +197 token/轮 ⇒ prompt 不是逐轮涨到窗口的）
//   ③ 多轮会话里真的碰到阈值/窗口的有几个？（**人口**，比任何均值都硬）
//
// 数据源两个，都要读（它们各记一半，缺一半就只能猜）：
//   - `<cell>/data/data/fleets.db::member_turn_events` —— 每回合的 `session_id` 与
//     `usage_input_max`（每请求 prompt 高水位）。**历史行不记 session id，这张表记**，
//     所以「这一轮用的哪个会话」只能从这儿判；
//   - `<cell>/data/cron-store/jobs.json` —— 执行行与 `sessionRotated` 标记，用来算轮换率
//     与三条触发路径。
//
// 本工具**不出红绿**（常年红的闸等于没有闸）：它量的是人口与斜率，判定归 change 的解锁条件。
//
// 用法：
//   node scripts/cron-session-metrics.mjs                       # 扫 /data/cells
//   node scripts/cron-session-metrics.mjs --root ./fixtures     # 指定根
//   node scripts/cron-session-metrics.mjs --threshold 89600 --window 128000
//   node scripts/cron-session-metrics.mjs --json
// 在 pod 里跑（无 sqlite3 CLI，走 better-sqlite3）：
//   kubectl exec -i … -- node - < scripts/cron-session-metrics.mjs
// 注意：pod 内 `/data/cells` 是**活库**，只读打开（readonly），不要 cp 出来算
// （正在写的库拷出来必然截断，md5 两侧不等）。

import fs from "node:fs";
import path from "node:path";

import {
  accumulationSlopes,
  peakReach,
  quantile,
  roundHighWaterStats,
  rotationAttribution,
  rotationRate,
  sessionize,
  sessionLengthStats,
} from "./lib/cron-session-metrics.mjs";

const DEFAULT_ROOT = "/data/cells";
const DEFAULT_THRESHOLD = 89_600; // 128000 × 0.7（`CRON_CONTEXT_WINDOW` / `CRON_SESSION_ROTATE_RATIO` 的缺省）
const DEFAULT_WINDOW = 128_000;

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, threshold: DEFAULT_THRESHOLD, window: DEFAULT_WINDOW, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--threshold") out.threshold = Number(argv[++i]);
    else if (a === "--window") out.window = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

// cron-parser 的教训同理：仓内走裸名，pod 里脚本常被 `cp` 到 /tmp 跑，退 /app 绝对路径。
async function loadSqlite() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default ?? mod;
  } catch {
    const mod = await import("/app/node_modules/better-sqlite3/lib/index.js");
    return mod.default ?? mod;
  }
}

function readJobsStore(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.tasks || raw.jobs || [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 26).join("\n"));
    return 0;
  }
  if (!fs.existsSync(args.root)) {
    console.error(`判不出：根目录不存在 ${args.root}`);
    return 2;
  }

  const Database = await loadSqlite();
  const cells = fs
    .readdirSync(args.root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const rows = [];
  const tasks = [];
  const perCell = [];
  let noDb = 0;
  let noTable = 0;
  let noStore = 0;
  let minAt = null;
  let maxAt = null;

  for (const cell of cells) {
    const dbPath = path.join(args.root, cell, "data", "data", "fleets.db");
    const storePath = path.join(args.root, cell, "data", "cron-store", "jobs.json");
    let dbRows = [];
    let dbReadable = false;
    if (fs.existsSync(dbPath)) {
      let db;
      try {
        db = new Database(dbPath, { readonly: true });
        dbRows = db
          .prepare(
            `select session_id sid, started_at at, usage_input_max mx
               from member_turn_events
              where source = 'cron' and usage_input_max is not null and usage_input_max > 0
              order by started_at asc`,
          )
          .all();
        dbReadable = true;
      } catch {
        // 有的 cell 库没有这张表（空库 / 别的 schema）——点名跳过，不静默
        noTable += 1;
      } finally {
        try {
          db?.close();
        } catch {}
      }
    } else {
      noDb += 1;
    }

    let cellTasks = [];
    if (fs.existsSync(storePath)) {
      try {
        cellTasks = readJobsStore(storePath);
      } catch {
        noStore += 1;
      }
    } else {
      noStore += 1;
    }

    for (const r of dbRows) {
      rows.push(r);
      if (typeof r.at === "number") {
        if (minAt === null || r.at < minAt) minAt = r.at;
        if (maxAt === null || r.at > maxAt) maxAt = r.at;
      }
    }
    tasks.push(...cellTasks);
    if (dbRows.length || cellTasks.length) {
      perCell.push({ cell, rows: dbRows.length, jobs: cellTasks.length, dbReadable });
    }
  }

  if (!rows.length && !tasks.length) {
    console.error(
      `判不出：${cells.length} 个 cell 里没有可读的 member_turn_events 或 jobs.json` +
        `（无库 ${noDb} / 无表 ${noTable} / 无 store ${noStore}）——不是「一条都没有」`,
    );
    return 2;
  }

  const sessions = sessionize(rows);
  const lengths = sessionLengthStats(sessions);
  const slopes = accumulationSlopes(sessions);
  const reach = peakReach(sessions, { threshold: args.threshold, window: args.window });
  const highWater = roundHighWaterStats(rows);
  const rate = rotationRate(tasks);
  const attribution = rotationAttribution(tasks, args.threshold);

  const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString().replace(".000Z", "Z") : "-");
  const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : "-");

  const report = {
    root: args.root,
    coverage: {
      cells: cells.length,
      cellsWithData: perCell.length,
      skippedNoDb: noDb,
      skippedNoTable: noTable,
      skippedNoStore: noStore,
      cronRounds: rows.length,
      from: iso(minAt),
      to: iso(maxAt),
    },
    // ① 会话长度
    sessions: {
      count: lengths.sessions,
      singleRound: lengths.singleRound,
      roundsP50: lengths.p50,
      roundsP90: lengths.p90,
      roundsMax: lengths.max,
      histogram: lengths.histogram,
    },
    // ② 会话内累积
    accumulation: {
      sessions: slopes.length,
      slopeP10: quantile(slopes.map((s) => s.slope), 0.1),
      slopeP50: quantile(slopes.map((s) => s.slope), 0.5),
      slopeP90: quantile(slopes.map((s) => s.slope), 0.9),
      slopeMax: slopes.length ? Math.max(...slopes.map((s) => s.slope)) : null,
    },
    // ③ 到线人口
    reach: { ...reach, threshold: args.threshold, window: args.window },
    rounds: highWater,
    rotation: {
      executedRows: rate.executed,
      rotatedRows: rate.rotated,
      ratePct: rate.rate === null ? null : Math.round(rate.rate * 1000) / 10,
      attribution: attribution.counts,
      residueExamples: attribution.examples.residue,
    },
    perCell,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const L = [];
  L.push(`== 覆盖（只读；窗口 ${report.coverage.from} .. ${report.coverage.to}）==`);
  L.push(
    `cell ${report.coverage.cells} 个（有数据 ${report.coverage.cellsWithData}；无库 ${noDb} / 无表 ${noTable} / 无 store ${noStore}）；` +
      `cron 回合带高水位 ${rows.length} 行`,
  );
  L.push("");
  L.push("== ① 会话长度（每个 session 的 cron 回合数）==");
  L.push(
    `session ${lengths.sessions} 个；p50 ${fmt(lengths.p50)} / p90 ${fmt(lengths.p90)} / max ${fmt(lengths.max)}；` +
      `只跑 1 轮 ${lengths.singleRound}（${lengths.sessions ? Math.round((100 * lengths.singleRound) / lengths.sessions) : 0}%）`,
  );
  L.push(`分布 ${JSON.stringify(lengths.histogram)}`);
  L.push("");
  L.push("== ② 会话内累积斜率（(末轮-首轮)/(轮数-1)，token/轮）==");
  L.push(
    `多轮 session ${slopes.length} 个；p10 ${fmt(report.accumulation.slopeP10)} / p50 ${fmt(report.accumulation.slopeP50)} / ` +
      `p90 ${fmt(report.accumulation.slopeP90)} / max ${fmt(report.accumulation.slopeMax)}`,
  );
  L.push("");
  L.push("== ③ 到线人口（分母只算多轮会话）==");
  L.push(
    `${reach.considered} 个多轮 session：峰值 ≥${args.threshold}（轮换门槛）${reach.reachedThreshold} 个；` +
      `≥${args.window}（窗口）${reach.reachedWindow} 个`,
  );
  L.push("");
  L.push("== 单轮高水位（说明大 prompt 是单轮体量还是累积）==");
  L.push(
    `${highWater.rounds} 轮：p50 ${fmt(highWater.p50)} / p90 ${fmt(highWater.p90)} / p99 ${fmt(highWater.p99)} / max ${fmt(highWater.max)}`,
  );
  L.push("");
  L.push("== 轮换率与三条触发路径 ==");
  L.push(
    `执行行 ${rate.executed} / 轮换行 ${rate.rotated}` +
      (rate.rate === null ? "（分母 0，判不出）" : ` = ${report.rotation.ratePct}%`),
  );
  const c = attribution.counts;
  L.push(
    `上一轮失败 ${c.lastFailed} / 上一轮溢出 ${c.overflow} / 阈值 ${c.threshold} / ` +
      `解释不了 ${c.residue} / 首行 ${c.firstRow}`,
  );
  if (c.residue && attribution.examples.residue.length) {
    L.push(`  解释不了的样例 job：${attribution.examples.residue.join(", ")}（先查 missed 行夹在中间，再判是不是手工 run-now）`);
  }
  L.push("");
  L.push("本工具不出红绿：它量人口与斜率，判定归 change 的解锁条件。");
  console.log(L.join("\n"));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`判不出：${err?.message || err}`);
    process.exit(2);
  });
