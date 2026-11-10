// 存量判例等级回填（默认 dry-run）
//
// 迁移时把存量一律记成 deputy-ruled 是过度保守：拍板车道里主人的裁决本身就是他
// 的判断——那条车道没有「代理起草、主人原样发出」这种情形。本脚本按行内**可证明**
// 的事实细分，并在没证据时保持保守。
//
//   node scripts/backfill-precedent-grades.mjs --db <fleets.db>            # 只报数
//   node scripts/backfill-precedent-grades.mjs --db <fleets.db> --apply    # 写入
//
// 判据（只用行里已有的列，不猜）：
//   退役 deputy 裁决                                   → deputy-ruled
//   主人裁决 + 无推荐值                                 → owner-authored（只能自己判断）
//   主人裁决 + 选择 ≠ 推荐                               → owner-authored（否决了代理倾向）
//   主人裁决 + 选择 = 推荐                               → deputy-ruled（分不清是否照抄）
//
// 安全闸：不加 --apply 一律只读；写入前打印逐桶计数；写入后回读校验。

import Database from "better-sqlite3";
import { classifyLegacyDecision } from "../lib/precedent-grade.js";

const argv = process.argv.slice(2);
const dbPath = argv[argv.indexOf("--db") + 1];
const apply = argv.includes("--apply");

if (!dbPath || dbPath.startsWith("--")) {
  console.error("usage: node scripts/backfill-precedent-grades.mjs --db <fleets.db> [--apply]");
  process.exit(2);
}

const db = new Database(dbPath);
const rows = db
  .prepare("SELECT id, resolved_by, recommendation, resolution, precedent_grade FROM decision_items")
  .all();

const buckets = new Map();
const changes = [];
for (const row of rows) {
  let resolution = null;
  try {
    resolution = row.resolution ? JSON.parse(row.resolution) : null;
  } catch {
    resolution = null;
  }
  const next = classifyLegacyDecision({
    resolvedBy: row.resolved_by,
    recommendation: row.recommendation,
    resolution,
  });
  const current = row.precedent_grade ?? "(none)";
  const key = `${current} → ${next}`;
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
  if (current !== next) changes.push({ id: row.id, next });
}

console.log(`库: ${dbPath}`);
console.log(`总行数: ${rows.length}`);
console.log("\n分级迁移:");
for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(40)} ${n}`);
}

const toCitable = changes.filter((c) => c.next !== "deputy-ruled").length;
console.log(`\n将变更: ${changes.length} 行（其中 ${toCitable} 行变为可引用）`);

if (!apply) {
  console.log("\n[dry-run] 未写入。加 --apply 生效。");
  db.close();
  process.exit(0);
}

const upd = db.prepare("UPDATE decision_items SET precedent_grade = ? WHERE id = ?");
const tx = db.transaction((items) => {
  for (const it of items) upd.run(it.next, it.id);
});
tx(changes);

// 回读校验：不再有 (none)，且分布符合预期
const after = db.prepare("SELECT precedent_grade g, COUNT(*) n FROM decision_items GROUP BY precedent_grade").all();
console.log("\n写入后分布:");
for (const r of after) console.log(`  ${String(r.g).padEnd(16)} ${r.n}`);
const missing = db.prepare("SELECT COUNT(*) n FROM decision_items WHERE precedent_grade IS NULL OR precedent_grade=''").get().n;
console.log(`未分级行: ${missing}`);
db.close();
process.exit(missing === 0 ? 0 : 1);
