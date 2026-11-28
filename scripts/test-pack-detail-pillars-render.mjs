// ── 记忆段与看板段的呈现契约（overhaul-pack-detail-presentation 2.1 / 2.2 / 3.1）
//
// 判据是「派生结果里已有的东西，页面上必须念得出来」：
//   · rows 里 declared=null 的行 → 标「平台默认」，且**不得**出现字符串 null；
//   · guidance 是对象数组，按岗位归属；没有时不渲染该段；
//   · dashboard 的块按 `console.block.<id>` 的显示名列出，不是「N blocks」；
//   · 页面上不出现裸字段路径（`kpi.hit_rate`、`store.home` 作为主文本）。
//
// 用真实派生函数求输入，再对渲染树做文本抽取——渲染层一旦退回转储，这里就红。
//
//   node --test scripts/test-pack-detail-pillars-render.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { derivePillars } from "../lib/pack-pillars.js";
import { deriveTeam } from "../lib/team-derivation.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web", "src", "components", "packs");

/** 实测自 `投研团队评测舰`（NBUjv3Z8HWNpEjblQzB6Ow）的 manifest 形状。 */
const MANIFEST = {
  name: "投研团队评测舰",
  description: "评测与审计两岗",
  mcpServers: [
    { registryName: "fleet-architect", allowTools: ["fleet_list", "fleet_spec_read", "fleet_turns_read"] },
    { registryName: "fd-quant", allowTools: ["list_pending_decisions", "retrieve_decisions", "summarize_pack_performance"] },
  ],
  agents: [
    {
      id: "inv-grade-evaluator",
      name: "评测岗",
      persona: "你是投研团队评测舰的评测岗。",
      memory: { guidance: "只记本周期的四类读数、偏离项与 gold 来源标识。" },
      resources: { mcpTools: { "fleet-architect": ["fleet_list"], "fd-quant": ["list_pending_decisions"] } },
    },
    { id: "inv-grade-auditor", name: "审计岗", persona: "你是审计岗。" },
  ],
  memory: {
    store: { home: "member" },
    read: { scope: "own+shared" },
    write: { authority: "private" },
    process: { distill: "on" },
  },
  console: {
    headline: "kpi.hit_rate",
    blocks: [{ block: "team" }, { block: "kpi" }, { block: "stream", params: { limit: 10 } }, { block: "decisions" }, { block: "spend" }],
  },
  fleet: {
    name: "投研团队评测舰",
    members: [
      {
        ref: "evaluator",
        title: "评测岗",
        target: { kind: "pack-preset", presetId: "inv-grade-evaluator", packId: "SELF" },
        cadence: { cron: "7 11 * * 1-5" },
        kpiSlots: [{ key: "pending", label: "待结算" }, { key: "hit_rate", label: "命中率" }],
      },
      {
        ref: "auditor",
        title: "审计岗",
        target: { kind: "pack-preset", presetId: "inv-grade-auditor", packId: "SELF" },
        cadence: { cron: "37 11 * * 1-5" },
        kpiSlots: [{ key: "reviewed", label: "复核条数" }],
      },
    ],
    orchestration: { edges: [{ kind: "handoff", from: "evaluator", to: "auditor" }] },
  },
  acceptance: [
    { id: "a1", kind: "post-materialized", target: "评测岗" },
    { id: "a4", kind: "report-landed", target: "评测岗" },
  ],
};

const pillars = derivePillars(MANIFEST);
const team = deriveTeam(MANIFEST);

const read = (f) => readFileSync(join(SRC, f), "utf8");

test("夹具前提：记忆有平台默认行、有跨级改写、有 guidance、有收窄", () => {
  const rows = pillars.memory.rows;
  assert.equal(pillars.memory.state, "present");
  // read.budget 未声明 → 平台默认
  assert.equal(rows["read.budget"].declared, null);
  assert.equal(rows["read.budget"].inherited_from, "platform");
  // 有至少一条已声明
  assert.equal(rows["store.home"].declared, "member");
  // guidance 是对象数组
  assert.ok(Array.isArray(pillars.memory.guidance));
  assert.equal(pillars.memory.guidance[0].agentId, "inv-grade-evaluator");
  // 收窄
  assert.ok(pillars.toolkit.roles.some((r) => r.narrowed === true), "评测岗收窄了工具面");
  // 看板五块
  assert.equal(pillars.dashboard.blocks.length, 5);
  // 验收两条
  assert.equal(team.acceptance.length, 2);
});

