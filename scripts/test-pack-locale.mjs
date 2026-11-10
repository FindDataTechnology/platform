#!/usr/bin/env node
// ── Locale resolution + manifest projection (add-pack-locale-tracks, task 2.1)
//
// lib/pack-locale.js is the single place locale resolution lives: the priority
// order (explicit locale > Accept-Language first tag > zh), zh as the only
// fallback endpoint, and the projection that overlays the en (or any other)
// block onto the zh base fields WITHOUT mutating the input. A manifest with no
// overlay, or a zh request, must project to the SAME object — the byte-
// identical default path every pre-change client already depends on.
//
//   node --test scripts/test-pack-locale.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeLocale,
  localeFromAcceptLanguage,
  resolveLocale,
  pickLocalized,
  projectManifestForLocale,
  applyLocaleToSummary,
  projectPackList,
} from "../lib/pack-locale.js";

const BASE = {
  name: "政心盯梢集群",
  description: "中文描述",
  skills: [{ name: "intel", description: "情报采集", content: "正文" }],
  agents: [
    {
      id: "watch",
      name: "监视岗",
      persona: "你是监视岗。",
      serving: { protocol: "a2a", card: { name: "监视卡", description: "卡描述", skills: [{ id: "gather", name: "采集", description: "采集能力" }] } },
    },
  ],
  bots: [{ id: "b1", name: "值班机器人", generic: "channel", description: "机器人描述" }],
  cluster: { name: "集群名", description: "集群描述", defaultAgents: ["watch"] },
  guide: { steps: [{ title: "一", body: "第一步" }, { title: "二", body: "第二步" }, { title: "三", body: "第三步" }] },
};

const BILINGUAL = {
  ...BASE,
  i18n: {
    en: {
      name: "Policy Sentinel Cluster",
      // description intentionally omitted — per-key fallback
      guide: { steps: [{ title: "One", body: "First" }, { title: "Two", body: "Second" }, { title: "Three", body: "Third" }] },
      skills: { intel: { description: "Collects intelligence" } },
      agents: { watch: { name: "Watch Post", serving: { card: { name: "Watch Card", skills: { gather: { name: "Gather" } } } } } },
      bots: { b1: { name: "Duty Bot" } },
      cluster: { name: "Cluster Name" },
    },
  },
};

// ── normalizeLocale ─────────────────────────────────────────────────────────

test("normalizeLocale lowercases and keeps subtags", () => {
  assert.equal(normalizeLocale("EN"), "en");
  assert.equal(normalizeLocale("en-US"), "en-us");
  assert.equal(normalizeLocale(" ja "), "ja");
});

test("normalizeLocale collapses every zh tag to 'zh'", () => {
  assert.equal(normalizeLocale("zh"), "zh");
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("ZH-Hans"), "zh");
});

test("normalizeLocale rejects non-tag input", () => {
  for (const bad of ["", "e", "english", "en_US", "-en", "en-", 42, null, undefined]) {
    assert.equal(normalizeLocale(bad), null, String(bad));
  }
});

// ── localeFromAcceptLanguage ────────────────────────────────────────────────

test("Accept-Language takes the first tag and strips its q-value", () => {
  assert.equal(localeFromAcceptLanguage("en-US,en;q=0.9,zh;q=0.8"), "en-us");
  assert.equal(localeFromAcceptLanguage("ja"), "ja");
  assert.equal(localeFromAcceptLanguage("   "), null);
  assert.equal(localeFromAcceptLanguage("not a lang"), null);
});

// ── resolveLocale ───────────────────────────────────────────────────────────

test("explicit locale wins over Accept-Language", () => {
  assert.equal(resolveLocale({ locale: "en", acceptLanguage: "ja" }), "en");
});

test("Accept-Language is the second choice", () => {
  assert.equal(resolveLocale({ acceptLanguage: "ja,en;q=0.5" }), "ja");
});

test("absent both, the default is zh", () => {
  assert.equal(resolveLocale(), "zh");
  assert.equal(resolveLocale({ locale: "not a lang", acceptLanguage: "??" }), "zh");
});

// ── pickLocalized ───────────────────────────────────────────────────────────

test("pickLocalized uses the override, else the base, and never for zh", () => {
  assert.equal(pickLocalized("基", "override", "en"), "override");
  assert.equal(pickLocalized("基", undefined, "en"), "基");
  assert.equal(pickLocalized("基", "   ", "en"), "基");
  assert.equal(pickLocalized("基", "override", "zh"), "基");
});

// ── projectManifestForLocale ────────────────────────────────────────────────

test("no overlay projects to the same object (byte-identical path)", () => {
  assert.equal(projectManifestForLocale(BASE, "en"), BASE);
  assert.equal(projectManifestForLocale(BILINGUAL, "zh"), BILINGUAL);
  assert.equal(projectManifestForLocale(BILINGUAL, undefined), BILINGUAL);
});

