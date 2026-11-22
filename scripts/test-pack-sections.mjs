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
