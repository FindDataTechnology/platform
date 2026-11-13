#!/usr/bin/env node
// ── Official starter content baseline (modernize-official-starter-agents) ────
//
// Pins the CONTENT quality bar of the five official starter teams as declared
// in staging/modernize.json (the published v7 source of truth):
//   1. every persona carries the structured sections (职责边界/输出契约 or
//      equivalent discipline markers) and is materially thicker than v6
//   2. every v6 report_status slot survives VERBATIM (深化不改变语义)
//   3. skills bucket ≥2 per team, ASCII names (publish-gate charset)
//   4. mcpServers only pin gate-proven registryNames with non-empty
//      allowTools; runtime-injected teams stay honestly empty
//   5. structure invariants: the overlay touches ONLY agents/skills/
//      mcpServers — fleet/guide/notes/name/description/category/tags must be
//      absent from the overlay (structure is v6's to keep)
//
//   node --test scripts/test-starter-content-baseline.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const overlay = JSON.parse(read("openspec/changes/archive/2026-11-01-modernize-official-starter-agents/staging/modernize.json"));

const NAMES = Object.keys(overlay);
assert.equal(NAMES.length, 5, "the five starter teams are the overlay's whole world");

const SLOTS = {
  "service-lead": ["open_tickets"],
  "service-agent": ["handled", "first_reply_min"],
  "service-qa": ["qa_pass_rate", "sampled"],
  "company-ceo": ["patrol_notes"],
  "company-oss": ["stars_week", "issues_open"],
  "company-invest": ["pnl_day", "watch_count"],
  "content-editor": ["brief_notes"],
  "content-planner": ["topics_pool", "picked"],
  "content-writer": ["drafts_done", "words_week"],
  "invest-chief": ["morning_notes"],
  "invest-macro": ["macro_view", "watch_count"],
  "invest-sector": ["sector_pick", "top_ticker"],
  "intel-chief": ["brief_digest", "sources_covered"],
  "intel-tech": ["tech_hits", "top_story"],
  "intel-market": ["market_moves", "watch_alerts"],
};

test("every persona is structured, thick, and slot-faithful", () => {
  for (const [pid, ov] of Object.entries(overlay)) {
    for (const [agentId, persona] of Object.entries(ov.personas)) {
      assert.ok(persona.length >= 380, `${agentId}: persona ${persona.length} chars (≥380)`);
      assert.ok(persona.includes("【职责边界】"), `${agentId}: 职责边界 section`);
      assert.ok(persona.includes("【输出契约】") || persona.includes("【工作纪律】"), `${agentId}: contract/discipline section`);
      for (const slot of SLOTS[agentId] ?? []) {
        assert.ok(persona.includes(slot), `${agentId}: slot ${slot} survives verbatim`);
      }
      assert.ok(
        ["绝不编造", "不给结论", "不替其编造"].some((w) => persona.includes(w)),
        `${agentId}: honesty discipline phrase survives`,
      );
    }
    assert.equal(Object.keys(ov.personas).length, 3, `${pid.slice(0, 8)}: exactly 3 posts`);
  }
});

test("skills bucket: ≥2 per team, ASCII names, executable content", () => {
  for (const [pid, ov] of Object.entries(overlay)) {
    assert.ok(ov.skills.length >= 2, `${pid.slice(0, 8)}: skills ≥2`);
    for (const s of ov.skills) {
      assert.match(s.name, /^[A-Za-z0-9._-]{1,64}$/, `${pid.slice(0, 8)}/${s.name}: gate charset`);
      assert.ok(s.content.length >= 200, `${s.name}: content ≥200 chars (executable, not a stub)`);
      assert.ok(s.description.length > 0);
    }
  }
});

test("mcpServers: only gate-proven registryNames with non-empty allowTools", () => {
  const PROVEN = new Set(["fd-daas-mcp", "fd-quant", "fd-info", "facet-market", "wire-ops", "actions-mcp", "wire-build-mcp", "fleet-architect", "fd-open-data-mcp", "fd-find-data-business-mcp", "fd-cn-report"]);
  for (const [pid, ov] of Object.entries(overlay)) {
    for (const x of ov.mcpServers ?? []) {
      assert.ok(PROVEN.has(x.registryName), `${pid.slice(0, 8)}: ${x.registryName} is gate-proven`);
      assert.ok(Array.isArray(x.allowTools) && x.allowTools.length > 0, `${x.registryName}: allowTools non-empty (gate requires real tool leaves)`);
    }
  }
  // 客服班组's CRM tools are runtime-injected — the empty bucket is honest.
  assert.deepEqual(overlay["EMGW14N8voa1b36LSuTxxw"].mcpServers, [], "客服班组: runtime-injected CRM → honestly empty mcp bucket");
});

test("the overlay touches ONLY the three content buckets (structure is v6's)", () => {
  for (const [pid, ov] of Object.entries(overlay)) {
    for (const k of Object.keys(ov)) {
      assert.ok(["personas", "skills", "mcpServers"].includes(k), `${pid.slice(0, 8)}: overlay key ${k} is a content bucket`);
    }
  }
});
