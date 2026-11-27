#!/usr/bin/env node
// ── 领域轴回填迁移 (overhaul-market-catalog-presentation P1 2.8) ──────────────
//
// 把历史 `category` slug 按保守归位表推导出的领域集合写入 packs.domains
// （JSON 数组）。三类不碰：
//   · 已经声明过 domains 的行（策展/发布写过的就是真值，迁移不覆盖）；
//   · 推导不出领域的类目（供给线 slug 不猜领域 → 保持未归类，进策展待办）；
//   · `category` 列本身（零迁移：逐字节不变）。
//
// 用法：
//   node scripts/migrate-pack-domains.mjs --db data/packs.db            # dry-run（默认）
//   node scripts/migrate-pack-domains.mjs --db data/packs.db --apply    # 落盘
//
// 生产库取法（运维文档既有配方）：
//   kubectl --context cheap -n fd-prod cp <facet-pod>:/data/facet/packs.db ./packs.db
//   迁移完再 cp 回去之前先停 pod 或确认无人写（facet 单副本、WAL）。

import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { domainsForCategory, domainLabelOf } from "../lib/pack-taxonomy.js";

/** Dry-run plan: one row per pack that WOULD receive a domain set. */
export function planBackfill(db) {
  const rows = db
    .prepare(
      `SELECT p.id, p.category, p.domains, v.name
         FROM packs p
         LEFT JOIN pack_versions v ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)`,
    )
    .all();
  const planned = [];
  const alreadyDeclared = [];
  const unclassified = [];
  for (const r of rows) {
    if (r.domains) {
      alreadyDeclared.push(r);
      continue;
    }
    const domains = domainsForCategory(r.category ?? "");
    if (domains.length === 0) {
      unclassified.push(r);
      continue;
    }
    planned.push({ ...r, domains });
  }
  return { planned, alreadyDeclared, unclassified, total: rows.length };
}

/** Apply the plan. Returns the number of rows written. Only NULL-domains rows
 *  whose derivation is non-empty are touched; `category` is never written. */
export function applyBackfill(db, plan) {
  const stmt = db.prepare(`UPDATE packs SET domains = ? WHERE id = ? AND domains IS NULL`);
  let written = 0;
  const tx = db.transaction((rows) => {
    for (const r of rows) written += stmt.run(JSON.stringify(r.domains), r.id).changes;
  });
  tx(plan.planned);
  return written;
}

function printReport(plan, locale) {
  const label = (slug) => domainLabelOf(slug, locale);
  console.log(`pack 总数: ${plan.total}`);
  console.log(`将回填: ${plan.planned.length}`);
  for (const r of plan.planned) {
    console.log(`  ${r.id}  ${r.name ?? "(no version)"}  ${r.category} → [${r.domains.map(label).join(", ")}]`);
  }
  console.log(`已声明（跳过）: ${plan.alreadyDeclared.length}`);
  for (const r of plan.alreadyDeclared) console.log(`  ${r.id}  ${r.name ?? ""}  ${r.domains}`);
  console.log(`未归类（保持，进策展待办）: ${plan.unclassified.length}`);
  for (const r of plan.unclassified) console.log(`  ${r.id}  ${r.name ?? ""}  category=${JSON.stringify(r.category ?? "")}`);
}

function main(argv) {
  const dbArg = argv.find((a) => a.startsWith("--db="))?.slice(5) ?? (argv.indexOf("--db") >= 0 ? argv[argv.indexOf("--db") + 1] : "");
  const apply = argv.includes("--apply");
  const locale = (argv.find((a) => a.startsWith("--locale="))?.slice(9) ?? "zh").toLowerCase();
  if (!dbArg) {
    console.error("usage: node scripts/migrate-pack-domains.mjs --db <packs.db> [--apply] [--locale=en]");
    process.exit(2);
  }
  const db = new Database(dbArg);
  try {
    const plan = planBackfill(db);
    printReport(plan, locale);
    if (!apply) {
      console.log("\n[dry-run] 未写盘。确认清单后加 --apply 落盘。");
      return;
    }
    const written = applyBackfill(db, plan);
    console.log(`\n[applied] 写入 ${written} 行 domains（category 列零改动）。`);
  } finally {
    db.close();
  }
}

// Import-safe: the CLI body runs only when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