test("a covered locale overrides only the declared fields, per key", () => {
  const out = projectManifestForLocale(BILINGUAL, "en");
  assert.equal(out.name, "Policy Sentinel Cluster");
  assert.equal(out.description, "中文描述"); // not covered → zh base
  assert.equal(out.guide.steps[1].title, "Two");
  assert.equal(out.skills[0].description, "Collects intelligence");
  assert.equal(out.agents[0].name, "Watch Post");
  assert.equal(out.agents[0].serving.card.name, "Watch Card");
  assert.equal(out.agents[0].serving.card.description, "卡描述"); // not covered
  assert.equal(out.agents[0].serving.card.skills[0].name, "Gather");
  assert.equal(out.bots[0].name, "Duty Bot");
  assert.equal(out.bots[0].description, "机器人描述"); // not covered
  assert.equal(out.cluster.name, "Cluster Name");
  assert.equal(out.cluster.description, "集群描述"); // not covered
});

test("the i18n block rides along unchanged and content is untouched", () => {
  const out = projectManifestForLocale(BILINGUAL, "en");
  assert.deepEqual(out.i18n, BILINGUAL.i18n);
  assert.equal(out.skills[0].content, "正文");
  assert.equal(out.agents[0].persona, "你是监视岗。");
});

test("an uncovered locale falls back to zh everywhere", () => {
  const out = projectManifestForLocale(BILINGUAL, "ja");
  assert.equal(out, BILINGUAL);
});

test("a primary-subtag request finds the block (en-US → en)", () => {
  const out = projectManifestForLocale(BILINGUAL, "en-US");
  assert.equal(out.name, "Policy Sentinel Cluster");
});

test("projection never mutates the input", () => {
  const snapshot = JSON.stringify(BILINGUAL);
  projectManifestForLocale(BILINGUAL, "en");
  assert.equal(JSON.stringify(BILINGUAL), snapshot);
});
// ── summary/list helpers (the gateway + cell read faces) ────────────────────

const SUMMARY = { id: "p1", name: "政心盯梢集群", description: "中文描述", tags: ["情报"] };

test("applyLocaleToSummary overlays name/description for a covered locale", () => {
  const out = applyLocaleToSummary(SUMMARY, BILINGUAL, "en");
  assert.equal(out.name, "Policy Sentinel Cluster");
  assert.equal(out.description, "中文描述"); // uncovered → zh column stays
  assert.deepEqual(out.tags, ["情报"]);
  assert.equal(out.id, "p1");
});

test("applyLocaleToSummary is a no-op for zh, uncovered locales and bad manifests", () => {
  assert.equal(applyLocaleToSummary(SUMMARY, BILINGUAL, "zh"), SUMMARY);
  assert.equal(applyLocaleToSummary(SUMMARY, BILINGUAL, "ja"), SUMMARY);
  assert.equal(applyLocaleToSummary(SUMMARY, null, "en"), SUMMARY);
  assert.equal(applyLocaleToSummary(SUMMARY, { name: "x" }, "en"), SUMMARY);
});

test("projectPackList projects records and returns zh requests untouched", () => {
  const packs = [
    { packId: "a", name: "政心盯梢集群", version: 1, manifest: BILINGUAL },
    { packId: "b", name: "无覆盖", version: 1, manifest: BASE },
  ];
  assert.equal(projectPackList(packs, { locale: "zh" }), packs);
  assert.equal(projectPackList(packs, {}), packs);
  const en = projectPackList(packs, { locale: "en" });
  assert.equal(en[0].name, "Policy Sentinel Cluster");
  assert.equal(en[0].manifest.guide.steps[0].title, "One");
  assert.equal(en[1].name, "无覆盖"); // no block → untouched record
  assert.equal(en[1].manifest, BASE);
  // Accept-Language channel, same priority as the market.
  assert.equal(projectPackList(packs, { acceptLanguage: "en-US" })[0].name, "Policy Sentinel Cluster");
});

// ── mcpServers projection (add-mcp-annotation-overlay) ───────────────────────

test("mcpServers description projects per registryName; uncovered entries pass through", () => {
  const manifest = {
    name: "名",
    description: "描述",
    mcpServers: [{ registryName: "wire-ops", description: "工单读写" }, { registryName: "fetch" }],
    i18n: { en: { mcpServers: { "wire-ops": { description: "Issue tracking" } } } },
  };
  const p = projectManifestForLocale(manifest, "en");
  assert.equal(p.mcpServers[0].description, "Issue tracking");
  assert.equal(p.mcpServers[0].registryName, "wire-ops");
  assert.equal(p.mcpServers[1], manifest.mcpServers[1]); // untouched, same reference
  assert.equal(projectManifestForLocale(manifest, "zh"), manifest); // byte-identical default path
});
