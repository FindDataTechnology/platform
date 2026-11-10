// 个人代理就绪检查（只读）
//
//   node scripts/personal-agent-doctor.mjs                      # 本机默认数据目录
//   node scripts/personal-agent-doctor.mjs --db <fleets.db> --fleet <id>
//
// 退出码：0 = 可跑（可能带 warn）；1 = 有 blocked 项。
// 它回答的问题只有一个：**现在这套东西能不能用**；不能的话缺哪一条、怎么补。

import Database from "better-sqlite3";
import { assessPersonalAgent } from "../lib/personal-agent-readiness.js";
import { normalizeMandatePolicy } from "../lib/personal-mandate.js";

const argv = process.argv.slice(2);
const dbPath = argv.includes("--db") ? argv[argv.indexOf("--db") + 1] : new URL("../data/fleets.db", import.meta.url).pathname;
const fleetId = argv.includes("--fleet") ? argv[argv.indexOf("--fleet") + 1] : null;

const db = new Database(dbPath, { readonly: true });
const get = (sql, ...p) => {
  try {
    return db.prepare(sql).get(...p);
  } catch {
    return null;
  }
};
const all = (sql, ...p) => {
  try {
    return db.prepare(sql).all(...p);
  } catch {
    return [];
  }
};

// 委托状（cell 默认，或指定舰队覆写）
let raw = null;
if (fleetId) {
  raw = get("SELECT delegation_policy v FROM fleets WHERE id = ?", fleetId)?.v ?? null;
} else {
  raw = get("SELECT value v FROM cell_settings WHERE key='delegationPolicy'")?.v ?? null;
}
let mandate = { version: 2, domains: {} };
if (raw) {
  try {
    const parsed = JSON.parse(raw);
    const norm = normalizeMandatePolicy(parsed);
    mandate = norm.ok ? norm.policy : mandate;
  } catch {
    /* 坏配置按未配置处理：宁可报「没配」，也不要假装读到了 */
  }
}

const mapRaw = get("SELECT value v FROM cell_settings WHERE key='personalDomainMap'")?.v ?? null;
let domainMap = [];
try {
  domainMap = mapRaw ? JSON.parse(mapRaw) : [];
} catch {
  domainMap = [];
}

const hasAuditor = all("SELECT target_kind FROM fleet_members").some((r) => r.target_kind === "auditor");
const citable = all(
  "SELECT id FROM decision_items WHERE precedent_grade IN ('owner-authored','owner-approved')",
).length;

const levelSamples = {};
for (const r of all(
  "SELECT disclose_level l, COUNT(*) n FROM action_audit WHERE audience IS NOT NULL AND disclose_level IS NOT NULL GROUP BY disclose_level",
)) levelSamples[r.l] = r.n;

const consistency = {};
for (const d of Object.keys(mandate.domains ?? {})) {
  const rows = all(
    "SELECT recommendation, resolution, state FROM decision_items WHERE resolved_by='owner' AND domain = ? AND state IN ('approved','rejected') AND recommendation IS NOT NULL AND recommendation <> ''",
    d,
  );
  let samples = 0;
  let agrees = 0;
  for (const r of rows) {
    let choice = null;
    try {
      choice = r.resolution ? JSON.parse(r.resolution)?.choice ?? null : null;
    } catch {
      choice = null;
    }
    samples += 1;
    if (r.state === "approved" && choice === r.recommendation) agrees += 1;
  }
  consistency[d] = { samples, agrees, rate: samples === 0 ? null : agrees / samples };
}

const result = assessPersonalAgent({
  mandate,
  domainMap,
  hasAuditor,
  verdictTokenConfigured: Boolean(String(process.env.MANDATE_VERDICT_TOKEN ?? "").trim()),
  citablePrecedents: citable,
  levelSamples,
  consistency,
});

console.log(`库: ${dbPath}${fleetId ? ` · 舰队 ${fleetId}` : ""}`);
console.log(`结论: ${result.verdict}\n`);
for (const item of result.items) {
  const mark = item.ok ? "✓" : item.severity === "blocked" ? "✗" : "!";
  console.log(`${mark} ${item.title}`);
  console.log(`    ${item.detail}`);
  if (!item.ok) console.log(`    → ${item.fix}`);
}
db.close();
process.exitCode = result.ready ? 0 : 1;
