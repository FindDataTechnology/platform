#!/usr/bin/env node
// ── Locale overlay validation (add-pack-locale-tracks, tasks 1.1–1.4) ────────
//
// validatePackManifest's optional top-level `i18n` block: zh stays the main
// track in the base string fields, the overlay may only cover declared display
// fields, names entities the way they are declared (guide steps by index,
// skills/agents/bots/card skills by name/id), obeys the base field's own caps,
// the three-step guide covers whole-group-or-nothing, long-form parity is
// bounded (with a short-string floor), and the en secondary track is scanned
// for absolute-replacement claims (same rule as the marketing audit). The
// gateway publish gate consumes this validator verbatim, so these level tests
// pin the publish contract without a live facet.
//
//   node --test scripts/test-pack-locale-validation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { GENERIC_BOT_TYPE_NAMES } from "../lib/generic-bot-types.js";

const step = (title, body) => ({ title, body });

// A rich but valid zh main-track manifest: every overlay target exists.
const BASE = {
  name: "政心盯梢集群",
  description: "盯住政策与舆情的长期变化，把异常送到主人面前。",
  notes: "首版",
  skills: [{ name: "intel", description: "情报采集与归档", content: "正文" }],
  mcpServers: [],
  agents: [
    {
      id: "watch",
      name: "监视岗",
      persona: "你是监视岗。",
      serving: {
        protocol: "a2a",
        card: {
          name: "监视卡",
          description: "卡描述",
          skills: [{ id: "gather", name: "采集", description: "采集能力" }],
        },
      },
    },
  ],
  bots: [
    { id: "b1", name: "值班机器人", generic: GENERIC_BOT_TYPE_NAMES[0], description: "值班机器人描述" },
  ],
  cluster: { name: "集群名", description: "集群描述", defaultAgents: ["watch"] },
  guide: { steps: [step("一", "第一步正文"), step("二", "第二步正文"), step("三", "第三步正文")] },
};

const withOverlay = (en) => ({ ...BASE, i18n: { en } });
const errorsOf = (manifest) => validatePackManifest(manifest);
const has = (errors, needle) => errors.some((e) => e.error.includes(needle) || (e.entry || "").includes(needle));

const EN_GUIDE = {
  steps: [
    step("One", "First body"),
    step("Two", "Second body"),
    step("Three", "Third body"),
  ],
};

test("a manifest without i18n is unaffected (compat regression)", () => {
  assert.deepEqual(errorsOf(BASE), []);
});

test("a well-formed bilingual overlay validates clean", () => {
  const errors = errorsOf(withOverlay({
    name: "Policy Sentinel Cluster",
    description: "Watches long-run policy and sentiment shifts, surfacing anomalies.",
    notes: "v1.1",
    guide: EN_GUIDE,
    skills: { intel: { description: "Collects and files intelligence" } },
    agents: { watch: { name: "Watch Post", serving: { card: { name: "Watch Card", description: "Card desc", skills: { gather: { name: "Gather", description: "Gathering" } } } } } },
    bots: { b1: { name: "Duty Bot", description: "Duty bot description" } },
    cluster: { name: "Cluster Name", description: "Cluster description" },
  }));
  assert.deepEqual(errors, []);
});

test("a non-object i18n is rejected", () => {
  assert.ok(has(errorsOf({ ...BASE, i18n: "en" }), "i18n must be an object"));
  assert.ok(has(errorsOf({ ...BASE, i18n: ["en"] }), "i18n must be an object"));
});

test("an empty i18n object is rejected", () => {
  assert.ok(has(errorsOf({ ...BASE, i18n: {} }), "at least one locale block"));
});

test("malformed locale keys are rejected", () => {
  for (const key of ["EN", "e", "en_US", "english", "-en"]) {
    assert.ok(has(errorsOf({ ...BASE, i18n: { [key]: { name: "X" } } }), "BCP-47"), key);
  }
});

test("a zh locale inside the overlay is rejected", () => {
  assert.ok(has(errorsOf({ ...BASE, i18n: { zh: { name: "X" } } }), "main track"));
  assert.ok(has(errorsOf({ ...BASE, i18n: { "zh-CN": { name: "X" } } }), "main track"));
});

test("an unknown key inside a locale block is rejected", () => {
  assert.ok(has(errorsOf(withOverlay({ tagline: "X" })), "unknown key 'tagline'"));
});

test("an override with no zh base is rejected", () => {
  const noDesc = { ...BASE };
  delete noDesc.description;
  assert.ok(has(errorsOf({ ...noDesc, i18n: { en: { description: "has base? no" } } }), "zh main track"));
});

test("an over-cap scalar override is rejected and names the field", () => {
  const errors = errorsOf(withOverlay({ name: "x".repeat(161) }));
  assert.ok(has(errors, "i18n.en.name"));
  assert.ok(has(errors, "within 80 CJK-equivalent display widths"));
});

test("guide overlay: exactly three steps or nothing", () => {
  assert.ok(has(errorsOf(withOverlay({ guide: { steps: [step("One", "a"), step("Two", "b")] } })), "exactly 3 steps"));
});

