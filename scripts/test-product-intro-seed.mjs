// Content red lines + routing discipline for the product-intro official seed
// (add-product-intro-team): the team faces EXTERNAL visitors, so its every
// persona text must stay public-only, speak the v4 lexicon, and the front
// desk must carry the explicit legal→Lex routing. Asserted against the seed
// JSON text — no runtime needed.
//
// Run: node --test scripts/test-product-intro-seed.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(dir, "..", "docs", "fleet-templates", "product-intro-fleet.seed.json");
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

// All persona-bearing text: the seed's self-carried agents.
const texts = seed.agents.map((a) => ({ from: `seed.agents[${a.id}]`, text: `${a.name}\n${a.description}\n${a.persona}` }));

// Forbidden content: internal-ops information and replaced v3 lexicon. Patterns
// are word-boundary/mode-based so ordinary prose cannot trip them (design D4).
const FORBIDDEN = [
  { re: /舰队/, why: "v3 旧词「舰队」——词表 v4 用「智能体团队」" },
  { re: /员工/, why: "v3 框架旧词「员工」" },
  { re: /\bfleets?\b/i, why: "内部代码词 fleet" },
  { re: /cheap[-_ ]?\d/i, why: "内部节点名" },
  { re: /\b(sub2api|ciyuan|liuliang|tcr-relay|argocd|gitops|kubectl|helm|rollout)\b/i, why: "内部运维栈词" },
  { re: /fd-craw-private|registry_token|corpSecret|session-secret/, why: "内部仓/凭据词" },
  { re: /\b\d+\s*(分钟\/月|minutes?\/mo)/i, why: "内部额度/成本数字" },
  { re: /\$\s?\d{3,}/, why: "成本数字" },
  { re: /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|127\.0\.0\.1)\b/, why: "内网地址" },
  { re: /@(gmail|findmail|qq|163)\.com|aloadtree|platform-test/, why: "内部账号/邮箱" },
  { re: /\b(k8s|kubernetes|crd|pod)\b/i, why: "内部部署栈词" },
  { re: /wire-ops|facet-market|paper-trading|lex-ops|dsh-profile/i, why: "内部车道/模块名（走查 B3 实锤泄漏源）" },
];

test("every persona text is free of internal-ops information and v3 lexicon", () => {
  const violations = [];
  for (const { from, text } of texts) {
    for (const { re, why } of FORBIDDEN) {
      const m = re.exec(text);
      if (m) violations.push(`${from}: /${re.source}/ → "${text.slice(Math.max(0, m.index - 20), m.index + 25)}" (${why})`);
    }
  }
  assert.deepEqual(violations, [], `红线违规（注入即红的判别断言）:\n${violations.join("\n")}`);
});

test("all five product lines are covered by name", () => {
  const all = texts.map((t) => t.text).join("\n");
  for (const line of ["壹座", "识律", "柏讯", "谦面", "萬星"]) {
    assert.ok(all.includes(line), `产品线「${line}」必须出现在团队知识中`);
  }
  assert.ok(seed.fleet.members.length === 6, "前台+五专家=6 岗");
});

test("the v4 lexicon is spoken (智能体团队/智能体市场) and sources are dated", () => {
  const all = texts.map((t) => t.text).join("\n") + "\n" + seed.description;
  assert.ok(all.includes("智能体团队"), "v4 词「智能体团队」必须在场");
  assert.ok(all.includes("智能体市场"), "v4 词「智能体市场」必须在场");
  assert.match(seed.description, /finddatatech\.cloud/, "知识来源（官网）必须标注");
  assert.match(seed.description, /2026-10-30/, "知识抓取日期必须标注");
});

test("the front desk carries the explicit legal→Lex routing (promote Lex)", () => {
  const guide = seed.agents.find((a) => a.id === "intro-guide");
  assert.ok(guide, "前台岗位 intro-guide 必须存在");
  const p = guide.persona;
  assert.match(p, /识律/, "分诊指令必须点名识律");
  assert.match(p, /法律/, "分诊指令必须点名法律话题");
  assert.match(p, /转.{0,6}识律|交给.{0,6}识律|导向.{0,6}识律/, "必须存在把法律话题转给识律的显式指令");
  assert.match(p, /主动/, "用户裁定法律线要主动推荐，指令必须含主动引导");
});

test("官网研究/服务口径归前台、永忆归壹座——不为此单设专家", () => {
  const ids = seed.agents.map((a) => a.id);
  assert.ok(!ids.some((id) => /xingyan|research|yongyi|memory/.test(id)), "不得为研究线/永忆单设岗位");
  const yizuo = seed.agents.find((a) => a.id === "intro-yizuo");
  assert.match(yizuo.persona, /永忆/, "永忆（开源自托管形态）必须并入壹座专家叙事");
  const guide = seed.agents.find((a) => a.id === "intro-guide");
  assert.match(guide.persona, /微调|论文/, "官网「研究与业务」口径（论文/微调服务）必须并入前台话术");
});

test("the walkthrough fixes are pinned: open-source fact + hardened red lines", () => {
  const guide = seed.agents.find((a) => a.id === "intro-guide");
  // B2: the front desk must KNOW the open-source fact (it is public) — the
  // walkthrough showed it answering "official did not mark it open source".
  assert.match(guide.persona, /开源/, "前台必须掌握「壹座已开源」这一公开事实（B2）");
  assert.match(guide.persona, /github\.com\/FindDataTechnology\/platform/, "前台必须带公开仓地址（B2）");
  // B3/B4 hardening: no internal lane names, no local-file reconnaissance, and
  // no unpublic product surfaces (the 柏讯 walkthrough answer invented a
  // console / ticket / 24h promise).
  for (const a of seed.agents) {
    assert.match(a.persona, /不(?:得|要)提及任何内部车道名/, `${a.id} 必须带禁内部车道名指令（B3）`);
    assert.match(a.persona, /不要为回答访客而检索本机的项目文件/, `${a.id} 必须带禁翻本地文件指令（B3）`);
  }
  const wire = seed.agents.find((a) => a.id === "intro-wire");
  assert.ok(!/需求单|控制台|24 ?小时/.test(wire.persona), "柏讯 persona 不得出现官网没有的产品面（B4）");
  assert.match(wire.persona, /开放数据本体/, "柏讯 persona 必须保留官网三件能力之一");
});

test("the team is fully self-carried — six agents, every member a pack-preset", () => {
  assert.equal(seed.agents.length, 6, "六岗全部自载（maxAgents 50 后不再拆引用岗）");
  const agentIds = new Set(seed.agents.map((a) => a.id));
  for (const m of seed.fleet.members) {
    assert.equal(m.target.kind, "pack-preset", `成员 ${m.ref} 必须指向包内岗位`);
    assert.equal(m.target.packId, "{{PACK_ID}}", `成员 ${m.ref} 的 packId 必须是 {{PACK_ID}} 占位`);
    assert.ok(agentIds.has(m.target.presetId), `成员 ${m.ref} 的 presetId ${m.target.presetId} 必须是自载 agent`);
    assert.ok(m.cadence == null, `成员 ${m.ref} 为会话型，无节奏（缺省或 null）`);
  }
  assert.ok(seed.agents.every((a) => a.name && a.persona && a.persona.length <= 16 * 1024), "每岗有人名与 persona 且不超 PACK_LIMITS.maxPersonaChars");
});
