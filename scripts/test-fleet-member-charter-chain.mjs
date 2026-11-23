// 逐岗章程：模板成员段 → agent 文档 → persona（enrich-fleet-template-member-config 3.1 / 3.3）。
//
// 这条链有三处可以静默断掉，每一处都有先例：
//   1. 成员段写了章程，但解析器不认 → 被 unknown-field 拒（这是好的）或静默丢（坏的）
//   2. 解析器认了，但 assembleManifest 不合并 → 章程停在模板里，persona 里没有
//   3. 合并了，但写错 id（ref 与 presetId 混淆）→ 章程串到别的岗
//
// Run: node --test scripts/test-fleet-member-charter-chain.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseFleetTemplate, MEMBER_CHARTER_MAX_CHARS } = await import("../server/fleet-template.js");
const { assembleManifest } = await import("../server/blueprint-validate.js");

const mkContent = (over = {}) => ({
  kind: "team",
  boundary: { name: "章程验证团队", oneLine: "验证逐岗章程链路" },
  agents: [
    { id: "p-a", name: "岗A", persona: "你是岗A。", resources: { mcpTools: {} } },
    { id: "p-b", name: "岗B", persona: "你是岗B。", resources: { mcpTools: {} } },
  ],
  skills: [{ name: "s", description: "d", content: "---\nname: s\ndescription: d\n---\n\n# s\n" }],
  mcpServers: [{ registryName: "fd-info", allowTools: ["locate_evidence"] }],
  fleet: {
    name: "章程验证集群（模板）",
    members: [
      { ref: "a", title: "岗A", parentRef: null, target: { kind: "pack-preset", packId: "PK", presetId: "p-a" }, kpiSlots: [{ key: "n", label: "n" }] },
      { ref: "b", title: "岗B", parentRef: null, target: { kind: "pack-preset", packId: "PK", presetId: "p-b" }, kpiSlots: [{ key: "m", label: "m" }] },
    ],
    orchestration: { mode: "supervisor" },
  },
  ...over,
});

test("成员段章程经 assembleManifest 落到同 presetId 的 agent（不是同 ref 的）", () => {
  const content = mkContent();
  content.fleet.members[0].memory = { guidance: "本岗只记报数摘要。" };
  const manifest = assembleManifest(content);
  const a = manifest.agents.find((x) => x.id === "p-a");
  const b = manifest.agents.find((x) => x.id === "p-b");
  assert.equal(a.memory.guidance, "本岗只记报数摘要。");
  assert.equal(b.memory, undefined, "不能串到另一个岗");
});

test("ref 与 presetId 不同名时也不会串（ref=a 但 presetId=p-a）", () => {
  const content = mkContent();
  content.fleet.members[1].memory = { guidance: "岗B 的章程。" };
  const manifest = assembleManifest(content);
  assert.equal(manifest.agents.find((x) => x.id === "p-a").memory, undefined);
  assert.equal(manifest.agents.find((x) => x.id === "p-b").memory.guidance, "岗B 的章程。");
});

test("agent 自己声明了 guidance ⇒ 模板层不覆盖它（更具体的那一份优先）", () => {
  const content = mkContent();
  content.agents[0].memory = { guidance: "agent 自带的章程。" };
  content.fleet.members[0].memory = { guidance: "模板里的章程。" };
  const manifest = assembleManifest(content);
  assert.equal(manifest.agents.find((x) => x.id === "p-a").memory.guidance, "agent 自带的章程。");
});

test("未声明章程 ⇒ agent 保持原样（不凭空造 memory 块）", () => {
  const manifest = assembleManifest(mkContent());
  for (const a of manifest.agents) assert.equal(a.memory, undefined);
});

test("超过 600 字 ⇒ 解析期拒收，不截断", () => {
  const c = mkContent();
  c.fleet.members[0].memory = { guidance: "x".repeat(MEMBER_CHARTER_MAX_CHARS + 1) };
  const r = parseFleetTemplate({ fleet: c.fleet });
  assert.equal(r.ok, false);
  assert.equal(r.code, "fleet_member_memory_invalid");
  assert.ok(r.error.includes("拒收而不是截断"));
});

test("恰好 600 字 ⇒ 通过（边界在等号上）", () => {
  const c = mkContent();
  c.fleet.members[0].memory = { guidance: "x".repeat(MEMBER_CHARTER_MAX_CHARS) };
  assert.equal(parseFleetTemplate({ fleet: c.fleet }).ok, true);
});

test("memory 块只认 guidance：四轴写进成员段 ⇒ 拒收并说明那是包级", () => {
  const c = mkContent();
  c.fleet.members[0].memory = { guidance: "ok", store: { home: "member" } };
  const r = parseFleetTemplate({ fleet: c.fleet });
  assert.equal(r.ok, false);
  assert.equal(r.code, "fleet_member_memory_invalid");
  assert.ok(r.error.includes("包级"));
});

test("章程确实进 persona（与 catalogEntryPersona 同源）", async () => {
  const { catalogEntryPersona } = await import("../dsh-profile.js");
  const content = mkContent();
  content.fleet.members[0].memory = { guidance: "本岗只记报数摘要。" };
  const manifest = assembleManifest(content);
  const persona = catalogEntryPersona({ ...manifest.agents[0], packId: "PK" });
  assert.ok(persona.includes("【记忆章程】本岗只记报数摘要。"));
});
