// ── member-agents-projection unit tests (complete-team-authoring-loop 2.2) ──
//
// 岗位与智能体是同一条指向上的两侧。这条测试钉的是「配对与断裂」：
// 加岗必产成对、删岗只删自己拥有的、改 id 两边同步、断裂可被前端预览。
//
//   node --test scripts/test-member-agents-projection.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { addPost, removePost, pairedAgentIdOf, pairingBreaks, renameAgent, slugify } = await import(
  "../web/src/lib/member-agents-projection.ts"
);

test("slugify 出安全 id", () => {
  assert.equal(slugify("电商岗"), "", "纯中文落空串——由 uniqueId 兜底，不是 slugify 的职责");
  assert.equal(slugify("Ecom Post"), "ecom-post");
  assert.equal(slugify("  a__b  "), "a-b");
});

test("纯中文标题加岗仍得合法 id（兜底为 post）", () => {
  const { member, agent } = addPost({ members: [], agents: [] }, "电商岗");
  assert.equal(member.ref, "post");
  assert.equal(agent.id, "post");
});

test("加岗产成对：member.presetId === agent.id", () => {
  const { member, agent } = addPost({ members: [], agents: [] }, "shop-agent");
  assert.equal(member.ref, agent.id);
  assert.equal(member.target.presetId, agent.id);
  assert.equal(member.target.kind, "pack-preset");
  assert.equal(member.target.packId, "{{PACK_ID}}");
});

test("加岗不撞已有 id（两侧都加后缀）", () => {
  const first = addPost({ members: [], agents: [] }, "shop");
  const doc = { members: first.members, agents: first.agents };
  const second = addPost(doc, "shop");
  assert.equal(second.member.ref, "shop-2");
  assert.equal(second.agent.id, "shop-2");
  assert.equal(second.member.target.presetId, "shop-2", "两侧同步加后缀");
});

test("加岗：新岗不是断裂源", () => {
  const { members, agents } = addPost({ members: [], agents: [] }, "x");
  assert.deepEqual(pairingBreaks({ members, agents }), []);
});

test("删岗连带删自己拥有的 agent", () => {
  const { members, agents } = addPost({ members: [], agents: [] }, "shop");
  const out = removePost({ members, agents }, members[0].ref);
  assert.equal(out.members.length, 0);
  assert.equal(out.agents.length, 0);
  assert.equal(out.removedAgentId, members[0].ref);
});

test("删岗不清除跨包引用指向的 agent", () => {
  const doc = {
    members: [{ ref: "p", title: "P", target: { kind: "pack-preset", packId: "{{PACK_ID:other}}", presetId: "foreign" } }],
    agents: [{ id: "mine", name: "mine" }],
  };
  const out = removePost(doc, "p");
  assert.equal(out.members.length, 0);
  assert.equal(out.agents.length, 1, "跨包引用不是本文件拥有的 agent");
  assert.equal(out.removedAgentId, null);
});

test("pairedAgentIdOf：非 pack-preset 返回 null", () => {
  assert.equal(pairedAgentIdOf({ ref: "t", title: "T", target: { kind: "tool", id: "s::t" } }), null);
});

test("pairedAgentIdOf：self 两种写法都认", () => {
  assert.equal(pairedAgentIdOf({ ref: "a", title: "A", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "x" } }), "x");
  assert.equal(pairedAgentIdOf({ ref: "a", title: "A", target: { kind: "pack-preset", packId: "{{PACK_ID:self}}", presetId: "y" } }), "y");
});

test("pairingBreaks：改掉 agent id 立刻报断裂", () => {
  const { members, agents } = addPost({ members: [], agents: [] }, "shop");
  const broken = { members, agents: [{ ...agents[0], id: "renamed" }] };
  const breaks = pairingBreaks(broken);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].presetId, members[0].target.presetId);
});

test("pairingBreaks：跨包引用不报（由铸造期解析）", () => {
  const breaks = pairingBreaks({
    members: [{ ref: "p", title: "P", target: { kind: "pack-preset", packId: "{{PACK_ID:other}}", presetId: "foreign" } }],
    agents: [],
  });
  assert.deepEqual(breaks, []);
});

test("renameAgent：两侧同步改名，配对不破", () => {
  const { members, agents } = addPost({ members: [], agents: [] }, "shop");
  const from = agents[0].id;
  const out = renameAgent({ members, agents }, from, "shop-renamed");
  assert.equal(out.agents[0].id, "shop-renamed");
  assert.equal(out.members[0].target.presetId, "shop-renamed");
  assert.deepEqual(pairingBreaks(out), []);
});

test("renameAgent：不触碰别的岗位", () => {
  const a = addPost({ members: [], agents: [] }, "a");
  const b = addPost({ members: a.members, agents: a.agents }, "b");
  const out = renameAgent({ members: b.members, agents: b.agents }, "a", "a2");
  const bMember = out.members.find((m) => m.ref === "b");
  assert.equal(bMember?.target.presetId, "b");
});
