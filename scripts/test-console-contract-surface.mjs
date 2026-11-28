// ── 控制台契约区的服务端契约（surface-team-contract-on-console 2.1–2.3）──────
//
// 三条判据，各自能红：
//   · 声明了两项 ⇒ `contract` 键存在，且 acceptance 与 deriveAcceptance 逐项相等
//     （同一份投影，不是第二套）；
//   · 一项都没声明 ⇒ **没有** `contract` 键（不是 null、不是空对象——那读作
//     「查过了，什么都没有」）；
//   · share 面裁掉 monitoring.notify，但 criteria/threshold/severity 必须还在
//     （裁剪不能过度，那会让公开页看起来没配监控）。
//
//   node --test scripts/test-console-contract-surface.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildConsoleViewModel } from "../server/console-blocks/index.js";
import { deriveAcceptance } from "../lib/team-derivation.js";

const DECLARED = {
  name: "契约夹具",
  console: { blocks: [{ block: "team" }] },
  acceptance: [
    { id: "a1", kind: "post-materialized", target: "评测岗" },
    { id: "a2", kind: "llm-judged", target: "审计岗", rubric: "逐条给依据（这段绝不能出现在响应里）" },
  ],
  monitoring: {
    anomaly_criteria: ["命中率分母与清单不自洽", "工具面出现 settle_decision"],
    escalate: { threshold: "gold 面不可达", severity_default: "high" },
    notify: "proposal-channel",
  },
};

const SILENT = { name: "什么也没声明的包", console: { blocks: [{ block: "team" }] } };

/** buildConsoleViewModel 需要的最小 db / memberView 桩：本测试只关心 contract。 */
const db = { listMembers: () => [] };
const memberView = () => ({});

function build(manifest, surface = "platform") {
  return buildConsoleViewModel({
    section: manifest.console ?? null,
    surface,
    db,
    fleet: { id: "f1", name: "夹具队", state: "running" },
    tasks: new Map(),
    model: null,
    now: 1_700_000_000_000,
    memberView,
    installedManifest: manifest,
  });
}

test("声明了契约 ⇒ contract 存在，acceptance 与 deriveAcceptance 逐项相等", () => {
  const view = build(DECLARED);
  assert.ok(view.contract, "必须挂 contract");
  assert.deepEqual(
    view.contract.acceptance,
    deriveAcceptance(DECLARED),
    "acceptance 必须来自 deriveAcceptance（同一投影），不是另写一套",
  );
  assert.equal(view.contract.monitoring.anomaly_criteria.length, 2);
  assert.equal(view.contract.monitoring.escalate.severity_default, "high");
});

test("rubric 永不下发（deriveAcceptance 本就不投它）", () => {
  const view = build(DECLARED);
  assert.ok(
    !JSON.stringify(view).includes("逐条给依据"),
    "llm-judged 的 rubric 是 release 面之后的内容，响应体里不能有",
  );
});

test("一项都没声明 ⇒ 响应里没有 contract 键（不是 null，不是 {}）", () => {
  const view = build(SILENT);
  assert.equal("contract" in view, false, "空契约必须整个键不存在——空对象读作「查过了，什么都没」");
});

test("platform 面带 notify；share 面裁掉 notify 但保留判据/阈值/严重度", () => {
  const platform = build(DECLARED, "platform");
  assert.equal(platform.contract.monitoring.notify, "proposal-channel", "平台面要带内部通道");

  const share = build(DECLARED, "share");
  assert.equal(share.contract.monitoring.notify, undefined, "分享面不得带内部通道");
  assert.ok(!JSON.stringify(share).includes("proposal-channel"), "响应体任何位置都不该出现 notify 的值");
  // 裁剪不能过度：规则本身必须还在，否则公开页看起来像没配监控
  assert.equal(share.contract.monitoring.anomaly_criteria.length, 2, "判据必须保留");
  assert.equal(share.contract.monitoring.escalate.threshold, "gold 面不可达", "阈值必须保留");
  assert.equal(share.contract.monitoring.escalate.severity_default, "high", "严重度必须保留");
});

test("只声明 acceptance 不声明 monitoring ⇒ monitoring 缺席而 acceptance 在", () => {
  const only = { ...DECLARED, monitoring: undefined };
  const view = build(only);
  assert.ok(view.contract.acceptance.length > 0);
  assert.equal("monitoring" in view.contract, false, "没声明的半区不出现，而不是渲染成空壳");
});

test("读数块不受 contract 影响（同名键不冲突、blocks 原样）", () => {
  const view = build(DECLARED);
  assert.ok(Array.isArray(view.blocks));
  assert.equal(view.blocks[0].block, "team");
  assert.notEqual(view.blocks[0].block, "acceptance", "契约不是块，不得混进 blocks");
});
