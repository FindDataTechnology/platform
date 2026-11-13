// 三面零矛盾：执行岗的"不行动条件"条数在 persona / 节奏 prompt / spec 里必须同一个数。
//
// 为什么值得一条测试：种子内部曾出现 persona 写"五条（①…⑤）、节奏 prompt 写"四条"，
// 而节奏 prompt 正是执行岗每个交易日真读到的那段文字。没有任何断言钉住这个数字，
// 于是它漂了很久（change5 3.3「三面零矛盾」本来要求的就是这件事）。
//
// workspace-only: needs finddata/{docs,openspec,reports}
// 这是一条**工作区级**验收，不是仓级测试：它拿本仓的种子去比 fd-wire 的
// pack manifest（finddata/docs）与它的 spec（finddata/openspec），还要读仓外的
// reports/。单仓 checkout 里那几样结构上不存在——按仓级红来读，读到的只是
// "这里没有工作区"，与交易舰队是否一致无关。scripts/unit-shard.mjs 认这行声明，
// 工作区不在场时把它从分片清单里剔除并**点名报数**（不静默少跑）。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SEED = path.join(ROOT, "paas/docs/fleet-templates/invest-trading-fleet.seed.json");
const MANIFEST = path.join(ROOT, "docs/wire-presets/pack-manifests/wire-invest-trading.json");
const SPEC = path.join(ROOT, "openspec/changes/add-investment-trading-fleet/specs/investment-trading-fleet/spec.md");

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };

function claimedCount(text) {
  const m = text.match(/([一二三四五六七])条不行动条件/);
  return m ? CN[m[1]] : null;
}

const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
const executor = seed.agents.find((a) => a.id === "trade-execute");
const cadence = seed.fleet.members.find((m) => m.ref === "trade-execute")
  ?? seed.fleet.members.find((m) => (m.cadence?.promptTemplate ?? "").includes("不行动条件"));

const personaN = claimedCount(executor.persona);
const promptN = claimedCount(cadence.cadence.promptTemplate);

// spec 的真源：fail-closed 要求正文里用「；」分隔的条件数
const specText = fs.readFileSync(SPEC, "utf8");
const failClosed = specText.split("### Requirement: 执行侧 fail-closed")[1].split("###")[0];
const mustLine = failClosed.split("\n").find((l) => l.includes("MUST 在下列任一条件"));
const specN = (mustLine.match(/；/g) || []).length + 1;

console.log(`  persona=${personaN}  prompt=${promptN}  spec=${specN}`);

assert.ok(personaN, "persona 里没有写「N 条不行动条件」");
assert.ok(promptN, "节奏 prompt 里没有写「N 条不行动条件」");
assert.equal(personaN, specN, `persona 说 ${personaN} 条，spec 有 ${specN} 条条件`);
assert.equal(promptN, specN, `节奏 prompt 说 ${promptN} 条，spec 有 ${specN} 条条件——执行岗每轮读到的就是这段`);

// persona 必须把每一条都点名（①…⑤），不能只写数字
for (const mark of ["①", "②", "③", "④", "⑤"].slice(0, specN)) {
  assert.ok(executor.persona.includes(mark), `persona 缺 ${mark} 条`);
}

// ── 节奏：四个盘前/收盘窗口不许重叠（change3 task 4.3）────────────
//
// 4.3 的判据是"脚本读种子各岗 cron，断言无重叠"。此前没有任何脚本读这四个参数
// （只有人肉算过一次窗：08:40 → 09:00 → 09:35 → 16:10），所以这条验收同样悬空。
// 这里把默认值解析成分钟数，断言严格递增且互不相等——同一分钟起的两个岗就是重叠。
const cronParams = Object.fromEntries((seed.fleet.params ?? []).map((p) => [p.name, p.default]));
const toMinutes = (cron) => {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/.exec(String(cron).trim());
  if (!m) return null;
  return Number(m[2]) * 60 + Number(m[1]);
};
const windows = [
  ["research", cronParams.researchCron],
  ["portfolio", cronParams.portfolioCron],
  ["execute", cronParams.executeCron],
  ["review", cronParams.reviewCron],
].map(([role, cron]) => {
  const at = toMinutes(cron);
  assert.ok(at !== null, `${role} 的 cron 不是"工作日 HH:MM"形态：${cron}`);
  return [role, at];
});
for (const [role] of Object.entries(cronParams)) {
  assert.ok(cronParams[role], `${role} 缺默认值`);
}
for (let i = 1; i < windows.length; i += 1) {
  const [prevRole, prevAt] = windows[i - 1];
  const [role, at] = windows[i];
  assert.ok(at > prevAt,
    `${role}(${at}分) 必须晚于 ${prevRole}(${prevAt}分)，否则两个岗同一分钟起跑`);
}
// 三条位置约束（防止"全都挪到下午也算递增"这种假通过）：
//   · 研究与组合是**盘前**两岗 —— 4.3 的原文就是"盘前两岗与复盘岗无重叠"；
//   · 执行是**开盘后**（种子把这个参数叫"开盘执行时刻"，默认 09:35 = 开盘后 5 分钟，
//     这样下单时有当日真实价格；写成"必须在开盘前"是错的，会与设计相反）；
//   · 复盘在**收盘后**。
const at = Object.fromEntries(windows);
assert.ok(at.research < 9 * 60 + 30, `研究 ${at.research}分 应在 09:30 开盘前`);
assert.ok(at.portfolio < 9 * 60 + 30, `组合 ${at.portfolio}分 应在 09:30 开盘前`);
assert.ok(at.execute >= 9 * 60 + 30 && at.execute < 12 * 60,
  `执行 ${at.execute}分 应在开盘后、上午收市前（"开盘执行时刻"）`);
