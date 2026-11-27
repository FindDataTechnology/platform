#!/usr/bin/env node
// ── 在架条目显示字段缺口巡检（surface-display-field-gaps 的巡检面）────────────
//
// 读 LIVE 市场读面，逐包统计 v2 显示字段缺哪几个，按缺口数降序打印。
// 与 audit-official-locale-coverage.mjs 同一姿态：只读、不改、缺口即非零退出。
//
// 为什么需要这条巡检而不是只看 #/curate 页面：
//   · 那个页面要登录 + 是人主动去看的；缺口恰恰是「没人注意到」才存在的；
//   · 这条能进定时巡检/出片前闸，让「208 个包全都缺」自己浮出来。
//
// 判据与 registry.displayFieldGaps / lib/pack-manifest.js::DISPLAY_FIELDS 同源
// ——三个面（页面、路由、巡检）共用一个闭集，不在脚本里另抄一份。
//
//   node scripts/audit-display-field-gaps.mjs
//   node scripts/audit-display-field-gaps.mjs --base=https://facet.finddatatech.cloud
//   node scripts/audit-display-field-gaps.mjs --limit=30 --json

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const BASE = args.get("base") || "https://facet.finddatatech.cloud";
const LIMIT = Number(args.get("limit") || 40);
const JSON_OUT = args.get("json") === "true";

/** The closed set, mirrored here ONLY as a fallback when the module is not
 *  resolvable (this script is also run against a snapshot tree). The live path
 *  prefers the real module so a field added there shows up here for free. */
async function displayFields() {
  try {
    const mod = await import("../lib/pack-manifest.js");
    if (Array.isArray(mod.DISPLAY_FIELDS)) return mod.DISPLAY_FIELDS;
  } catch {
    /* fall through */
  }
  return ["identity", "promise", "audience", "outcomes", "examples", "domain"];
}

async function liveRows() {
  const out = [];
  const pageSize = 100;
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${BASE}/api/packs?page=${page}&pageSize=${pageSize}`);
    if (!res.ok) throw new Error(`GET /api/packs page ${page} → ${res.status}`);
    const body = await res.json();
    out.push(...(body.packs ?? []));
    if (out.length >= (body.total ?? 0) || (body.packs ?? []).length < pageSize) break;
  }
  return out;
}

async function main() {
  const fields = await displayFields();
  // The list face carries the display block only when the pack declares one
  // (pack-display-format 透传规则) — absence of the block IS absence of every
  // field. So a row with no `display` counts as missing all of them; that is
  // exactly the gap this audit exists to surface.
  const rows = await liveRows();
  // 口径要写清：这里数的是「读者能看到的条目」（列表面），不是 DB 里的全部
  // ——后者含 unlisted/私有，实测 208 vs 142。两个数都真，但意义不同；把口径
  // 埋在代码里，下一次读报告的人会拿错数比。
  const gaps = rows.map((p) => {
    const d = p.display ?? {};
    // `domain` is NOT a manifest display field and never rides the `display`
    // block — it is the curation column `packs.domains` (setCuration), surfaced
    // on the row as `domains`. Reading it from `display` reports 100% missing
    // forever, which is what this audit did until 2026-11-24.
    const missing = fields.filter((f) => (f === "domain" ? (p.domains ?? []).length === 0 : d[f] === undefined));
    return { id: p.id, name: p.name, missing, gapCount: missing.length };
  });

  const perField = Object.fromEntries(fields.map((f) => [f, gaps.filter((g) => g.missing.includes(f)).length]));
  const total = gaps.length;
  const fullyDeclared = gaps.filter((g) => g.gapCount === 0).length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ total, fullyDeclared, perField, rows: gaps }, null, 2));
    return total > 0 && fullyDeclared === 0 ? 1 : 0;
  }

  console.log(`在架条目（列表面，不含未上架/私有）：${total}　显示字段全声明：${fullyDeclared}`);
  console.log("  注：DB 里的条目数更多（实测 208 vs 142）；这里只数读者真能看到的那些。");
  console.log("逐字段缺失：");
  for (const f of fields) {
    const n = perField[f];
    const pct = total ? Math.round((n / total) * 100) : 0;
    console.log(`  ${f.padEnd(10)} ${String(n).padStart(4)} / ${total}  (${pct}%)`);
  }

  const worst = gaps.filter((g) => g.gapCount > 0).sort((a, b) => b.gapCount - a.gapCount).slice(0, LIMIT);
  if (worst.length) {
    console.log(`\n缺口最多的 ${worst.length} 个（按缺口数降序）：`);
    for (const g of worst) console.log(`  ${g.gapCount}  ${g.name}  ← ${g.missing.join(", ")}`);
  }

  // 退出码的判据是**退步**，不是「还缺」。
  //
  // 「142 个条目全都缺」是一个已知的内容现状，不是缺陷：把它做成长期红，闸就会
  // 被无视（同族纪律见 constraints/criterion-must-fire-on-real-data——一个恒红的
  // 判据等于没有判据）。所以基线记在 --baseline，只有当「全声明数」比上次更少、
  // 或某个字段的缺失面变大时才非零退出。首次运行用 --write-baseline 落基线。
  const BASELINE = args.get("baseline") || "scripts/display-field-gaps-baseline.json";
  const WRITE = args.get("write-baseline") === "true";
  const current = { total, fullyDeclared, perField };
  if (WRITE) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
    console.log(`\n基线已写入 ${BASELINE}`);
    return;
  }

  let prev = null;
  try {
    const { readFileSync } = await import("node:fs");
    prev = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    /* 没有基线：只报告，不判红 —— 第一次运行不该拦人。 */
  }
  if (!prev) {
    console.log("\n（无基线，仅报告。用 --write-baseline 落一条。）");
    return;
  }
  const regressions = [];
  if (fullyDeclared < (prev.fullyDeclared ?? 0)) {
    regressions.push(`显示字段全声明的条目 ${prev.fullyDeclared} → ${fullyDeclared}`);
  }
  for (const f of fields) {
    if ((perField[f] ?? 0) > (prev.perField?.[f] ?? 0)) {
      regressions.push(`${f} 缺失面 ${prev.perField?.[f]} → ${perField[f]}`);
    }
  }
  if (regressions.length) {
    console.error("\n✗ 显示字段缺口退步：");
    for (const r of regressions) console.error(`  · ${r}`);
    console.error("  市场卡片的承诺位会更常退回描述首句。逐包入口：#/curate 的「显示字段缺失」面板。");
    process.exitCode = 1;
  } else {
    console.log("\n✓ 相对基线无退步。");
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(2);
});
