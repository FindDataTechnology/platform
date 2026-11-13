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

// 三条闸门（判达标只看累计口径）
const g1 = post >= 20;
const g2 = post > 0 && postCat / post >= 0.9;
const g3 = deputyItems.length >= 5;
console.log(
  `GATE        ①量 ${post}/20 ${g1 ? "PASS" : "FAIL"} | ②非空率 ${pct(postCat, post)} ${g2 ? "PASS" : "FAIL"} | ③可裁 ${deputyItems.length}/5 ${g3 ? "PASS" : "FAIL"} => ${g1 && g2 && g3 ? "达标" : "未达标"}`,
);
