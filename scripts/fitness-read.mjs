#!/usr/bin/env node
// ── 判定读数器（establish-agent-role-and-fitness-plane 1.2）────────────────────
//
// 一份舰队在一个窗口内的**四个确定性读数**，全部从既有三张表算出来，不新增记账：
//
//   回合      member_turn_events  → 跑了多少轮、成功/失败/中断
//   报数      member_reports      → 应报 vs 实报（每轮一条是岗位纪律）
//   成本      member_turn_daily   → 有价样本的美元与 token
//   时延      member_turn_events  → 队列等待（该列可能大面积 NULL，如实报样本数）
//
// 为什么单独一个只读脚本：判定要「同一输入重算得同一裁决」（agent-fitness-verdict
// spec），而重算的前提是读数本身可被任何一个进程用 SQL 复现。它不写库、不读凭据、
// 不联网。
//
// 退出码（fleet-acceptance-readings spec：读数作业的退出码就是判词）
//   0  全部判据有读数且未越线
//   1  至少一条越线
//   2  判不出（窗口内没有任何回合 / 库或表读不到）——**不是**通过
//
// 用法：
//   node scripts/fitness-read.mjs --db <fleets.db> --fleet <fleetId> --hours 24
//   node scripts/fitness-read.mjs --db ... --fleet ... --since 1763... --until 1763...
//   --json 输出整份读数；人读默认打一张表。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const EXIT = Object.freeze({ GREEN: 0, RED: 1, UNDET: 2 });

// 越线阈值。故意只有两条，且都在读数里写明用的是什么数——判据越多越像在
// 找一个能过的数，而不是在描述健康。
//
// **这两个 0.25 是在真实数据上验过的**（constraints/criterion-must-fire-on-real-data）：
// 2026-11-22 在生产的 20 片 cell / 7 天窗口上实测（138 岗、4439 回合）——
//
//   失败率  n=120  p50 18.8%  p90 42.9%  分布 0:19 / <10%:12 / 10-25%:45 / 25-50%:34 / >=50%:10
//   缺报率  n=118  p50 20.0%  p90 61.5%  分布 0:31 / <10%:6  / 10-25%:28 / 25-50%:35 / >=50%:18
//
// 即：信号会产生（不是恒 0/恒 1）、有区分度（跨五个桶）、对象与信号相交
// （被评估的岗正是产生回合与报数的那批）。0.25 落在 p50 与 p90 之间，命中
// 38/120 与 49/118——足够有告警量，也不至于全红。
export const THRESHOLDS = Object.freeze({
  // 失败率（failed / turns）。
  failureRate: 0.25,
  // 缺报率（max(0, 应报 - 实报) / 应报）。一轮一条是纪律；缺 1/4 说明
  // 报数车道在用"能跑完"冒充"做完"（report-contract.js 头部的 0.23/轮实测）。
  reportGapRate: 0.25,
  // 低于这个回合数不判（样本太小，比例没有意义）。如实报 undet，不报绿。
  minTurns: 5,
});

// 哪些回合算「该报一条」。
//
// **这份词表必须与真实写入口一致**——第一版我写的是
// `schedule/edge/handoff/fanout/event/delegate`，而 `server/turn-request.js`
// 的 `SOURCES` 只产出 `cron|manual|delegation|event`，两者**交集只有 event**。
// 于是 209 个真实回合的「应报」全是 0，缺报率判据恒不触发（
// constraints/criterion-must-fire-on-real-data 那一族：测试绿、逻辑对、真实数据上无效）。
//
// 生产实测分布（2026-11-22，20 片 cell / 15241 回合）：
//   cron 12849 · manual 2148 · delegation 241 · event 3
// 所以「该报」= cron + delegation + event；**manual 不算**——run-now / execute-now
// 是人手动点的一次补跑，本来就不带报数义务（`server/turn-request.js` 的注释：
// 「a manual fleet task (run-now / execute-now) reads manual」）。
export const OWING_SOURCES = Object.freeze(["cron", "delegation", "event"]);
// 曾经的错误词表留档，防止有人照着它改回去。
export const LEGACY_SOURCE_VOCAB = Object.freeze(["schedule", "edge", "handoff", "fanout", "delegate"]);

