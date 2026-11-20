#!/usr/bin/env node
// ── 个人代理启用闸门 · 只读观测探针 ──────────────────────────────────────────
//
// 为什么要在仓库里：这个探针此前每小时手写在 /tmp 再 cp 进 pod，被系统清掉过三次，
// 而且「tool 岗报错不计入真失败率」这条口径只写在文档里、没落进代码。口径和实现
// 分家就会各漂各的，所以固化。
//
// 用法（在 pod 内跑，因为要 /app 的 better-sqlite3）：
//   kubectl cp scripts/observe-personal-agent-gates.cjs <pod>:/tmp/probe.cjs -c platform
//   kubectl exec <pod> -c platform -- node /tmp/probe.cjs
//
// 本机跑（指向别处的数据根）：
//   BASE=/path/to/platform node scripts/observe-personal-agent-gates.cjs
//
// 三条纪律（来自 2026-11-10 反复踩坑后的裁决）：
//   1. 失败率拆两半：detail.reported=true 是「跑完被掐断」，不是「跑挂了」；
//   2. 判断只看上产后新增，不用 24h 全窗口（会被上产前老条目稀释）；
//   3. 判达标看 route=deputy 的累计条数，不看总数——总数里大头是硬锁主人的类别。
//
// 额外一条（2026-11-11 加）：tool 岗的 "Unknown agent preset" 单独成行、不计入真失败率。
// 原因：那不是「回合跑了但失败」，而是「这个岗位指向的 MCP server 不存在」——
// 零 token、秒级失败（实测 53 次/7 天、平均 1203ms），与模型/上下文/上游无关，
// 混进失败率会让读数长期被污染。
//
// 只读：所有 DB 都以 readonly 打开，除了 print 不写任何东西。

const path = require("node:path");
const fs = require("node:fs");

const BASE = process.env.BASE || "/app";
const DATA = process.env.CELLS_ROOT || "/data/cells";
// 首次上产时刻（累计口径基准）。env 可覆盖，便于换基线重算。
const DEPLOY = Number(process.env.DEPLOY_MS || Date.parse("2026-11-10T05:25:00+08:00"));
const TURN_WINDOW_H = Number(process.env.TURN_WINDOW_H || 6);
// `detail.cause` 的出现时刻基线（fix-context-attribution-window 5.2）。
// 缺省＝把 `detail.cause` 写进产线的那一笔落 main 的时刻（`3e59fbe29`，2026-11-10
// 03:03+08＝11-09T19:03Z）。它**早于**实际上产，所以这条分母偏宽、只会少算非空率，
// 不会把没上产的行算成已上产——判决方向是保守的那一侧。env 可覆盖。
const CAUSE_SINCE = Number(process.env.CAUSE_SINCE_MS || Date.parse("2026-11-09T19:03:13Z"));

let Database;
try {
  Database = require(path.join(BASE, "node_modules", "better-sqlite3"));
} catch (e) {
  console.error(`无法加载 better-sqlite3（BASE=${BASE}）：${e.message}`);
  process.exit(2);
}

const now = Date.now();
const turnSince = now - TURN_WINDOW_H * 3600e3;

// ── 累计口径 ────────────────────────────────────────────────────────────────
let totAll = 0,
  catAll = 0;
let post = 0,
  postCat = 0;
let d24 = 0,
  d24Cat = 0;
const byRoute = {},
  byRoute24 = {},
  byCat = {};
const deputyItems = [];
const deputyItems24 = [];

// ── 回合口径 ────────────────────────────────────────────────────────────────
let turns = 0,
  failed = 0,
  reportedCut = 0;
let toolPresetErrors = 0; // 单独一行：tool 岗指向的 server 不存在
const realErrs = {};

// ── 上下文压力归因口径（`detail.cause`，fix-context-attribution-window 5.2）──
// 「压力失败行」的定义照 spec：`detail.contextPressure === true` 的失败行。
// 这一节独立于上面的 6h 回合窗口——cause 是全历史台账，只在 6h 窗口里数是数不到的
// （实测 2026-11-17：141 行压力失败、55 行带 cause，全部落在 11-10→11-11）。
// 分母为 0 时打「判不出」而不是 ✗：没有压力失败行 ≠ 归因坏了（同族于
// 「零活人口让『没人装载』与『没有东西可装载』同形」）。
let pressRows = 0,
  pressWithCause = 0,
  pressPost = 0,
  pressPostWithCause = 0;
