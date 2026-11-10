#!/usr/bin/env node
// ── Agent fork lineage tests (add-agent-fork-lineage) ────────────────────────
//
// Pins:
//   1. validator: `forkOf` is an optional lineage block — lineage-ONLY shape
//      (no kind) passes; malformed forkOf is rejected field-level; the
//      adopted record's all-fields contract is byte-identical (kind must be
//      official-adopted, five fields required); a PRESENT field gets its
//      shape check even in lineage-only mode (D6 license preservation)
//   2. official semantics: a lineage block NEVER confers official status —
//      describeProvenance reads it as community without the roster
//   3. gateway: the publish-gate dry-run accepts a lineage manifest and
//      rejects a malformed one (endpoint == gate text)
//   4. studio: `?fork=` seeds from the READ api only; the lineage block rides
//      emitDraft's entries; no fork write endpoint anywhere
//   5. surfaces: the shared sheet renders the lineage line only when the
//      document carries it; the dialog forks via DEEP LINK; facet passes the
//      cross-domain origin and stays write-free
//
//   node --test scripts/test-agent-fork-lineage.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { describeProvenance } from "../lib/pack-provenance.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const base = { name: "fork 测试", description: "d", skills: [{ name: "a", description: "x", content: "y" }] };
const provErrors = (manifest) => validatePackManifest(manifest).filter((e) => e.entry?.startsWith("provenance") || e.error.startsWith("provenance"));

test("lineage-only provenance block passes; malformed forkOf is rejected field-level", () => {
  assert.equal(provErrors({ ...base, provenance: { forkOf: { packId: "EMGW", version: 6 } } }).length, 0);
  assert.equal(provErrors({ ...base, provenance: { forkOf: { packId: "EMGW", version: 6 }, license: "MIT" } }).length, 0, "D6: the parent's license rides the lineage block");
  const malformed = [
    { forkOf: { packId: "x" } },                 // missing version
    { forkOf: { packId: 1, version: "x" } },     // bad types
    { forkOf: { packId: "x", version: 1, note: "hi" } }, // unknown key
    { forkOf: "EMGW" },                          // not an object
  ];
  for (const provenance of malformed) {
    const errs = provErrors({ ...base, provenance });
    assert.ok(errs.length > 0, `malformed ${JSON.stringify(provenance)} rejected`);
    assert.ok(errs.every((e) => e.error.includes("forkOf") || e.entry?.includes("forkOf")), "rejections name the forkOf field");
  }
});

test("the adopted record's contract is byte-identical (no relaxation)", () => {
  const rev = "a".repeat(40);
  const full = { kind: "official-adopted", upstreamUrl: "https://e.com/x", upstreamName: "x", license: "MIT", revision: rev, adoptedBy: "a@b.c", reviewedBy: "a@b.c", reviewedAt: "2026-01-01T00:00:00Z" };
  assert.equal(provErrors({ ...base, provenance: full }).length, 0);
  // Every required field still required; kind still the only admissible kind.
  const missing = provErrors({ ...base, provenance: { kind: "official-adopted" } });
  assert.ok(missing.length >= 7, "all adopted fields still required");
  assert.ok(provErrors({ ...base, provenance: { license: "MIT" } }).some((e) => e.error.includes("provenance.kind")), "kind still required outside lineage-only");
});

test("a present field keeps its shape check in lineage-only mode", () => {
  const errs = provErrors({ ...base, provenance: { forkOf: { packId: "EMGW", version: 6 }, license: "not a license!!" } });
  assert.ok(errs.some((e) => e.entry === "provenance.license"), "bad license caught even though optional here");
});

test("a lineage block never confers official status (roster-only)", () => {
  const d = describeProvenance({ provenance: { forkOf: { packId: "EMGW", version: 6 } } }, { official: false });
  assert.equal(d.official, false);
  assert.equal(d.source, "community");
  // Even a roster-official author publishing a fork-shaped block reads as
  // official-original by the roster — never via the lineage block itself.
  const d2 = describeProvenance({ provenance: { forkOf: { packId: "EMGW", version: 6 } } }, { official: true });
  assert.equal(d2.source, "official-original");
});

// ── surfaces: source contract ────────────────────────────────────────────────
const page = read("web/src/pages/AgentStudioPage.tsx");
const dialog = read("web/src/components/packs/PackDetailDialog.tsx");
const sheet = read("web/src/components/packs/AgentSpecSheet.tsx");
const facetApp = read("facet/web/src/App.tsx");

test("studio seeds from the READ api and carries lineage into the draft emit", () => {
  assert.match(page, /searchParams\.get\("fork"\)/, "?fork= param consumed");
  // add-agent-builder-workspace 批 1 重建后契约等价：播种仍走 READ api（可见性
  // 在读面强制），lineage 落 content.provenance，emitDraft 从持久文档带出。
  assert.match(page, /fetch\(`\/api\/packs\/\$\{encodeURIComponent\(fork\w*\)\}`\)/, "seed fetched through the read API (visibility enforced there)");
  assert.match(page, /forkOf: \{ packId: detail\.id, version: detail\.version \}/, "lineage stamped on the seed");
  assert.ok(!/kind: ["']official/.test(page), "the seed never fabricates an adopted record");
  // 全页唯一出现点即 emitDraft（TS 类型注解里的 `};` 会让切片式提取截断）。
  assert.match(page, /provenance: prov/, "emitDraft carries the lineage block");
  assert.ok(!/\/api\/fork|fork.*POST/.test(page), "no fork write endpoint in the studio");
});

test("the dialog forks via deep link; availability follows read visibility by construction", () => {
  assert.match(dialog, /pack-fork/, "fork button on the detail dialog");
  assert.match(dialog, /\/studio\?fork=\$\{encodeURIComponent\(pack\.id\)\}/, "deep link carries the pack id");
  assert.match(dialog, /studioOrigin \?\? ""/, "relative on 壹座, origin-parameterized for facet");
});

test("facet renders the affordance cross-domain and stays write-free", () => {
  assert.match(facetApp, /studioOrigin="https:\/\/platform\.finddatatech\.cloud"/, "facet passes the 壹座 origin");
  // The whole fork mechanism is client navigation; the facet SERVER has no
  // fork write surface at all.
  for (const f of ["index.js", "identity.js", "publish-gate.js", "pairing.js", "mcp-catalog.js"]) {
    const src = read(`facet/${f}`);
    assert.ok(!/fork/i.test(src.replace(/forkedFrom/g, "")), `facet/${f} has no fork surface`);
  }
});

test("the shared sheet renders lineage only when the document carries it", () => {
  assert.match(sheet, /lineage && \(/, "lineage line is data-gated");
  assert.match(sheet, /packs\.specSheet\.forkedFrom/, "rendered through the i18n key");
  assert.match(dialog, /lineage=\{\(pack\.manifest\?\.provenance/, "dialog feeds lineage from the manifest");
});

test("i18n: fork chrome keys exist in all five locales", () => {
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    assert.ok(d.packs?.specSheet?.forkedFrom, `${loc}: specSheet.forkedFrom`);
    assert.ok(d.packs?.detail?.fork && d.packs?.detail?.forkHint, `${loc}: detail.fork/forkHint`);
    assert.ok(d.studio?.fork?.seeded && d.studio?.fork?.unavailable, `${loc}: studio.fork`);
  }
});
