#!/usr/bin/env node
// ── Facade corpus snapshot (add-principal-facade 6.1) ────────────────────────
//
// Refreshes the 寻数分身 pack's fast-stale corpus (projects) from live
// in-repo sources and re-stamps every corpus skill's as-of line:
//   - corpus-projects: milestone statuses extracted from the 双星 roadmap's
//     exit-criteria table + in-flight openspec changes (`openspec list --json`).
//   - corpus-company: hand-curated, slow-moving — left untouched (the pack's
//     own notes say so; edit the manifest directly when it drifts).
//   - corpus-capabilities: the live pack shelf lives in the production packs
//     DB, not this repo — the script re-stamps as-of and prints a curation
//     reminder instead of inventing content.
//
// The script only rewrites the manifest file; publishing a new version (and
// the in-service redeploy) stay on the normal publish path — refresh
// discipline is weekly by default, diff reviewed by a human before publish.
//
//   node scripts/facade-corpus-snapshot.mjs [--dry]

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packs", "finddata-facade", "manifest.json");
const dry = process.argv.includes("--dry");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const asOf = new Date().toISOString().slice(0, 10);

// ── Source: 双星 roadmap exit-criteria table ────────────────────────────────
// Rows look like "| M1 | ≥5 内部 pack 周活跃 | ✅ | evidence…|" — pull the
// milestone, the criterion, and the status cell (✅ / ◐ / 未采).
function roadmapStatuses() {
  const md = readFileSync(path.join(root, "docs", "facet-wanxing-roadmap.md"), "utf8");
  const rows = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(✅|◐|未采)?\s*\|/);
    if (!m) continue;
    const [_, ms, criterion, status] = m;
    if (!/^(M\d|F\d)/.test(ms.trim())) continue;
    rows.push(`- ${ms.trim()}（${criterion.trim()}）：${status?.trim() ?? "（无标记）"}`);
  }
  return rows;
}

// ── Source: in-flight openspec changes ──────────────────────────────────────
function inFlightChanges() {
  try {
    const out = execFileSync("openspec", ["list", "--json"], { cwd: root, encoding: "utf8" });
    return JSON.parse(out).changes.map(
      (c) => `- ${c.name}（${c.completedTasks}/${c.totalTasks}，${c.status}）`,
    );
  } catch {
    return ["- （openspec 不可用，本次快照未纳入在途变更）"];
  }
}

const skill = (name) => manifest.skills.find((s) => s.name === name);
const changed = [];

// corpus-projects: full regeneration from live sources.
const projects = skill("corpus-projects");
if (projects) {
  const prev = projects.content;
  projects.content = [
    `# 项目语料（语料截至 ${asOf}；快照脚本自动生成，人工复核后随新版本发布）`,
    "",
    "## 里程碑出口判据（双星路线图对账表）",
    "",
    ...roadmapStatuses(),
    "",
    "## 在途变更（openspec 实时口径）",
    "",
    ...inFlightChanges(),
    "",
    "## 方向动态",
    "",
    "- 方向动态为人工策展段：多 harness 运行管理层、记忆架构 v4、agents-native 沟通愿景（AI 分身能力）——详见 docs/facet-wanxing-roadmap.md 与 openspec/changes/。",
  ].join("\n");
  if (projects.content !== prev) changed.push("corpus-projects");
}

// corpus-company / corpus-capabilities: re-stamp the as-of line only, keep
// the curated body; capabilities additionally reminds the operator that the
// live shelf is production-side.
for (const [name, reminder] of [
  ["corpus-company", null],
  ["corpus-capabilities", "提醒：能力货架在生产的 packs DB，本语料为人工策展——发布前对照线上目录核对一遍。"],
]) {
  const s = skill(name);
  if (!s) continue;
  const prev = s.content;
  s.content = s.content.replace(
    /^# .*$/m,
    `# ${name === "corpus-company" ? "企业语料" : "能力语料"}（语料截至 ${asOf}${reminder ? "；" + reminder : ""}）`,
  );
  if (s.content !== prev) changed.push(name);
}

if (changed.length === 0) {
  console.log("facade corpus snapshot: no changes (already current)");
} else {
  console.log(`facade corpus snapshot (${asOf}) refreshed: ${changed.join(", ")}`);
  if (!dry) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`wrote ${path.relative(root, manifestPath)} — review the diff, then publish a new version`);
  } else {
    console.log("dry run — manifest untouched");
  }
}
