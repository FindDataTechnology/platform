#!/usr/bin/env node
// ── Cell MCP budget tests
//    (enable-constructor-skill-authoring / D8 ④ 容量面) ───────────────────────
//
// Pins the install-face budget for MCP server count. Motivation (2026-11-08
// live): 41 installed packs → 32 MCP servers → dsh init exceeded its 60s
// budget → the entire cell was unreachable and every fleet's rounds were
// skipped, with the only symptom being "initialize timed out".
//
//   node --test scripts/test-cell-mcp-budget.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { mcpNamesOf, projectedMcpNames, mcpBudgetCheck, installBudgetVerdict, DEFAULT_MCP_SOFT_LIMIT, DEFAULT_MCP_HARD_LIMIT } =
  await import(path.join(here, "../lib/cell-mcp-budget.js"));

const manifestOf = (...names) => ({ mcpServers: names.map((n) => ({ registryName: n })) });
const manyManifests = (count) =>
  Array.from({ length: count }, (_, i) => manifestOf(`srv_${i}`));

test("mcpNamesOf is shape-tolerant", () => {
  assert.deepEqual([...mcpNamesOf(manifestOf(" a ", "b"))].sort(), ["a", "b"]);
  for (const bad of [null, {}, { mcpServers: null }, { mcpServers: [null, {}, { registryName: 5 }] }]) {
    assert.equal(mcpNamesOf(bad).size, 0, `must not throw on ${JSON.stringify(bad)}`);
  }
});

test("overlapping references count once — the profile materialises the union", () => {
  const existing = [manifestOf("fleet-architect", "facet-market")];
  const incoming = manifestOf("facet-market", "actions-mcp");
  const union = projectedMcpNames(existing, incoming);
  assert.deepEqual([...union].sort(), ["actions-mcp", "facet-market", "fleet-architect"]);
});

test("under the soft limit is a clean ok with no message", () => {
  const out = mcpBudgetCheck({ existingManifests: manyManifests(5), incomingManifest: manifestOf("x") });
  assert.equal(out.level, "ok");
  assert.equal(out.ok, true);
  assert.equal(out.message, null);
  assert.equal(out.count, 6);
});

test("crossing the soft limit still installs but names the real cause", () => {
  const out = mcpBudgetCheck({
    existingManifests: manyManifests(DEFAULT_MCP_SOFT_LIMIT),
    incomingManifest: manifestOf("extra"),
  });
  assert.equal(out.level, "soft");
  assert.equal(out.ok, true);
  assert.match(out.message, /60s/);
  assert.match(out.message, /stops starting/);
});

test("crossing the hard limit refuses and explains the whole-cell impact", () => {
  const out = mcpBudgetCheck({
    existingManifests: manyManifests(DEFAULT_MCP_HARD_LIMIT),
    incomingManifest: manifestOf("one_too_many"),
  });
  assert.equal(out.level, "hard");
  assert.equal(out.ok, false);
  assert.match(out.message, /EVERY fleet on it stops running/);
  assert.match(out.message, /Uninstall unused packs/);
  assert.deepEqual(out.added, ["one_too_many"]);
});

test("the 2026-11-08 incident shape is refused, not silently accepted", () => {
  // 32 distinct servers on the cell — the observed failing state.
  const out = mcpBudgetCheck({ existingManifests: manyManifests(32), incomingManifest: null });
  assert.equal(out.level, "hard");
  assert.equal(out.ok, false);
  assert.equal(out.count, 32);
});

test("env overrides move both limits, and hard never sits below soft", () => {
  const out = mcpBudgetCheck({
    existingManifests: manyManifests(9),
    incomingManifest: manifestOf("ten"),
    env: { CELL_MCP_SOFT_LIMIT: "5", CELL_MCP_HARD_LIMIT: "8" },
  });
  assert.equal(out.softLimit, 5);
  assert.equal(out.hardLimit, 8);
  assert.equal(out.level, "hard");

  const weird = mcpBudgetCheck({
    existingManifests: manyManifests(2),
    incomingManifest: null,
    env: { CELL_MCP_SOFT_LIMIT: "30", CELL_MCP_HARD_LIMIT: "5" },
  });
  assert.equal(weird.hardLimit, 30, "hard is clamped up to soft");
});

// ── 装包面判决（mcp-injection-budget-residual 2.2）───────────────────────────
// `mcpBudgetCheck` 说的是「cell 会落在哪」；`installBudgetVerdict` 多一条政策：
// 不新增 server 的包绝不硬拒。这两类必须成对钉住，否则「拒绝」与「放行」两侧
// 各改一半时没有一条会红。

test("install face: crossing the hard limit with a new server is REFUSED", () => {
  const out = installBudgetVerdict({
    existingManifests: manyManifests(DEFAULT_MCP_HARD_LIMIT),
    incomingManifest: manifestOf("one_too_many"),
  });
  assert.equal(out.refuse, true);
  assert.equal(out.level, "hard");
  assert.equal(out.count, DEFAULT_MCP_HARD_LIMIT + 1);
  assert.deepEqual(out.added, ["one_too_many"]);
  // 处置必须点名：现状数量 / 上限 / 该怎么办
  assert.match(out.message, new RegExp(`${DEFAULT_MCP_HARD_LIMIT + 1} MCP servers`));
  assert.match(out.message, new RegExp(`limit ${DEFAULT_MCP_HARD_LIMIT}`));
  assert.match(out.message, /Uninstall unused packs first/);
});

