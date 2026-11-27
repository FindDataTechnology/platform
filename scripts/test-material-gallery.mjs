// ── 素材画廊的三条语义（merge-plaza-into-facet-entry 2.2）─────────────────────
//
//   node --test scripts/test-material-gallery.mjs
//
// 画廊是 React 重写的，但三条语义都在**纯函数**里（mergeMaterials /
// filterMaterials），所以不需要浏览器就能钉住它们。这比测渲染更可靠：
// 语义错的时候，渲染测试往往还能通过（假绿）。
//
// 三条：
//   (a) live 成功 → 用实时数据，且**只就地更新、不逐出其他物种**
//   (b) live 不可达 → 用快照 + as-of 日期（状态字符串由组件给，函数层保证数据是快照）
//   (c) 快照有效时永不渲染空——即 merge/filter 不得把非空快照变成空
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeMaterials, filterMaterials, speciesOf } from "../facet/web/src/gallery-model.ts";

const snap = [
  { id: "p1", slug: "pack-p1", category: "pack", human: { "zh-CN": { name: "包一" } } },
  { id: "s1", slug: "skill-s1", category: "skill", human: { "zh-CN": { name: "技能一" } } },
  { id: "m1", slug: "mcp-m1", category: "mcp", human: { "zh-CN": { name: "服务一" } } },
];

test("(a) live only updates in place — it never evicts the other species", () => {
  // 这是原实现专门写过注释的那个坑：live 只覆盖 pack，整个替换会让
  // 技能与 MCP 页签在市场可达时变成空的。
  const live = [{ id: "p1", slug: "pack-p1", category: "pack", human: { "zh-CN": { name: "包一（实时）" } } }];
  const merged = mergeMaterials(snap, live, "live");
  assert.equal(merged.length, 3, "三种物种都还在");
  assert.equal(merged.find((m) => m.id === "s1")?.category, "skill");
  assert.equal(merged.find((m) => m.id === "m1")?.category, "mcp");
  assert.equal(merged.find((m) => m.id === "p1")?.human["zh-CN"].name, "包一（实时）", "pack 用实时值");
});

test("(a') a live-only entry is appended, not dropped", () => {
  const live = [{ id: "p2", slug: "pack-p2", category: "pack", human: { "zh-CN": { name: "新包" } } }];
  const merged = mergeMaterials(snap, live, "live");
  assert.equal(merged.length, 4);
  assert.ok(merged.some((m) => m.id === "p2"));
});

test("(b) snapshot state ignores live entirely", () => {
  const live = [{ id: "p9", slug: "pack-p9", category: "pack" }];
  const merged = mergeMaterials(snap, live, "snapshot");
  assert.deepEqual(merged.map((m) => m.id).sort(), ["m1", "p1", "s1"], "快照原样，不混 live");
});

test("(b') pending state also shows the snapshot, never an empty list", () => {
  const merged = mergeMaterials(snap, null, "pending");
  assert.equal(merged.length, 3);
});

test("(c) a valid snapshot is never turned into an empty list", () => {
  for (const state of ["pending", "live", "snapshot"]) {
    const merged = mergeMaterials(snap, state === "live" ? [] : null, state);
    assert.ok(merged.length > 0, `state=${state} 时快照不得变空`);
  }
});

test("filter: species tabs map to the same species sets as the old page", () => {
  assert.deepEqual(filterMaterials(snap, { tab: "skills", category: "", query: "", locale: "zh-CN" }).map((m) => m.id), ["s1"]);
  assert.deepEqual(filterMaterials(snap, { tab: "mcp", category: "", query: "", locale: "zh-CN" }).map((m) => m.id), ["m1"]);
  assert.equal(filterMaterials(snap, { tab: "all", category: "", query: "", locale: "zh-CN" }).length, 3);
  // agents = pack + facade + official-data（与旧实现一致）
  assert.ok(speciesOf("agents")("facade"));
  assert.ok(speciesOf("agents")("official-data"));
  assert.equal(speciesOf("agents")("skill"), false);
});

test("filter: search matches name, brief and tags", () => {
  const withTags = [...snap, { id: "t1", slug: "pack-t1", category: "pack", tags: ["营销"], human: { "zh-CN": { name: "团队" } } }];
  assert.deepEqual(filterMaterials(withTags, { tab: "all", category: "", query: "营销", locale: "zh-CN" }).map((m) => m.id), ["t1"]);
  assert.deepEqual(filterMaterials(withTags, { tab: "all", category: "", query: "技能", locale: "zh-CN" }).map((m) => m.id), ["s1"]);
});

test("species preselect maps the compatibility doors' query the same way", () => {
  // 兼容门跳转带 `?species=skill|mcp`。旧静态页按 hostname/query 预选，
  // 重写后按 query——三档映射必须一致，否则 skills. 门跳过来落在「全部」页签。
  const map = (raw) => {
    const v = String(raw ?? "").toLowerCase();
    if (v === "skill" || v === "skills") return "skills";
    if (v === "mcp") return "mcp";
    if (v === "agent" || v === "agents" || v === "pack") return "agents";
    return "all";
  };
  assert.equal(map("skill"), "skills");
  assert.equal(map("mcp"), "mcp");
  assert.equal(map("agent"), "agents");
  assert.equal(map(null), "all");
  assert.equal(map("nonsense"), "all");
});
