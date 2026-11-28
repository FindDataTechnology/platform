// 能力层（capability-layer）：三轴模型 + 三作用域同形状 + 扩展 lineage。
// Run: node --test scripts/test-capability-layer.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCapabilities, normalizeVisibility, projectForAudience, ORIGIN, VISIBILITY, SCOPE } from "../lib/capability-layer.js";
import { derivePillars } from "../lib/pack-pillars.js";

const M = {
  name: "t", visibility: "public",
  skills: [{ name: "a", description: "A" }, { name: "b", description: "B" }],
  mcpServers: [{ registryName: "srv1", allowTools: ["x"] }],
  agents: [
    { id: "ag1", resources: { skills: ["a"] } },
    { id: "ag2", resources: { skills: ["a", "c"], lineage: { skills: { c: { from: "a", at: "2026-11-28T00:00:00Z" } } } } },
  ],
  fleet: { members: [{ id: "m1", agentRef: "ag1" }] },
};

test("三种作用域返回同一形状（字段集合一致）", () => {
  const shapes = ["pack", "team", "agent"].map((scope) => {
    const r = deriveCapabilities(M, { scope, agentId: scope === "agent" ? "ag1" : null });
    return Object.keys(r).sort().join(",");
  });
  assert.equal(new Set(shapes).size, 1, `形状不一致: ${shapes.join(" | ")}`);
});

test("三面与 derivePillars 逐字段一致（包装而非重写）", () => {
  const r = deriveCapabilities(M, { scope: "pack" });
  const p = derivePillars(M);
  assert.deepEqual(r.pillars.memory, p.memory);
  assert.deepEqual(r.pillars.toolkit, p.toolkit);
  assert.deepEqual(r.pillars.dashboard, p.dashboard);
});

test("pack 作用域给全量 skills；agent 作用域只给它声明的", () => {
  assert.deepEqual(deriveCapabilities(M, { scope: "pack" }).skills.resolved.map((s) => s.name), ["a", "b"]);
  assert.deepEqual(deriveCapabilities(M, { scope: "agent", agentId: "ag1" }).skills.resolved.map((s) => s.name), ["a"]);
});

test("扩展声明带 lineage ⇒ origin=agent；解析不到 ⇒ unresolved 带原因", () => {
  const r = deriveCapabilities(M, { scope: "agent", agentId: "ag2" });
  const c = r.skills.resolved.find((s) => s.name === "c");
  assert.equal(c.origin, "agent", "带 lineage 的扩展应标 origin=agent");
  assert.deepEqual(c.lineage, { from: "a", at: "2026-11-28T00:00:00Z" });
  // 不带 lineage 的扩展必须进 unresolved，不能被静默丢弃
  const bad = { ...M, agents: [{ id: "x", resources: { skills: ["zzz"] } }] };
  const r2 = deriveCapabilities(bad, { scope: "agent", agentId: "x" });
  assert.deepEqual(r2.skills.resolved, []);
  assert.deepEqual(r2.skills.unresolved, [{ name: "zzz", reason: "not-declared" }]);
});

test("指名不存在的角色 ⇒ 不回落到全包", () => {
  const r = deriveCapabilities(M, { scope: "agent", agentId: "nope" });
  assert.deepEqual(r.skills.resolved, [], "不许把全包能力给一个不存在的角色");
  assert.match(r.skills.error, /not found/);
});

test("三轴取值来自闭集", () => {
  const r = deriveCapabilities(M, { scope: "pack" });
  for (const c of r.capabilities) {
    assert.ok(ORIGIN.includes(c.origin), c.origin);
    assert.ok(VISIBILITY.includes(c.visibility), c.visibility);
    assert.ok(SCOPE.includes(c.scope), c.scope);
  }
});

test("可见性归一：两套词汇合成一套，默认 private", () => {
  assert.equal(normalizeVisibility("public"), "public");
  assert.equal(normalizeVisibility("group"), "tenant");
  assert.equal(normalizeVisibility("group-restricted"), "tenant");
  assert.equal(normalizeVisibility("unlisted"), "tenant");
  assert.equal(normalizeVisibility("internal"), "private");
  assert.equal(normalizeVisibility(null), "private");
  assert.equal(normalizeVisibility("typo-value"), "private", "未知值不放宽");
});