assert.ok(at.review >= 15 * 60, `收盘复盘 ${at.review}分 应在 15:00 之后`);
// orchestration 的 trigger 边把同一段 cron **又写了一遍**（不是 `${param}` 引用）。
// 两处一旦漂移，界面上显示的节奏与调度器实际用的节奏就不是一回事，而且没人会报错。
// 判据：每条 trigger 的 cron 必须等于同名参数的默认值。
const triggerCron = Object.fromEntries(
  (seed.fleet.orchestration?.edges ?? [])
    .filter((e) => e.kind === "trigger" && e.cron)
    .map((e) => [e.to, e.cron.trim()])
);
for (const [role, paramName] of [["research", "researchCron"], ["portfolio", "portfolioCron"],
                                 ["execute", "executeCron"], ["review", "reviewCron"]]) {
  assert.ok(triggerCron[role], `orchestration 缺 ${role} 的 trigger 边`);
  assert.equal(triggerCron[role], String(cronParams[paramName]).trim(),
    `${role}: orchestration 写 ${JSON.stringify(triggerCron[role])}，参数默认值是 ${JSON.stringify(cronParams[paramName])}——同一节奏写了两处且已漂移`);
}
// 被动岗靠 dispatch 唤醒，不能有 trigger 边（有的话它就不是被动岗了）。
assert.ok(!triggerCron.risk, "风控官不该有 trigger 边（它是被动岗）");
assert.ok((seed.fleet.orchestration?.edges ?? []).some(
  (e) => e.kind === "dispatch" && e.to === "risk"),
  "风控官需要一条 dispatch 边，否则被动岗永远不会被唤醒");

console.log(`✓ 节奏：${windows.map(([r, m]) => `${r} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`).join(" → ")}；orchestration 与参数默认值一致`);

