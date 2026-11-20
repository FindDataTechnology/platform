#!/usr/bin/env node
// ── Planner-pack content tests (add-mission-planner-pack task 2.1) ───────────
//
// The pack is pure content: these tests pin the contract surface the planner
// depends on — the five writeback kinds and their payloads, the idempotency
// key discipline, the search_agents honesty rule, the window/budget/retry
// discipline, and the serving shape (a2a + rhythm + budget).
//
//   node --test scripts/test-mission-planner-pack.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { buildManifest } = await import("../scripts/mission-planner-pack.mjs");
const { validatePackManifest } = await import("../lib/pack-manifest.js");

const manifest = buildManifest();
const skill = (name) => manifest.skills.find((s) => s.name === name)?.content ?? "";
const all = manifest.skills.map((s) => s.content).join("\n") + "\n" + manifest.agents[0].persona;

test("2.1 the manifest validates and is persona+skills only (no MCP refs)", () => {
  const errors = validatePackManifest(manifest);
  assert.deepEqual(errors, []);
  // v4: catalog-visible — the planner is the wanxing plane's own operational
  // agent and the M3② example-showcase (add-agent-card-examples).
  assert.equal(manifest.visibility, "public");
  assert.deepEqual(manifest.mcpServers, []);
  assert.equal(manifest.skills.length, 4);
});

test("2.1 the five writeback kinds and their payloads are all specified", () => {
  const proto = skill("mission-protocol");
  for (const kind of ["plan", "ready", "step", "report", "fail"]) {
    assert.ok(proto.includes(kind), `kind ${kind} named`);
  }
  assert.ok(/plan payload.*steps.*agent/.test(proto.replace(/\n/g, " ")), "plan payload shape");
  assert.ok(proto.includes("{stepId,status"), "step payload shape");
  assert.ok(proto.includes("{summary"), "report payload shape");
  assert.ok(proto.includes("{reason"), "fail payload shape");
});

test("2.1 the read-before-write and poll discipline is stated", () => {
  const proto = skill("mission-protocol");
  assert.ok(/每回合醒来先/.test(proto) || /先读后写/.test(all), "wake→GET first");
  assert.ok(proto.includes("GET <url>"), "GET verb");
  assert.ok(/awaiting_approval.*不动手|不动手.*awaiting_approval/s.test(all), "human-approval wait");
});

test("2.1 the idempotency key discipline names the key shape", () => {
  assert.ok(/wb-<mission 短 id/.test(all) || /wb-3f9a2c1b/.test(all), "key shape");
  assert.ok(/重发同键|同键/.test(all), "same key on resend");
});

test("2.1 the search_agents honesty rule is a hard constraint", () => {
  const planning = skill("mission-planning");
  assert.ok(/search_agents 实查/.test(planning), "verified-only agents");
  assert.ok(/绝不编造|绝不硬填/.test(planning), "never fabricate");
  assert.ok(/留空.*自行执行|自行执行/.test(planning), "self-execute fallback");
});

test("2.1 window/budget/retry discipline is stated in execution", () => {
  const exec = skill("mission-execution");
  assert.ok(/window_end/.test(exec) || /窗口已尽/.test(exec), "window expiry");
  assert.ok(/重试至多 1 次|重试 ≤1/.test(exec), "one retry");
  assert.ok(/cap/.test(exec), "cap awareness");
  assert.ok(/自行执行/.test(exec), "delegation fallback");
});

test("2.1 reporting distinguishes full vs partial delivery; notify is single-shot", () => {
  const rep = skill("mission-reporting");
  assert.ok(/部分交付/.test(rep), "partial delivery path");
  assert.ok(/mission_terminal/.test(rep), "notify event name");
  assert.ok(/至多一条/.test(rep), "single notify");
});

test("2.1 the serving contract is a2a with rhythm and a turn budget", () => {
  const agent = manifest.agents[0];
  assert.equal(agent.serving.protocol, "a2a");
  assert.ok(agent.serving.rhythm.length >= 1);
  assert.ok(agent.serving.rhythm[0].every.endsWith("m"));
  assert.equal(typeof agent.serving.budget.turnMinutes, "number");
  assert.ok(agent.serving.budget.turnMinutes >= 15);
});


test("2.1 v2 disciplines: wake-window check, bounded investigation, terminal-before-report", () => {
  const proto = skill("mission-protocol");
  const exec = skill("mission-execution");
  // Window check fires on EVERY wake, before any action.
  assert.ok(/GET 之后、做任何事之前先核/.test(all) || /醒来先 GET → 核窗/.test(proto), "wake-order window check");
  assert.ok(/窗口已尽/.test(proto), "expired-window action row");
  // Bounded investigation (context hygiene).
  assert.ok(/至多 8 次|调查有界/.test(all), "bounded investigation");
  assert.ok(/三行状态小结/.test(all), "wake summary");
  // Every step reaches a terminal state before the report.
  assert.ok(/report 之前逐步核过|绝不带着 running 状态交付/.test(exec), "terminal-before-report");
});

test("2.1 the planner card declares example prompts (add-agent-card-examples)", () => {
  const card = manifest.agents[0].serving.card ?? {};
  assert.ok(Array.isArray(card.examples) && card.examples.length >= 1 && card.examples.length <= 3);
  for (const ex of card.examples) assert.ok(typeof ex === "string" && ex.trim() && ex.length <= 200);
});