function windowFromArgs(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const since = arg("--since");
  const until = arg("--until");
  const hours = arg("--hours");
  const now = Date.now();
  if (since || until) {
    const s = Number(since);
    const u = Number(until) || now;
    if (!Number.isFinite(s) || s <= 0) throw new Error("--since must be epoch milliseconds");
    return { windowStart: s, windowEnd: u };
  }
  const h = Number(hours ?? 24);
  if (!Number.isFinite(h) || h <= 0) throw new Error("--hours must be a positive number");
  return { windowStart: now - h * 3_600_000, windowEnd: now };
}

/**
 * 纯计算：给定三张表的原始行，算出一份读数。不碰 fs、不碰时钟，
 * 因此可以在测试里用假行直接验（`test-fitness-read.mjs`）。
 */
export function computeReadings({ turns, reports, daily, windowStart, windowEnd, owingSources = OWING_SOURCES, thresholds = THRESHOLDS }) {
  const inWindow = turns.filter((t) => t.started_at >= windowStart && t.started_at <= windowEnd);
  const byMember = new Map();
  const row = (memberId) => {
    if (!byMember.has(memberId)) {
      byMember.set(memberId, { memberId, turns: 0, ok: 0, failed: 0, interrupted: 0, owing: 0, queueWaitSamples: [], queueWaitMsMax: null });
    }
    return byMember.get(memberId);
  };

  for (const t of inWindow) {
    const m = row(t.member_id);
    m.turns += 1;
    if (t.status === "ok") m.ok += 1;
    else if (t.status === "failed") m.failed += 1;
    else if (t.status === "interrupted") m.interrupted += 1;
    if (owingSources.includes(t.source)) m.owing += 1;
    if (Number.isFinite(t.queue_wait_ms)) {
      m.queueWaitSamples.push(t.queue_wait_ms);
      const w = t.queue_wait_ms;
      m.queueWaitMsMax = m.queueWaitMsMax === null ? w : Math.max(m.queueWaitMsMax, w);
    }
  }

  // 报数只数岗位自报（source='self'）。派生报数是平台写的，不能算岗位交了差。
  const reportsByMember = new Map();
  for (const r of reports) {
    if (r.created_at < windowStart || r.created_at > windowEnd) continue;
    if (r.source !== "self") continue;
    reportsByMember.set(r.member_id, (reportsByMember.get(r.member_id) ?? 0) + 1);
  }

  // 成本按日汇总落在窗口内的行累加；有价样本数单独给出，因为未定价的回合
  // 不是 0 美元，是「不知道」。
  const dailyInWindow = daily.filter((d) => {
    // day 是 'YYYY-MM-DD'（UTC）。窗口跨天时按整日纳入——日粒度无法更细，
    // 这是记账的既有粒度，不在这里假装更精确。
    const dayMs = Date.parse(`${d.day}T00:00:00Z`);
    return Number.isFinite(dayMs) && dayMs <= windowEnd && dayMs + 86_400_000 > windowStart;
  });
  const cost = { usd: 0, pricedTurns: 0, turns: 0, inputTokens: 0, outputTokens: 0 };
  for (const d of dailyInWindow) {
    cost.usd += (d.cost_input_usd ?? 0) + (d.cost_output_usd ?? 0) + (d.cost_cache_write_usd ?? 0) + (d.cost_cache_read_usd ?? 0);
    cost.turns += d.turns ?? 0;
    if (d.pricing_at !== null && d.pricing_at !== undefined) cost.pricedTurns += d.turns ?? 0;
    cost.inputTokens += d.usage_input ?? 0;
    cost.outputTokens += d.usage_output ?? 0;
  }
  cost.usd = Math.round(cost.usd * 10_000) / 10_000;

  const members = [...byMember.values()]
    .map((m) => {
      const reports = reportsByMember.get(m.memberId) ?? 0;
      // 应报 = 该报一条的回合数；缺报不为负（多报不算负缺口）。
      const expected = m.owing;
      const gap = Math.max(0, expected - reports);
      const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
      const sorted = m.queueWaitSamples.slice().sort((a, b) => a - b);
      const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.5)] : null;
      return {
        memberId: m.memberId,
        turns: m.turns,
        ok: m.ok,
        failed: m.failed,
        interrupted: m.interrupted,
        failureRate: rate(m.failed, m.turns),
        reportsExpected: expected,
        reportsFiled: reports,
        reportGap: gap,
        reportGapRate: rate(gap, expected),
        queueWaitMsP50: p50,
        queueWaitMsMax: m.queueWaitMsMax,
        queueWaitSamples: sorted.length,
      };
    })
    .sort((a, b) => a.memberId.localeCompare(b.memberId));

  const totalTurns = members.reduce((n, m) => n + m.turns, 0);

  // 判词。三种结果都显式：green / red / undet（含原因）。
  const reds = [];
  if (totalTurns < thresholds.minTurns) {
    return {
      windowStart,
      windowEnd,
      verdict: "undet",
      reason: totalTurns === 0 ? "no-turns-in-window" : "below-min-turns",
      thresholds,
      totals: { turns: totalTurns, members: members.length },
      cost,
      members,
      reds,
    };
  }
  for (const m of members) {
    if (m.failureRate !== null && m.failureRate > thresholds.failureRate) {
      reds.push({ memberId: m.memberId, criterion: "failure-rate", value: m.failureRate, limit: thresholds.failureRate });
    }
    if (m.reportGapRate !== null && m.reportGapRate > thresholds.reportGapRate) {
      reds.push({ memberId: m.memberId, criterion: "report-gap-rate", value: m.reportGapRate, limit: thresholds.reportGapRate });
    }
  }

  return {
    windowStart,
    windowEnd,
    verdict: reds.length ? "red" : "green",
    reason: null,
    thresholds,
    totals: { turns: totalTurns, members: members.length },
    cost,
    members,
    reds,
  };
}