// ── 卡点表必须覆盖该 change 的全部未完成项（防"清单漏了一条"）──────
//
// 这张表是给人看的，最容易的失效方式是"后来又加了一条未完成项、表没跟着加"。
// 判据：某 change 的 tasks.md 里，`- [ ] N.M` 出现的集合，必须与它
// 「外部卡点」小节表格行（`| N.M ...`）的任务号集合完全相同。
// 只查有该小节的文件；没有未完成项的 change 不要求有该小节。
// ROOT 已经是 finddata 根（见文件开头）；change1/3/4 在根上，change5 在 paas 下。
const TASKS = [
  [path.join(ROOT, "openspec/changes/add-price-supply-and-caliber/tasks.md"), "add-price-supply-and-caliber"],
  [path.join(ROOT, "openspec/changes/add-investment-trading-fleet/tasks.md"), "add-investment-trading-fleet"],
  [path.join(ROOT, "paas/openspec/changes/add-trading-starter-and-entry-paths/tasks.md"), "add-trading-starter-and-entry-paths"],
  [path.join(ROOT, "openspec/changes/add-portfolio-intent-contract/tasks.md"), "add-portfolio-intent-contract"],
  [path.join(ROOT, "openspec/changes/deepen-trading-benchmark-and-risk/tasks.md"), "deepen-trading-benchmark-and-risk"],
];
let blockedTotal = 0;
for (const [file, name] of TASKS) {
  // An ARCHIVED change has no live open-task contract: `openspec archive` moves
  // the directory under openspec/changes/archive/, so the path above stops
  // existing. Crashing here (ENOENT) turned "this change closed" into a red that
  // says nothing about trading-fleet consistency — add-portfolio-intent-contract
  // and deepen-trading-benchmark-and-risk were both archived 2026-11-10.
  if (!fs.existsSync(file)) {
    console.log(`  · ${name}: 已归档（无 live tasks.md），跳过卡点表核对`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  const open = new Set();
  for (const line of text.split("\n")) {
    const m = /^- \[ \] (\d+\.\d+)/.exec(line);
    if (m) open.add(m[1]);
  }
  const section = text.split(/^## .*外部卡点.*$/m)[1] ?? "";
  const listed = new Set();
  for (const line of section.split("\n")) {
    const m = /^\|\s*(\d+\.\d+)/.exec(line);
    if (m) listed.add(m[1]);
  }
  blockedTotal += open.size;
  if (open.size === 0) {
    assert.equal(listed.size, 0, `${name}: 没有未完成项却还有卡点行`);
    continue;
  }
  const missing = [...open].filter((t) => !listed.has(t));
  const extra = [...listed].filter((t) => !open.has(t));
  assert.deepEqual(missing, [], `${name}: 卡点表漏了未完成项 ${JSON.stringify(missing)}`);
  assert.deepEqual(extra, [], `${name}: 卡点表列了已完成/不存在的项 ${JSON.stringify(extra)}`);
}
console.log(`✓ 卡点表：5 个 change 共 ${blockedTotal} 条未完成项，逐条在表内且无多余`);

// ── 两项待裁决必须在手册里写清"链条 + 未裁决期间的替代路径"───────
//
// 这两项是唯一需要人拍板的（packId / 隧道）。它们最容易的失效方式不是写错，
// 而是**某次编辑把它删了**——手册就变成"11 条都卡着，但没人知道找谁、能不能先干别的"。
// 判据：手册里同时出现两项裁决标题、各自的一句话链条标记箭头、以及"未裁决期间的替代路径"。
const RUNBOOK = path.join(ROOT, "reports/invest-trading-activation-runbook.md");
const rb = fs.readFileSync(RUNBOOK, "utf8");
for (const key of ["裁决一 · `packId`", "裁决二 · 隧道"]) {
  assert.ok(rb.includes(key), `手册缺待裁决项：${key}`);
}
const decisionBlocks = rb.split(/\*\*裁决[一二] · /).slice(1);
assert.equal(decisionBlocks.length, 2, "待裁决项应为两条");
for (const blk of decisionBlocks) {
  assert.ok(blk.includes("→"), "每条裁决都要给出一句话的解锁链条（用 → 串起来）");
  assert.ok(blk.includes("未裁决期间的替代路径"), "每条裁决都要标出未裁决期间的替代路径");
}
console.log(`✓ 待裁决：packId 与隧道各有链条与替代路径（${decisionBlocks.length} 条）`);

// ── 风控官：被动岗 + 无放行权（change3 task 2.5）───────────────
//
// 2.5 原验收要求"稿内出现'只能升级给人、不得放行'的明文"。**这条不可能成立**：
// 风控官是 `existing-persona` + `{{RISK_PERSONA}}`，本种子不带它的人设稿
// （invest-morning-fleet 同样如此），所以"稿内"根本没有承载那句话的地方。
// 于是把能机械判定的三件事钉住，"无放行权"至少有一条可执行的判据：
//   ① 被动：`cadence` 必须为 null（有 cron 就不再是被动岗）；
//   ② 它报的是"被拦/升级"，不是成交：kpiSlots 必须是这两项；
//   ③ 任何地方都不给它下单入口：pack manifest 里不存在名为 risk 的 agent，
//      因此也不可能给它 place_order。
const riskMember = seed.fleet.members.find((m) => m.ref === "risk");
assert.ok(riskMember, "种子缺风控官成员");
assert.equal(riskMember.cadence, null,
  "风控官必须是被动岗（cadence: null）；给了 cron 就不是被动岗了");
assert.equal(riskMember.target.kind, "existing-persona",
  "风控官应复用宿主已有的风控人设（本种子不带人设稿）");
const slotKeys = (riskMember.kpiSlots ?? []).map((s2) => s2.key).sort();
assert.deepEqual(slotKeys, ["blocked_count", "escalated"],
  `风控官应只报被拦与升级，实际 ${JSON.stringify(slotKeys)}`);

const manifestAgents = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).agents ?? [];
assert.ok(!manifestAgents.some((a) => a.id === "risk"),
  "风控官不该进 pack 的 agents（那会让它拿到 pack 级工具面）");
for (const a of manifestAgents) {
  const tools = Object.values(a.resources?.mcpTools ?? {}).flat();
  if (a.id === "trade-execute") continue;   // 执行岗唯一允许下单
  assert.ok(!tools.includes("place_order"),
    `${a.id} 不该持有 place_order`);
}
console.log(`✓ 风控官：被动岗 + 只报被拦/升级，且无任何下单入口`);

// 卡面：description 里「核心纪律是…：A、B、C——任一成立」这一段的顿号项数。
// 这一段以前只列四条（漏了"权重实例校验失败"），而任务 1.3 的验收正是照着它写的，
// 于是"卡上四项"被当成了真源。卡面是用户最先读到的一面，必须同数。
const card = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).description;
const cardSeg = card.split("核心纪律是")[1].split("——")[0];
const cardN = cardSeg.split("、").length;
assert.equal(cardN, specN, `卡面列了 ${cardN} 条条件，spec 有 ${specN} 条`);

console.log(`✓ 不行动条件四面一致：${specN} 条（spec / persona / 节奏 prompt / 卡面）`);
