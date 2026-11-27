// ── Official adoption tests (add-official-adopted-agents 1.3 / 1.1 / 1.2) ────
//
// 三块，对应三条被代码验伪过的设计断言：
//   1. 许可门：只认宽松许可；许可必须来自上游证据（货架 licenseState 恒 unknown
//      不能作输入）；多许可取最宽松；未声明绝不猜。
//      —— 真实坑锚点：GitHub 元数据对 MCP 仓返回 NOASSERTION/Other，原文却是
//         MIT → Apache-2.0 过渡双许可。故本组用例把那段原文直接当夹具。
//   2. provenance 形状：可选、缺省零影响、非法 kind 被拒。
//   3. 三轴投影：adopted 不自带官方身份；类型徽章不受 adoption 影响。
//
//   node --test scripts/test-official-adoption.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  scanLicenseText,
  evaluateLicense,
  assertLicenseAdmissible,
} from "../lib/license-gate.js";
import { validateProvenance, validatePackManifest } from "../lib/pack-manifest.js";
import { describeProvenance, describeShelfProvenance, PROVENANCE_SOURCE } from "../lib/pack-provenance.js";

// 实测原文（2026-10-31 curl raw.githubusercontent.com/modelcontextprotocol/servers/main/LICENSE）
const MCP_TRANSITION_LICENSE = `The MCP project is undergoing a licensing transition from the MIT License to the Apache License, Version 2.0 ("Apache-2.0"). All new code and specification contributions to the project are licensed under Apache-2.0. Documentation contributions (excluding specifications) are licensed under CC-BY-4.0.`;

const MIT_TEXT = `MIT License

Copyright (c) 2024 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.`;

const AGPL_TEXT = `GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007`;

const NC_TEXT = `Creative Commons Attribution-NonCommercial 4.0 International
You may not use the material for commercial purposes.`;

// ── 1. 许可门 ───────────────────────────────────────────────────────────────

test("license: MIT text is admitted and governs", () => {
  const r = evaluateLicense([{ source: "LICENSE", text: MIT_TEXT }]);
  assert.equal(r.state, "admitted");
  assert.equal(r.governing, "MIT");
  assert.equal(r.axis, null);
});

test("license: the real MCP transition file admits on MIT despite metadata saying NOASSERTION", () => {
  // 元数据层 evidence 说不知道 —— 原文层说 MIT/Apache。裁决必须听原文。
  const r = evaluateLicense([
    { source: "repo-metadata", text: "NOASSERTION" },
    { source: "LICENSE", text: MCP_TRANSITION_LICENSE },
  ]);
  assert.equal(r.state, "admitted");
  assert.ok(["MIT", "Apache-2.0"].includes(r.governing));
  assert.equal(r.axis, null);
});

test("license: AGPL is rejected with the copyleft-network axis named", () => {
  const r = evaluateLicense([{ source: "LICENSE", text: AGPL_TEXT }]);
  assert.equal(r.state, "rejected");
  assert.equal(r.axis, "copyleft-network");
  assert.equal(r.governing, null);
});

test("license: non-commercial is rejected on the non-commercial axis", () => {
  const r = evaluateLicense([{ source: "LICENSE", text: NC_TEXT }]);
  assert.equal(r.state, "rejected");
  assert.equal(r.axis, "non-commercial");
});

test("license: dual license resolves to the permissive one and records the mix", () => {
  const r = evaluateLicense([
    { source: "LICENSE", text: `${MIT_TEXT}\n\nAlternatively: ${AGPL_TEXT}` },
  ]);
  assert.equal(r.state, "admitted");
  assert.equal(r.governing, "MIT");
  assert.ok(r.notes.some((n) => n.includes("mixed-license")), "mixed license must be recorded for review");
  assert.ok(r.observed.length >= 1, "observed evidence must be kept");
});

test("license: no evidence at all is not-declared, never a guessed license", () => {
  const r = evaluateLicense([]);
  assert.equal(r.state, "not-declared");
  assert.equal(r.governing, null);
  assert.equal(r.axis, "license-absent");
});

test("license: blank/undefined evidence is ignored rather than admitted", () => {
  const r = evaluateLicense([{ source: "LICENSE", text: "   " }, null, { source: "package.json" }]);
  assert.equal(r.state, "not-declared");
});

test("license: assertLicenseAdmissible throws with a structured axis on rejection", () => {
  assert.throws(
    () => assertLicenseAdmissible([{ source: "LICENSE", text: AGPL_TEXT }]),
    (err) => {
      assert.equal(err.code, "license-rejected");
      assert.equal(err.axis, "copyleft-network");
      return true;
    },
  );
  assert.throws(
    () => assertLicenseAdmissible([]),
    (err) => err.code === "license-rejected" && err.licenseState === "not-declared",
  );
  // admitted passes through
  const ok = assertLicenseAdmissible([{ source: "LICENSE", text: MIT_TEXT }]);
  assert.equal(ok.state, "admitted");
});