test("presentForAudience：不可见 ⇒ opaque 占位，不是缺席", () => {
  const r = deriveCapabilities({ ...M, visibility: "private" }, { scope: "pack" });
  const forPublic = projectForAudience(r, { audience: "public" });
  assert.ok(forPublic.some((c) => c.opaque === true), "私有能力对外应呈现占位");
  assert.ok(forPublic.every((c) => c.name !== "a" || c.visibility === "public"));
  const forOwner = projectForAudience(r, { audience: "owner" });
  assert.ok(forOwner.every((c) => c.opaque !== true), "属主应看到全部");
});

test("非法 scope 被结构化拒绝", () => {
  const r = deriveCapabilities(M, { scope: "bogus" });
  assert.match(r.error, /scope must be one of/);
});

// roleSkillReport：agent-serving 的解析不再静默丢弃（capability-layer 2.3）
test("roleSkillReport 把解析不到的声明放进 unresolved 而不是丢掉", async () => {
  const { roleSkillReport } = await import("../lib/agent-serving.js");
  const manifest = { skills: [{ name: "a", description: "A" }, { name: "b", description: "B" }] };
  const agent = { id: "ag", resources: { skills: ["a", "zzz"] } };
  const r = roleSkillReport(manifest, agent);
  assert.deepEqual(r.resolved.map((s) => s.name), ["a"], "只解析到 a");
  assert.deepEqual(r.unresolved, [{ name: "zzz", reason: "not-declared" }], "zzz 必须被报告而不是丢弃");
  assert.equal(r.declared, true);
});

test("roleSkillReport：带 lineage 的扩展解析为条目（正文不在 pack 里，不假装知道）", async () => {
  const { roleSkillReport } = await import("../lib/agent-serving.js");
  const manifest = { skills: [{ name: "a", description: "A" }] };
  const agent = { id: "ag", resources: { skills: ["a", "grown"], lineage: { skills: { grown: { from: "a", at: "t0" } } } } };
  const r = roleSkillReport(manifest, agent);
  assert.deepEqual(r.resolved.map((s) => s.name), ["a", "grown"]);
  assert.equal(r.resolved[1].content, null, "正文不在 pack 里，不许编造");
  assert.equal(r.resolved[1]._extension, true);
  assert.deepEqual(r.unresolved, []);
});

test("roleSkillReport：未声明 ⇒ 全包，且 declared=false", async () => {
  const { roleSkillReport } = await import("../lib/agent-serving.js");
  const manifest = { skills: [{ name: "a" }, { name: "b" }] };
  const r = roleSkillReport(manifest, { id: "ag" });
  assert.deepEqual(r.resolved.map((s) => s.name), ["a", "b"]);
  assert.equal(r.declared, false);
});

// 可见性投影三档（capability-layer 3.2/3.3）：不可见 ⇒ opaque 占位，不是缺席。
test("三档受众：public 只见 public，tenant 加见 tenant，owner 全见", () => {
  const r = deriveCapabilities({ name: "t", visibility: "public", skills: [{ name: "pub", description: "P" }], agents: [] }, { scope: "pack" });
  r.capabilities.push({ kind: "skill", name: "hidden", origin: "agent", visibility: "private", scope: "local", lineage: null, detail: null });
  r.capabilities.push({ kind: "mcp", name: "shared-srv", origin: "pack", visibility: "tenant", scope: "shared", lineage: null, detail: null });

  const names = (a) => projectForAudience(r, { audience: a }).map((c) => (c.opaque ? "[opaque]" : c.name));
  assert.deepEqual(names("public"), ["pub", "[opaque]", "[opaque]"]);
  assert.deepEqual(names("tenant"), ["pub", "[opaque]", "shared-srv"]);
  assert.deepEqual(names("owner"), ["pub", "hidden", "shared-srv"]);
});

test("opaque 占位带说明，且不泄露名字", () => {
  const r = deriveCapabilities({ name: "t", visibility: "private", skills: [{ name: "secret", description: "S" }], agents: [] }, { scope: "pack" });
  const [c] = projectForAudience(r, { audience: "public" });
  assert.equal(c.opaque, true);
  assert.equal(c.name, null, "占位不得带出原名字");
  assert.equal(c.note, "由提供方维护");
});

test("缺省 visibility 是 private（租来的 agent 默认不公开内部）", () => {
  // manifest 未声明 visibility 时，pack 的条目应落到 private
  const r = deriveCapabilities({ name: "t", skills: [{ name: "x", description: "X" }], agents: [] }, { scope: "pack" });
  assert.equal(r.capabilities[0].visibility, "private");
  const projected = projectForAudience(r, { audience: "public" });
  assert.equal(projected[0].opaque, true, "缺省 private ⇒ 对外是占位");
});

