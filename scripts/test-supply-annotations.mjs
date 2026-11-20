#!/usr/bin/env node
// ── Supply annotation overlay helper (add-mcp-annotation-overlay) ────────────
//
// lib/supply-annotations.js: annotation shape validation (zh MAIN track
// required, per-locale tracks, optional canonical brief), field-wise merge
// across registry > catalog with provenance following the winner, and locale
// projection with the zh-only fallback chain. The read faces and the chat
// tool-block index consume these — the merge and projection rules must live
// in exactly one place (design D2/D6).
//
//   node --test scripts/test-supply-annotations.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnnotation, mergeAnnotations, projectAnnotation } from "../lib/supply-annotations.js";

const zh = { name: "工单读写", summary: "建单、查单、改状态。", whenToUse: "需要操作 issue 时。" };
const en = { name: "Issue tracking", summary: "Create, query, and transition tickets." };

test("a full annotation validates", () => {
  const r = validateAnnotation({ human: { zh, en }, canonical: { brief: "Operates issues on connected repos." }, provenance: { source: "catalog", updatedAt: "2026-11-01" } });
  assert.equal(r.ok, true);
});

test("missing zh MAIN track is rejected wholesale", () => {
  const r = validateAnnotation({ human: { en } });
  assert.equal(r.ok, false);
  assert.match(r.error, /human\.zh \(the zh MAIN track\) is required/);
});

test("an unknown locale and unknown keys are rejected", () => {
  assert.match(validateAnnotation({ human: { zh, ko: en } }).error, /unknown locale 'ko'/);
  assert.match(validateAnnotation({ human: { zh, en: { ...en, extra: 1 } } }).error, /unknown key 'extra'/);
  assert.match(validateAnnotation({ human: { zh }, wat: 1 }).error, /unknown key 'wat'/);
});

test("track field caps are enforced", () => {
  assert.match(validateAnnotation({ human: { zh: { ...zh, name: "x".repeat(61) } } }).error, /at most 60/);
  assert.match(validateAnnotation({ human: { zh: { ...zh, summary: "x".repeat(201) } } }).error, /at most 200/);
  assert.match(validateAnnotation({ human: { zh }, canonical: { brief: "x".repeat(301) } }).error, /at most 300/);
});

test("tool sub-annotations validate recursively", () => {
  const r = validateAnnotation({ human: { zh }, tools: { create_issue: { human: { zh: { name: "建单", summary: "新建 issue。" } } } } });
  assert.equal(r.ok, true);
  const bad = validateAnnotation({ human: { zh }, tools: { create_issue: { human: { en } } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /tools\['create_issue'\]/);
});

test("merge: registry wins field-wise, provenance follows the winner", () => {
  const merged = mergeAnnotations({
    registry: { human: { zh: { name: "registry 名", summary: "注册处一句话。" } }, canonical: { brief: "registry brief" } },
    catalog: { human: { zh, en }, canonical: { brief: "catalog brief" }, provenance: { source: "catalog" } },
  });
  assert.equal(merged.human.zh.name, "registry 名");
  assert.equal(merged.human.zh.summary, "注册处一句话。");
  assert.equal(merged.human.en.summary, en.summary); // catalog-only field survives
  assert.equal(merged.canonical.brief, "registry brief");
  assert.equal(merged.provenance.source, "registry");
});

test("merge: single-source passthrough stamps the source", () => {
  assert.equal(mergeAnnotations({ catalog: { human: { zh } } }).provenance.source, "catalog");
  assert.equal(mergeAnnotations({ registry: { human: { zh } } }).provenance.source, "registry");
  assert.equal(mergeAnnotations({}), null);
  assert.equal(mergeAnnotations(), null);
});

test("merge: tool sub-annotations merge per leaf", () => {
  const merged = mergeAnnotations({
    registry: { human: { zh }, tools: { create_issue: { human: { zh: { name: "建单(reg)", summary: "reg" } } } } },
    catalog: { human: { zh }, tools: { create_issue: { human: { zh, en: { name: "Create issue", summary: "s" } } }, list: { human: { zh: { name: "列表", summary: "s" } } } } },
  });
  assert.equal(merged.tools.create_issue.human.zh.name, "建单(reg)");
  assert.equal(merged.tools.create_issue.human.en.name, "Create issue");
  assert.equal(merged.tools.list.human.zh.name, "列表");
});

test("projection: requested locale wins, zh is the only fallback endpoint", () => {
  const a = { human: { zh, en } };
  assert.equal(projectAnnotation(a, "en").name, "Issue tracking");
  assert.equal(projectAnnotation(a, "ja").name, "工单读写"); // ja 缺 → zh
  assert.equal(projectAnnotation(a, "zh-CN").name, "工单读写"); // zh* 归一
  assert.equal(projectAnnotation(a, "en").source, null);
});

test("projection: partial secondary track falls back per field", () => {
  const a = { human: { zh, en: { name: "Issue tracking", summary: "" } } };
  const p = projectAnnotation(a, "en");
  assert.equal(p.name, "Issue tracking");
  assert.equal(p.summary, zh.summary); // empty en summary → zh
});

test("projection: unannotated objects project to null (raw upstream path)", () => {
  assert.equal(projectAnnotation(null, "en"), null);
  assert.equal(projectAnnotation({}, "en"), null);
  assert.equal(projectAnnotation({ human: {} }, "en"), null);
});
