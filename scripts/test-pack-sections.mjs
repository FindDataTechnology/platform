// ── 详情页章节的判据（pack-detail-as-page 2.1）───────────────────────────────
//
//   node --test scripts/test-pack-sections.mjs
//
// 今天实撞：我按 `agent.memory` 判断「记忆」章节，而 memory 是 **manifest 顶层
// 字段**（pillar-surfaces），类型里 agent 上根本没有这个字段——TypeScript 没报，
// 因为它在 `?? {}` 之后被推断成 `{}`。这类「判据读了一个从不存在的字段」的错，
// 表现为「章节永远不出现」，没有任何东西会响。
//
// 所以这条测试逐字段钉住：每个章节由**哪个真实字段**触发。
import { test } from "node:test";
import assert from "node:assert/strict";

import { sectionsFor } from "../web/src/components/packs/pack-sections.ts";

const wrap = (manifest) => ({ id: "p", name: "n", version: 1, manifest });

test("a bare pack shows only overview and versions", () => {
  const ids = sectionsFor(wrap({})).map((s) => s.id);
  assert.deepEqual(ids, ["overview", "versions"]);
});

test("roles / skills / mcp appear only when declared", () => {
  assert.ok(sectionsFor(wrap({ agents: [{ id: "a", name: "A", persona: "p" }] })).some((s) => s.id === "roles"));
  assert.ok(sectionsFor(wrap({ skills: [{ name: "s" }] })).some((s) => s.id === "skills"));
  assert.ok(sectionsFor(wrap({ mcpServers: [{ registryName: "m" }] })).some((s) => s.id === "mcp"));
});

test("memory is a MANIFEST-level field, not an agent field", () => {
  // 正：manifest.memory 触发
  assert.ok(sectionsFor(wrap({ memory: { store: { home: "member" } } })).some((s) => s.id === "memory"));
  // 反：把它挂在 agent 上**不该**触发——这正是我今天写错的那个判据
  const onAgent = sectionsFor(wrap({ agents: [{ id: "a", name: "A", persona: "p", memory: { store: {} } }] }));
  assert.equal(onAgent.some((s) => s.id === "memory"), false, "agent.memory is not the manifest's memory");
});

test("board appears only when console is declared", () => {
  assert.ok(sectionsFor(wrap({ console: { headline: "h" } })).some((s) => s.id === "board"));
  assert.equal(sectionsFor(wrap({})).some((s) => s.id === "board"), false);
});

test("order is reading order and versions is last", () => {
  const ids = sectionsFor(wrap({ agents: [{ id: "a", name: "A", persona: "p" }], skills: [{ name: "s" }], mcpServers: [{ registryName: "m" }], memory: {}, console: {} })).map((s) => s.id);
  assert.deepEqual(ids, ["overview", "roles", "skills", "mcp", "memory", "board", "versions"]);
});

test("a null pack yields no sections (not a crash)", () => {
  assert.deepEqual(sectionsFor(null), []);
});

// ── 双向一致（overhaul-pack-detail-presentation D6）──────────────────────────
//
// 实测两个在架包（投研团队评测两岗岗位包 / 铸造三岗岗位包）只在**角色级**声明
// 记忆：`derivePillars()` 报 present（内容渲染了），而旧判据看包级 `manifest.memory`
// 为 null（导航没有该项、内容也没有锚点）。判据必须与渲染同源。
test("agent-only memory still yields the memory section when the derivation says present", () => {
  const pack = {
    ...wrap({ agents: [{ id: "a", name: "A", persona: "p" }] }),
    pillars: { memory: { state: "present" }, toolkit: { state: "undeclared" }, dashboard: { state: "undeclared" } },
  };
  assert.ok(sectionsFor(pack).some((s) => s.id === "memory"), "派生说 present ⇒ 导航必须有记忆一项");
});

test("a derivation that says undeclared suppresses the section even when raw fields exist", () => {
  const pack = {
    ...wrap({ agents: [{ id: "a", name: "A", persona: "p" }], memory: { store: { home: "member" } } }),
    pillars: { memory: { state: "undeclared" }, toolkit: { state: "undeclared" }, dashboard: { state: "undeclared" } },
  };
  assert.equal(sectionsFor(pack).some((s) => s.id === "memory"), false, "派生说 undeclared ⇒ 不出现（否则就是内容没有、导航有的死链）");
});

test("every section the sheet can anchor is reachable in the nav", () => {
  const full = {
    ...wrap({
      agents: [{ id: "a", name: "A", persona: "p" }],
      skills: [{ name: "s" }],
      mcpServers: [{ registryName: "m" }],
      memory: { store: { home: "member" } },
      console: { blocks: [{ block: "team" }] },
      board: [{ artifact: "doc", title: "t", discipline: "d" }],
      monitoring: { anomaly_criteria: ["x"], escalate: { threshold: "y", severity_default: "high" } },
    }),
    pillars: {
      memory: { state: "present" },
      toolkit: { state: "present", roles: [{ agentId: "a", narrowed: true, effective: {}, effectiveServers: [], declared: null }] },
      dashboard: { state: "present" },
    },
    team: {
      state: "present",
      roster: [{ ref: "r", title: "岗", parentRef: null, target: { kind: null, presetId: null, packId: null }, cadence: { declared: false }, kpiSlots: [] }],
      edges: [],
      acceptance: [{ id: "a1", kind: "post-materialized", target: "岗", expect: null }],
    },
  };
  const ids = new Set(sectionsFor(full).map((s) => s.id));
  // AgentSpecSheet 会打锚点的每一段
  for (const anchored of ["roles", "skills", "mcp", "memory", "toolkit", "board", "acceptance", "monitoring", "output"]) {
    assert.ok(ids.has(anchored), `内容里打了 [data-section="${anchored}"]，导航却没有这一项`);
  }
});