// 演化策略三档（capability-layer 4.x）：策略是声明，不写死。
test("manual 模式下 agent 写入停在待批", async () => {
  const { evaluateCapabilityWrite } = await import("../lib/capability-layer.js");
  const r = evaluateCapabilityWrite({ mode: "manual", write: { origin: "agent", scope: "local", name: "x" }, actor: "agent" });
  assert.equal(r.accepted, false);
  assert.equal(r.needsApproval, true);
});

test("agent-decides 接受 agent 对 local 的写入", async () => {
  const { evaluateCapabilityWrite } = await import("../lib/capability-layer.js");
  const r = evaluateCapabilityWrite({ mode: "agent-decides", write: { origin: "agent", scope: "local", name: "x" }, actor: "agent" });
  assert.equal(r.accepted, true);
});

test("任何模式都不得覆盖 pack 声明的条目", async () => {
  const { evaluateCapabilityWrite } = await import("../lib/capability-layer.js");
  for (const mode of ["manual", "auto-low-risk", "agent-decides"]) {
    const r = evaluateCapabilityWrite({ mode, write: { origin: "pack", scope: "local", name: "x" }, actor: "agent" });
    assert.equal(r.accepted, false, `${mode} 不该允许覆盖 pack 条目`);
  }
});

test("agent-decides 不覆盖 shared/pinned（团队一致面）", async () => {
  const { evaluateCapabilityWrite } = await import("../lib/capability-layer.js");
  const r = evaluateCapabilityWrite({ mode: "agent-decides", write: { origin: "agent", scope: "shared", name: "x" }, actor: "agent" });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /scope=local/);
});

test("auto-low-risk：低风险通过，高风险待人批", async () => {
  const { evaluateCapabilityWrite } = await import("../lib/capability-layer.js");
  const low = evaluateCapabilityWrite({ mode: "auto-low-risk", write: { origin: "agent", scope: "local" }, actor: "agent", risk: "low" });
  const high = evaluateCapabilityWrite({ mode: "auto-low-risk", write: { origin: "agent", scope: "local" }, actor: "agent", risk: "high" });
  assert.equal(low.accepted, true);
  assert.equal(high.accepted, false);
  assert.equal(high.needsApproval, true);
});

test("未知演化模式回落到 manual，不放宽", async () => {
  const { normalizeEvolutionMode, evaluateCapabilityWrite } = await import("../lib/capability-layer.js");
  assert.equal(normalizeEvolutionMode("bogus"), "manual");
  const r = evaluateCapabilityWrite({ mode: "bogus", write: { origin: "agent", scope: "local" }, actor: "agent" });
  assert.equal(r.accepted, false, "拼错的模式不该意外放宽");
});

// 消费面接入（capability-layer 5.x）：新增 capabilities 字段不得改变 pillars 的形状。
test("生产样本：capabilities.pillars 与 derivePillars 逐字段一致", async () => {
  // 用一个真实形状的 manifest（含 skills / mcpServers / memory / console / fleet）
  const m = {
    name: "样例包", version: "1.0.0", description: "d", category: "fleet", visibility: "public",
    skills: [{ name: "s1", description: "S1", content: "x".repeat(300) }],
    mcpServers: [{ registryName: "srv", allowTools: ["t1"] }],
    memory: { store: { home: "fleet" } },
    agents: [{ id: "a1", name: "岗1", persona: "p", resources: { skills: ["s1"] } }],
    fleet: { members: [{ id: "m1", agentRef: "a1" }] },
  };
  const c = deriveCapabilities(m, { scope: "pack" });
  const p = derivePillars(m);
  assert.deepEqual(c.pillars, p, "包装必须无损");
  assert.ok(Array.isArray(c.capabilities), "capabilities 是数组");
  assert.ok(c.capabilities.length > 0, "样例包应有能力条目");
});

// 读面接入（capability-layer 5.x）：内联 skill 不参与可见性过滤。
test("pack 内联的 skill 不因 registry 可见性而被藏掉", () => {
  // 场景：某个 skill 在 registry 里是 private，但它是被这个 pack 内联分发的。
  // 买家装上就有了——按 registry 可见性藏它会让已付费的包突然少能力。
  const manifest = { name: "t", visibility: "private", skills: [{ name: "inlined", description: "I" }], agents: [] };
  const r = deriveCapabilities(manifest, { scope: "pack" });
  const inline = new Set((manifest.skills ?? []).map((s) => s.name));
  // 模拟详情端点的组合逻辑
  const combined = r.capabilities
    .filter((c) => c.kind === "skill" && inline.has(c.name))
    .concat(projectForAudience(r, { audience: "public" }).filter((c) => !(c.kind === "skill" && inline.has(c.name))));
  const inlined = combined.find((c) => c.name === "inlined");
  assert.ok(inlined, "内联 skill 必须在结果里");
  assert.notEqual(inlined.opaque, true, "内联 skill 不得被投影成占位");
});

