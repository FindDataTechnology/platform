#!/usr/bin/env node
// ── 精选外部技能的许可审计与转正（adopt-curated-external-skills 2.x）───────
//
// 一条命令回答运营真正会问的两个问题：
//   1. 我清单里这些条目，现在还能不能合法再分发？（逐条许可裁决 + 上游原文证据）
//   2. 能的那几条，转正产物长什么样？（adopted manifest + provenance）
//
// 默认只读：审计 + 打印。写盘必须显式 `--emit <dir>`，且必须同时给
// `--operator` / `--reviewer`（official-adoption 规范：转正必须可归属）。
//
//   node scripts/adopt-curated-skills.mjs
//   node scripts/adopt-curated-skills.mjs --json > audit.json
//   node scripts/adopt-curated-skills.mjs --emit /tmp/adopted --operator a@b --reviewer c@d
//
// 环境：GITHUB_TOKEN 可选（实名额度 5000/h；匿名只有 60/h，逐条取包会撞墙）。
//
// 退出码 0 = 清单全部可转正；1 = 有任一条被卡（fail-closed：pin 漂移成不可
// 再分发的内容时 CI 应当红，而不是安静地少一条）。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createExternalSourceRegistry } from "../external-sources.js";
import { CURATED_SOURCES, createCuratedAdapters, githubApiFetch } from "../lib/curated-sources.js";
import { adoptExternalSkill, previewAdoption } from "../lib/adoption.js";

function parseArgs(argv) {
  const out = { emit: null, operator: null, reviewer: null, only: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--emit") out.emit = argv[++i] ?? null;
    else if (a === "--operator") out.operator = argv[++i] ?? null;
    else if (a === "--reviewer") out.reviewer = argv[++i] ?? null;
    else if (a === "--only") out.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.emit && (!args.operator || !args.reviewer)) {
  console.error("--emit requires --operator <id> and --reviewer <id> (adoption must be attributable)");
  process.exit(2);
}

const fetchImpl = githubApiFetch(process.env.GITHUB_TOKEN);
const adapters = createCuratedAdapters({ fetchImpl });
const registry = createExternalSourceRegistry({
  // 只开精选源：审计的对象是清单本身，不掺第三方搜索源的噪声。
  env: { EXTERNAL_SKILL_SOURCES: CURATED_SOURCES.map((s) => s.id).join(",") },
  fetchImpl,
  extraAdapters: adapters,
});

const onlySet = args.only ? new Set(args.only) : null;
const rows = [];

for (const pin of CURATED_SOURCES) {
  for (const item of pin.entries) {
    if (onlySet && !onlySet.has(item.slug)) continue;
    const row = { source: pin.id, slug: item.slug, pinnedRevision: pin.ref };
    try {
      const preview = await previewAdoption({ source: pin.id, slug: item.slug, registry, fetchImpl });
      row.license = preview.license.state;
      row.axis = preview.license.axis ?? null;
      row.governing = preview.license.governing ?? null;
      row.revision = preview.revision;
      row.files = preview.inlinedFiles;
      row.bodyChars = preview.bodyChars;
      row.capabilityNeeds = preview.capabilityNeeds;
      row.verdict = preview.verdict;
      row.observed = preview.evidence;
      row.ok = preview.license.state === "admitted" && Boolean(preview.revision);
    } catch (err) {
      row.license = "error";
      row.axis = err?.axis ?? null;
      row.verdict = `失败：${err?.code ?? "error"} ${err?.message ?? ""}`.trim();
      row.ok = false;
    }
    rows.push(row);
    if (!args.json) {
      const mark = row.ok ? "OK  " : "FAIL";
      console.log(
        `${mark} ${row.slug.padEnd(24)} ${String(row.license).padEnd(13)} ${String(row.axis ?? "-").padEnd(18)} ${row.verdict}`,
      );
    }
  }
}

const refused = rows.filter((r) => !r.ok);
const summary = {
  checked: rows.length,
  admitted: rows.length - refused.length,
  refused: refused.length,
  operator: args.operator ?? null,
  reviewer: args.reviewer ?? null,
  generatedAt: new Date().toISOString(),
  pins: CURATED_SOURCES.map((s) => ({ id: s.id, owner: s.owner, repo: s.repo, ref: s.ref })),
  rows,
};

// ── 转正产物（可选）──────────────────────────────────────────────────────────
if (args.emit) {
  const manifestDir = path.resolve(args.emit);
  await mkdir(manifestDir, { recursive: true });
  const admitted = rows.filter((r) => r.ok);
  for (const row of admitted) {
    const { manifest, report } = await adoptExternalSkill({
      source: row.source,
      slug: row.slug,
      registry,
      operator: args.operator,
      reviewer: args.reviewer,
      fetchImpl,
    });
    const dir = path.join(manifestDir, row.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(dir, "provenance.json"), `${JSON.stringify(report, null, 2)}\n`);
    row.adoptedManifest = path.join(dir, "manifest.json");
    if (!args.json) console.log(`     -> ${row.adoptedManifest}`);
  }
  await writeFile(path.join(manifestDir, "audit.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

if (args.json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\n${summary.admitted}/${summary.checked} 可转正，${summary.refused} 条被拒`);
  for (const r of refused) console.log(`  拒绝：${r.slug} — ${r.verdict}`);
}

process.exit(refused.length === 0 ? 0 : 1);
