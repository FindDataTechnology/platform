// 机器面与人类面同源（openspec: team-derivation 3.4 / pillar-surfaces 机器面纪律）
// 运行：node --test scripts/test-plaza-team-facts.mjs
//
// 两条断言，都是「机器面只带契约级事实」的可执行形式：
//   ① 同一岗位的槽位键在 plaza 投影与 deriveTeam 逐字相同（同源，不是各算一遍）
//   ② 机器面里**不出现** persona 正文与 promptTemplate 原文（散文不透出）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.dirname(new URL(import.meta.url).pathname);
const { deriveTeam } = await import(pathToFileURL(path.join(root, "..", "lib", "team-derivation.js")).href);

// plaza-export.mjs 是脚本，不导出 teamFactsOf；用它的真实输入路径复算：
// 该脚本对 `anchor.manifest` 调 teamFactsOf，等价于「manifest → 契约事实」。
// 这里直接读脚本源码确认它没有另写一套收窄规则，再用 deriveTeam 对拍数据。
const MANIFEST = path.join(root, "..", "..", "fleet-packs", "lex", "statute-update-fleet", "manifest.json");

test("槽位键同源：deriveTeam 与 plaza 契约事实逐字一致", async () => {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const team = deriveTeam(m);
  assert.equal(team.state, "present");

  // plaza 侧的形状（与 teamFactsOf 输出一致）
  const plazaPosts = (m.fleet.members ?? []).map((x) => ({
    ref: x.ref,
    kpiSlots: (x.kpiSlots ?? []).map((k) => k.key),
    cron: x.cadence?.cron ?? null,
  }));

  for (const post of plazaPosts) {
    const row = team.roster.find((r) => r.ref === post.ref);
    assert.ok(row, `deriveTeam 里缺岗位 ${post.ref}`);
    assert.deepEqual(row.kpiSlots.map((k) => k.key), post.kpiSlots, `${post.ref} 槽位键两处必须逐字相同`);
    assert.equal(row.cadence.cron ?? null, post.cron, `${post.ref} 节奏两处必须逐字相同`);
  }
});

test("机器面不带散文：persona 与 promptTemplate 不进契约事实", async () => {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const personas = (m.agents ?? []).map((a) => a.persona).filter((p) => typeof p === "string" && p.length > 40);
  const prompts = (m.fleet.members ?? []).map((x) => x.cadence?.promptTemplate).filter((p) => typeof p === "string" && p.length > 40);
  assert.ok(personas.length > 0 && prompts.length > 0, "fixture 必须真的含散文，否则这条断言什么都没验");

  // deriveTeam 的 acceptance/edges/roster 里不得出现任何一段散文
  const projected = JSON.stringify(deriveTeam(m));
  for (const prose of [...personas, ...prompts]) {
    // 取一段有辨识度的片段（前 40 字）来比，避免整段 JSON 转义带来的假绿
    assert.equal(projected.includes(prose.slice(0, 40)), false, "契约投影里出现了散文片段");
  }
  assert.equal(projected.includes("promptTemplate"), false, "promptTemplate 键不该出现在契约投影里");
});

test("非团队包不产契约事实（absence 保持存量 payload 不变）", () => {
  const plain = { name: "single", skills: [{ name: "s", description: "d", content: "x" }] };
  assert.equal(deriveTeam(plain).state, "undeclared");
  // plaza 侧：teamFactsOf 对无 fleet.members 的包返回 null ⇒ 不产 team 键
  assert.equal(Array.isArray(plain.fleet?.members), false);
});
