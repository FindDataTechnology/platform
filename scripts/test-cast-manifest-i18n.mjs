#!/usr/bin/env node
// ── Blueprint cast must carry the author's i18n block (cast-manifest-carries-i18n) ──
//
// 2026-11-21 真机撞到：官方作者（OFFICIAL_AUTHOR_EMAILS，PACK_OFFICIAL_EN_GATE=1）
// 在创作台铸团队模板恒 422 official_en_coverage_incomplete —— 根因 assembleManifest
// 不读 content.i18n，蓝图产物拿不到英文块，官方 en 门（lib/pack-locale-coverage.js
// 读 manifest.i18n.en）永远判 0 覆盖。
//
// Pins:
//   1.1  合法 i18n 原样进 manifest；无 i18n / 非对象 → 无 i18n 键（旧产物逐字节不变）
//   1.2  buildCastManifest 经 assembleManifest 自动携带 i18n
//   2.1  门闭环：无 i18n 被拒；正确 en 覆盖放行
//   2.2  反向：不完整覆盖仍被拒且 missing 点名该路径（门没被放松）
//
//   node --test scripts/test-cast-manifest-i18n.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { assembleManifest, buildCastManifest } = await import("../server/blueprint-validate.js");
const { officialEnGateBody } = await import("../lib/pack-locale-coverage.js");

// 一个组织面三字段齐的团队 content（name / description / agents[x].name）
function teamContent(i18n) {
  const c = {
    kind: "team",
    boundary: { name: "盯梢团队", oneLine: "盯跨境电商政策", outOfScope: "" },
    dataSources: [],
    agents: [{ id: "brief-agent", name: "简报助手", persona: "你是简报助手。" }],
    mcpServers: [],
    skills: [],
    fleet: {
      name: "盯梢团队",
      members: [{ ref: "brief", title: "简报岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "brief-agent" } }],
    },
    acceptance: [],
    board: {},
  };
  if (i18n !== undefined) c.i18n = i18n;
  return c;
}

const GOOD_EN = {
  en: {
    name: "Watch Team",
    description: "Watch cross-border e-commerce policy",
    agents: { "brief-agent": { name: "Brief Agent" } },
  },
};

test("1.1 a valid i18n object passes through to the manifest verbatim", () => {
  const manifest = assembleManifest(teamContent(GOOD_EN));
  assert.deepEqual(manifest.i18n, GOOD_EN, "i18n carried unchanged");
});

test("1.1 no i18n declared → no i18n key (legacy cast byte-identical)", () => {
  const manifest = assembleManifest(teamContent(undefined));
  assert.equal(Object.hasOwn(manifest, "i18n"), false, "no i18n key when undeclared");
});

test("1.1 a non-object i18n (array/string) is ignored, not injected", () => {
  for (const bad of [[], "en", 42, null]) {
    const manifest = assembleManifest(teamContent(bad));
    assert.equal(Object.hasOwn(manifest, "i18n"), false, `i18n=${JSON.stringify(bad)} must be ignored`);
  }
});

test("1.2 buildCastManifest (which calls assembleManifest) carries i18n", () => {
  const { manifest } = buildCastManifest({
    content: teamContent(GOOD_EN),
    casting: { blueprintId: "bp_x", version: 1, approvedBy: "a@b", approvedAt: "2026-11-21T00:00:00Z" },
  });
  assert.deepEqual(manifest.i18n, GOOD_EN, "cast manifest carries i18n");
  assert.ok(manifest._casting, "_casting still present");
});

test("2.1 gate closed before: a manifest with no i18n is rejected", () => {
  const body = officialEnGateBody(assembleManifest(teamContent(undefined)));
  assert.ok(body, "no i18n ⇒ gate rejects (non-null body)");
  assert.equal(body.code, "official_en_coverage_incomplete");
  assert.ok(body.coverage.missing.includes("name"));
});

test("2.1 gate open after: correct en coverage passes", () => {
  const body = officialEnGateBody(assembleManifest(teamContent(GOOD_EN)));
  assert.equal(body, null, "full en coverage ⇒ gate passes (null)");
});

test("2.2 gate is NOT loosened: incomplete coverage still rejected, itemized", () => {
  const partial = { en: { name: "Watch Team", description: "x" } }; // missing agents[brief-agent].name
  const body = officialEnGateBody(assembleManifest(teamContent(partial)));
  assert.ok(body, "partial coverage ⇒ still rejected");
  assert.ok(
    body.coverage.missing.includes("agents['brief-agent'].name"),
    `missing must name the agent path, got ${JSON.stringify(body.coverage.missing)}`,
  );
});
