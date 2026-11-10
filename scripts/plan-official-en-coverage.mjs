#!/usr/bin/env node
// ── 官方条目 en 覆盖草稿提取 (overhaul-market-catalog-presentation 5.2 准备) ──
//
// READ-ONLY against the live market face: for every official entry, recompute
// the same gap list the audit reports (one denominator: lib/pack-locale-coverage)
// and lift each missing path's zh source text into a per-pack draft file under
// the local drafts dir. Nothing here publishes or mutates production — the
// drafts are the REVIEW ARTIFACT: `en` slots get filled (translation pass),
// a human eyeballs them, and ONLY then scripts/apply-official-en-coverage.mjs
// (guarded, --apply, resume-safe) turns them into version bumps.
//
//   node scripts/plan-official-en-coverage.mjs
//   node scripts/plan-official-en-coverage.mjs --out=/tmp/en-coverage-drafts --base=https://facet.finddatatech.cloud
//
// Draft shape (one file per pack):
//   { packId, name, authorEmail, version, gaps: [{ path, zh, en }] }
// `path` uses the exact coverage-module grammar so the apply step can merge
// values back into i18n.en without re-deriving anything.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localeCoverage, orgSurface } from "../lib/pack-locale-coverage.js";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const base = (arg("base", "https://facet.finddatatech.cloud") || "").replace(/\/+$/, "");
const outDir = arg("out", "/tmp/en-coverage-drafts");
const locale = arg("locale", "en");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inverse of orgSurface's path grammar: locate the declared zh value.
function valueAt(manifest, p) {
  if (p === "tags") return manifest.tags;
  if (/^(name|description|notes|promise)$/.test(p)) return manifest[p];
  const guide = /^guide\.steps\[(\d+)\]\.(title|body)$/.exec(p);
  if (guide) return manifest.guide?.steps?.[Number(guide[1])]?.[guide[2]];
  const named = /^(skills|agents|bots)\['([^']+)'\]\.(description|name)$/.exec(p);
  if (named) {
    // orgSurface's grammar: skills key by NAME, agents/bots key by ID — mirror
    // it exactly here or every keyed lookup misses.
    const group = named[1];
    const key = named[2];
    const field = named[3];
    const arr = Array.isArray(manifest[group]) ? manifest[group] : [];
    const ent = arr.find((x, i) => String(group === "skills" ? (x?.name ?? i) : (x?.id ?? i)) === key);
    return ent?.[field];
  }
  const item = /^(outcomes|examples)\[(\d+)\]\.(title|detail|prompt)$/.exec(p);
  if (item) return manifest[item[1]]?.[Number(item[2])]?.[item[3]];
  return undefined;
}

async function main() {
  const listRes = await fetch(`${base}/api/packs?pageSize=100`);
  if (!listRes.ok) throw new Error(`list ${listRes.status}`);
  const list = await listRes.json();
  const official = (list.packs ?? []).filter((p) => p.official === true);

  mkdirSync(outDir, { recursive: true });
  const index = [];
  let totalGaps = 0;
  for (const row of official) {
    await sleep(120); // polite sequential reads, same law as the audit
    const d = await fetch(`${base}/api/packs/${encodeURIComponent(row.id)}`);
    if (!d.ok) {
      index.push({ packId: row.id, error: `detail ${d.status}` });
      continue;
    }
    const detail = await d.json();
    const manifest = detail.manifest ?? {}; // zh main track (no locale param)
    const cov = localeCoverage(manifest, locale);
    if (cov.missing.length === 0) {
      index.push({ packId: row.id, name: row.name, authorEmail: row.authorEmail, version: row.version, gaps: 0 });
      continue;
    }
    // The detail face may hide keys the column list carries — trust coverage's
    // own denominator (orgSurface paths) and pull zh text per path from it.
    const gaps = orgSurface(manifest)
      .filter((p) => cov.missing.includes(p))
      .map((p) => ({ path: p, zh: valueAt(manifest, p) ?? null, en: "" }));
    const draft = {
      packId: row.id,
      name: row.name,
      authorEmail: row.authorEmail ?? detail.authorEmail ?? null,
      version: row.version ?? detail.version ?? null,
      locale,
      coverage: { covered: cov.covered, total: cov.total },
      gaps,
    };
    writeFileSync(path.join(outDir, `${row.id}.json`), JSON.stringify(draft, null, 2) + "\n");
    index.push({ packId: row.id, name: row.name, authorEmail: draft.authorEmail, gaps: gaps.length });
    totalGaps += gaps.length;
  }
  writeFileSync(
    path.join(outDir, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), base, locale, packs: index }, null, 2) + "\n",
  );
  const withGaps = index.filter((x) => x.gaps > 0).length;
  console.log(`提取完成：${official.length} 条官方 · ${withGaps} 条带缺项 · 共 ${totalGaps} 个字段路径 · 草稿目录 ${outDir}`);
  const owners = {};
  for (const x of index) if (x.authorEmail) owners[x.authorEmail] = (owners[x.authorEmail] ?? 0) + 1;
  for (const [email, n] of Object.entries(owners).sort((a, b) => b[1] - a[1])) console.log(`  归属 ${email}: ${n} 条`);
}

await main();
