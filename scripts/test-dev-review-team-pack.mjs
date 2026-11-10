#!/usr/bin/env node
// ── 研发评审小队 pack 基线（cast-dev-review-team）──────────────────────────
//
// 把 spec 的三条拒绝演变成测试：改铸的外部角色必须是无触手顾问。
//   · validatePackManifest 零错（与发布门同一套规则）
//   · 八岗全部 toolFace=chat，且 persona 里写着读—判—说契约
//   · 每岗带自己的上游出处（文件路径 + 钉版 sha），包级 provenance 完整
//   · persona 不得含「我打开/我运行/我扫描」类动手承诺（谎报触手）
//   · 判据是领域性的（不是八岗复制粘贴的通用套话）

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { validatePackManifest } from "../lib/pack-manifest.js";

const MANIFEST = JSON.parse(readFileSync(new URL("../packs/dev-review-team/manifest.json", import.meta.url), "utf8"));
const PIN = "ed74d115b7fb7026a22a4f816a8e3250f425e3b4";
const ROLES = [
  "code-reviewer",
  "security-auditor",
  "architect-reviewer",
  "performance-engineer",
  "qa-expert",
  "api-designer",
  "debugger",
  "api-documenter",
];

test("manifest passes the same publish-gate validator", () => {
  assert.deepEqual(validatePackManifest(MANIFEST), []);
});

test("exactly the eight declared advisory roles, every one handless", () => {
  assert.deepEqual(MANIFEST.agents.map((a) => a.id).sort(), [...ROLES].sort());
  for (const a of MANIFEST.agents) {
    assert.equal(a.serving?.protocol, "a2a", `${a.id} must serve a2a`);
    assert.equal(a.serving?.toolFace, "chat", `${a.id} must stay on the narrowed (chat) tool face`);
  }
});

test("each persona carries its own upstream attribution with the pinned revision", () => {
  for (const a of MANIFEST.agents) {
    assert.ok(a.persona.includes("VoltAgent/awesome-claude-code-subagents"), `${a.id}: repo attribution missing`);
    assert.ok(a.persona.includes(PIN), `${a.id}: pinned revision missing`);
    // 出处必须是具体文件，不是笼统的一句「来自上游仓」
    assert.match(a.persona, /categories\/[\w-]+\/[\w-]+\.md/, `${a.id}: source file path missing`);
  }
});

test("personas state the read-judge-say contract, not tool promises", () => {
  // 谎报触手的形态：第一人称地声称打开过仓库/跑过测试/扫描过端口/查过日志系统。
  const LIE_PATTERNS = [
    /我(会|先|刚刚)?打开(了|过)?仓库/,
    /我(会|刚刚)?(运行|执行)(了|过)?(测试|基准|用例)/,
    /我(会)?扫描(了|过)?(端口|系统|网络)/,
    /实测[结证]/,
  ];
  for (const a of MANIFEST.agents) {
    for (const re of LIE_PATTERNS) {
      assert.ok(!re.test(a.persona), `${a.id}: persona promises execution (${re})`);
    }
    assert.ok(a.persona.includes("读—判—说"), `${a.id}: read-judge-say contract missing`);
    assert.ok(a.persona.includes("触手"), `${a.id}: handless declaration missing`);
    assert.ok(a.persona.includes("输出契约"), `${a.id}: output contract missing`);
    assert.ok(a.persona.includes("职责边界"), `${a.id}: scope boundary missing`);
  }
});

test("criteria are domain-specific, not eight copies of boilerplate", () => {
  // 判据段抽出来两两比对：任何两岗的判据行重合率过半 = 复制粘贴的套话。
  const sections = MANIFEST.agents.map((a) => {
    const m = /## 判据\n\n([\s\S]*?)\n\n##/.exec(a.persona);
    assert.ok(m, "each persona must have a 判据 section");
    return m[1].split("\n").filter(Boolean);
  });
  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const shared = sections[i].filter((line) => sections[j].includes(line)).length;
      const min = Math.min(sections[i].length, sections[j].length);
      assert.ok(shared / min <= 0.4, `${MANIFEST.agents[i].id} and ${MANIFEST.agents[j].id} share ${shared}/${min} criteria lines`);
    }
  }
});

test("provenance records the upstream as adopted material", () => {
  const p = MANIFEST.provenance;
  assert.equal(p.kind, "official-adopted");
  assert.equal(p.license, "MIT");
  assert.match(p.revision, /^[0-9a-f]{40}$/);
  assert.equal(p.upstreamName, "VoltAgent/awesome-claude-code-subagents");
  assert.equal(p.upstreamUrl, "https://github.com/VoltAgent/awesome-claude-code-subagents");
});

test("the pack declares no skills or MCP reach", () => {
  // 这是一支顾问小队：不借包夹带技能正文或工具面引用。
  assert.equal(MANIFEST.skills, undefined);
  assert.equal(MANIFEST.mcpServers, undefined);
});

test("i18n en overlay mirrors every declared agent id", () => {
  const overlay = MANIFEST.i18n?.en;
  assert.ok(overlay, "en overlay required");
  for (const a of MANIFEST.agents) {
    assert.ok(overlay.agents?.[a.id]?.name, `en overlay missing agents.${a.id}.name`);
    assert.ok(overlay.agents?.[a.id]?.serving?.card?.name, `en overlay missing agents.${a.id} card name`);
    // 覆盖层比基座窄：agent 只许 name+serving，card 不收 examples——写多了过不了发布门。
    assert.equal(overlay.agents?.[a.id]?.description, undefined);
  }
});
