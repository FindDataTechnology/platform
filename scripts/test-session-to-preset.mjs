#!/usr/bin/env node
// ── Session-to-preset tests (add-session-to-preset) ─────────────────────────
//
// Covers the three new seams:
//   validator — the optional `examples` field: absent OK, legal list OK,
//               over-count/over-length/empty-item rejected with a named
//               error (task 1.1);
//   storage   — examples round-trip through createUserPreset/updateUserPreset
//               and hydrate as absent for pre-v26 rows (NULL → undefined);
//   bridge    — preset.examples lands on the draft agent's serving card;
//               no examples → no card key (task 1.2).
//
//   node --test scripts/test-session-to-preset.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "session-to-preset-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

const { validatePresetBody } = await import("../server/routes/custom-presets.js");
const db = await import("../db.js");
await db.initDb();

test("validator: examples absent is fine (back-compat)", () => {
  const r = validatePresetBody({ name: "方案", persona: "你是助手" });
  assert.ok(r.ok);
  assert.equal(r.value.examples, undefined);
});

test("validator: legal examples pass and are trimmed", () => {
  const r = validatePresetBody({
    name: "方案",
    persona: "你是助手",
    examples: ["  帮我把这份财报做成图表 ", "找出合同里的风险条款"],
  });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.value.examples, ["帮我把这份财报做成图表", "找出合同里的风险条款"]);
});

test("validator: over-count rejected with a named error", () => {
  const r = validatePresetBody({
    name: "方案",
    persona: "你是助手",
    examples: ["一", "二", "三", "四"],
  });
  assert.ok(!r.ok);
  assert.match(r.error, /1-3 sample prompts/);
});

test("validator: over-length item rejected", () => {
  const r = validatePresetBody({
    name: "方案",
    persona: "你是助手",
    examples: ["x".repeat(201)],
  });
  assert.ok(!r.ok);
  assert.match(r.error, /at most 200 characters/);
});

test("validator: empty item rejected", () => {
  const r = validatePresetBody({ name: "方案", persona: "你是助手", examples: ["   "] });
  assert.ok(!r.ok);
  assert.match(r.error, /non-empty string/);
});

test("storage: examples round-trip through create/update/hydrate", () => {
  const created = db.createUserPreset({
    name: "会话方案",
    persona: "你是数据分析助手",
    examples: ["做成月度图表", "总结三条洞察"],
  });
  assert.deepEqual(created.examples, ["做成月度图表", "总结三条洞察"]);

  const updated = db.updateUserPreset(created.id, { examples: ["只留一条"] });
  assert.deepEqual(updated.examples, ["只留一条"]);

  const cleared = db.updateUserPreset(created.id, { examples: null });
  assert.equal(cleared.examples, undefined);
});

test("bridge: preset examples land on the draft agent's serving card", async () => {
  const { composePackDraftFromPreset } = await import("../preset-pack-bridge.js");
  const preset = db.createUserPreset({
    name: "带示例的方案",
    persona: "你是助手",
    examples: ["问一", "问二"],
  });
  const { draft } = await composePackDraftFromPreset(preset, {});
  const agent = draft.entries.agents[0];
  assert.deepEqual(agent.serving.card.examples, ["问一", "问二"]);
  assert.equal(agent.serving.protocol, "a2a");
});

test("bridge: no examples → no card key on the agent", async () => {
  const { composePackDraftFromPreset } = await import("../preset-pack-bridge.js");
  const preset = db.createUserPreset({ name: "无示例方案", persona: "你是助手" });
  const { draft } = await composePackDraftFromPreset(preset, {});
  const agent = draft.entries.agents[0];
  assert.equal(agent.serving.card, undefined);
});
