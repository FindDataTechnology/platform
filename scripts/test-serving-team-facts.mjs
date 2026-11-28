import test from "node:test";
import assert from "node:assert/strict";
import { composeDescriptor } from "../lib/agent-serving.js";
import { existsSync, readFileSync } from "node:fs";

// The corpus pack lives OUTSIDE this repo (`../fleet-packs/`, a sibling checkout
// in the author's workspace). Reading it at module load made the whole file
// throw ENOENT in any checkout that lacks it — the public image mirror has no
// fleet-packs, so this test crashed out of the CI suite on every run while
// passing locally. That is a false signal in both directions: locally green
// because the sibling happens to exist, CI red for a reason that has nothing to
// do with the code under test.
//
// Guard the read and skip the cases that need the corpus. The absence case
// below does not, so it keeps running — an explicit skip is not a vacuous pass.
const TEAM_PATH = new URL("../../fleet-packs/lex/statute-update-fleet/manifest.json", import.meta.url);
const HAS_TEAM = existsSync(TEAM_PATH);
const TEAM = HAS_TEAM ? JSON.parse(readFileSync(TEAM_PATH, "utf8")) : null;
const NEEDS_TEAM = HAS_TEAM ? {} : { skip: "fleet-packs corpus not present (sibling checkout outside this repo)" };

test("团队包：descriptor 携带岗位数与槽位键（discovery 面读这个）", NEEDS_TEAM, () => {
  const d = composeDescriptor({ manifest: TEAM, packId: "P", version: 1, agent: TEAM.agents[0] });
  assert.equal(d.team.postCount, 3);
  assert.deepEqual(d.team.posts.map((p) => p.ref), ["patrol", "chief", "poster"]);
  assert.deepEqual(d.team.posts[0].kpiSlots, ["new_statutes", "amended", "repealed"]);
});

test("团队事实是摘要不是 roster：不含 persona / promptTemplate / 标题", NEEDS_TEAM, () => {
  const d = composeDescriptor({ manifest: TEAM, packId: "P", version: 1, agent: TEAM.agents[0] });
  const s = JSON.stringify(d.team);
  for (const banned of ["persona", "promptTemplate", "监视位", "title"]) {
    assert.equal(s.includes(banned), false, `team 摘要里不该有 ${banned}`);
  }
});

test("非团队包不产 team 键（absence 保持 payload 不变）", () => {
  const plain = { name: "x", agents: [{ id: "a", name: "A", persona: "p" }] };
  const d = composeDescriptor({ manifest: plain, packId: "P", version: 1, agent: plain.agents[0] });
  assert.equal("team" in d, false);
});

test("团队摘要体积可控（不撑大每一条 agent entry）", NEEDS_TEAM, () => {
  const d = composeDescriptor({ manifest: TEAM, packId: "P", version: 1, agent: TEAM.agents[0] });
  assert.ok(JSON.stringify(d.team).length < 400, "摘要必须保持在几百字节内");
});

// ── D8 三态（openspec: unify-pillar-surfaces 4.4）───────────────────────────
//
// 机器面要区分三种包：声明了团队 console 的 / 有编制但无 console 的 /
// 只有一个 agent 什么编制都没有的。最后一种**只能靠一个明确的布尔事实**说出来
// ——「没有 team 键」既可能是没编制，也可能是编制解析失败，两者不能混。

test("有 fleet 声明 ⇒ descriptor.fleet = true（即使 members 为空）", () => {
  const empty = { name: "x", agents: [{ id: "a", name: "A", persona: "p" }], fleet: {} };
  const d = composeDescriptor({ manifest: empty, packId: "P", version: 1, agent: empty.agents[0] });
  assert.equal(d.fleet, true, "fleet:{} 仍是一份编制声明");
  assert.equal("team" in d, false, "没有 members 就不产 team 摘要——两者粒度不同");
});

test("有 members ⇒ fleet 与 team 同时产出", () => {
  const m = { name: "x", agents: [{ id: "a", name: "A", persona: "p" }],
              fleet: { members: [{ ref: "r1", kpiSlots: [{ key: "k1" }] }] } };
  const d = composeDescriptor({ manifest: m, packId: "P", version: 1, agent: m.agents[0] });
  assert.equal(d.fleet, true);
  assert.equal(d.team.postCount, 1);
});

test("无 fleet 声明 ⇒ 不产 fleet 键（消费方据此说「本包无团队编制」）", () => {
  const plain = { name: "x", agents: [{ id: "a", name: "A", persona: "p" }] };
  const d = composeDescriptor({ manifest: plain, packId: "P", version: 1, agent: plain.agents[0] });
  assert.equal("fleet" in d, false);
});