test("guide overlay: a step missing its body is rejected (group-or-nothing)", () => {
  const partial = { steps: [step("One", "a"), { title: "Two" }, step("Three", "c")] };
  assert.ok(has(errorsOf(withOverlay({ guide: partial })), "i18n.en.guide.steps[1].body"));
});

test("guide overlay without a zh base guide is rejected", () => {
  const noGuide = { ...BASE };
  delete noGuide.guide;
  assert.ok(has(errorsOf({ ...noGuide, i18n: { en: { guide: EN_GUIDE } } }), "zh main track"));
});

test("undeclared entity references are rejected with entry names", () => {
  assert.ok(has(errorsOf(withOverlay({ skills: { nope: { description: "x" } } })), "i18n.en.skills['nope']"));
  assert.ok(has(errorsOf(withOverlay({ agents: { nope: { name: "x" } } })), "i18n.en.agents['nope']"));
  assert.ok(has(errorsOf(withOverlay({ bots: { nope: { name: "x" } } })), "i18n.en.bots['nope']"));
  assert.ok(has(errorsOf(withOverlay({ agents: { watch: { serving: { card: { skills: { nope: { name: "x" } } } } } } })), "serving.card.skills['nope']"));
});

test("a card override without a zh base card is rejected", () => {
  const noCard = { ...BASE, agents: [{ id: "watch", name: "监视岗", persona: "你是监视岗。", serving: { protocol: "a2a" } }] };
  assert.ok(has(errorsOf({ ...noCard, i18n: { en: { agents: { watch: { serving: { card: { name: "X" } } } } } } }), "serving.card"));
});

test("cluster override without a zh base cluster is rejected", () => {
  const noCluster = { ...BASE };
  delete noCluster.cluster;
  assert.ok(has(errorsOf({ ...noCluster, i18n: { en: { cluster: { name: "X" } } } }), "zh main track"));
});

test("long-form parity is bounded in both directions", () => {
  const zh = "字".repeat(40);
  const manifest = { ...BASE, description: zh };
  assert.ok(has(errorsOf({ ...manifest, i18n: { en: { description: "a".repeat(250) } } }), "more than 3x"));
  const longZh = { ...BASE, description: "字".repeat(100) };
  assert.ok(has(errorsOf({ ...longZh, i18n: { en: { description: "a".repeat(21) } } }), "more than 3x"));
  assert.deepEqual(errorsOf({ ...manifest, i18n: { en: { description: "a".repeat(100) } } }), []);
});

test("short strings are exempt from parity (the floor)", () => {
  const errors = errorsOf(withOverlay({ name: "Policy Sentinel Cluster — Watch the long run" }));
  assert.ok(!has(errors, "more than 3x"));
});

test("the en secondary track is scanned for absolute-replacement claims", () => {
  assert.ok(has(errorsOf(withOverlay({ name: "Replace all human work" })), "absolute-replacement claim"));
  assert.ok(has(errorsOf(withOverlay({ description: "The agent takes over all human work daily." })), "absolute-replacement claim"));
});

test("the zh main track is not claim-scanned this version", () => {
  const zhClaim = { ...BASE, name: "替代所有人类工作" };
  assert.deepEqual(errorsOf(zhClaim), []);
});

test("a non-en locale block is not claim-scanned", () => {
  assert.deepEqual(errorsOf({ ...BASE, i18n: { ja: { name: "Replace all human work" } } }), []);
});

test("errors name the exact locale field path", () => {
  const bad = { steps: [step("One", "a"), step("Two", "b"), step("x".repeat(121), "c")] };
  assert.ok(has(errorsOf(withOverlay({ guide: bad })), "i18n.en.guide.steps[2].title"));
});
// ── mcpServers overlay (add-mcp-annotation-overlay) ──────────────────────────

const MCP_BASE = {
  ...BASE,
  mcpServers: [{ registryName: "wire-ops", allowTools: ["create_issue"], description: "工单读写：建单、查单、改状态。" }],
};

test("a legal mcpServers description overlay passes", () => {
  assert.deepEqual(
    errorsOf({ ...MCP_BASE, i18n: { en: { mcpServers: { "wire-ops": { description: "Issue tracking: create, query, and transition tickets." } } } } }),
    [],
  );
});

test("mcpServers overlay referencing an undeclared registryName is rejected", () => {
  assert.ok(has(errorsOf({ ...MCP_BASE, i18n: { en: { mcpServers: { ghost: { description: "x" } } } } }), "does not declare in mcpServers"));
});

test("mcpServers overlay only covers description", () => {
  assert.ok(has(errorsOf({ ...MCP_BASE, i18n: { en: { mcpServers: { "wire-ops": { allowTools: ["x"] } } } } }), "unknown key"));
});

test("mcpServers base description cap is enforced on the zh main track", () => {
  assert.ok(
    has(errorsOf({ ...MCP_BASE, mcpServers: [{ registryName: "wire-ops", description: "x".repeat(301) }] }), "at most 300"),
  );
  assert.deepEqual(errorsOf({ ...MCP_BASE, mcpServers: [{ registryName: "wire-ops", description: "工单读写。" }] }), []);
});
