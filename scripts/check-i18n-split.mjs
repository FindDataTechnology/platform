#!/usr/bin/env node
// ── Only the active locale may ride the first paint ─────────────────────────
//
// 2026-11-24 measurement: the entry chunk was 1,808 KB raw / 590 KB gzip and
// 346 KB of that gzip was four locale files nobody was reading. The five
// bundles were static imports in web/src/i18n/index.ts, so every user paid for
// every language.
//
// This gate judges a BUILD PRODUCT, not the source: "the source imports five
// JSON files" is a code-review fact, while "the shipped entry chunk contains
// Japanese prose for a zh-CN user" is the defect. Probe strings make that
// decidable — each locale contributes its longest distinctive leaf value.
//
// Run: node scripts/check-i18n-split.mjs [--json]
// Exits non-zero when the split is not in effect.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web", "dist", "assets");
const LOCALES_DIR = path.join(REPO, "web", "src", "locales");

/** Every leaf string in a nested locale object. */
function leaves(obj, out = []) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") leaves(v, out);
    else if (typeof v === "string") out.push(v);
  }
  return out;
}

/**
 * Pick a probe string per locale: long, CJK/accented enough to be distinctive,
 * and provably absent from every OTHER locale's file. A probe that appears in
 * another locale would make the gate report a false positive.
 */
export function probesFor(localeDir = LOCALES_DIR) {
  const locales = fs.readdirSync(localeDir).filter((d) => fs.statSync(path.join(localeDir, d)).isDirectory());
  const texts = {};
  for (const l of locales) {
    texts[l] = leaves(JSON.parse(fs.readFileSync(path.join(localeDir, l, "common.json"), "utf8")));
  }
  const probes = {};
  for (const l of locales) {
    const candidates = texts[l]
      .filter((s) => s.length >= 12 && (/[\s\u0080-￿]/.test(s)))
      .sort((a, b) => b.length - a.length);
    const otherText = Object.entries(texts)
      .filter(([k]) => k !== l)
      .flatMap(([, v]) => v)
      .join("\n");
    probes[l] = candidates.find((s) => !otherText.includes(s)) ?? null;
  }
  return probes;
}

/** The built entry chunk(s): the LOCAL ones index.html actually references. */
function entryChunks() {
  const html = fs.readFileSync(path.join(REPO, "web", "dist", "index.html"), "utf8");
  const refs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  // A cross-origin script (the hosted Copilot widget) is not part of this
  // build's first paint; only same-origin asset paths are.
  return refs
    .filter((r) => r.startsWith("/") || r.startsWith("./"))
    .map((r) => path.join(REPO, "web", "dist", r.replace(/^\.?\//, "")))
    .filter((p) => fs.existsSync(p));
}

/** @returns {{ok:boolean, active:string|null, findings:string[], chunkBytes:number}} */
export function checkSplit({ activeLocale = null } = {}) {
  const findings = [];
  if (!fs.existsSync(DIST)) {
    return { ok: false, activeLocale, findings: ["web/dist is not built — run `npm run web:build` first"], chunkBytes: 0 };
  }
  const probes = probesFor();
  const chunks = entryChunks();
  if (chunks.length === 0) return { ok: false, activeLocale, findings: ["no entry chunk referenced by index.html"], chunkBytes: 0 };

  const source = chunks.map((c) => fs.readFileSync(c, "utf8")).join("\n");
  const chunkBytes = chunks.reduce((n, c) => n + fs.statSync(c).size, 0);

  // Which locales are physically present in the first paint?
  const present = Object.entries(probes)
    .filter(([, probe]) => probe && source.includes(probe))
    .map(([l]) => l);

  if (present.length === 0) {
    findings.push("no locale prose found in the entry chunk — the probe strings are stale, not the split working");
  }
  if (present.length > 2) {
    findings.push(
      `entry chunk carries ${present.length} locales (${present.join(", ")}) — only the active locale and "en" may ride the first paint`,
    );
  }
  if (!present.includes("en")) {
    findings.push('the "en" fallback bundle must be in the entry chunk — a missing key cannot wait for a network round trip');
  }
  if (activeLocale && present.length > 0 && !present.includes(activeLocale)) {
    findings.push(`active locale "${activeLocale}" is not in the entry chunk — that is a flash of English, not a saving`);
  }
  return { ok: findings.length === 0, activeLocale, findings, chunkBytes, present, probes };
}

function main() {
  const wantJson = process.argv.includes("--json");
  const r = checkSplit();
  if (wantJson) {
    console.log(JSON.stringify({ ...r, probes: undefined }, null, 2));
  } else if (!r.ok) {
    for (const f of r.findings) console.error(`[i18n-split] ${f}`);
    console.error(`[i18n-split] entry chunk is ${(r.chunkBytes / 1024).toFixed(0)} KB raw`);
    console.error("[i18n-split] fix: static-import only the active locale + en in web/src/i18n/index.ts;");
    console.error('           make the others `() => import("@/locales/<l>/common.json")`.');
  } else {
    // A silent pass cannot be told apart from "checked nothing" — print the
    // numbers it actually saw, so a green run carries its own evidence.
    console.log(
      `[i18n-split] ✓ ${r.present.length} locale(s) in the entry chunk (${r.present.join(", ")}), ${(r.chunkBytes / 1024).toFixed(0)} KB raw`,
    );
  }
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