/** 从一份 fleets.db 读数。默认只读打开：这个脚本永远不写库。
 *
 * 但 **WAL 只读陷阱**（bench-lane-freshness 2026-11-15 生产实测）成立：只读打开
 * 一个 WAL 库会读到**不含 -wal 内容的旧快照**，于是「最近的回合」看不见，读数
 * 看起来一片安静。所以给定 `walCopyDir` 时，先把 db/-wal/-shm 三件拷进去再以读写
 * 打开副本（SQLite 回放 WAL），生产库零写入。CronJob 走这条路；离线手跑可以不给。
 */
export function readFleet({ dbPath, fleetId, windowStart, windowEnd, thresholds = THRESHOLDS, walCopyDir = null }) {
  if (!fs.existsSync(dbPath)) return { ok: false, reason: "db-missing", dbPath };
  let openPath = dbPath;
  let options = { readonly: true, fileMustExist: true };
  if (walCopyDir) {
    const dest = path.join(walCopyDir, `${path.basename(path.dirname(path.dirname(dbPath)))}-${path.basename(dbPath)}`);
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = `${dbPath}${suffix}`;
      if (fs.existsSync(src)) fs.copyFileSync(src, `${dest}${suffix}`);
    }
    openPath = dest;
    options = { fileMustExist: true }; // 副本可写 ⇒ WAL 回放
  }
  const db = new Database(openPath, options);
  try {
    const has = (t) => db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    for (const t of ["member_turn_events", "member_reports", "member_turn_daily"]) {
      if (!has(t)) return { ok: false, reason: `table-missing:${t}` };
    }
    const turns = db
      .prepare("SELECT member_id, source, status, started_at, queue_wait_ms FROM member_turn_events WHERE fleet_id = ? AND started_at >= ? AND started_at <= ?")
      .all(fleetId, windowStart, windowEnd);
    const reports = db
      .prepare("SELECT member_id, source, created_at FROM member_reports WHERE fleet_id = ? AND created_at >= ? AND created_at <= ?")
      .all(fleetId, windowStart, windowEnd);
    const daily = db
      .prepare("SELECT member_id, day, turns, usage_input, usage_output, cost_input_usd, cost_output_usd, cost_cache_write_usd, cost_cache_read_usd, pricing_at FROM member_turn_daily WHERE fleet_id = ?")
      .all(fleetId);
    return { ok: true, readings: computeReadings({ turns, reports, daily, windowStart, windowEnd, thresholds }) };
  } catch (e) {
    return { ok: false, reason: `read-failed:${e.message}` };
  } finally {
    db.close();
  }
}