test("install face: exactly at the hard limit installs (the ceiling is `>`, not `>=`)", () => {
  const atCeiling = installBudgetVerdict({
    existingManifests: manyManifests(DEFAULT_MCP_HARD_LIMIT - 1),
    incomingManifest: manifestOf("fills_the_last_slot"),
  });
  assert.equal(atCeiling.count, DEFAULT_MCP_HARD_LIMIT);
  assert.equal(atCeiling.refuse, false);
  assert.equal(atCeiling.level, "soft", "at the ceiling is still advisory, not refused");

  const overByOne = installBudgetVerdict({
    existingManifests: manyManifests(DEFAULT_MCP_HARD_LIMIT),
    incomingManifest: manifestOf("over"),
  });
  assert.equal(overByOne.refuse, true, "one past the ceiling is the first refusal");
});

test("install face: a pack that adds NO new server is never hard-refused", () => {
  // 2026-11-08 的现场形状：32 个 server（超硬线 30）。此时若拒绝一切装包，
  // 这个 cell 连「装一个告诉 owner 该卸哪些包的包」都做不到 —— 正是该修它的时候被锁死。
  const out = installBudgetVerdict({
    existingManifests: manyManifests(32),
    incomingManifest: manifestOf("srv_0"), // 已有名字，union 不变
  });
  assert.equal(out.count, 32);
  assert.deepEqual(out.added, []);
  assert.equal(out.refuse, false);
  assert.equal(out.level, "hard", "state still reported as hard — only the refusal is withheld");
  assert.match(out.message, /adds no new MCP server/);
  assert.match(out.message, /stays broken/);

  // 同样是超线状态，但本包**新增**了 server ⇒ 拒绝。这一对才算把政策钉住。
  const withNew = installBudgetVerdict({
    existingManifests: manyManifests(32),
    incomingManifest: manifestOf("brand_new"),
  });
  assert.deepEqual(withNew.added, ["brand_new"]);
  assert.equal(withNew.refuse, true);
});

test("install face: under the soft limit is a clean pass with no message", () => {
  const out = installBudgetVerdict({ existingManifests: manyManifests(3), incomingManifest: manifestOf("a", "b") });
  assert.equal(out.refuse, false);
  assert.equal(out.level, "ok");
  assert.equal(out.message, null);
  assert.equal(out.count, 5);
});

test("install face: soft-band installs pass with the advisory message intact", () => {
  const out = installBudgetVerdict({
    existingManifests: manyManifests(DEFAULT_MCP_SOFT_LIMIT),
    incomingManifest: manifestOf("extra"),
  });
  assert.equal(out.refuse, false);
  assert.equal(out.level, "soft");
  assert.match(out.message, /soft limit/);
});

// ── 回滚点（ADR-0032 承诺「配置可整体置空 ⇒ 关闸」）──────────────────────────
// 关闸不是「上限变成 0」——那会把所有装包全拒掉，方向正好相反。所以两种关法都要
// 钉住，并且必须**在超线场景下**验：拿一个本来必拒的输入，关闸后必须放行。

const OVER_LIMIT = () => ({
  existingManifests: manyManifests(DEFAULT_MCP_HARD_LIMIT),
  incomingManifest: manifestOf("one_too_many"),
});

test("rollback: CELL_MCP_BUDGET=off disables the refusal", () => {
  assert.equal(installBudgetVerdict(OVER_LIMIT()).refuse, true, "baseline: this input IS refused");

  const off = installBudgetVerdict({ ...OVER_LIMIT(), env: { CELL_MCP_BUDGET: "off" } });
  assert.equal(off.refuse, false);
  assert.equal(off.level, "disabled");
  assert.equal(off.disabled, true);
  assert.equal(off.message, null, "off means silent, not a softer warning");
  // 关闸仍如实报数：`count` 是事实，不该被关闸抹掉
  assert.equal(off.count, DEFAULT_MCP_HARD_LIMIT + 1);
});

test("rollback: CELL_MCP_HARD_LIMIT=0 also disables (one knob is all people remember)", () => {
  for (const value of ["0", "off", "none", "disabled", "false", "OFF"]) {
    const out = installBudgetVerdict({ ...OVER_LIMIT(), env: { CELL_MCP_HARD_LIMIT: value } });
    assert.equal(out.disabled, true, `CELL_MCP_HARD_LIMIT=${value} must disable the gate`);
    assert.equal(out.refuse, false, `CELL_MCP_HARD_LIMIT=${value} must not refuse`);
  }
});

test("rollback: a numeric hard limit is NOT read as 'disabled'", () => {
  // 边界：`"30"` 与 `"0"` 只差一位，把数字当关闸会让闸在不知不觉中失效。
  const kept = installBudgetVerdict({ ...OVER_LIMIT(), env: { CELL_MCP_HARD_LIMIT: "30" } });
  assert.equal(kept.disabled, undefined);
  assert.equal(kept.hardLimit, 30);
  assert.equal(kept.refuse, true);

  const five = installBudgetVerdict({
    existingManifests: manyManifests(5),
    incomingManifest: manifestOf("x"),
    // 两个旋钮一起给：只给 hard=5 会被既有语义夹回 soft 默认值 22（hard 不低于
    // soft），那时 6 个 server 根本没越线 —— 断言就变成在验另一件事了。
    env: { CELL_MCP_SOFT_LIMIT: "5", CELL_MCP_HARD_LIMIT: "5" },
  });
  assert.equal(five.disabled, undefined);
  assert.equal(five.hardLimit, 5);
  assert.equal(five.refuse, true);
});