test("license: scanner separates permissive from forbidden without cross-matching LGPL as GPL", () => {
  const s = scanLicenseText("GNU Lesser General Public License version 2.1");
  assert.deepEqual(s.permissive, []);
  assert.deepEqual(s.forbidden.map((f) => f.id), ["LGPL"]);
});

// ── 2. provenance 形状 ──────────────────────────────────────────────────────

const GOOD_PROVENANCE = {
  kind: "official-adopted",
  upstreamUrl: "https://github.com/example/skill-repo",
  upstreamName: "example-skill",
  license: "MIT",
  revision: "4a93985763241755401a10678395303de4e720ba",
  adoptedBy: "ops@finddata.cloud",
  reviewedBy: "reviewer@finddata.cloud",
  reviewedAt: "2026-10-31T02:00:00.000Z",
};

function baseManifest(extra = {}) {
  return {
    name: "转正示例",
    description: "adoption fixture",
    skills: [{ name: "example-skill", description: "d", content: "body" }],
    ...extra,
  };
}

test("provenance: absent block produces no errors (legacy manifests byte-identical)", () => {
  const errors = validatePackManifest(baseManifest());
  assert.deepEqual(errors, []);
});

test("provenance: a well-formed adopted block validates", () => {
  const errors = validatePackManifest(baseManifest({ provenance: GOOD_PROVENANCE }));
  assert.deepEqual(errors, []);
});

test("provenance: unknown kind is rejected", () => {
  const errors = [];
  validateProvenance(baseManifest({ provenance: { ...GOOD_PROVENANCE, kind: "made-up" } }), errors);
  assert.ok(errors.some((e) => e.entry === "provenance.kind"));
});

test("provenance: unknown key is rejected", () => {
  const errors = [];
  validateProvenance(baseManifest({ provenance: { ...GOOD_PROVENANCE, sneaky: 1 } }), errors);
  assert.ok(errors.some((e) => e.error.includes("unknown key 'sneaky'")));
});

test("provenance: unpinned / garbage revision is rejected", () => {
  const errors = [];
  validateProvenance(baseManifest({ provenance: { ...GOOD_PROVENANCE, revision: "!!" } }), errors);
  assert.ok(errors.some((e) => e.entry === "provenance.revision"));
});

test("provenance: non-URL upstream and unparsable reviewedAt are rejected", () => {
  const errors = [];
  validateProvenance(
    baseManifest({ provenance: { ...GOOD_PROVENANCE, upstreamUrl: "not a url", reviewedAt: "whenever" } }),
    errors,
  );
  assert.ok(errors.some((e) => e.entry === "provenance.upstreamUrl"));
  assert.ok(errors.some((e) => e.entry === "provenance.reviewedAt"));
});

// ── 3. 三轴投影 ─────────────────────────────────────────────────────────────

test("provenance projection: adopted + roster official reads as official-adopted", () => {
  const d = describeProvenance(baseManifest({ provenance: GOOD_PROVENANCE }), { official: true });
  assert.equal(d.source, PROVENANCE_SOURCE.OFFICIAL_ADOPTED);
  assert.equal(d.official, true);
  assert.ok(d.adopted, "the adopted record rides along for the detail view");
});

test("provenance projection: adopted provenance alone NEVER grants official status", () => {
  const d = describeProvenance(baseManifest({ provenance: GOOD_PROVENANCE }), { official: false });
  assert.equal(d.source, PROVENANCE_SOURCE.COMMUNITY);
  assert.equal(d.official, false);
  assert.equal(d.adopted, null, "no official-adopted record without roster");
});

test("provenance projection: roster official without adoption reads as official-original", () => {
  const d = describeProvenance(baseManifest(), { official: true });
  assert.equal(d.source, PROVENANCE_SOURCE.OFFICIAL_ORIGINAL);
  assert.equal(d.adopted, null);
});

test("provenance projection: adoption leaves the structure-derived type badge unchanged", () => {
  // toolkit-shaped pack (no agents) stays toolkit after adoption
  const toolkit = baseManifest({ provenance: GOOD_PROVENANCE });
  assert.equal(describeProvenance(toolkit, { official: true }).badge, "toolkit");

  // assistant-shaped pack (agents, no serving/facade) stays assistant
  const assistant = baseManifest({
    provenance: GOOD_PROVENANCE,
    agents: [{ id: "helper", name: "Helper", persona: "p" }],
  });
  assert.equal(describeProvenance(assistant, { official: true }).badge, "assistant");
});

test("shelf provenance is always unreviewed and never official-adopted", () => {
  const s = describeShelfProvenance({
    originUrl: "https://skillhub.cn/skills/x",
    displayName: "X",
    licenseState: "unknown",
    downloads: 10,
    stars: 2,
  });
  assert.equal(s.source, PROVENANCE_SOURCE.ECOSYSTEM_UNREVIEWED);
  assert.equal(s.licenseState, "unknown");
  assert.equal(s.upstreamUrl, "https://skillhub.cn/skills/x");
});