/**
 * 扫一整片 cells 根（CronJob 的形态）：每个 cell 一个 `data/data/fleets.db`。
 *
 * 只判**窗口内有回合**的舰队；没有回合的舰队单列成 idle（既不是绿也不是红——
 * 「今天没轮到它」不是健康读数）。一片可判的都没有 ⇒ undet，不是绿。
 * 有 cell 读不到（缺库/缺表/打不开）⇒ 计入 undecidable，最终至少 exit 2。
 */
export function scanCells({ cellsRoot, windowStart, windowEnd, thresholds = THRESHOLDS, walCopyDir = null }) {
  if (!fs.existsSync(cellsRoot)) return { ok: false, reason: "cells-root-missing", cellsRoot };
  const cells = fs
    .readdirSync(cellsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(cellsRoot, d.name));
  if (cells.length === 0) return { ok: false, reason: "no-cells", cellsRoot };

  const fleets = [];
  const undecidable = [];
  let idle = 0;
  let n = 0;
  for (const cellDir of cells) {
    const dbPath = path.join(cellDir, "data", "data", "fleets.db");
    if (!fs.existsSync(dbPath)) {
      // 「引导前」：旧代码没给这个 cell 建过库 ⇒ 那里不可能有舰队。事实，不是盲区。
      continue;
    }
    // 每个 cell 一份副本（同一次运行时按顺序覆盖同一个目录会串味，所以一次一个）。
    let probePath = dbPath;
    if (walCopyDir) {
      const dir = path.join(walCopyDir, `c${n++}`);
      fs.mkdirSync(dir, { recursive: true });
      probePath = path.join(dir, "fleets.db");
      for (const suffix of ["", "-wal", "-shm"]) {
        const src = `${dbPath}${suffix}`;
        if (fs.existsSync(src)) fs.copyFileSync(src, `${probePath}${suffix}`);
      }
    }
    let ids = [];
    try {
      const probe = new Database(probePath, walCopyDir ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
      try {
        ids = probe.prepare("SELECT id FROM fleets WHERE state = 'active'").all().map((r) => r.id);
      } finally {
        probe.close();
      }
    } catch (e) {
      undecidable.push({ cell: cellDir, reason: `fleets-read-failed:${e.message}` });
      continue;
    }
    for (const fleetId of ids) {
      const r = readFleet({ dbPath: probePath, fleetId, windowStart, windowEnd, thresholds });
      if (!r.ok) {
        // table-missing 在一个活跃舰队身上意味着这个 cell 从没有过回合记账 ⇒ 判不出
        undecidable.push({ cell: cellDir, fleetId, reason: r.reason });
        continue;
      }
      if (r.readings.totals.turns === 0) {
        idle += 1;
        continue;
      }
      fleets.push({ cell: cellDir, fleetId, readings: r.readings });
    }
  }

  const reds = fleets.flatMap((f) => f.readings.reds.map((red) => ({ ...red, fleetId: f.fleetId })));
  // 判词合成：红优先；没有红但有「判不出」的舰队（样本不足 / cell 读不到）⇒ 整体
  // 也是判不出。**不能因为其余舰队判绿就说整体绿**——「没判出问题」与「判不了」
  // 混成一个绿，正是这条读数存在的意义所在。
  const undetFleets = fleets.filter((f) => f.readings.verdict !== "green").length;
  const verdict = reds.length ? "red" : undetFleets || undecidable.length ? "undet" : fleets.length ? "green" : "undet";
  return {
    ok: true,
    cellsRoot,
    windowStart,
    windowEnd,
    verdict,
    fleets,
    idleFleets: idle,
    undecidable,
    reds,
  };
}

export function exitCodeFor(result) {
  if (!result.ok) return EXIT.UNDET;
  const v = result.readings?.verdict ?? result.verdict;
  return v === "green" ? EXIT.GREEN : v === "red" ? EXIT.RED : EXIT.UNDET;
}

function renderHuman(result) {
  if (!result.ok) return `undet — ${result.reason}`;
  if (result.readings) {
    const r = result.readings;
    const lines = [
      `fleet 判定读数 ${new Date(r.windowStart).toISOString()} → ${new Date(r.windowEnd).toISOString()}`,
      `判定: ${r.verdict}${r.reason ? ` (${r.reason})` : ""}  回合 ${r.totals.turns}  岗 ${r.totals.members}`,
      `成本: $${r.cost.usd}（有价回合 ${r.cost.pricedTurns}/${r.cost.turns}，未定价回合的成本是"不知道"不是 0）`,
    ];
    for (const m of r.members) {
      lines.push(
        `  ${m.memberId}: 回合 ${m.turns}（ok ${m.ok} / failed ${m.failed} / int ${m.interrupted}）` +
          `  失败率 ${m.failureRate ?? "-"}  应报 ${m.reportsExpected} 实报 ${m.reportsFiled} 缺 ${m.reportGap}` +
          `  队列等待 p50 ${m.queueWaitMsP50 ?? "-"}ms max ${m.queueWaitMsMax ?? "-"}ms（样本 ${m.queueWaitSamples}）`,
      );
    }
    for (const red of r.reds) lines.push(`  RED ${red.memberId} ${red.criterion}=${red.value} > ${red.limit}`);
    return lines.join("\n");
  }
  // cells 扫描形态
  const lines = [
    `舰队判定读数（cells 根 ${result.cellsRoot}）${new Date(result.windowStart).toISOString()} → ${new Date(result.windowEnd).toISOString()}`,
    `判定: ${result.verdict}  有回合的舰队 ${result.fleets.length}  窗口内无回合 ${result.idleFleets}  判不出 ${result.undecidable.length}`,
  ];
  for (const f of result.fleets) {
    lines.push(
      `  ${f.fleetId}: ${f.readings.verdict}${f.readings.reason ? `(${f.readings.reason})` : ""} 回合 ${f.readings.totals.turns} 成本 $${f.readings.cost.usd}（${f.cell}）`,
    );
  }
  for (const u of result.undecidable) lines.push(`  UNDET ${u.fleetId ?? ""} ${u.cell}: ${u.reason}`);
  for (const red of result.reds) lines.push(`  RED ${red.fleetId} ${red.memberId} ${red.criterion}=${red.value} > ${red.limit}`);
  return lines.join("\n");
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  let window;
  try {
    window = windowFromArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exit(EXIT.UNDET);
  }
  const cellsRoot = arg("--cells-root");
  if (cellsRoot) {
    let walCopyDir = null;
    if (!argv.includes("--no-wal-copy")) {
      walCopyDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-wal-"));
    }
    const result = scanCells({ cellsRoot: path.resolve(cellsRoot), ...window, walCopyDir });
    try {
      if (walCopyDir) fs.rmSync(walCopyDir, { recursive: true, force: true });
    } catch {}
    console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : renderHuman(result));
    process.exit(exitCodeFor(result));
  }

  const dbPath = arg("--db") || process.env.FLEET_DB_PATH;
  const fleetId = arg("--fleet");
  if (!dbPath || !fleetId) {
    console.error("usage: node scripts/fitness-read.mjs (--db <fleets.db> --fleet <fleetId> | --cells-root <dir>) [--hours 24 | --since <ms> [--until <ms>]] [--json]");
    process.exit(EXIT.UNDET);
  }
  const result = readFleet({ dbPath: path.resolve(dbPath), fleetId, ...window });
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : renderHuman(result));
  process.exit(exitCodeFor(result));
}

