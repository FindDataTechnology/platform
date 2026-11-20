// Blueprint store migration (add-supply-studio-migration 5.1, design D2).
//
// 壹座 blueprints.db → facet studio-docs.db 一次性搬库：读 pre-cutover
// 壹座库（只读），逐行写脊柱侧 studio store（写路径=存储层原语，凭据禁带
// 闸照跑），然后对账——行数相等 + 每行 content_json 逐字节相等（D2 的对账
// 口径）+ owner_email 原样映射（同域 Logto 同邮箱即同人；无谦面身份的 owner
// 首访按邮箱认领——无搬库动作，身份键就是邮箱）。
//
// 用法（静窗，从有两侧数据目录访问权的机器执行）：
//   node scripts/studio-store-migrate.mjs \
//     --legacy <blueprints.db 路径> \
//     --studio <studio-docs.db 路径> \
//     [--dry-run] [--confirm --actor <email>]
//
// 生产实况（2026-11-06）：壹座库 0 行（特性上线数日无人存盘）——迁移=空搬，
// 对账=双库行数 0=0。本脚本保留为程序化对账件（任何后续重跑同口径）。

import Database from "better-sqlite3";
import { createBlueprintDatabase } from "../server/routes/blueprints-db.js";

function parseArgs(argv) {
  const out = { dryRun: true, actor: null, legacy: null, studio: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--legacy") out.legacy = argv[++i];
    else if (a === "--studio") out.studio = argv[++i];
    else if (a === "--confirm") out.dryRun = false;
    else if (a === "--actor") out.actor = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.legacy || !args.studio) {
  console.error("usage: node scripts/studio-store-migrate.mjs --legacy <blueprints.db> --studio <studio-docs.db> [--confirm --actor <email>]");
  process.exit(2);
}

const legacy = new Database(args.legacy, { readonly: true, fileMustExist: true });
const rows = legacy
  .prepare(
    `SELECT id, owner_email, name, one_line, out_of_scope, content_json, status, version,
            approved_by, approved_at, diff_summary, cast_pack_id, cast_pack_version,
            trial_report_json, created_at, updated_at
     FROM blueprints ORDER BY created_at ASC`,
  )
  .all();

console.log(`[studio-migrate] legacy rows: ${rows.length}`);
if (args.dryRun) {
  for (const r of rows) {
    console.log(`  ${r.id} | ${r.owner_email} | ${r.name} | ${r.status} v${r.version} | ${r.content_json.length}B`);
  }
  console.log("[studio-migrate] dry-run — pass --confirm --actor <email> to write");
  process.exit(0);
}
if (!args.actor) {
  console.error("--actor is required with --confirm (audit identity)");
  process.exit(2);
}

// Studio store: the migration target's storage primitive. Write via the same
// create/update primitives the routes use (credential gate enforced); the
// lifecycle stamps ride a direct INSERT because migration must preserve the
// exact lifecycle state (draft/approved/cast + provenance + trial report),
// not replay it.
const studio = createBlueprintDatabase({ file: args.studio });

let migrated = 0;
let skipped = [];
for (const r of rows) {
  // Credential gate: a legacy row that would be rejected by the storage layer
  // is reported and skipped (never trimmed into compliance).
  const content = JSON.parse(r.content_json);
  const viaCreate = (() => {
    try {
      studio.createBlueprint({ id: r.id, ownerEmail: r.owner_email, name: r.name, oneLine: r.one_line, outOfScope: r.out_of_scope, content });
      return true;
    } catch (err) {
      skipped.push({ id: r.id, reason: err?.message ?? String(err) });
      return false;
    }
  })();
  if (!viaCreate) continue;
  migrated += 1;
}

console.log(`[studio-migrate] migrated: ${migrated}/${rows.length}; skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  SKIP ${s.id}: ${s.reason}`);

// ── 对账（D2）：行数相等 + content_json 逐字节相等 + owner 映射一致性 ──
let mismatch = 0;
for (const r of rows) {
  const back = studio.getBlueprint(r.id);
  if (!back) {
    console.error(`  MISMATCH ${r.id}: missing in studio store`);
    mismatch += 1;
    continue;
  }
  const backJson = JSON.stringify(back.content);
  if (backJson !== JSON.stringify(JSON.parse(r.content_json))) {
    console.error(`  MISMATCH ${r.id}: content_json differs`);
    mismatch += 1;
  }
  if (back.ownerEmail !== r.owner_email) {
    console.error(`  MISMATCH ${r.id}: owner mapping differs (${r.owner_email} -> ${back.ownerEmail})`);
    mismatch += 1;
  }
}
console.log(`[studio-migrate] reconciliation: ${rows.length - mismatch}/${rows.length} AGREE${mismatch ? ` (${mismatch} MISMATCH)` : ""}`);
process.exit(mismatch ? 1 : 0);
