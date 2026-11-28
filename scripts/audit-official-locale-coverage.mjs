#!/usr/bin/env node
// ── 在架官方条目 en 覆盖审计 (overhaul-market-catalog-presentation 5.1) ──────
//
// Pulls the LIVE market read face (or a saved snapshot), finds every entry the
// SOURCE projection judges official, and computes its en coverage over the
// org surface with the SAME module the publish gate and the workbench use
// (lib/pack-locale-coverage — one denominator, no re-derivation). Any gap exits
// non-zero with a per-pack, per-field-path list: this is the door the official
// en publish gate (PACK_OFFICIAL_EN_GATE=1) will enforce per-publish, run here
// per-catalog BEFORE the door opens (P5.5). The audit only READS; it changes
// nothing (specs/official-locale-coverage 审计不改变读面).
//
//   node scripts/audit-official-locale-coverage.mjs
//   node scripts/audit-official-locale-coverage.mjs --snapshot=dir-or-file
//   node scripts/audit-official-locale-coverage.mjs --base=https://facet.finddatatech.cloud --locale=en
//
// --base defaults to https://facet.finddatatech.cloud; --snapshot reads
// <file> or every *.json under <dir> shaped { packs: [{ manifest, official }] }.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
// Snapshot-directory mode joins paths below; without this import the audit threw
// `ReferenceError: path is not defined` the moment it was pointed at a directory
// snapshot instead of a single file.
import path from "node:path";
import { localeCoverage } from "../lib/pack-locale-coverage.js";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const locale = arg("locale", "en");
const base = (arg("base", "https://facet.finddatatech.cloud") || "").replace(/\/+$/, "");
const snapshot = arg("snapshot", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collect rows as { id, official, manifest } — the manifest is the zh main
// track (fetched without a locale), the official flag is the source projection.
async function liveRows() {
  const listRes = await fetch(`${base}/api/packs?pageSize=100`);
  if (!listRes.ok) throw new Error(`list ${listRes.status}`);
  const list = await listRes.json();
  const rows = [];
  for (const p of list.packs ?? []) {
    if (p.official !== true) continue; // only official entries are gated
    await sleep(120); // polite: sequential detail reads, no burst at the edge
    const d = await fetch(`${base}/api/packs/${encodeURIComponent(p.id)}`);
    if (!d.ok) {
      rows.push({ id: p.id, name: p.name, error: `detail ${d.status}` });
      continue;
    }
    const detail = await d.json();
    rows.push({ id: p.id, name: detail.name ?? p.name, manifest: detail.manifest ?? {} });
  }
  return rows;
}

function snapshotRows() {
  const files = [];
  if (snapshot && existsSync(snapshot) && statSync(snapshot).isDirectory()) {
    for (const f of readdirSync(snapshot)) if (f.endsWith(".json")) files.push(path.join(snapshot, f));
  } else if (snapshot && existsSync(snapshot)) {
    files.push(snapshot);
  } else {
    throw new Error(`--snapshot path not found: ${snapshot}`);
  }
  const rows = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    for (const p of j.packs ?? (Array.isArray(j) ? j : [j])) {
      if (p.official !== true) continue;
      rows.push({ id: p.id ?? path.basename(f), name: p.name ?? p.manifest?.name ?? "?", manifest: p.manifest ?? p });
    }
  }
  return rows;
}

async function main() {
  const rows = snapshot ? snapshotRows() : await liveRows();
  const report = [];
  let readErrors = 0;
  for (const r of rows) {
    if (r.error) {
      readErrors += 1;
      report.push({ pack: r.id, name: r.name, error: r.error });
      continue;
    }
    const cov = localeCoverage(r.manifest ?? {}, locale);
    if (cov.missing.length > 0) report.push({ pack: r.id, name: r.name, covered: cov.covered, total: cov.total, missing: cov.missing });
  }

  const gaps = report.filter((x) => x.missing?.length || x.error);
  console.log(`审计 ${rows.length} 条官方条目 · locale=${locale} · ${gaps.length} 条存在缺项${readErrors ? ` · ${readErrors} 条读取失败` : ""}`);
  for (const g of gaps) {
    if (g.error) {
      console.log(`  [读取失败] ${g.pack} (${g.name}): ${g.error}`);
      continue;
    }
    console.log(`  [${g.covered}/${g.total}] ${g.pack} (${g.name})`);
    for (const p of g.missing) console.log(`      - ${p}`);
  }
  if (gaps.length === 0 && rows.length > 0) console.log("  ✓ 全部官方条目组织面 en 覆盖完整");
  process.exit(gaps.length > 0 ? 1 : 0);
}

await main();