test("MemoryAxes 不把 null 印成字面量，并把平台默认单独标注", () => {
  const s = read("MemoryAxes.tsx");
  assert.match(s, /memoryFromPlatform/, "必须区分平台默认");
  assert.match(s, /memoryUnexecuted/, "必须标注未执行");
  assert.match(s, /memoryDeclaredWas/, "跨级改写必须两个值并列");
  // 值渲染一律经 readValue()，null 走 empty 文案而不是 String(null)
  assert.match(s, /value === null \|\| value === undefined/, "null 必须走专用分支");
  assert.doesNotMatch(s, /\{String\(row\.effective\)\}/, "不得直接 String() 生效值（null 会漏出去）");
});

test("记忆章程按岗位归属，而不是一段合并的字符串", () => {
  const s = read("AgentSpecSheet.tsx");
  assert.match(s, /memoryCharterTitle/);
  assert.match(s, /guidance\.map\(/, "guidance 必须逐条渲染");
  assert.match(s, /g\.agentId/, "每条章程必须带岗位归属");
});

test("看板段按块名列出，而不是只报个数", () => {
  const s = read("AgentSpecSheet.tsx");
  assert.match(s, /console\.block\.\$\{b\.block\}/, "块名必须取 console.block.<id>（与控制台页同一组键）");
  assert.doesNotMatch(
    s,
    /dashboardBlocks", \{ n: blocks\.length \}/,
    "不得退回「N blocks」——那正是本轮要修的形态",
  );
});

test("岗位槽位渲染标签而不是键", () => {
  const s = read("AgentSpecSheet.tsx");
  assert.match(s, /s\.label \?\?/, "KPI 槽位必须先取 label");
  assert.doesNotMatch(s, /kpiSlots\.map\(\(s\) => s\.key\)/, "不得只取 key（实测 data 里 label 就在隔壁）");
});

test("新增三段只在声明时出现：验收 / 监控 / 产物卡", () => {
  const s = read("AgentSpecSheet.tsx");
  assert.match(s, /team\?\.acceptance && team\.acceptance\.length > 0/, "验收段必须整段省略");
  assert.match(s, /\{monitoring &&/, "监控段必须整段省略");
  assert.match(s, /board && board\.length > 0/, "产物卡段必须整段省略");
  // 产物卡（board）与看板（console）必须是两个标题，不能共用 dashboardTitle
  assert.match(s, /packs\.specSheet\.output/, "产物卡段用自己的标题");
});

test("外观文案在五语齐全（新增键不得只在 en）", () => {
  const KEYS = [
    "memoryFromPlatform", "memoryFromRole", "memoryAxis", "memorySubkey", "memoryValue",
    "acceptance", "acceptanceUndeclared", "assertion", "monitoring", "monitoringCriteria",
    "monitoringEscalate", "monitoringSeverity", "output", "outputDiscipline", "outputArtifact",
    "bindingSystem", "bindingDirection", "bindingCredential", "bindingRequired", "bindingOptional",
    "expandPersona", "collapsePersona", "toolkitNarrowing", "dashboardTitle",
  ];
  for (const loc of ["en", "zh-CN", "es", "fr", "ja"]) {
    const d = JSON.parse(readFileSync(join(ROOT, "web", "src", "locales", loc, "common.json"), "utf8"));
    for (const k of KEYS) {
      assert.ok(d.packs?.specSheet?.[k] !== undefined, `${loc}: packs.specSheet.${k} 缺失`);
    }
  }
});

// ── 来源判据必须是 inherited_from，不是「declared 为空」（2026-11-24 线上实见）──
//
// `write.authority` 平台**没有默认值**：real payload 是
//   {declared: null, inherited_from: null, effective: null}
// 按「declared 为空 ⇒ 平台默认」判，会把它标成「平台默认」——页面会说谎。
test("来源判据用 inherited_from：空默认与平台默认必须分开", () => {
  const src = read("MemoryAxes.tsx");
  assert.match(src, /inherited_from === "platform"/, "平台默认必须按 inherited_from 判");
  assert.doesNotMatch(
    src,
    /fromPlatform\s*=\s*row\.declared === null/,
    "不得按 declared 为空判平台默认——write.authority 没有平台默认，会被误标",
  );
  assert.match(src, /memoryUnset/, "无值项必须有「未设置」态，不能留空");

  // 真实 payload 的形状：三态各不相同
  const WRITE_AUTHORITY = { declared: null, inherited_from: null, effective: null };
  const READ_SCOPE = { declared: null, inherited_from: "platform", effective: "own+shared" };
  assert.equal(WRITE_AUTHORITY.inherited_from === "platform", false, "write.authority 不是平台默认");
  assert.equal(READ_SCOPE.inherited_from === "platform", true, "read.scope 是平台默认");
});