const causeDist = {};
const pressureKeys = {};
let causeFirst = null,
  causeLast = null;

const cells = fs.existsSync(DATA) ? fs.readdirSync(DATA) : [];

for (const c of cells) {
  const dbPath = path.join(DATA, c, "data", "data", "fleets.db");
  if (!fs.existsSync(dbPath)) continue;
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    continue;
  }

  // 岗位表：标题 + 承载类型（判 tool 岗要它）
  const who = {};
  try {
    for (const m of db.prepare("SELECT id, title, target_kind FROM fleet_members").all()) {
      who[m.id] = m;
    }
  } catch {
    /* 老库没有该列 */
  }

  // 决策项：累计 + 近 24h 两个窗口
  try {
    for (const it of db
      .prepare("SELECT member_id, category, route, submitted_at FROM decision_items")
      .all()) {
      totAll += 1;
      if (it.category) catAll += 1;
      const ts = Number(it.submitted_at);
      const r = it.route || "(null)";
      if (ts >= DEPLOY) {
        post += 1;
        if (it.category) postCat += 1;
        byRoute[r] = (byRoute[r] || 0) + 1;
        const k = `${it.category || "(null)"}->${r}`;
        byCat[k] = (byCat[k] || 0) + 1;
        if (r === "deputy") {
          deputyItems.push(`${String(who[it.member_id]?.title || "?").slice(0, 8)}|${it.category || "-"}`);
        }
      }
      if (ts >= now - 24 * 3600e3) {
        d24 += 1;
        if (it.category) d24Cat += 1;
        byRoute24[r] = (byRoute24[r] || 0) + 1;
        if (r === "deputy") {
          deputyItems24.push(`${String(who[it.member_id]?.title || "?").slice(0, 8)}|${it.category || "-"}`);
        }
      }
    }
  } catch {
    /* 无 decision_items 的 cell */
  }

  // 回合：失败拆两半，tool 岗 preset 错单独计
  try {
    for (const r of db
      .prepare("SELECT member_id, status, error, detail FROM member_turn_events WHERE started_at >= ?")
      .all(turnSince)) {
      turns += 1;
      if (r.status !== "failed") continue;
      failed += 1;
      let reported = false;
      try {
        reported = JSON.parse(r.detail || "{}").reported === true;
      } catch {
        /* detail 不是 JSON：当作未报数 */
      }
      const isToolPreset =
        typeof r.error === "string" &&
        r.error.includes("Unknown agent preset") &&
        who[r.member_id]?.target_kind === "tool";
      if (isToolPreset) {
        toolPresetErrors += 1;
        continue; // 不计入真失败率
      }
      if (reported) {
        reportedCut += 1;
        continue;
      }
      const key = String(r.error || "-").slice(0, 44);
      realErrs[key] = (realErrs[key] || 0) + 1;
    }
  } catch {
    /* 无 member_turn_events */
  }

  // 上下文压力归因：**不带 6h 时间过滤**（cause 是历史台账，窗口一收就永远是 0）
  try {
    for (const r of db
      .prepare(
        "SELECT started_at, detail FROM member_turn_events WHERE status = 'failed' AND instr(coalesce(detail,''), 'contextPressure') > 0",
      )
      .all()) {
      let d;
      try {
        d = JSON.parse(r.detail || "{}");
      } catch {
        continue; // detail 不是 JSON ⇒ 不是归因行，不计入分母
      }
      if (d.contextPressure !== true) continue; // 串里出现字样但字段不是 true，不算压力失败行
      pressRows += 1;
      const ts = Number(r.started_at);
      if (ts >= CAUSE_SINCE) pressPost += 1;
      if (d.cause) {
        pressWithCause += 1;
        causeDist[d.cause] = (causeDist[d.cause] || 0) + 1;
        if (ts >= CAUSE_SINCE) pressPostWithCause += 1;
        if (causeFirst === null || ts < causeFirst) causeFirst = ts;
        if (causeLast === null || ts > causeLast) causeLast = ts;
      } else {
        for (const k of Object.keys(d)) pressureKeys[k] = (pressureKeys[k] || 0) + 1;
      }
    }
  } catch {
    /* 无 member_turn_events */
  }

  db.close();
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : "n/a");
const realFailed = failed - reportedCut - toolPresetErrors;

