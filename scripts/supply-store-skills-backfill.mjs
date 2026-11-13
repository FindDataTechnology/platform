#!/usr/bin/env node
// supply-store-skills-backfill.mjs — skills 物种迁移补课（add-supply-store-unification 4.3 修复）。
//
// 背景：2026-11-07 对账（4.3）发现迁移器只迁了 mcp_servers（dump 26/26），skills 物种
// 从未入 spine——facet /api/skills-catalog 匿名面从 bridge 时代 265 掉到 0，registry
// 副本（SPINE_REPLICA_MODE=1）同步受染。真值源 = cheap-1 退役 compose Mongo 卷
// （mcp-gateway-registry_mongodb-data，agent_skills_default 212 行，mongosh 导出
// /tmp/skills-dump.json）。本脚本把该 dump 经写闸 upsertSkill 回填 spine，
// 字段映射与 scripts/supply-store-migrate.mjs 的 mapSkillRow 完全同口径
// （skillEntryName = path 末段 bridge-identical）。
//
// 用法：
//   node scripts/supply-store-skills-backfill.mjs --dump /tmp/skills-dump.json \
//     --base http://10.43.71.119:3200 --token <SUPPLY_STORE_WRITE_TOKEN> [--dry-run]
//
// 幂等：写闸 upsertSkill ON CONFLICT(name) DO UPDATE，重复跑安全。
// 单向铁律：本脚本只 POST 写闸，不读运行态、不驱动任何实例行为。

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const DUMP = opt("--dump");
const BASE = (opt("--base") || "").replace(/\/+$/, "");
const TOKEN = opt("--token") || "";
const DRY = args.includes("--dry-run");
if (!DUMP || !BASE || !TOKEN) {
  console.error("usage: supply-store-skills-backfill.mjs --dump <file> --base <write-gate> --token <token> [--dry-run]");
  process.exit(2);
}

// ── bridge-identical mapping (same as supply-store-migrate.mjs) ─────────────
const pathToName = (p) => String(p || "").split("/").filter(Boolean).join("-");
const skillEntryName = (row) => {
  const seg = String(row?.path ?? row?._id ?? row?.name ?? "").split("/").filter(Boolean).pop();
  return pathToName(seg);
};

const rows = JSON.parse(readFileSync(DUMP, "utf8"));
console.log(`dump: ${rows.length} row(s)`);

// Dry-run field validation first (SUPPLY_UNKNOWN_FIELD is a hard 400).
const SKILL_COLUMNS = new Set([
  "name", "display_name", "description", "repository_url", "author", "version",
  "tags", "license", "metadata", "visibility", "groups", "is_enabled",
]);
const entries = [];
let bad = 0;
for (const doc of rows) {
  const name = skillEntryName(doc);
  if (!name) { bad += 1; continue; }
  const entry = {
    name,
    display_name: doc.name || name,
    description: doc.description ?? null,
    repository_url: doc.repository_url ?? null,
    author: doc.metadata?.author ?? doc.author ?? null,
    version: doc.metadata?.version ?? doc.version ?? null,
    tags: Array.isArray(doc.tags) ? doc.tags : null,
    license: doc.license ?? null,
    metadata: doc.metadata ?? null,
    visibility: doc.visibility ?? null,
    groups: [], // registry-groups.json retired (unification 2.x): spine-native column, unmapped ⇒ []
    is_enabled: doc.is_enabled === undefined ? true : Boolean(doc.is_enabled),
  };
  const unknown = Object.keys(entry).filter((k) => !SKILL_COLUMNS.has(k));
  if (unknown.length) { console.error(`UNKNOWN field(s) ${unknown.join(",")} on ${name} — aborting`); process.exit(1); }
  entries.push(entry);
}
console.log(`mapped: ${entries.length} ok, ${bad} skipped (no name)`);
const vis = {};
for (const e of entries) vis[e.visibility ?? "null"] = (vis[e.visibility ?? "null"] ?? 0) + 1;
console.log("visibility:", JSON.stringify(vis));
if (DRY) { console.log("dry-run: no writes performed"); process.exit(0); }

// ── write-gate fan-out (bounded concurrency) ────────────────────────────────
let ok = 0, fail = 0;
const CONC = 6;
for (let i = 0; i < entries.length; i += CONC) {
  const batch = entries.slice(i, i + CONC);
  await Promise.all(batch.map(async (entry) => {
    try {
      const res = await fetch(`${BASE}/api/supply-store/skills/upsert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ actor: "migration-skills-backfill", source: "migration", entry }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) ok += 1;
      else {
        fail += 1;
        const detail = (await res.text()).slice(0, 160);
        console.error(`FAIL ${entry.name}: HTTP ${res.status} ${detail}`);
      }
    } catch (err) {
      fail += 1;
      console.error(`FAIL ${entry.name}: ${err?.message ?? err}`);
    }
  }));
}
console.log(`done: ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