// `import.meta.url` 是 realpath 而 `argv[1]` 是调用者给的原样路径：macOS 上
// /tmp → /private/tmp，直接比较会恒为 false（脚本什么都不跑、退出码还是 0）。
// stdin 执行没有真 argv[1]（本机 undefined / pod 内 "-"），两种都必须算入口。
function isMain() {
  if (!process.argv[1] || process.argv[1] === "-") return true;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// ── 自证（夹具全在临时目录，不碰真库/网络） ──────────────────────────────────
//
// 每道判据都必须能红。这里造的是**假宇宙**：真 fleets.db 结构、假行。
// 六臂：绿 / 红（失败率）/ 红（缺报）/ 判不出（无回合）/ 判不出（一片 cell 都没有）
// / 引导前（有库无活跃舰队）。
export function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-selftest-"));
  const W0 = 1_700_000_000_000;
  const W1 = W0 + 3_600_000;
  const mkCell = (name, { fleets = [], turns = [], reports = [] }) => {
    const dir = path.join(root, name, "data", "data");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "fleets.db"));
    db.exec(`CREATE TABLE fleets (id TEXT PRIMARY KEY, name TEXT, owner_email TEXT, state TEXT);
             CREATE TABLE member_turn_events (id INTEGER PRIMARY KEY AUTOINCREMENT, fleet_id TEXT, member_id TEXT,
               source TEXT, status TEXT, started_at INTEGER, queue_wait_ms INTEGER);
             CREATE TABLE member_reports (id TEXT PRIMARY KEY, fleet_id TEXT, member_id TEXT, source TEXT, created_at INTEGER);
             CREATE TABLE member_turn_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, fleet_id TEXT, member_id TEXT, day TEXT,
               turns INTEGER, usage_input INTEGER, usage_output INTEGER, cost_input_usd REAL, cost_output_usd REAL,
               cost_cache_write_usd REAL, cost_cache_read_usd REAL, pricing_at INTEGER);`);
    for (const f of fleets) db.prepare("INSERT INTO fleets VALUES (?,?,'o@t','active')").run(f, f);
    for (const t of turns) {
      db.prepare("INSERT INTO member_turn_events (fleet_id, member_id, source, status, started_at, queue_wait_ms) VALUES (?,?,?,?,?,?)").run(
        t.fleetId, t.memberId ?? "m", t.source ?? "cron", t.status ?? "ok", t.startedAt ?? W0 + 1000, null,
      );
    }
    for (const r of reports) {
      db.prepare("INSERT INTO member_reports VALUES (?,?,?,?,?)").run(r.id, r.fleetId, r.memberId ?? "m", "self", r.createdAt ?? W0 + 1500);
    }
    db.close();
  };

  const six = Array.from({ length: 6 }, (_, i) => ({ fleetId: "f_ok", startedAt: W0 + 1000 + i }));
  const sixReports = six.map((_, i) => ({ id: `r${i}`, fleetId: "f_ok", createdAt: W0 + 1100 + i }));
  mkCell("green", { fleets: ["f_ok"], turns: six, reports: sixReports });
  mkCell("redfail", {
    fleets: ["f_bad"],
    turns: [...Array.from({ length: 4 }, (_, i) => ({ fleetId: "f_bad", startedAt: W0 + i })),
      ...Array.from({ length: 4 }, (_, i) => ({ fleetId: "f_bad", status: "failed", startedAt: W0 + 100 + i }))],
    reports: [],
  });
  mkCell("idle", { fleets: ["f_idle"], turns: [], reports: [] });

  // 每个用例独立一「片 cell 根」：`<root>/cell-<name>/data/data/fleets.db` 才是
  // 生产形状（cell 目录下再拼一层 data）。夹具直接铺在根下会一片都读不到，
  // 而「读不到」在真实运行里就是 exit 2——那会把绿用例误读成判据错。
  const runRoot = (name, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-run-"));
    fs.cpSync(path.join(root, name), path.join(dir, `cell-${name}`), { recursive: true });
    const r = scanCells({ cellsRoot: dir, windowStart: W0, windowEnd: W1, ...extra });
    fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };

  const arms = [];
  const check = (name, got, want) => arms.push({ name, ok: got === want, got, want });

  const green = runRoot("green");
  check("绿：全成功且报数齐 ⇒ exit 0", exitCodeFor(green), EXIT.GREEN);
  const red = runRoot("redfail");
  check("红：失败率越线 ⇒ exit 1", exitCodeFor(red), EXIT.RED);
  check("红：点名 criterion", red.reds.some((x) => x.criterion === "failure-rate") ? "yes" : "no", "yes");

  // 缺报：六个成功回合、零自报
  mkCell("redgap", { fleets: ["f_gap"], turns: six.map((t) => ({ ...t, fleetId: "f_gap" })), reports: [] });
  const gap = runRoot("redgap");
  check("红：六轮零报数 ⇒ exit 1", exitCodeFor(gap), EXIT.RED);
  check("红：点名缺报率", gap.reds.some((x) => x.criterion === "report-gap-rate") ? "yes" : "no", "yes");

  // 绿舰队 + 样本不足舰队混在同一根 ⇒ 整体判不出（「没判出问题」≠「判得了」）
  mkCell("mixedSmall", { fleets: ["f_small"], turns: [{ fleetId: "f_small", startedAt: W0 + 5 }], reports: [] });
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-mixed-"));
    fs.cpSync(path.join(root, "green"), path.join(dir, "cell-green"), { recursive: true });
    fs.cpSync(path.join(root, "mixedSmall"), path.join(dir, "cell-small"), { recursive: true });
    const mixed = scanCells({ cellsRoot: dir, windowStart: W0, windowEnd: W1 });
    fs.rmSync(dir, { recursive: true, force: true });
    check("绿 + 样本不足混在一根 ⇒ 整体判不出（不报绿）", exitCodeFor(mixed), EXIT.UNDET);
  }

  // 只有一个 idle 舰队 ⇒ 判不出（没轮到它 ≠ 健康）
  const idle = runRoot("idle");
  check("判不出：窗口内无回合 ⇒ exit 2", exitCodeFor(idle), EXIT.UNDET);

  // 空根 ⇒ 判不出
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-empty-"));
  const noCells = scanCells({ cellsRoot: empty, windowStart: W0, windowEnd: W1 });
  fs.rmSync(empty, { recursive: true, force: true });
  check("判不出：一片 cell 都没有 ⇒ exit 2", exitCodeFor(noCells), EXIT.UNDET);

  // 引导前：有 fleets.db 但没有活跃舰队 ⇒ 既不是绿也不是红，而是「没东西可判」
  mkCell("bootstrap", { fleets: [], turns: [], reports: [] });
  const boot = runRoot("bootstrap");
  check("引导前：无活跃舰队 ⇒ exit 2（不是绿）", exitCodeFor(boot), EXIT.UNDET);

  fs.rmSync(root, { recursive: true, force: true });
  const bad = arms.filter((a) => !a.ok);
  for (const a of arms) console.log(`  ${a.ok ? "✓" : "✗"} ${a.name}${a.ok ? "" : `（实际 ${a.got}，期望 ${a.want}）`}`);
  console.log(bad.length ? `self-test ${bad.length} 项不符` : "self-test 全过");
  return bad.length ? 1 : 0;
}

const SELF_TEST = process.argv.includes("--self-test");
if (SELF_TEST) process.exit(selfTest());
if (isMain()) main(process.argv.slice(2));