console.log(
  `POSTDEPLOY  累计(≥${new Date(DEPLOY).toISOString().slice(0, 16)}Z) 新增 ${post} 条，带 category ${postCat} 条，非空率 ${pct(postCat, post)}`,
);
console.log(`LAST24H     近24h 新增 ${d24} 条，带 category ${d24Cat} 条，非空率 ${pct(d24Cat, d24)}`);
console.log(`ROUTE_CUM   ${JSON.stringify(byRoute)}`);
console.log(`ROUTE_24H   ${JSON.stringify(byRoute24)}`);
console.log(`BYCAT       ${JSON.stringify(byCat)}`);
console.log(
  `TURNS       近${TURN_WINDOW_H}h 回合 ${turns}，失败 ${failed}，其中已报数被早停 ${reportedCut}，tool岗preset错 ${toolPresetErrors}（不计）`,
);
console.log(`REALFAIL    真失败 ${realFailed}，真失败率 ${pct(realFailed, turns)}`);
console.log(
  `ERR_REAL    ${Object.entries(realErrs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}(${v})`)
    .join(" | ") || "(无)"}`,
);
console.log(`DEPUTY_CUM  ${deputyItems.length} ${deputyItems.join(" , ")}`);
console.log(`DEPUTY_24H  ${deputyItems24.length} ${deputyItems24.join(" , ")}`);
console.log(`ALL         全库 ${totAll} 条，带 category ${catAll} 条`);

// ── 上下文压力归因（`detail.cause`）────────────────────────────────────────
{
  const iso = (t) => (t ? new Date(t).toISOString().slice(5, 16).replace("T", " ") + "Z" : "-");
  const dist = Object.entries(causeDist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}(${v})`)
    .join(" | ");
  console.log(
    `CAUSE       压力失败行 ${pressRows}，带 cause ${pressWithCause}（${pct(pressWithCause, pressRows)}）；` +
      `基线(${iso(CAUSE_SINCE)}，早于上产)后 ${pressPost} 行里 ${pressPostWithCause} 行带 cause` +
      (dist ? `；分布 ${dist}` : ""),
  );
  if (pressWithCause > 0) {
    console.log(`CAUSE_RANGE 首个带 cause ${iso(causeFirst)} → 末个 ${iso(causeLast)}`);
  }
  if (pressRows === 0) {
    console.log("CAUSE_VERDICT 判不出：全库没有压力失败行（分母 0）——这与「归因坏了」在 0/0 上同形");
  } else if (pressWithCause === 0) {
    const keys = Object.keys(pressureKeys).slice(0, 8).join(",") || "(detail 里没有键)";
    console.log(
      `CAUSE_VERDICT ✗ 压力失败行 ${pressRows} 行、带 cause 0 行——归因没有落库（缺 cause 的行现有键：${keys}）`,
    );
  } else {
    console.log(`CAUSE_VERDICT ✓ 归因在落库（${pressWithCause}/${pressRows}）`);
  }
}

// 三条闸门（判达标只看累计口径）
const g1 = post >= 20;
const g2 = post > 0 && postCat / post >= 0.9;
const g3 = deputyItems.length >= 5;
console.log(
  `GATE        ①量 ${post}/20 ${g1 ? "PASS" : "FAIL"} | ②非空率 ${pct(postCat, post)} ${g2 ? "PASS" : "FAIL"} | ③可裁 ${deputyItems.length}/5 ${g3 ? "PASS" : "FAIL"} => ${g1 && g2 && g3 ? "达标" : "未达标"}`,
);