// 5.3：团队结构把能力面当作投影（不持有字段、依赖单向）。
test("团队结构的能力投影：返回 scope=team 的推导，且不新增真源字段", async () => {
  const { projectCapabilitiesForTeam } = await import("../lib/team-structure.js");
  const doc = {
    name: "样例团队", version: "1.0.0", description: "d", category: "fleet",
    skills: [{ name: "s1", description: "S1", content: "x".repeat(300) }],
    mcpServers: [{ registryName: "srv", allowTools: ["t1"] }],
    agents: [{ id: "a1", name: "岗1", persona: "p", resources: { skills: ["s1"] } }],
    fleet: { name: "样例团队", members: [{ ref: "m1", title: "岗1", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "a1" } }] },
  };
  const r = projectCapabilitiesForTeam(doc);
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.equal(r.scope, "team");
  assert.ok(Array.isArray(r.capabilities));
});

test("团队声明不合法 ⇒ 能力面如实不可得，不回落到全包", async () => {
  const { projectCapabilitiesForTeam } = await import("../lib/team-structure.js");
  const r = projectCapabilitiesForTeam({ name: "x", fleet: { members: "not-an-array" } });
  assert.equal(r.ok, false);
  assert.ok(r.reason, "必须给出原因");
  assert.equal(r.capabilities, undefined, "不许回落到一份看起来正常的能力表");
});

test("依赖单向：capability-layer 不 import team-structure（无环）", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../lib/capability-layer.js", import.meta.url), "utf8");
  assert.ok(!/from "\.\/team-structure\.js"/.test(src), "capability-layer 不得反向依赖 team-structure");
});

// team scope 的成员解析（2026-11-28 生产实撞）。
// 真实 manifest 的成员用 `target: {kind, id}`，不是裸 agentRef/preset/agentId。
// 早先按后者取永远匹配不到，team scope 的 skills 恒为空——静默返回空数组
// 比报错更难发现，所以这条测试用生产里的真实形状。
test("team scope 解析 target.id（existing-persona 形状）", () => {
  const m = {
    name: "t", skills: [{ name: "s1", description: "S1" }, { name: "s2", description: "S2" }],
    agents: [
      { id: "a1", name: "岗1", resources: { skills: ["s1"] } },
      { id: "a2", name: "岗2", resources: { skills: ["s2"] } },
    ],
    fleet: { members: [
      { ref: "m1", title: "岗1", target: { kind: "existing-persona", id: "a1" } },
      { ref: "m2", title: "岗2", target: { kind: "existing-persona", id: "a2" } },
    ] },
  };
  const r = deriveCapabilities(m, { scope: "team" });
  assert.deepEqual(r.skills.resolved.map((s) => s.name).sort(), ["s1", "s2"], "两个成员的技能都该出现");
});

test("team scope 解析 target.presetId（pack-preset 形状）", () => {
  const m = {
    name: "t", skills: [{ name: "s1", description: "S1" }],
    agents: [{ id: "a1", name: "岗1", resources: { skills: ["s1"] } }],
    fleet: { members: [{ ref: "m1", title: "岗1", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "a1" } }] },
  };
  const r = deriveCapabilities(m, { scope: "team" });
  assert.deepEqual(r.skills.resolved.map((s) => s.name), ["s1"]);
});

test("team scope 支持 memberRef 只取一个成员", () => {
  const m = {
    name: "t", skills: [{ name: "s1" }, { name: "s2" }],
    agents: [
      { id: "a1", resources: { skills: ["s1"] } },
      { id: "a2", resources: { skills: ["s2"] } },
    ],
    fleet: { members: [
      { ref: "m1", target: { kind: "existing-persona", id: "a1" } },
      { ref: "m2", target: { kind: "existing-persona", id: "a2" } },
    ] },
  };
  const r = deriveCapabilities(m, { scope: "team", memberRef: "m2" });
  assert.deepEqual(r.skills.resolved.map((s) => s.name), ["s2"]);
});
